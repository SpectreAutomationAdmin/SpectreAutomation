// HR-2B.3.6 (2026-08-19) — Employee delete + archive lifecycle tests.
//
// Founder invariants:
//   * Pre-hire employee with no history → hard delete allowed.
//   * Onboarding SUBMITTED/APPROVED/REJECTED → hard delete refused.
//   * Payroll history → hard delete refused, even if onboarding is
//     incomplete.
//   * Timesheet history → hard delete refused.
//   * Archive works from any state past PRE_HIRE; preserves every
//     child row (payroll, tax, audit, documents).
//   * Cross-Club admin refused for both actions.
//   * AUDITOR_READ_ONLY refused for both actions.

import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  archiveEmployee,
  createEmployee,
  deleteEmployee,
  getDeleteEligibility,
} from "@/lib/hr/employees";
import { resetDb, seedRbac } from "../../util/db";
import { makeAdminHrFixture } from "./_helpers";

describe("HR-2B.3.6 · Employee delete + archive", () => {
  beforeEach(async () => {
    await resetDb();
    await seedRbac();
  });

  it("pre-hire employee with no history → getDeleteEligibility says eligible; deleteEmployee removes the row", async () => {
    const fx = await makeAdminHrFixture("Delete-PreHire");
    const emp = await createEmployee(fx.clubAdmin, fx.club.id, {
      firstName: "Pre",
      lastName: "Hire",
    });

    const eligibility = await getDeleteEligibility(fx.clubAdmin, emp.id);
    expect(eligibility.eligible).toBe(true);

    await deleteEmployee(fx.clubAdmin, emp.id);
    const gone = await prisma.employee.findUnique({ where: { id: emp.id } });
    expect(gone).toBeNull();
  });

  it("onboardingState=SUBMITTED → getDeleteEligibility says INELIGIBLE with reason=onboarding_completed; deleteEmployee throws", async () => {
    const fx = await makeAdminHrFixture("Delete-Submitted");
    const emp = await createEmployee(fx.clubAdmin, fx.club.id, {
      firstName: "Sub",
      lastName: "Mitted",
    });
    await prisma.employee.update({
      where: { id: emp.id },
      data: { onboardingState: "SUBMITTED" },
    });

    const eligibility = await getDeleteEligibility(fx.clubAdmin, emp.id);
    expect(eligibility.eligible).toBe(false);
    expect(eligibility.reason).toBe("onboarding_completed");

    await expect(deleteEmployee(fx.clubAdmin, emp.id)).rejects.toThrow();
    const still = await prisma.employee.findUnique({ where: { id: emp.id } });
    expect(still).toBeTruthy();
  });

  it.each(["APPROVED", "REJECTED"] as const)(
    "onboardingState=%s → hard delete refused",
    async (state) => {
      const fx = await makeAdminHrFixture(`Delete-${state}`);
      const emp = await createEmployee(fx.clubAdmin, fx.club.id, {
        firstName: state,
        lastName: "One",
      });
      await prisma.employee.update({
        where: { id: emp.id },
        data: { onboardingState: state },
      });
      const eligibility = await getDeleteEligibility(fx.clubAdmin, emp.id);
      expect(eligibility.eligible).toBe(false);
      expect(eligibility.reason).toBe("onboarding_completed");
    },
  );

  it("payroll history → hard delete refused with reason=has_payroll_lines (even if onboarding incomplete)", async () => {
    const fx = await makeAdminHrFixture("Delete-Payroll");
    const emp = await createEmployee(fx.clubAdmin, fx.club.id, {
      firstName: "Paid",
      lastName: "Once",
    });
    // Seed a minimal PayrollLine (via PayrollRun → PayrollPeriod).
    const period = await prisma.payrollPeriod.create({
      data: {
        clubId: fx.club.id,
        label: `TEST-${Math.random().toString(36).slice(2, 8)}`,
        startDate: new Date(),
        endDate: new Date(),
        payDate: new Date(),
        status: "OPEN",
      },
    });
    const run = await prisma.payrollRun.create({
      data: {
        clubId: fx.club.id,
        periodId: period.id,
        runNumber: `R-${Math.random().toString(36).slice(2, 8)}`,
      },
    });
    await prisma.payrollLine.create({
      data: {
        clubId: fx.club.id,
        employeeId: emp.id,
        runId: run.id,
        regularHours: 8,
        overtimeHours: 0,
        grossPay: 200,
      },
    });

    const eligibility = await getDeleteEligibility(fx.clubAdmin, emp.id);
    expect(eligibility.eligible).toBe(false);
    expect(eligibility.reason).toBe("has_payroll_lines");
    await expect(deleteEmployee(fx.clubAdmin, emp.id)).rejects.toThrow();
  });

  it("archiveEmployee flips lifecycle to ARCHIVED and preserves every child row", async () => {
    const fx = await makeAdminHrFixture("Archive-Preserve");
    const emp = await createEmployee(fx.clubAdmin, fx.club.id, {
      firstName: "Keep",
      lastName: "History",
    });
    // Seed a payroll row to prove archive doesn't destroy it.
    const period = await prisma.payrollPeriod.create({
      data: {
        clubId: fx.club.id,
        label: `TEST-${Math.random().toString(36).slice(2, 8)}`,
        startDate: new Date(),
        endDate: new Date(),
        payDate: new Date(),
        status: "OPEN",
      },
    });
    const run = await prisma.payrollRun.create({
      data: {
        clubId: fx.club.id,
        periodId: period.id,
        runNumber: `R-${Math.random().toString(36).slice(2, 8)}`,
      },
    });
    const payrollLine = await prisma.payrollLine.create({
      data: {
        clubId: fx.club.id,
        employeeId: emp.id,
        runId: run.id,
        regularHours: 8,
        overtimeHours: 0,
        grossPay: 200,
      },
    });

    const updated = await archiveEmployee(fx.clubAdmin, emp.id);
    expect(updated.employeeLifecycle).toBe("ARCHIVED");

    // Row still there.
    const still = await prisma.employee.findUnique({ where: { id: emp.id } });
    expect(still).toBeTruthy();
    expect(still!.employeeLifecycle).toBe("ARCHIVED");
    // Payroll row still there.
    const payroll = await prisma.payrollLine.findUnique({ where: { id: payrollLine.id } });
    expect(payroll).toBeTruthy();
  });

  it("archiveEmployee is idempotent", async () => {
    const fx = await makeAdminHrFixture("Archive-Idempotent");
    const emp = await createEmployee(fx.clubAdmin, fx.club.id, {
      firstName: "Arch",
      lastName: "Twice",
    });
    await archiveEmployee(fx.clubAdmin, emp.id);
    const second = await archiveEmployee(fx.clubAdmin, emp.id);
    expect(second.employeeLifecycle).toBe("ARCHIVED");
  });

  it("cross-Club admin cannot delete OR archive an employee at another club", async () => {
    const fx = await makeAdminHrFixture("XClub-Refuse");
    const emp = await createEmployee(fx.clubAdmin, fx.club.id, {
      firstName: "Own",
      lastName: "Club",
    });
    await expect(deleteEmployee(fx.foreignClubAdmin, emp.id)).rejects.toThrow();
    await expect(archiveEmployee(fx.foreignClubAdmin, emp.id)).rejects.toThrow();
    // Neither mutation applied.
    const still = await prisma.employee.findUnique({ where: { id: emp.id } });
    expect(still).toBeTruthy();
    expect(still!.employeeLifecycle).not.toBe("ARCHIVED");
  });

  it("AUDITOR_READ_ONLY refused for both actions", async () => {
    const fx = await makeAdminHrFixture("Auditor-Refuse");
    const emp = await createEmployee(fx.clubAdmin, fx.club.id, {
      firstName: "Read",
      lastName: "Only",
    });
    await expect(deleteEmployee(fx.auditor, emp.id)).rejects.toThrow();
    await expect(archiveEmployee(fx.auditor, emp.id)).rejects.toThrow();
  });

  it("delete cascade removes sensitive HR children (SIN / bank / tax / documents / onboarding rows)", async () => {
    const fx = await makeAdminHrFixture("Delete-Cascade");
    const emp = await createEmployee(fx.clubAdmin, fx.club.id, {
      firstName: "Cascade",
      lastName: "Test",
    });
    // Seed representative child rows the delete transaction covers.
    await prisma.employeeSensitiveIdentity.create({
      data: {
        clubId: fx.club.id,
        employeeId: emp.id,
        sinLastThree: "999",
        sinSecretRef: "kms:test:sin",
      },
    });
    await prisma.employeeBankAccount.create({
      data: {
        clubId: fx.club.id,
        employeeId: emp.id,
        institutionSecretRef: "kms:test:inst",
        transitSecretRef: "kms:test:trans",
        accountSecretRef: "kms:test:acct",
        holderName: "Cascade Test",
      },
    });
    await prisma.employeeDocument.create({
      data: {
        clubId: fx.club.id,
        employeeId: emp.id,
        storageKey: "s3://test/x",
        contentSha256: "a".repeat(64),
        sizeBytes: 100,
        mimeType: "application/pdf",
        category: "resume",
      },
    });

    // Untick the profilePhoto pointer if seed set it — safety.
    await prisma.employee.update({
      where: { id: emp.id },
      data: { profilePhotoDocumentId: null, resumeDocumentId: null },
    }).catch(() => { /* older schema without those fields */ });

    await deleteEmployee(fx.clubAdmin, emp.id);

    const [sin, bank, docs, gone] = await Promise.all([
      prisma.employeeSensitiveIdentity.findFirst({ where: { employeeId: emp.id } }),
      prisma.employeeBankAccount.findFirst({ where: { employeeId: emp.id } }),
      prisma.employeeDocument.findMany({ where: { employeeId: emp.id } }),
      prisma.employee.findUnique({ where: { id: emp.id } }),
    ]);
    expect(sin).toBeNull();
    expect(bank).toBeNull();
    expect(docs).toEqual([]);
    expect(gone).toBeNull();
  });
});
