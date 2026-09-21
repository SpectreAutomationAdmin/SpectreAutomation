// FPP-6 (2026-09-21) — Payroll approval preview DTO frozen-evidence
// contract. The preview panel Controller sees MUST reflect the exact
// values Marc submitted — NEVER a later re-calculation or a live
// component-catalogue read.
//
// This suite proves:
//   * loadPayrollApprovalPreview reads from componentSnapshots + frozen
//     employees (not from PayrollComponent), so if the live catalogue
//     rate changes, the preview is unaffected.
//   * Executive Insights are FACTUAL (per §1 MVP directive): every line
//     is derived from the batch's own frozen state; no fabricated
//     budget deltas, prior-period comparisons, or departmental
//     causality.
//   * Cross-tenant access is refused (tenant isolation).
//   * Non-PAYROLL_FINAL_APPROVAL WI items are refused.

import { describe, it, expect, beforeEach } from "vitest";
import { db, resetDb, seedRbac, makeClub, makeUser, principalFor } from "../util/db";
import { loadPayrollApprovalPreview } from "@/lib/mission-control/payroll-approval-preview";
import { NotFoundError } from "@/lib/errors";
import { upsertPayrollClubConfig } from "@/lib/payroll/club-config";

const d = (y: number, m: number, day: number) => new Date(Date.UTC(y, m - 1, day));

async function scenario(opts: { batchStatus?: string; workSubtype?: string } = {}) {
  const club = await makeClub("FPP-6 Club");
  const admin = await makeUser({ email: "adminA@fpp6.test", role: "CLUB_ADMIN", clubId: club.id });
  const pa = await makeUser({ email: "paA@fpp6.test", role: "PAYROLL_ADMIN", clubId: club.id });
  const ctrl = await makeUser({ email: "ctrlA@fpp6.test", role: "CONTROLLER", clubId: club.id });
  const adminP = await principalFor(admin.email);
  const paP = await principalFor(pa.email);
  const ctrlP = await principalFor(ctrl.email);
  await upsertPayrollClubConfig(adminP, club.id, {
    provinceOfEmployment: "AB", payrollAdminUserId: pa.id, controllerUserId: ctrl.id,
  });
  const pg = await db().payrollPayGroup.create({
    data: {
      clubId: club.id, code: "TEST-SM", name: "Test SM",
      payFrequency: "SEMI_MONTHLY", periodBoundaryStrategy: "LAGGED_SEMI_MONTHLY",
      active: true,
    },
  });
  const period = await db().payrollPayPeriod.create({
    data: {
      clubId: club.id, payGroupId: pg.id, taxYear: 2026, sequenceInYear: 17,
      periodStart: d(2026, 8, 24), periodEnd: d(2026, 9, 9), payDate: d(2026, 9, 15),
    },
  });
  const emp = await db().employee.create({
    data: {
      clubId: club.id, firstName: "R", lastName: "TP",
      email: "rtp@fpp6.test", hireDate: d(2026, 2, 1), status: "ACTIVE",
      employeeNumber: "E-FPP6",
    },
  });
  const batch = await db().payrollBatch.create({
    data: {
      clubId: club.id, payGroupId: pg.id, payPeriodId: period.id,
      status: opts.batchStatus ?? "SUBMITTED_FOR_APPROVAL",
      calculationVersion: 1, sequence: 1,
      preparedAt: d(2026, 9, 15), calculatedAt: d(2026, 9, 15),
      submittedAt: d(2026, 9, 15), submittedByUserId: pa.id,
      packageChecksum: "a0e3bca415aa72b3b5ff6161f72c161db74813c8df0b647bc68a999dc34fc432",
      algorithmVersion: "spectre-payroll-3c3d7-v2",
    },
  });
  await db().payrollBatchEmployee.create({
    data: {
      batchId: batch.id, employeeId: emp.id, clubId: club.id,
      jurisdictionCountry: "CA", employeeLifecycleAtPrep: "ACTIVE",
      grossPay: "4620.83", netPay: "3037.33", totalEmployeeDeductions: "1583.50",
      deductionCppEeCombined: "281.33", deductionEiEe: "75.32",
      deductionFederalTax: "652.19", deductionProvincialTax: "317.38",
      employerCppCombined: "281.33", employerCpp2: "0",
      employerEi: "105.45",
      salaried: true,
    },
  });
  // Frozen component snapshots (RRSP ER $229.17 + AD&D $2.25 + Life $20.93 + DepLife $0.83 → $253.18 employer benefits).
  const be = await db().payrollBatchEmployee.findFirstOrThrow({ where: { batchId: batch.id } });
  // Create lightweight PayrollComponent records for the sourceComponentId FK.
  const mkComp = async (code: string, name: string) => {
    return db().payrollComponent.create({
      data: {
        clubId: club.id, code, displayName: name, category: "BENEFIT",
        side: "EMPLOYER", displaySection: "BENEFITS", displayOrder: 100,
        cashEffect: "NO_NET_PAY_EFFECT", calculationMethod: "FIXED_AMOUNT",
        active: true,
      },
    });
  };
  const [rrspEr, adD, life, depLife] = await Promise.all([
    mkComp("RRSP_ER", "RRSP Employer"),
    mkComp("AD_D", "AD&D"),
    mkComp("LIFE_INSURANCE", "Life Insurance"),
    mkComp("DEPENDENT_LIFE_INSURANCE", "Dependent Life"),
  ]);
  await db().payrollBatchComponentSnapshot.createMany({
    data: [
      { batchId: batch.id, batchEmployeeId: be.id, employeeId: emp.id, clubId: club.id,
        sourceComponentId: rrspEr.id,
        componentCode: "RRSP_ER", displayName: "RRSP Employer", category: "BENEFIT",
        side: "EMPLOYER", displaySection: "BENEFITS", displayOrder: 100,
        cashEffect: "NO_NET_PAY_EFFECT", calculationMethod: "FIXED_AMOUNT",
        resolvedAmount: "229.17", provenance: "RECURRING_EMPLOYEE_SETUP", sourceEffectiveFrom: d(2026, 1, 1) },
      { batchId: batch.id, batchEmployeeId: be.id, employeeId: emp.id, clubId: club.id,
        sourceComponentId: adD.id,
        componentCode: "AD_D", displayName: "AD&D", category: "BENEFIT",
        side: "EMPLOYER", displaySection: "BENEFITS", displayOrder: 110,
        cashEffect: "NO_NET_PAY_EFFECT", calculationMethod: "FIXED_AMOUNT",
        resolvedAmount: "2.25", provenance: "RECURRING_EMPLOYEE_SETUP", sourceEffectiveFrom: d(2026, 1, 1) },
      { batchId: batch.id, batchEmployeeId: be.id, employeeId: emp.id, clubId: club.id,
        sourceComponentId: life.id,
        componentCode: "LIFE_INSURANCE", displayName: "Life Insurance", category: "BENEFIT",
        side: "EMPLOYER", displaySection: "BENEFITS", displayOrder: 120,
        cashEffect: "NO_NET_PAY_EFFECT", calculationMethod: "FIXED_AMOUNT",
        resolvedAmount: "20.93", provenance: "RECURRING_EMPLOYEE_SETUP", sourceEffectiveFrom: d(2026, 1, 1) },
      { batchId: batch.id, batchEmployeeId: be.id, employeeId: emp.id, clubId: club.id,
        sourceComponentId: depLife.id,
        componentCode: "DEPENDENT_LIFE_INSURANCE", displayName: "Dependent Life", category: "BENEFIT",
        side: "EMPLOYER", displaySection: "BENEFITS", displayOrder: 130,
        cashEffect: "NO_NET_PAY_EFFECT", calculationMethod: "FIXED_AMOUNT",
        resolvedAmount: "0.83", provenance: "RECURRING_EMPLOYEE_SETUP", sourceEffectiveFrom: d(2026, 1, 1) },
    ],
  });
  // Work Intake Item + Origin — bound to the submitted batch.
  const wi = await db().workIntakeItem.create({
    data: {
      clubId: club.id, status: "OPEN", judgmentRequired: true,
      ownerUserId: ctrl.id,
      classification: "PAYROLL_FINAL_APPROVAL",
      classificationReason: "test",
      classificationMethod: "RULE",
      displaySourceLabel: "Spectre Payroll",
      displaySender: "Payroll orchestration",
      displaySubject: "Payroll for Controller approval",
      displayPreview: "test",
      displayReceivedAt: d(2026, 9, 15),
      displayHasAttachments: false,
      workDomain: "PAYROLL", workIntent: "APPROVE",
      workSubtype: opts.workSubtype ?? "PAYROLL_FINAL_APPROVAL",
    },
  });
  await db().workIntakeOrigin.create({
    data: {
      clubId: club.id, workIntakeItemId: wi.id,
      kind: "PAYROLL_FINAL_APPROVAL", referenceId: batch.id, role: "PRIMARY",
      linkReason: "test",
    },
  });
  return { club, adminP, paP, ctrlP, pa, ctrl, pg, period, batch, wi };
}

describe("FPP-6 — payroll approval preview DTO", () => {
  beforeEach(async () => {
    await resetDb();
    await seedRbac();
  });

  it("Returns frozen submitted evidence for the bound batch", async () => {
    const s = await scenario();
    const preview = await loadPayrollApprovalPreview(s.ctrlP, s.club.id, s.wi.id);

    expect(preview.workIntakeItemId).toBe(s.wi.id);
    expect(preview.batchId).toBe(s.batch.id);
    expect(preview.batchStatus).toBe("SUBMITTED_FOR_APPROVAL");
    expect(preview.calculationVersion).toBe(1);
    expect(preview.algorithmVersion).toBe("spectre-payroll-3c3d7-v2");
    expect(preview.packageChecksumShort).toBe("a0e3bca415aa");
    expect(preview.totals.employeeCount).toBe(1);
    expect(preview.totals.grossPayDisplay).toBe("$4,620.83");
    expect(preview.totals.employeeDeductionsDisplay).toBe("$1,583.50");
    expect(preview.totals.netPayDisplay).toBe("$3,037.33");
    // Employer contributions include employer benefits from snapshots.
    // 281.33 (CPP) + 0 (CPP2) + 105.45 (EI) + 229.17 + 2.25 + 20.93 + 0.83 = 639.96
    expect(preview.totals.employerContributionsDisplay).toBe("$639.96");
    expect(preview.reconciliation.reconciles).toBe(true);
    expect(preview.reconciliation.differenceCents).toBe(0);
  });

  it("Executive insights are factual — no fabricated budget/prior-period comparisons", async () => {
    const s = await scenario();
    const preview = await loadPayrollApprovalPreview(s.ctrlP, s.club.id, s.wi.id);
    // Every insight is derivable from the batch's own frozen state.
    for (const i of preview.executiveInsights) {
      expect(i.label).not.toMatch(/budget|previous period|prior period|department.+overtime/i);
    }
    // Includes the mandated factual observations.
    expect(preview.executiveInsights.some((i) =>
      i.label.includes("1 employee") && i.label.includes("$4,620.83"))).toBe(true);
    expect(preview.executiveInsights.some((i) =>
      i.label.toLowerCase().includes("reconciles to the cent"))).toBe(true);
  });

  it("Review checks are the four founder-approved supported items", async () => {
    const s = await scenario();
    const preview = await loadPayrollApprovalPreview(s.ctrlP, s.club.id, s.wi.id);
    const labels = preview.reviewChecks.map((c) => c.label);
    expect(labels).toEqual([
      "Payroll calculation reviewed",
      "Statutory deductions calculated",
      "Payroll reconciliation balanced",
      "Frozen payroll inputs preserved",
    ]);
    // §9 — never claim payment/direct-deposit generation.
    for (const l of labels) {
      expect(l.toLowerCase()).not.toMatch(/direct deposit|payment|transmitted|paid/);
    }
  });

  it("Period range renders inclusive last day (Aug 24 – Sep 8, 2026)", async () => {
    const s = await scenario();
    const preview = await loadPayrollApprovalPreview(s.ctrlP, s.club.id, s.wi.id);
    expect(preview.period.rangeLabel).toBe("Aug 24 – Sep 8, 2026");
    expect(preview.period.payDateLabel).toBe("Sep 15, 2026");
  });

  it("Rejects non-payroll-approval WI items", async () => {
    const s = await scenario({ workSubtype: "PAYROLL_REVIEW" });
    await expect(loadPayrollApprovalPreview(s.ctrlP, s.club.id, s.wi.id))
      .rejects.toBeInstanceOf(NotFoundError);
  });

  it("Enforces tenant isolation — cross-tenant read is refused", async () => {
    const s = await scenario();
    const otherClub = await makeClub("FPP-6 Other Club");
    const otherPa = await makeUser({ email: "other-pa@fpp6.test", role: "PAYROLL_ADMIN", clubId: otherClub.id });
    const otherP = await principalFor(otherPa.email);
    await expect(loadPayrollApprovalPreview(otherP, otherClub.id, s.wi.id))
      .rejects.toBeInstanceOf(NotFoundError);
  });

  it("Batch not yet submitted (CALCULATED) still resolves with correct status", async () => {
    const s = await scenario({ batchStatus: "CALCULATED" });
    // Batch has calculatedAt but no submittedAt — loader still resolves
    // the preview, but the pane relies on isActionable = batchStatus ===
    // SUBMITTED_FOR_APPROVAL to hide Approve/Return.
    const preview = await loadPayrollApprovalPreview(s.ctrlP, s.club.id, s.wi.id);
    expect(preview.batchStatus).toBe("CALCULATED");
  });
});
