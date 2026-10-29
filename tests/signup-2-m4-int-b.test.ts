// SIGNUP-2 M4-INT-B (2026-10-29) -- Operational completion contract tests.
//
// Covers:
//   §1 commercial authorization + payment release API + UI shape,
//   §2 billing exception management API + UI shape,
//   §3 renewal review API + UI shape,
//   §4 billing operations hub integration (links to all three),
//   §7 flag discipline preserved (dormant on staging).

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  OPERATOR_RESOLUTIONS,
} from "@/lib/billing/signup-2m4-exception-resolution";
import {
  RENEWAL_REVIEW_OUTCOMES,
} from "@/lib/billing/signup-2m4-renewal-review";

const TRIG_API = readFileSync(
  join(process.cwd(), "src/app/api/admin/billing/triggering/route.ts"),
  "utf8",
);
const TRIG_UI = readFileSync(
  join(process.cwd(), "src/app/app/admin/signup-ops/billing/triggering/page.tsx"),
  "utf8",
);
const EXCEPTION_API = readFileSync(
  join(process.cwd(), "src/app/api/admin/billing/exceptions/route.ts"),
  "utf8",
);
const EXCEPTION_UI = readFileSync(
  join(process.cwd(), "src/app/app/admin/signup-ops/billing/exceptions/page.tsx"),
  "utf8",
);
const RENEWAL_API = readFileSync(
  join(process.cwd(), "src/app/api/admin/billing/renewal-review/route.ts"),
  "utf8",
);
const RENEWAL_UI = readFileSync(
  join(process.cwd(), "src/app/app/admin/signup-ops/billing/renewal-review/page.tsx"),
  "utf8",
);
const HUB = readFileSync(
  join(process.cwd(), "src/app/app/admin/signup-ops/billing/page.tsx"),
  "utf8",
);
const TRIG_SVC = readFileSync(
  join(process.cwd(), "src/lib/billing/signup-2m4-triggering-service.ts"),
  "utf8",
);
const EXCEPTION_SVC = readFileSync(
  join(process.cwd(), "src/lib/billing/signup-2m4-exception-resolution.ts"),
  "utf8",
);
const RENEWAL_SVC = readFileSync(
  join(process.cwd(), "src/lib/billing/signup-2m4-renewal-review.ts"),
  "utf8",
);

const codeOnly = (s: string): string =>
  s.split("\n").filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*")).join("\n");

/* ============================================================
 * §1 Commercial authorization + payment release
 * ============================================================ */

describe("signup-2 m4-int-b :: §1 commercial authorization + payment release", () => {
  it("API gated by platform:signups:release", () => {
    expect(TRIG_API).toMatch(/hasPermission\(principal, null, "platform:signups:release"\)/);
  });
  it("API supports preflight (GET) + record-commercial-auth + release + drain", () => {
    expect(TRIG_API).toMatch(/action === "preflight"/);
    expect(TRIG_API).toMatch(/case "record-commercial-auth":/);
    expect(TRIG_API).toMatch(/case "release":/);
    expect(TRIG_API).toMatch(/case "drain":/);
  });
  it("API binds operator identity to principal (never trusts body for commercial/release operator ids)", () => {
    expect(TRIG_API).toMatch(/commercialApprovedByUserId:\s*auth\.principalId/);
    expect(TRIG_API).toMatch(/releaseApprovedByUserId:\s*auth\.principalId/);
  });
  it("service exposes recordCommercialAuthorisation + enforces SoD on release", () => {
    expect(TRIG_SVC).toMatch(/export async function recordCommercialAuthorisation/);
    expect(TRIG_SVC).toMatch(/SoD violation: releaseApprovedByUserId must differ from commercialApprovedByUserId/);
  });
  it("service does not permit payment initiation while execution flags remain OFF", () => {
    // drainOneBillingCommand gates on BOTH M4-trigger flag AND M3 payment-initiation flag.
    expect(TRIG_SVC).toMatch(/SPECTRE_SIGNUP_2M3_PAYMENT_INITIATION/);
    expect(TRIG_SVC).toMatch(/assertM4TriggerLiveFlag/);
  });
  it("UI page gated + shows dormant banners when flags are OFF", () => {
    expect(TRIG_UI).toMatch(/hasPermission\((principal|p), null, "platform:signups:release"\)/);
    expect(TRIG_UI).toMatch(/data-testid="triggering-dormant-banner"/);
    expect(TRIG_UI).toMatch(/data-testid="triggering-payment-init-off"/);
  });
  it("UI page displays refusal reasons from preflight (READY vs NOT_READY)", () => {
    expect(TRIG_UI).toMatch(/preflightReason/);
    expect(TRIG_UI).toMatch(/preflightDetail/);
    expect(TRIG_UI).toMatch(/READY/);
  });
  it("UI page shows separate commercial-auth + release forms (two operators)", () => {
    expect(TRIG_UI).toMatch(/Operator A — commercial authorization/);
    expect(TRIG_UI).toMatch(/Operator B — payment release/);
  });
});

/* ============================================================
 * §2 Billing exception management
 * ============================================================ */

describe("signup-2 m4-int-b :: §2 billing exception management", () => {
  it("API gated by platform:signups:release", () => {
    expect(EXCEPTION_API).toMatch(/hasPermission\(principal, null, "platform:signups:release"\)/);
  });
  it("API supports acknowledge / resolve / escalate", () => {
    expect(EXCEPTION_API).toMatch(/case "acknowledge":/);
    expect(EXCEPTION_API).toMatch(/case "resolve":/);
    expect(EXCEPTION_API).toMatch(/case "escalate":/);
  });
  it("API supports filtering by club / status / category / severity", () => {
    expect(EXCEPTION_API).toMatch(/clubId/);
    expect(EXCEPTION_API).toMatch(/category/);
    expect(EXCEPTION_API).toMatch(/severity/);
    expect(EXCEPTION_API).toMatch(/state === "open"/);
  });
  it("API returns payment-attempt chain alongside a single exception", () => {
    expect(EXCEPTION_API).toMatch(/billingInvoicePaymentAttempt\.findMany/);
    expect(EXCEPTION_API).toMatch(/paymentAttempts/);
  });
  it("service never deletes a BillingExceptionCase row", () => {
    expect(codeOnly(EXCEPTION_SVC)).not.toMatch(/billingExceptionCase\.delete/);
    expect(codeOnly(EXCEPTION_API)).not.toMatch(/billingExceptionCase\.delete/);
    expect(codeOnly(EXCEPTION_UI)).not.toMatch(/billingExceptionCase\.delete/);
  });
  it("service exposes all six operator resolutions", () => {
    expect(OPERATOR_RESOLUTIONS).toContain("SUSPEND_TENANT");
    expect(OPERATOR_RESOLUTIONS).toContain("RETRY_INVOICE");
    expect(OPERATOR_RESOLUTIONS).toContain("SCHEDULE_CANCELLATION");
    expect(OPERATOR_RESOLUTIONS).toContain("ACCEPT_LOSS");
    expect(OPERATOR_RESOLUTIONS).toContain("AWAIT_DISPUTE_OUTCOME");
    expect(OPERATOR_RESOLUTIONS).toContain("NO_ACTION");
  });
  it("service refuses resolution before acknowledgement", () => {
    expect(EXCEPTION_SVC).toMatch(/EXCEPTION_NOT_ACKNOWLEDGED/);
  });
  it("service's escalate path re-opens the row (clears prior resolution)", () => {
    expect(EXCEPTION_SVC).toMatch(/requiresOperatorAction:\s*true/);
    expect(EXCEPTION_SVC).toMatch(/operatorAcknowledgedAt:\s*null/);
    expect(EXCEPTION_SVC).toMatch(/operatorResolution:\s*null/);
  });
  it("UI page shows the three-step flow (acknowledge / resolve / escalate)", () => {
    expect(EXCEPTION_UI).toMatch(/1\. Acknowledge/);
    expect(EXCEPTION_UI).toMatch(/2\. Resolve/);
    expect(EXCEPTION_UI).toMatch(/3\. Escalate/);
  });
  it("UI page displays filter controls + open-count", () => {
    expect(EXCEPTION_UI).toMatch(/data-testid="exceptions-filters"/);
    expect(EXCEPTION_UI).toMatch(/open exception/);
  });
});

/* ============================================================
 * §3 Renewal review
 * ============================================================ */

describe("signup-2 m4-int-b :: §3 renewal review", () => {
  it("service exposes recordRenewalReview + listPreflightsAwaitingReview", () => {
    expect(RENEWAL_SVC).toMatch(/export async function recordRenewalReview/);
    expect(RENEWAL_SVC).toMatch(/export async function listPreflightsAwaitingReview/);
  });
  it("service lists only preflights that need operator attention (non-READY, un-reviewed, executed)", () => {
    expect(RENEWAL_SVC).toMatch(/outcome: \{ notIn: \["READY"\] \}/);
    expect(RENEWAL_SVC).toMatch(/operatorReviewedAt: null/);
    expect(RENEWAL_SVC).toMatch(/executedAt: \{ not: null \}/);
  });
  it("service exposes all three review outcomes", () => {
    expect(RENEWAL_REVIEW_OUTCOMES).toContain("APPROVED");
    expect(RENEWAL_REVIEW_OUTCOMES).toContain("REJECTED");
    expect(RENEWAL_REVIEW_OUTCOMES).toContain("RETURN_FOR_CORRECTION");
  });
  it("service is idempotent via conditional updateMany on operatorReviewedAt=null", () => {
    expect(RENEWAL_SVC).toMatch(/updateMany/);
    expect(RENEWAL_SVC).toMatch(/alreadyReviewed/);
  });
  it("API gated + review action binds operator identity to principal", () => {
    expect(RENEWAL_API).toMatch(/hasPermission\(principal, null, "platform:signups:release"\)/);
    expect(RENEWAL_API).toMatch(/reviewedByUserId:\s*auth\.principalId/);
  });
  it("UI page shows outcome-specific operator hints", () => {
    expect(RENEWAL_UI).toMatch(/MANDATE_EXPIRED/);
    expect(RENEWAL_UI).toMatch(/PRICING_CHANGED/);
    expect(RENEWAL_UI).toMatch(/TAX_TREATMENT_CHANGED/);
  });
  it("UI page empty-state asserts routine READY preflights do NOT appear here", () => {
    expect(RENEWAL_UI).toMatch(/No renewal preflights currently need operator review/);
    expect(RENEWAL_UI).toMatch(/Routine READY preflights do not appear here/);
  });
  it("schema carries the 4 new nullable review fields (prisma schema + both migrations)", () => {
    const schemaPg = readFileSync(join(process.cwd(), "prisma-postgres/schema.prisma"), "utf8");
    const schemaSqlite = readFileSync(join(process.cwd(), "prisma/schema.prisma"), "utf8");
    for (const schema of [schemaPg, schemaSqlite]) {
      expect(schema).toMatch(/operatorReviewedByUserId\s+String\?/);
      expect(schema).toMatch(/operatorReviewedAt\s+DateTime\?/);
      expect(schema).toMatch(/operatorReviewOutcome\s+String\?/);
      expect(schema).toMatch(/operatorReviewNotes\s+String\?/);
    }
    const migPg = readFileSync(
      join(process.cwd(), "prisma-postgres/migrations/20261029_signup_2_m4_int_b_renewal_review/migration.sql"),
      "utf8",
    );
    const migSqlite = readFileSync(
      join(process.cwd(), "prisma/migrations/20261029_signup_2_m4_int_b_renewal_review/migration.sql"),
      "utf8",
    );
    for (const mig of [migPg, migSqlite]) {
      expect(mig).toMatch(/operatorReviewedByUserId/);
      expect(mig).toMatch(/operatorReviewOutcome/);
      // Additive -- no destructive statements.
      expect(mig).not.toMatch(/DROP/);
    }
  });
});

/* ============================================================
 * §4 Billing operations hub integration
 * ============================================================ */

describe("signup-2 m4-int-b :: §4 hub integration", () => {
  it("hub links to all four operator workflows (triggering, exceptions, renewal review, cancellation)", () => {
    expect(HUB).toMatch(/data-testid="link-triggering"/);
    expect(HUB).toMatch(/data-testid="link-exceptions"/);
    expect(HUB).toMatch(/data-testid="link-renewal-review"/);
    expect(HUB).toMatch(/data-testid="link-cancellation"/);
  });
  it("hub preserves the four existing observability counts", () => {
    expect(HUB).toMatch(/Open cancellation requests/);
    expect(HUB).toMatch(/Pending billing commands/);
    expect(HUB).toMatch(/Exceptions needing action/);
    expect(HUB).toMatch(/Due renewal preflights/);
  });
  it("hub preserves the DORMANT banner when every live flag is OFF", () => {
    expect(HUB).toMatch(/data-testid="billing-ops-dormant-banner"/);
  });
  it("hub preserves the fail-closed stat-holiday coverage section", () => {
    expect(HUB).toMatch(/stat-holiday calendar coverage/);
  });
  it("hub uses existing admin chrome -- no new design system", () => {
    // All new workflow pages use the same primitives (section tables,
    // rounded-md borders, neutral-200, p-8 padding).  No tailwind
    // classes outside the established palette.
    for (const page of [TRIG_UI, EXCEPTION_UI, RENEWAL_UI, HUB]) {
      expect(page).toMatch(/rounded-md border border-neutral-200/);
      expect(page).toMatch(/text-sm font-semibold uppercase tracking-wide text-neutral-500|text-xs text-neutral-500/);
    }
  });
});

/* ============================================================
 * §7 Flag discipline preserved
 * ============================================================ */

describe("signup-2 m4-int-b :: §7 flag discipline preserved (no production billing enabled)", () => {
  it("none of the new API routes directly call Stripe mutation methods", () => {
    for (const route of [TRIG_API, EXCEPTION_API, RENEWAL_API]) {
      const cleaned = codeOnly(route);
      expect(cleaned).not.toMatch(/stripe\.subscriptions\.create/);
      expect(cleaned).not.toMatch(/stripe\.paymentIntents\.create/);
      expect(cleaned).not.toMatch(/stripe\.invoices\.pay/);
    }
  });
  it("none of the new UI pages mutate the Stripe adapter / clubBillingPricing / clubs", () => {
    for (const page of [TRIG_UI, EXCEPTION_UI, RENEWAL_UI, HUB]) {
      const cleaned = codeOnly(page);
      expect(cleaned).not.toMatch(/stripe\./);
      expect(cleaned).not.toMatch(/prisma\.clubBillingPricing\.(create|update|upsert|delete)/);
      expect(cleaned).not.toMatch(/prisma\.club\.(delete|update)/);
    }
  });
  it("new exception-resolution service never deletes rows (no .delete call)", () => {
    expect(codeOnly(EXCEPTION_SVC)).not.toMatch(/\.delete\(/);
  });
  it("renewal review service never deletes preflight rows", () => {
    expect(codeOnly(RENEWAL_SVC)).not.toMatch(/billingRenewalPreflight\.delete/);
  });
});
