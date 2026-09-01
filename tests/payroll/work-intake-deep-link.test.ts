// Payroll-3B-5B-3A closeout — Work Intake deep-link regression.

import { describe, it, expect, beforeEach } from "vitest";
import { db, resetDb, seedRbac, makeClub, makeUser, principalFor } from "../util/db";
import { upsertPayrollClubConfig } from "@/lib/payroll/club-config";
import { preparePayrollBatch } from "@/lib/payroll/batch-preparation";
import { orchestratePayrollReviewHandoff } from "@/lib/payroll/orchestration";
import { calculatePayrollBatch } from "@/lib/payroll/calculation-execute";
import { seedCanadaAlbertaPackages2026 } from "@/lib/payroll/statutory/seed-ca-ab-2026";
import { resolvePayrollWorkIntakeDeepLink } from "@/lib/payroll/work-intake-deep-link";

const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));

async function superAdminP() {
  const c = db();
  await c.user.deleteMany({ where: { email: "super-3aclose@spectre.test" } });
  const u = await c.user.create({
    data: { email: "super-3aclose@spectre.test", name: "Super3AClose",
            role: "SUPER_ADMIN", passwordHash: "x", status: "ACTIVE" },
  });
  await c.userClubRole.create({ data: { userId: u.id, clubId: null, roleKey: "SUPER_ADMIN" } });
  return principalFor("super-3aclose@spectre.test");
}

describe("resolvePayrollWorkIntakeDeepLink — pure resolver", () => {
  it("PAYROLL_FINAL_APPROVAL → review workspace URL with label 'Review payroll'", () => {
    const r = resolvePayrollWorkIntakeDeepLink("PAYROLL_FINAL_APPROVAL", "cmxyz123");
    expect(r).not.toBeNull();
    expect(r!.href).toBe("/app/admin/payroll/batches/cmxyz123");
    expect(r!.label).toBe("Review payroll");
  });
  it("PAYROLL_REVIEW → processing page with batchId query", () => {
    const r = resolvePayrollWorkIntakeDeepLink("PAYROLL_REVIEW", "cmabc");
    expect(r?.href).toBe("/app/admin/payroll/process?batchId=cmabc");
    expect(r?.label).toBe("Open payroll processing");
  });
  it("unknown subtype → null", () => {
    expect(resolvePayrollWorkIntakeDeepLink("SOME_OTHER_SUBTYPE", "cmabc")).toBeNull();
  });
  it("missing referenceId → null", () => {
    expect(resolvePayrollWorkIntakeDeepLink("PAYROLL_FINAL_APPROVAL", null)).toBeNull();
  });
  it("special chars in referenceId are URL-encoded (defensive — cuid ids are safe)", () => {
    const r = resolvePayrollWorkIntakeDeepLink("PAYROLL_FINAL_APPROVAL", "cm?evil=xss");
    expect(r?.href).toContain("cm%3Fevil%3Dxss");
  });
});

describe("PAYROLL_FINAL_APPROVAL WI item carries the review URL in its preview", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("displayPreview includes 'Review payroll → /app/admin/payroll/batches/<batchId>'; no SIN/bank/TD1 amount", async () => {
    const sup = await superAdminP();
    await seedCanadaAlbertaPackages2026(sup);

    const club = await makeClub("Club DL");
    const admin      = await makeUser({ email: "admin.dl@a.test", role: "CLUB_ADMIN", clubId: club.id });
    const pa         = await makeUser({ email: "pa.dl@a.test",    role: "PAYROLL_ADMIN", clubId: club.id });
    const controller = await makeUser({ email: "ctl.dl@a.test",   role: "CONTROLLER", clubId: club.id });
    const adminP = await principalFor(admin.email);
    const paP    = await principalFor(pa.email);
    await upsertPayrollClubConfig(adminP, club.id, {
      provinceOfEmployment: "AB", payrollAdminUserId: pa.id, controllerUserId: controller.id,
    });
    const emp = await db().employee.create({
      data: {
        clubId: club.id, firstName: "Deep", lastName: "Link",
        email: "dl@a.test", hireDate: utc(2026, 1, 1),
        dateOfBirth: utc(1990, 5, 12), status: "ACTIVE", employeeNumber: "E-DL-1",
      },
    });
    const assn = await db().employeeEmploymentAssignment.create({
      data: {
        clubId: club.id, employeeId: emp.id, role: "PRIMARY",
        employmentType: "FULL_TIME", effectiveFrom: utc(2026, 1, 1),
      },
    });
    await db().employeeCompensation.create({
      data: {
        clubId: club.id, employeeId: emp.id, assignmentId: assn.id,
        cadence: "SALARY", rate: "52000", currency: "CAD",
        effectiveFrom: utc(2026, 1, 1),
      },
    });
    await db().employeeBankAccount.create({
      data: {
        clubId: club.id, employeeId: emp.id,
        institutionSecretRef: "fixture", transitSecretRef: "fixture",
        accountSecretRef: "fixture", holderName: "DL", bankFingerprint: "fp-dl",
        status: "VERIFIED", activatedAt: utc(2026, 1, 1),
      },
    });
    await db().employeeTaxProfile.create({
      data: {
        clubId: club.id, employeeId: emp.id,
        province: "AB", td1FormVersion: "2026-01", effectiveFrom: utc(2026, 1, 1),
        federalClaimSecretRef: "16452", provincialClaimSecretRef: "22769",
      },
    });
    const pg = await db().payrollPayGroup.create({
      data: {
        clubId: club.id, code: "PG-DL", name: "PG-DL",
        payFrequency: "BIWEEKLY", payDateOffsetDays: 0,
        calendarAnchorDate: utc(2026, 1, 4),
      },
    });
    const yearStart = utc(2026, 1, 4);
    let pp: { id: string } | null = null;
    for (let seq = 1; seq <= 26; seq++) {
      const start = new Date(yearStart.getTime() + (seq - 1) * 14 * 86400_000);
      const end   = new Date(start.getTime() + 13 * 86400_000);
      const row = await db().payrollPayPeriod.create({
        data: {
          clubId: club.id, payGroupId: pg.id,
          sequenceInYear: seq, taxYear: 2026,
          periodStart: start, periodEnd: end, payDate: end,
        },
      });
      if (seq === 5) pp = row;
    }
    if (!pp) throw new Error("no pp");
    await db().payrollPayGroupMember.create({
      data: { clubId: club.id, payGroupId: pg.id, employeeId: emp.id, effectiveFrom: utc(2026, 1, 1) },
    });
    const prepared = await preparePayrollBatch(adminP, club.id, pp.id);
    await orchestratePayrollReviewHandoff(adminP, club.id, pp.id, prepared.batchId);
    const be = await db().payrollBatchEmployee.findFirstOrThrow({ where: { batchId: prepared.batchId } });
    await db().payrollBatchEarning.create({
      data: {
        clubId: club.id, batchId: prepared.batchId, batchEmployeeId: be.id,
        employeeId: emp.id, earningType: "SALARY",
        quantity: "1", rate: "2000.00", rateSource: "MANUAL",
      },
    });
    const r = await calculatePayrollBatch(paP, club.id, prepared.batchId);
    expect(r.finalApprovalWorkIntakeItemId).not.toBeNull();
    const wi = await db().workIntakeItem.findUniqueOrThrow({ where: { id: r.finalApprovalWorkIntakeItemId! } });
    const preview = wi.displayPreview ?? "";
    expect(preview).toContain("Review payroll →");
    expect(preview).toContain(`/app/admin/payroll/batches/${prepared.batchId}`);
    // §41 executive-summary invariant still holds — no TD1 / SIN / bank.
    expect(preview).not.toMatch(/SIN|bank/i);
    expect(preview).not.toContain("16452");
    expect(preview).not.toContain("22769");
    // Approval endpoint MUST NOT be referenced.
    expect(preview).not.toMatch(/\bapprove\b|posted?|remit/i);
    // Card subtype + owner remain correct.
    expect(wi.workSubtype).toBe("PAYROLL_FINAL_APPROVAL");
    expect(wi.workIntent).toBe("APPROVE");
    expect(wi.ownerUserId).toBe(controller.id);
  });
});
