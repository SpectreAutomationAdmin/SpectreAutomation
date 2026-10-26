// SIGNUP-2 Phase 2G (2026-10-26) -- Reversal / cancellation / sentinel
// contract.  Verifies the source-code shape of the compensation path
// so the DB-free CI run still catches regressions.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SERVICE = readFileSync(
  join(process.cwd(), "src/lib/billing/signup-2g-provisioning-service.ts"),
  "utf8",
);

describe("SIGNUP-2 Phase 2G · reversal handling across 5 windows", () => {
  it("pre-step revalidation routes to cancelJob (not retry)", () => {
    const tick = SERVICE.match(/export async function tickProvisioningJob[\s\S]+?^}/m)![0];
    expect(tick).toMatch(/const revalidation = await validateActivationAuthorisation/);
    expect(tick).toMatch(/if \(!revalidation\.ok\)[\s\S]+?await cancelJob/);
    expect(tick).toMatch(/REVALIDATION_FAILED/);
  });

  it("final-grant inside-tx revalidation routes to cancelJob", () => {
    const finalBlock = SERVICE.match(/async function completeProvisioningAtomically[\s\S]+?^}/m)![0];
    expect(finalBlock).toMatch(/if \(!txResult\.ok\)[\s\S]+?await cancelJob/);
  });

  it("post-COMPLETED reversal is NOT handled by Phase 2G destructively", () => {
    // Phase 2G must not delete rows on reversal; Phase 2H owns
    // suspension.  Verify no delete of Club/User/ClubSubscription
    // appears anywhere in the Phase 2G service.
    expect(SERVICE).not.toMatch(/\bprisma\.user\.delete\b/);
    expect(SERVICE).not.toMatch(/\bprisma\.club\.delete\b/);
    expect(SERVICE).not.toMatch(/\bprisma\.clubSubscription\.delete\b/);
    expect(SERVICE).not.toMatch(/tx\.user\.delete\b/);
    expect(SERVICE).not.toMatch(/tx\.club\.delete\b/);
    expect(SERVICE).not.toMatch(/tx\.clubSubscription\.delete\b/);
  });

  it("cancellation preserves data by stamping sentinel (never deleting)", () => {
    const startIdx = SERVICE.indexOf("async function cancelJob");
    const after = SERVICE.slice(startIdx);
    const endRel = after.search(/\n(\/\/ ---|async function |function |export )/);
    const cancel = endRel === -1 ? after : after.slice(0, endRel);
    expect(cancel).toMatch(/provisioningCancelledAt: now/);
    expect(cancel).not.toMatch(/\.delete\(|\.deleteMany/);
  });
});

describe("SIGNUP-2 Phase 2G · sentinel is read, not deleted, on resumption", () => {
  it("final-grant checks ClubSubscription.provisioningCancelledAt before activating", () => {
    const final = SERVICE.match(/async function completeProvisioningAtomically[\s\S]+?^}/m)![0];
    expect(final).toMatch(/provisioningCancelledAt: true/);
    expect(final).toMatch(/sub\.provisioningCancelledAt/);
  });
});

describe("SIGNUP-2 Phase 2G · operator alert categories", () => {
  it("emits the 7 Phase 2G alert categories", () => {
    for (const category of [
      "PROVISIONING_STUCK",
      "EXISTING_USER_EMAIL_CONFLICT",
      "EXISTING_CLUB_SLUG_CONFLICT",
      "EXISTING_SUBSCRIPTION_CONFLICT",
      "PROVISIONING_REVOCATION",
      "MOCK_EVIDENCE_REJECTED_2G",
      "PROVISIONING_COMPLETED",
    ]) {
      expect(SERVICE).toContain(category);
    }
  });
});
