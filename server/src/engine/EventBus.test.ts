import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventBus } from './EventBus.js';

describe('EventBus', () => {
  let bus: EventBus;

  beforeEach(() => {
    bus = new EventBus();
  });

  it('does not dispatch until flush', () => {
    const handler = vi.fn();
    bus.on('sim:tick', handler);

    bus.emit('sim:tick', { tick: 1, elapsedMs: 50 });
    expect(handler).not.toHaveBeenCalled();
    expect(bus.pending).toBe(1);

    bus.flush();
    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith({ tick: 1, elapsedMs: 50 });
    expect(bus.pending).toBe(0);
  });

  it('preserves emission order across different event names', () => {
    const seen: string[] = [];
    bus.on('sim:tick', () => seen.push('tick'));
    bus.on('leaderboard:updated', () => seen.push('leaderboard'));

    bus.emit('sim:tick', { tick: 1, elapsedMs: 50 });
    bus.emit('leaderboard:updated', { tick: 1 });
    bus.emit('sim:tick', { tick: 2, elapsedMs: 100 });
    bus.flush();

    expect(seen).toEqual(['tick', 'leaderboard', 'tick']);
  });

  it('dispatches to every subscriber of an event', () => {
    const a = vi.fn();
    const b = vi.fn();
    bus.on('sim:tick', a);
    bus.on('sim:tick', b);

    bus.emit('sim:tick', { tick: 1, elapsedMs: 50 });
    bus.flush();

    expect(a).toHaveBeenCalledOnce();
    expect(b).toHaveBeenCalledOnce();
  });

  it('stops delivering after unsubscribe', () => {
    const handler = vi.fn();
    const unsubscribe = bus.on('sim:tick', handler);
    unsubscribe();

    bus.emit('sim:tick', { tick: 1, elapsedMs: 50 });
    bus.flush();
    expect(handler).not.toHaveBeenCalled();
  });

  it('delivers a once() handler exactly one time', () => {
    const handler = vi.fn();
    bus.once('sim:tick', handler);

    bus.emit('sim:tick', { tick: 1, elapsedMs: 50 });
    bus.emit('sim:tick', { tick: 2, elapsedMs: 100 });
    bus.flush();

    expect(handler).toHaveBeenCalledOnce();
  });

  it('isolates a throwing handler from its peers', () => {
    const failing = vi.fn(() => {
      throw new Error('handler exploded');
    });
    const healthy = vi.fn();
    bus.on('sim:tick', failing);
    bus.on('sim:tick', healthy);

    bus.emit('sim:tick', { tick: 1, elapsedMs: 50 });
    expect(() => bus.flush()).not.toThrow();
    expect(healthy).toHaveBeenCalledOnce();
  });

  it('dispatches events emitted from inside a handler on a later pass', () => {
    const seen: string[] = [];
    bus.on('territory:captured', () => {
      seen.push('captured');
      bus.emit('leaderboard:updated', { tick: 1 });
    });
    bus.on('leaderboard:updated', () => seen.push('leaderboard'));

    bus.emit('territory:captured', {
      territory: 1,
      previousOwner: 0,
      newOwner: 2,
      troopsLost: 10,
      tick: 1,
    });
    bus.flush();

    expect(seen).toEqual(['captured', 'leaderboard']);
    expect(bus.pending).toBe(0);
  });

  it('breaks an infinite emit cascade after a bounded number of passes', () => {
    // A handler that re-emits its own event loops forever without a cap. The
    // assertion that matters is that the work is *bounded* — an earlier
    // implementation appended into the array being iterated, so this spun
    // until V8 threw RangeError while still satisfying `not.toThrow()`.
    let invocations = 0;
    bus.on('sim:tick', () => {
      invocations++;
      bus.emit('sim:tick', { tick: 0, elapsedMs: 0 });
    });

    bus.emit('sim:tick', { tick: 1, elapsedMs: 50 });

    const startedAt = performance.now();
    bus.flush();
    const durationMs = performance.now() - startedAt;

    // One invocation per pass, capped by MAX_FLUSH_PASSES.
    expect(invocations).toBeLessThanOrEqual(8);
    expect(invocations).toBeGreaterThan(0);
    expect(durationMs).toBeLessThan(100);
    expect(bus.pending).toBe(0);
  });

  it('does not let a re-emitting handler extend the batch being dispatched', () => {
    // Two events queued; the first handler emits a third. That third must be
    // dispatched on the *next* pass, after both originals — not spliced into
    // the batch currently being walked.
    const seen: string[] = [];
    bus.on('territory:captured', (event) => {
      seen.push(`captured:${event.territory}`);
      if (event.territory === 1) {
        bus.emit('leaderboard:updated', { tick: 99 });
      }
    });
    bus.on('leaderboard:updated', (event) => seen.push(`leaderboard:${event.tick}`));

    const capture = (territory: number) => ({
      territory,
      previousOwner: 0,
      newOwner: 2,
      troopsLost: 0,
      tick: 1,
    });
    bus.emit('territory:captured', capture(1));
    bus.emit('territory:captured', capture(2));
    bus.flush();

    expect(seen).toEqual(['captured:1', 'captured:2', 'leaderboard:99']);
  });

  it('allows a handler to unsubscribe another during dispatch', () => {
    const second = vi.fn();
    const unsubscribeSecond = bus.on('sim:tick', second);
    // Registered after, but the snapshot means `second` still runs this pass.
    bus.on('sim:tick', () => unsubscribeSecond());

    bus.emit('sim:tick', { tick: 1, elapsedMs: 50 });
    bus.flush();
    expect(second).toHaveBeenCalledOnce();

    bus.emit('sim:tick', { tick: 2, elapsedMs: 100 });
    bus.flush();
    expect(second).toHaveBeenCalledOnce();
  });

  it('emitImmediate bypasses the queue', () => {
    const handler = vi.fn();
    bus.on('sim:started', handler);

    bus.emitImmediate('sim:started', { matchId: 'm1', startedAt: 0 });
    expect(handler).toHaveBeenCalledOnce();
    expect(bus.pending).toBe(0);
  });

  it('clear discards queued events without dispatching', () => {
    const handler = vi.fn();
    bus.on('sim:tick', handler);

    bus.emit('sim:tick', { tick: 1, elapsedMs: 50 });
    bus.clear();
    bus.flush();

    expect(handler).not.toHaveBeenCalled();
  });

  it('reports and clears listener registrations', () => {
    bus.on('sim:tick', vi.fn());
    bus.on('sim:tick', vi.fn());
    expect(bus.listenerCount('sim:tick')).toBe(2);

    bus.removeAllListeners();
    expect(bus.listenerCount('sim:tick')).toBe(0);
  });

  it('tolerates emitting an event nobody listens to', () => {
    bus.emit('sim:tick', { tick: 1, elapsedMs: 50 });
    expect(() => bus.flush()).not.toThrow();
    expect(bus.pending).toBe(0);
  });
});
