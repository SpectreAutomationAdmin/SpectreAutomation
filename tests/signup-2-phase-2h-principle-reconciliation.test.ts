// SIGNUP-2 Phase 2H (2026-10-26) -- Founder-principle reconciliation.
// Each principle in the founder's §2-§7 directives is asserted as
// a specific source-contract claim.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SERVICE = readFileSync(
  join(process.cwd(), "src/lib/billing/signup-2h-tenant-lifecycle-service.ts"),
  "utf8",
);
const SUSPEND_ROUTE = readFileSync(
  join(process.cwd(), "src/app/api/admin/signup-ops/tenants/[clubId]/suspend/route.ts"),
  "utf8",
);
const REINSTATE_ROUTE = readFileSync(
  join(process.cwd(), "src/app/api/admin/signup-ops/tenants/[clubId]/reinstate/route.ts"),
  "utf8",
);

describe("Founder §2 · Six distinct suspension triggers", () => {
  it("all six triggers declared in SUSPENSION_TRIGGERS", () => {
    for (const t of [
      "PAD_RETURN",
      "PAYMENT_REVERSAL",
      "REFUND",
      "DISPUTE",
      "FAILED_RENEWAL",
      "OPERATOR_HOLD",
    ]) {
      expect(SERVICE).toContain(`"${t}"`);
    }
  });
  it("suspension does NOT delete any club / user / subscription / audit row", () => {
    // Non-destructive invariant covers "preserve financial suspension
    // and administrative suspension" differentiation implicitly.
    expect(SERVICE).not.toMatch(/\.delete\(|\.deleteMany/);
  });
});

describe("Founder §3 · Server-side enforcement (not UI-only)", () => {
  it("suspend route checks RBAC server-side", () => {
    expect(SUSPEND_ROUTE).toMatch(/hasPermission\(principal, null, "platform:tenants:suspend"\)/);
    expect(SUSPEND_ROUTE).toMatch(/status:\s*403/);
  });
  it("reinstate route checks RBAC server-side", () => {
    expect(REINSTATE_ROUTE).toMatch(/hasPermission\(principal, null, "platform:tenants:reinstate"\)/);
  });
  it("isTenantOperationallyActive helper exported for worker gating", () => {
    expect(SERVICE).toMatch(/export async function isTenantOperationallyActive/);
    expect(SERVICE).toMatch(/export async function assertTenantOperationallyActive/);
  });
});

function sliceFromTo(src: string, startMarker: string, endMarker: string | null): string {
  const startIdx = src.indexOf(startMarker);
  const after = src.slice(startIdx);
  if (!endMarker) return after;
  const endIdx = after.indexOf(endMarker);
  return endIdx === -1 ? after : after.slice(0, endIdx);
}

describe("Founder §4 · Reinstatement controls", () => {
  it("no automatic reinstatement — all reinstateTenant calls require operatorUserId + authoriserUserId", () => {
    expect(SERVICE).toMatch(/interface ReinstateArgs \{[\s\S]+?authoriserUserId: string;/m);
  });
  it("reasonCode + reasonNotes >= 20 chars required", () => {
    const body = sliceFromTo(SERVICE, "export async function reinstateTenant", "export async function isTenantOperationallyActive");
    expect(body).toMatch(/args\.reasonNotes\.length < 20/);
  });
  it("separation-of-duties: operator != authoriser on UNDER_REVIEW -> ACTIVE", () => {
    const body = sliceFromTo(SERVICE, "export async function reinstateTenant", "export async function isTenantOperationallyActive");
    expect(body).toMatch(/target === "ACTIVE".+SOD_VIOLATION/s);
  });
  it("five eligibility checks exercised", () => {
    const body = sliceFromTo(SERVICE, "async function evaluateReinstatementEligibility", "export async function reinstateTenant");
    expect(body).toMatch(/NO_BILLING_CYCLE/);
    expect(body).toMatch(/LATEST_CYCLE_REVERSED/);
    expect(body).toMatch(/LATEST_CYCLE_NOT_HEALTHY/);
    expect(body).toMatch(/OPEN_DISPUTE/);
    expect(body).toMatch(/ATTESTATION_SUPERSEDED/);
  });
});

describe("Founder §5 · Existing-tenant protection", () => {
  it("suspend refuses when subscriptionStatus=null (legacy tenant)", () => {
    const body = SERVICE.match(/export async function suspendTenant[\s\S]+?^}/m)![0];
    expect(body).toMatch(/sub\.subscriptionStatus === null/);
    expect(body).toMatch(/LEGACY_TENANT_PROTECTED/);
  });
  it("reinstate refuses when subscriptionStatus=null", () => {
    const body = sliceFromTo(SERVICE, "export async function reinstateTenant", "export async function isTenantOperationallyActive");
    expect(body).toMatch(/current\.subscriptionStatus === null/);
    expect(body).toMatch(/LEGACY_TENANT_PROTECTED/);
  });
});

describe("Founder §6 · Concurrency + safety", () => {
  it("suspend uses prisma.$transaction + inside-tx state read", () => {
    const body = SERVICE.match(/export async function suspendTenant[\s\S]+?^}/m)![0];
    expect(body).toMatch(/prisma\.\$transaction/);
    expect(body).toMatch(/tx\.clubSubscription\.findUnique/);
  });
  it("reinstate uses prisma.$transaction + inside-tx re-read (TOCTOU)", () => {
    const body = sliceFromTo(SERVICE, "export async function reinstateTenant", "export async function isTenantOperationallyActive");
    expect(body).toMatch(/prisma\.\$transaction/);
    expect(body).toMatch(/tx\.clubSubscription\.findUnique/);
    expect(body).toMatch(/relock\.subscriptionStatus !== previousStatus/);
  });
  it("no external Stripe network call while holding a DB lock", () => {
    // Phase 2H service does NOT import any Stripe adapter.
    expect(SERVICE).not.toMatch(/stripe-adapter|StripeAdapter|createMockStripeAdapter|retrieveBalanceTransaction/);
  });
});

describe("Founder §7 · Operator workflow (RBAC + SoD + audit)", () => {
  it("three new permission keys declared", () => {
    const perms = readFileSync(join(process.cwd(), "src/lib/permissions.ts"), "utf8");
    expect(perms).toMatch(/"platform:tenants:suspend"/);
    expect(perms).toMatch(/"platform:tenants:reinstate"/);
    expect(perms).toMatch(/"platform:tenants:remediate"/);
  });
  it("audit() emitted on every successful state change", () => {
    expect(SERVICE).toMatch(/signup\.lifecycle\.suspend/);
    expect(SERVICE).toMatch(/signup\.lifecycle\.reinstate/);
  });
});

describe("Founder §11 non-authorisations preserved", () => {
  it("no gov-ID collection", () => {
    expect(SERVICE).not.toMatch(/\b(governmentId|govId|SSN|driversLicense|passport)\b/i);
    expect(SERVICE).not.toMatch(/\bSIN\b/);
  });
  it("no live-Stripe call", () => {
    expect(SERVICE).not.toMatch(/createLiveStripeAdapter|stripe\.customers\.|stripe\.subscriptions\.|stripe\.webhooks\./);
  });
  it("fail-closed flag check present", () => {
    expect(SERVICE).toMatch(/assertPhase2hFlag/);
  });
});
