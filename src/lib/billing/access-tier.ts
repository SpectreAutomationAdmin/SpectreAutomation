// SIGNUP-2 Phase 2A (2026-10-25) -- Access-tier capability model.
//
// Pure functions.  The CRITICAL safeguard: enforcement is DORMANT
// for existing tenants.  Legacy ClubSubscription rows have
// `accessTier = null`, and every assertTierAtLeast call treats null
// as "grandfathered -> PASS".  Only Clubs that go through the
// SIGNUP-2 subscription flow receive a non-null `accessTier`, and
// only those Clubs have tier enforcement active.
//
// SIGNUP-2 Phase 2B (2026-10-25) adds two side-effectful helpers at
// the bottom of this file: `assertAccessTierForPosting(clubId)` and
// `assertAccessTierForClubEmail(clubId)`.  They are the ONLY code
// paths that read ClubSubscription.accessTier in Phase 2B; the
// posting-guard seam + the selectEmailAdapter seam call them.

import { ForbiddenError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";

/** The four access tiers. */
export const ACCESS_TIERS = [
  "PRE_AUTH",             // Nothing beyond Screen 3 status card.
  "STAGED",               // Onboarding prep: admin + Club config + queued invites + dry-run COA + dry-run opening balance + branding.
  "FULL",                 // Full operational access.
  "SUSPENDED_READ_ONLY",  // Tier-2 collapsed to Tier-1 read-only (post-reversal; pre-remediation).
] as const;
export type AccessTier = (typeof ACCESS_TIERS)[number];

/** Capability keys enforced by the tier system.  Each key maps to
 *  the MINIMUM tier required.  Capabilities not listed default
 *  to PRE_AUTH (universally permitted). */
export const CAPABILITY_MIN_TIER: Readonly<Record<string, AccessTier>> = {
  // Universally permitted (listed for explicitness).
  "signup.status.view":                "PRE_AUTH",
  "operator-inbox.view":               "PRE_AUTH",

  // STAGED (Tier 1) -- onboarding preparation.  Allowed during the
  // AWAITING_SETTLEMENT window per founder decision 1.
  "admin.profile.edit":                "STAGED",
  "club.identity.edit":                "STAGED",
  "club.departments.edit":             "STAGED",
  "club.role-templates.edit":          "STAGED",
  "club.user-invites.queue":           "STAGED",
  "club.coa.upload":                   "STAGED",      // dry-run only
  "club.opening-balance.upload":       "STAGED",      // dry-run only
  "club.branding.upload":              "STAGED",
  "club.portal.copy.edit":             "STAGED",

  // FULL (Tier 2) -- everything that moves money, posts to the
  // authoritative ledger, or reaches an external third party.
  "club.user-invites.deliver":         "FULL",
  "club.coa.commit":                   "FULL",
  "club.opening-balance.commit":       "FULL",
  "gl.journal.post":                   "FULL",
  "ap.invoice.post":                   "FULL",
  "ar.invoice.post":                   "FULL",
  "payroll.batch.run":                 "FULL",
  "payroll.statement.publish":         "FULL",
  "member.billing.post":               "FULL",
  "member.statement.publish":          "FULL",
  "club.mailbox.send":                 "FULL",
  "club.mailbox.integration.write":    "FULL",
  "member.portal.publish":             "FULL",
  "api.token.issue":                   "FULL",
  "integration.webhook.enable":        "FULL",

  // Only operator-visible shortcuts.  Reserved for Spectre's own
  // admin surface.
  "operator.manual-invoice.confirm":   "FULL",
  "operator.subscription.suspend":     "FULL",
  "operator.subscription.cancel":      "FULL",
} as const;
export type Capability = keyof typeof CAPABILITY_MIN_TIER;

/** Numeric ordering of the tiers for comparison.  SUSPENDED_READ_ONLY
 *  sits between STAGED and FULL -- it grants STAGED-level reads but
 *  denies STAGED-level writes.  See `isTierSufficient`. */
const TIER_RANK: Readonly<Record<AccessTier, number>> = {
  PRE_AUTH:            0,
  STAGED:              1,
  SUSPENDED_READ_ONLY: 2,   // read-only; higher than STAGED-write but lower than FULL
  FULL:                3,
} as const;

/**
 * Does the subject's current tier satisfy the required tier?
 *
 * Null `current` (legacy tenant without a SIGNUP-2 subscription
 * record) grandfathers to PASS -- enforcement is dormant for
 * existing tenants until separately authorised.
 *
 * SUSPENDED_READ_ONLY-held Clubs pass checks for PRE_AUTH + STAGED
 * (reads), fail checks for FULL (writes).  The capability map
 * doesn't currently distinguish STAGED-read vs STAGED-write, so
 * SUSPENDED_READ_ONLY is treated as satisfying STAGED by rank
 * ordering; actual write capabilities under SUSPENDED_READ_ONLY
 * are blocked at the capability layer (every STAGED-tier write
 * capability also requires `!isSuspendedReadOnly`).
 */
export function isTierSufficient(current: AccessTier | null, required: AccessTier): boolean {
  if (current === null) return true;  // grandfathered legacy tenant
  if (current === "SUSPENDED_READ_ONLY" && required === "FULL") return false;
  if (current === "SUSPENDED_READ_ONLY" && required === "STAGED") return true;
  return TIER_RANK[current] >= TIER_RANK[required];
}

/**
 * Server-side guard function.  Throws ForbiddenError if the
 * principal's active Club does not meet the required tier for the
 * named capability.  Legacy (null) tenants pass by design (see
 * header note).  Spectre-admin principals can bypass via an
 * operator-only override flag the caller may set.
 */
export function assertTierForCapability(args: {
  capability: Capability;
  currentTier: AccessTier | null;
  operatorOverride?: boolean;
}): void {
  if (args.operatorOverride === true) return;
  const required = CAPABILITY_MIN_TIER[args.capability];
  if (required === undefined) {
    // Unknown capability -- fail CLOSED on an unknown key.  This
    // forces a code change (adding the capability to the map) when
    // a new feature is wired through assertTierForCapability.
    throw new ForbiddenError(
      `SIGNUP-2 access-tier: unknown capability '${String(args.capability)}'`,
    );
  }
  if (isTierSufficient(args.currentTier, required)) return;
  throw new ForbiddenError(
    `SIGNUP-2 access-tier: capability '${String(args.capability)}' requires tier ${required}; current tier is ${args.currentTier ?? "null (grandfathered)"}`,
  );
}

/**
 * Shorthand for the common case: assert that the current tier is at
 * least `required`, with the legacy-grandfather semantics.  Does NOT
 * take a capability name; used by routes that gate on tier directly
 * (e.g. a global "operational-features-only" middleware).
 */
export function assertTierAtLeast(args: {
  currentTier: AccessTier | null;
  required: AccessTier;
  operatorOverride?: boolean;
}): void {
  if (args.operatorOverride === true) return;
  if (isTierSufficient(args.currentTier, args.required)) return;
  throw new ForbiddenError(
    `SIGNUP-2 access-tier: required tier ${args.required}; current tier is ${args.currentTier ?? "null (grandfathered)"}`,
  );
}

/** Convenience helper for routes that need to know the Club's
 *  current tier string without performing an assertion.  Returns
 *  `null` for grandfathered legacy tenants so the caller can
 *  express "legacy means allow". */
export function readAccessTier(subscriptionAccessTier: string | null): AccessTier | null {
  if (subscriptionAccessTier == null) return null;
  if ((ACCESS_TIERS as readonly string[]).includes(subscriptionAccessTier)) {
    return subscriptionAccessTier as AccessTier;
  }
  // Unknown stored value -- treat as grandfathered rather than
  // fail-closed so a bad DB write cannot lock legacy Clubs out.
  // Future code should log + audit this case; Phase 2A does not
  // wire the write path so it cannot occur yet.
  return null;
}

// =========================================================================
// SIGNUP-2 Phase 2B (2026-10-25) -- Side-effectful tier gates.
// =========================================================================
// These two helpers are the ONLY code paths that read
// ClubSubscription.accessTier in Phase 2B.  Each is called from
// exactly one upstream seam:
//
//   - assertAccessTierForPosting(clubId) is called from
//     src/lib/posting-guard/index.ts (both assertPostingAllowed
//     and assertSensitiveActionAllowed).  Covers 40+ financial
//     + HR + sensitive-action callers (classifications A + B in
//     docs/signup-2-phase-2b-capability-matrix.md).
//
//   - assertAccessTierForClubEmail(clubId) is called from
//     src/lib/integrations/email.ts selectEmailAdapter(args).
//     Covers Club-scoped outbound email (classification C in the
//     capability matrix) -- the only FULL-tier capability surface
//     that bypasses posting-guard today.
//
// Three PASS conditions (ANY satisfies):
//   1. No ClubSubscription row for the Club (legacy grandfather).
//   2. accessTier is null or an unknown string (legacy grandfather).
//   3. accessTier == "FULL" OR subscriptionStatus == "MANUAL_INVOICE".
//
// One FAIL condition: anything else (STAGED, SUSPENDED_READ_ONLY,
// or a future value we have not whitelisted) -> throw ForbiddenError.
//
// Operator override is NOT supported at this layer -- operators
// use their own code paths that call these guards with
// operator-elevated principals, and the operator path's audit
// trail is captured by the posting-guard seam's audit() call
// (unchanged).

/** Transaction-aware access-tier evaluator.
 *
 *  When invoked WITHOUT a tx (legacy call-site), it reads the
 *  ClubSubscription row with plain findUnique.  This preserves the
 *  Phase 2B behaviour for the ~50 pre-existing posting-guard
 *  call-sites that have not yet migrated.
 *
 *  When invoked WITH a tx (M1 call-site -- e.g. via
 *  withPostingGuard() in src/lib/posting-guard), the evaluator issues
 *  `SELECT ... FOR UPDATE` on ClubSubscription so the subscription
 *  row is row-locked for the duration of the caller's transaction.
 *  Phase 2H's suspendTenant + reinstateTenant use the same lock on
 *  the same row, so suspension cannot interleave with a protected
 *  write.  Legacy tenants (subscriptionStatus=null) short-circuit
 *  with the same grandfather-PASS semantics.
 *
 *  The lock is a per-row Postgres advisory via FOR UPDATE; it does
 *  NOT block reads from other transactions, only writes.  Suspension
 *  and the protected write both take the lock; whichever acquires
 *  first dictates ordering.
 */
async function evaluateAccessTierGate(
  clubId: string,
  opts?: { tx?: { $queryRawUnsafe: (sql: string, ...args: unknown[]) => Promise<unknown[]> } },
): Promise<{ pass: boolean; detail: string }> {
  let sub: { accessTier: string | null; subscriptionStatus: string | null } | null = null;
  if (opts?.tx) {
    // Transaction-bound read with FOR UPDATE.  Row-level lock held
    // until the caller's tx commits or rolls back.
    const rows = (await opts.tx.$queryRawUnsafe(
      `SELECT "accessTier", "subscriptionStatus"
         FROM "ClubSubscription"
         WHERE "clubId" = $1
         FOR UPDATE`,
      clubId,
    )) as Array<{ accessTier: string | null; subscriptionStatus: string | null }>;
    sub = rows[0] ?? null;
  } else {
    sub = await prisma.clubSubscription.findUnique({
      where: { clubId },
      select: { accessTier: true, subscriptionStatus: true },
    });
  }
  if (!sub) return { pass: true, detail: "no-subscription-row" };
  // Founder closure §1.5 preserved: legacy tenants with null
  // subscriptionStatus pass regardless of accessTier.
  if (sub.subscriptionStatus === null) return { pass: true, detail: "legacy-grandfather-status-null" };
  const tier = readAccessTier(sub.accessTier);
  if (tier === null) return { pass: true, detail: "legacy-grandfather" };
  if (tier === "FULL") {
    // Phase 2H addition: refuse when status is UNDER_REVIEW /
    // SUSPENDED / CANCELLED even if tier was never flipped (defence
    // in depth; a correctly-flipped tenant has tier=SUSPENDED_READ_ONLY).
    if (
      sub.subscriptionStatus === "UNDER_REVIEW" ||
      sub.subscriptionStatus === "SUSPENDED" ||
      sub.subscriptionStatus === "CANCELLED"
    ) {
      return {
        pass: false,
        detail: `tier=FULL status=${sub.subscriptionStatus} (Phase 2H blocked)`,
      };
    }
    return { pass: true, detail: "full" };
  }
  if (sub.subscriptionStatus === "MANUAL_INVOICE") {
    return { pass: true, detail: "manual-invoice" };
  }
  return {
    pass: false,
    detail: `tier=${tier} status=${sub.subscriptionStatus ?? "null"}`,
  };
}

export async function assertAccessTierForPosting(
  clubId: string,
  opts?: { tx?: { $queryRawUnsafe: (sql: string, ...args: unknown[]) => Promise<unknown[]> } },
): Promise<void> {
  const result = await evaluateAccessTierGate(clubId, opts);
  if (result.pass) return;
  throw new ForbiddenError(
    `SIGNUP-2 access-tier: posting-tier action rejected for Club ${clubId} (${result.detail})`,
  );
}

export async function assertAccessTierForClubEmail(clubId: string): Promise<void> {
  const result = await evaluateAccessTierGate(clubId);
  if (result.pass) return;
  throw new ForbiddenError(
    `SIGNUP-2 access-tier: club-outbound-email rejected for Club ${clubId} (${result.detail})`,
  );
}
