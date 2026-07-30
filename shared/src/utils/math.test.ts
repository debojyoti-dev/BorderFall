import { describe, expect, it } from 'vitest';
import {
  clamp,
  damp,
  distance,
  inverseLerp,
  lerp,
  pointInPolygon,
  polygonArea,
  polygonCentroid,
  rectsIntersect,
} from './math.js';
import type { Point } from './math.js';

const unitSquare: Point[] = [
  { x: 0, y: 0 },
  { x: 10, y: 0 },
  { x: 10, y: 10 },
  { x: 0, y: 10 },
];

describe('math', () => {
  it('clamps to both bounds', () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(99, 0, 10)).toBe(10);
  });

  it('lerps and inverse-lerps consistently', () => {
    expect(lerp(0, 100, 0.25)).toBe(25);
    expect(inverseLerp(0, 100, 25)).toBe(0.25);
  });

  it('returns 0 from inverseLerp on a degenerate range instead of NaN', () => {
    expect(inverseLerp(5, 5, 5)).toBe(0);
  });

  it('damps frame-rate independently', () => {
    // One 1s step must match two 0.5s steps to within float tolerance.
    const single = damp(0, 100, 0.1, 1);
    let stepped = damp(0, 100, 0.1, 0.5);
    stepped = damp(stepped, 100, 0.1, 0.5);
    expect(stepped).toBeCloseTo(single, 6);
  });

  it('measures distance', () => {
    expect(distance(0, 0, 3, 4)).toBe(5);
  });

  it('computes polygon area regardless of winding sign', () => {
    expect(Math.abs(polygonArea(unitSquare))).toBe(100);
  });

  it('computes an area-weighted centroid', () => {
    const centroid = polygonCentroid(unitSquare);
    expect(centroid.x).toBeCloseTo(5, 6);
    expect(centroid.y).toBeCloseTo(5, 6);
  });

  it('falls back to the vertex mean on a degenerate polygon', () => {
    const collinear: Point[] = [
      { x: 0, y: 0 },
      { x: 5, y: 0 },
      { x: 10, y: 0 },
    ];
    const centroid = polygonCentroid(collinear);
    expect(centroid.x).toBeCloseTo(5, 6);
    expect(centroid.y).toBeCloseTo(0, 6);
  });

  it('handles an empty polygon without throwing', () => {
    expect(polygonCentroid([])).toEqual({ x: 0, y: 0 });
    expect(polygonArea([])).toBe(0);
  });

  it('tests point containment', () => {
    expect(pointInPolygon(5, 5, unitSquare)).toBe(true);
    expect(pointInPolygon(15, 5, unitSquare)).toBe(false);
    expect(pointInPolygon(-1, -1, unitSquare)).toBe(false);
  });

  it('detects rectangle overlap', () => {
    const a = { x: 0, y: 0, width: 10, height: 10 };
    expect(rectsIntersect(a, { x: 5, y: 5, width: 10, height: 10 })).toBe(true);
    expect(rectsIntersect(a, { x: 20, y: 20, width: 5, height: 5 })).toBe(false);
  });
});
