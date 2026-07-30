import { describe, expect, it } from 'vitest';
import { TokenBucket } from './rate-limit.js';

describe('TokenBucket', () => {
  const config = { capacity: 5, refillPerSecond: 2 };

  it('allows a burst up to capacity, then rejects', () => {
    const bucket = new TokenBucket(config, 0);
    for (let i = 0; i < 5; i++) {
      expect(bucket.tryConsume(0)).toBe(true);
    }
    expect(bucket.tryConsume(0)).toBe(false);
  });

  it('refills proportionally to elapsed time', () => {
    const bucket = new TokenBucket(config, 0);
    for (let i = 0; i < 5; i++) bucket.tryConsume(0);

    expect(bucket.tryConsume(400)).toBe(false); // 0.8 tokens
    expect(bucket.tryConsume(500)).toBe(true); // 1.0 token
  });

  it('never refills beyond capacity', () => {
    const bucket = new TokenBucket(config, 0);
    bucket.tryConsume(0, 5);
    expect(bucket.available(60_000)).toBe(5);
  });

  it('reports an accurate retry delay', () => {
    const bucket = new TokenBucket(config, 0);
    bucket.tryConsume(0, 5);
    // Need 1 token at 2/sec => 500 ms.
    expect(bucket.retryAfterMs(0)).toBeCloseTo(500, 5);
    expect(bucket.retryAfterMs(250)).toBeCloseTo(250, 5);
    expect(bucket.retryAfterMs(500)).toBe(0);
  });

  it('does not mint tokens when the clock goes backwards', () => {
    const bucket = new TokenBucket(config, 10_000);
    bucket.tryConsume(10_000, 5);
    expect(bucket.tryConsume(5000)).toBe(false);
    expect(bucket.available(5000)).toBe(0);
  });

  it('treats a zero refill rate as an unrecoverable bucket', () => {
    const bucket = new TokenBucket({ capacity: 1, refillPerSecond: 0 }, 0);
    expect(bucket.tryConsume(0)).toBe(true);
    expect(bucket.tryConsume(1_000_000)).toBe(false);
    expect(bucket.retryAfterMs(0)).toBe(Number.POSITIVE_INFINITY);
  });

  it('supports multi-token costs', () => {
    const bucket = new TokenBucket(config, 0);
    expect(bucket.tryConsume(0, 3)).toBe(true);
    expect(bucket.tryConsume(0, 3)).toBe(false);
    expect(bucket.tryConsume(0, 2)).toBe(true);
  });

  it('restores to full on reset', () => {
    const bucket = new TokenBucket(config, 0);
    bucket.tryConsume(0, 5);
    bucket.reset(1000);
    expect(bucket.available(1000)).toBe(5);
  });
});
