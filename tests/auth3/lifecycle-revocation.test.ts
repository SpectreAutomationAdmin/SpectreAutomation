// AUTH-3B — lifecycle revocation atomic wiring.
//
// Proves that:
//   • terminateEmployee revokes every active EMPLOYEE Session inside
//     the same transaction as the lifecycle update.
//   • archiveEmployee does the same.
//   • The audit row for each event carries `meta.sessionsRevoked`.
//   • Unrelated updateEmployee edits do NOT revoke.
//   • The canonical revoker is scoped per-employee — the OTHER
//     employee's sessions in the same club are untouched.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { prisma } from "@/lib/prisma";
import { terminateEmployee, archiveEmployee, updateEmployee } from "@/lib/hr/employees";
import { createSession, SURFACE_EMPLOYEE } from "@/lib/services/session-store";
import { makeAdminHrFixture, latestAuditForAction } from "../hr/admin-workflows/_helpers";
import { makeEmployee } from "../hr/security-compliance/_helpers";
import { resetDb, seedRbac } from "../util/db";

describe("AUTH-3B · Employee lifecycle atomic revocation", () => {
  beforeAll(async () => { await resetDb(); await seedRbac(); });
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("terminateEmployee revokes every active EMPLOYEE Session in one transaction", async () => {
    const fx = await makeAdminHrFixture();
    // Two active sessions for the target employee.
    const s1 = await createSession({
      surface: SURFACE_EMPLOYEE,
      employeeId: fx.employee.id,
      clubId: fx.employee.clubId,
    });
    const s2 = await createSession({
      surface: SURFACE_EMPLOYEE,
      employeeId: fx.employee.id,
      clubId: fx.employee.clubId,
    });
    // A separate employee's session in the same club (must NOT be revoked).
    const otherEmp = await makeEmployee(fx.club.id, { firstName: "Other", lastName: "Person" });
    const other = await createSession({
      surface: SURFACE_EMPLOYEE,
      employeeId: otherEmp.id,
      clubId: fx.club.id,
    });

    await terminateEmployee(fx.clubAdmin, fx.employee.id, {
      terminationDate: new Date("2026-09-15"),
      reason: "auth3 test",
    });

    // Both target sessions revoked.
    const [r1, r2, ro] = await Promise.all([
      prisma.session.findUnique({ where: { id: s1.session.id }, select: { revokedAt: true, revokeReason: true, revokedBy: true } }),
      prisma.session.findUnique({ where: { id: s2.session.id }, select: { revokedAt: true, revokeReason: true, revokedBy: true } }),
      prisma.session.findUnique({ where: { id: other.session.id }, select: { revokedAt: true } }),
    ]);
    expect(r1?.revokedAt).not.toBeNull();
    expect(r2?.revokedAt).not.toBeNull();
    expect(r1?.revokeReason).toBe("lifecycle:terminate");
    expect(r2?.revokeReason).toBe("lifecycle:terminate");
    expect(r1?.revokedBy).toBe(fx.clubAdmin.id);
    // Other employee's session is untouched — canonical revoker is per-employee.
    expect(ro?.revokedAt).toBeNull();

    // Audit meta carries sessionsRevoked.
    const audit = await latestAuditForAction("hr.employee.terminate.post");
    expect(audit?.entityId).toBe(fx.employee.id);
    const meta = audit?.metaJson ? JSON.parse(audit.metaJson) : null;
    expect(meta?.sessionsRevoked).toBe(2);
    expect(meta?.reason).toBe("auth3 test");
  });

  it("archiveEmployee revokes every active EMPLOYEE Session in one transaction", async () => {
    const fx = await makeAdminHrFixture();
    const s1 = await createSession({
      surface: SURFACE_EMPLOYEE,
      employeeId: fx.employee.id,
      clubId: fx.employee.clubId,
    });

    await archiveEmployee(fx.clubAdmin, fx.employee.id, { reason: "auth3 archive test" });

    const r1 = await prisma.session.findUnique({
      where: { id: s1.session.id },
      select: { revokedAt: true, revokeReason: true },
    });
    expect(r1?.revokedAt).not.toBeNull();
    expect(r1?.revokeReason).toBe("lifecycle:archive");

    const audit = await latestAuditForAction("hr.employee.archive.update");
    const meta = audit?.metaJson ? JSON.parse(audit.metaJson) : null;
    expect(meta?.sessionsRevoked).toBe(1);
  });

  it("updateEmployee cosmetic edit does NOT revoke sessions", async () => {
    const fx = await makeAdminHrFixture();
    const s = await createSession({
      surface: SURFACE_EMPLOYEE,
      employeeId: fx.employee.id,
      clubId: fx.employee.clubId,
    });

    await updateEmployee(fx.clubAdmin, fx.employee.id, {
      preferredName: "River-Updated",
      mobilePhone: "555-9999",
    });

    const after = await prisma.session.findUnique({
      where: { id: s.session.id },
      select: { revokedAt: true },
    });
    expect(after?.revokedAt).toBeNull();
  });

  it("archiveEmployee is idempotent when already ARCHIVED — no new revoke pass", async () => {
    const fx = await makeAdminHrFixture();
    await archiveEmployee(fx.clubAdmin, fx.employee.id);
    // A NEW session issued after the archive would not normally happen
    // (portal auth would reject the ARCHIVED lifecycle), but we test the
    // idempotency at the service layer: repeat archive is a no-op and
    // does NOT revoke a hypothetical session.
    const s = await createSession({
      surface: SURFACE_EMPLOYEE,
      employeeId: fx.employee.id,
      clubId: fx.employee.clubId,
    });
    await archiveEmployee(fx.clubAdmin, fx.employee.id); // second call — early-return
    const after = await prisma.session.findUnique({
      where: { id: s.session.id },
      select: { revokedAt: true },
    });
    // Second archive returned early without touching the transaction —
    // this session stays valid.
    expect(after?.revokedAt).toBeNull();
  });
});
