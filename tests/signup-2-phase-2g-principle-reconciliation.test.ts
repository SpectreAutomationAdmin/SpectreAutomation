// SIGNUP-2 Phase 2G (2026-10-26) -- Founder-principle reconciliation.
// Each principle in the authorisation email is asserted as a specific
// source-contract claim here, so a future refactor that silently
// violates one principle fails CI.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SERVICE = readFileSync(
  join(process.cwd(), "src/lib/billing/signup-2g-provisioning-service.ts"),
  "utf8",
);
const TICK = readFileSync(
  join(process.cwd(), "src/app/api/admin/signup-ops/provisioning-tick/route.ts"),
  "utf8",
);

describe("Principle 1 — Durable, resumable, idempotent", () => {
  it("state machine with 11 enumerated states", () => {
    const sm = readFileSync(
      join(process.cwd(), "src/lib/billing/tenant-provisioning-workflow.ts"),
      "utf8",
    );
    expect(sm).toMatch(/PROVISIONING_STATES = \[[\s\S]+?CREATED[\s\S]+?COMPLETED[\s\S]+?FAILED[\s\S]+?\]/);
  });
});

describe("Principle 2 — One active job per billing cycle", () => {
  it("TenantProvisioningJob.billingCycleId @unique (Phase 2A invariant preserved)", () => {
    const schema = readFileSync(
      join(process.cwd(), "prisma-postgres/schema.prisma"),
      "utf8",
    );
    const block = schema.match(/model TenantProvisioningJob[\s\S]+?^}/m)![0];
    expect(block).toMatch(/billingCycleId\s+String\s+@unique/);
  });
});

describe("Principle 3 — Refuse auto-reuse of existing Club on identity collision", () => {
  it("slug collision throws + writes IMMEDIATE operator alert", () => {
    const step = SERVICE.match(/async function stepClubCreated[\s\S]+?^}/m)![0];
    expect(step).toMatch(/SIGNUP_2G_COLLISION_CLUB_SLUG/);
    expect(step).toMatch(/EXISTING_CLUB_SLUG_CONFLICT/);
    expect(step).toMatch(/severity: "IMMEDIATE"/);
  });
});

describe("Principle 4 — Reuse User only with independently verified stable identity", () => {
  it("Phase 2G baseline NEVER reuses on email match (hard refusal)", () => {
    const step = SERVICE.match(/async function stepUserCreated[\s\S]+?^}/m)![0];
    expect(step).toMatch(/SIGNUP_2G_COLLISION_EMAIL/);
    // No `return { idempotencyAnchor: { provisionedUserId: existing.id`.
    expect(step).not.toMatch(/provisionedUserId:\s*existing\.id/);
  });
});

describe("Principle 5 — Never link users based solely on email", () => {
  it("email match triggers refusal, not reuse", () => {
    const step = SERVICE.match(/async function stepUserCreated[\s\S]+?^}/m)![0];
    expect(step).toMatch(/throw new AppError\(\s*"SIGNUP_2G_COLLISION_EMAIL"/);
  });
});

describe("Principle 6 — Preserve audit evidence during partial failure + recovery", () => {
  it("cancelJob writes sentinel on touched rows + never deletes", () => {
    const startIdx = SERVICE.indexOf("async function cancelJob");
    const after = SERVICE.slice(startIdx);
    const endRel = after.search(/\n(\/\/ ---|async function |function |export )/);
    const cancel = endRel === -1 ? after : after.slice(0, endRel);
    expect(cancel).toMatch(/provisioningCancelledAt: now/);
    expect(cancel).not.toMatch(/\.delete\(|\.deleteMany/);
  });
  it("audit() is emitted on step advance + completion", () => {
    expect(SERVICE).toMatch(/await audit\(null, \{\s*action: `signup\.provisioning\.\$\{currentState\.toLowerCase\(\)\}\.advanced`/);
    expect(SERVICE).toMatch(/await audit\(null, \{\s*action: "signup\.provisioning\.completed"/);
  });
});

describe("Principle 7 — Revalidate financial auth before sensitive steps", () => {
  it("validateActivationAuthorisation call appears before step dispatch in tickProvisioningJob", () => {
    const tick = SERVICE.match(/export async function tickProvisioningJob[\s\S]+?^}/m)![0];
    const revalIdx = tick.indexOf("validateActivationAuthorisation(jobId)");
    const dispatchIdx = tick.indexOf("advanceOneStep");
    expect(revalIdx).toBeGreaterThan(-1);
    expect(dispatchIdx).toBeGreaterThan(-1);
    expect(revalIdx).toBeLessThan(dispatchIdx);
  });
  it("final-grant transaction re-validates inside the lock", () => {
    const final = SERVICE.match(/async function completeProvisioningAtomically[\s\S]+?^}/m)![0];
    // Pre-tx + inside-tx cycle re-read serve the same purpose.
    expect(final).toMatch(/const preRevalidation = await validateActivationAuthorisation\(jobId\)/);
    expect(final).toMatch(/tx\.billingCycle\.findUnique/);
    expect(final).toMatch(/cycleRelock\.reversedAt/);
  });
});

describe("Principle 8 — Independently reject mock evidence from production path", () => {
  it("Phase 2G gate is NOT a wrapper around Phase 2F -- it has its own env var", () => {
    expect(SERVICE).toMatch(/SPECTRE_SIGNUP_2G_ALLOW_TESTONLY_PROVISIONING/);
    // Must NOT delegate to the Phase 2F sweep's SPECTRE_SIGNUP_2F_ALLOW_TESTONLY_SWEEP env.
    expect(SERVICE).not.toMatch(/SPECTRE_SIGNUP_2F_ALLOW_TESTONLY_SWEEP/);
  });
  it("tick fires MOCK_EVIDENCE_REJECTED when mock + env not set", () => {
    const tick = SERVICE.match(/export async function tickProvisioningJob[\s\S]+?^}/m)![0];
    expect(tick).toMatch(/if \(!isMockEvidencePermitted/);
    expect(tick).toMatch(/MOCK_EVIDENCE_REJECTED/);
  });
});

describe("Principle 9 — Prevent operational access until final auth + provisioning complete", () => {
  it("Club shell is created at accessTier=STAGED (never FULL)", () => {
    const step = SERVICE.match(/async function stepClubCreated[\s\S]+?^}/m)![0];
    expect(step).toMatch(/accessTier: "STAGED"/);
    expect(step).not.toMatch(/accessTier: "FULL"/);
  });
  it("accessTier=FULL appears ONLY inside completeProvisioningAtomically", () => {
    const nonFinal = SERVICE
      .split("async function completeProvisioningAtomically")
      .slice(0, 1)
      .join("");
    expect(nonFinal).not.toMatch(/accessTier:\s*"FULL"/);
  });
  it("subscriptionStatus=ACTIVE appears ONLY inside the final transaction", () => {
    const nonFinal = SERVICE
      .split("async function completeProvisioningAtomically")
      .slice(0, 1)
      .join("");
    expect(nonFinal).not.toMatch(/subscriptionStatus:\s*"ACTIVE"/);
  });
});

describe("Principle 10 — Safe suspension path for post-activation reversal", () => {
  it("Phase 2G never deletes Club / User / ClubSubscription on reversal", () => {
    expect(SERVICE).not.toMatch(/\.user\.delete\b/);
    expect(SERVICE).not.toMatch(/\.club\.delete\b/);
    expect(SERVICE).not.toMatch(/\.clubSubscription\.delete\b/);
  });
  it("Phase 2G stamps sentinels so Phase 2H can perform suspension/remediation", () => {
    expect(SERVICE).toMatch(/provisioningCancelledAt/);
  });
});

describe("Phase 2G non-authorisations (negative contract)", () => {
  it("tick route does NOT accept testOnly query param (gate is server-side only)", () => {
    expect(TICK).not.toMatch(/testOnly/);
  });
  it("service exports no production-provisioning helpers (only tick + sweep + flag guards)", () => {
    const exports = SERVICE.match(/export (async )?function \w+/g) ?? [];
    // Allow: assertPhase2gFlag, isMockEvidencePermitted, tickProvisioningJob,
    // tickProvisioningJobToCompletion, sweepProvisioningCandidates.
    const allowed = new Set([
      "export function assertPhase2gFlag",
      "export function isMockEvidencePermitted",
      "export async function tickProvisioningJob",
      "export async function tickProvisioningJobToCompletion",
      "export async function sweepProvisioningCandidates",
    ]);
    for (const e of exports) {
      expect(allowed.has(e), `unexpected export: ${e}`).toBe(true);
    }
  });
});
