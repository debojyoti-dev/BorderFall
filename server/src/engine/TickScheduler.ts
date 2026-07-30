import { MASTER_TICK_MS, MAX_CATCHUP_MS, TICK_BUDGET_WARN_MS } from '@borderfall/shared';
import type { ISimulationSystem, SystemContext } from './System.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('scheduler');

export interface SystemTiming {
  readonly name: string;
  /** Milliseconds spent in this system during the last completed master tick. */
  lastMs: number;
  /** Exponential moving average of `lastMs`, for stable dashboards. */
  averageMs: number;
  /** Worst observed duration since the last {@link TickScheduler.resetPeaks}. */
  peakMs: number;
  /** Total invocations since match start. */
  updates: number;
}

export interface TickReport {
  readonly tick: number;
  readonly elapsedMs: number;
  /** Master ticks executed in this call to {@link TickScheduler.advance}. */
  readonly ticksRun: number;
  /** Real time spent inside the simulation, in ms. */
  readonly durationMs: number;
  /** Simulation time discarded because the server could not keep up. */
  readonly droppedMs: number;
}

/**
 * Drives every system on a fixed timestep from a single wall-clock source.
 *
 * ## Why one loop with per-system accumulators
 *
 * The obvious implementation is one `setInterval` per system — 1 s for
 * population, 100 ms for combat, 50 ms for missiles. It is also wrong. Node
 * timers have no ordering guarantee between them, so with ten independent
 * intervals the relative order of "economy runs" and "buildings spend" varies
 * from tick to tick, and the simulation stops being reproducible. Replays
 * diverge, and load-test results become noise.
 *
 * One master interval with an accumulator per system gives us: a single timer,
 * a deterministic within-tick ordering (by `system.order`), exact intervals
 * regardless of timer jitter, and the ability to run the whole simulation
 * without a clock at all — which is exactly what replay verification and
 * headless load tests need.
 *
 * ## Why time is clamped rather than fully repaid
 *
 * If the process stalls (GC pause, a blocking DB write, the machine
 * suspending), the accumulator can hold seconds of unsimulated time. Replaying
 * all of it in one pass takes longer than the stall itself, which builds more
 * backlog — the classic spiral of death. Above {@link MAX_CATCHUP_MS} the
 * excess is dropped and reported. A brief simulation hiccup is recoverable;
 * a server that never catches up is not.
 */
export class TickScheduler {
  private readonly systems: ISimulationSystem[] = [];
  /** Accumulated unsimulated time per system, index-aligned with `systems`. */
  private readonly accumulators: number[] = [];
  private readonly timings = new Map<string, SystemTiming>();

  private tickIndex = 0;
  private elapsed = 0;
  private started = false;

  /**
   * Registers a system. Ordering is applied here, once, rather than sorted per
   * tick — the sort is O(n log n) and the set never changes after start-up.
   */
  register(system: ISimulationSystem): void {
    if (this.started) {
      throw new Error(`Cannot register system "${system.name}" after the scheduler has started`);
    }
    if (system.intervalMs % MASTER_TICK_MS !== 0) {
      // Enforced rather than rounded: a silently-adjusted interval would make
      // the balance numbers in shared/constants quietly untrue.
      throw new Error(
        `System "${system.name}" has interval ${system.intervalMs}ms, which is not a multiple ` +
          `of the ${MASTER_TICK_MS}ms master tick. Non-aligned intervals cause systems to drift ` +
          `relative to one another and break replay determinism.`,
      );
    }
    if (system.intervalMs <= 0) {
      throw new Error(`System "${system.name}" must have a positive interval`);
    }
    if (this.systems.some((existing) => existing.name === system.name)) {
      throw new Error(`Duplicate system name "${system.name}"`);
    }

    this.systems.push(system);
    this.systems.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));

    // Rebuild accumulators so they stay index-aligned after the sort.
    this.accumulators.length = 0;
    for (let i = 0; i < this.systems.length; i++) this.accumulators.push(0);

    this.timings.set(system.name, {
      name: system.name,
      lastMs: 0,
      averageMs: 0,
      peakMs: 0,
      updates: 0,
    });
  }

  /** Runs every system's `init`. Call once, before the first {@link advance}. */
  start(makeContext: (system: ISimulationSystem) => SystemContext): void {
    if (this.started) return;
    this.started = true;
    for (const system of this.systems) {
      system.init?.(makeContext(system));
    }
  }

  /**
   * Advances the simulation by `deltaMs` of real time.
   *
   * The caller supplies the delta rather than the scheduler reading a clock, so
   * that a replay or a load test can feed synthetic time and run a ten-minute
   * match in a few seconds.
   */
  advance(
    deltaMs: number,
    makeContext: (system: ISimulationSystem, tick: number, elapsedMs: number) => SystemContext,
    onTick?: (tick: number, elapsedMs: number) => void,
  ): TickReport {
    const startedAt = performance.now();

    let budget = deltaMs;
    let dropped = 0;
    if (budget > MAX_CATCHUP_MS) {
      dropped = budget - MAX_CATCHUP_MS;
      budget = MAX_CATCHUP_MS;
      log.warn('Simulation fell behind; discarding backlog', {
        droppedMs: Math.round(dropped),
        tick: this.tickIndex,
      });
    }

    let ticksRun = 0;
    while (budget >= MASTER_TICK_MS) {
      budget -= MASTER_TICK_MS;
      this.elapsed += MASTER_TICK_MS;
      this.tickIndex++;
      ticksRun++;
      this.runMasterTick(makeContext);
      onTick?.(this.tickIndex, this.elapsed);
    }

    const durationMs = performance.now() - startedAt;
    if (durationMs > TICK_BUDGET_WARN_MS && ticksRun > 0) {
      log.warn('Tick exceeded budget', {
        tick: this.tickIndex,
        durationMs: Math.round(durationMs * 100) / 100,
        ticksRun,
        slowest: this.slowestSystem()?.name ?? 'unknown',
      });
    }

    return {
      tick: this.tickIndex,
      elapsedMs: this.elapsed,
      ticksRun,
      durationMs,
      droppedMs: dropped,
    };
  }

  private runMasterTick(
    makeContext: (system: ISimulationSystem, tick: number, elapsedMs: number) => SystemContext,
  ): void {
    for (let i = 0; i < this.systems.length; i++) {
      const system = this.systems[i] as ISimulationSystem;
      let accumulated = (this.accumulators[i] as number) + MASTER_TICK_MS;

      if (accumulated < system.intervalMs) {
        this.accumulators[i] = accumulated;
        continue;
      }

      const measure = performance.now();
      let updates = 0;
      while (accumulated >= system.intervalMs) {
        accumulated -= system.intervalMs;
        system.update(makeContext(system, this.tickIndex, this.elapsed), system.intervalMs);
        updates++;
      }
      this.accumulators[i] = accumulated;
      this.recordTiming(system.name, performance.now() - measure, updates);
    }
  }

  private recordTiming(name: string, durationMs: number, updates: number): void {
    const timing = this.timings.get(name);
    if (!timing) return;
    timing.lastMs = durationMs;
    // EMA with alpha 0.1 — smooth enough to be readable on a dashboard, fast
    // enough to show a regression within a couple of seconds.
    timing.averageMs =
      timing.averageMs === 0 ? durationMs : timing.averageMs * 0.9 + durationMs * 0.1;
    if (durationMs > timing.peakMs) timing.peakMs = durationMs;
    timing.updates += updates;
  }

  private slowestSystem(): SystemTiming | undefined {
    let worst: SystemTiming | undefined;
    for (const timing of this.timings.values()) {
      if (!worst || timing.lastMs > worst.lastMs) worst = timing;
    }
    return worst;
  }

  /** Per-system timings, for the metrics endpoint. */
  getTimings(): SystemTiming[] {
    return [...this.timings.values()];
  }

  resetPeaks(): void {
    for (const timing of this.timings.values()) timing.peakMs = 0;
  }

  get tick(): number {
    return this.tickIndex;
  }

  get elapsedMs(): number {
    return this.elapsed;
  }

  get systemCount(): number {
    return this.systems.length;
  }

  /** Registered systems in execution order. */
  getSystems(): readonly ISimulationSystem[] {
    return this.systems;
  }

  dispose(): void {
    // Reverse order so a system can rely on its dependencies still being alive.
    for (let i = this.systems.length - 1; i >= 0; i--) {
      this.systems[i]?.dispose?.();
    }
    this.systems.length = 0;
    this.accumulators.length = 0;
    this.timings.clear();
    this.started = false;
  }
}
