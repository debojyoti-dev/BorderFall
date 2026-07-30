import { SpatialGrid } from './SpatialGrid.js';

/**
 * Voronoi diagram built by half-plane clipping.
 *
 * ## Why not Delaunay duality
 *
 * The textbook route is to triangulate the sites and take the dual. It is
 * asymptotically better (O(n log n) versus O(n·k)) but needs exact geometric
 * predicates to stay robust: with floating-point orientation tests, nearly
 * collinear or cocircular sites produce inverted triangles, and the failure
 * mode is a silently corrupt map — a territory with the wrong neighbours, or a
 * polygon that self-intersects — rather than a clean crash. Debugging that
 * after it ships in a replay is genuinely awful.
 *
 * Clipping is immune to all of it. A cell is the intersection of half-planes,
 * built by successive convex clips of the bounding box. Every intermediate
 * result is convex by construction, the operation is numerically forgiving, and
 * degenerate input yields a degenerate-but-valid polygon. At 5 000 sites with
 * ~20 candidates each the cost is trivial, and it happens once per match.
 *
 * The neighbour graph falls out for free: site *j* borders site *i* exactly
 * when an edge of *i*'s final polygon lies on their perpendicular bisector.
 */

export interface VoronoiResult {
  /** Flattened `[x0, y0, x1, y1, ...]` vertices for every cell. */
  readonly polygonPoints: Float32Array;
  /** CSR offsets: cell `i` spans `polygonOffsets[i] .. polygonOffsets[i + 1]`. */
  readonly polygonOffsets: Uint32Array;
  /** CSR neighbour ids. */
  readonly neighbours: Uint16Array;
  readonly neighbourOffsets: Uint32Array;
  /** Area-weighted centroid of each cell. */
  readonly centroidX: Float32Array;
  readonly centroidY: Float32Array;
  readonly area: Float32Array;
}

/**
 * Points closer than this are treated as coincident.
 *
 * Sits well below the smallest meaningful map feature (cells are hundreds of
 * units across) but far above float32 noise, so it removes clipping slivers
 * without ever collapsing a real edge.
 */
const EPSILON = 1e-6;

/**
 * Multiplier on the mean site spacing used to gather bisector candidates.
 *
 * A cell can only be bounded by a site within twice its own radius, so 3.5×
 * mean spacing is a comfortable margin. The search widens automatically when a
 * region is sparse — see {@link gatherCandidates}.
 */
const CANDIDATE_RADIUS_FACTOR = 3.5;

export function buildVoronoi(
  xs: Float32Array,
  ys: Float32Array,
  count: number,
  width: number,
  height: number,
): VoronoiResult {
  const grid = new SpatialGrid(xs, ys, width, height, count);

  const meanSpacing = Math.sqrt((width * height) / Math.max(1, count));
  const searchRadius = meanSpacing * CANDIDATE_RADIUS_FACTOR;

  const polygonOffsets = new Uint32Array(count + 1);
  const neighbourOffsets = new Uint32Array(count + 1);
  const centroidX = new Float32Array(count);
  const centroidY = new Float32Array(count);
  const area = new Float32Array(count);

  // Two passes: measure, then fill. Growing a JS array of 5 000 sub-arrays and
  // flattening afterwards would allocate far more and fragment the heap.
  const cellPolygons: number[][] = new Array<number[]>(count);
  const cellNeighbours: number[][] = new Array<number[]>(count);

  const candidates: number[] = [];
  let totalPoints = 0;
  let totalNeighbours = 0;

  for (let i = 0; i < count; i++) {
    const sx = xs[i] as number;
    const sy = ys[i] as number;

    gatherCandidates(grid, sx, sy, searchRadius, i, candidates);

    const polygon = clipCell(sx, sy, xs, ys, candidates, width, height);
    const neighbours = deriveNeighbours(sx, sy, xs, ys, candidates, polygon);

    cellPolygons[i] = polygon;
    cellNeighbours[i] = neighbours;

    totalPoints += polygon.length;
    totalNeighbours += neighbours.length;

    polygonOffsets[i + 1] = totalPoints;
    neighbourOffsets[i + 1] = totalNeighbours;

    const metrics = polygonMetrics(polygon);
    centroidX[i] = metrics.cx;
    centroidY[i] = metrics.cy;
    area[i] = metrics.area;
  }

  const polygonPoints = new Float32Array(totalPoints);
  const neighbourArray = new Uint16Array(totalNeighbours);

  let pointCursor = 0;
  let neighbourCursor = 0;
  for (let i = 0; i < count; i++) {
    const polygon = cellPolygons[i] as number[];
    for (let k = 0; k < polygon.length; k++) {
      polygonPoints[pointCursor++] = polygon[k] as number;
    }
    const neighbours = cellNeighbours[i] as number[];
    for (let k = 0; k < neighbours.length; k++) {
      neighbourArray[neighbourCursor++] = neighbours[k] as number;
    }
  }

  return {
    polygonPoints,
    polygonOffsets,
    neighbours: neighbourArray,
    neighbourOffsets,
    centroidX,
    centroidY,
    area,
  };
}

/**
 * Collects nearby site indices, widening the search until enough are found.
 *
 * The widening matters at map corners and in sparse regions: a fixed radius
 * there can return zero candidates, leaving the cell as the whole bounding box
 * and producing one enormous territory that swallows the map.
 */
function gatherCandidates(
  grid: SpatialGrid,
  x: number,
  y: number,
  radius: number,
  self: number,
  out: number[],
): void {
  let currentRadius = radius;
  for (let attempt = 0; attempt < 4; attempt++) {
    grid.queryRadius(x, y, currentRadius, out);
    // `out` includes `self`, hence > 4 rather than >= 4.
    if (out.length > 4) break;
    currentRadius *= 2;
  }

  // Remove self in place, preserving order (order affects nothing, but a
  // deterministic result keeps the generator reproducible).
  const selfIndex = out.indexOf(self);
  if (selfIndex >= 0) out.splice(selfIndex, 1);
}

/**
 * Intersects the bounding box with the half-plane of every candidate bisector.
 *
 * Returns a flat `[x, y, ...]` convex polygon.
 */
function clipCell(
  sx: number,
  sy: number,
  xs: Float32Array,
  ys: Float32Array,
  candidates: readonly number[],
  width: number,
  height: number,
): number[] {
  let polygon: number[] = [0, 0, width, 0, width, height, 0, height];

  for (const j of candidates) {
    const jx = xs[j] as number;
    const jy = ys[j] as number;

    // Perpendicular bisector of (site, candidate). Keep the side containing
    // the site: points p with dot(p - midpoint, candidate - site) <= 0.
    const nx = jx - sx;
    const ny = jy - sy;
    const mx = (sx + jx) * 0.5;
    const my = (sy + jy) * 0.5;

    // Coincident sites have no meaningful bisector.
    if (nx * nx + ny * ny < EPSILON) continue;

    polygon = clipHalfPlane(polygon, nx, ny, mx, my);
    if (polygon.length < 6) return polygon; // Degenerate; nothing left to clip.
  }

  return polygon;
}

/**
 * Sutherland–Hodgman clip of a convex polygon against a half-plane.
 *
 * Keeps points satisfying `dot(p - m, n) <= 0`.
 */
function clipHalfPlane(
  polygon: readonly number[],
  nx: number,
  ny: number,
  mx: number,
  my: number,
): number[] {
  const vertexCount = polygon.length / 2;
  if (vertexCount === 0) return [];

  const out: number[] = [];

  let prevX = polygon[(vertexCount - 1) * 2] as number;
  let prevY = polygon[(vertexCount - 1) * 2 + 1] as number;
  let prevDistance = (prevX - mx) * nx + (prevY - my) * ny;

  for (let i = 0; i < vertexCount; i++) {
    const currX = polygon[i * 2] as number;
    const currY = polygon[i * 2 + 1] as number;
    const currDistance = (currX - mx) * nx + (currY - my) * ny;

    const prevInside = prevDistance <= 0;
    const currInside = currDistance <= 0;

    if (currInside !== prevInside) {
      // Crossing: emit the intersection with the bisector.
      const t = prevDistance / (prevDistance - currDistance);
      out.push(prevX + (currX - prevX) * t, prevY + (currY - prevY) * t);
    }
    if (currInside) {
      out.push(currX, currY);
    }

    prevX = currX;
    prevY = currY;
    prevDistance = currDistance;
  }

  return out;
}

/**
 * Determines which candidates actually border this cell.
 *
 * Tests each polygon edge for lying on a candidate's bisector — both endpoints
 * equidistant from the two sites. Checking "did this clip change the polygon?"
 * during clipping would be cheaper but wrong: a candidate can trim a corner
 * that a later clip removes entirely, which reports a neighbour that does not
 * share a border. That error would let a player attack a non-adjacent
 * territory, so it is worth the exact test.
 */
function deriveNeighbours(
  sx: number,
  sy: number,
  xs: Float32Array,
  ys: Float32Array,
  candidates: readonly number[],
  polygon: readonly number[],
): number[] {
  const vertexCount = polygon.length / 2;
  if (vertexCount < 3) return [];

  const neighbours: number[] = [];

  for (const j of candidates) {
    const jx = xs[j] as number;
    const jy = ys[j] as number;

    const nx = jx - sx;
    const ny = jy - sy;
    const mx = (sx + jx) * 0.5;
    const my = (sy + jy) * 0.5;
    const lengthSq = nx * nx + ny * ny;
    if (lengthSq < EPSILON) continue;

    // Tolerance scales with site separation so it stays meaningful for both
    // tightly and loosely packed regions.
    const tolerance = Math.sqrt(lengthSq) * 1e-3;

    for (let i = 0; i < vertexCount; i++) {
      const ax = polygon[i * 2] as number;
      const ay = polygon[i * 2 + 1] as number;
      const next = (i + 1) % vertexCount;
      const bx = polygon[next * 2] as number;
      const by = polygon[next * 2 + 1] as number;

      // Signed distance from the bisector, normalised by |n|.
      const da = ((ax - mx) * nx + (ay - my) * ny) / Math.sqrt(lengthSq);
      const db = ((bx - mx) * nx + (by - my) * ny) / Math.sqrt(lengthSq);

      if (Math.abs(da) < tolerance && Math.abs(db) < tolerance) {
        // Ignore zero-length edges, which contribute no real border.
        const edgeLengthSq = (bx - ax) * (bx - ax) + (by - ay) * (by - ay);
        if (edgeLengthSq > EPSILON) {
          neighbours.push(j);
        }
        break;
      }
    }
  }

  return neighbours;
}

/** Area and area-weighted centroid of a flat polygon. */
function polygonMetrics(polygon: readonly number[]): { cx: number; cy: number; area: number } {
  const vertexCount = polygon.length / 2;
  if (vertexCount === 0) return { cx: 0, cy: 0, area: 0 };
  if (vertexCount < 3) {
    let sx = 0;
    let sy = 0;
    for (let i = 0; i < vertexCount; i++) {
      sx += polygon[i * 2] as number;
      sy += polygon[i * 2 + 1] as number;
    }
    return { cx: sx / vertexCount, cy: sy / vertexCount, area: 0 };
  }

  let signedArea = 0;
  let cx = 0;
  let cy = 0;

  for (let i = 0, j = vertexCount - 1; i < vertexCount; j = i++) {
    const ax = polygon[j * 2] as number;
    const ay = polygon[j * 2 + 1] as number;
    const bx = polygon[i * 2] as number;
    const by = polygon[i * 2 + 1] as number;
    const cross = ax * by - bx * ay;
    signedArea += cross;
    cx += (ax + bx) * cross;
    cy += (ay + by) * cross;
  }

  if (Math.abs(signedArea) < EPSILON) {
    let sx = 0;
    let sy = 0;
    for (let i = 0; i < vertexCount; i++) {
      sx += polygon[i * 2] as number;
      sy += polygon[i * 2 + 1] as number;
    }
    return { cx: sx / vertexCount, cy: sy / vertexCount, area: 0 };
  }

  const factor = 1 / (3 * signedArea);
  return { cx: cx * factor, cy: cy * factor, area: Math.abs(signedArea) * 0.5 };
}

/**
 * One pass of Lloyd relaxation: move every site to its cell centroid.
 *
 * Poisson sampling already avoids clumping, but relaxation additionally
 * regularises cell *shape*, turning elongated cells into compact ones. Two or
 * three passes give territories that are pleasant to click and roughly equal in
 * value; many more passes converge toward a hex grid and lose the organic look
 * entirely.
 */
export function relaxSites(
  xs: Float32Array,
  ys: Float32Array,
  count: number,
  width: number,
  height: number,
): void {
  const result = buildVoronoi(xs, ys, count, width, height);
  for (let i = 0; i < count; i++) {
    // A degenerate cell has no meaningful centroid; leave that site alone.
    if ((result.area[i] as number) <= 0) continue;
    xs[i] = result.centroidX[i] as number;
    ys[i] = result.centroidY[i] as number;
  }
}
