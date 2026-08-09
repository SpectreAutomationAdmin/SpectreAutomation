// Sprint 3 · Phase 4 Slice 5.6 (2026-08-09) — Cost / rate controls.
//
// Founder §18: initial staging limit 50 external research invocations
// per club per day + per-request caps + circuit breaker.
//
// This is an in-process rate limiter. A multi-instance deployment
// would need a Redis-backed counter — that's a Slice 5.7 hardening
// item. Staging is single-instance so in-process is sufficient for
// initial acceptance.

export interface RateLimitConfig {
  perClubPerDay: number;
  perRequestMaxQueries: number;
  perRequestMaxSources: number;
  perRequestTimeoutMs: number;
  wholeJobTimeoutMs: number;
  retryCeiling: number;
  circuitBreakerFailureThreshold: number;
  circuitBreakerCooldownMs: number;
}

export const DEFAULT_RATE_LIMIT: RateLimitConfig = {
  perClubPerDay: 50,             // §18 initial staging limit
  perRequestMaxQueries: 2,       // one identity question + up to 1 disambiguation
  perRequestMaxSources: 6,       // up to 6 candidate source URLs per query
  perRequestTimeoutMs: 8000,     // single request budget
  wholeJobTimeoutMs: 60000,      // web_search + fetch + parse budget
  retryCeiling: 1,               // one retry on transient failure only
  circuitBreakerFailureThreshold: 5,
  circuitBreakerCooldownMs: 5 * 60_000,   // 5-minute cool-off
};

// -----------------------------------------------------------------------------
// In-process daily counter per club
// -----------------------------------------------------------------------------

interface ClubCounter {
  dayIso: string;   // "YYYY-MM-DD" UTC
  count: number;
}

const DAILY_COUNTER = new Map<string, ClubCounter>();

function todayIsoUtc(): string {
  const d = new Date();
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

export function currentClubDailyCount(clubId: string): number {
  const c = DAILY_COUNTER.get(clubId);
  if (!c) return 0;
  if (c.dayIso !== todayIsoUtc()) return 0;   // stale, will reset on next tryConsume
  return c.count;
}

/** Attempt to consume one daily quota unit for the club. Returns
 *  { allowed: true } when under cap or false otherwise. Callers
 *  MUST NOT invoke the external provider when allowed is false. */
export function tryConsumeDailyQuota(clubId: string, config: RateLimitConfig = DEFAULT_RATE_LIMIT): {
  allowed: boolean;
  remaining: number;
  reason?: string;
} {
  const today = todayIsoUtc();
  const existing = DAILY_COUNTER.get(clubId);
  if (!existing || existing.dayIso !== today) {
    DAILY_COUNTER.set(clubId, { dayIso: today, count: 1 });
    return { allowed: true, remaining: config.perClubPerDay - 1 };
  }
  if (existing.count >= config.perClubPerDay) {
    return {
      allowed: false,
      remaining: 0,
      reason: `daily cap reached (${existing.count}/${config.perClubPerDay}) — resets 00:00 UTC`,
    };
  }
  existing.count += 1;
  return { allowed: true, remaining: config.perClubPerDay - existing.count };
}

/** Test-only: reset the counter for a club. Not exported for
 *  production callers — reserved for the acceptance harness. */
export function _resetDailyQuotaForTest(clubId?: string): void {
  if (clubId) DAILY_COUNTER.delete(clubId);
  else DAILY_COUNTER.clear();
}

// -----------------------------------------------------------------------------
// Circuit breaker — trip open after N consecutive failures per provider
// -----------------------------------------------------------------------------

interface BreakerState {
  failures: number;
  openedAt: number | null;
}

const BREAKER = new Map<string, BreakerState>();

export function circuitBreakerAllowed(providerName: string, config: RateLimitConfig = DEFAULT_RATE_LIMIT): {
  allowed: boolean;
  reason?: string;
} {
  const state = BREAKER.get(providerName);
  if (!state || state.openedAt == null) return { allowed: true };
  const now = Date.now();
  if (now - state.openedAt >= config.circuitBreakerCooldownMs) {
    // half-open: give one attempt
    BREAKER.set(providerName, { failures: 0, openedAt: null });
    return { allowed: true };
  }
  return {
    allowed: false,
    reason: `circuit-breaker open (${state.failures} consecutive failures, retry in ${Math.round((config.circuitBreakerCooldownMs - (now - state.openedAt)) / 1000)}s)`,
  };
}

export function circuitBreakerRecordFailure(providerName: string, config: RateLimitConfig = DEFAULT_RATE_LIMIT): void {
  const state = BREAKER.get(providerName) ?? { failures: 0, openedAt: null };
  state.failures += 1;
  if (state.failures >= config.circuitBreakerFailureThreshold) {
    state.openedAt = Date.now();
  }
  BREAKER.set(providerName, state);
}

export function circuitBreakerRecordSuccess(providerName: string): void {
  BREAKER.set(providerName, { failures: 0, openedAt: null });
}

export function _resetCircuitBreakerForTest(): void {
  BREAKER.clear();
}
