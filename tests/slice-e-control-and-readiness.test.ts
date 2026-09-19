// Slice E (2026-09-19) — payroll control + first-pay readiness.
// Covers:
//   §5 (pay-date policy math)
//   §17-18 (NO_APPROVED_HOURS_FOR_HOURLY blocker + acknowledgement)
//   §15-16 (Work Intake deep-links)
//   §2-4 (Payroll Register DTO totals + GL reconciliation)

import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@/lib/prisma";
import { resetDb, seedRbac, makeUser, principalFor } from "./util/db";
import { createPayrollIntegrationFixture } from "./util/payroll-integration-fixture";
import { preparePayrollBatch } from "@/lib/payroll/batch-preparation";
import { calculatePayrollBatch } from "@/lib/payroll/calculation-execute";
import { attestBatchReview } from "@/lib/payroll/batch-review";
import { submitPayrollBatch } from "@/lib/payroll/submit-payroll-batch";
import { approvePayrollBatch, postPayrollBatch } from "@/lib/payroll/approve-and-post";
import { buildPayrollRegister } from "@/lib/payroll/payroll-register";
import { renderPayrollRegisterCsv } from "@/lib/payroll/payroll-register-csv";
import { acknowledgeZeroHours } from "@/lib/payroll/zero-hours-acknowledgement";
import { applyPayDateAdjustment } from "@/lib/payroll/pay-date-policy";
import { resolvePayrollWorkIntakeDeepLink } from "@/lib/payroll/work-intake-deep-link";

describe("Slice E — pay-date adjustment policy (§5)", () => {
  const sat = new Date(Date.UTC(2026, 9, 31)); // Sat Oct 31, 2026
  const sun = new Date(Date.UTC(2026, 5, 28)); // Sun Jun 28, 2026
  const wed = new Date(Date.UTC(2026, 5, 24)); // Wed Jun 24, 2026

  it("NONE keeps the raw date", () => {
    expect(applyPayDateAdjustment(sat, "NONE").toISOString()).toBe(sat.toISOString());
    expect(applyPayDateAdjustment(sun, "NONE").toISOString()).toBe(sun.toISOString());
    expect(applyPayDateAdjustment(wed, "NONE").toISOString()).toBe(wed.toISOString());
  });

  it("PREVIOUS_BUSINESS_DAY moves Sat/Sun to preceding Friday", () => {
    // Sat Oct 31 → Fri Oct 30
    expect(applyPayDateAdjustment(sat, "PREVIOUS_BUSINESS_DAY").toISOString()).toBe(new Date(Date.UTC(2026, 9, 30)).toISOString());
    // Sun Jun 28 → Fri Jun 26
    expect(applyPayDateAdjustment(sun, "PREVIOUS_BUSINESS_DAY").toISOString()).toBe(new Date(Date.UTC(2026, 5, 26)).toISOString());
    // Wed unchanged
    expect(applyPayDateAdjustment(wed, "PREVIOUS_BUSINESS_DAY").toISOString()).toBe(wed.toISOString());
  });

  it("NEXT_BUSINESS_DAY moves Sat/Sun to following Monday", () => {
    // Sat Oct 31 → Mon Nov 2
    expect(applyPayDateAdjustment(sat, "NEXT_BUSINESS_DAY").toISOString()).toBe(new Date(Date.UTC(2026, 10, 2)).toISOString());
    // Sun Jun 28 → Mon Jun 29
    expect(applyPayDateAdjustment(sun, "NEXT_BUSINESS_DAY").toISOString()).toBe(new Date(Date.UTC(2026, 5, 29)).toISOString());
  });
});

describe("Slice E — Work Intake deep-links (§15-16)", () => {
  it("PAYROLL_READY_TO_POST resolves to batch review", () => {
    const dl = resolvePayrollWorkIntakeDeepLink("PAYROLL_READY_TO_POST", "batch-xyz");
    expect(dl).not.toBeNull();
    expect(dl!.href).toBe("/app/admin/payroll/batches/batch-xyz");
    expect(dl!.label).toBe("Post approved payroll");
  });
  it("PAYROLL_RETURNED_FOR_CORRECTION resolves with ?returned=1 flag", () => {
    const dl = resolvePayrollWorkIntakeDeepLink("PAYROLL_RETURNED_FOR_CORRECTION", "batch-abc");
    expect(dl).not.toBeNull();
    expect(dl!.href).toBe("/app/admin/payroll/batches/batch-abc?returned=1");
  });
  it("Unknown subtype returns null", () => {
    expect(resolvePayrollWorkIntakeDeepLink("PAYROLL_UNKNOWN_X", "batch-xyz")).toBeNull();
  });
});

describe("Slice E — NO_APPROVED_HOURS_FOR_HOURLY blocker + acknowledgement (§17-18)", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("Fires BLOCKER when hourly employee has zero approved hours; ack resolves the exception", async () => {
    const s = await createPayrollIntegrationFixture({ clubName: "SliceE zero-hours" });
    // Convert the fixture employee to HOURLY: replace SALARY compensation.
    await prisma.employeeCompensation.deleteMany({ where: { employeeId: s.emp.id } });
    await prisma.employeeCompensation.create({
      data: {
        clubId: s.clubId, employeeId: s.emp.id, cadence: "HOURLY",
        rate: "20.00", currency: "CAD",
        effectiveFrom: new Date(Date.UTC(2020, 0, 1)),
      },
    });
    // Prepare — expect the batch to land as DRAFT with a NO_APPROVED_HOURS_FOR_HOURLY blocker.
    const prep = await preparePayrollBatch(s.paP, s.clubId, s.payPeriodId);
    const exceptions = await prisma.payrollBatchException.findMany({
      where: { batchId: prep.batchId },
    });
    const blocker = exceptions.find((e) => e.code === "NO_APPROVED_HOURS_FOR_HOURLY");
    expect(blocker, `expected NO_APPROVED_HOURS_FOR_HOURLY exception; got ${exceptions.map((e) => e.code).join(", ")}`).toBeDefined();
    expect(blocker!.severity).toBe("BLOCKER");

    // Ack the zero-hours case → exception resolves.
    const be = await prisma.payrollBatchEmployee.findFirstOrThrow({
      where: { batchId: prep.batchId, employeeId: s.emp.id },
    });
    await acknowledgeZeroHours(s.paP, s.clubId, {
      batchEmployeeId: be.id,
      reason: "UNPAID_LEAVE",
    });
    const after = await prisma.payrollBatchException.findFirst({
      where: { batchId: prep.batchId, code: "NO_APPROVED_HOURS_FOR_HOURLY" },
    });
    expect(after!.resolvedAt).not.toBeNull();
  });
});

describe("Slice E — Payroll Register DTO + totals + reconciliation (§2-4)", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("$110k SM salaried employee — CALCULATED register totals + reconciles", async () => {
    const s = await createPayrollIntegrationFixture({
      clubName: "SliceE register",
      annualSalary: "110000",
    });
    const prep = await preparePayrollBatch(s.paP, s.clubId, s.payPeriodId);
    await calculatePayrollBatch(s.paP, s.clubId, prep.batchId);
    await attestBatchReview(s.paP, s.clubId, prep.batchId, "CALCULATED_PAYROLL");
    await submitPayrollBatch(s.paP, s.clubId, prep.batchId);
    await approvePayrollBatch(s.controllerP, prep.batchId);
    await postPayrollBatch(s.paP, prep.batchId);

    const reg = await buildPayrollRegister(s.paP, s.clubId, prep.batchId);
    expect(reg.state).toBe("POSTED");
    expect(reg.statePosted).toBe(true);
    expect(reg.employees.length).toBe(1);
    const row = reg.employees[0]!;
    // Gross is the SM salary
    expect(Number(row.grossCashEarnings)).toBeCloseTo(4583.33, 2);
    // Totals row equals employee row
    expect(reg.totals.grossCashEarnings).toBe(row.grossCashEarnings);
    expect(reg.totals.netPay).toBe(row.netPay);
    // Reconciliation: Preview == Post so GL debits == GL credits
    expect(reg.reconciliation.differenceCents).toBe(0);

    // CSV export renders totals row
    const csv = renderPayrollRegisterCsv(reg);
    expect(csv).toContain(row.employeeName);
    expect(csv).toContain("TOTALS");
    expect(csv.split("\n").filter((l) => l.trim().length > 0).length).toBe(1 + reg.employees.length + 1);
  });
});

describe("Slice E — register security (§11)", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("Refuses register for a user without payroll:read", async () => {
    const s = await createPayrollIntegrationFixture({ clubName: "SliceE authz" });
    const prep = await preparePayrollBatch(s.paP, s.clubId, s.payPeriodId);
    await calculatePayrollBatch(s.paP, s.clubId, prep.batchId);
    const rando = await makeUser({ email: `rando.${s.clubId}@t.test`, role: "STAFF", clubId: s.clubId });
    const randoP = await principalFor(rando.email);
    await expect(buildPayrollRegister(randoP, s.clubId, prep.batchId)).rejects.toThrow(/Forbidden|permission/i);
  });
});
