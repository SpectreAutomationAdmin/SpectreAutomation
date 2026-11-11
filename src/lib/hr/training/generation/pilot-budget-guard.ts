// EP-TRAIN-4Y-Z §3 — Per-pilot cumulative spending guard.
//
// Spectre has three concentric spending protections:
//
//   1. Modal account-level spending limit    ($10 — provider-side)
//   2. Per-tenant daily USD cap               ($10/day/clubId —
//      `DEFAULT_DAILY_USD_MICROS` in generation-service.ts)
//   3. Per-pilot cumulative ceiling          ($1 — this module,
//      application-side)
//
// This third layer bounds a single authorised pilot (= one
// (clubId, courseVersionId) target). It is application-side, NOT a
// provider-side hard cap, so it cannot guarantee zero overage if a
// bug bypasses it; it CAN prevent additional invocations once the
// conservative worst-case projection crosses $1.
//
// Retries, cold-boot time, prior failed attempts, metadata calls, and
// question-generation calls all count toward the same cumulative
// basis. The guard is called BEFORE each Modal invocation; if the
// conservative worst-case projection of the pilot's cumulative cost
// (incurred + accumulated + remaining ceiling) exceeds the budget,
// the call is refused and the run is terminated non-retryably.

import { PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "@/lib/prisma";

/** Pilot budget (application-side). Distinct from the $10/day/club
 *  cap in generation-service.ts and the $10 Modal account cap. */
export const PILOT_BUDGET_USD_MICROS = 1_000_000; // $1.00 × 1e6

/** EP-TRAIN-4Y-AN §2 — per-pilot budget overrides.
 *
 *  Scoped to specific (courseVersionId) tuples so a raise is applied
 *  ONLY to the authorised pilot (directive §2 constraint: "Do not
 *  change global budget policies for other tenants"). Any pilot NOT
 *  in this table falls back to `PILOT_BUDGET_USD_MICROS` ($1.00).
 *
 *  Each entry must carry (versionId, budgetUsdMicros, authorisation
 *  reference) as part of the auditable record. The auth reference is
 *  a founder-issued directive slug — Spectre's generation history log
 *  then ties the elevated spend to the directive that authorised it.
 */
export const PILOT_BUDGET_OVERRIDES: ReadonlyMap<string, {
  readonly budgetUsdMicros: number;
  readonly authorisation: string;
}> = new Map([
  // Silver Springs onboarding pilot — AN §1 raise to $2 for the
  // single bounded shortfall-only completion attempt.
  ["cmw8n6z9a000az4nx56vwh02f", {
    budgetUsdMicros: 2_000_000,
    authorisation: "EP-TRAIN-4Y-AN founder directive 2026-11-10",
  }],
]);

/** Resolve the budget for a (courseVersionId). Returns the override if
 *  one exists; otherwise the default $1 pilot cap. */
export function getPilotBudgetMicros(courseVersionId: string): number {
  const override = PILOT_BUDGET_OVERRIDES.get(courseVersionId);
  return override?.budgetUsdMicros ?? PILOT_BUDGET_USD_MICROS;
}

// Observed Qwen-on-A10G runtime in prior EP-TRAIN-4Y-N / 4Y-V runs:
// successful calls completed in 20-32 s typical, 84 s maximum; the
// 4Y-V attempt 1 failure root cause was forced cancellation at the
// 120 s CPU timeout (now raised to 900 s by §2). We project 180 s per
// call as the conservative WORST-CASE ceiling (5.6× typical) so that
// a slow call plus a retry still leaves headroom under the budget
// without needlessly tripping the gate on a normal run.
export const PER_CALL_WORST_CASE_MS = 180_000;    // 3 min

// First Modal call of a cold container pays an additional ~60 s for
// `@modal.enter() _load_model`. Subsequent calls within the 180 s
// `scaledown_window` are cache-hot.
export const COLD_BOOT_WORST_CASE_MS = 60_000;    // 1 min

/** L40S $1.95/hr → 0.541666… micros/ms. Reused verbatim from
 *  generation-service.ts for consistency. Qwen on A10G is cheaper
 *  (~$1.10/hr = 0.306 micros/ms), so this rate is conservative. */
export const COST_PER_MS_MICROS = 0.541_666_7;

export function msToCostMicros(ms: number): number {
  return Math.ceil(ms * COST_PER_MS_MICROS);
}

export interface PilotBudgetState {
  /** Micros already incurred by PRIOR attempts of this pilot (sum of
   *  `inferenceMs` on all non-current runs for the same
   *  (clubId, courseVersionId) — including FAILED and CANCELLED). */
  readonly priorAttemptCostMicros: number;
  /** Micros accumulated so far during the CURRENT attempt
   *  (metadata call + each group call that has completed). */
  readonly currentAttemptCostMicros: number;
  /** Modal calls not yet made during the current attempt. */
  readonly callsRemainingThisAttempt: number;
  /** Whether cold-boot has already been charged this attempt. */
  readonly coldBootConsumed: boolean;
}

/** Conservative worst-case projection: everything already spent, plus
 *  `callsRemaining × 180 s × L40S rate`, plus 60 s cold-boot if not
 *  yet consumed. */
export function projectPilotWorstCaseMicros(state: PilotBudgetState): number {
  const remaining = Math.max(0, state.callsRemainingThisAttempt);
  const perCall = msToCostMicros(PER_CALL_WORST_CASE_MS);
  const coldBoot = state.coldBootConsumed ? 0 : msToCostMicros(COLD_BOOT_WORST_CASE_MS);
  return state.priorAttemptCostMicros
    + state.currentAttemptCostMicros
    + (remaining * perCall)
    + coldBoot;
}

export interface BudgetGateDecision {
  readonly allow: boolean;
  readonly projectedTotalMicros: number;
  readonly budgetMicros: number;
  /** Populated when `allow === false`. Suitable for a
   *  `recordGenerationFailed.failureMessage` body — does NOT contain
   *  secrets, tokens, or signed URLs. */
  readonly reason?: string;
}

/** Pure, DB-free, synchronous: decide whether the NEXT Modal
 *  invocation is permitted by the pilot budget.
 *
 *  EP-TRAIN-4Y-AN §2 — accepts an optional `budgetMicros` override so
 *  per-pilot raises (e.g. the Silver Springs $2 directive) apply ONLY
 *  to the authorised pilot. The default is the $1 global.
 */
export function preInvocationBudgetGate(
  state: PilotBudgetState,
  opts: { readonly budgetMicros?: number } = {},
): BudgetGateDecision {
  const projected = projectPilotWorstCaseMicros(state);
  const budgetMicros = opts.budgetMicros ?? PILOT_BUDGET_USD_MICROS;
  if (projected > budgetMicros) {
    const budgetUsd = (budgetMicros / 1_000_000).toFixed(2);
    return {
      allow: false,
      projectedTotalMicros: projected,
      budgetMicros,
      reason:
        `Pilot $${budgetUsd} budget would be exceeded. Projected worst-case ` +
        `cumulative cost: ${projected} micros (budget: ` +
        `${budgetMicros} micros). ` +
        `Prior-attempt cost: ${state.priorAttemptCostMicros}; ` +
        `current attempt: ${state.currentAttemptCostMicros}; ` +
        `remaining calls: ${state.callsRemainingThisAttempt}; ` +
        `cold-boot consumed: ${state.coldBootConsumed}.`,
    };
  }
  return {
    allow: true,
    projectedTotalMicros: projected,
    budgetMicros,
  };
}

/** Read the cumulative `inferenceMs` of every PRIOR attempt of this
 *  pilot (= every run for the same (clubId, courseVersionId) except
 *  the current one), convert to micros.
 *
 *  Scoped across ALL run states (COMPLETED, FAILED, CANCELLED,
 *  QUEUED) so a partially-executed earlier attempt whose
 *  `recordGenerationFailed` persisted its `inferenceMs` (per the §3
 *  patch) counts toward the budget — not just COMPLETED runs.
 *
 *  **Concurrency protection.** Spectre's existing worker already
 *  prevents two simultaneous runs for the same planIdentity via the
 *  lease on the queue claim; Modal's `max_containers=1` on the
 *  Qwen class prevents two GPU calls running in parallel. The
 *  budget-guard therefore relies on these existing serialization
 *  guarantees to prevent an overlapping call from inflating the
 *  cumulative cost mid-read — there is no racing writer. If a future
 *  change relaxes either constraint, this function must move to a
 *  transaction with `SELECT FOR UPDATE` (Postgres) or an advisory
 *  lock keyed on `(clubId, courseVersionId)`.
 */
export async function loadPriorPilotCostMicros(
  args: { clubId: string; courseVersionId: string; excludeRunId: string },
  opts: { prisma?: PrismaClient } = {},
): Promise<number> {
  const db = opts.prisma ?? defaultPrisma;
  const r = await db.trainingQuestionAiGenerationRun.aggregate({
    where: {
      clubId: args.clubId,
      courseVersionId: args.courseVersionId,
      id: { not: args.excludeRunId },
    },
    _sum: { inferenceMs: true },
  });
  const ms = r._sum.inferenceMs ?? 0;
  return msToCostMicros(ms);
}
