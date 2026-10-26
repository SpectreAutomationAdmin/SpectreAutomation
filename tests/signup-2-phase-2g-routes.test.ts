// SIGNUP-2 Phase 2G (2026-10-26) -- HTTP route contract.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const TICK = readFileSync(
  join(process.cwd(), "src/app/api/admin/signup-ops/provisioning-tick/route.ts"),
  "utf8",
);
const DIAG = readFileSync(
  join(process.cwd(), "src/app/api/admin/signup-ops/provisioning/[jobId]/route.ts"),
  "utf8",
);

describe("SIGNUP-2 Phase 2G · provisioning-tick POST route", () => {
  it("super-admin gated", () => {
    expect(TICK).toMatch(/isSuperAdmin/);
    expect(TICK).toMatch(/status:\s*403/);
    expect(TICK).toMatch(/status:\s*401/);
  });
  it("supports both single-job (?jobId=) and sweep (no arg)", () => {
    expect(TICK).toMatch(/const jobId = url\.searchParams\.get\("jobId"\)/);
    expect(TICK).toMatch(/tickProvisioningJob/);
    expect(TICK).toMatch(/sweepProvisioningCandidates/);
  });
  it("fails closed via assertPhase2gFlag inside the service", () => {
    // The route itself delegates to the service; the service enforces
    // the flag.  We verify the route catches ForbiddenError.
    expect(TICK).toMatch(/if \(err instanceof ForbiddenError\)/);
    expect(TICK).toMatch(/status:\s*403/);
  });
  it("logs operator action + outcome", () => {
    expect(TICK).toMatch(/logger\.info.+signup\.provisioning\.tick_api/);
  });
});

describe("SIGNUP-2 Phase 2G · provisioning/[jobId] diagnostic GET", () => {
  it("super-admin gated + 401 on unauthenticated", () => {
    expect(DIAG).toMatch(/isSuperAdmin/);
    expect(DIAG).toMatch(/status:\s*403/);
    expect(DIAG).toMatch(/status:\s*401/);
  });
  it("read-only: never calls tickProvisioningJob or sweep", () => {
    // Match callsites (identifier + open paren), not comments.
    expect(DIAG).not.toMatch(/tickProvisioningJob\(|sweepProvisioningCandidates\(|completeProvisioningAtomically\(/);
  });
  it("returns the full set of job + idempotency anchors", () => {
    for (const field of [
      "state",
      "attempts",
      "authorisationEvidenceSource",
      "authorisationExpiresAt",
      "invalidatedAt",
      "provisionedUserId",
      "provisionedClubId",
      "rolesAssignedBatchKey",
      "committedCoaBatchKey",
      "welcomeEmailProviderMessageId",
    ]) {
      expect(DIAG).toContain(field);
    }
  });
  it("audits the diagnostic read", () => {
    expect(DIAG).toMatch(/logger\.info.+signup\.provisioning\.diagnostic_api/);
  });
});
