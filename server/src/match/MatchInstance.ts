import { randomUUID } from 'node:crypto';
import {
  MASTER_TICK_MS,
  MatchState,
  PlayerStatus,
  Rng,
  WorldReader,
  createMapParams,
  generateWorld,
  type GameMode,
  type MapGenParams,
  type RoomVisibility,
} from '@borderfall/shared';
import { EventBus } from '../engine/EventBus.js';
import { TickScheduler } from '../engine/TickScheduler.js';
import { WorldState } from '../engine/WorldState.js';
import type { ISimulationSystem, SystemContext } from '../engine/System.js';
import { PlayerRegistry, type Player } from './PlayerRegistry.js';
import { createLogger, type Logger } from '../utils/logger.js';
import { Metric, metrics } from '../services/metrics.js';

export interface MatchConfig {
  readonly name: string;
  readonly mode: GameMode;
  readonly visibility: RoomVisibility;
  readonly password?: string | undefined;
  readonly maxPlayers: number;
  readonly territoryCount: number;
  readonly seed: number;
  /** Bots to fill the lobby with when the match starts. */
  readonly botCount: number;
}

/**
 * One running match: its world, its players, and its simulation loop.
 *
 * Everything a match owns is contained here — no module-level state — so a
 * single Node process can host several matches side by side, and a test can
 * construct one, drive it with synthetic time, and assert on the result without
 * a socket or an HTTP server in sight.
 *
 * The instance deliberately knows nothing about networking. It exposes state
 * and emits events; a broadcaster subscribes and decides what each connection
 * is allowed to see. That inversion is what lets the same simulation run
 * headless inside a replay verifier or a load test.
 */
export class MatchInstance {
  readonly id: string;
  readonly code: string;
  readonly createdAt: number;

  readonly bus = new EventBus();
  readonly scheduler = new TickScheduler();
  readonly players: PlayerRegistry;
  readonly world: WorldState;
  readonly reader: WorldReader;
  readonly mapParams: MapGenParams;

  readonly log: Logger;

  private state: MatchState = MatchState.Lobby;
  private readonly rng: Rng;
  private startedAt = 0;
  private lastTickAt = 0;
  private loopHandle: ReturnType<typeof setInterval> | null = null;

  /** Spawn points already handed out, so two players never share one. */
  private readonly usedSpawns = new Set<number>();

  constructor(
    readonly config: MatchConfig,
    code: string,
  ) {
    this.id = randomUUID();
    this.code = code;
    this.createdAt = Date.now();
    this.log = createLogger(`match:${this.code}`);

    this.mapParams = createMapParams(config.seed, { territoryCount: config.territoryCount });

    const geometry = generateWorld(this.mapParams);
    this.world = new WorldState(geometry);
    this.reader = new WorldReader(geometry);

    this.players = new PlayerRegistry(config.maxPlayers);

    // The simulation RNG is separate from the map generator's stream. Map
    // generation must produce the same world regardless of how many combat
    // rolls later occur, so the two never share a sequence.
    this.rng = new Rng(config.seed).fork('simulation');

    this.log.info('Match created', {
      id: this.id,
      territories: geometry.territoryCount,
      seed: config.seed,
      mode: config.mode,
    });
  }

  /* Lifecycle -------------------------------------------------------------- */

  registerSystem(system: ISimulationSystem): void {
    this.scheduler.register(system);
  }

  start(): void {
    if (this.state !== MatchState.Lobby && this.state !== MatchState.Starting) return;

    this.state = MatchState.Running;
    this.startedAt = Date.now();
    this.lastTickAt = this.startedAt;

    this.scheduler.start((system) => this.makeContext(system, 0, 0));

    /**
     * One interval per match, driving every system through the scheduler's
     * accumulators. `setInterval` rather than a self-scheduling `setTimeout`
     * chain because the scheduler already absorbs timer jitter — it consumes
     * whole fixed ticks from whatever real time elapsed — so the simpler timer
     * is sufficient and does not accumulate drift.
     */
    this.loopHandle = setInterval(() => this.runTick(), MASTER_TICK_MS);

    this.bus.emitImmediate('sim:started', { matchId: this.id, startedAt: this.startedAt });
    metrics.setGauge(Metric.matchesActive, metrics.getGauge(Metric.matchesActive) + 1);
    this.log.info('Match started', { players: this.players.activeCount });
  }

  private runTick(): void {
    const now = Date.now();
    const elapsed = now - this.lastTickAt;
    this.lastTickAt = now;

    const report = this.scheduler.advance(
      elapsed,
      (system, tick, elapsedMs) => this.makeContext(system, tick, elapsedMs),
      (tick, elapsedMs) => {
        this.bus.emit('sim:tick', { tick, elapsedMs });
      },
    );

    // Flush once per timer callback rather than once per simulated tick: events
    // queued by an earlier tick are still dispatched in order, and batching
    // avoids repeating the flush machinery during catch-up.
    this.bus.flush();

    if (report.ticksRun > 0) {
      metrics.observe(Metric.tickDurationMs, report.durationMs);
    }
    if (report.droppedMs > 0) {
      metrics.increment(Metric.tickDroppedMs, report.droppedMs);
    }

    this.expireDisconnects(now);
  }

  /**
   * Drops players whose reconnect grace has run out, releasing their land back
   * to neutral so the map does not fill with abandoned empires.
   */
  private expireDisconnects(now: number): void {
    const expired = this.players.expiredDisconnects(now);
    for (const player of expired) {
      this.log.info('Reconnect grace expired', { slot: player.slot, name: player.name });
      player.status = PlayerStatus.Surrendered;
      this.world.releaseSlot(player.slot);
      this.bus.emit('player:left', { slot: player.slot, surrendered: true });
    }
  }

  private makeContext(system: ISimulationSystem, tick: number, elapsedMs: number): SystemContext {
    return {
      matchId: this.id,
      bus: this.bus,
      log: this.log.child(system.name),
      // Each system draws from its own stream, so adding a roll in one cannot
      // shift the sequence another observes.
      rng: this.rng.fork(system.name),
      elapsedMs,
      tick,
    };
  }

  end(winnerSlot: number | null): void {
    if (this.state === MatchState.Finished) return;
    this.state = MatchState.Ending;

    if (this.loopHandle !== null) {
      clearInterval(this.loopHandle);
      this.loopHandle = null;
    }

    const durationMs = this.startedAt === 0 ? 0 : Date.now() - this.startedAt;
    this.bus.emitImmediate('sim:ended', { matchId: this.id, winnerSlot, durationMs });
    this.state = MatchState.Finished;

    metrics.setGauge(Metric.matchesActive, Math.max(0, metrics.getGauge(Metric.matchesActive) - 1));
    this.log.info('Match ended', { winnerSlot, durationMs });
  }

  dispose(): void {
    if (this.loopHandle !== null) {
      clearInterval(this.loopHandle);
      this.loopHandle = null;
    }
    this.scheduler.dispose();
    this.bus.removeAllListeners();
    this.bus.clear();
  }

  /* Players ---------------------------------------------------------------- */

  /**
   * Seats a player and grants them a starting territory.
   *
   * Spawns are drawn from the generator's greedy farthest-point list in order,
   * so early joiners are maximally separated. Falling back to any unowned land
   * matters for a full lobby on a small map — refusing to seat a player because
   * the curated list ran out would be a worse outcome than a slightly cramped
   * start.
   */
  addPlayer(accountId: string, name: string, isBot: boolean): Player | null {
    const player = this.players.add(accountId, name, isBot, Date.now());
    if (!player) return null;

    const spawn = this.claimSpawn();
    if (spawn >= 0) {
      this.world.setOwner(spawn, player.slot);
      this.world.setPopulation(spawn, 500);
      this.world.setTroops(spawn, 50);
    }

    this.bus.emit('player:joined', { slot: player.slot, name: player.name, isBot });
    this.log.info('Player joined', { slot: player.slot, name, isBot, spawn });
    return player;
  }

  private claimSpawn(): number {
    for (const candidate of this.reader.geometry.spawnCandidates) {
      if (this.usedSpawns.has(candidate)) continue;
      if (!this.world.isNeutral(candidate)) continue;
      this.usedSpawns.add(candidate);
      return candidate;
    }

    for (let id = 0; id < this.world.territoryCount; id++) {
      if (!this.reader.isLand(id)) continue;
      if (!this.world.isNeutral(id)) continue;
      this.usedSpawns.add(id);
      return id;
    }

    return -1;
  }

  removePlayer(slot: number, surrendered: boolean): void {
    const player = this.players.get(slot);
    if (!player) return;

    this.world.releaseSlot(slot);
    player.status = surrendered ? PlayerStatus.Surrendered : PlayerStatus.Eliminated;
    this.bus.emit('player:left', { slot, surrendered });
    this.log.info('Player left', { slot, surrendered });
  }

  /* Queries ---------------------------------------------------------------- */

  get matchState(): MatchState {
    return this.state;
  }

  get isRunning(): boolean {
    return this.state === MatchState.Running;
  }

  get tick(): number {
    return this.scheduler.tick;
  }

  get elapsedMs(): number {
    return this.startedAt === 0 ? 0 : Date.now() - this.startedAt;
  }

  get isEmpty(): boolean {
    return this.players.humanCount === 0;
  }

  /** True when the room accepts another player. */
  get hasCapacity(): boolean {
    return this.players.activeCount < this.config.maxPlayers;
  }
}
