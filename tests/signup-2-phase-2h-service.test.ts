// SIGNUP-2 Phase 2H (2026-10-26) -- Core service contract.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SERVICE = readFileSync(
  join(process.cwd(), "src/lib/billing/signup-2h-tenant-lifecycle-service.ts"),
  "utf8",
);

function blockFromName(name: string): string {
  const startIdx = SERVICE.indexOf(name);
  const after = SERVICE.slice(startIdx);
  const endRel = after.search(/\n(\/\/ ---|async function |export async function |export function |function |interface |export interface )/);
  return endRel === -1 ? after : after.slice(0, endRel);
}

describe("SIGNUP-2 Phase 2H · service surface", () => {
  it("exports suspendTenant, reinstateTenant, isTenantOperationallyActive, assertTenantOperationallyActive, readTenantLifecycleTimeline", () => {
    expect(SERVICE).toMatch(/export async function suspendTenant/);
    expect(SERVICE).toMatch(/export async function reinstateTenant/);
    expect(SERVICE).toMatch(/export async function isTenantOperationallyActive/);
    expect(SERVICE).toMatch(/export async function assertTenantOperationallyActive/);
    expect(SERVICE).toMatch(/export async function readTenantLifecycleTimeline/);
  });
  it("exports fail-closed flag check", () => {
    expect(SERVICE).toMatch(/export function assertPhase2hFlag/);
    expect(SERVICE).toMatch(/SPECTRE_SIGNUP_2H_SUSPENSION_LIVE/);
  });
  it("declares six enumerated triggers", () => {
    for (const trig of [
      "PAD_RETURN",
      "PAYMENT_REVERSAL",
      "REFUND",
      "DISPUTE",
      "FAILED_RENEWAL",
      "OPERATOR_HOLD",
    ]) {
      expect(SERVICE).toContain(`"${trig}"`);
    }
  });
});

describe("SIGNUP-2 Phase 2H · state machine", () => {
  it("SUSPEND_TRANSITIONS enumerates permitted flips", () => {
    expect(SERVICE).toMatch(/ACTIVE:\s*new Set\(\["UNDER_REVIEW"\]\)/);
    expect(SERVICE).toMatch(/UNDER_REVIEW:\s*new Set\(\["SUSPENDED",\s*"CANCELLED"\]\)/);
    expect(SERVICE).toMatch(/SUSPENDED:\s*new Set\(\["CANCELLED"\]\)/);
  });
  it("REINSTATE_TRANSITIONS enumerates permitted flips", () => {
    expect(SERVICE).toMatch(/SUSPENDED:\s*new Set\(\["UNDER_REVIEW"\]\)/);
    expect(SERVICE).toMatch(/UNDER_REVIEW:\s*new Set\(\["ACTIVE"\]\)/);
  });
  it("STATUS_ACCESS_TIER maps states to access tiers", () => {
    expect(SERVICE).toMatch(/ACTIVE:\s*"FULL"/);
    expect(SERVICE).toMatch(/UNDER_REVIEW:\s*"SUSPENDED_READ_ONLY"/);
    expect(SERVICE).toMatch(/SUSPENDED:\s*"SUSPENDED_READ_ONLY"/);
    expect(SERVICE).toMatch(/CANCELLED:\s*"SUSPENDED_READ_ONLY"/);
  });
});

describe("SIGNUP-2 Phase 2H · existing-tenant protection (founder §5)", () => {
  it("suspendTenant refuses when subscriptionStatus === null", () => {
    const body = blockFromName("export async function suspendTenant");
    expect(body).toMatch(/sub\.subscriptionStatus === null/);
    expect(body).toMatch(/LEGACY_TENANT_PROTECTED/);
  });
  it("reinstateTenant refuses when subscriptionStatus === null", () => {
    const body = blockFromName("export async function reinstateTenant");
    expect(body).toMatch(/current\.subscriptionStatus === null/);
    expect(body).toMatch(/LEGACY_TENANT_PROTECTED/);
  });
  it("isTenantOperationallyActive treats subscriptionStatus=null as active", () => {
    const body = blockFromName("export async function isTenantOperationallyActive");
    expect(body).toMatch(/sub\.subscriptionStatus === null.+return true/s);
  });
});

describe("SIGNUP-2 Phase 2H · OPERATOR_HOLD evidence requirement", () => {
  it("rejects OPERATOR_HOLD without reasonCode or short reasonNotes", () => {
    const body = blockFromName("export async function suspendTenant");
    expect(body).toMatch(/args\.trigger === "OPERATOR_HOLD"/);
    expect(body).toMatch(/args\.reasonNotes\.length < 20/);
  });
});

describe("SIGNUP-2 Phase 2H · separation-of-duties on reinstatement", () => {
  it("SoD required only for UNDER_REVIEW -> ACTIVE", () => {
    const body = blockFromName("export async function reinstateTenant");
    expect(body).toMatch(/target === "ACTIVE".+args\.operatorUserId === args\.authoriserUserId/s);
    expect(body).toMatch(/SOD_VIOLATION/);
  });
  it("SUSPENDED -> UNDER_REVIEW is single-operator-OK", () => {
    const body = blockFromName("export async function reinstateTenant");
    // No SoD throw inside the SUSPENDED->UNDER_REVIEW branch; the
    // check is scoped to target === "ACTIVE" only.
    expect(body).not.toMatch(/target === "UNDER_REVIEW".+SOD_VIOLATION/s);
  });
});

describe("SIGNUP-2 Phase 2H · reinstatement eligibility (5 checks)", () => {
  it("evaluateReinstatementEligibility exists + inspects BillingCycle", () => {
    const body = blockFromName("async function evaluateReinstatementEligibility");
    expect(body).toMatch(/prisma\.billingCycle\.findFirst/);
    expect(body).toMatch(/latestCycle\.reversedAt !== null/);
    expect(body).toMatch(/LATEST_CYCLE_REVERSED/);
    expect(body).toMatch(/LATEST_CYCLE_NOT_HEALTHY/);
  });
  it("checks open disputes via StripeWebhookEvent", () => {
    const body = blockFromName("async function evaluateReinstatementEligibility");
    expect(body).toMatch(/prisma\.stripeWebhookEvent\.findMany/);
    expect(body).toMatch(/OPEN_DISPUTE/);
    expect(body).toMatch(/charge\.dispute\./);
  });
  it("checks attestation freshness", () => {
    const body = blockFromName("async function evaluateReinstatementEligibility");
    expect(body).toMatch(/prisma\.subscriptionAuthorisationAttestation\.findFirst/);
    expect(body).toMatch(/ATTESTATION_SUPERSEDED/);
  });
  it("ineligible attempt writes a lifecycle row with REINSTATEMENT_REFUSED_* reason", () => {
    const body = blockFromName("export async function reinstateTenant");
    expect(body).toMatch(/REINSTATEMENT_REFUSED_/);
    expect(body).toMatch(/REINSTATEMENT_INELIGIBLE/);
  });
});

describe("SIGNUP-2 Phase 2H · non-destructive invariant", () => {
  it("service NEVER deletes User / Club / ClubSubscription / BillingCycle", () => {
    expect(SERVICE).not.toMatch(/\bprisma\.user\.delete\b/);
    expect(SERVICE).not.toMatch(/\bprisma\.club\.delete\b/);
    expect(SERVICE).not.toMatch(/\bprisma\.clubSubscription\.delete\b/);
    expect(SERVICE).not.toMatch(/\bprisma\.billingCycle\.delete\b/);
    expect(SERVICE).not.toMatch(/\bprisma\.tenantLifecycleTransition\.delete\b/);
    expect(SERVICE).not.toMatch(/\btx\.user\.delete\b/);
    expect(SERVICE).not.toMatch(/\btx\.club\.delete\b/);
    expect(SERVICE).not.toMatch(/\btx\.clubSubscription\.delete\b/);
  });
});

describe("SIGNUP-2 Phase 2H · transaction + audit discipline", () => {
  it("suspend runs state flip inside prisma.$transaction", () => {
    const body = blockFromName("export async function suspendTenant");
    expect(body).toMatch(/prisma\.\$transaction/);
    expect(body).toMatch(/tx\.clubSubscription\.update/);
    expect(body).toMatch(/tx\.tenantLifecycleTransition\.create/);
  });
  it("reinstate runs state flip inside prisma.$transaction", () => {
    const body = blockFromName("export async function reinstateTenant");
    expect(body).toMatch(/prisma\.\$transaction/);
    expect(body).toMatch(/tx\.clubSubscription\.update/);
    expect(body).toMatch(/tx\.tenantLifecycleTransition\.create/);
  });
  it("reinstate re-reads subscription inside the tx (TOCTOU defence) [M1b: via tx.$queryRawUnsafe + FOR UPDATE]", () => {
    const body = blockFromName("export async function reinstateTenant");
    // M1b upgraded reads to `tx.$queryRawUnsafe` with `FOR UPDATE`.
    expect(body).toMatch(/tx\.\$queryRawUnsafe/);
    expect(body).toMatch(/FOR UPDATE/);
    expect(body).toMatch(/relock\.subscriptionStatus !== previousStatus/);
  });
  it("audit() is emitted on successful suspend + reinstate", () => {
    expect(SERVICE).toMatch(/await audit\(null, \{\s*action: "signup\.lifecycle\.suspend"/);
    expect(SERVICE).toMatch(/await audit\(null, \{\s*action: "signup\.lifecycle\.reinstate"/);
  });
});

describe("SIGNUP-2 Phase 2H · operational-active helper", () => {
  it("returns true for null subscription row (legacy)", () => {
    const body = blockFromName("export async function isTenantOperationallyActive");
    expect(body).toMatch(/if \(!sub\) return true/);
  });
  it("returns true only for ACTIVE + (FULL | null) tier", () => {
    const body = blockFromName("export async function isTenantOperationallyActive");
    expect(body).toMatch(/subscriptionStatus === "ACTIVE"/);
    expect(body).toMatch(/accessTier === "FULL" \|\| sub\.accessTier === null/);
  });
  it("throws via assertTenantOperationallyActive when not active", () => {
    const body = blockFromName("export async function assertTenantOperationallyActive");
    expect(body).toMatch(/ForbiddenError/);
  });
});
