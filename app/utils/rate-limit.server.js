/**
 * In-memory token-bucket rate limiter.
 *
 * Single-process only. Render free/starter runs one instance, so this is
 * sufficient. If we ever scale to multiple instances, replace the Map with
 * Redis (Upstash / Render Key-Value) keeping the same `consume()` shape.
 *
 * Usage:
 *   import { consume, getClientIp } from "../utils/rate-limit.server";
 *   const ok = consume(`carrier:${shop}`, { capacity: 60, refillPerSec: 1 });
 *   if (!ok) return new Response(JSON.stringify({ error: "rate_limited" }),
 *     { status: 429, headers: { "Retry-After": "30" } });
 */

const buckets = new Map();
const MAX_KEYS = 10_000;

function evictIfFull() {
  if (buckets.size < MAX_KEYS) return;
  // Drop the oldest 25% by insertion order. Map preserves insertion order, so
  // iterating from the start yields the oldest keys first.
  const dropCount = Math.floor(MAX_KEYS * 0.25);
  let dropped = 0;
  for (const key of buckets.keys()) {
    buckets.delete(key);
    if (++dropped >= dropCount) break;
  }
}

/**
 * Consume one token from the bucket identified by `key`. Returns true when
 * the request should be allowed, false when rate-limited.
 *
 *   capacity     — burst size; bucket starts full at this many tokens.
 *   refillPerSec — sustained rate (tokens added per second).
 */
export function consume(key, { capacity, refillPerSec }) {
  if (!key) return true;
  const now = Date.now();
  let bucket = buckets.get(key);

  if (!bucket) {
    evictIfFull();
    bucket = { tokens: capacity, last: now };
    buckets.set(key, bucket);
  } else {
    const elapsedSec = (now - bucket.last) / 1000;
    if (elapsedSec > 0) {
      bucket.tokens = Math.min(capacity, bucket.tokens + elapsedSec * refillPerSec);
      bucket.last = now;
    }
  }

  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    return true;
  }
  return false;
}

/**
 * Best-effort client IP extraction. Render terminates TLS at its proxy and
 * forwards the original IP via `x-forwarded-for`. Falls back to a constant
 * so all unknown clients share a bucket (still bounded, just less granular).
 */
export function getClientIp(request) {
  const xff = request.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  return request.headers.get("x-real-ip") || "unknown";
}

/**
 * Standard 429 response with Retry-After hint and optional CORS headers.
 */
export function rateLimitedResponse(retryAfterSec = 30, extraHeaders = {}) {
  return Response.json(
    { error: "rate_limited", retry_after: retryAfterSec },
    {
      status: 429,
      headers: {
        "Retry-After": String(retryAfterSec),
        ...extraHeaders,
      },
    },
  );
}
