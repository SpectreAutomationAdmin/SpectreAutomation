// Slice A closeout (2026-09-18) — Controller-facing service-date
// correction. Founder-directive §3 test matrix A-I.

import { describe, it, expect, beforeEach } from "vitest";
import { db, resetDb, seedRbac, makeClub, makeUser, principalFor } from "./util/db";
import { prisma } from "@/lib/prisma";
import { ROLE_PERMISSIONS, type PermissionKey } from "@/lib/permissions";
import { hasPermission } from "@/lib/rbac";
import { updateEmployeeHireDate } from "@/lib/hr/service-date";
import { resolveMembershipEffectiveFrom } from "@/lib/payroll/pay-group-auto-assign";
import { ForbiddenError } from "@/lib/errors";

async function seedTestEmployee(clubId: string, opts: {
  hireDate?: Date | null;
  activatedAt?: Date | null;
  departmentId?: string | null;
} = {}) {
  const id = `test-emp-${Math.random().toString(36).slice(2, 10)}`;
  await prisma.employee.create({
    data: {
      id, clubId,
      employeeNumber: id.slice(-8),
      firstName: "Test",
      lastName: id.slice(-6),
      employeeLifecycle: "ACTIVE",
      hireDate: opts.hireDate ?? null,
      activatedAt: opts.activatedAt ?? null,
      departmentId: opts.departmentId ?? null,
    },
  });
  return id;
}

describe("Slice A closeout — hr:service-date:write narrow permission", () => {
  it("A. CONTROLLER has hr:service-date:write", () => {
    const g = new Set<PermissionKey>(ROLE_PERMISSIONS.CONTROLLER);
    expect(g.has("hr:service-date:write")).toBe(true);
  });
  it("B. PAYROLL_ADMIN has hr:service-date:write", () => {
    const g = new Set<PermissionKey>(ROLE_PERMISSIONS.PAYROLL_ADMIN);
    expect(g.has("hr:service-date:write")).toBe(true);
  });
  it("CLUB_ADMIN has hr:service-date:write", () => {
    const g = new Set<PermissionKey>(ROLE_PERMISSIONS.CLUB_ADMIN);
    expect(g.has("hr:service-date:write")).toBe(true);
  });
  it("C. CONTROLLER does NOT gain hr:employment:write via this slice", () => {
    const g = new Set<PermissionKey>(ROLE_PERMISSIONS.CONTROLLER);
    expect(g.has("hr:employment:write")).toBe(false);
  });
  it("CONTROLLER does NOT gain hr:employee:write via this slice", () => {
    const g = new Set<PermissionKey>(ROLE_PERMISSIONS.CONTROLLER);
    expect(g.has("hr:employee:write")).toBe(false);
  });
  it("CONTROLLER cannot reveal SIN / banking / tax after this slice", () => {
    const g = new Set<PermissionKey>(ROLE_PERMISSIONS.CONTROLLER);
    expect(g.has("hr:sin:reveal")).toBe(false);
    expect(g.has("hr:banking:reveal")).toBe(false);
    expect(g.has("hr:tax:reveal")).toBe(false);
  });
});

describe("Slice A closeout — updateEmployeeHireDate service (Controller)", () => {
  beforeEach(async () => {
    await resetDb();
    await seedRbac();
  });

  it("D. Controller can correct Original Hire Date on an isolated employee", async () => {
    const club = await makeClub("Service Date Club");
    await makeUser({ email: "controller@svc.test", role: "CONTROLLER", clubId: club.id });
    const controller = await principalFor("controller@svc.test");
    // Sanity: principal really carries the narrow grant.
    expect(hasPermission(controller, club.id, "hr:service-date:write")).toBe(true);

    const empId = await seedTestEmployee(club.id, {
      hireDate: null,
      activatedAt: new Date("2026-09-15T00:00:00.000Z"),
    });
    const result = await updateEmployeeHireDate(controller, empId, {
      hireDate: "2019-05-01",
    });
    expect(result.hireDate?.toISOString().slice(0, 10)).toBe("2019-05-01");

    const row = await prisma.employee.findUnique({
      where: { id: empId },
      select: { hireDate: true, activatedAt: true, departmentId: true },
    });
    expect(row?.hireDate?.toISOString().slice(0, 10)).toBe("2019-05-01");
    // G. activatedAt untouched.
    expect(row?.activatedAt?.toISOString().slice(0, 10)).toBe("2026-09-15");
    // E. departmentId untouched (was null; still null).
    expect(row?.departmentId).toBeNull();
  });

  it("E + F. Service ignores departmentId / positionId even if passed at runtime", async () => {
    const club = await makeClub("Service Date Club E");
    const dept = await prisma.department.create({
      data: { clubId: club.id, code: "T", name: "T dept" },
    });
    await makeUser({ email: "controller-ef@svc.test", role: "CONTROLLER", clubId: club.id });
    const controller = await principalFor("controller-ef@svc.test");

    const empId = await seedTestEmployee(club.id, {
      hireDate: null,
      departmentId: null,
    });
    // Cast to `any` and try to smuggle departmentId + positionId + activatedAt.
    // The service is typed as `UpdateHireDateInput = { hireDate }`; runtime
    // proof follows.
    await updateEmployeeHireDate(controller, empId, {
      hireDate: "2020-01-01",
      // @ts-expect-error — smuggle attempt
      departmentId: dept.id,
      // @ts-expect-error — smuggle attempt
      positionId: "some-position",
      // @ts-expect-error — smuggle attempt
      activatedAt: new Date("2000-01-01"),
    } as never);
    const row = await prisma.employee.findUnique({
      where: { id: empId },
      select: { hireDate: true, departmentId: true, positionId: true, activatedAt: true },
    });
    expect(row?.hireDate?.toISOString().slice(0, 10)).toBe("2020-01-01");
    expect(row?.departmentId).toBeNull();
    expect(row?.positionId).toBeNull();
    expect(row?.activatedAt).toBeNull();
  });

  it("H. Changing hireDate does NOT alter pay-group membership effectiveFrom (via activatedAt-first hierarchy)", async () => {
    const club = await makeClub("Service Date Club H");
    await makeUser({ email: "controller-h@svc.test", role: "CONTROLLER", clubId: club.id });
    const controller = await principalFor("controller-h@svc.test");
    const empId = await seedTestEmployee(club.id, {
      hireDate: new Date("2026-05-01"),
      activatedAt: new Date("2026-09-15T00:00:00.000Z"),
    });
    // Pre-change: activatedAt already dominates.
    const before = await resolveMembershipEffectiveFrom(empId, new Date());
    expect(before?.source).toBe("EMPLOYEE_ACTIVATED_AT");

    // Controller corrects hireDate to a pre-Spectre date.
    await updateEmployeeHireDate(controller, empId, { hireDate: "2019-05-01" });

    const after = await resolveMembershipEffectiveFrom(empId, new Date());
    expect(after?.source).toBe("EMPLOYEE_ACTIVATED_AT");
    expect(after?.effectiveFrom.toISOString().slice(0, 10)).toBe("2026-09-15");
  });

  it("Idempotent no-op when the new hireDate equals the existing value", async () => {
    const club = await makeClub("Service Date Club Idempotent");
    await makeUser({ email: "controller-i@svc.test", role: "CONTROLLER", clubId: club.id });
    const controller = await principalFor("controller-i@svc.test");
    const empId = await seedTestEmployee(club.id, {
      hireDate: new Date("2021-06-01T00:00:00.000Z"),
    });
    const result = await updateEmployeeHireDate(controller, empId, { hireDate: "2021-06-01" });
    expect(result.hireDate?.toISOString().slice(0, 10)).toBe("2021-06-01");
    expect(result.before.hireDate?.toISOString().slice(0, 10)).toBe("2021-06-01");
  });

  it("I. Audit contains before + after hireDate", async () => {
    const club = await makeClub("Service Date Club Audit");
    await makeUser({ email: "controller-audit@svc.test", role: "CONTROLLER", clubId: club.id });
    const controller = await principalFor("controller-audit@svc.test");
    const empId = await seedTestEmployee(club.id, {
      hireDate: new Date("2015-03-15T00:00:00.000Z"),
    });
    await updateEmployeeHireDate(controller, empId, { hireDate: "2019-05-01" });

    const auditRow = await prisma.auditLog.findFirst({
      where: { entityType: "Employee", entityId: empId, action: "hr.employee.hire_date.set" },
      orderBy: { createdAt: "desc" },
    });
    expect(auditRow).not.toBeNull();
    const before = JSON.parse(auditRow!.beforeJson ?? "{}");
    const after = JSON.parse(auditRow!.afterJson ?? "{}");
    expect(before.hireDate).toContain("2015-03-15");
    expect(after.hireDate).toContain("2019-05-01");
  });

  it("Real-value DB → service DTO integration: OpeningBalanceFields round-trips every field", async () => {
    // Founder-directive §7 — prove the DB → service → page-DTO contract
    // for the Employee Payroll Opening YTD summary. Uses distinctive
    // non-zero values so a silently missing field is caught by an
    // assertion, not a coincidence.
    const { createDraftOpeningBalance, activateOpeningBalance, getActiveOpeningBalance } =
      await import("@/lib/payroll/opening-balance");
    const club = await makeClub("Opening YTD Real-Value Club");
    await makeUser({ email: "pa-openingytd@svc.test", role: "PAYROLL_ADMIN", clubId: club.id });
    const pa = await principalFor("pa-openingytd@svc.test");
    const empId = await seedTestEmployee(club.id, {
      hireDate: new Date("2019-05-01T00:00:00.000Z"),
      activatedAt: new Date("2026-09-15T00:00:00.000Z"),
    });

    const draft = await createDraftOpeningBalance(pa, club.id, {
      employeeId: empId,
      taxYear: 2026,
      throughPayDate: new Date("2026-08-31T00:00:00.000Z"),
      priorPayrollKind: "PRIOR_SYSTEM_SAME_EMPLOYER",
      importSource: "MANUAL",
      values: {
        ytdGrossEarnings: "12345.67",
        ytdTaxableEarnings: "12000.00",
        ytdPensionableEarnings: "11500.00",
        ytdInsurableEarnings: "11800.00",
        ytdCppEE_Base: "400.00",
        ytdCppEE_FirstAdd: "50.55",
        ytdCppEE: "450.55",
        ytdCpp2EE: "25.25",
        ytdEiEE: "125.75",
        ytdFederalTax: "1300.10",
        ytdProvincialTax: "700.20",
        ytdCppER_Base: "400.00",
        ytdCppER_FirstAdd: "50.55",
        ytdCppER: "450.55",
        ytdCpp2ER: "25.25",
        ytdEiER: "176.05",
      },
    });
    await activateOpeningBalance(pa, club.id, draft.id);

    const view = await getActiveOpeningBalance(club.id, empId, 2026);
    expect(view).not.toBeNull();
    expect(view!.status).toBe("ACTIVE");
    expect(view!.throughPayDate?.toISOString().slice(0, 10)).toBe("2026-08-31");
    expect(view!.priorPayrollKind).toBe("PRIOR_SYSTEM_SAME_EMPLOYER");
    // Every OpeningBalanceFields property must round-trip verbatim.
    const v = view!.values;
    expect(v.ytdGrossEarnings).toBe("12345.67");
    expect(v.ytdTaxableEarnings).toBe("12000");
    expect(v.ytdPensionableEarnings).toBe("11500");
    expect(v.ytdInsurableEarnings).toBe("11800");
    expect(v.ytdCppEE_Base).toBe("400");
    expect(v.ytdCppEE_FirstAdd).toBe("50.55");
    expect(v.ytdCppEE).toBe("450.55");
    expect(v.ytdCpp2EE).toBe("25.25");
    expect(v.ytdEiEE).toBe("125.75");
    expect(v.ytdFederalTax).toBe("1300.1");
    expect(v.ytdProvincialTax).toBe("700.2");
    expect(v.ytdCppER_Base).toBe("400");
    expect(v.ytdCppER_FirstAdd).toBe("50.55");
    expect(v.ytdCppER).toBe("450.55");
    expect(v.ytdCpp2ER).toBe("25.25");
    expect(v.ytdEiER).toBe("176.05");
  });

  it("Refuses without hr:service-date:write (e.g. GENERAL_MANAGER)", async () => {
    const club = await makeClub("Service Date Club Denied");
    await makeUser({ email: "gm-denied@svc.test", role: "GENERAL_MANAGER", clubId: club.id });
    const gm = await principalFor("gm-denied@svc.test");
    const empId = await seedTestEmployee(club.id);
    await expect(
      updateEmployeeHireDate(gm, empId, { hireDate: "2020-01-01" }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});
