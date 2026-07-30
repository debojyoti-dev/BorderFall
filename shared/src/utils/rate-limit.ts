/**
 * Token-bucket rate limiter.
 *
 * Lives in `shared/` deliberately: the server uses it to *enforce* limits, and
 * the client uses an identical instance to *predict* them, greying out a button
 * before the user spends a command that would be rejected. One implementation
 * means the client's prediction can never disagree with the server's ruling.
 *
 * Lazy refill (compute on read rather than on a timer) keeps this O(1) per
 * check with no background work — important when there are hundreds of buckets,
 * several per connection.
 */
export interface RateLimitConfig {
  /** Maximum tokens the bucket holds; also the maximum burst size. */
  readonly capacity: number;
  /** Tokens restored per second. */
  readonly refillPerSecond: number;
}

export class TokenBucket {
  private tokens: number;
  private lastRefillMs: number;

  constructor(
    private readonly config: RateLimitConfig,
    nowMs: number,
  ) {
    this.tokens = config.capacity;
    this.lastRefillMs = nowMs;
  }

  /** Consumes `cost` tokens if available. Returns false when rate-limited. */
  tryConsume(nowMs: number, cost = 1): boolean {
    this.refill(nowMs);
    if (this.tokens < cost) return false;
    this.tokens -= cost;
    return true;
  }

  /** Tokens currently available, refilled to `nowMs`. */
  available(nowMs: number): number {
    this.refill(nowMs);
    return this.tokens;
  }

  /** Milliseconds until `cost` tokens are available; 0 if available now. */
  retryAfterMs(nowMs: number, cost = 1): number {
    this.refill(nowMs);
    if (this.tokens >= cost) return 0;
    if (this.config.refillPerSecond <= 0) return Number.POSITIVE_INFINITY;
    return ((cost - this.tokens) / this.config.refillPerSecond) * 1000;
  }

  reset(nowMs: number): void {
    this.tokens = this.config.capacity;
    this.lastRefillMs = nowMs;
  }

  private refill(nowMs: number): void {
    // Clock skew or a rewound test clock must never mint tokens.
    if (nowMs <= this.lastRefillMs) {
      this.lastRefillMs = Math.min(this.lastRefillMs, nowMs);
      return;
    }
    const elapsedSeconds = (nowMs - this.lastRefillMs) / 1000;
    this.tokens = Math.min(
      this.config.capacity,
      this.tokens + elapsedSeconds * this.config.refillPerSecond,
    );
    this.lastRefillMs = nowMs;
  }
}
