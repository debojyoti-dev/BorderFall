import { describe, expect, it } from 'vitest';
import { Rng, seedFromString } from './prng.js';

describe('Rng', () => {
  it('produces an identical stream for an identical seed', () => {
    const a = new Rng(12345);
    const b = new Rng(12345);
    const streamA = Array.from({ length: 256 }, () => a.nextUint32());
    const streamB = Array.from({ length: 256 }, () => b.nextUint32());
    expect(streamA).toEqual(streamB);
  });

  it('produces different streams for different seeds', () => {
    const a = new Rng(1);
    const b = new Rng(2);
    const streamA = Array.from({ length: 64 }, () => a.nextUint32());
    const streamB = Array.from({ length: 64 }, () => b.nextUint32());
    expect(streamA).not.toEqual(streamB);
  });

  it('never returns an out-of-range float', () => {
    const rng = new Rng(999);
    for (let i = 0; i < 10_000; i++) {
      const value = rng.nextFloat();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it('respects inclusive integer bounds', () => {
    const rng = new Rng(42);
    for (let i = 0; i < 10_000; i++) {
      const value = rng.nextInt(3, 7);
      expect(value).toBeGreaterThanOrEqual(3);
      expect(value).toBeLessThanOrEqual(7);
      expect(Number.isInteger(value)).toBe(true);
    }
  });

  it('collapses a degenerate integer range to its single value', () => {
    const rng = new Rng(7);
    expect(rng.nextInt(5, 5)).toBe(5);
    expect(rng.nextInt(9, 2)).toBe(9);
  });

  it('draws integers without detectable modulo bias', () => {
    // A range that does not divide 2^32 evenly is where naive `% n` skews.
    const rng = new Rng(2024);
    const buckets = new Array<number>(7).fill(0);
    const samples = 700_000;
    for (let i = 0; i < samples; i++) {
      buckets[rng.nextInt(0, 6)]!++;
    }
    const expected = samples / 7;
    for (const count of buckets) {
      expect(Math.abs(count - expected) / expected).toBeLessThan(0.02);
    }
  });

  it('never enters the all-zero fixed point, even when seeded with zero', () => {
    const rng = new Rng(0);
    const draws = Array.from({ length: 32 }, () => rng.nextUint32());
    expect(draws.some((value) => value !== 0)).toBe(true);
  });

  it('forks independent streams that are stable per label', () => {
    const parentA = new Rng(555);
    const parentB = new Rng(555);

    const combatA = parentA.fork('combat');
    const combatB = parentB.fork('combat');
    expect(combatA.nextUint32()).toBe(combatB.nextUint32());

    // A differently-labelled fork from the same parent state must diverge.
    const mapgen = new Rng(555).fork('mapgen');
    const combat = new Rng(555).fork('combat');
    expect(mapgen.nextUint32()).not.toBe(combat.nextUint32());
  });

  it('advancing a forked stream does not disturb the parent', () => {
    const control = new Rng(88);
    const subject = new Rng(88);

    control.nextUint32(); // account for the draw fork() consumes
    const forked = subject.fork('noise');
    for (let i = 0; i < 1000; i++) forked.nextUint32();

    expect(subject.nextUint32()).toBe(control.nextUint32());
  });

  it('round-trips its state', () => {
    const rng = new Rng(31337);
    for (let i = 0; i < 50; i++) rng.nextUint32();

    const saved = rng.saveState();
    const expected = Array.from({ length: 20 }, () => rng.nextUint32());

    const restored = new Rng(0);
    restored.restoreState(saved);
    const actual = Array.from({ length: 20 }, () => restored.nextUint32());

    expect(actual).toEqual(expected);
    expect(restored.draws).toBe(rng.draws);
  });

  it('shuffles deterministically and preserves every element', () => {
    const source = Array.from({ length: 100 }, (_, i) => i);
    const a = new Rng(4).shuffle([...source]);
    const b = new Rng(4).shuffle([...source]);
    expect(a).toEqual(b);
    expect([...a].sort((x, y) => x - y)).toEqual(source);
  });

  it('throws when picking from an empty array', () => {
    expect(() => new Rng(1).pick([])).toThrow(RangeError);
  });

  it('honours the extremes of chance()', () => {
    const rng = new Rng(6);
    expect(rng.chance(0)).toBe(false);
    expect(rng.chance(1)).toBe(true);
  });

  it('hashes seed strings stably and distinctly', () => {
    expect(seedFromString('borderfall')).toBe(seedFromString('borderfall'));
    expect(seedFromString('borderfall')).not.toBe(seedFromString('borderfal'));
  });

  it('generates a gaussian with approximately the requested moments', () => {
    const rng = new Rng(2718);
    const samples = Array.from({ length: 50_000 }, () => rng.nextGaussian(10, 2));
    const mean = samples.reduce((sum, value) => sum + value, 0) / samples.length;
    const variance = samples.reduce((sum, value) => sum + (value - mean) ** 2, 0) / samples.length;
    expect(mean).toBeCloseTo(10, 1);
    expect(Math.sqrt(variance)).toBeCloseTo(2, 1);
  });
});
