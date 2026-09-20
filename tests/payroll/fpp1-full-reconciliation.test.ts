// FPP-1 (2026-09-20) §6 — full synthetic opening → payroll → closing YTD
// reconciliation.
//
// Proves the two invariants under founder scrutiny:
//   1. Aggregate: opening + current payroll = closing YTD  (no double-count)
//   2. Component: opening + current payroll = closing YTD, per Component
//                 (RRSP EE ≠ RRSP ER, Health ER ≠ any EE-side row,
//                  each POSTED contribution counted exactly once)
//
// Runs the actual pipeline (prepare → calculate → submit → approve → post)
// with an ACTIVE PRIOR_SYSTEM_SAME_EMPLOYER opening balance that includes
// non-zero component openings for Cell Phone, RRSP EE, RRSP ER, LTD_EE,
// and HEALTH_ER. The Club is placed in MID_YEAR_MIGRATION with
// firstSpectrePayDate = the batch's payDate so §2's throughPayDate <
// firstSpectrePayDate boundary is exercised.

import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@/lib/prisma";
import { resetDb, seedRbac } from "../util/db";
import { createPayrollIntegrationFixture } from "../util/payroll-integration-fixture";
import { preparePayrollBatch } from "@/lib/payroll/batch-preparation";
import { calculatePayrollBatch } from "@/lib/payroll/calculation-execute";
import { attestBatchReview } from "@/lib/payroll/batch-review";
import { submitPayrollBatch } from "@/lib/payroll/submit-payroll-batch";
import { approvePayrollBatch, postPayrollBatch } from "@/lib/payroll/approve-and-post";
import { getEmployeePayrollYtd } from "@/lib/payroll/ytd";
import { getEmployeeComponentYtd } from "@/lib/payroll/component-ytd";
import {
  createDraftOpeningBalance,
  activateOpeningBalance,
  addOpeningComponentBalance,
} from "@/lib/payroll/opening-balance";

const d = (y: number, m: number, day: number) => new Date(Date.UTC(y, m - 1, day));

describe("FPP-1 §6 — full synthetic opening → payroll → closing reconciliation", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("opening + current = closing (aggregate + per-component; RRSP EE/ER + LTD + Health/Dental + Cell Phone)", async () => {
    // 1) Fixture: salary $110k SM + RRSP 5%/100% match/3% cap + LTD $60 + Health $110 + Cell Phone $50.
    const s = await createPayrollIntegrationFixture({
      clubName: "FPP-1 §6 reconciliation",
      annualSalary: "110000",
      cellPhoneAmount: "50",
      rrsp: { employeePercent: 5, employerMatchPercent: 100, employerCapPercent: 3 },
      ltd: { employeeMonthlyPremium: "60" },
      healthDental: { employerMonthlyPremium: "110" },
    });

    // 2) The fixture uses ZERO_OPENING_YTD. Switch to MID_YEAR_MIGRATION
    //    with firstSpectrePayDate = the target period's payDate so §2's
    //    boundary is exercised (throughPayDate strictly before it).
    const period = await prisma.payrollPayPeriod.findUniqueOrThrow({ where: { id: s.payPeriodId } });
    await prisma.payrollImplementationDeclaration.update({
      where: { clubId_taxYear: { clubId: s.clubId, taxYear: 2026 } },
      data: { mode: "MID_YEAR_MIGRATION", firstSpectrePayDate: period.payDate },
    });

    // 3) Opening balance: throughPayDate = 15 days before payDate.
    const through = new Date(period.payDate);
    through.setUTCDate(through.getUTCDate() - 15);
    const openingAggregate = {
      ytdGrossEarnings: "80000",
      ytdTaxableEarnings: "79000",
      ytdPensionableEarnings: "78000",
      ytdInsurableEarnings: "78000",
      ytdCppEE_Base: "3300.00", ytdCppEE_FirstAdd: "600.00", ytdCppEE: "3900.00",
      ytdCpp2EE: "0",
      ytdEiEE: "1100.00",
      ytdFederalTax: "10000.00", ytdProvincialTax: "5500.00",
      ytdCppER_Base: "3300.00", ytdCppER_FirstAdd: "600.00", ytdCppER: "3900.00",
      ytdCpp2ER: "0",
      ytdEiER: "1540.00",
    };
    const draft = await createDraftOpeningBalance(s.paP, s.clubId, {
      employeeId: s.emp.id, taxYear: 2026,
      throughPayDate: through, values: openingAggregate,
      priorPayrollKind: "PRIOR_SYSTEM_SAME_EMPLOYER",
    });

    // 4) Component openings — one per fixture component.
    const OPENING_CELL     = "500";   // Cell Phone
    const OPENING_RRSP_EE  = "2000";  // Employee RRSP contribution history
    const OPENING_RRSP_ER  = "1200";  // Employer RRSP match history
    const OPENING_LTD      = "540";   // Employee LTD premium history
    const OPENING_HEALTH   = "990";   // Employer Health/Dental premium history

    await addOpeningComponentBalance(s.paP, s.clubId, {
      openingBalanceId: draft.id, componentId: s.cellPhone!.id, ytdAmount: OPENING_CELL,
    });
    await addOpeningComponentBalance(s.paP, s.clubId, {
      openingBalanceId: draft.id, componentId: s.rrspPlan!.employeeComponentId, ytdAmount: OPENING_RRSP_EE,
    });
    await addOpeningComponentBalance(s.paP, s.clubId, {
      openingBalanceId: draft.id, componentId: s.rrspPlan!.employerComponentId, ytdAmount: OPENING_RRSP_ER,
    });
    await addOpeningComponentBalance(s.paP, s.clubId, {
      openingBalanceId: draft.id, componentId: s.ltdPlan!.employeeComponentId, ytdAmount: OPENING_LTD,
    });
    await addOpeningComponentBalance(s.paP, s.clubId, {
      openingBalanceId: draft.id, componentId: s.healthPlan!.employerComponentId, ytdAmount: OPENING_HEALTH,
    });
    await activateOpeningBalance(s.paP, s.clubId, draft.id);

    // 5) Full pipeline for the target period.
    const prep = await preparePayrollBatch(s.paP, s.clubId, s.payPeriodId);
    const be = await prisma.payrollBatchEmployee.findFirstOrThrow({
      where: { batchId: prep.batchId, employeeId: s.emp.id },
    });
    const calc = await calculatePayrollBatch(s.paP, s.clubId, prep.batchId);
    expect(calc.lifecycleStatus, JSON.stringify(calc.blockers ?? [])).toBe("CALCULATED");
    await attestBatchReview(s.paP, s.clubId, prep.batchId, "CALCULATED_PAYROLL");
    await submitPayrollBatch(s.paP, s.clubId, prep.batchId);
    await approvePayrollBatch(s.controllerP, prep.batchId);
    const post = await postPayrollBatch(s.posterP, prep.batchId);
    expect(post.journalEntryId).toBeDefined();

    // 6) Snapshot the POSTED batch's per-line contributions for reconciliation.
    const currentBe = await prisma.payrollBatchEmployee.findUniqueOrThrow({ where: { id: be.id } });
    const currentSnaps = await prisma.payrollBatchComponentSnapshot.findMany({
      where: { batchEmployeeId: be.id },
    });
    const currentByCode = new Map<string, number>();
    for (const sn of currentSnaps) {
      if (sn.resolvedAmount == null) continue;
      const key = sn.componentCode;
      currentByCode.set(key, (currentByCode.get(key) ?? 0) + Number(sn.resolvedAmount.toString()));
    }

    // 7) Aggregate reconciliation — closing = opening + current, counted once.
    // asOfPayDate strictly AFTER the batch's payDate so it is INCLUDED.
    const asOf = new Date(period.payDate);
    asOf.setUTCDate(asOf.getUTCDate() + 1);
    const closingAgg = await getEmployeePayrollYtd(s.clubId, s.emp.id, asOf);
    const currentGross = Number(currentBe.grossPay!.toString());
    expect(Number(closingAgg.ytdGrossEarnings)).toBeCloseTo(
      Number(openingAggregate.ytdGrossEarnings) + currentGross, 2,
    );
    // Sanity: another read at asOfPayDate BEFORE the batch's payDate must
    // equal exactly the opening (proving the aggregator does not include
    // the current batch until asOf passes payDate — no double-count).
    const preBatch = await getEmployeePayrollYtd(s.clubId, s.emp.id, through /* < payDate */);
    expect(Number(preBatch.ytdGrossEarnings)).toBeCloseTo(Number(openingAggregate.ytdGrossEarnings), 2);

    // 8) Component reconciliation.
    const closingComp = await getEmployeeComponentYtd(s.clubId, s.emp.id, asOf);

    const rrspEeCurrent = currentByCode.get("RRSP_EE") ?? 0;
    const rrspErCurrent = currentByCode.get("RRSP_ER") ?? 0;
    const ltdCurrent    = currentByCode.get("LTD_EE") ?? 0;
    const healthCurrent = currentByCode.get("HEALTH_ER") ?? 0;
    const cellCurrent   = currentByCode.get("CELL_PHONE_ALLOWANCE") ?? 0;

    const rrspEeClosing = closingComp.byKey.get(s.rrspPlan!.employeeComponentId);
    const rrspErClosing = closingComp.byKey.get(s.rrspPlan!.employerComponentId);
    const ltdClosing    = closingComp.byKey.get(s.ltdPlan!.employeeComponentId);
    const healthClosing = closingComp.byKey.get(s.healthPlan!.employerComponentId);
    const cellClosing   = closingComp.byKey.get(s.cellPhone!.id);

    expect(rrspEeClosing, "RRSP EE row must exist").toBeTruthy();
    expect(rrspErClosing, "RRSP ER row must exist").toBeTruthy();
    expect(ltdClosing,    "LTD EE row must exist").toBeTruthy();
    expect(healthClosing, "HEALTH ER row must exist").toBeTruthy();
    expect(cellClosing,   "Cell Phone row must exist").toBeTruthy();

    // Identity — RRSP EE and RRSP ER MUST be distinct rows.
    expect(rrspEeClosing!.componentCode).toBe("RRSP_EE");
    expect(rrspErClosing!.componentCode).toBe("RRSP_ER");
    expect(rrspEeClosing!.side).toBe("EMPLOYEE");
    expect(rrspErClosing!.side).toBe("EMPLOYER");

    // Identity — Health ER (employer) is distinct from any employee-side row.
    expect(healthClosing!.side).toBe("EMPLOYER");
    expect(ltdClosing!.side).toBe("EMPLOYEE");

    // Reconciliation: opening + current = closing, per component.
    expect(Number(rrspEeClosing!.ytdAmount)).toBeCloseTo(Number(OPENING_RRSP_EE) + rrspEeCurrent, 2);
    expect(Number(rrspErClosing!.ytdAmount)).toBeCloseTo(Number(OPENING_RRSP_ER) + rrspErCurrent, 2);
    expect(Number(ltdClosing!.ytdAmount)).toBeCloseTo(Number(OPENING_LTD) + ltdCurrent, 2);
    expect(Number(healthClosing!.ytdAmount)).toBeCloseTo(Number(OPENING_HEALTH) + healthCurrent, 2);
    expect(Number(cellClosing!.ytdAmount)).toBeCloseTo(Number(OPENING_CELL) + cellCurrent, 2);

    // 9) No-double-count guard: aggregator called TWICE returns the same values.
    const closingAgain = await getEmployeePayrollYtd(s.clubId, s.emp.id, asOf);
    expect(closingAgain.ytdGrossEarnings).toBe(closingAgg.ytdGrossEarnings);
    const closingCompAgain = await getEmployeeComponentYtd(s.clubId, s.emp.id, asOf);
    expect(closingCompAgain.byKey.get(s.rrspPlan!.employeeComponentId)?.ytdAmount).toBe(rrspEeClosing!.ytdAmount);
  });
});
