import {
  KEYFRAME_INTERVAL_MS,
  NETWORK_TICK_MS,
  SYSTEM_INTERVAL_MS,
  type LeaderboardEntry,
} from '@borderfall/shared';
import type { MatchInstance } from '../match/MatchInstance.js';
import type { GameServer } from './SocketGateway.js';
import { deltaByteLength, encodeDelta, encodeSnapshot } from './StateEncoder.js';
import { Metric, metrics } from '../services/metrics.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('broadcast');

/**
 * Turns simulation state into network traffic for one match.
 *
 * Runs on its own 20 Hz timer rather than inside the 50 Hz simulation loop.
 * Decoupling the two means the broadcast rate can be tuned — or made adaptive
 * under load — without touching simulation timing, and a slow serialisation
 * pass can never delay a tick and desynchronise the match.
 *
 * The broadcaster is the *only* component that decides what a given connection
 * is permitted to see. The simulation emits everything; this filters. Keeping
 * that judgement in one place is what makes "does this leak information?" a
 * question with a single answer rather than one per system.
 */
export class StateBroadcaster {
  private handle: ReturnType<typeof setInterval> | null = null;
  private leaderboardHandle: ReturnType<typeof setInterval> | null = null;

  /** Tick the last delta was based on, so clients can detect a gap. */
  private lastBroadcastTick = 0;
  private lastKeyframeAt = 0;

  constructor(
    private readonly io: GameServer,
    private readonly match: MatchInstance,
  ) {}

  start(): void {
    if (this.handle !== null) return;
    this.lastKeyframeAt = Date.now();
    this.handle = setInterval(() => this.broadcast(), NETWORK_TICK_MS);

    /**
     * Standings run on their own, much slower timer.
     *
     * Recomputing the leaderboard is O(players × territories) — it sweeps the
     * whole world once per player — so doing it at the 20 Hz broadcast rate
     * would dominate the server's CPU budget for information a human reads a
     * few times a minute. Two seconds is frequent enough to feel live.
     */
    this.leaderboardHandle = setInterval(
      () => this.broadcastLeaderboard(),
      SYSTEM_INTERVAL_MS.leaderboard,
    );

    // Send one immediately so a joining player is not staring at an empty
    // panel for two seconds.
    this.broadcastLeaderboard();
  }

  stop(): void {
    if (this.handle !== null) {
      clearInterval(this.handle);
      this.handle = null;
    }
    if (this.leaderboardHandle !== null) {
      clearInterval(this.leaderboardHandle);
      this.leaderboardHandle = null;
    }
  }

  private get room(): string {
    return `match:${this.match.id}`;
  }

  private broadcast(): void {
    const now = Date.now();
    const tick = this.match.tick;

    // A periodic full snapshot lets a client that dropped a delta resynchronise
    // without rejoining. It also bounds the damage from any decoder bug: state
    // can be wrong for at most one keyframe interval.
    if (now - this.lastKeyframeAt >= KEYFRAME_INTERVAL_MS) {
      this.sendKeyframe(tick, now);
      this.lastKeyframeAt = now;
      return;
    }

    const delta = encodeDelta(this.match.world, tick, this.lastBroadcastTick, now);
    this.match.world.clearDirty();

    if (delta) {
      this.io.to(this.room).emit('world:delta', delta);
      metrics.increment(Metric.broadcastBytes, deltaByteLength(delta));
    }

    // Advance regardless: with no changes, the next delta legitimately builds
    // on this tick, and reusing a stale base would make clients request a
    // resync every frame of an idle match.
    this.lastBroadcastTick = tick;

    this.sendResourceUpdates(tick);
  }

  private sendKeyframe(tick: number, now: number): void {
    const snapshot = encodeSnapshot(this.match.world, tick, now);
    this.io.to(this.room).emit('world:snapshot', snapshot);
    this.match.world.clearDirty();
    this.lastBroadcastTick = tick;
  }

  /**
   * Sends each player their own resources.
   *
   * Unicast rather than broadcast because gold and food are private: knowing an
   * opponent's exact reserves tells you precisely when they can afford a silo,
   * which is information the game is designed to keep hidden.
   */
  private sendResourceUpdates(tick: number): void {
    for (const player of this.match.players.all()) {
      if (!player.socketId) continue;

      const totals = this.match.world.totalsForSlot(player.slot);
      this.io.to(player.socketId).emit('player:resources', {
        tick,
        resources: {
          gold: Math.floor(player.gold),
          food: Math.floor(player.food),
          population: totals.population,
          troops: totals.troops,
          territoryCount: totals.territories,
          cityCount: 0,
        },
      });
    }
  }

  /** Pushes a full snapshot to one socket, for join and explicit resync. */
  sendSnapshotTo(socketId: string): void {
    const snapshot = encodeSnapshot(this.match.world, this.match.tick, Date.now());
    this.io.to(socketId).emit('world:snapshot', snapshot);
  }

  broadcastPlayerList(): void {
    this.io.to(this.room).emit('match:players', { players: this.match.players.toViews() });
  }

  /**
   * Recomputes and broadcasts the leaderboard.
   *
   * Public by design — standings are the shared context that makes diplomacy
   * meaningful. Only the aggregate is exposed, never the per-territory detail
   * that would let a player pinpoint an opponent's weakest holding.
   */
  broadcastLeaderboard(): void {
    const landTotal = Math.max(1, this.match.reader.countLandTerritories());

    const entries: LeaderboardEntry[] = this.match.players
      .activePlayers()
      .map((player) => {
        const totals = this.match.world.totalsForSlot(player.slot);
        return {
          rank: 0,
          slot: player.slot,
          name: player.name,
          isBot: player.isBot,
          population: totals.population,
          troops: totals.troops,
          territoryShare: totals.territories / landTotal,
          gold: Math.floor(player.gold),
          cities: 0,
          kills: player.kills,
          deaths: player.deaths,
          // Territory dominates, with population and army as tiebreakers. A
          // pure territory count would reward grabbing worthless tundra over
          // developing a compact, productive core.
          score: totals.territories * 100 + totals.population * 0.1 + totals.troops * 0.5,
        };
      })
      .sort((a, b) => b.score - a.score)
      .map((entry, index) => ({ ...entry, rank: index + 1 }));

    this.io.to(this.room).emit('leaderboard:update', { tick: this.match.tick, entries });
  }

  notify(
    socketId: string,
    code: string,
    text: string,
    severity: 'info' | 'warning' | 'error',
  ): void {
    this.io.to(socketId).emit('system:notice', { code, text, severity });
  }

  announce(code: string, text: string, severity: 'info' | 'warning' | 'error' = 'info'): void {
    this.io.to(this.room).emit('system:notice', { code, text, severity });
    log.debug('Announcement', { match: this.match.code, code });
  }
}
