/** Small, allocation-free geometry and numeric helpers used by both runtimes. */

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

export function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Inverse lerp; returns 0 when the range is degenerate rather than NaN. */
export function inverseLerp(a: number, b: number, value: number): number {
  return a === b ? 0 : (value - a) / (b - a);
}

/**
 * Frame-rate independent exponential smoothing.
 *
 * `smoothing` is the fraction of the remaining distance left after one second.
 * Camera inertia uses this so that pan feel is identical at 30 and 144 fps —
 * a naive `lerp(a, b, 0.1)` per frame is silently frame-rate dependent.
 */
export function damp(
  current: number,
  target: number,
  smoothing: number,
  dtSeconds: number,
): number {
  return lerp(current, target, 1 - Math.pow(smoothing, dtSeconds));
}

export function distanceSq(ax: number, ay: number, bx: number, by: number): number {
  const dx = ax - bx;
  const dy = ay - by;
  return dx * dx + dy * dy;
}

export function distance(ax: number, ay: number, bx: number, by: number): number {
  return Math.sqrt(distanceSq(ax, ay, bx, by));
}

/** Smootherstep — zero first and second derivative at both ends. */
export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01(inverseLerp(edge0, edge1, x));
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/** Signed area of a polygon; positive for counter-clockwise winding. */
export function polygonArea(points: readonly Point[]): number {
  const n = points.length;
  if (n < 3) return 0;
  let area = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const a = points[j] as Point;
    const b = points[i] as Point;
    area += (a.x + b.x) * (a.y - b.y);
  }
  return area / 2;
}

/**
 * Area-weighted centroid.
 *
 * Territory labels and army markers anchor here. The naive average of vertices
 * would drift towards densely sampled edges and place labels off-centre on
 * elongated cells.
 */
export function polygonCentroid(points: readonly Point[]): Point {
  const n = points.length;
  if (n === 0) return { x: 0, y: 0 };
  if (n < 3) {
    let sx = 0;
    let sy = 0;
    for (const p of points) {
      sx += p.x;
      sy += p.y;
    }
    return { x: sx / n, y: sy / n };
  }

  let cx = 0;
  let cy = 0;
  let signedArea = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const a = points[j] as Point;
    const b = points[i] as Point;
    const cross = a.x * b.y - b.x * a.y;
    signedArea += cross;
    cx += (a.x + b.x) * cross;
    cy += (a.y + b.y) * cross;
  }

  // Degenerate (zero-area) polygon: fall back to the vertex mean.
  if (Math.abs(signedArea) < 1e-9) {
    let sx = 0;
    let sy = 0;
    for (const p of points) {
      sx += p.x;
      sy += p.y;
    }
    return { x: sx / n, y: sy / n };
  }

  const factor = 1 / (3 * signedArea);
  return { x: cx * factor, y: cy * factor };
}

/** Ray-casting point-in-polygon test. */
export function pointInPolygon(px: number, py: number, points: readonly Point[]): boolean {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[i] as Point;
    const b = points[j] as Point;
    const intersects = a.y > py !== b.y > py && px < ((b.x - a.x) * (py - a.y)) / (b.y - a.y) + a.x;
    if (intersects) inside = !inside;
  }
  return inside;
}

export function rectContains(rect: Rect, x: number, y: number): boolean {
  return x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height;
}

export function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

/** Rounds to a fixed number of decimals — used to trim float noise before wire encoding. */
export function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
