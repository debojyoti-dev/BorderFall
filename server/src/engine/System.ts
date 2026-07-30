import type { Rng } from '@borderfall/shared';
import type { EventBus } from './EventBus.js';
import type { Logger } from '../utils/logger.js';

/**
 * Everything a system is allowed to touch.
 *
 * Passed in rather than imported, which is what makes systems unit-testable
 * without a running server: a test constructs a context with a fake clock and a
 * seeded RNG, ticks the system, and asserts on the world. It is also what lets
 * one Node process host several independent matches — nothing is module-global.
 *
 * The world state itself is added to this interface in Phase 2, once the
 * territory store exists. Keeping the seam explicit from the start means adding
 * it later is an interface extension, not a refactor.
 */
export interface SystemContext {
  readonly matchId: string;
  readonly bus: EventBus;
  readonly log: Logger;

  /**
   * The simulation RNG, forked per system.
   *
   * Each system receives its *own* stream via `rng.fork(systemName)`, so adding
   * a random roll to combat can never shift the sequence the bot controller
   * observes. Without this, a balance tweak in one system silently changes the
   * behaviour of every other — and breaks every stored replay.
   */
  readonly rng: Rng;

  /** Simulation time since match start, in ms. Never wall-clock. */
  readonly elapsedMs: number;
  /** Master tick index since match start. */
  readonly tick: number;
}

/**
 * A single, isolated slice of the simulation.
 *
 * Contract:
 * - A system owns its data and mutates only what it owns.
 * - It communicates outward exclusively through {@link SystemContext.bus}.
 * - `update` must be **pure with respect to wall-clock time** — it may read
 *   `context.elapsedMs`, never `Date.now()`. This is what makes a replay
 *   reproduce a match exactly, and what lets a load test run a match at 100×
 *   speed.
 */
export interface ISimulationSystem {
  /** Stable identifier. Used for RNG stream derivation, logs and metrics. */
  readonly name: string;

  /**
   * Fixed interval between updates, in ms. Must be a multiple of the master
   * tick so systems never drift relative to one another.
   */
  readonly intervalMs: number;

  /**
   * Ordering within a single tick, ascending. Systems that produce inputs for
   * others run first — economy before construction, combat before leaderboard.
   * Explicit rather than registration-derived, because registration order is
   * easy to change by accident and impossible to reason about later.
   */
  readonly order: number;

  /** One-time setup: subscribe to the bus, allocate buffers. */
  init?(context: SystemContext): void;

  /**
   * Advance the system by exactly {@link intervalMs}.
   *
   * `deltaMs` is always the fixed interval, never the real frame time — a
   * variable timestep makes the simulation non-deterministic and therefore
   * un-replayable.
   */
  update(context: SystemContext, deltaMs: number): void;

  /** Release resources and unsubscribe. Called on match teardown. */
  dispose?(): void;
}

/**
 * Canonical execution order.
 *
 * Centralised here rather than scattered across system files so the whole
 * pipeline is readable in one place — the order *is* the architecture, and it
 * is the first thing anyone debugging a simulation bug needs to see.
 */
export const SystemOrder = {
  /** Growth first: everything downstream reads population. */
  Population: 100,
  /** Income derived from the population just computed. */
  Economy: 200,
  /** Spends the income; must follow it within the same tick. */
  Buildings: 300,
  /** Resolves in-flight attacks and applies ownership changes. */
  Combat: 400,
  /** Moves hulls and resolves naval engagements. */
  Ships: 500,
  /** Integrates flight and applies blast damage. */
  Missiles: 600,
  /** Alliance timers and cooldowns, after all combat has settled. */
  Diplomacy: 700,
  /** Bots decide last, so they observe a fully settled world. */
  Bots: 800,
  /** Pure readers of final state. */
  Leaderboard: 900,
  Victory: 1000,
} as const;

/** Convenience base class. Implementing the interface directly is equally fine. */
export abstract class BaseSystem implements ISimulationSystem {
  abstract readonly name: string;
  abstract readonly intervalMs: number;
  abstract readonly order: number;

  /** Unsubscribe callbacks collected by {@link subscribe}, released on dispose. */
  private readonly teardown: Array<() => void> = [];

  init?(context: SystemContext): void;

  abstract update(context: SystemContext, deltaMs: number): void;

  /** Registers a bus subscription that is automatically released on dispose. */
  protected subscribe(unsubscribe: () => void): void {
    this.teardown.push(unsubscribe);
  }

  dispose(): void {
    for (const unsubscribe of this.teardown) unsubscribe();
    this.teardown.length = 0;
  }
}
