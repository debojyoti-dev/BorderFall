import { createLogger, errorFields } from '../utils/logger.js';
import type { SimulationEventMap } from './events.js';

const log = createLogger('eventbus');

type Handler<T> = (payload: T) => void;

/**
 * Typed, deferred-dispatch event bus — the only channel through which
 * simulation systems talk to one another.
 *
 * ## Why systems may not call each other directly
 *
 * The combat system needs to tell the leaderboard, the replay recorder, the
 * statistics tracker and the bot controller that a territory changed hands. If
 * it called them directly it would need to import all four, and the "no giant
 * Game.ts" rule would be quietly violated by a web of cross-imports instead of
 * a single fat file. Here, `CombatSystem` imports nothing but the bus.
 *
 * ## Why dispatch is deferred by default
 *
 * `emit()` **queues**; the loop calls `flush()` once at the end of each tick.
 * If dispatch were immediate, a handler could mutate the world while the
 * emitting system was still iterating over it — the classic
 * modify-during-iteration bug, made much worse here because our "collection" is
 * a set of parallel typed arrays with no iterator to invalidate loudly. It
 * would simply produce a wrong simulation, silently, and differently on the
 * server than in a replay.
 *
 * Deferred dispatch also gives us a natural batching point and makes tick
 * boundaries meaningful for the replay recorder.
 *
 * ## Why a handler throwing does not abort the tick
 *
 * A bug in the leaderboard renderer must not take down a match containing 200
 * players. Handler errors are caught, logged with context, and the remaining
 * handlers still run.
 */
export class EventBus {
  private readonly handlers = new Map<string, Set<Handler<never>>>();

  /**
   * Queued events, stored as a flat alternating `[name, payload, ...]` array.
   * Flat rather than an array of `{name, payload}` objects because a busy tick
   * queues hundreds of events and we would otherwise allocate an envelope
   * object for every one of them, purely to throw it away microseconds later.
   */
  private queue: unknown[] = [];

  /**
   * The idle half of the double buffer.
   *
   * `flush` moves the pending batch here and installs this array as the live
   * `queue`, so dispatch iterates one array while handlers append to the other.
   */
  private spare: unknown[] = [];

  private flushing = false;

  /** Guards against an emit/handle cycle spinning the loop forever. */
  private static readonly MAX_FLUSH_PASSES = 8;

  on<K extends keyof SimulationEventMap & string>(
    event: K,
    handler: Handler<SimulationEventMap[K]>,
  ): () => void {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(handler as Handler<never>);

    // Returning the unsubscribe closure keeps teardown local to the subscriber,
    // so a system can dispose itself without the bus knowing its identity.
    return () => {
      this.handlers.get(event)?.delete(handler as Handler<never>);
    };
  }

  once<K extends keyof SimulationEventMap & string>(
    event: K,
    handler: Handler<SimulationEventMap[K]>,
  ): () => void {
    const unsubscribe = this.on(event, (payload) => {
      unsubscribe();
      handler(payload);
    });
    return unsubscribe;
  }

  /**
   * Queues an event for dispatch at the next {@link flush}.
   *
   * Always appends to `queue`, never to the batch being dispatched. During a
   * flush the two are guaranteed to be different arrays (see {@link flush}), so
   * a handler that re-emits cannot extend the collection its own dispatch loop
   * is walking — which would spin forever and never reach the cascade guard.
   */
  emit<K extends keyof SimulationEventMap & string>(
    event: K,
    payload: SimulationEventMap[K],
  ): void {
    this.queue.push(event, payload);
  }

  /**
   * Dispatches immediately, bypassing the queue.
   *
   * Reserved for lifecycle events fired outside a tick (match start, player
   * join). Calling this from inside a system tick is a bug — see the class
   * documentation.
   */
  emitImmediate<K extends keyof SimulationEventMap & string>(
    event: K,
    payload: SimulationEventMap[K],
  ): void {
    this.dispatch(event, payload);
  }

  /**
   * Dispatches everything queued, including events queued by handlers, up to
   * {@link MAX_FLUSH_PASSES} cascading passes.
   *
   * Cascades are legitimate — a capture eliminates a player, which dissolves an
   * alliance — but an unbounded cascade is a bug, and one that would otherwise
   * present as a frozen server rather than as an error.
   */
  flush(): void {
    if (this.flushing) return;
    this.flushing = true;

    try {
      let pass = 0;
      while (this.queue.length > 0) {
        if (++pass > EventBus.MAX_FLUSH_PASSES) {
          log.error('Event cascade exceeded pass limit; dropping remaining events', {
            passes: pass,
            dropped: this.queue.length / 2,
            next: String(this.queue[0]),
          });
          this.queue.length = 0;
          break;
        }

        // Park the pending batch and make the spare array live, so anything a
        // handler emits below lands in `queue` and is picked up next pass.
        const batch = this.queue;
        this.queue = this.spare;
        this.spare = batch;

        for (let i = 0; i < batch.length; i += 2) {
          this.dispatch(batch[i] as string, batch[i + 1]);
        }
        batch.length = 0;
      }
    } finally {
      this.flushing = false;
    }
  }

  /** Number of events awaiting dispatch. Used by tests and the metrics probe. */
  get pending(): number {
    return this.queue.length / 2;
  }

  /** Discards queued events without dispatching. Used when a match aborts. */
  clear(): void {
    this.queue.length = 0;
    this.spare.length = 0;
  }

  /** Removes every subscription. Called on match teardown to break references. */
  removeAllListeners(): void {
    this.handlers.clear();
  }

  listenerCount(event: string): number {
    return this.handlers.get(event)?.size ?? 0;
  }

  private dispatch(event: string, payload: unknown): void {
    const set = this.handlers.get(event);
    if (!set || set.size === 0) return;

    // Snapshot: a handler is allowed to unsubscribe itself (or another) during
    // dispatch, and mutating the Set mid-iteration would skip handlers.
    for (const handler of [...set]) {
      try {
        (handler as Handler<unknown>)(payload);
      } catch (error) {
        log.error('Event handler threw', { event, ...errorFields(error) });
      }
    }
  }
}
