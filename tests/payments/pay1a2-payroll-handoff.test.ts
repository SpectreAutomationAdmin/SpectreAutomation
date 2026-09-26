// PAY-1A/2 — Payroll → Payments handoff integration.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { Prisma } from "@prisma/client";
import { db, resetDb, seedRbac, makeClub, makeUser, principalFor } from "../util/db";
import { preparePayrollPayments } from "@/lib/payments/payroll-source";

const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));

interface Fx {
  clubId: string;
  batchId: string;
  fundingBankAccountId: string;
  payrollAdmin: Awaited<ReturnType<typeof principalFor>>;
  controller: Awaited<ReturnType<typeof principalFor>>;
  employees: { employeeId: string; bankId: string; netPay: string }[];
}

async function fixture(opts: {
  employeeNetPays: string[];
  transactionType?: "STANDARD" | "CORRECTION" | "REVERSAL";
  batchStatus?: string;
  giveEmployeeBank?: boolean[];
}): Promise<Fx> {
  const c = db();
  const club = await makeClub("PAY-1A/2 Club " + Date.now());
  const paEmail = `pa-${Date.now()}-${Math.random().toString(36).slice(2)}@t.test`;
  const cEmail = `ctrl-${Date.now()}-${Math.random().toString(36).slice(2)}@t.test`;
  await makeUser({ email: paEmail, role: "PAYROLL_ADMIN", clubId: club.id });
  await makeUser({ email: cEmail, role: "CONTROLLER", clubId: club.id });
  const payrollAdmin = await principalFor(paEmail);
  const controller = await principalFor(cEmail);

  // Cash GL account for the funding bank.
  const cashAcct = await c.account.create({
    data: {
      clubId: club.id, accountNumber: "1010", name: "Operating Cash", type: "ASSET",
      normalBalance: "DEBIT", isBankAccount: true, isCashAccount: true, isActive: true,
      allowManualPosting: false, accountRole: "CASH",
    },
  });
  const bank = await c.bankAccount.create({
    data: {
      clubId: club.id, institutionReference: "TEST-BANK", displayName: "Operating Account",
      maskedIdentifier: "••••4821", currency: "CAD", status: "ACTIVE", glAccountId: cashAcct.id,
    },
  });

  // Pay group + period + batch.
  const payGroup = await c.payrollPayGroup.create({
    data: {
      clubId: club.id, code: `PG-${Date.now()}`, name: "Test Group",
      payFrequency: "BIWEEKLY", payDateOffsetDays: 5,
    },
  });
  const payPeriod = await c.payrollPayPeriod.create({
    data: {
      clubId: club.id, payGroupId: payGroup.id, taxYear: 2026, sequenceInYear: 1,
      periodStart: utc(2026, 9, 1), periodEnd: utc(2026, 9, 15),
      payDate: utc(2026, 9, 20), status: "OPEN",
    },
  });
  const batch = await c.payrollBatch.create({
    data: {
      clubId: club.id, payGroupId: payGroup.id, payPeriodId: payPeriod.id,
      status: opts.batchStatus ?? "POSTED",
      transactionType: opts.transactionType ?? "STANDARD",
      postedAt: new Date(),
      calculatedAt: new Date(), calculationVersion: 1,
    },
  });

  // Employees + bank + batch-employee rows.
  const employees: Fx["employees"] = [];
  for (let i = 0; i < opts.employeeNetPays.length; i++) {
    const emp = await c.employee.create({
      data: {
        clubId: club.id, employeeNumber: `E-${Date.now()}-${i}`,
        firstName: `Emp${i}`, lastName: "Test",
        email: `emp${i}-${Date.now()}@t.test`, status: "ACTIVE",
        employeeLifecycle: "ACTIVE",
      },
    });
    let bankId = "";
    const shouldBank = opts.giveEmployeeBank?.[i] ?? true;
    if (shouldBank) {
      const b = await c.employeeBankAccount.create({
        data: {
          clubId: club.id, employeeId: emp.id,
          institutionSecretRef: `kms:inst-${emp.id}`,
          transitSecretRef: `kms:tr-${emp.id}`,
          accountSecretRef: `kms:acct-${emp.id}`,
          accountLastFour: String(1000 + i).slice(-4),
          holderName: `${emp.firstName} Test`,
          status: "ACTIVE",
          activatedAt: new Date(),
        },
      });
      bankId = b.id;
    }
    await c.payrollBatchEmployee.create({
      data: {
        clubId: club.id, batchId: batch.id, employeeId: emp.id,
        jurisdictionCountry: "CA", jurisdictionProvince: "AB",
        employeeLifecycleAtPrep: "ACTIVE",
        bankingReady: shouldBank, sinReady: true,
        federalTd1Ready: true, provincialTd1Ready: true, compensationReady: true,
        status: "INCLUDED",
        netPay: new Prisma.Decimal(opts.employeeNetPays[i]),
      },
    });
    employees.push({ employeeId: emp.id, bankId, netPay: opts.employeeNetPays[i] });
  }
  return {
    clubId: club.id, batchId: batch.id, fundingBankAccountId: bank.id,
    payrollAdmin, controller, employees,
  };
}

describe("PAY-1A/2 · Payroll handoff · happy path", () => {
  beforeAll(async () => { await resetDb(); await seedRbac(); });
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("prepares a run whose instructions reconcile exactly to sum of frozen netPay", async () => {
    const fx = await fixture({ employeeNetPays: ["3037.33", "1200.00", "584.50"] });
    const result = await preparePayrollPayments(fx.payrollAdmin, {
      clubId: fx.clubId, payrollBatchId: fx.batchId,
      fundingBankAccountId: fx.fundingBankAccountId,
    });
    expect(result.instructionCount).toBe(3);
    expect(result.skippedZeroNet).toBe(0);
    expect(result.totalAmount).toBe("4821.83");

    const run = await db().paymentRun.findUnique({
      where: { id: result.runId },
      select: { totalAmount: true, status: true, instructionCount: true, sourceType: true, sourceId: true },
    });
    expect(run?.status).toBe("PREPARED");
    expect(run?.sourceType).toBe("PAYROLL");
    expect(run?.sourceId).toBe(fx.batchId);
    expect(new Prisma.Decimal(run!.totalAmount).toFixed(2)).toBe("4821.83");

    const instructions = await db().paymentInstruction.findMany({
      where: { runId: result.runId },
      select: { amount: true, recipientType: true, status: true, instructionFingerprint: true, destinationSnapshotId: true },
    });
    expect(instructions).toHaveLength(3);
    for (const i of instructions) {
      expect(i.recipientType).toBe("EMPLOYEE");
      expect(i.status).toBe("PREPARED");
      expect(i.instructionFingerprint).toMatch(/^ifp-v1-[0-9a-f]{64}$/);
      expect(i.destinationSnapshotId).toBeTruthy();
    }
  });

  it("skips zero-net employees (no instruction, still reconciles)", async () => {
    const fx = await fixture({ employeeNetPays: ["100.00", "0.00", "200.00"] });
    const result = await preparePayrollPayments(fx.payrollAdmin, {
      clubId: fx.clubId, payrollBatchId: fx.batchId,
      fundingBankAccountId: fx.fundingBankAccountId,
    });
    expect(result.instructionCount).toBe(2);
    expect(result.skippedZeroNet).toBe(1);
    expect(result.totalAmount).toBe("300.00");
  });
});

describe("PAY-1A/2 · Payroll handoff · failure modes", () => {
  beforeAll(async () => { await resetDb(); await seedRbac(); });
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("refuses a non-POSTED batch", async () => {
    const fx = await fixture({ employeeNetPays: ["100.00"], batchStatus: "APPROVED" });
    await expect(preparePayrollPayments(fx.payrollAdmin, {
      clubId: fx.clubId, payrollBatchId: fx.batchId,
      fundingBankAccountId: fx.fundingBankAccountId,
    })).rejects.toThrow(/not POSTED/);
  });

  it("refuses REVERSAL batches (no money-recovery in PAY-1A)", async () => {
    const fx = await fixture({ employeeNetPays: ["100.00"], transactionType: "REVERSAL" });
    await expect(preparePayrollPayments(fx.payrollAdmin, {
      clubId: fx.clubId, payrollBatchId: fx.batchId,
      fundingBankAccountId: fx.fundingBankAccountId,
    })).rejects.toThrow(/REVERSAL/);
  });

  it("refuses duplicate preparation for the same batch", async () => {
    const fx = await fixture({ employeeNetPays: ["100.00"] });
    await preparePayrollPayments(fx.payrollAdmin, {
      clubId: fx.clubId, payrollBatchId: fx.batchId,
      fundingBankAccountId: fx.fundingBankAccountId,
    });
    await expect(preparePayrollPayments(fx.payrollAdmin, {
      clubId: fx.clubId, payrollBatchId: fx.batchId,
      fundingBankAccountId: fx.fundingBankAccountId,
    })).rejects.toThrow(/PaymentRun already exists/);
  });

  it("fails closed on a non-zero-net employee with no active bank account", async () => {
    const fx = await fixture({
      employeeNetPays: ["100.00", "50.00"],
      giveEmployeeBank: [true, false],
    });
    await expect(preparePayrollPayments(fx.payrollAdmin, {
      clubId: fx.clubId, payrollBatchId: fx.batchId,
      fundingBankAccountId: fx.fundingBankAccountId,
    })).rejects.toThrow(/no ACTIVE bank account/);
  });

  it("Controller (no payment:prepare) cannot invoke", async () => {
    const fx = await fixture({ employeeNetPays: ["100.00"] });
    await expect(preparePayrollPayments(fx.controller, {
      clubId: fx.clubId, payrollBatchId: fx.batchId,
      fundingBankAccountId: fx.fundingBankAccountId,
    })).rejects.toThrow();
  });
});

describe("PAY-1A/2 · Payment-destination binding invariant", () => {
  beforeAll(async () => { await resetDb(); await seedRbac(); });
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("snapshot points to the SPECIFIC bank row at prepare time; later bank change does not redirect", async () => {
    const fx = await fixture({ employeeNetPays: ["100.00"] });
    const emp = fx.employees[0];
    const result = await preparePayrollPayments(fx.payrollAdmin, {
      clubId: fx.clubId, payrollBatchId: fx.batchId,
      fundingBankAccountId: fx.fundingBankAccountId,
    });
    const inst = await db().paymentInstruction.findFirstOrThrow({
      where: { runId: result.runId },
      select: { destinationSnapshotId: true },
    });
    const snap = await db().paymentDestinationSnapshot.findUniqueOrThrow({
      where: { id: inst.destinationSnapshotId },
      select: { sourceId: true, maskedIdentifier: true, institutionSecretRef: true, transitSecretRef: true, accountSecretRef: true },
    });
    expect(snap.sourceId).toBe(emp.bankId);
    const originalMasked = snap.maskedIdentifier;
    const originalInst = snap.institutionSecretRef;

    // Simulate the employee changing their bank AFTER preparation.
    await db().employeeBankAccount.update({
      where: { id: emp.bankId },
      data: { status: "INACTIVE" },
    });
    await db().employeeBankAccount.create({
      data: {
        clubId: fx.clubId, employeeId: emp.employeeId,
        institutionSecretRef: "kms:NEW-inst", transitSecretRef: "kms:NEW-tr",
        accountSecretRef: "kms:NEW-acct", accountLastFour: "9876",
        holderName: "Emp0 Test", status: "ACTIVE", activatedAt: new Date(),
      },
    });

    // Snapshot must NOT change.
    const after = await db().paymentDestinationSnapshot.findUniqueOrThrow({
      where: { id: inst.destinationSnapshotId },
      select: { sourceId: true, maskedIdentifier: true, institutionSecretRef: true },
    });
    expect(after.sourceId).toBe(emp.bankId);
    expect(after.maskedIdentifier).toBe(originalMasked);
    expect(after.institutionSecretRef).toBe(originalInst);
  });
});
