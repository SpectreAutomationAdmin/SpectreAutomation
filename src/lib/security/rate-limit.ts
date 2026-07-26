// Phase 8H — Token-bucket rate limiter with two adapters:
//   - inMemoryRateLimit: process-local Map, suitable for single-instance
//     deployments + tests. Fast and dependency-free.
//   - dbRateLimit: persists buckets to RateLimitBucket so distributed
//     workers share state. Use when running > 1 web instance.
//
// Buckets refill at `tokensPerSecond` up to `capacity`. `consume(n)`
// returns whether n tokens were available; on miss the caller should
// emit a 429.

import { prisma } from "../prisma";
import { logger } from "../observability/logger";

export interface RateLimitOptions {
  scope: string;          // logical bucket name ("login" | "webhook:square" | ...)
  identifier: string;     // IP / userId / clubId / composite
  capacity: number;       // max tokens
  tokensPerSecond: number;
  cost?: number;          // tokens consumed per call (default 1)
}

export interface RateLimiter {
  name: string;
  consume(opts: RateLimitOptions): Promise<{ allowed: boolean; remaining: number; retryAfterMs?: number }>;
}

// ---------------------------------------------------------------------------
// In-memory adapter.
// ---------------------------------------------------------------------------
const memoryBuckets = new Map<string, { tokens: number; updatedAt: number }>();
export function _resetInMemoryBuckets() { memoryBuckets.clear(); }
export const inMemoryRateLimit: RateLimiter = {
  name: "memory",
  async consume(opts) {
    const key = `${opts.scope}:${opts.identifier}`;
    const cost = opts.cost ?? 1;
    const now = Date.now();
    const existing = memoryBuckets.get(key);
    const tokens = existing
      ? Math.min(opts.capacity, existing.tokens + ((now - existing.updatedAt) / 1000) * opts.tokensPerSecond)
      : opts.capacity;
    if (tokens < cost) {
      const need = cost - tokens;
      const retryAfterMs = Math.ceil((need / opts.tokensPerSecond) * 1000);
      return { allowed: false, remaining: tokens, retryAfterMs };
    }
    memoryBuckets.set(key, { tokens: tokens - cost, updatedAt: now });
    return { allowed: true, remaining: tokens - cost };
  },
};

// ---------------------------------------------------------------------------
// Database-backed adapter (cluster-safe).
// ---------------------------------------------------------------------------
export const dbRateLimit: RateLimiter = {
  name: "db",
  async consume(opts) {
    const cost = opts.cost ?? 1;
    const now = new Date();
    const existing = await prisma.rateLimitBucket.findUnique({
      where: { scope_identifier: { scope: opts.scope, identifier: opts.identifier } },
    });
    let tokens: number;
    if (existing) {
      const elapsed = (now.getTime() - existing.refillAt.getTime()) / 1000;
      tokens = Math.min(opts.capacity, Number(existing.tokens.toString()) + elapsed * opts.tokensPerSecond);
    } else {
      tokens = opts.capacity;
    }
    if (tokens < cost) {
      const need = cost - tokens;
      const retryAfterMs = Math.ceil((need / opts.tokensPerSecond) * 1000);
      // Update timestamp so the next call sees a continuous refill window.
      await prisma.rateLimitBucket.upsert({
        where: { scope_identifier: { scope: opts.scope, identifier: opts.identifier } },
        update: { tokens, refillAt: now },
        create: { scope: opts.scope, identifier: opts.identifier, tokens, refillAt: now },
      });
      return { allowed: false, remaining: tokens, retryAfterMs };
    }
    const remaining = tokens - cost;
    await prisma.rateLimitBucket.upsert({
      where: { scope_identifier: { scope: opts.scope, identifier: opts.identifier } },
      update: { tokens: remaining, refillAt: now },
      create: { scope: opts.scope, identifier: opts.identifier, tokens: remaining, refillAt: now },
    });
    return { allowed: true, remaining };
  },
};

let activeLimiter: RateLimiter = inMemoryRateLimit;
export function setRateLimiter(rl: RateLimiter) { activeLimiter = rl; }
export function getRateLimiter(): RateLimiter { return activeLimiter; }

// Convenience: predefined buckets for common surfaces.
export const RATE_LIMIT_PROFILES = {
  login: { capacity: 5, tokensPerSecond: 0.2 },         // 5 attempts, refill 1 per 5s
  password_reset: { capacity: 3, tokensPerSecond: 0.05 },
  public_application: { capacity: 10, tokensPerSecond: 0.5 },
  webhook_pos: { capacity: 60, tokensPerSecond: 5 },
  download: { capacity: 30, tokensPerSecond: 1 },
  export: { capacity: 10, tokensPerSecond: 0.1 },
} as const;

export type RateProfile = keyof typeof RATE_LIMIT_PROFILES;

// One-call helper that combines profile lookup + consume + log.
export async function consumeRate(profile: RateProfile, identifier: string): Promise<{ allowed: boolean; remaining: number; retryAfterMs?: number }> {
  const cfg = RATE_LIMIT_PROFILES[profile];
  const result = await activeLimiter.consume({ scope: profile, identifier, ...cfg });
  if (!result.allowed) {
    logger.warn("rate_limit.deny", { profile, identifier, retryAfterMs: result.retryAfterMs });
  }
  return result;
}
