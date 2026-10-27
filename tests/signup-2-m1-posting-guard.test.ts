// SIGNUP-2 M1 (2026-10-26) -- Posting-guard tx + FOR UPDATE contract.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";

const POSTING_GUARD = readFileSync(
  join(process.cwd(), "src/lib/posting-guard/index.ts"),
  "utf8",
);
const ACCESS_TIER = readFileSync(
  join(process.cwd(), "src/lib/billing/access-tier.ts"),
  "utf8",
);
const PHASE_2H = readFileSync(
  join(process.cwd(), "src/lib/billing/signup-2h-tenant-lifecycle-service.ts"),
  "utf8",
);

describe("M1 · posting-guard tx-aware surface", () => {
  it("assertPostingAllowed accepts an opts.tx parameter", () => {
    expect(POSTING_GUARD).toMatch(/export async function assertPostingAllowed[\s\S]+?opts\?: \{ tx\?: MinimalTxClient \}/m);
  });
  it("withPostingGuard helper is exported + opens prisma.$transaction", () => {
    expect(POSTING_GUARD).toMatch(/export async function withPostingGuard</);
    expect(POSTING_GUARD).toMatch(/prisma\.\$transaction/);
  });
  it("withPostingGuard runs the guard INSIDE the tx (not before/after)", () => {
    const body = POSTING_GUARD.match(/export async function withPostingGuard[\s\S]+?^}/m)![0];
    const txIdx = body.indexOf("prisma.$transaction");
    const guardIdx = body.indexOf("assertPostingAllowed(");
    const workIdx = body.indexOf("work(tx)");
    expect(txIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeGreaterThan(txIdx);
    expect(workIdx).toBeGreaterThan(guardIdx);
  });
});

describe("M1 · access-tier gate uses SELECT ... FOR UPDATE when tx is passed", () => {
  it("evaluateAccessTierGate accepts opts.tx + runs tx.$queryRawUnsafe", () => {
    expect(ACCESS_TIER).toMatch(/async function evaluateAccessTierGate\(\s*clubId: string,\s*opts\?: \{/m);
    expect(ACCESS_TIER).toMatch(/opts\.tx\.\$queryRawUnsafe/);
  });
  it("the FOR UPDATE query targets ClubSubscription by clubId", () => {
    const block = ACCESS_TIER.match(/async function evaluateAccessTierGate[\s\S]+?^}/m)![0];
    expect(block).toMatch(/SELECT "accessTier", "subscriptionStatus"/);
    expect(block).toMatch(/FROM "ClubSubscription"/);
    expect(block).toMatch(/WHERE "clubId" = \$1/);
    expect(block).toMatch(/FOR UPDATE/);
  });
  it("Phase 2H blocks posting on SUSPENDED / UNDER_REVIEW / CANCELLED subscriptionStatus even if tier is FULL", () => {
    const block = ACCESS_TIER.match(/async function evaluateAccessTierGate[\s\S]+?^}/m)![0];
    // The branch that refuses on these three states explicitly.
    expect(block).toMatch(/subscriptionStatus === "UNDER_REVIEW"/);
    expect(block).toMatch(/subscriptionStatus === "SUSPENDED"/);
    expect(block).toMatch(/subscriptionStatus === "CANCELLED"/);
    expect(block).toMatch(/Phase 2H blocked/);
  });
  it("legacy tenant (subscriptionStatus=null) still grandfathers to PASS", () => {
    const block = ACCESS_TIER.match(/async function evaluateAccessTierGate[\s\S]+?^}/m)![0];
    expect(block).toMatch(/sub\.subscriptionStatus === null/);
    expect(block).toMatch(/legacy-grandfather-status-null/);
  });
});

describe("M1 · Phase 2H uses FOR UPDATE on suspend + reinstate reads", () => {
  it("suspendTenant upgrades the initial read to tx.$queryRawUnsafe + FOR UPDATE", () => {
    const body = PHASE_2H.match(/export async function suspendTenant[\s\S]+?^}/m)![0];
    expect(body).toMatch(/tx\.\$queryRawUnsafe/);
    expect(body).toMatch(/FOR UPDATE/);
  });
  it("reinstateTenant upgrades its inside-tx re-read likewise", () => {
    const bodyStart = PHASE_2H.indexOf("export async function reinstateTenant");
    const after = PHASE_2H.slice(bodyStart);
    const endRel = after.indexOf("export async function isTenantOperationallyActive");
    const body = endRel === -1 ? after : after.slice(0, endRel);
    expect(body).toMatch(/tx\.\$queryRawUnsafe/);
    expect(body).toMatch(/FOR UPDATE/);
  });
});

describe("M1 · call-site inventory (per founder §2 'complete route/worker migration inventory')", () => {
  // Enumerate every file that calls assertPostingAllowed and classify
  // by whether the file ALSO opens a prisma.$transaction (potentially
  // migrateable) or does NOT (needs route-level refactor).  This test
  // snapshots the current state; the acceptance doc tracks progress.
  function listPostingGuardCallers(): string[] {
    const out = execSync('grep -rlE "assertPostingAllowed\\b" src/', {
      encoding: "utf8",
      cwd: process.cwd(),
    });
    return out.split(/\r?\n/).filter((l) => l && !l.includes("access-tier.ts") && !l.includes("posting-guard/index.ts"));
  }

  it("the inventory stays below 55 call-sites (regression guard)", () => {
    const callers = listPostingGuardCallers();
    expect(callers.length).toBeLessThan(55);
  });
  it("every known caller is enumerated below (if this fails, add new sites to the acceptance doc inventory)", () => {
    const callers = new Set(listPostingGuardCallers().map((p) => p.replace(/\\/g, "/")));
    // The known enumerated callers at M1 ship time.  New callers
    // force an inventory update + a migration decision.
    const known = new Set<string>([
      "src/lib/accounting/journal.ts",
      "src/lib/announcements.ts",
      "src/lib/ap/invoices.ts",
      "src/lib/ap/payments.ts",
      "src/lib/club/media.ts",
      "src/lib/employee-portal/quick-links.ts",
      "src/lib/hr/allowances.ts",
      "src/lib/hr/compensation.ts",
      "src/lib/hr/employment-assignments.ts",
      "src/lib/hr/payroll-profile.ts",
      "src/lib/hr/sensitive-identity.ts",
      "src/lib/hr/training/assignments.ts",
      "src/lib/hr/training/courses.ts",
      "src/lib/hr/training/questions.ts",
      "src/lib/hr/training/video.ts",
      "src/lib/imports/index.ts",
      "src/lib/opening-balance/index.ts",
      "src/lib/ops/inventory.ts",
      "src/lib/payroll/approve-and-post.ts",
      "src/lib/payroll/approved-time.ts",
      "src/lib/payroll/batch-preparation.ts",
      "src/lib/payroll/batch-review.ts",
      "src/lib/payroll/benefit-enrolments.ts",
      "src/lib/payroll/benefit-plans.ts",
      "src/lib/payroll/club-config.ts",
      "src/lib/payroll/correction.ts",
      "src/lib/payroll/cpp-election.ts",
      "src/lib/payroll/department-approval.ts",
      "src/lib/payroll/freeze-service.ts",
      "src/lib/payroll/late-time-service.ts",
      "src/lib/payroll/opening-balance-import.ts",
      "src/lib/payroll/opening-balance.ts",
      "src/lib/payroll/pay-group-auto-assign.ts",
      "src/lib/payroll/pay-group-members.ts",
      "src/lib/payroll/pay-groups.ts",
      "src/lib/payroll/pay-periods.ts",
      "src/lib/payroll/return-payroll-batch.ts",
      "src/lib/payroll/return-to-preparation.ts",
      "src/lib/payroll/reversal.ts",
      "src/lib/payroll/scheduled-one-time-earning.ts",
      "src/lib/payroll/submit-payroll-batch.ts",
      "src/lib/payroll/zero-hours-acknowledgement.ts",
      "src/lib/permissions.ts",
      "src/lib/pos/checks.ts",
      "src/lib/pos/index.ts",
      "src/lib/pos/lounge.ts",
      "src/lib/services/ar.ts",
      "src/lib/signup/signup-service.ts",
      "src/lib/signup-2/registration-handler.ts",
      "src/lib/timesheets/manager-approval.ts",
      "src/lib/billing/signup-2h-tenant-lifecycle-service.ts",
      // M1b (2026-10-26) -- the per-caller inventory registry (not a
      // caller itself; references assertPostingAllowed in comments).
      "src/lib/posting-guard/legacy-callers.ts",
    ]);
    // The known set is a superset of the actual callers.  If a new
    // caller appears that isn't in `known`, the test fails: the
    // acceptance doc inventory must be updated.
    const unknown = [...callers].filter((c) => !known.has(c));
    expect(unknown).toEqual([]);
  });
});
