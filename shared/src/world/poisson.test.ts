import { describe, expect, it } from 'vitest';
import { Rng } from '../utils/prng.js';
import { poissonDiscSample, radiusForCount } from './poisson.js';

describe('poissonDiscSample', () => {
  it('never places two samples closer than the radius', () => {
    // The defining property. Violations produce sliver Voronoi cells that are
    // unclickable and impossible to balance.
    const radius = 60;
    const result = poissonDiscSample(1200, 1200, radius, new Rng(4));
    expect(result.count).toBeGreaterThan(50);

    for (let i = 0; i < result.count; i++) {
      for (let j = i + 1; j < result.count; j++) {
        const dx = result.xs[i]! - result.xs[j]!;
        const dy = result.ys[i]! - result.ys[j]!;
        // Allow a hair of float tolerance on the boundary case.
        expect(Math.hypot(dx, dy)).toBeGreaterThanOrEqual(radius - 1e-3);
      }
    }
  });

  it('keeps every sample inside the rectangle', () => {
    const result = poissonDiscSample(800, 600, 40, new Rng(9));
    for (let i = 0; i < result.count; i++) {
      expect(result.xs[i]).toBeGreaterThanOrEqual(0);
      expect(result.xs[i]).toBeLessThan(800);
      expect(result.ys[i]).toBeGreaterThanOrEqual(0);
      expect(result.ys[i]).toBeLessThan(600);
    }
  });

  it('is deterministic for a given seed', () => {
    const a = poissonDiscSample(1000, 1000, 50, new Rng(77));
    const b = poissonDiscSample(1000, 1000, 50, new Rng(77));
    expect(a.count).toBe(b.count);
    expect(Array.from(a.xs)).toEqual(Array.from(b.xs));
    expect(Array.from(a.ys)).toEqual(Array.from(b.ys));
  });

  it('fills the space at a stable density', () => {
    // Pins the empirical constant behind radiusForCount. If the annulus range
    // or attempt count is ever changed, this fails and the constant must be
    // re-measured rather than silently drifting the territory count.
    for (const radius of [40, 80]) {
      const result = poissonDiscSample(4096, 4096, radius, new Rng(3));
      const areaPerPoint = (4096 * 4096) / result.count / (radius * radius);
      expect(areaPerPoint).toBeGreaterThan(1.55);
      expect(areaPerPoint).toBeLessThan(1.7);
    }
  });
});

describe('radiusForCount', () => {
  it('produces close to the requested sample count', () => {
    for (const target of [200, 1000, 5000]) {
      const radius = radiusForCount(4096, 4096, target);
      const result = poissonDiscSample(4096, 4096, radius, new Rng(target));
      const error = Math.abs(result.count - target) / target;
      expect(error).toBeLessThan(0.12);
    }
  });

  it('returns a larger radius for fewer points', () => {
    expect(radiusForCount(1000, 1000, 100)).toBeGreaterThan(radiusForCount(1000, 1000, 400));
  });
});
