import type { Rng } from '../utils/prng.js';

/**
 * Bridson Poisson-disc sampling.
 *
 * Produces points that are randomly placed but never closer than `radius` to
 * one another, in O(n).
 *
 * **Why not uniform random placement?** Uniform points clump. Clumped Voronoi
 * sites produce a mix of slivers and giant cells, which is bad three times
 * over: slivers are unclickable, giant cells are strategically overpowered, and
 * the size variance makes per-territory balance impossible to tune. Poisson
 * discs give the blue-noise distribution that yields evenly sized cells while
 * still looking organic rather than gridded.
 */
export interface PoissonResult {
  readonly xs: Float32Array;
  readonly ys: Float32Array;
  readonly count: number;
}

export function poissonDiscSample(
  width: number,
  height: number,
  radius: number,
  rng: Rng,
  attemptsPerPoint = 24,
): PoissonResult {
  // Background grid sized so each cell holds at most one sample, making the
  // "is anything too close?" test a fixed 5x5 cell scan instead of a search.
  const cellSize = radius / Math.SQRT2;
  const cols = Math.ceil(width / cellSize);
  const rows = Math.ceil(height / cellSize);

  const grid = new Int32Array(cols * rows).fill(-1);

  // Upper bound on samples for a Poisson disc packing, with headroom.
  const capacity = Math.ceil(((width * height) / (radius * radius)) * 2) + 64;
  const xs = new Float32Array(capacity);
  const ys = new Float32Array(capacity);
  let count = 0;

  const active: number[] = [];

  const gridIndex = (x: number, y: number): number => {
    const col = Math.min(cols - 1, Math.max(0, Math.floor(x / cellSize)));
    const row = Math.min(rows - 1, Math.max(0, Math.floor(y / cellSize)));
    return row * cols + col;
  };

  const isFarEnough = (x: number, y: number): boolean => {
    const col = Math.floor(x / cellSize);
    const row = Math.floor(y / cellSize);
    const minCol = Math.max(0, col - 2);
    const maxCol = Math.min(cols - 1, col + 2);
    const minRow = Math.max(0, row - 2);
    const maxRow = Math.min(rows - 1, row + 2);

    for (let r = minRow; r <= maxRow; r++) {
      for (let c = minCol; c <= maxCol; c++) {
        const other = grid[r * cols + c] as number;
        if (other < 0) continue;
        const dx = (xs[other] as number) - x;
        const dy = (ys[other] as number) - y;
        if (dx * dx + dy * dy < radius * radius) return false;
      }
    }
    return true;
  };

  const addSample = (x: number, y: number): number => {
    const index = count++;
    xs[index] = x;
    ys[index] = y;
    grid[gridIndex(x, y)] = index;
    active.push(index);
    return index;
  };

  addSample(rng.nextRange(0, width), rng.nextRange(0, height));

  while (active.length > 0 && count < capacity) {
    // Pick a random active sample rather than the newest: always taking the
    // newest produces a visible directional bias in the growth front.
    const activeIndex = rng.nextInt(0, active.length - 1);
    const parent = active[activeIndex] as number;
    const px = xs[parent] as number;
    const py = ys[parent] as number;

    let placed = false;
    for (let attempt = 0; attempt < attemptsPerPoint; attempt++) {
      const angle = rng.nextFloat() * Math.PI * 2;
      // Sample the annulus [radius, 2 * radius). Uniform-in-radius would bias
      // toward the inner edge; the sqrt gives uniform area density.
      const distance = radius * Math.sqrt(rng.nextFloat() * 3 + 1);
      const x = px + Math.cos(angle) * distance;
      const y = py + Math.sin(angle) * distance;

      if (x < 0 || x >= width || y < 0 || y >= height) continue;
      if (!isFarEnough(x, y)) continue;

      addSample(x, y);
      placed = true;
      break;
    }

    if (!placed) {
      // Exhausted: retire this sample by swapping with the last, which is O(1)
      // where `splice` would be O(n) and dominate at 5 000 points.
      active[activeIndex] = active[active.length - 1] as number;
      active.pop();
    }
  }

  return { xs: xs.subarray(0, count), ys: ys.subarray(0, count), count };
}

/**
 * Mean area occupied per sample, in units of `radius²`.
 *
 * Measured empirically from this sampler rather than derived: the theoretical
 * hexagonal-packing bound is `√3/2 ≈ 0.866 r²`, but Bridson with an annulus of
 * `[r, 2r)` and 24 attempts achieves only about 53 % of that. Deriving the
 * radius from the theoretical bound produced ~40 % of the requested territory
 * count.
 *
 * Stable to within 1 % across radii from 40 to 120 and across seeds, so a
 * constant is appropriate. Re-measure if the annulus range or attempt count
 * changes — both move this number.
 */
const AREA_PER_SAMPLE_FACTOR = 1.62;

/**
 * Chooses the disc radius that yields approximately `targetCount` samples.
 *
 * Poisson sampling cannot hit an exact count — the process is stochastic — so
 * callers should treat the result as a target, not a guarantee. In practice
 * this lands within a few percent.
 */
export function radiusForCount(width: number, height: number, targetCount: number): number {
  const areaPerPoint = (width * height) / Math.max(1, targetCount);
  return Math.sqrt(areaPerPoint / AREA_PER_SAMPLE_FACTOR);
}
