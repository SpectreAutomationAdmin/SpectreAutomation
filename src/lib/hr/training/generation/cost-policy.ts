// EP-TRAIN-4Y-BA §2+§6 — Production AI consumption policy for
// Safety & Training. Distinguishes pilot vs commercial mode, and
// enumerates the concentric spending-protection layers the system
// enforces.
//
// This module is PURE and OFFLINE. It does not read or write the DB.
// Call sites (worker + budget-guard) consume these constants directly.
//
// IMPORTANT: this policy preserves every existing infrastructure cap.
// It does NOT change the $10 Modal account-level spend cap, the
// $10/day/club cap, or the pilot per-course cap. It PROPOSES a
// production per-course default ($5) that is higher than the
// historical $1 pilot cap but still strictly bounded.

/**
 * Mode discriminator for the AI consumption policy.
 *
 * - "pilot"      — the historical experimental mode. Tight per-course
 *                   cap ($1 default) + explicit founder authorization
 *                   per course via `PER_COURSE_BUDGET_OVERRIDES`.
 * - "commercial" — the production mode for authorized club managers.
 *                   Per-course cap defaults to $5. The budget guard
 *                   still refuses runaway worst-case projections.
 */
export type CostPolicyMode = "pilot" | "commercial";

export interface CostPolicy {
  readonly mode: CostPolicyMode;
  /** Per-course processing budget in USD micros. */
  readonly perCourseBudgetUsdMicros: number;
  /** Maximum number of distinct generation-run attempts per course
   *  before the policy refuses. Beyond this, the manager must open a
   *  new course draft or request a founder override. */
  readonly maxGenerationAttempts: number;
  /** Maximum retries per Modal call (independent of the generation-run
   *  attempt cap). The queue runner caps this at `maxAttempts` on the
   *  job row; the policy constant here is the ceiling. */
  readonly maxRetriesPerCall: number;
  /** Behavior when the per-course budget is exhausted. */
  readonly onBudgetExhausted: "REFUSE_AND_SURFACE";
  /** Behavior when the daily tenant cap is exhausted. */
  readonly onDailyCapExhausted: "REFUSE_AND_SURFACE";
  /** Behavior when the Modal account cap is hit. */
  readonly onAccountCapExhausted: "REFUSE_AND_HOLD";
}

/** The historical pilot policy (unchanged from pre-BA). */
export const PILOT_POLICY: CostPolicy = {
  mode: "pilot",
  perCourseBudgetUsdMicros: 1_000_000,
  maxGenerationAttempts: 3,
  maxRetriesPerCall: 2,
  onBudgetExhausted: "REFUSE_AND_SURFACE",
  onDailyCapExhausted: "REFUSE_AND_SURFACE",
  onAccountCapExhausted: "REFUSE_AND_HOLD",
};

/**
 * Commercial policy — the production default for authorized managers.
 *
 * Numbers are chosen to accommodate right-sized plans (see
 * `placement.ts` evenlyPickIndices) for routine 10-minute training
 * videos with worst-case projected cost ≤ $1.50 (metadata + ~6 Modal
 * calls × 180s worst-case + one cold-boot). The $5 cap therefore
 * absorbs one retry per call plus the small metadata attribution call.
 *
 * A course that genuinely needs more than $5 (e.g. a 2-hour onboarding
 * recording with dozens of distinct learning objectives) must be
 * added to PER_COURSE_BUDGET_OVERRIDES by a founder with an auditable
 * reason. The policy intentionally forces a human decision for the
 * long tail rather than silently allowing arbitrary spend.
 */
export const COMMERCIAL_POLICY: CostPolicy = {
  mode: "commercial",
  perCourseBudgetUsdMicros: 5_000_000,
  maxGenerationAttempts: 3,
  maxRetriesPerCall: 2,
  onBudgetExhausted: "REFUSE_AND_SURFACE",
  onDailyCapExhausted: "REFUSE_AND_SURFACE",
  onAccountCapExhausted: "REFUSE_AND_HOLD",
};

/**
 * Per-tenant monthly AI spending ceiling (micros).
 *
 * Proposal for production: $300/month/clubId, independent of the
 * $10/day/club rolling cap. Captures runaway spend across a slow-
 * drip pattern (10 days of $9.99 spending would pass the daily cap
 * but should be surfaced to the operator). This slice ADDS THE
 * CONSTANT but does not yet enforce it at call time — enforcement
 * would need a per-tenant monthly rollup query the budget-guard
 * does not yet carry. Deferred to a follow-up slice.
 */
export const MONTHLY_TENANT_SPEND_CAP_USD_MICROS = 300_000_000; // $300.00

/**
 * Infrastructure-layer caps — recorded here for documentation only.
 * The actual enforcement lives at the respective layer.
 */
export const INFRASTRUCTURE_CAPS = {
  modalAccountCapUsdMicros: 10_000_000,       // $10 — Modal dashboard
  tenantDailyCapUsdMicros: 10_000_000,        // $10 — generation-service.ts
  defaultPerCourseCapUsdMicros: 5_000_000,    // $5  — commercial policy
  pilotPerCourseCapUsdMicros: 1_000_000,      // $1  — pilot policy
  monthlyTenantCapUsdMicros: 300_000_000,     // $300 — proposed, deferred
} as const;

/**
 * Pick the active policy for a (clubId, courseVersionId) tuple. For
 * this slice the mode discrimination is intentionally conservative:
 * every course is "pilot" unless the version id appears in
 * PER_COURSE_BUDGET_OVERRIDES (an explicit founder-directive list)
 * OR the system has been flipped to commercial globally via the
 * `TRAINING_COST_POLICY_MODE=commercial` environment variable.
 *
 * The environment flag gate ensures the production policy does not
 * silently become active on a staging deploy — flipping it is an
 * operator decision captured in Fly secrets, not a code change.
 */
export function selectCostPolicy(opts: {
  readonly hasOverride: boolean;
  readonly env?: NodeJS.ProcessEnv;
}): CostPolicy {
  if (opts.hasOverride) return PILOT_POLICY; // override wins — explicit raise lives in PER_COURSE_BUDGET_OVERRIDES
  const env = opts.env ?? process.env;
  if (env.TRAINING_COST_POLICY_MODE === "commercial") return COMMERCIAL_POLICY;
  return PILOT_POLICY;
}
