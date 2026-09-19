// Slice F (2026-09-19) — hourly + overtime full-pipeline regression.
// Covers directive §11 example, §32 cross-period, §33 same-record
// pipeline, §34 A-V assertions, §35 rounding.

import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@/lib/prisma";
import { resetDb, seedRbac } from "./util/db";
import { createPayrollIntegrationFixture } from "./util/payroll-integration-fixture";
import { preparePayrollBatch } from "@/lib/payroll/batch-preparation";
import { calculatePayrollBatch } from "@/lib/payroll/calculation-execute";
import { attestBatchReview } from "@/lib/payroll/batch-review";
import { submitPayrollBatch } from "@/lib/payroll/submit-payroll-batch";
import { approvePayrollBatch, postPayrollBatch } from "@/lib/payroll/approve-and-post";
import { buildPayrollRegister } from "@/lib/payroll/payroll-register";
import { renderPayrollRegisterCsv } from "@/lib/payroll/payroll-register-csv";
import { ForbiddenError } from "@/lib/errors";

function utc(y: number, m: number, d: number): Date { return new Date(Date.UTC(y, m - 1, d)); }

describe("Slice F — hourly + overtime full pipeline", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("$22.50 hourly, 5 days × 10hr → 40 regular + 10 OT → gross $1,237.50", async () => {
    // §11 canonical example. Pay period is SM Sep 16-30 (payDate Sep 30).
    // We produce a workweek entirely inside the period: Sep 20 (Sun) - Sep 26 (Sat).
    // Actual 2026 DOWs: Sep 20 Sun, Sep 21 Mon..Sep 26 Sat.
    const s = await createPayrollIntegrationFixture({
      clubName: "SliceF §11 canonical",
      hourlyEmployee: {
        firstName: "Casey", lastName: "Hourly",
        hourlyRate: "22.50",
        approvedTime: [
          { workDate: utc(2026, 9, 21), hours: "10" },
          { workDate: utc(2026, 9, 22), hours: "10" },
          { workDate: utc(2026, 9, 23), hours: "10" },
          { workDate: utc(2026, 9, 24), hours: "10" },
          { workDate: utc(2026, 9, 25), hours: "10" },
        ],
      },
    });
    expect(s.hourly).toBeDefined();

    const prep = await preparePayrollBatch(s.paP, s.clubId, s.payPeriodId);
    const beHourly = await prisma.payrollBatchEmployee.findFirstOrThrow({
      where: { batchId: prep.batchId, employeeId: s.hourly!.employeeId },
    });
    // A. total approved hours preserved (50).
    expect(Number(beHourly.approvedHoursSnapshot!.toString())).toBeCloseTo(50, 2);
    // B. regular = 40 (5 × 8), C. overtime = 10 (5 × 2 daily OT).
    expect(Number(beHourly.regularHoursSnapshot!.toString())).toBeCloseTo(40, 2);
    expect(Number(beHourly.overtimeHoursSnapshot!.toString())).toBeCloseTo(10, 2);
    // E. base rate frozen.
    expect(Number(beHourly.hourlyBaseRateSnapshot!.toString())).toBeCloseTo(22.5, 2);
    // F. OT multiplier frozen.
    expect(Number(beHourly.overtimeMultiplierSnapshot!.toString())).toBeCloseTo(1.5, 2);
    // G. OT rate = 33.75.
    expect(Number(beHourly.overtimeRateSnapshot!.toString())).toBeCloseTo(33.75, 2);

    // Persisted earning rows.
    const earnings = await prisma.payrollBatchEarning.findMany({ where: { batchEmployeeId: beHourly.id } });
    const regRow = earnings.find((e) => e.earningType === "REGULAR");
    const otRow  = earnings.find((e) => e.earningType === "OVERTIME");
    expect(regRow, "REGULAR earning row").toBeDefined();
    expect(otRow,  "OVERTIME earning row").toBeDefined();
    // H. regular earnings exact: 40 × 22.50 = 900.
    expect(Number(regRow!.quantity.toString()) * Number(regRow!.rate.toString())).toBeCloseTo(900, 2);
    // I. overtime earnings exact: 10 × 33.75 = 337.50.
    expect(Number(otRow!.quantity.toString()) * Number(otRow!.rate.toString())).toBeCloseTo(337.50, 2);

    // Calculate.
    const calc = await calculatePayrollBatch(s.paP, s.clubId, prep.batchId);
    expect(calc.lifecycleStatus).toBe("CALCULATED");
    const beAfterCalc = await prisma.payrollBatchEmployee.findUniqueOrThrow({ where: { id: beHourly.id } });
    // J. gross exact: 900 + 337.50 = 1,237.50.
    expect(Number(beAfterCalc.grossPay!.toString())).toBeCloseTo(1237.50, 2);

    // Attest / Submit / Approve / Post (§34 U + V: PA posts after Controller approves).
    await attestBatchReview(s.paP, s.clubId, prep.batchId, "CALCULATED_PAYROLL");
    await submitPayrollBatch(s.paP, s.clubId, prep.batchId);
    await approvePayrollBatch(s.controllerP, prep.batchId);
    await expect(postPayrollBatch(s.controllerP, prep.batchId)).rejects.toBeInstanceOf(ForbiddenError);
    const post = await postPayrollBatch(s.paP, prep.batchId);
    expect(post.journalEntryId).toBeDefined();

    // M. Register distinguishes OT.
    const reg = await buildPayrollRegister(s.paP, s.clubId, prep.batchId);
    const hourlyRow = reg.employees.find((r) => r.batchEmployeeId === beHourly.id)!;
    expect(Number(hourlyRow.regularHours)).toBeCloseTo(40, 2);
    expect(Number(hourlyRow.overtimeHours)).toBeCloseTo(10, 2);
    expect(Number(hourlyRow.regularEarnings)).toBeCloseTo(900, 2);
    expect(Number(hourlyRow.overtimeEarnings)).toBeCloseTo(337.50, 2);
    // Register CSV also carries the OT column.
    const csv = renderPayrollRegisterCsv(reg);
    expect(csv).toMatch(/Overtime Hours/);
    expect(csv).toMatch(/Overtime Earnings/);
  });

  it("Rounding boundary (§35): $23.17/hr × 1.5 = $34.755 → freezes at 4dp, displays HALF_UP", async () => {
    // §35 canonical rounding case. Frozen OT rate must retain full
    // precision; display / posting must round HALF_UP.
    const s = await createPayrollIntegrationFixture({
      clubName: "SliceF §35 rounding",
      hourlyEmployee: {
        hourlyRate: "23.17",
        approvedTime: [
          // One 9-hour day → 8 regular + 1 OT. OT earning = 1 × 34.755
          // = $34.755 → HALF_UP → $34.76 when rendered at 2dp.
          { workDate: utc(2026, 9, 21), hours: "9" },
        ],
      },
    });
    const prep = await preparePayrollBatch(s.paP, s.clubId, s.payPeriodId);
    const beHourly = await prisma.payrollBatchEmployee.findFirstOrThrow({
      where: { batchId: prep.batchId, employeeId: s.hourly!.employeeId },
    });
    // Frozen rate carries full precision — no premature 2-dp rounding.
    // Prisma Decimal serializes trailing zeros away ("34.7550" → "34.755").
    expect(Number(beHourly.overtimeRateSnapshot!.toString())).toBe(34.755);
    expect(Number(beHourly.overtimeHoursSnapshot!.toString())).toBeCloseTo(1, 2);
    // Register requires CALCULATED status. Run Calculate before asserting display.
    await calculatePayrollBatch(s.paP, s.clubId, prep.batchId);
    const reg = await buildPayrollRegister(s.paP, s.clubId, prep.batchId);
    const row = reg.employees.find((r) => r.batchEmployeeId === beHourly.id)!;
    expect(row.overtimeEarnings).toBe("34.76");
  });

  it("Cross-period workweek (§32): OT allocated correctly across SM boundary", async () => {
    // Workweek Sep 20 (Sun) - Sep 26 (Sat), all inside SM period 18 [Sep 16, Oct 1).
    // But we need cross-period. Workweek Aug 30 (Sun) - Sep 5 (Sat), 10 hrs × 7 days = 70,
    // split 2:5 across periods 16 [Aug 16, Sep 1) and 17 [Sep 1, Sep 16).
    // Founder fixture defaults to seq 18 (Sep 16 → Oct 1). Use seq=16 for
    // the cross-period test.
    const s = await createPayrollIntegrationFixture({
      clubName: "SliceF §32 cross-period",
      targetSequence: 16, // Aug 16 → Sept 1 (payDate Aug 31)
      hourlyEmployee: {
        hourlyRate: "20.00",
        approvedTime: [
          { workDate: utc(2026, 8, 30), hours: "10" }, // Sun (workweek start)
          { workDate: utc(2026, 8, 31), hours: "10" }, // Mon
          { workDate: utc(2026, 9, 1),  hours: "10" }, // Tue
          { workDate: utc(2026, 9, 2),  hours: "10" }, // Wed
          { workDate: utc(2026, 9, 3),  hours: "10" }, // Thu
          { workDate: utc(2026, 9, 4),  hours: "10" }, // Fri
          { workDate: utc(2026, 9, 5),  hours: "10" }, // Sat (workweek end)
        ],
      },
    });
    const prep = await preparePayrollBatch(s.paP, s.clubId, s.payPeriodId);
    const beHourly = await prisma.payrollBatchEmployee.findFirstOrThrow({
      where: { batchId: prep.batchId, employeeId: s.hourly!.employeeId },
    });
    // Period 1 [Aug 16, Sep 1) contains days Aug 30, Aug 31.
    // Per §32 classifier proof: regular 16, overtime 4.
    expect(Number(beHourly.regularHoursSnapshot!.toString())).toBeCloseTo(16, 2);
    expect(Number(beHourly.overtimeHoursSnapshot!.toString())).toBeCloseTo(4, 2);
    expect(Number(beHourly.approvedHoursSnapshot!.toString())).toBeCloseTo(20, 2);
  });
});
