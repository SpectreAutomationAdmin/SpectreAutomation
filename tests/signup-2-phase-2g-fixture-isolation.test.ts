// SIGNUP-2 Phase 2G (2026-10-26) -- Fixture harness isolation contract.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const FIXTURE = readFileSync(
  join(process.cwd(), "scripts/signup-2-phase-2b-staging-fixture.mjs"),
  "utf8",
);

describe("SIGNUP-2 Phase 2G · fixture harness surface", () => {
  it("declares the PHASE_2G_FIXTURE_PREFIX constant", () => {
    expect(FIXTURE).toMatch(/const PHASE_2G_FIXTURE_PREFIX = "signup-2g-fixture-"/);
  });
  it("declares three scenarios: happy, email-collision, slug-collision", () => {
    for (const scenario of ["happy", "email-collision", "slug-collision"]) {
      expect(FIXTURE).toContain(`"${scenario}":`);
    }
  });
  it("exposes seed / teardown / inspect / reverse / invalidate commands", () => {
    for (const cmd of [
      "phase2g-seed",
      "phase2g-teardown",
      "phase2g-inspect",
      "phase2g-reverse",
      "phase2g-invalidate",
    ]) {
      expect(FIXTURE).toContain(`"${cmd}"`);
    }
  });
  it("every fixture Club carries stagingDataMode = SYNTHETIC_DEMO", () => {
    const startIdx = FIXTURE.indexOf("async function phase2gSeed");
    const after = FIXTURE.slice(startIdx);
    const endRel = after.search(/\nasync function phase2gTeardown/);
    const seedFn = endRel === -1 ? after : after.slice(0, endRel);
    // Match prisma.club.create() with its nested data block, non-greedy
    // across lines until the matching close + closing paren.
    const clubCreates = seedFn.match(/prisma\.club\.create\(\{[\s\S]*?\}\s*,?\s*\}\)/g) ?? [];
    expect(clubCreates.length).toBeGreaterThan(0);
    for (const c of clubCreates) {
      expect(c).toMatch(/stagingDataMode: "SYNTHETIC_DEMO"/);
    }
  });
  it("every fixture Club slug is prefixed signup-2g-fixture-", () => {
    const seedFn = FIXTURE.match(/async function phase2gSeed[\s\S]+?^}/m)![0];
    expect(seedFn).toMatch(/\$\{PHASE_2G_FIXTURE_PREFIX\}/);
  });
  it("teardown deletes Users with the fixture email + strips UserClubRole + Session", () => {
    const td = FIXTURE.match(/async function phase2gTeardownScenario[\s\S]+?^}/m)![0];
    expect(td).toMatch(/prisma\.user\.findUnique/);
    expect(td).toMatch(/prisma\.userClubRole\.deleteMany/);
    expect(td).toMatch(/prisma\.session\.deleteMany/);
    expect(td).toMatch(/prisma\.user\.delete/);
  });
  it("teardown deletes BillingCycle, TenantProvisioningJob, ClubSubscription, Club", () => {
    const td = FIXTURE.match(/async function phase2gTeardownScenario[\s\S]+?^}/m)![0];
    for (const sub of [
      "tenantProvisioningJob.deleteMany",
      "paymentReconciliationEntry.deleteMany",
      "billingCycle.deleteMany",
      "clubSubscription.deleteMany",
      "club.deleteMany",
      "signupRegistration.deleteMany",
      "subscriptionPaymentMandate.deleteMany",
      "operatorVerificationRecord.deleteMany",
      "subscriptionAuthorisationAttestation.deleteMany",
    ]) {
      expect(td).toContain(sub);
    }
  });
});
