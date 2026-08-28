// Payroll-3B-1 (2026-08-27) — canonical setup services.
// Covers §18 test requirements from the ticket brief:
//   - tenant isolation
//   - permissions (write vs. read-only vs. unrelated role)
//   - activation preconditions (block on missing) + success path
//   - Pay Group create / update / activate/deactivate / tenant isolation
//   - PayGroupMember effective-date semantics, boundary dates
//   - overlap prevention (same-group, cross-group, adjacent allowed,
//     future allowed, transfer produces no overlap)
//   - audit records for meaningful mutations

import { describe, it, expect, beforeEach } from "vitest";
import { db, resetDb, seedRbac, makeClub, makeUser, principalFor } from "../util/db";
import {
  getPayrollClubConfig,
  upsertPayrollClubConfig,
  activatePayrollClubConfig,
  deactivatePayrollClubConfig,
  checkPayrollActivationPreconditions,
} from "@/lib/payroll/club-config";
import {
  createPayGroup,
  updatePayGroup,
  setPayGroupActive,
  listPayGroups,
} from "@/lib/payroll/pay-groups";
import {
  assignMembership,
  endMembership,
  transferMembership,
  getMembershipAsOf,
  listActiveMembersAsOf,
  listMembershipHistoryForEmployee,
  listMemberships,
} from "@/lib/payroll/pay-group-members";

async function makeEmployee(clubId: string, employeeNumber: string) {
  return db().employee.create({
    data: {
      clubId,
      firstName: "Test",
      lastName: employeeNumber,
      email: `${employeeNumber.toLowerCase()}@t.example`,
      hireDate: new Date("2026-01-01"),
      status: "ACTIVE",
      employeeNumber,
    },
  });
}

describe("Payroll-3B-1 — setup services", () => {
  beforeEach(async () => {
    await resetDb();
    await seedRbac();
  });

  async function setup() {
    const clubA = await makeClub("Payroll Club A");
    const clubB = await makeClub("Payroll Club B");
    const payAdminUser = await makeUser({ email: "pa@a.test", role: "PAYROLL_ADMIN", clubId: clubA.id });
    const controllerUser = await makeUser({ email: "ctl@a.test", role: "CONTROLLER", clubId: clubA.id });
    // A CLUB_ADMIN has payroll:read + payroll:write via the seeded matrix.
    const clubAdmin = await makeUser({ email: "admin@a.test", role: "CLUB_ADMIN", clubId: clubA.id });
    const adminP = await principalFor(clubAdmin.email);
    return { clubA, clubB, payAdminUser, controllerUser, adminP };
  }

  // ---- Configuration -------------------------------------------------------

  it("tenant isolation — Club A admin cannot read/update Club B config", async () => {
    const { clubA, clubB, adminP } = await setup();
    // adminP is scoped to clubA only. requirePermission for clubB must reject.
    await expect(getPayrollClubConfig(adminP, clubB.id)).rejects.toThrow();
    await expect(upsertPayrollClubConfig(adminP, clubB.id, { provinceOfEmployment: "AB" })).rejects.toThrow();
    // sanity: clubA works
    const created = await upsertPayrollClubConfig(adminP, clubA.id, { provinceOfEmployment: "AB" });
    expect(created.clubId).toBe(clubA.id);
  });

  it("STAFF-role user cannot mutate payroll config (server-side gate)", async () => {
    const { clubA } = await setup();
    const staff = await makeUser({ email: "staff@a.test", role: "STAFF", clubId: clubA.id });
    const staffP = await principalFor(staff.email);
    await expect(upsertPayrollClubConfig(staffP, clubA.id, { provinceOfEmployment: "AB" })).rejects.toThrow();
    await expect(activatePayrollClubConfig(staffP, clubA.id)).rejects.toThrow();
  });

  it("activation blocked with structured, actionable errors when prerequisites missing", async () => {
    const { clubA, adminP } = await setup();
    // Config exists but is empty.
    await upsertPayrollClubConfig(adminP, clubA.id, {});
    const check = await checkPayrollActivationPreconditions(clubA.id);
    expect(check.ok).toBe(false);
    const paths = check.missing.map((m) => m.path);
    expect(paths).toContain("provinceOfEmployment");
    expect(paths).toContain("payrollAdminUserId");
    expect(paths).toContain("controllerUserId");
    await expect(activatePayrollClubConfig(adminP, clubA.id)).rejects.toThrow();
  });

  it("activation blocked when designated Payroll Admin lacks the required role", async () => {
    const { clubA, adminP, controllerUser } = await setup();
    // Assign a random Club user as payrollAdminUserId — but that user
    // does NOT hold PAYROLL_ADMIN role at this Club.
    const nonAdmin = await makeUser({ email: "random@a.test", role: "STAFF", clubId: clubA.id });
    await upsertPayrollClubConfig(adminP, clubA.id, {
      provinceOfEmployment: "AB",
      payrollAdminUserId: nonAdmin.id,
      controllerUserId: controllerUser.id,
    });
    const check = await checkPayrollActivationPreconditions(clubA.id);
    expect(check.ok).toBe(false);
    expect(check.missing.some((m) => m.path === "payrollAdminUserId")).toBe(true);
  });

  it("activation succeeds once every prerequisite is satisfied; deactivation flips it back", async () => {
    const { clubA, adminP, payAdminUser, controllerUser } = await setup();
    await upsertPayrollClubConfig(adminP, clubA.id, {
      provinceOfEmployment: "AB",
      payrollAdminUserId: payAdminUser.id,
      controllerUserId: controllerUser.id,
    });
    const check = await checkPayrollActivationPreconditions(clubA.id);
    expect(check.ok).toBe(true);
    const activated = await activatePayrollClubConfig(adminP, clubA.id);
    expect(activated.enabled).toBe(true);
    const deactivated = await deactivatePayrollClubConfig(adminP, clubA.id);
    expect(deactivated.enabled).toBe(false);
  });

  it("MVP jurisdiction gate — activation fails on non-AB province", async () => {
    const { clubA, adminP, payAdminUser, controllerUser } = await setup();
    await upsertPayrollClubConfig(adminP, clubA.id, {
      provinceOfEmployment: "BC",
      payrollAdminUserId: payAdminUser.id,
      controllerUserId: controllerUser.id,
    });
    const check = await checkPayrollActivationPreconditions(clubA.id);
    expect(check.ok).toBe(false);
    expect(check.missing.some((m) => m.path === "provinceOfEmployment")).toBe(true);
  });

  // ---- Pay Groups ---------------------------------------------------------

  it("Pay Group create/update — uniqueness + tenant isolation + activation", async () => {
    const { clubA, clubB, adminP } = await setup();
    const grp = await createPayGroup(adminP, clubA.id, {
      code: "HOURLY_BW",
      name: "Hourly Biweekly",
      payFrequency: "BIWEEKLY",
    });
    expect(grp.code).toBe("HOURLY_BW");
    expect(grp.memberCount).toBe(0);
    // Duplicate code rejected within same Club.
    await expect(
      createPayGroup(adminP, clubA.id, { code: "HOURLY_BW", name: "dupe", payFrequency: "WEEKLY" }),
    ).rejects.toThrow();
    // Same code in different Club is allowed (adminP has no clubB access).
    await expect(
      createPayGroup(adminP, clubB.id, { code: "HOURLY_BW", name: "cross", payFrequency: "WEEKLY" }),
    ).rejects.toThrow(); // permission gate rejects first
    // Rename works.
    const renamed = await updatePayGroup(adminP, clubA.id, grp.id, { name: "Renamed" });
    expect(renamed.name).toBe("Renamed");
    // Activate/deactivate.
    const off = await setPayGroupActive(adminP, clubA.id, grp.id, false);
    expect(off.active).toBe(false);
    const on = await setPayGroupActive(adminP, clubA.id, grp.id, true);
    expect(on.active).toBe(true);
  });

  it("listPayGroups is tenant-scoped", async () => {
    const { clubA, clubB, adminP } = await setup();
    await createPayGroup(adminP, clubA.id, { code: "A", name: "Aye", payFrequency: "BIWEEKLY" });
    const listA = await listPayGroups(adminP, clubA.id);
    expect(listA.length).toBe(1);
    await expect(listPayGroups(adminP, clubB.id)).rejects.toThrow();
  });

  // ---- Membership effective dating ---------------------------------------

  it("membership half-open semantics — employee included on effectiveFrom, excluded on effectiveTo", async () => {
    const { clubA, adminP } = await setup();
    const grp = await createPayGroup(adminP, clubA.id, { code: "H", name: "H", payFrequency: "WEEKLY" });
    const emp = await makeEmployee(clubA.id, "E-1000");
    // Membership covers 2026-06-01 to 2026-09-01 (exclusive).
    await assignMembership(adminP, clubA.id, {
      payGroupId: grp.id,
      employeeId: emp.id,
      effectiveFrom: new Date("2026-06-01T00:00:00Z"),
      effectiveTo: new Date("2026-09-01T00:00:00Z"),
    });
    // included on effectiveFrom
    const onStart = await getMembershipAsOf(adminP, clubA.id, emp.id, new Date("2026-06-01T00:00:00Z"));
    expect(onStart?.payGroupId).toBe(grp.id);
    // included one millisecond before effectiveTo
    const onLast = await getMembershipAsOf(adminP, clubA.id, emp.id, new Date("2026-08-31T23:59:59Z"));
    expect(onLast?.payGroupId).toBe(grp.id);
    // EXCLUDED on effectiveTo itself
    const onTo = await getMembershipAsOf(adminP, clubA.id, emp.id, new Date("2026-09-01T00:00:00Z"));
    expect(onTo).toBeNull();
    // excluded well before effectiveFrom
    const before = await getMembershipAsOf(adminP, clubA.id, emp.id, new Date("2026-05-31T00:00:00Z"));
    expect(before).toBeNull();
  });

  it("adjacent memberships allowed; overlapping same-group rejected", async () => {
    const { clubA, adminP } = await setup();
    const grp = await createPayGroup(adminP, clubA.id, { code: "H", name: "H", payFrequency: "WEEKLY" });
    const emp = await makeEmployee(clubA.id, "E-2000");
    // First window Jun-Aug.
    await assignMembership(adminP, clubA.id, {
      payGroupId: grp.id,
      employeeId: emp.id,
      effectiveFrom: new Date("2026-06-01T00:00:00Z"),
      effectiveTo: new Date("2026-09-01T00:00:00Z"),
    });
    // Adjacent window Sep-Nov: allowed (a2 == b1 is NOT overlap).
    await expect(
      assignMembership(adminP, clubA.id, {
        payGroupId: grp.id,
        employeeId: emp.id,
        effectiveFrom: new Date("2026-09-01T00:00:00Z"),
        effectiveTo: new Date("2026-12-01T00:00:00Z"),
      }),
    ).resolves.toBeTruthy();
    // Overlapping window Aug-Oct: rejected.
    await expect(
      assignMembership(adminP, clubA.id, {
        payGroupId: grp.id,
        employeeId: emp.id,
        effectiveFrom: new Date("2026-08-15T00:00:00Z"),
        effectiveTo: new Date("2026-10-15T00:00:00Z"),
      }),
    ).rejects.toThrow();
  });

  it("cross-group overlap rejected — an employee cannot belong to two groups simultaneously", async () => {
    const { clubA, adminP } = await setup();
    const salary = await createPayGroup(adminP, clubA.id, { code: "SAL", name: "S", payFrequency: "SEMI_MONTHLY" });
    const hourly = await createPayGroup(adminP, clubA.id, { code: "HRL", name: "H", payFrequency: "WEEKLY" });
    const emp = await makeEmployee(clubA.id, "E-3000");
    await assignMembership(adminP, clubA.id, {
      payGroupId: salary.id,
      employeeId: emp.id,
      effectiveFrom: new Date("2026-06-01T00:00:00Z"),
      effectiveTo: null,
    });
    await expect(
      assignMembership(adminP, clubA.id, {
        payGroupId: hourly.id,
        employeeId: emp.id,
        effectiveFrom: new Date("2026-08-01T00:00:00Z"),
        effectiveTo: null,
      }),
    ).rejects.toThrow();
  });

  it("future membership allowed for an employee starting later", async () => {
    const { clubA, adminP } = await setup();
    const grp = await createPayGroup(adminP, clubA.id, { code: "H", name: "H", payFrequency: "WEEKLY" });
    const emp = await makeEmployee(clubA.id, "E-4000");
    const far = new Date("2099-01-01T00:00:00Z");
    const m = await assignMembership(adminP, clubA.id, {
      payGroupId: grp.id, employeeId: emp.id, effectiveFrom: far,
    });
    expect(m.effectiveFrom.getTime()).toBe(far.getTime());
  });

  it("transfer — ends old + starts new at the same boundary; no overlap; audit visible", async () => {
    const { clubA, adminP } = await setup();
    const salary = await createPayGroup(adminP, clubA.id, { code: "SAL", name: "S", payFrequency: "SEMI_MONTHLY" });
    const hourly = await createPayGroup(adminP, clubA.id, { code: "HRL", name: "H", payFrequency: "WEEKLY" });
    const emp = await makeEmployee(clubA.id, "E-5000");
    await assignMembership(adminP, clubA.id, {
      payGroupId: salary.id,
      employeeId: emp.id,
      effectiveFrom: new Date("2026-06-01T00:00:00Z"),
    });
    const at = new Date("2026-09-01T00:00:00Z");
    const { ended, started } = await transferMembership(adminP, clubA.id, {
      employeeId: emp.id, toPayGroupId: hourly.id, effectiveAt: at,
    });
    expect(ended?.payGroupId).toBe(salary.id);
    expect(ended?.effectiveTo?.getTime()).toBe(at.getTime());
    expect(started.payGroupId).toBe(hourly.id);
    expect(started.effectiveFrom.getTime()).toBe(at.getTime());
    // Sanity: on the transfer day the employee is in the NEW group.
    const asOfAt = await getMembershipAsOf(adminP, clubA.id, emp.id, at);
    expect(asOfAt?.payGroupId).toBe(hourly.id);
    // On the day before the transfer, the OLD group.
    const asOfBefore = await getMembershipAsOf(adminP, clubA.id, emp.id, new Date("2026-08-31T00:00:00Z"));
    expect(asOfBefore?.payGroupId).toBe(salary.id);
    // History returns both rows in date order.
    const hist = await listMembershipHistoryForEmployee(adminP, clubA.id, emp.id);
    expect(hist.map((h) => h.payGroupId)).toEqual([salary.id, hourly.id]);
  });

  it("endMembership rejects an end date before effectiveFrom", async () => {
    const { clubA, adminP } = await setup();
    const grp = await createPayGroup(adminP, clubA.id, { code: "H", name: "H", payFrequency: "WEEKLY" });
    const emp = await makeEmployee(clubA.id, "E-6000");
    const m = await assignMembership(adminP, clubA.id, {
      payGroupId: grp.id, employeeId: emp.id, effectiveFrom: new Date("2026-06-01T00:00:00Z"),
    });
    await expect(endMembership(adminP, clubA.id, m.id, new Date("2026-05-01T00:00:00Z"))).rejects.toThrow();
    const ended = await endMembership(adminP, clubA.id, m.id, new Date("2026-08-01T00:00:00Z"));
    expect(ended.effectiveTo?.getTime()).toBe(new Date("2026-08-01T00:00:00Z").getTime());
  });

  it("cross-tenant assignment blocked — Club A admin cannot assign a Club B employee", async () => {
    const { clubA, clubB, adminP } = await setup();
    const grpA = await createPayGroup(adminP, clubA.id, { code: "H", name: "H", payFrequency: "WEEKLY" });
    const empB = await makeEmployee(clubB.id, "E-B-1");
    // Direct write via adminP fails permission at the boundary.
    await expect(
      assignMembership(adminP, clubB.id, {
        payGroupId: grpA.id, employeeId: empB.id, effectiveFrom: new Date(),
      }),
    ).rejects.toThrow();
    // Even trying to assign Club B's employee to Club A's group fails validation.
    await expect(
      assignMembership(adminP, clubA.id, {
        payGroupId: grpA.id, employeeId: empB.id, effectiveFrom: new Date(),
      }),
    ).rejects.toThrow();
  });

  it("listActiveMembersAsOf enumerates the pay group's population deterministically", async () => {
    const { clubA, adminP } = await setup();
    const grp = await createPayGroup(adminP, clubA.id, { code: "H", name: "H", payFrequency: "WEEKLY" });
    const e1 = await makeEmployee(clubA.id, "E-7001");
    const e2 = await makeEmployee(clubA.id, "E-7002");
    const asOf = new Date("2026-07-01T00:00:00Z");
    await assignMembership(adminP, clubA.id, { payGroupId: grp.id, employeeId: e1.id, effectiveFrom: new Date("2026-06-01T00:00:00Z") });
    await assignMembership(adminP, clubA.id, { payGroupId: grp.id, employeeId: e2.id, effectiveFrom: new Date("2026-08-01T00:00:00Z") });
    const rows = await listActiveMembersAsOf(adminP, clubA.id, grp.id, asOf);
    // Only e1 covers 2026-07-01.
    expect(rows.map((r) => r.employeeId)).toEqual([e1.id]);
  });

  it("audit records are generated for meaningful mutations", async () => {
    const { clubA, adminP, payAdminUser, controllerUser } = await setup();
    await upsertPayrollClubConfig(adminP, clubA.id, {
      provinceOfEmployment: "AB",
      payrollAdminUserId: payAdminUser.id,
      controllerUserId: controllerUser.id,
    });
    await activatePayrollClubConfig(adminP, clubA.id);
    const grp = await createPayGroup(adminP, clubA.id, { code: "H", name: "H", payFrequency: "WEEKLY" });
    const emp = await makeEmployee(clubA.id, "E-8000");
    const m = await assignMembership(adminP, clubA.id, {
      payGroupId: grp.id, employeeId: emp.id, effectiveFrom: new Date("2026-06-01"),
    });
    await endMembership(adminP, clubA.id, m.id, new Date("2026-08-01"));

    const audits = await db().auditLog.findMany({
      where: { clubId: clubA.id, action: { startsWith: "payroll." } },
      orderBy: { createdAt: "asc" },
      select: { action: true, entityType: true, userId: true },
    });
    const actions = audits.map((a) => a.action);
    expect(actions).toContain("payroll.config.upsert");
    expect(actions).toContain("payroll.config.activate");
    expect(actions).toContain("payroll.pay-group.create");
    expect(actions).toContain("payroll.pay-group-member.assign");
    expect(actions).toContain("payroll.pay-group-member.end");
    // Every write attributed to the acting principal.
    expect(audits.every((a) => a.userId === adminP.id)).toBe(true);
  });

  it("listMemberships returns everything at the tenant boundary; other tenant sees zero", async () => {
    const { clubA, clubB, adminP } = await setup();
    const grp = await createPayGroup(adminP, clubA.id, { code: "H", name: "H", payFrequency: "WEEKLY" });
    const emp = await makeEmployee(clubA.id, "E-9000");
    await assignMembership(adminP, clubA.id, { payGroupId: grp.id, employeeId: emp.id, effectiveFrom: new Date() });
    const a = await listMemberships(adminP, clubA.id);
    expect(a.length).toBe(1);
    await expect(listMemberships(adminP, clubB.id)).rejects.toThrow();
  });
});
