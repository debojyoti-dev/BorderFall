import {
  GameMode,
  MatchState,
  RoomVisibility,
  generateRoomCode,
  randomSeed,
  type RoomSummary,
} from '@borderfall/shared';
import { env } from '../config/env.js';
import { createLogger } from '../utils/logger.js';
import { Metric, metrics } from '../services/metrics.js';
import { MatchInstance, type MatchConfig } from './MatchInstance.js';
import { registerCoreSystems } from '../systems/index.js';

const log = createLogger('matches');

/**
 * Owns every match in this process: creation, lookup, and reaping.
 *
 * Kept separate from the socket gateway so that room lifecycle is testable
 * without a transport, and so a future Redis-backed registry can replace this
 * one by implementing the same surface.
 */
export class MatchManager {
  private readonly byId = new Map<string, MatchInstance>();
  private readonly byCode = new Map<string, MatchInstance>();

  private reaperHandle: ReturnType<typeof setInterval> | null = null;

  /** How long an empty match lingers before being torn down. */
  private static readonly EMPTY_GRACE_MS = 60_000;
  private readonly emptySince = new Map<string, number>();

  constructor(private readonly maxConcurrent = env.maxConcurrentMatches) {
    // Reaping on a timer rather than on player-leave: a match can also empty
    // out through reconnect-grace expiry inside the simulation, which the
    // manager never observes directly.
    this.reaperHandle = setInterval(() => this.reap(), 15_000);
    this.reaperHandle.unref();
  }

  create(partial: Partial<MatchConfig> = {}): MatchInstance | null {
    if (this.byId.size >= this.maxConcurrent) {
      log.warn('Match creation refused; at capacity', { active: this.byId.size });
      return null;
    }

    const config: MatchConfig = {
      name: partial.name ?? 'Public Match',
      mode: partial.mode ?? GameMode.FreeForAll,
      visibility: partial.visibility ?? RoomVisibility.Public,
      password: partial.password,
      maxPlayers: clamp(partial.maxPlayers ?? 64, 2, 256),
      territoryCount: clamp(partial.territoryCount ?? 2500, 256, 20_000),
      seed: partial.seed ?? randomSeed(),
      botCount: clamp(partial.botCount ?? 0, 0, 128),
    };

    const code = this.allocateCode();
    const match = new MatchInstance(config, code);

    // Systems are registered at creation, before the scheduler starts — it
    // rejects late registration precisely so ordering cannot change mid-match.
    registerCoreSystems(match);

    this.byId.set(match.id, match);
    this.byCode.set(code, match);
    metrics.setGauge(Metric.matchesActive, this.byId.size);

    return match;
  }

  /**
   * Finds a public match with room, or creates one.
   *
   * Prefers the *fullest* joinable match rather than the emptiest. Spreading
   * players thinly across many half-empty rooms is the failure mode that kills
   * a session-based game at low population: everyone sees a lobby list of
   * one-player rooms and leaves.
   */
  findOrCreatePublic(): MatchInstance | null {
    let best: MatchInstance | null = null;

    for (const match of this.byId.values()) {
      if (match.config.visibility !== RoomVisibility.Public) continue;
      if (!match.hasCapacity) continue;
      if (match.matchState === MatchState.Ending || match.matchState === MatchState.Finished) {
        continue;
      }
      if (!best || match.players.activeCount > best.players.activeCount) best = match;
    }

    return best ?? this.create();
  }

  getById(id: string): MatchInstance | undefined {
    return this.byId.get(id);
  }

  getByCode(code: string): MatchInstance | undefined {
    return this.byCode.get(code.toUpperCase());
  }

  /** Accepts either a match id or a room code, since clients use both. */
  resolve(idOrCode: string): MatchInstance | undefined {
    return this.byId.get(idOrCode) ?? this.byCode.get(idOrCode.toUpperCase());
  }

  /** Public, joinable rooms for the lobby browser. */
  listPublic(): RoomSummary[] {
    const rooms: RoomSummary[] = [];
    for (const match of this.byId.values()) {
      if (match.config.visibility === RoomVisibility.Private) continue;
      if (match.matchState === MatchState.Finished) continue;
      rooms.push(this.summarise(match));
    }
    return rooms.sort((a, b) => b.playerCount - a.playerCount);
  }

  summarise(match: MatchInstance): RoomSummary {
    return {
      id: match.id,
      code: match.code,
      name: match.config.name,
      mode: match.config.mode,
      visibility: match.config.visibility,
      state: match.matchState,
      playerCount: match.players.humanCount,
      botCount: match.players.botCount,
      spectatorCount: 0,
      maxPlayers: match.config.maxPlayers,
      territoryCount: match.world.territoryCount,
      // Never leak the password itself, only whether one is required.
      requiresPassword:
        match.config.visibility === RoomVisibility.PasswordProtected &&
        typeof match.config.password === 'string' &&
        match.config.password.length > 0,
      createdAt: match.createdAt,
      elapsedMs: match.elapsedMs,
    };
  }

  destroy(id: string): void {
    const match = this.byId.get(id);
    if (!match) return;

    match.dispose();
    this.byId.delete(id);
    this.byCode.delete(match.code);
    this.emptySince.delete(id);
    metrics.setGauge(Metric.matchesActive, this.byId.size);
    log.info('Match destroyed', { code: match.code });
  }

  /**
   * Tears down matches that have been empty for the grace period, and finished
   * matches immediately.
   *
   * The grace exists so a host who reloads their browser does not lose the room
   * they just configured and shared a code for.
   */
  private reap(): void {
    const now = Date.now();

    for (const [id, match] of this.byId) {
      if (match.matchState === MatchState.Finished) {
        this.destroy(id);
        continue;
      }

      if (!match.isEmpty) {
        this.emptySince.delete(id);
        continue;
      }

      const since = this.emptySince.get(id);
      if (since === undefined) {
        this.emptySince.set(id, now);
      } else if (now - since >= MatchManager.EMPTY_GRACE_MS) {
        log.info('Reaping empty match', { code: match.code });
        this.destroy(id);
      }
    }
  }

  private allocateCode(): string {
    // Collisions are vanishingly rare in a 31^6 space, but a duplicate would
    // silently route players into the wrong game, so it is checked.
    for (let attempt = 0; attempt < 32; attempt++) {
      const code = generateRoomCode(Math.random);
      if (!this.byCode.has(code)) return code;
    }
    return generateRoomCode(Math.random, 10);
  }

  get activeCount(): number {
    return this.byId.size;
  }

  all(): MatchInstance[] {
    return [...this.byId.values()];
  }

  disposeAll(): void {
    if (this.reaperHandle !== null) {
      clearInterval(this.reaperHandle);
      this.reaperHandle = null;
    }
    for (const id of [...this.byId.keys()]) this.destroy(id);
  }
}

function clamp(value: number, min: number, max: number): number {
  return Number.isFinite(value) ? Math.max(min, Math.min(max, Math.floor(value))) : min;
}
