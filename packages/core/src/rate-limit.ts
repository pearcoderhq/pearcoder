export interface RateLimit {
  /** Events allowed in a burst. */
  burst: number;
  /** Sustained events per second. */
  perSecond: number;
}

export const DEFAULT_EVENT_RATE_LIMIT: RateLimit = { burst: 20, perSecond: 2 };

/** Review and other requests per participant: 10 at once, then 10 per hour. */
export const REQUEST_RATE_LIMIT: RateLimit = { burst: 10, perSecond: 10 / 3600 };

/** Token bucket per key (threat model T07). */
export class RateLimiter {
  readonly #limit: RateLimit;
  readonly #now: () => number;
  readonly #buckets = new Map<string, { tokens: number; updatedAt: number }>();

  constructor(limit: RateLimit, now: () => number = Date.now) {
    this.#limit = limit;
    this.#now = now;
  }

  /** Takes one token for `key`; returns false when the key is over its limit. */
  take(key: string): boolean {
    const now = this.#now();
    const bucket = this.#buckets.get(key) ?? { tokens: this.#limit.burst, updatedAt: now };
    const refill = ((now - bucket.updatedAt) / 1000) * this.#limit.perSecond;
    bucket.tokens = Math.min(this.#limit.burst, bucket.tokens + refill);
    bucket.updatedAt = now;
    this.#buckets.set(key, bucket);
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }
}
