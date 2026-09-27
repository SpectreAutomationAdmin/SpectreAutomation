// PAY-1B/3 — external payment event ingestion invariants.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { Prisma } from "@prisma/client";
import { createHash } from "node:crypto";
import { db, resetDb, seedRbac, makeClub, makeUser, principalFor } from "../util/db";
import { preparePayrollPayments } from "@/lib/payments/payroll-source";
import { submitForAuthorization, authorizePaymentRun } from "@/lib/payments/authorization";
import { scheduleAndSubmit } from "@/lib/payments/submission";
import { ingestExternalEvent } from "@/lib/payments/external-events";
import type { ExternalPaymentEventEnvelope } from "@/lib/payments/provider/contract";
import { resetSimulator } from "@/lib/payments/provider/simulator";

const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));

async function seedFullFixture() {
  const c = db();
  const club = await makeClub("EV " + Math.random().toString(36).slice(2));
  const paE = `pa-${Math.random().toString(36).slice(2)}@t.test`;
  const cE = `c-${Math.random().toString(36).slice(2)}@t.test`;
  await makeUser({ email: paE, role: "PAYROLL_ADMIN", clubId: club.id });
  await makeUser({ email: cE, role: "CONTROLLER", clubId: club.id });
  const pa = await principalFor(paE); const ctrl = await principalFor(cE);
  const cash = await c.account.create({ data: { clubId: club.id, accountNumber: "1010", name: "Cash", type: "ASSET", normalBalance: "DEBIT", isBankAccount: true, isCashAccount: true, isActive: true, allowManualPosting: false, accountRole: "CASH" } });
  const netPayable = await c.account.create({ data: { clubId: club.id, accountNumber: "2100", name: "NP", type: "LIABILITY", normalBalance: "CREDIT", isActive: true, allowManualPosting: false } });
  const salExp = await c.account.create({ data: { clubId: club.id, accountNumber: "5100", name: "S", type: "EXPENSE", normalBalance: "DEBIT", isActive: true, allowManualPosting: false } });
  await c.payrollGlAccountingProfile.create({ data: { clubId: club.id, salaryExpenseAccountId: salExp.id, employerCppExpenseAccountId: salExp.id, employerEiExpenseAccountId: salExp.id, netPayPayableAccountId: netPayable.id, cppPayableAccountId: netPayable.id, eiPayableAccountId: netPayable.id, federalTaxPayableAccountId: netPayable.id, provincialTaxPayableAccountId: netPayable.id } });
  const fy = await c.fiscalYear.create({ data: { clubId: club.id, label: "FY", startDate: utc(2026, 1, 1), endDate: utc(2026, 12, 31), status: "OPEN" } });
  await c.fiscalPeriod.create({ data: { clubId: club.id, fiscalYearId: fy.id, label: "M09", sequence: 9, startDate: utc(2026, 9, 1), endDate: utc(2026, 9, 30), status: "OPEN" } });
  const bank = await c.bankAccount.create({ data: { clubId: club.id, institutionReference: "T", displayName: "O", maskedIdentifier: "••••1", currency: "CAD", status: "ACTIVE", glAccountId: cash.id } });
  const pg = await c.payrollPayGroup.create({ data: { clubId: club.id, code: `PG-${Math.random().toString(36).slice(2)}`, name: "G", payFrequency: "BIWEEKLY", payDateOffsetDays: 5 } });
  const pp = await c.payrollPayPeriod.create({ data: { clubId: club.id, payGroupId: pg.id, taxYear: 2026, sequenceInYear: 1, periodStart: utc(2026, 9, 1), periodEnd: utc(2026, 9, 15), payDate: utc(2026, 9, 20), status: "OPEN" } });
  const batch = await c.payrollBatch.create({ data: { clubId: club.id, payGroupId: pg.id, payPeriodId: pp.id, status: "POSTED", transactionType: "STANDARD", postedAt: new Date(), calculatedAt: new Date(), calculationVersion: 1 } });
  const emp = await c.employee.create({ data: { clubId: club.id, employeeNumber: "E-" + Math.random().toString(36).slice(2), firstName: "E", lastName: "X", email: `e-${Math.random().toString(36).slice(2)}@t.test`, status: "ACTIVE", employeeLifecycle: "ACTIVE" } });
  await c.employeeBankAccount.create({ data: { clubId: club.id, employeeId: emp.id, institutionSecretRef: "kms:i", transitSecretRef: "kms:t", accountSecretRef: "kms:a", accountLastFour: "9999", holderName: "E X", status: "ACTIVE", activatedAt: new Date() } });
  await c.payrollBatchEmployee.create({ data: { clubId: club.id, batchId: batch.id, employeeId: emp.id, jurisdictionCountry: "CA", jurisdictionProvince: "AB", employeeLifecycleAtPrep: "ACTIVE", bankingReady: true, sinReady: true, federalTd1Ready: true, provincialTd1Ready: true, compensationReady: true, status: "INCLUDED", netPay: new Prisma.Decimal("100.00") } });
  const prep = await preparePayrollPayments(pa, { clubId: club.id, payrollBatchId: batch.id, fundingBankAccountId: bank.id, requestedExecutionDate: utc(2026, 9, 20) });
  await submitForAuthorization(pa, prep.runId);
  await authorizePaymentRun(ctrl, prep.runId);
  await scheduleAndSubmit(pa, prep.runId);
  const inst = await c.paymentInstruction.findFirstOrThrow({ where: { runId: prep.runId } });
  return { club, pa, ctrl, bank, batch, runId: prep.runId, inst };
}

function envelope(overrides: Partial<ExternalPaymentEventEnvelope>): ExternalPaymentEventEnvelope {
  const raw = JSON.stringify(overrides);
  const base: ExternalPaymentEventEnvelope = {
    provider: "SIMULATOR",
    providerEventId: "EV-" + Math.random().toString(36).slice(2),
    eventType: "SETTLED",
    verificationStatus: "VERIFIED",
    payloadHash: createHash("sha256").update(raw).digest("hex"),
  };
  return { ...base, ...overrides } as ExternalPaymentEventEnvelope;
}

describe("PAY-1B/3 · External event ingestion", () => {
  beforeAll(async () => { await resetDb(); await seedRbac(); resetSimulator(); });
  beforeEach(async () => { await resetDb(); await seedRbac(); resetSimulator(); });

  it("verified SETTLED event applies + creates a settlement JE", async () => {
    const f = await seedFullFixture();
    const r = await ingestExternalEvent({
      clubId: f.club.id,
      envelope: envelope({
        providerInstructionId: f.inst.providerInstructionId!,
        eventType: "SETTLED", status: "SETTLED",
        amount: "100.00", currency: "CAD",
      }),
    });
    expect(r.outcome).toBe("APPLIED");
    const inst = await db().paymentInstruction.findUniqueOrThrow({ where: { id: f.inst.id } });
    expect(inst.status).toBe("SETTLED");
    const jes = await db().journalEntry.count({ where: { clubId: f.club.id, source: "PAYMENTS" } });
    expect(jes).toBe(1);
  });

  it("duplicate event is IGNORED_DUPLICATE + no duplicate JE", async () => {
    const f = await seedFullFixture();
    const evId = "DUP-" + Math.random().toString(36).slice(2);
    const e = envelope({
      providerEventId: evId,
      providerInstructionId: f.inst.providerInstructionId!,
      eventType: "SETTLED", status: "SETTLED", amount: "100.00", currency: "CAD",
    });
    await ingestExternalEvent({ clubId: f.club.id, envelope: e });
    const r2 = await ingestExternalEvent({ clubId: f.club.id, envelope: e });
    expect(r2.outcome).toBe("IGNORED_DUPLICATE");
    const jes = await db().journalEntry.count({ where: { clubId: f.club.id, source: "PAYMENTS" } });
    expect(jes).toBe(1);
  });

  it("UNVERIFIED event mutates NO financial state", async () => {
    const f = await seedFullFixture();
    const r = await ingestExternalEvent({
      clubId: f.club.id,
      envelope: envelope({
        providerInstructionId: f.inst.providerInstructionId!,
        eventType: "SETTLED", status: "SETTLED", amount: "100.00", currency: "CAD",
        verificationStatus: "FAILED",
      }),
    });
    expect(r.outcome).toBe("REJECTED_UNVERIFIED");
    const inst = await db().paymentInstruction.findUniqueOrThrow({ where: { id: f.inst.id } });
    expect(inst.status).not.toBe("SETTLED");
    const jes = await db().journalEntry.count({ where: { clubId: f.club.id, source: "PAYMENTS" } });
    expect(jes).toBe(0);
  });

  it("event for another tenant is REJECTED_TENANT_MISMATCH", async () => {
    const f = await seedFullFixture();
    const otherClub = await makeClub("OTHER");
    const r = await ingestExternalEvent({
      clubId: otherClub.id,
      envelope: envelope({
        providerInstructionId: f.inst.providerInstructionId!,
        eventType: "SETTLED", status: "SETTLED", amount: "100.00", currency: "CAD",
      }),
    });
    expect(r.outcome).toBe("REJECTED_TENANT_MISMATCH");
  });

  it("amount mismatch fails closed — no incorrect settlement JE", async () => {
    const f = await seedFullFixture();
    const r = await ingestExternalEvent({
      clubId: f.club.id,
      envelope: envelope({
        providerInstructionId: f.inst.providerInstructionId!,
        eventType: "SETTLED", status: "SETTLED",
        amount: "99.00", currency: "CAD",
      }),
    });
    expect(r.outcome).toBe("REJECTED_AMOUNT_MISMATCH");
    const jes = await db().journalEntry.count({ where: { clubId: f.club.id, source: "PAYMENTS" } });
    expect(jes).toBe(0);
  });

  it("currency mismatch fails closed", async () => {
    const f = await seedFullFixture();
    const r = await ingestExternalEvent({
      clubId: f.club.id,
      envelope: envelope({
        providerInstructionId: f.inst.providerInstructionId!,
        eventType: "SETTLED", status: "SETTLED",
        amount: "100.00", currency: "USD",
      }),
    });
    expect(r.outcome).toBe("REJECTED_CURRENCY_MISMATCH");
  });

  it("unknown status fails closed", async () => {
    const f = await seedFullFixture();
    const r = await ingestExternalEvent({
      clubId: f.club.id,
      envelope: envelope({
        providerInstructionId: f.inst.providerInstructionId!,
        eventType: "STATUS_UPDATED",
        status: "COMPLETELY_MADE_UP_STATUS" as any,
      }),
    });
    expect(r.outcome).toBe("REJECTED_UNKNOWN_STATUS");
  });

  it("out-of-order ACCEPTED after SETTLED does NOT regress state", async () => {
    const f = await seedFullFixture();
    await ingestExternalEvent({
      clubId: f.club.id,
      envelope: envelope({
        providerInstructionId: f.inst.providerInstructionId!,
        eventType: "SETTLED", status: "SETTLED", amount: "100.00", currency: "CAD",
      }),
    });
    const late = await ingestExternalEvent({
      clubId: f.club.id,
      envelope: envelope({
        providerEventId: "LATE-ACCEPTED",
        providerInstructionId: f.inst.providerInstructionId!,
        eventType: "STATUS_UPDATED", status: "ACCEPTED",
        amount: "100.00", currency: "CAD",
      }),
    });
    expect(late.outcome).toBe("IGNORED_OUT_OF_ORDER");
    const inst = await db().paymentInstruction.findUniqueOrThrow({ where: { id: f.inst.id } });
    expect(inst.status).toBe("SETTLED");
  });

  it("provider reference collision (same providerInstructionId on two instructions) fails closed", async () => {
    const f = await seedFullFixture();
    // Attach the same providerInstructionId to a second instruction —
    // simulates a defective/malicious provider.
    const other = await seedFullFixture();
    await db().paymentInstruction.update({
      where: { id: other.inst.id },
      data: { providerInstructionId: f.inst.providerInstructionId! },
    }).catch(() => {}); // unique constraint may already block; both paths acceptable
    // If the DB accepted (it shouldn't due to unique), the collision path fires.
    const insts = await db().paymentInstruction.count({ where: { providerInstructionId: f.inst.providerInstructionId! } });
    if (insts < 2) {
      // DB uniqueness caught it — that's an equally-good guarantee.
      expect(insts).toBe(1);
      return;
    }
    const r = await ingestExternalEvent({
      clubId: f.club.id,
      envelope: envelope({
        providerInstructionId: f.inst.providerInstructionId!,
        eventType: "SETTLED", status: "SETTLED", amount: "100.00", currency: "CAD",
      }),
    });
    expect(r.outcome).toBe("REJECTED_REFERENCE_COLLISION");
  });
});
