// AUTH-3D.AUDIT-HOTFIX — platform-host failure audits must persist.
//
// Context: the employee-portal login action's failure branch used to
// pass `clubId: hostClubId ?? "platform"` to `audit()`. On the
// platform host (staging.spectreautomation.com), hostClubId is null
// and the fabricated string "platform" hit the AuditLog_clubId_fkey
// foreign key at write time. `audit()` swallows write errors by
// design (audit failures must never block legitimate work), so the
// failure row silently disappeared. Symptom during AUTH-3D Live Test
// B: the founder's fresh-login attempt for TERMINATED Taylor produced
// the correct neutral denial UX, but no `employee_portal.login.failure`
// audit row was persisted.
//
// Fix: pass `clubId: hostClubId ?? null`. AuditLog.clubId is nullable
// with the canonical comment "null = global / Spectre admin actions",
// which is the correct representation for a platform-level event.
//
// This suite guards both halves of the fix:
//   • the action's source no longer fabricates a "platform" clubId
//     and passes null instead;
//   • audit() with clubId=null actually persists (positive proof of
//     the invariant, run against Prisma);
//   • audit() with clubId="platform" fails FK silently (negative
//     regression demonstrating the pre-existing defect exists on the
//     schema level — this pins the defect to the wrong-clubId
//     parameter, not to the audit helper itself, so any future
//     contributor who reintroduces a fabricated-clubId pattern in
//     any other action gets a diagnosable failure here).

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import { resetDb, seedRbac, makeClub } from "../util/db";

const loginActionSrc = readFileSync(
  resolve(process.cwd(), "src/app/employee/_login-actions.ts"),
  "utf8",
);

describe("AUTH-3D.AUDIT-HOTFIX · source contract", () => {
  it("failure branch no longer fabricates a 'platform' clubId FK", () => {
    // Before the hotfix, the action passed `clubId: hostClubId ?? "platform"`
    // to `audit()`. That specific property-assignment shape must be gone.
    // Note: `${hostClubId ?? "platform"}` inside the rate-limit KEY (a
    // string, never a FK) is a DIFFERENT pattern and is intentionally
    // preserved — so we narrow the regex to the audit-property shape.
    expect(loginActionSrc).not.toMatch(/clubId:\s*hostClubId\s*\?\?\s*"platform"/);
    // Positive assertion: the failure branch passes null for platform-
    // host attempts, so audit() can persist the row against the
    // nullable AuditLog.clubId column.
    expect(loginActionSrc).toMatch(/clubId:\s*hostClubId\s*\?\?\s*null/);
  });

  it("the failure audit still fires for ineligible/not_recognised/ambiguous", () => {
    // Every failure kind must still route through the same audit +
    // neutral-redirect path. The hotfix touches ONLY the clubId
    // parameter — the surrounding branch structure and failure kinds
    // are preserved.
    expect(loginActionSrc).toMatch(/result\.kind === "not_recognised"/);
    expect(loginActionSrc).toMatch(/result\.kind === "ambiguous_across_clubs"/);
    expect(loginActionSrc).toMatch(/result\.kind === "ineligible"/);
    expect(loginActionSrc).toMatch(/action:\s*"employee_portal\.login\.failure"/);
    expect(loginActionSrc).toMatch(/failureKind:\s*result\.kind/);
  });

  it("the failure audit's entityId is still hash:<hashEmail(email)> (never raw email)", () => {
    expect(loginActionSrc).toMatch(/entityId:\s*`hash:\$\{hashEmail\(email\)\}`/);
  });

  it("the failure branch does NOT surface failureKind to the browser", () => {
    // failureKind lives ONLY inside meta (audit stream). It must NEVER
    // appear inside a `withErr(...)`, `redirect(...)`, or any string
    // that reaches the caller-visible response. Mentions in comments
    // (documenting the internal-only rule) are fine and expected.
    // Strip comments then scan for withErr/redirect argument shapes.
    const noComments = loginActionSrc
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    // Every withErr / redirect must NOT contain failureKind.
    const withErrCalls = noComments.match(/withErr\([^)]*\)/g) ?? [];
    for (const call of withErrCalls) {
      expect(call).not.toContain("failureKind");
    }
    const redirectCalls = noComments.match(/redirect\([^)]*\)/g) ?? [];
    for (const call of redirectCalls) {
      expect(call).not.toContain("failureKind");
    }
  });
});

describe("AUTH-3D.AUDIT-HOTFIX · audit() behaviour on platform-level events", () => {
  beforeAll(async () => { await resetDb(); await seedRbac(); });
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("audit(null, {clubId: null, ...}) persists a failure row (platform-level)", async () => {
    // The invariant this suite exists to guard.
    const before = await prisma.auditLog.count({
      where: { action: "employee_portal.login.failure" },
    });
    await audit(null, {
      action: "employee_portal.login.failure",
      entityType: "EmployeePortalCredential",
      entityId: "hash:test",
      clubId: null,
      meta: { failureKind: "ineligible" },
    });
    const after = await prisma.auditLog.count({
      where: { action: "employee_portal.login.failure" },
    });
    expect(after).toBe(before + 1);

    // And the persisted row's clubId is null (never "platform").
    const row = await prisma.auditLog.findFirst({
      where: { action: "employee_portal.login.failure", entityId: "hash:test" },
      select: { clubId: true, metaJson: true },
    });
    expect(row?.clubId).toBeNull();
    // meta still carries failureKind for operator observability.
    expect(JSON.parse(row?.metaJson ?? "{}").failureKind).toBe("ineligible");
  });

  it("audit(null, {clubId: 'platform', ...}) does NOT persist (documents the schema-level FK constraint that motivates this hotfix)", async () => {
    // This test pins the pre-existing defect at the schema level: a
    // fabricated non-Club-id string for clubId will fail the FK and
    // be silently swallowed by audit(). Any future contributor who
    // reintroduces the fabricated-clubId pattern gets a diagnosable
    // failure here.
    const before = await prisma.auditLog.count({
      where: { action: "audit-hotfix-negative-test" },
    });
    // audit() catches its own errors and never throws.
    await audit(null, {
      action: "audit-hotfix-negative-test",
      entityType: "EmployeePortalCredential",
      entityId: "hash:negative-test",
      clubId: "platform",  // fabricated string that fails the FK
      meta: {},
    });
    const after = await prisma.auditLog.count({
      where: { action: "audit-hotfix-negative-test" },
    });
    // The write silently fails. No row is persisted.
    expect(after).toBe(before);
  });

  it("audit(null, {clubId: <real Club id>, ...}) persists (tenant-scoped attempt)", async () => {
    // Sanity: a real Club id continues to persist correctly. This
    // guards the "successful eligible login continues to use the
    // employee's real Club ID" invariant from the founder brief.
    const club = await makeClub("AUDIT-HOTFIX Tenant");
    await audit(null, {
      action: "employee_portal.login.success",
      entityType: "EmployeePortalCredential",
      entityId: "some-employee-id",
      clubId: club.id,
      meta: {},
    });
    const row = await prisma.auditLog.findFirst({
      where: { action: "employee_portal.login.success", clubId: club.id },
      select: { clubId: true },
    });
    expect(row?.clubId).toBe(club.id);
  });
});
