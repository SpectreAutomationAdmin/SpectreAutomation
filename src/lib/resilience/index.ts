// Phase 12I — Platform resilience: circuit breakers + retry budgets.
//
// Goal: protect Spectre from cascading failure when an external dependency
// (POS provider, payment processor, push gateway, webhook receiver, etc.)
// goes intermittent or down.
//
// The breaker state is persisted in CircuitBreakerState so multiple workers
// share the same view. Each unique `resourceKey` (e.g. "pos:square") has its
// own breaker.
//
// States:
//   CLOSED     — normal; calls pass through.
//   OPEN       — failing fast; calls short-circuit until cooldown elapses.
//   HALF_OPEN  — probing; one trial call is allowed.
//
// Retry budget: per resourceKey, we cap concurrent in-flight retries to
// avoid retry storms when a dependency is degraded.

import { prisma } from "../prisma";
import { logger } from "../observability/logger";
import { getObservability } from "../observability/adapter";

export interface BreakerConfig {
  failureThreshold: number; // open after this many consecutive failures
  cooldownMs: number;       // OPEN → HALF_OPEN after this delay
  halfOpenSuccesses: number;// HALF_OPEN → CLOSED after this many trial successes
}

const DEFAULT_CONFIG: BreakerConfig = {
  failureThreshold: 5,
  cooldownMs: 30_000,
  halfOpenSuccesses: 2,
};

export class CircuitOpenError extends Error {
  readonly resourceKey: string;
  readonly retryAfterMs: number;
  constructor(resourceKey: string, retryAfterMs: number) {
    super(`Circuit ${resourceKey} is OPEN; retry in ${retryAfterMs}ms`);
    this.resourceKey = resourceKey;
    this.retryAfterMs = retryAfterMs;
  }
}

async function loadOrInit(resourceKey: string, clubId: string | null, config: BreakerConfig) {
  const existing = await prisma.circuitBreakerState.findUnique({ where: { resourceKey } });
  if (existing) return existing;
  return prisma.circuitBreakerState.create({
    data: {
      resourceKey, clubId: clubId ?? null,
      state: "CLOSED", thresholdHint: config.failureThreshold,
    },
  });
}

async function transitionOpen(resourceKey: string) {
  const now = new Date();
  await prisma.circuitBreakerState.update({
    where: { resourceKey },
    data: { state: "OPEN", openedAt: now, lastFailureAt: now, successCount: 0 },
  });
  logger.warn("resilience.circuit_open", { resourceKey });
  getObservability().incrCounter("spectre_circuit_state_change_total", { resourceKey, to: "OPEN" }, 1);
}

async function transitionHalfOpen(resourceKey: string) {
  await prisma.circuitBreakerState.update({
    where: { resourceKey },
    data: { state: "HALF_OPEN", successCount: 0 },
  });
  logger.info("resilience.circuit_half_open", { resourceKey });
  getObservability().incrCounter("spectre_circuit_state_change_total", { resourceKey, to: "HALF_OPEN" }, 1);
}

async function transitionClosed(resourceKey: string) {
  await prisma.circuitBreakerState.update({
    where: { resourceKey },
    data: { state: "CLOSED", failureCount: 0, successCount: 0, openedAt: null, resetAt: new Date() },
  });
  logger.info("resilience.circuit_closed", { resourceKey });
  getObservability().incrCounter("spectre_circuit_state_change_total", { resourceKey, to: "CLOSED" }, 1);
}

// ---------------------------------------------------------------------------
// Main entrypoint: wrap a downstream call in a circuit breaker.
// ---------------------------------------------------------------------------
export async function withBreaker<T>(args: {
  resourceKey: string;
  clubId?: string | null;
  config?: Partial<BreakerConfig>;
  call: () => Promise<T>;
}): Promise<T> {
  const config: BreakerConfig = { ...DEFAULT_CONFIG, ...(args.config ?? {}) };
  let state = await loadOrInit(args.resourceKey, args.clubId ?? null, config);

  // Check OPEN → HALF_OPEN promotion if cooldown elapsed.
  if (state.state === "OPEN") {
    const openedAt = state.openedAt ?? new Date(0);
    if (Date.now() - openedAt.getTime() >= config.cooldownMs) {
      await transitionHalfOpen(args.resourceKey);
      state = await prisma.circuitBreakerState.findUnique({ where: { resourceKey: args.resourceKey } }) ?? state;
    } else {
      const retryAfterMs = config.cooldownMs - (Date.now() - openedAt.getTime());
      getObservability().incrCounter("spectre_circuit_rejected_total", { resourceKey: args.resourceKey }, 1);
      throw new CircuitOpenError(args.resourceKey, retryAfterMs);
    }
  }

  try {
    const result = await args.call();
    if (state.state === "HALF_OPEN") {
      const next = state.successCount + 1;
      if (next >= config.halfOpenSuccesses) {
        await transitionClosed(args.resourceKey);
      } else {
        await prisma.circuitBreakerState.update({
          where: { resourceKey: args.resourceKey },
          data: { successCount: next },
        });
      }
    } else if (state.failureCount > 0) {
      // Reset failure count on first success.
      await prisma.circuitBreakerState.update({
        where: { resourceKey: args.resourceKey },
        data: { failureCount: 0 },
      });
    }
    return result;
  } catch (err) {
    const nextFailureCount = state.failureCount + 1;
    if (state.state === "HALF_OPEN") {
      // Single probe failed — fail straight back to OPEN.
      await transitionOpen(args.resourceKey);
    } else if (nextFailureCount >= config.failureThreshold) {
      await transitionOpen(args.resourceKey);
    } else {
      await prisma.circuitBreakerState.update({
        where: { resourceKey: args.resourceKey },
        data: { failureCount: nextFailureCount, lastFailureAt: new Date() },
      });
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Retry-budget guard: bounds concurrent retries per resourceKey to prevent
// retry storms. In-memory only (per-process).
// ---------------------------------------------------------------------------
const retryBudgets = new Map<string, number>();

export async function withRetryBudget<T>(args: {
  resourceKey: string;
  maxConcurrent?: number;
  call: () => Promise<T>;
}): Promise<T> {
  const max = args.maxConcurrent ?? 10;
  const inFlight = retryBudgets.get(args.resourceKey) ?? 0;
  if (inFlight >= max) {
    getObservability().incrCounter("spectre_retry_budget_exhausted_total", { resourceKey: args.resourceKey }, 1);
    throw new Error(`Retry budget exhausted for ${args.resourceKey} (${inFlight}/${max})`);
  }
  retryBudgets.set(args.resourceKey, inFlight + 1);
  try {
    return await args.call();
  } finally {
    const after = (retryBudgets.get(args.resourceKey) ?? 1) - 1;
    if (after <= 0) retryBudgets.delete(args.resourceKey);
    else retryBudgets.set(args.resourceKey, after);
  }
}

// ---------------------------------------------------------------------------
// Inspection / admin
// ---------------------------------------------------------------------------
export async function listBreakers(clubId?: string | null) {
  return prisma.circuitBreakerState.findMany({
    where: clubId === undefined ? {} : { clubId: clubId ?? null },
    orderBy: [{ state: "asc" }, { resourceKey: "asc" }],
  });
}

export async function forceCloseBreaker(resourceKey: string) {
  const existing = await prisma.circuitBreakerState.findUnique({ where: { resourceKey } });
  if (!existing) return null;
  await transitionClosed(resourceKey);
  return prisma.circuitBreakerState.findUnique({ where: { resourceKey } });
}

export async function forceOpenBreaker(resourceKey: string) {
  await prisma.circuitBreakerState.upsert({
    where: { resourceKey },
    update: { state: "OPEN", openedAt: new Date(), lastFailureAt: new Date() },
    create: { resourceKey, state: "OPEN", openedAt: new Date(), lastFailureAt: new Date() },
  });
  return prisma.circuitBreakerState.findUnique({ where: { resourceKey } });
}
