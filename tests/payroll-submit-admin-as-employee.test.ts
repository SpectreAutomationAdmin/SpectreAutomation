// v-slice-1-followup-3 (2026-09-15) — §10 item C regression.
//
// Founder-directive requirement:
//   "Payroll Administrator being an employee included in the payroll
//    does not prevent submission."
//
// This test seeds a Payroll Admin whose UserClubProfile.employeeId
// links to an Employee row that IS included as a
// PayrollBatchEmployee on the CALCULATED batch — the exact staging
// shape for Marc + Chris — and proves the submit path still succeeds.

import { describe, it, expect } from "vitest";
import { PrismaClient } from "@prisma/client";
import type { Principal } from "@/lib/rbac";
import { submitPayrollBatch } from "@/lib/payroll/submit-payroll-batch";
import { attestBatchReview } from "@/lib/payroll/batch-review";
import { seedRbac } from "./util/db";

const prisma = new PrismaClient();
const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));

function principal(
  clubId: string, id: string, roleKey: "PAYROLL_ADMIN" | "CONTROLLER",
): Principal {
  return {
    id, kind: "user",
    memberships: [{ clubId, roleKey }],
    activeClubId: clubId,
  } as unknown as Principal;
}

/**
 * Seed a Payroll Admin who is ALSO an employee in the current batch.
 * Mirrors Marc's staging shape: UserClubProfile.employeeId links to a
 * live Employee row that appears in PayrollBatchEmployee.
 */
async function seedPaWhoIsAlsoInBatch() {
  await seedRbac();
  const clubId = `club-${Math.random().toString(36).slice(2, 8)}`;
  const paUserId = `pa-${Math.random().toString(36).slice(2, 8)}`;
  const ctrlUserId = `ctrl-${Math.random().toString(36).slice(2, 8)}`;
  const paEmployeeId = `emp-${Math.random().toString(36).slice(2, 8)}`;

  await prisma.club.create({
    data: {
      id: clubId, slug: clubId, name: `Test ${clubId}`, wordmark: clubId,
      timezone: "America/Edmonton", payrollProvince: "AB",
    },
  });
  await prisma.user.createMany({
    data: [
      { id: paUserId,   email: `${paUserId}@t.test`,   name: "PA-Employee", role: "PAYROLL_ADMIN", passwordHash: "x" },
      { id: ctrlUserId, email: `${ctrlUserId}@t.test`, name: "Controller",  role: "CONTROLLER",    passwordHash: "x" },
    ],
  });
  await prisma.userClubRole.createMany({
    data: [
      { userId: paUserId,   clubId, roleKey: "PAYROLL_ADMIN" },
      { userId: ctrlUserId, clubId, roleKey: "CONTROLLER" },
    ],
  });

  // The PA IS an Employee. This is exactly Marc's shape.
  await prisma.employee.create({
    data: {
      id: paEmployeeId, clubId,
      firstName: "PA", lastName: "AlsoEmployee",
      employeeNumber: paEmployeeId.slice(-8),
      hireDate: utc(2026, 1, 1),
      employeeLifecycle: "ACTIVE",
      timekeepingMethod: "NO_CLOCK",
      dateOfBirth: utc(1985, 5, 20),
    },
  });
  // Link the User to the Employee via UserClubProfile — this is the
  // canonical bridge that would tempt a mistaken SoD rule to refuse.
  await prisma.userClubProfile.create({
    data: {
      clubId, userId: paUserId, employeeId: paEmployeeId,
      status: "ACTIVE",
    },
  });

  const payGroupId = `pg-${Math.random().toString(36).slice(2, 8)}`;
  await prisma.payrollPayGroup.create({
    data: {
      id: payGroupId, clubId, code: "BW", name: "Bi-Weekly",
      payFrequency: "BIWEEKLY", payDateOffsetDays: 0,
      calendarAnchorDate: utc(2026, 1, 4), active: true,
    },
  });
  const payPeriodId = `pp-${Math.random().toString(36).slice(2, 8)}`;
  await prisma.payrollPayPeriod.create({
    data: {
      id: payPeriodId, clubId, payGroupId,
      sequenceInYear: 1, taxYear: 2026,
      periodStart: utc(2026, 1, 4), periodEnd: utc(2026, 1, 18),
      payDate: utc(2026, 1, 17), status: "OPEN",
    },
  });
  const batchId = `bch-${Math.random().toString(36).slice(2, 8)}`;
  await prisma.payrollBatch.create({
    data: {
      id: batchId, clubId, payGroupId, payPeriodId,
      status: "CALCULATED", sequence: 1,
      preparedAt: new Date(), preparedByUserId: paUserId,
      sourceSnapshotAt: new Date(),
      calculatedAt: new Date(), calculationVersion: 1,
      algorithmVersion: "test",
    },
  });
  // The PA IS present in the batch as an INCLUDED employee.
  await prisma.payrollBatchEmployee.create({
    data: {
      id: `be-${Math.random().toString(36).slice(2, 8)}`,
      clubId, batchId, employeeId: paEmployeeId,
      payGroupMemberId: `pgm-${Math.random().toString(36).slice(2, 8)}`,
      salaried: true, status: "INCLUDED",
      jurisdictionCountry: "CA", jurisdictionProvince: "AB",
      employeeLifecycleAtPrep: "ACTIVE",
      compensationReady: true, bankingReady: true, sinReady: true,
      federalTd1Ready: true, provincialTd1Ready: true,
      bankingStatus: "VERIFIED",
      membershipEffectiveFrom: utc(2026, 1, 1),
      dateOfBirthSnapshot: utc(1985, 5, 20),
      grossPay: "3500.00", netPay: "2765.00",
      totalEmployeeDeductions: "735.00",
      deductionCppEeCombined: "195.00", deductionCpp2Ee: "0",
      deductionEiEe: "58.00",
      deductionFederalTax: "310.00", deductionProvincialTax: "172.00",
      employerCppCombined: "195.00", employerCpp2: "0", employerEi: "81.00",
      sourceFactsJson: JSON.stringify({ schemaVersion: 1 }),
    },
  });
  await prisma.payrollClubConfig.upsert({
    where: { clubId },
    update: { payrollAdminUserId: paUserId, controllerUserId: ctrlUserId },
    create: {
      clubId, payrollAdminUserId: paUserId, controllerUserId: ctrlUserId,
      provinceOfEmployment: "AB",
    },
  });
  return { clubId, batchId, paUserId, ctrlUserId, paEmployeeId };
}

describe("Payroll Submit — Admin-who-is-also-an-employee (v-slice-1-followup-3 §10.C)", () => {
  it("Payroll Admin whose UserClubProfile.employeeId is included in the batch CAN still submit", async () => {
    const s = await seedPaWhoIsAlsoInBatch();
    const pa = principal(s.clubId, s.paUserId, "PAYROLL_ADMIN");

    // Attest the calculated-payroll review — same actor that would submit.
    await attestBatchReview(pa, s.clubId, s.batchId, "CALCULATED_PAYROLL");

    // Submit — SoD must NOT refuse because the actor is also an employee
    // in the batch. This is the exact case the founder called out:
    // small clubs where the Payroll Admin is themselves on payroll.
    const result = await submitPayrollBatch(pa, s.clubId, s.batchId, { note: null });
    expect(result.status).toBe("SUBMITTED_FOR_APPROVAL");
    expect(result.submittedByUserId).toBe(s.paUserId);
    expect(result.workIntakeItemId).toBeTruthy();

    // Batch row reflects the transition.
    const post = await prisma.payrollBatch.findUniqueOrThrow({ where: { id: s.batchId } });
    expect(post.status).toBe("SUBMITTED_FOR_APPROVAL");
    expect(post.submittedByUserId).toBe(s.paUserId);
    expect(post.submittedAt).not.toBeNull();
  });
});
