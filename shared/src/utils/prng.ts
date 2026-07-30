/**
 * Deterministic pseudo-random number generation.
 *
 * Three properties matter here, and `Math.random()` provides none of them:
 *
 * 1. **Reproducibility.** The client regenerates the world from a 4-byte seed
 *    instead of downloading ~2 MB of polygons. That only works if both sides
 *    produce a bit-identical stream.
 * 2. **Replayability.** A replay stores commands, not state. Re-running the
 *    simulation must reproduce every combat roll exactly, so the simulation RNG
 *    is seeded from the match seed and advanced only by the simulation.
 * 3. **Stream isolation.** Map generation, combat and bot decisions each take an
 *    independent {@link Rng} derived via {@link Rng.fork}. Without this, adding a
 *    single extra combat roll would shift the map generator's stream and change
 *    the terrain — a class of bug that is agonising to track down.
 *
 * Algorithm: xoshiro128**, seeded through SplitMix32. Chosen over a bare LCG
 * because low bits of an LCG are notoriously non-random (visible as grid
 * artefacts in Poisson-disc sampling), and over Mersenne Twister because we
 * need cheap forking and a tiny state.
 */

/** Expands a single 32-bit seed into well-distributed state words. */
function splitMix32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x9e3779b9) >>> 0;
    let z = s;
    z = Math.imul(z ^ (z >>> 16), 0x21f0aaad) >>> 0;
    z = Math.imul(z ^ (z >>> 15), 0x735a2d97) >>> 0;
    return (z ^ (z >>> 15)) >>> 0;
  };
}

function rotl(x: number, k: number): number {
  return ((x << k) | (x >>> (32 - k))) >>> 0;
}

export class Rng {
  private s0: number;
  private s1: number;
  private s2: number;
  private s3: number;

  /** Number of values drawn. Exposed so replays can assert stream alignment. */
  private drawCount = 0;

  constructor(seed: number) {
    const mix = splitMix32(seed >>> 0);
    this.s0 = mix();
    this.s1 = mix();
    this.s2 = mix();
    this.s3 = mix();

    // An all-zero state is a fixed point for xoshiro; make it impossible.
    if ((this.s0 | this.s1 | this.s2 | this.s3) === 0) {
      this.s0 = 0x9e3779b9;
    }
  }

  /** Raw 32-bit unsigned draw. Every other method routes through this one. */
  nextUint32(): number {
    const result = (Math.imul(rotl(Math.imul(this.s1, 5) >>> 0, 7) >>> 0, 9) >>> 0) >>> 0;
    const t = (this.s1 << 9) >>> 0;

    this.s2 = (this.s2 ^ this.s0) >>> 0;
    this.s3 = (this.s3 ^ this.s1) >>> 0;
    this.s1 = (this.s1 ^ this.s2) >>> 0;
    this.s0 = (this.s0 ^ this.s3) >>> 0;
    this.s2 = (this.s2 ^ t) >>> 0;
    this.s3 = rotl(this.s3, 11);

    this.drawCount++;
    return result;
  }

  /** Uniform float in `[0, 1)`. */
  nextFloat(): number {
    // 2^-32. Using the full 32 bits keeps the low-order entropy that a
    // `% n` reduction would otherwise waste.
    return this.nextUint32() * 2.3283064365386963e-10;
  }

  /** Uniform float in `[min, max)`. */
  nextRange(min: number, max: number): number {
    return min + this.nextFloat() * (max - min);
  }

  /**
   * Uniform integer in `[min, max]` inclusive, without modulo bias.
   *
   * Rejection sampling matters more than it looks: combat criticals and bot
   * target selection both draw small integers, and a biased low bit there is
   * exactly the kind of thing players reverse-engineer and exploit.
   */
  nextInt(min: number, max: number): number {
    if (max <= min) return min;
    const range = max - min + 1;
    const limit = Math.floor(0x100000000 / range) * range;
    let draw = this.nextUint32();
    while (draw >= limit) draw = this.nextUint32();
    return min + (draw % range);
  }

  /** True with probability `p`. */
  chance(p: number): boolean {
    if (p <= 0) return false;
    if (p >= 1) return true;
    return this.nextFloat() < p;
  }

  /** Uniformly picks an element. Throws on an empty input — a caller bug. */
  pick<T>(items: readonly T[]): T {
    if (items.length === 0) {
      throw new RangeError('Rng.pick called with an empty array');
    }
    return items[this.nextInt(0, items.length - 1)] as T;
  }

  /** In-place Fisher–Yates. Returns the same array for chaining. */
  shuffle<T>(items: T[]): T[] {
    for (let i = items.length - 1; i > 0; i--) {
      const j = this.nextInt(0, i);
      const tmp = items[i] as T;
      items[i] = items[j] as T;
      items[j] = tmp;
    }
    return items;
  }

  /**
   * Standard normal via Box–Muller.
   *
   * Used for terrain elevation jitter, where uniform noise reads as visually
   * "flat" and a bell curve produces more natural clustering.
   */
  nextGaussian(mean = 0, stdDev = 1): number {
    // Guard against log(0).
    let u = this.nextFloat();
    while (u === 0) u = this.nextFloat();
    const v = this.nextFloat();
    return mean + stdDev * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  /**
   * Derives an independent generator.
   *
   * `label` is hashed into the child seed so that named streams ("combat",
   * "mapgen") stay stable even if the order in which they are created changes.
   */
  fork(label: string): Rng {
    let h = 0x811c9dc5;
    for (let i = 0; i < label.length; i++) {
      h ^= label.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return new Rng((this.nextUint32() ^ h) >>> 0);
  }

  /** Snapshot of internal state, for persisting a mid-match simulation. */
  saveState(): RngState {
    return { s0: this.s0, s1: this.s1, s2: this.s2, s3: this.s3, draws: this.drawCount };
  }

  /** Restores a snapshot produced by {@link saveState}. */
  restoreState(state: RngState): void {
    this.s0 = state.s0 >>> 0;
    this.s1 = state.s1 >>> 0;
    this.s2 = state.s2 >>> 0;
    this.s3 = state.s3 >>> 0;
    this.drawCount = state.draws;
  }

  get draws(): number {
    return this.drawCount;
  }
}

export interface RngState {
  readonly s0: number;
  readonly s1: number;
  readonly s2: number;
  readonly s3: number;
  readonly draws: number;
}

/** Converts a human-typed seed string into the 32-bit seed the engine uses. */
export function seedFromString(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** A fresh non-deterministic seed, for creating (not replaying) a match. */
export function randomSeed(): number {
  return (Math.floor(Math.random() * 0x100000000) ^ Date.now()) >>> 0;
}
