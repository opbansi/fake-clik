'use strict';

/**
 * Small in-memory fixed-window rate limiter.
 * Keys (IP addresses, hashed visitor IDs) live only in memory and are never
 * written to disk. For several server processes, put a shared limiter
 * (nginx limit_req, Cloudflare, Redis) in front instead.
 */
function createRateLimiter({ windowMs, max, maxKeys = 50_000 }) {
  const buckets = new Map();

  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= now) buckets.delete(key);
    }
  }, Math.max(windowMs, 1000));
  sweeper.unref();

  return {
    check(key, now = Date.now()) {
      let bucket = buckets.get(key);
      if (!bucket || bucket.resetAt <= now) {
        // Bound memory: evict the oldest key if an attacker rotates keys.
        if (!bucket && buckets.size >= maxKeys) buckets.delete(buckets.keys().next().value);
        bucket = { count: 0, resetAt: now + windowMs };
        buckets.set(key, bucket);
      }
      bucket.count += 1;
      return {
        allowed: bucket.count <= max,
        remaining: Math.max(0, max - bucket.count),
        retryAfterSec: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
      };
    },
    close() {
      clearInterval(sweeper);
    },
  };
}

module.exports = { createRateLimiter };
