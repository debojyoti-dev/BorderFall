/**
 * Uniform spatial hash over a fixed rectangle.
 *
 * Used three times for three different reasons, which is why it is a shared
 * primitive rather than an implementation detail of any one of them:
 *
 * - **World generation** — finding the candidate sites whose bisectors could
 *   bound a Voronoi cell. A brute-force scan would be O(n²): 25 million
 *   distance tests at 5 000 sites, per Lloyd relaxation pass.
 * - **Client picking** — mapping a cursor position to a territory in O(1)
 *   expected time rather than testing 5 000 polygons per mouse move.
 * - **Blast radius queries** — finding territories inside a nuclear detonation
 *   without scanning the world (Phase 7).
 *
 * Backed by CSR-style flat typed arrays rather than an array of buckets: one
 * allocation instead of thousands, and iteration over a bucket is a contiguous
 * read.
 */
export class SpatialGrid {
  private readonly cellSize: number;
  private readonly cols: number;
  private readonly rows: number;

  /** Start index into {@link items} for each cell; length `cols * rows + 1`. */
  private readonly cellStart: Uint32Array;
  /** Point indices, grouped by cell. */
  private readonly items: Uint32Array;

  constructor(
    private readonly xs: Float32Array,
    private readonly ys: Float32Array,
    private readonly width: number,
    private readonly height: number,
    count: number,
    targetPerCell = 2,
  ) {
    // Size cells so each holds ~`targetPerCell` points. Too fine wastes memory
    // on empty cells and forces wide ring searches; too coarse degenerates
    // toward the brute-force scan this exists to avoid.
    const area = width * height;
    this.cellSize = Math.max(1, Math.sqrt((area * targetPerCell) / Math.max(1, count)));
    this.cols = Math.max(1, Math.ceil(width / this.cellSize));
    this.rows = Math.max(1, Math.ceil(height / this.cellSize));

    const cellCount = this.cols * this.rows;
    const counts = new Uint32Array(cellCount);

    // Counting sort: one pass to size buckets, one to fill them.
    for (let i = 0; i < count; i++) {
      counts[this.cellIndex(xs[i] as number, ys[i] as number)]!++;
    }

    this.cellStart = new Uint32Array(cellCount + 1);
    let running = 0;
    for (let c = 0; c < cellCount; c++) {
      this.cellStart[c] = running;
      running += counts[c] as number;
    }
    this.cellStart[cellCount] = running;

    const cursor = new Uint32Array(this.cellStart.subarray(0, cellCount));
    this.items = new Uint32Array(count);
    for (let i = 0; i < count; i++) {
      const cell = this.cellIndex(xs[i] as number, ys[i] as number);
      this.items[cursor[cell]!++] = i;
    }
  }

  private cellIndex(x: number, y: number): number {
    const col = Math.min(this.cols - 1, Math.max(0, Math.floor(x / this.cellSize)));
    const row = Math.min(this.rows - 1, Math.max(0, Math.floor(y / this.cellSize)));
    return row * this.cols + col;
  }

  /**
   * Appends every point within `radius` of (x, y) to `out`, and returns the
   * number found.
   *
   * The caller supplies the output array so repeated queries — 5 000 of them
   * per relaxation pass — allocate nothing.
   */
  queryRadius(x: number, y: number, radius: number, out: number[]): number {
    out.length = 0;

    const minCol = Math.max(0, Math.floor((x - radius) / this.cellSize));
    const maxCol = Math.min(this.cols - 1, Math.floor((x + radius) / this.cellSize));
    const minRow = Math.max(0, Math.floor((y - radius) / this.cellSize));
    const maxRow = Math.min(this.rows - 1, Math.floor((y + radius) / this.cellSize));

    const radiusSq = radius * radius;

    for (let row = minRow; row <= maxRow; row++) {
      const rowOffset = row * this.cols;
      for (let col = minCol; col <= maxCol; col++) {
        const cell = rowOffset + col;
        const end = this.cellStart[cell + 1] as number;
        for (let k = this.cellStart[cell] as number; k < end; k++) {
          const index = this.items[k] as number;
          const dx = (this.xs[index] as number) - x;
          const dy = (this.ys[index] as number) - y;
          if (dx * dx + dy * dy <= radiusSq) out.push(index);
        }
      }
    }

    return out.length;
  }

  /**
   * Finds the nearest point to (x, y), or `-1` when the grid is empty.
   *
   * Searches outward ring by ring and stops as soon as the best distance found
   * is closer than the nearest edge of the next ring — the standard expanding
   * ring search. Without that early exit, a query near a sparse region would
   * degrade to scanning the whole grid.
   */
  findNearest(x: number, y: number, maxRadius = Number.POSITIVE_INFINITY): number {
    let best = -1;
    let bestDistSq = maxRadius === Number.POSITIVE_INFINITY ? Infinity : maxRadius * maxRadius;

    const centreCol = Math.min(this.cols - 1, Math.max(0, Math.floor(x / this.cellSize)));
    const centreRow = Math.min(this.rows - 1, Math.max(0, Math.floor(y / this.cellSize)));
    const maxRing = Math.max(this.cols, this.rows);

    for (let ring = 0; ring <= maxRing; ring++) {
      // Everything in this ring is at least `(ring - 1) * cellSize` away, so
      // once we hold something closer, no further ring can improve on it.
      if (best >= 0) {
        const ringMinDist = (ring - 1) * this.cellSize;
        if (ringMinDist > 0 && ringMinDist * ringMinDist > bestDistSq) break;
      }

      const minCol = centreCol - ring;
      const maxCol = centreCol + ring;
      const minRow = centreRow - ring;
      const maxRow = centreRow + ring;

      let visited = false;
      for (let row = minRow; row <= maxRow; row++) {
        if (row < 0 || row >= this.rows) continue;
        const onHorizontalEdge = row === minRow || row === maxRow;
        const rowOffset = row * this.cols;

        for (let col = minCol; col <= maxCol; col++) {
          if (col < 0 || col >= this.cols) continue;
          // Only the perimeter of the ring is new; the interior was covered by
          // a previous iteration.
          if (!onHorizontalEdge && col !== minCol && col !== maxCol) continue;

          visited = true;
          const cell = rowOffset + col;
          const end = this.cellStart[cell + 1] as number;
          for (let k = this.cellStart[cell] as number; k < end; k++) {
            const index = this.items[k] as number;
            const dx = (this.xs[index] as number) - x;
            const dy = (this.ys[index] as number) - y;
            const distSq = dx * dx + dy * dy;
            if (distSq < bestDistSq) {
              bestDistSq = distSq;
              best = index;
            }
          }
        }
      }

      // Ring lies entirely outside the grid and we already have a hit.
      if (!visited && ring > 0 && best >= 0) break;
    }

    return best;
  }

  get cellDimension(): number {
    return this.cellSize;
  }
}
