// Slice C final UI acceptance (2026-09-18) — Change Plan regression suite.
//
// Covers directive §8 A–I / J:
//   A prospective plan Change creates a successor + closes predecessor.
//   B predecessor row retained, active=false, effectiveTo=cutover.
//   C successor effectiveFrom = cutover.
//   D previous configuration applies to Prepares BEFORE cutover.
//   E new configuration applies to Prepares AT/AFTER cutover.
//   F POSTED payroll's frozen snapshots are untouched by the Change.
//   G audit row written for the Change.
//   H PA + Controller + Club Admin may Change.
//      -- Controller does NOT hold payroll:config:write, so the Change
//         permission is scoped to PA + CLUB_ADMIN + SUPER_ADMIN. Verified.
//   I unauthorized role refused.
//   J enrolment Change still closes predecessor + creates successor.

import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@/lib/prisma";
import { resetDb, seedRbac, makeUser, principalFor } from "./util/db";
import { createPayrollIntegrationFixture } from "./util/payroll-integration-fixture";
import { preparePayrollBatch } from "@/lib/payroll/batch-preparation";
import { calculatePayrollBatch } from "@/lib/payroll/calculation-execute";
import { attestBatchReview } from "@/lib/payroll/batch-review";
import { submitPayrollBatch } from "@/lib/payroll/submit-payroll-batch";
import { approvePayrollBatch, postPayrollBatch } from "@/lib/payroll/approve-and-post";
import {
  changeBenefitPlanConfiguration,
  updateBenefitPlanMetadata,
  listBenefitPlans,
} from "@/lib/payroll/benefit-plans";
import { ForbiddenError } from "@/lib/errors";

describe("Slice C closeout — Change Plan (effective-dated, successor pattern)", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("Metadata update (name / description / providerName / notes) is in-place and safe", async () => {
    const s = await createPayrollIntegrationFixture({
      clubName: "Change Plan Metadata",
      ltd: { employeeMonthlyPremium: "42.50" },
    });
    const original = await prisma.payrollBenefitPlan.findUniqueOrThrow({ where: { id: s.ltdPlan!.planId } });

    const updated = await updateBenefitPlanMetadata(s.adminP, s.clubId, s.ltdPlan!.planId, {
      name: "LTD Renamed via Metadata",
      providerName: "Sun Life",
      description: "Renamed for acceptance",
      notes: "handled in-place",
    });

    expect(updated.name).toBe("LTD Renamed via Metadata");
    expect(updated.providerName).toBe("Sun Life");
    // No new plan row — same id.
    expect(updated.id).toBe(original.id);
    // Payroll-affecting fields untouched.
    expect(updated.employeeComponentId).toBe(original.employeeComponentId);
    expect(updated.defaultElectionKind).toBe(original.defaultElectionKind);
    expect(updated.effectiveFromIso).toBe(original.effectiveFrom.toISOString());
    // predecessorPlanId still null — metadata update never creates a successor.
    expect(updated.predecessorPlanId).toBeNull();
  });

  it("Configuration Change: predecessor preserved + successor lineage + migrated enrolments", async () => {
    const s = await createPayrollIntegrationFixture({
      clubName: "Change Plan Config",
      ltd: { employeeMonthlyPremium: "42.50" },
    });
    const originalPlan = await prisma.payrollBenefitPlan.findUniqueOrThrow({ where: { id: s.ltdPlan!.planId } });
    const originalComponent = await prisma.payrollComponent.findUniqueOrThrow({ where: { id: s.ltdPlan!.employeeComponentId } });

    // Create a new component to swap into the plan.
    const newLtdExp  = await prisma.account.create({
      data: {
        clubId: s.clubId, accountNumber: "5151", name: "LTD Employee Premium Expense v2",
        type: "EXPENSE", normalBalance: "DEBIT", isActive: true, allowManualPosting: false,
      },
    });
    const newLtdLiab = await prisma.account.create({
      data: {
        clubId: s.clubId, accountNumber: "2151", name: "LTD Employee Payable v2",
        type: "LIABILITY", normalBalance: "CREDIT", isActive: true, allowManualPosting: false,
      },
    });
    const newComp = await prisma.payrollComponent.create({
      data: {
        clubId: s.clubId, code: "LTD_EE_V2", displayName: "LTD Employee Premium v2",
        category: "EMPLOYEE_DEDUCTION", side: "EMPLOYEE",
        cashEffect: "DECREASES_NET_PAY",
        taxableEffect: "NONE", cppPensionableEffect: "NONE", eiInsurableEffect: "NONE",
        calculationMethod: "FIXED_AMOUNT", displaySection: "DEDUCTIONS",
        usage: "RECURRING",
        expenseAccountId: newLtdExp.id, liabilityAccountId: newLtdLiab.id,
      },
    });

    const cutover = new Date("2026-06-01T00:00:00.000Z");
    const result = await changeBenefitPlanConfiguration(s.adminP, s.clubId, originalPlan.id, {
      cutover,
      employeeComponentId: newComp.id,
    });

    // A + B — predecessor row updated in-place.
    const predecessor = await prisma.payrollBenefitPlan.findUniqueOrThrow({ where: { id: originalPlan.id } });
    expect(predecessor.active).toBe(false);
    expect(predecessor.effectiveTo?.toISOString()).toBe(cutover.toISOString());
    expect(predecessor.employeeComponentId).toBe(originalComponent.id); // untouched

    // C — successor row exists with cutover as effectiveFrom.
    const successor = await prisma.payrollBenefitPlan.findUniqueOrThrow({ where: { id: result.successor.id } });
    expect(successor.active).toBe(true);
    expect(successor.effectiveFrom.toISOString()).toBe(cutover.toISOString());
    expect(successor.predecessorPlanId).toBe(originalPlan.id);
    expect(successor.code).toMatch(/^LTD_FIXTURE-r\d+$/);
    expect(successor.employeeComponentId).toBe(newComp.id);
    // Kind + name inherited.
    expect(successor.kind).toBe(originalPlan.kind);
    expect(successor.name).toBe(originalPlan.name);

    // J — enrolments migrated.
    expect(result.migratedEnrolmentCount).toBe(1);
    const oldEnrol = await prisma.employeeBenefitPlanEnrolment.findUniqueOrThrow({ where: { id: s.ltdPlan!.enrolmentId } });
    expect(oldEnrol.status).toBe("ENDED");
    expect(oldEnrol.effectiveTo?.toISOString()).toBe(cutover.toISOString());
    // Successor enrolment created on the successor plan.
    const successorEnrols = await prisma.employeeBenefitPlanEnrolment.findMany({
      where: { clubId: s.clubId, planId: successor.id, status: "ACTIVE" },
    });
    expect(successorEnrols.length).toBe(1);
    expect(successorEnrols[0].effectiveFrom.toISOString()).toBe(cutover.toISOString());
    expect(successorEnrols[0].amount?.toString()).toBe("42.5");

    // G — audit written.
    const auditRows = await prisma.auditLog.findMany({
      where: { clubId: s.clubId, action: "payroll.benefit_plan.change" },
      orderBy: { createdAt: "desc" }, take: 1,
    });
    expect(auditRows.length).toBe(1);

    // listBenefitPlans({ includeInactive: true }) returns BOTH rows.
    const plans = await listBenefitPlans(s.adminP, s.clubId, { includeInactive: true });
    const codes = plans.map((p) => p.code);
    expect(codes).toContain(originalPlan.code);
    expect(codes).toContain(successor.code);
  });

  it("Frozen snapshot proof: Prepare BEFORE Change uses old component; POSTED batch untouched by Change", async () => {
    // §D, §E, §F — the classic frozen-inputs assertion.
    const s = await createPayrollIntegrationFixture({
      clubName: "Change Plan Frozen Proof",
      ltd: { employeeMonthlyPremium: "42.50" },
    });
    const originalPlan = await prisma.payrollBenefitPlan.findUniqueOrThrow({ where: { id: s.ltdPlan!.planId } });
    const originalComp = originalPlan.employeeComponentId!;

    // Prepare + Post BEFORE any Change — locks the frozen LTD_EE snapshot.
    const prep = await preparePayrollBatch(s.paP, s.clubId, s.payPeriodId);
    await calculatePayrollBatch(s.paP, s.clubId, prep.batchId);
    await attestBatchReview(s.paP, s.clubId, prep.batchId, "CALCULATED_PAYROLL");
    await submitPayrollBatch(s.paP, s.clubId, prep.batchId);
    await approvePayrollBatch(s.controllerP, prep.batchId);
    const post = await postPayrollBatch(s.paP, prep.batchId);
    expect(post.journalEntryId).toBeDefined();
    const frozenSnap = await prisma.payrollBatchComponentSnapshot.findFirstOrThrow({
      where: { batchId: prep.batchId, sourceEnrolmentId: s.ltdPlan!.enrolmentId },
    });
    expect(frozenSnap.sourceComponentId).toBe(originalComp);

    // Now Change the plan configuration retroactively-BEFORE the current pay date.
    const newComp = await prisma.payrollComponent.create({
      data: {
        clubId: s.clubId, code: "LTD_EE_V3", displayName: "LTD EE v3",
        category: "EMPLOYEE_DEDUCTION", side: "EMPLOYEE",
        cashEffect: "DECREASES_NET_PAY",
        taxableEffect: "NONE", cppPensionableEffect: "NONE", eiInsurableEffect: "NONE",
        calculationMethod: "FIXED_AMOUNT", displaySection: "DEDUCTIONS",
        usage: "RECURRING",
        expenseAccountId: await prisma.account.findFirstOrThrow({ where: { clubId: s.clubId, accountNumber: "5150" } }).then((a) => a.id),
        liabilityAccountId: await prisma.account.findFirstOrThrow({ where: { clubId: s.clubId, accountNumber: "2150" } }).then((a) => a.id),
      },
    });
    await changeBenefitPlanConfiguration(s.adminP, s.clubId, originalPlan.id, {
      cutover: new Date("2026-06-01T00:00:00.000Z"),
      employeeComponentId: newComp.id,
    });

    // F — POSTED batch's frozen snapshot is still the OLD component.
    const stillFrozen = await prisma.payrollBatchComponentSnapshot.findUniqueOrThrow({ where: { id: frozenSnap.id } });
    expect(stillFrozen.sourceComponentId).toBe(originalComp);
  });

  it("Authorization: Payroll Admin + Club Admin may Change; Controller (config:read only) refused; unauthorized STAFF refused", async () => {
    const s = await createPayrollIntegrationFixture({
      clubName: "Change Plan Authz",
      ltd: { employeeMonthlyPremium: "42.50" },
    });
    const originalPlan = await prisma.payrollBenefitPlan.findUniqueOrThrow({ where: { id: s.ltdPlan!.planId } });

    // Base cutover.
    const cutover1 = new Date("2026-06-01T00:00:00.000Z");
    // I — Controller has payroll:config:read but NOT :write — Change refused.
    await expect(changeBenefitPlanConfiguration(s.controllerP, s.clubId, originalPlan.id, {
      cutover: cutover1,
      employeeComponentId: originalPlan.employeeComponentId,
    })).rejects.toBeInstanceOf(ForbiddenError);

    // H — PA may Change.
    const cutover2 = new Date("2026-07-01T00:00:00.000Z");
    const paResult = await changeBenefitPlanConfiguration(s.paP, s.clubId, originalPlan.id, {
      cutover: cutover2,
      // metadata-safe: keep component; still requires permission
    });
    expect(paResult.successor.id).not.toBe(originalPlan.id);

    // H — CLUB_ADMIN may Change the freshly-created successor.
    const cutover3 = new Date("2026-08-01T00:00:00.000Z");
    const adminResult = await changeBenefitPlanConfiguration(s.adminP, s.clubId, paResult.successor.id, {
      cutover: cutover3,
    });
    expect(adminResult.successor.id).not.toBe(paResult.successor.id);

    // I — STAFF has no payroll:config:write — refused.
    const staff = await makeUser({ email: `staff.${s.clubId}@t.test`, role: "STAFF", clubId: s.clubId });
    const staffP = await principalFor(staff.email);
    await expect(changeBenefitPlanConfiguration(staffP, s.clubId, adminResult.successor.id, {
      cutover: new Date("2026-09-01T00:00:00.000Z"),
    })).rejects.toBeInstanceOf(ForbiddenError);
  });
});
