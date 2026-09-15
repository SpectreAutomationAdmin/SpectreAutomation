// v-slice-1-followup-4 (2026-09-15) — Payroll role-governance hardening.
//
// Founder-directive §6: PAYROLL_ADMIN must no longer carry
// `payroll:approve`. Server-side same-actor SoD in
// approve-and-post.ts remains as defense-in-depth for multi-role
// holders. Together they close the "second Payroll Admin approves
// another Payroll Admin's submission" governance hole.
//
// This suite proves:
//   1. PAYROLL_ADMIN can submit.
//   2. PAYROLL_ADMIN cannot approve (permission gate refuses BEFORE
//      the same-actor SoD check even fires).
//   3. PAYROLL_ADMIN cannot return.
//   4. CONTROLLER can approve.
//   5. CONTROLLER can return.
//   6. Payroll Admin A submits + Payroll Admin B (pure PA, distinct
//      user) is refused approval — the governance hole is closed.
//   7. CONTROLLER-only can approve Payroll Admin A's submission.
//   8. Multi-role PAYROLL_ADMIN+CONTROLLER may possess both
//      capabilities but cannot approve a submission they personally
//      submitted (same-actor SoD preserved).

import { describe, it, expect } from "vitest";
import { PrismaClient } from "@prisma/client";
import type { Principal } from "@/lib/rbac";
import { hasPermission } from "@/lib/rbac";
import {
  submitPayrollBatch,
} from "@/lib/payroll/submit-payroll-batch";
import {
  approvePayrollBatch,
  ApproveSegregationOfDutiesError,
} from "@/lib/payroll/approve-and-post";
import { returnPayrollBatch } from "@/lib/payroll/return-payroll-batch";
import { attestBatchReview } from "@/lib/payroll/batch-review";
import { ForbiddenError } from "@/lib/errors";
import { seedRbac } from "./util/db";

const prisma = new PrismaClient();
const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));

type Role = "PAYROLL_ADMIN" | "CONTROLLER";

function principal(
  clubId: string, id: string, roleKeys: Role[],
): Principal {
  return {
    id, kind: "user",
    memberships: roleKeys.map(roleKey => ({ clubId, roleKey })),
    activeClubId: clubId,
  } as unknown as Principal;
}

async function seedCalculatedBatch() {
  await seedRbac();
  const clubId = `club-${Math.random().toString(36).slice(2, 8)}`;
  const paAId  = `pa-a-${Math.random().toString(36).slice(2, 8)}`;
  const paBId  = `pa-b-${Math.random().toString(36).slice(2, 8)}`;
  const ctrlId = `ctrl-${Math.random().toString(36).slice(2, 8)}`;
  const multiId = `mr-${Math.random().toString(36).slice(2, 8)}`;

  await prisma.club.create({
    data: {
      id: clubId, slug: clubId, name: `Test ${clubId}`, wordmark: clubId,
      timezone: "America/Edmonton", payrollProvince: "AB",
    },
  });
  await prisma.user.createMany({
    data: [
      { id: paAId,  email: `${paAId}@t.test`,  name: "PA A",  role: "PAYROLL_ADMIN", passwordHash: "x" },
      { id: paBId,  email: `${paBId}@t.test`,  name: "PA B",  role: "PAYROLL_ADMIN", passwordHash: "x" },
      { id: ctrlId, email: `${ctrlId}@t.test`, name: "Ctrl",  role: "CONTROLLER",    passwordHash: "x" },
      { id: multiId,email: `${multiId}@t.test`,name: "Multi", role: "CONTROLLER",    passwordHash: "x" },
    ],
  });
  await prisma.userClubRole.createMany({
    data: [
      { userId: paAId,  clubId, roleKey: "PAYROLL_ADMIN" },
      { userId: paBId,  clubId, roleKey: "PAYROLL_ADMIN" },
      { userId: ctrlId, clubId, roleKey: "CONTROLLER" },
      { userId: multiId, clubId, roleKey: "PAYROLL_ADMIN" },
      { userId: multiId, clubId, roleKey: "CONTROLLER" },
    ],
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
      preparedAt: new Date(), preparedByUserId: paAId,
      sourceSnapshotAt: new Date(),
      calculatedAt: new Date(), calculationVersion: 1,
      algorithmVersion: "test",
    },
  });
  const empId = `emp-${Math.random().toString(36).slice(2, 8)}`;
  await prisma.employee.create({
    data: {
      id: empId, clubId, firstName: "T", lastName: "E",
      employeeNumber: empId.slice(-8),
      hireDate: utc(2026, 1, 1), employeeLifecycle: "ACTIVE",
      timekeepingMethod: "NO_CLOCK",
      dateOfBirth: utc(1988, 1, 1),
    },
  });
  await prisma.payrollBatchEmployee.create({
    data: {
      id: `be-${Math.random().toString(36).slice(2, 8)}`,
      clubId, batchId, employeeId: empId,
      payGroupMemberId: `pgm-${Math.random().toString(36).slice(2, 8)}`,
      salaried: true, status: "INCLUDED",
      jurisdictionCountry: "CA", jurisdictionProvince: "AB",
      employeeLifecycleAtPrep: "ACTIVE",
      compensationReady: true, bankingReady: true, sinReady: true,
      federalTd1Ready: true, provincialTd1Ready: true,
      bankingStatus: "VERIFIED",
      membershipEffectiveFrom: utc(2026, 1, 1),
      dateOfBirthSnapshot: utc(1988, 1, 1),
      grossPay: "2000.00", netPay: "1500.00",
      totalEmployeeDeductions: "500.00",
      deductionCppEeCombined: "110.99", deductionCpp2Ee: "0",
      deductionEiEe: "32.60",
      deductionFederalTax: "177.36", deductionProvincialTax: "86.53",
      employerCppCombined: "110.99", employerCpp2: "0", employerEi: "45.64",
      sourceFactsJson: JSON.stringify({ schemaVersion: 1 }),
    },
  });
  await prisma.payrollClubConfig.upsert({
    where: { clubId },
    update: { payrollAdminUserId: paAId, controllerUserId: ctrlId },
    create: { clubId, payrollAdminUserId: paAId, controllerUserId: ctrlId, provinceOfEmployment: "AB" },
  });
  return { clubId, batchId, paAId, paBId, ctrlId, multiId };
}

describe("Payroll role governance hardening (v-slice-1-followup-4)", () => {
  it("PAYROLL_ADMIN role has payroll:submit but NOT payroll:approve / payroll:return", async () => {
    await seedRbac();
    const clubId = `club-${Math.random().toString(36).slice(2, 8)}`;
    await prisma.club.create({
      data: { id: clubId, slug: clubId, name: clubId, wordmark: clubId, timezone: "America/Edmonton", payrollProvince: "AB" },
    });
    const pa = principal(clubId, `pa-${Math.random().toString(36).slice(2, 8)}`, ["PAYROLL_ADMIN"]);
    expect(hasPermission(pa, clubId, "payroll:submit")).toBe(true);
    expect(hasPermission(pa, clubId, "payroll:prepare")).toBe(true);
    expect(hasPermission(pa, clubId, "payroll:edit")).toBe(true);
    expect(hasPermission(pa, clubId, "payroll:run")).toBe(true);
    // The governance-hole grants:
    expect(hasPermission(pa, clubId, "payroll:approve")).toBe(false);
    expect(hasPermission(pa, clubId, "payroll:return")).toBe(false);
    expect(hasPermission(pa, clubId, "payroll:post")).toBe(false);
  });

  it("CONTROLLER role has payroll:approve + payroll:return + payroll:post, but NOT payroll:submit / prepare / edit", async () => {
    await seedRbac();
    const clubId = `club-${Math.random().toString(36).slice(2, 8)}`;
    await prisma.club.create({
      data: { id: clubId, slug: clubId, name: clubId, wordmark: clubId, timezone: "America/Edmonton", payrollProvince: "AB" },
    });
    const ctrl = principal(clubId, `c-${Math.random().toString(36).slice(2, 8)}`, ["CONTROLLER"]);
    expect(hasPermission(ctrl, clubId, "payroll:approve")).toBe(true);
    expect(hasPermission(ctrl, clubId, "payroll:return")).toBe(true);
    expect(hasPermission(ctrl, clubId, "payroll:post")).toBe(true);
    expect(hasPermission(ctrl, clubId, "payroll:submit")).toBe(false);
    expect(hasPermission(ctrl, clubId, "payroll:prepare")).toBe(false);
    expect(hasPermission(ctrl, clubId, "payroll:edit")).toBe(false);
  });

  it("PAYROLL_ADMIN A can submit a CALCULATED batch (governance model preserved)", async () => {
    const s = await seedCalculatedBatch();
    const paA = principal(s.clubId, s.paAId, ["PAYROLL_ADMIN"]);
    await attestBatchReview(paA, s.clubId, s.batchId, "CALCULATED_PAYROLL");
    const r = await submitPayrollBatch(paA, s.clubId, s.batchId, { note: null });
    expect(r.status).toBe("SUBMITTED_FOR_APPROVAL");
    expect(r.submittedByUserId).toBe(s.paAId);
  });

  it("SECOND PAYROLL_ADMIN B cannot approve Payroll Admin A's submission — CLOSES GOVERNANCE HOLE", async () => {
    const s = await seedCalculatedBatch();
    const paA = principal(s.clubId, s.paAId, ["PAYROLL_ADMIN"]);
    const paB = principal(s.clubId, s.paBId, ["PAYROLL_ADMIN"]);
    await attestBatchReview(paA, s.clubId, s.batchId, "CALCULATED_PAYROLL");
    await submitPayrollBatch(paA, s.clubId, s.batchId, { note: null });

    // Pure PAYROLL_ADMIN B — after the fix — no longer carries
    // payroll:approve, so the permission gate refuses BEFORE the
    // same-actor SoD check has a chance to weigh in.
    await expect(approvePayrollBatch(paB, s.batchId)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("PAYROLL_ADMIN cannot return a submitted batch", async () => {
    const s = await seedCalculatedBatch();
    const paA = principal(s.clubId, s.paAId, ["PAYROLL_ADMIN"]);
    await attestBatchReview(paA, s.clubId, s.batchId, "CALCULATED_PAYROLL");
    await submitPayrollBatch(paA, s.clubId, s.batchId, { note: null });
    const paB = principal(s.clubId, s.paBId, ["PAYROLL_ADMIN"]);
    await expect(returnPayrollBatch(paB, s.clubId, s.batchId, "not eligible")).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("CONTROLLER can approve Payroll Admin A's submission", async () => {
    const s = await seedCalculatedBatch();
    const paA  = principal(s.clubId, s.paAId, ["PAYROLL_ADMIN"]);
    const ctrl = principal(s.clubId, s.ctrlId, ["CONTROLLER"]);
    await attestBatchReview(paA, s.clubId, s.batchId, "CALCULATED_PAYROLL");
    await submitPayrollBatch(paA, s.clubId, s.batchId, { note: null });

    const approved = await approvePayrollBatch(ctrl, s.batchId);
    expect(approved?.status).toBe("APPROVED");
    expect(approved?.approvedByUserId).toBe(s.ctrlId);
  });

  it("CONTROLLER can return Payroll Admin A's submission for correction", async () => {
    const s = await seedCalculatedBatch();
    const paA  = principal(s.clubId, s.paAId, ["PAYROLL_ADMIN"]);
    const ctrl = principal(s.clubId, s.ctrlId, ["CONTROLLER"]);
    await attestBatchReview(paA, s.clubId, s.batchId, "CALCULATED_PAYROLL");
    await submitPayrollBatch(paA, s.clubId, s.batchId, { note: null });

    const returned = await returnPayrollBatch(ctrl, s.clubId, s.batchId, "please recheck compensation");
    expect(returned.status).toBe("RETURNED_FOR_CORRECTION");
    expect(returned.returnedByUserId).toBe(s.ctrlId);
  });

  it("MULTI-ROLE PAYROLL_ADMIN + CONTROLLER carries both capabilities but same-actor SoD refuses self-approval", async () => {
    const s = await seedCalculatedBatch();
    const multi = principal(s.clubId, s.multiId, ["PAYROLL_ADMIN", "CONTROLLER"]);

    // Capabilities present.
    expect(hasPermission(multi, s.clubId, "payroll:submit")).toBe(true);
    expect(hasPermission(multi, s.clubId, "payroll:approve")).toBe(true);
    expect(hasPermission(multi, s.clubId, "payroll:return")).toBe(true);

    // Multi-role user submits + attempts to self-approve. Same-actor
    // SoD in approve-and-post.ts refuses even though the permission
    // capability is present.
    // Route the Controller preflight to the multi-role user for this
    // scenario (they are the "assigned Controller" on this synthetic
    // config), so submit's preflight succeeds.
    await prisma.payrollClubConfig.update({
      where: { clubId: s.clubId },
      data: { controllerUserId: s.multiId },
    });
    await attestBatchReview(multi, s.clubId, s.batchId, "CALCULATED_PAYROLL");
    await submitPayrollBatch(multi, s.clubId, s.batchId, { note: null });

    await expect(approvePayrollBatch(multi, s.batchId)).rejects.toBeInstanceOf(ApproveSegregationOfDutiesError);
  });
});
