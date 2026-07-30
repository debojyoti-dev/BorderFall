import { Rng } from '@borderfall/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { EventBus } from './EventBus.js';
import { TickScheduler } from './TickScheduler.js';
import { createLogger } from '../utils/logger.js';
import type { ISimulationSystem, SystemContext } from './System.js';

/** Records every update so tests can assert on cadence and ordering. */
class RecordingSystem implements ISimulationSystem {
  readonly calls: Array<{ tick: number; elapsedMs: number; deltaMs: number }> = [];

  constructor(
    readonly name: string,
    readonly intervalMs: number,
    readonly order: number,
    private readonly sharedLog?: string[],
  ) {}

  update(context: SystemContext, deltaMs: number): void {
    this.calls.push({ tick: context.tick, elapsedMs: context.elapsedMs, deltaMs });
    this.sharedLog?.push(this.name);
  }
}

function makeHarness() {
  const bus = new EventBus();
  const rng = new Rng(1);
  const log = createLogger('test');

  const makeContext = (system: ISimulationSystem, tick = 0, elapsedMs = 0): SystemContext => ({
    matchId: 'test-match',
    bus,
    log,
    rng: rng.fork(system.name),
    elapsedMs,
    tick,
  });

  return { bus, makeContext };
}

describe('TickScheduler', () => {
  let scheduler: TickScheduler;
  let harness: ReturnType<typeof makeHarness>;

  beforeEach(() => {
    scheduler = new TickScheduler();
    harness = makeHarness();
  });

  it('rejects an interval that is not a multiple of the master tick', () => {
    expect(() => scheduler.register(new RecordingSystem('bad', 75, 1))).toThrow(/master tick/);
  });

  it('rejects a non-positive interval', () => {
    expect(() => scheduler.register(new RecordingSystem('bad', 0, 1))).toThrow(/positive/);
  });

  it('rejects duplicate system names', () => {
    scheduler.register(new RecordingSystem('dup', 100, 1));
    expect(() => scheduler.register(new RecordingSystem('dup', 100, 2))).toThrow(/Duplicate/);
  });

  it('rejects registration after start', () => {
    scheduler.start((system) => harness.makeContext(system));
    expect(() => scheduler.register(new RecordingSystem('late', 100, 1))).toThrow(/after/);
  });

  it('updates a system exactly once per its interval', () => {
    const fast = new RecordingSystem('fast', 50, 1);
    const slow = new RecordingSystem('slow', 1000, 2);
    scheduler.register(fast);
    scheduler.register(slow);
    scheduler.start((system) => harness.makeContext(system));

    // 20 master ticks == 1000 ms.
    for (let i = 0; i < 20; i++) {
      scheduler.advance(50, (system, tick, elapsed) => harness.makeContext(system, tick, elapsed));
    }

    expect(fast.calls).toHaveLength(20);
    expect(slow.calls).toHaveLength(1);
    expect(scheduler.tick).toBe(20);
    expect(scheduler.elapsedMs).toBe(1000);
  });

  it('always passes the fixed interval as deltaMs, never the real frame time', () => {
    const system = new RecordingSystem('combat', 100, 1);
    scheduler.register(system);
    scheduler.start((s) => harness.makeContext(s));

    // A single ragged 250 ms frame.
    scheduler.advance(250, (s, tick, elapsed) => harness.makeContext(s, tick, elapsed));

    expect(system.calls.length).toBeGreaterThan(0);
    for (const call of system.calls) {
      expect(call.deltaMs).toBe(100);
    }
  });

  it('executes systems in ascending order within a tick', () => {
    const order: string[] = [];
    scheduler.register(new RecordingSystem('late', 50, 900, order));
    scheduler.register(new RecordingSystem('early', 50, 100, order));
    scheduler.register(new RecordingSystem('middle', 50, 500, order));
    scheduler.start((system) => harness.makeContext(system));

    scheduler.advance(50, (system, tick, elapsed) => harness.makeContext(system, tick, elapsed));

    expect(order).toEqual(['early', 'middle', 'late']);
  });

  it('accumulates sub-tick time instead of discarding it', () => {
    const system = new RecordingSystem('combat', 100, 1);
    scheduler.register(system);
    scheduler.start((s) => harness.makeContext(s));

    // Three 30 ms frames = 90 ms: not yet a master tick boundary at 50 ms each,
    // but the residue must survive into the following call.
    scheduler.advance(30, (s, t, e) => harness.makeContext(s, t, e));
    scheduler.advance(30, (s, t, e) => harness.makeContext(s, t, e));
    expect(scheduler.tick).toBe(0);

    // The scheduler consumes whole master ticks only; leftover is caller-side,
    // so feed a full 100 ms and expect exactly two master ticks.
    scheduler.advance(100, (s, t, e) => harness.makeContext(s, t, e));
    expect(scheduler.tick).toBe(2);
    expect(system.calls).toHaveLength(1);
  });

  it('clamps catch-up instead of spiralling', () => {
    const system = new RecordingSystem('combat', 100, 1);
    scheduler.register(system);
    scheduler.start((s) => harness.makeContext(s));

    // Simulate a 10 second stall.
    const report = scheduler.advance(10_000, (s, t, e) => harness.makeContext(s, t, e));

    expect(report.droppedMs).toBeGreaterThan(0);
    // Capped at MAX_CATCHUP_MS (500 ms) => 10 master ticks => 5 combat updates.
    expect(report.ticksRun).toBe(10);
    expect(system.calls).toHaveLength(5);
  });

  it('reports elapsed simulation time monotonically', () => {
    scheduler.register(new RecordingSystem('a', 50, 1));
    scheduler.start((s) => harness.makeContext(s));

    const ticks: number[] = [];
    scheduler.advance(
      200,
      (s, t, e) => harness.makeContext(s, t, e),
      (tick) => ticks.push(tick),
    );

    expect(ticks).toEqual([1, 2, 3, 4]);
  });

  it('collects per-system timings', () => {
    const system = new RecordingSystem('economy', 1000, 1);
    scheduler.register(system);
    scheduler.start((s) => harness.makeContext(s));

    for (let i = 0; i < 20; i++) {
      scheduler.advance(50, (s, t, e) => harness.makeContext(s, t, e));
    }

    const timing = scheduler.getTimings().find((t) => t.name === 'economy');
    expect(timing).toBeDefined();
    expect(timing?.updates).toBe(1);
    expect(timing?.peakMs).toBeGreaterThanOrEqual(0);
  });

  it('produces an identical update trace for identical input', () => {
    const run = () => {
      const local = new TickScheduler();
      const localHarness = makeHarness();
      const population = new RecordingSystem('population', 1000, 100);
      const combat = new RecordingSystem('combat', 100, 400);
      const missiles = new RecordingSystem('missiles', 50, 600);
      local.register(population);
      local.register(combat);
      local.register(missiles);
      local.start((s) => localHarness.makeContext(s));

      for (let i = 0; i < 60; i++) {
        local.advance(50, (s, t, e) => localHarness.makeContext(s, t, e));
      }
      return {
        population: population.calls.map((c) => c.tick),
        combat: combat.calls.map((c) => c.tick),
        missiles: missiles.calls.map((c) => c.tick),
      };
    };

    expect(run()).toEqual(run());
  });

  it('disposes systems in reverse order and clears registrations', () => {
    const disposed: string[] = [];
    class Disposable implements ISimulationSystem {
      constructor(
        readonly name: string,
        readonly order: number,
      ) {}
      readonly intervalMs = 50;
      update(): void {}
      dispose(): void {
        disposed.push(this.name);
      }
    }

    scheduler.register(new Disposable('first', 100));
    scheduler.register(new Disposable('second', 200));
    scheduler.dispose();

    expect(disposed).toEqual(['second', 'first']);
    expect(scheduler.systemCount).toBe(0);
  });
});
