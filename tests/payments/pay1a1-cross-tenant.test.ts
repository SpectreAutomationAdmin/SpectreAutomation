// PAY-1A.1 — cross-tenant integration coverage.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { Prisma } from "@prisma/client";
import { db, resetDb, seedRbac, makeClub, makeUser, principalFor } from "../util/db";
import { preparePayrollPayments } from "@/lib/payments/payroll-source";
import { submitForAuthorization, authorizePaymentRun, cancelPaymentRun } from "@/lib/payments/authorization";
import { scheduleAndSubmit, pollAndAdvance } from "@/lib/payments/submission";

const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));

async function makeTenantWithRun() {
  const c = db();
  const club = await makeClub("Tenant " + Math.random().toString(36).slice(2));
  const paEmail = `pa-${Math.random().toString(36).slice(2)}@t.test`;
  const cEmail = `ctrl-${Math.random().toString(36).slice(2)}@t.test`;
  await makeUser({ email: paEmail, role: "PAYROLL_ADMIN", clubId: club.id });
  await makeUser({ email: cEmail, role: "CONTROLLER", clubId: club.id });
  const pa = await principalFor(paEmail);
  const ctrl = await principalFor(cEmail);

  const cash = await c.account.create({
    data: {
      clubId: club.id, accountNumber: "1010", name: "Cash", type: "ASSET",
      normalBalance: "DEBIT", isBankAccount: true, isCashAccount: true, isActive: true,
      allowManualPosting: false, accountRole: "CASH",
    },
  });
  const bank = await c.bankAccount.create({
    data: {
      clubId: club.id, institutionReference: "T", displayName: "Ops",
      maskedIdentifier: "••••1", currency: "CAD", status: "ACTIVE", glAccountId: cash.id,
    },
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
      institutionSecretRef: "kms:i", transitSecretRef: "kms:t",
      accountSecretRef: "kms:a", accountLastFour: "9999", holderName: "E X",
      status: "ACTIVE", activatedAt: new Date(),
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
  });
  return { club, pa, ctrl, bank, batch, runId: prep.runId };
}

describe("PAY-1A.1 · Cross-tenant negative tests", () => {
  beforeAll(async () => { await resetDb(); await seedRbac(); });
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("Tenant B PA cannot prepare payments against Tenant A payroll batch", async () => {
    const A = await makeTenantWithRun();
    const B = await makeTenantWithRun();
    // B's PA tries to prepare against A's clubId + A's batchId — must be refused.
    await expect(preparePayrollPayments(B.pa, {
      clubId: A.club.id, payrollBatchId: A.batch.id, fundingBankAccountId: A.bank.id,
    })).rejects.toThrow();
    await expect(preparePayrollPayments(B.pa, {
      clubId: B.club.id, payrollBatchId: A.batch.id, fundingBankAccountId: B.bank.id,
    })).rejects.toThrow();
  });

  it("Tenant B Controller cannot authorize a Tenant A run", async () => {
    const A = await makeTenantWithRun();
    const B = await makeTenantWithRun();
    await submitForAuthorization(A.pa, A.runId);
    await expect(authorizePaymentRun(B.ctrl, A.runId)).rejects.toThrow();
    // A.runId still PENDING (not authorized).
    const r = await db().paymentRun.findUniqueOrThrow({ where: { id: A.runId }, select: { status: true } });
    expect(r.status).toBe("PENDING_AUTHORIZATION");
  });

  it("Tenant B PA cannot cancel a Tenant A run", async () => {
    const A = await makeTenantWithRun();
    const B = await makeTenantWithRun();
    await expect(cancelPaymentRun(B.pa, A.runId, "attempt")).rejects.toThrow();
    const r = await db().paymentRun.findUniqueOrThrow({ where: { id: A.runId }, select: { status: true } });
    expect(r.status).toBe("PREPARED");
  });

  it("Tenant B PA cannot submit a Tenant A run to the provider", async () => {
    const A = await makeTenantWithRun();
    const B = await makeTenantWithRun();
    await submitForAuthorization(A.pa, A.runId);
    await authorizePaymentRun(A.ctrl, A.runId);
    await expect(scheduleAndSubmit(B.pa, A.runId)).rejects.toThrow();
  });

  it("Tenant B poll cannot advance a Tenant A run (poll uses SYSTEM actor but requires no cross-tenant leak)", async () => {
    // pollAndAdvance takes no principal — it's a system operation. It
    // should never leak or corrupt cross-tenant data. Both A and B
    // runs can advance independently, but the provider state per
    // instruction is idempotencyKey-keyed by runId+instId — no leak
    // possible. This test proves polling A's run does not accidentally
    // touch B's data.
    const A = await makeTenantWithRun();
    const B = await makeTenantWithRun();
    await submitForAuthorization(A.pa, A.runId);
    await authorizePaymentRun(A.ctrl, A.runId);
    await scheduleAndSubmit(A.pa, A.runId);
    await pollAndAdvance(A.runId);
    // B's run should be untouched: still PREPARED with no provider references.
    const bInsts = await db().paymentInstruction.findMany({ where: { runId: B.runId }, select: { status: true, providerInstructionId: true } });
    for (const i of bInsts) {
      expect(i.status).toBe("PREPARED");
      expect(i.providerInstructionId).toBeNull();
    }
  });
});
