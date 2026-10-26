// SIGNUP-2 Phase 2G (2026-10-26) -- Concurrency + retry contract.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SERVICE = readFileSync(
  join(process.cwd(), "src/lib/billing/signup-2g-provisioning-service.ts"),
  "utf8",
);
const PHASE_2A = readFileSync(
  join(process.cwd(), "src/lib/billing/tenant-provisioning-workflow.ts"),
  "utf8",
);

describe("SIGNUP-2 Phase 2G · uses Phase 2A state machine for steps 1-8", () => {
  it("imports advanceOneStep + FORWARD_SEQUENCE from Phase 2A workflow", () => {
    expect(SERVICE).toMatch(/from "\.\/tenant-provisioning-workflow"/);
    expect(SERVICE).toMatch(/advanceOneStep,/);
    expect(SERVICE).toMatch(/FORWARD_SEQUENCE/);
  });
  it("Phase 2A retry policy is intact (not overridden)", () => {
    expect(PHASE_2A).toMatch(/RETRY_MAX_ATTEMPTS = 10/);
    expect(PHASE_2A).toMatch(/function nextRetryDelayMs/);
  });
});

describe("SIGNUP-2 Phase 2G · one active provisioning job per billing cycle", () => {
  it("TenantProvisioningJob.billingCycleId is unique (schema contract from Phase 2A)", () => {
    const schema = readFileSync(
      join(process.cwd(), "prisma-postgres/schema.prisma"),
      "utf8",
    );
    const block = schema.match(/model TenantProvisioningJob[\s\S]+?^}/m)![0];
    expect(block).toMatch(/billingCycleId\s+String\s+@unique/);
  });
});

describe("SIGNUP-2 Phase 2G · concurrent-worker safety", () => {
  it("advanceOneStep uses conditional updates with attempts increment", () => {
    expect(PHASE_2A).toMatch(/attempts:\s*\{\s*increment:\s*1\s*\}/);
    expect(PHASE_2A).toMatch(/startedAt:\s*job\.startedAt\s*\?\?/);
  });
  it("final-grant transaction re-reads BOTH BillingCycle AND Job state (TOCTOU defence)", () => {
    const final = SERVICE.match(/async function completeProvisioningAtomically[\s\S]+?^}/m)![0];
    expect(final).toMatch(/tx\.billingCycle\.findUnique/);
    expect(final).toMatch(/tx\.tenantProvisioningJob\.findUnique/);
    expect(final).toMatch(/jobRelock\.state !== "WELCOME_EMAIL_SENT"/);
  });
});

describe("SIGNUP-2 Phase 2G · idempotency anchors", () => {
  it("step 1 is idempotent via provisionedUserId", () => {
    const step = SERVICE.match(/async function stepUserCreated[\s\S]+?^}/m)![0];
    expect(step).toMatch(/job\?\.provisionedUserId/);
    expect(step).toMatch(/return \{ idempotencyAnchor: \{ provisionedUserId:/);
  });
  it("step 2 is idempotent via provisionedClubId", () => {
    const step = SERVICE.match(/async function stepClubCreated[\s\S]+?^}/m)![0];
    expect(step).toMatch(/job\?\.provisionedClubId/);
  });
  it("step 3 is idempotent via rolesAssignedBatchKey", () => {
    const step = SERVICE.match(/async function stepRolesAssigned[\s\S]+?^}/m)![0];
    expect(step).toMatch(/job\?\.rolesAssignedBatchKey/);
  });
  it("stub steps all stamp an anchor key", () => {
    const stub = SERVICE.match(/function makeStubStep[\s\S]+?^}/m)![0];
    expect(stub).toMatch(/idempotencyAnchor: \{ \[anchorField\]: batchKey \}/);
  });
});
