// PAY-1A.2 — retry-submit invariants.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { Prisma } from "@prisma/client";
import { db, resetDb, seedRbac, makeClub, makeUser, principalFor } from "../util/db";
import { preparePayrollPayments } from "@/lib/payments/payroll-source";
import { submitForAuthorization, authorizePaymentRun } from "@/lib/payments/authorization";
import { scheduleAndSubmit, retrySubmit, pollAndAdvance } from "@/lib/payments/submission";
import { getSimulator, resetSimulator } from "@/lib/payments/provider/simulator";

const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));

async function fx() {
  const c = db();
  const club = await makeClub("R " + Math.random().toString(36).slice(2));
  const paE = `pa-${Math.random().toString(36).slice(2)}@t.test`;
  const cE = `ctrl-${Math.random().toString(36).slice(2)}@t.test`;
  await makeUser({ email: paE, role: "PAYROLL_ADMIN", clubId: club.id });
  await makeUser({ email: cE, role: "CONTROLLER", clubId: club.id });
  const pa = await principalFor(paE);
  const ctrl = await principalFor(cE);
  const cash = await c.account.create({
    data: {
      clubId: club.id, accountNumber: "1010", name: "Cash", type: "ASSET",
      normalBalance: "DEBIT", isBankAccount: true, isCashAccount: true, isActive: true,
      allowManualPosting: false, accountRole: "CASH",
    },
  });
  const netPayable = await c.account.create({
    data: {
      clubId: club.id, accountNumber: "2100", name: "Net Pay Payable", type: "LIABILITY",
      normalBalance: "CREDIT", isActive: true, allowManualPosting: false,
    },
  });
  const salExp = await c.account.create({
    data: {
      clubId: club.id, accountNumber: "5100", name: "Salary", type: "EXPENSE",
      normalBalance: "DEBIT", isActive: true, allowManualPosting: false,
    },
  });
  await c.payrollGlAccountingProfile.create({
    data: {
      clubId: club.id,
      salaryExpenseAccountId: salExp.id,
      employerCppExpenseAccountId: salExp.id, employerEiExpenseAccountId: salExp.id,
      netPayPayableAccountId: netPayable.id,
      cppPayableAccountId: netPayable.id, eiPayableAccountId: netPayable.id,
      federalTaxPayableAccountId: netPayable.id, provincialTaxPayableAccountId: netPayable.id,
    },
  });
  const fy = await c.fiscalYear.create({
    data: { clubId: club.id, label: "FY", startDate: utc(2026, 1, 1), endDate: utc(2026, 12, 31), status: "OPEN" },
  });
  await c.fiscalPeriod.create({
    data: { clubId: club.id, fiscalYearId: fy.id, label: "M09", sequence: 9,
      startDate: utc(2026, 9, 1), endDate: utc(2026, 9, 30), status: "OPEN" },
  });
  const bank = await c.bankAccount.create({
    data: { clubId: club.id, institutionReference: "T", displayName: "Ops",
      maskedIdentifier: "••••1", currency: "CAD", status: "ACTIVE", glAccountId: cash.id },
  });
  const pg = await c.payrollPayGroup.create({
    data: { clubId: club.id, code: `PG-${Math.random().toString(36).slice(2)}`, name: "G", payFrequency: "BIWEEKLY", payDateOffsetDays: 5 },
  });
  const pp = await c.payrollPayPeriod.create({
    data: {
      clubId: club.id, payGroupId: pg.id, taxYear: 2026, sequenceInYear: 1,
      periodStart: utc(2026, 9, 1), periodEnd: utc(2026, 9, 15),
      payDate: utc(2026, 9, 20), status: "OPEN",
    },
  });
  const batch = await c.payrollBatch.create({
    data: {
      clubId: club.id, payGroupId: pg.id, payPeriodId: pp.id,
      status: "POSTED", transactionType: "STANDARD",
      postedAt: new Date(), calculatedAt: new Date(), calculationVersion: 1,
    },
  });
  const emp = await c.employee.create({
    data: {
      clubId: club.id, employeeNumber: "E-" + Math.random().toString(36).slice(2),
      firstName: "E", lastName: "X", email: `e-${Math.random().toString(36).slice(2)}@t.test`,
      status: "ACTIVE", employeeLifecycle: "ACTIVE",
    },
  });
  await c.employeeBankAccount.create({
    data: {
      clubId: club.id, employeeId: emp.id,
      institutionSecretRef: "kms:i", transitSecretRef: "kms:t", accountSecretRef: "kms:a",
      accountLastFour: "9999", holderName: "E X", status: "ACTIVE", activatedAt: new Date(),
    },
  });
  await c.payrollBatchEmployee.create({
    data: {
      clubId: club.id, batchId: batch.id, employeeId: emp.id,
      jurisdictionCountry: "CA", jurisdictionProvince: "AB",
      employeeLifecycleAtPrep: "ACTIVE",
      bankingReady: true, sinReady: true, federalTd1Ready: true,
      provincialTd1Ready: true, compensationReady: true, status: "INCLUDED",
      netPay: new Prisma.Decimal("100.00"),
    },
  });
  const prep = await preparePayrollPayments(pa, {
    clubId: club.id, payrollBatchId: batch.id, fundingBankAccountId: bank.id,
    requestedExecutionDate: utc(2026, 9, 20),
  });
  await submitForAuthorization(pa, prep.runId);
  await authorizePaymentRun(ctrl, prep.runId);
  return { club, pa, ctrl, bank, batch, runId: prep.runId };
}

describe("PAY-1A.2 · retrySubmit invariants", () => {
  beforeAll(async () => { await resetDb(); await seedRbac(); resetSimulator(); });
  beforeEach(async () => { await resetDb(); await seedRbac(); resetSimulator(); });

  it("timeout → retry: same instruction id, same idempotency key, one economic payment", async () => {
    const f = await fx();
    const inst = await db().paymentInstruction.findFirstOrThrow({ where: { runId: f.runId } });
    const originalId = inst.id;
    const originalFp = inst.instructionFingerprint;
    const idemKey = `run:${f.runId}:inst:${inst.id}`;

    const sim = getSimulator();
    sim.setDirective(idemKey, { kind: "TIMEOUT" });
    await scheduleAndSubmit(f.pa, f.runId);

    // After timeout: same instruction, no providerInstructionId, status SUBMITTING.
    const mid = await db().paymentInstruction.findUniqueOrThrow({ where: { id: originalId } });
    expect(mid.status).toBe("SUBMITTING");
    expect(mid.providerInstructionId).toBeNull();
    expect(mid.submissionAttempts).toBe(1);

    // Flip directive to accept and retry.
    sim.setDirective(idemKey, { kind: "ACCEPT_THEN_SETTLE" });
    const r = await retrySubmit(f.pa, f.runId);
    expect(r.attemptedInstructions).toBe(1);
    expect(r.submitted).toBe(1);
    expect(r.authorizationInvalidated).toBe(false);

    const after = await db().paymentInstruction.findUniqueOrThrow({ where: { id: originalId } });
    // Same PaymentInstruction identity.
    expect(after.id).toBe(originalId);
    expect(after.instructionFingerprint).toBe(originalFp);
    // Now has provider identity.
    expect(after.status).toBe("SUBMITTED");
    expect(after.providerInstructionId).not.toBeNull();
    expect(after.submissionAttempts).toBe(2);

    // Only one PaymentInstruction row exists for the run.
    const count = await db().paymentInstruction.count({ where: { runId: f.runId } });
    expect(count).toBe(1);
  });

  it("second retry after successful retry does NOT create another provider payment", async () => {
    const f = await fx();
    const inst = await db().paymentInstruction.findFirstOrThrow({ where: { runId: f.runId } });
    const idemKey = `run:${f.runId}:inst:${inst.id}`;
    const sim = getSimulator();
    sim.setDirective(idemKey, { kind: "TIMEOUT" });
    await scheduleAndSubmit(f.pa, f.runId);
    sim.setDirective(idemKey, { kind: "ACCEPT_THEN_SETTLE" });
    await retrySubmit(f.pa, f.runId);
    const first = await db().paymentInstruction.findUniqueOrThrow({ where: { id: inst.id } });
    const firstProviderId = first.providerInstructionId!;

    // The run is now SUBMITTED — retry-submit should refuse because the
    // run is no longer in SUBMITTING.
    await expect(retrySubmit(f.pa, f.runId)).rejects.toThrow(/requires run in SUBMITTING/);

    const stillOne = await db().paymentInstruction.findUniqueOrThrow({ where: { id: inst.id } });
    expect(stillOne.providerInstructionId).toBe(firstProviderId);
  });

  it("concurrent retries against the same timed-out instruction do NOT duplicate the provider payment", async () => {
    const f = await fx();
    const inst = await db().paymentInstruction.findFirstOrThrow({ where: { runId: f.runId } });
    const idemKey = `run:${f.runId}:inst:${inst.id}`;
    const sim = getSimulator();
    sim.setDirective(idemKey, { kind: "TIMEOUT" });
    await scheduleAndSubmit(f.pa, f.runId);
    sim.setDirective(idemKey, { kind: "ACCEPT_THEN_SETTLE" });

    // Two concurrent retries.
    const results = await Promise.allSettled([
      retrySubmit(f.pa, f.runId),
      retrySubmit(f.pa, f.runId),
    ]);
    // At least one succeeded.
    expect(results.some((r) => r.status === "fulfilled")).toBe(true);

    const finalInst = await db().paymentInstruction.findUniqueOrThrow({ where: { id: inst.id } });
    expect(finalInst.providerInstructionId).not.toBeNull();

    const insts = await db().paymentInstruction.count({ where: { runId: f.runId } });
    expect(insts).toBe(1);
  });

  it("no settlement JE on ambiguous timeout alone", async () => {
    const f = await fx();
    const inst = await db().paymentInstruction.findFirstOrThrow({ where: { runId: f.runId } });
    const idemKey = `run:${f.runId}:inst:${inst.id}`;
    const sim = getSimulator();
    sim.setDirective(idemKey, { kind: "TIMEOUT" });
    await scheduleAndSubmit(f.pa, f.runId);
    const jeCount = await db().journalEntry.count({ where: { clubId: f.club.id, source: "PAYMENTS" } });
    expect(jeCount).toBe(0);
  });

  it("timeout → retry → poll → SETTLED produces exactly one settlement JE", async () => {
    const f = await fx();
    const inst = await db().paymentInstruction.findFirstOrThrow({ where: { runId: f.runId } });
    const idemKey = `run:${f.runId}:inst:${inst.id}`;
    const sim = getSimulator();
    sim.setDirective(idemKey, { kind: "TIMEOUT" });
    await scheduleAndSubmit(f.pa, f.runId);
    sim.setDirective(idemKey, { kind: "ACCEPT_THEN_SETTLE" });
    await retrySubmit(f.pa, f.runId);
    await pollAndAdvance(f.runId);
    await pollAndAdvance(f.runId);
    const jes = await db().journalEntry.findMany({ where: { clubId: f.club.id, source: "PAYMENTS" } });
    expect(jes).toHaveLength(1);
    expect(new Prisma.Decimal(jes[0].totalDebits).eq(jes[0].totalCredits)).toBe(true);
  });

  it("material mutation before retry → authorization invalidated + retry refused", async () => {
    const f = await fx();
    const inst = await db().paymentInstruction.findFirstOrThrow({ where: { runId: f.runId } });
    const idemKey = `run:${f.runId}:inst:${inst.id}`;
    const sim = getSimulator();
    sim.setDirective(idemKey, { kind: "TIMEOUT" });
    await scheduleAndSubmit(f.pa, f.runId);

    // Mutate the run's totalAmount (a material field). This is
    // artificial for the test but simulates any material drift.
    await db().paymentRun.update({
      where: { id: f.runId },
      data: { totalAmount: new Prisma.Decimal("999.99") },
    });

    const r = await retrySubmit(f.pa, f.runId);
    expect(r.authorizationInvalidated).toBe(true);
    expect(r.attemptedInstructions).toBe(0);
    const auth = await db().paymentAuthorization.findUniqueOrThrow({ where: { runId: f.runId } });
    expect(auth.status).toBe("INVALIDATED");
    expect(auth.invalidatedReason).toBe("material-mutation-detected-on-retry");
  });

  it("retry against a non-SUBMITTING run is refused (e.g. PREPARED, AUTHORIZED, SUBMITTED)", async () => {
    const f = await fx();
    // Run is currently AUTHORIZED (never submitted).
    await expect(retrySubmit(f.pa, f.runId)).rejects.toThrow(/requires run in SUBMITTING/);
  });
});
