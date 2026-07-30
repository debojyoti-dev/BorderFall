import type { Rng } from '../utils/prng.js';

/**
 * Deterministic gradient (Perlin) noise with fractal Brownian motion.
 *
 * Used for elevation and moisture fields during world generation. Must be
 * bit-identical on server and client — the whole seed-replication scheme
 * depends on it — so the permutation table is built from the simulation
 * {@link Rng} rather than from any ambient randomness.
 *
 * Gradient noise rather than value noise: value noise has visible axis-aligned
 * artefacts that show up as suspiciously straight coastlines, which players
 * read (correctly) as "generated" rather than as terrain.
 */
export class NoiseField {
  /**
   * Doubled permutation table.
   *
   * Duplicating the 256 entries lets the lookup skip a `& 255` on the second
   * index, which matters when sampling four corners per octave across six
   * octaves for every one of 5 000 territories.
   */
  private readonly perm = new Uint8Array(512);

  constructor(rng: Rng) {
    const source = new Uint8Array(256);
    for (let i = 0; i < 256; i++) source[i] = i;
    // Fisher-Yates through the simulation RNG keeps the table reproducible.
    for (let i = 255; i > 0; i--) {
      const j = rng.nextInt(0, i);
      const tmp = source[i] as number;
      source[i] = source[j] as number;
      source[j] = tmp;
    }
    for (let i = 0; i < 512; i++) this.perm[i] = source[i & 255] as number;
  }

  /** Single-octave gradient noise. Returns roughly `[-1, 1]`. */
  noise2D(x: number, y: number): number {
    const xi = Math.floor(x) & 255;
    const yi = Math.floor(y) & 255;
    const xf = x - Math.floor(x);
    const yf = y - Math.floor(y);

    const u = fade(xf);
    const v = fade(yf);

    const perm = this.perm;
    const a = (perm[xi] as number) + yi;
    const b = (perm[xi + 1] as number) + yi;

    return lerp(
      lerp(grad(perm[a] as number, xf, yf), grad(perm[b] as number, xf - 1, yf), u),
      lerp(grad(perm[a + 1] as number, xf, yf - 1), grad(perm[b + 1] as number, xf - 1, yf - 1), u),
      v,
    );
  }

  /**
   * Fractal Brownian motion — several octaves of {@link noise2D} at doubling
   * frequency and halving amplitude.
   *
   * Normalised by the total amplitude so the result stays in `[-1, 1]`
   * regardless of octave count; without that, changing `octaves` would silently
   * shift every sea-level threshold that consumes this field.
   */
  fbm(x: number, y: number, octaves = 5, lacunarity = 2, gain = 0.5): number {
    let amplitude = 1;
    let frequency = 1;
    let sum = 0;
    let normalisation = 0;

    for (let i = 0; i < octaves; i++) {
      sum += this.noise2D(x * frequency, y * frequency) * amplitude;
      normalisation += amplitude;
      amplitude *= gain;
      frequency *= lacunarity;
    }

    return normalisation === 0 ? 0 : sum / normalisation;
  }

  /**
   * Ridged multifractal — sharp crests instead of rolling hills.
   *
   * Applied to the mountain mask so ranges form connected chains rather than
   * isolated blobs, which makes them read as real orography and gives them
   * strategic meaning as natural borders.
   */
  ridged(x: number, y: number, octaves = 4): number {
    let amplitude = 1;
    let frequency = 1;
    let sum = 0;
    let normalisation = 0;

    for (let i = 0; i < octaves; i++) {
      const value = 1 - Math.abs(this.noise2D(x * frequency, y * frequency));
      sum += value * value * amplitude;
      normalisation += amplitude;
      amplitude *= 0.5;
      frequency *= 2;
    }

    return normalisation === 0 ? 0 : sum / normalisation;
  }
}

/** Quintic ease curve — zero first and second derivatives at 0 and 1. */
function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function lerp(a: number, b: number, t: number): number {
  return a + t * (b - a);
}

/** Dot product with one of eight unit gradients selected by the hash. */
function grad(hash: number, x: number, y: number): number {
  switch (hash & 7) {
    case 0:
      return x + y;
    case 1:
      return -x + y;
    case 2:
      return x - y;
    case 3:
      return -x - y;
    case 4:
      return x;
    case 5:
      return -x;
    case 6:
      return y;
    default:
      return -y;
  }
}
