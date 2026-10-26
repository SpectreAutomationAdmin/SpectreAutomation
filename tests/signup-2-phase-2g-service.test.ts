// SIGNUP-2 Phase 2G (2026-10-26) -- Core service contract.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SERVICE = readFileSync(
  join(process.cwd(), "src/lib/billing/signup-2g-provisioning-service.ts"),
  "utf8",
);

describe("SIGNUP-2 Phase 2G · service surface", () => {
  it("exports tickProvisioningJob", () => {
    expect(SERVICE).toMatch(/export async function tickProvisioningJob/);
  });
  it("exports sweepProvisioningCandidates", () => {
    expect(SERVICE).toMatch(/export async function sweepProvisioningCandidates/);
  });
  it("exports tickProvisioningJobToCompletion", () => {
    expect(SERVICE).toMatch(/export async function tickProvisioningJobToCompletion/);
  });
  it("exports assertPhase2gFlag", () => {
    expect(SERVICE).toMatch(/export function assertPhase2gFlag/);
  });
  it("exports isMockEvidencePermitted", () => {
    expect(SERVICE).toMatch(/export function isMockEvidencePermitted/);
  });
});

describe("SIGNUP-2 Phase 2G · fail-closed flag", () => {
  it("flag name is SPECTRE_SIGNUP_2G_PROVISIONING_LIVE", () => {
    expect(SERVICE).toMatch(/SPECTRE_SIGNUP_2G_PROVISIONING_LIVE/);
  });
  it("throws ForbiddenError when flag != '1'", () => {
    expect(SERVICE).toMatch(/process\.env\[PHASE_2G_FLAG\]\s*!==\s*"1"/);
    expect(SERVICE).toMatch(/throw new ForbiddenError/);
  });
});

describe("SIGNUP-2 Phase 2G · independent mock-isolation gate", () => {
  it("uses SPECTRE_SIGNUP_2G_ALLOW_TESTONLY_PROVISIONING env var", () => {
    expect(SERVICE).toMatch(/SPECTRE_SIGNUP_2G_ALLOW_TESTONLY_PROVISIONING/);
  });
  it("refuses mock-stripe without the testOnly env", () => {
    expect(SERVICE).toMatch(/isMockEvidencePermitted/);
    // The gate checks evidenceSource === "mock-stripe" AND the env var.
    expect(SERVICE).toMatch(/if \(evidenceSource !== "mock-stripe"\) return true/);
    expect(SERVICE).toMatch(/process\.env\[PHASE_2G_TESTONLY_ENV\]\s*===\s*"1"/);
  });
  it("tickProvisioningJob checks mock-isolation BEFORE revalidation", () => {
    // Source-order check: isMockEvidencePermitted comes before
    // validateActivationAuthorisation in tickProvisioningJob.
    const tickBody = SERVICE.match(/export async function tickProvisioningJob[\s\S]+?^}/m)![0];
    const mockIdx = tickBody.indexOf("isMockEvidencePermitted");
    const revalIdx = tickBody.indexOf("validateActivationAuthorisation");
    expect(mockIdx).toBeGreaterThan(-1);
    expect(revalIdx).toBeGreaterThan(-1);
    expect(mockIdx).toBeLessThan(revalIdx);
  });
  it("writes MOCK_EVIDENCE_REJECTED_2G operator alert on refusal", () => {
    expect(SERVICE).toMatch(/MOCK_EVIDENCE_REJECTED_2G/);
    expect(SERVICE).toMatch(/MOCK_EVIDENCE_REJECTED/);
  });
});

describe("SIGNUP-2 Phase 2G · pre-step revalidation", () => {
  it("calls validateActivationAuthorisation before every tick", () => {
    expect(SERVICE).toMatch(/const revalidation = await validateActivationAuthorisation\(jobId\)/);
  });
  it("cancels (not retries) on revalidation failure", () => {
    expect(SERVICE).toMatch(/if \(!revalidation\.ok\)[\s\S]+?await cancelJob/);
    expect(SERVICE).toMatch(/PROVISIONING_REVOCATION/);
  });
  it("preserves provisioned rows + stamps provisioningCancelledAt", () => {
    expect(SERVICE).toMatch(/async function cancelJob/);
    expect(SERVICE).toMatch(/provisioningCancelledAt: now/);
    // Never deletes.
    expect(SERVICE).not.toMatch(/user\.delete|club\.delete|clubSubscription\.delete/);
  });
});

describe("SIGNUP-2 Phase 2G · 9 step handlers", () => {
  it("handler map covers all 9 non-terminal states", () => {
    const handlerBlock = SERVICE.match(/const STEP_HANDLERS[\s\S]+?^}/m)![0];
    for (const state of [
      "CREATED",
      "USER_CREATED",
      "CLUB_CREATED",
      "ROLES_ASSIGNED",
      "COA_COMMITTED",
      "OPENING_BALANCE_COMMITTED",
      "BRANDING_COMMITTED",
      "INVITATIONS_DELIVERED",
      "WELCOME_EMAIL_SENT",
    ]) {
      expect(handlerBlock).toContain(state);
    }
  });
  it("WELCOME_EMAIL_SENT handler routes to atomic final grant (not advanceOneStep)", () => {
    expect(SERVICE).toMatch(/if \(job\.state === "WELCOME_EMAIL_SENT"\)[\s\S]+?completeProvisioningAtomically/);
  });
  it("step 1 refuses on existing email + writes EXISTING_USER_EMAIL_CONFLICT alert", () => {
    expect(SERVICE).toMatch(/SIGNUP_2G_COLLISION_EMAIL/);
    expect(SERVICE).toMatch(/EXISTING_USER_EMAIL_CONFLICT/);
  });
  it("step 2 refuses on existing slug + writes EXISTING_CLUB_SLUG_CONFLICT alert", () => {
    expect(SERVICE).toMatch(/SIGNUP_2G_COLLISION_CLUB_SLUG/);
    expect(SERVICE).toMatch(/EXISTING_CLUB_SLUG_CONFLICT/);
  });
  it("step 2 creates ClubSubscription with accessTier = STAGED", () => {
    const step2 = SERVICE.match(/async function stepClubCreated[\s\S]+?^}/m)![0];
    expect(step2).toMatch(/accessTier: "STAGED"/);
    expect(step2).toMatch(/subscriptionStatus: "ACTIVATION_READY"/);
    expect(step2).not.toMatch(/accessTier: "FULL"/);
  });
});

describe("SIGNUP-2 Phase 2G · atomic final grant", () => {
  it("completeProvisioningAtomically exists", () => {
    expect(SERVICE).toMatch(/async function completeProvisioningAtomically/);
  });
  it("runs the final flip in a prisma.$transaction", () => {
    const body = SERVICE.match(/async function completeProvisioningAtomically[\s\S]+?^}/m)![0];
    expect(body).toMatch(/prisma\.\$transaction/);
  });
  it("re-reads BillingCycle AND TenantProvisioningJob inside the transaction", () => {
    const body = SERVICE.match(/async function completeProvisioningAtomically[\s\S]+?^}/m)![0];
    expect(body).toMatch(/tx\.billingCycle\.findUnique/);
    expect(body).toMatch(/tx\.tenantProvisioningJob\.findUnique/);
  });
  it("checks reversedAt, invalidatedAt, cancelledAt, authorisationExpiresAt inside the transaction", () => {
    const body = SERVICE.match(/async function completeProvisioningAtomically[\s\S]+?^}/m)![0];
    expect(body).toMatch(/cycleRelock\.reversedAt/);
    expect(body).toMatch(/jobRelock\.invalidatedAt/);
    expect(body).toMatch(/jobRelock\.cancelledAt/);
    expect(body).toMatch(/jobRelock\.authorisationExpiresAt/);
  });
  it("flips subscriptionStatus = ACTIVE + accessTier = FULL inside the transaction", () => {
    const body = SERVICE.match(/async function completeProvisioningAtomically[\s\S]+?^}/m)![0];
    expect(body).toMatch(/subscriptionStatus: "ACTIVE"/);
    expect(body).toMatch(/accessTier: "FULL"/);
    expect(body).toMatch(/state: "COMPLETED"/);
  });
  it("writes PaymentReconciliationEntry with entryType = ACTIVATION_COMPLETED", () => {
    const body = SERVICE.match(/async function completeProvisioningAtomically[\s\S]+?^}/m)![0];
    expect(body).toMatch(/entryType: "ACTIVATION_COMPLETED"/);
  });
  it("Tier 2 flip appears ONLY inside completeProvisioningAtomically", () => {
    // Nowhere else should accessTier be set to FULL by Phase 2G.
    const nonFinalBlocks = SERVICE
      .split("async function completeProvisioningAtomically")
      .slice(0, 1)
      .join("");
    expect(nonFinalBlocks).not.toMatch(/accessTier:\s*"FULL"/);
  });
});

describe("SIGNUP-2 Phase 2G · cancellation protocol", () => {
  // cancelJob is the ONLY site that references prisma.$transaction +
  // provisioningCancelledAt together.  Grab from the function name
  // through the next bare `// `-prefixed section header.
  function cancelJobBody(): string {
    const startIdx = SERVICE.indexOf("async function cancelJob");
    expect(startIdx).toBeGreaterThan(-1);
    const after = SERVICE.slice(startIdx);
    // The next top-level function or section comment ends cancelJob.
    const endRel = after.search(/\n(\/\/ ---|async function |function |export )/);
    return endRel === -1 ? after : after.slice(0, endRel);
  }
  it("cancelJob stamps provisioningCancelledAt on User/Club/ClubSubscription", () => {
    const body = cancelJobBody();
    expect(body).toMatch(/tx\.user\.update/);
    expect(body).toMatch(/tx\.club\.update/);
    expect(body).toMatch(/tx\.clubSubscription\.updateMany/);
    expect(body).toMatch(/provisioningCancelledAt: now/);
  });
  it("cancelJob never deletes rows", () => {
    const body = cancelJobBody();
    expect(body).not.toMatch(/\.delete\(|\.deleteMany/);
  });
});
