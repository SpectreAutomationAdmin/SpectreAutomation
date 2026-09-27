// PAY-1C/3 — payment limit evaluation (fail-closed).

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { Prisma } from "@prisma/client";
import { db, resetDb, seedRbac, makeClub } from "../util/db";
import { evaluatePaymentRunLimits, assertPaymentRunWithinLimits } from "@/lib/payments/limits";

async function seedMinimalRun(opts: { clubId: string; totalAmount: string; perInstruction: string[] }) {
  const c = db();
  const bankAcc = await c.account.create({
    data: {
      clubId: opts.clubId,
      accountNumber: "1010" + Math.floor(Math.random() * 1000),
      name: "Bank Ops", type: "ASSET", normalBalance: "DEBIT",
      isBankAccount: true, isCashAccount: true, isActive: true,
      allowManualPosting: false, accountRole: "CASH",
    },
  });
  const bank = await c.bankAccount.create({
    data: {
      clubId: opts.clubId, institutionReference: "SIM-0001",
      displayName: "Bank ***0001", maskedIdentifier: "***0001",
      currency: "CAD", status: "ACTIVE", glAccountId: bankAcc.id,
    },
  });
  const dest = await c.paymentDestinationSnapshot.create({
    data: {
      clubId: opts.clubId, recipientType: "EMPLOYEE",
      recipientId: "emp-1", sourceModel: "EmployeeBankAccount",
      sourceId: "eba-1", sourceVersion: 1,
      maskedIdentifier: "***0002",
      institutionSecretRef: "kms:i", transitSecretRef: "kms:t", accountSecretRef: "kms:a",
      currency: "CAD",
    },
  });
  const run = await c.paymentRun.create({
    data: {
      clubId: opts.clubId, runNumber: "PR-TEST-" + Math.floor(Math.random() * 100000),
      sourceType: "PAYROLL_BATCH", sourceId: null,
      fundingBankAccountId: bank.id, currency: "CAD",
      requestedExecutionDate: new Date("2026-12-30"),
      totalAmount: new Prisma.Decimal(opts.totalAmount),
      instructionCount: opts.perInstruction.length,
      status: "AUTHORIZED",
      createdByUserId: "user-1",
    },
  });
  for (const [i, amt] of opts.perInstruction.entries()) {
    await c.paymentInstruction.create({
      data: {
        clubId: opts.clubId, runId: run.id,
        sourceType: "PAYROLL_BATCH", sourceReference: `pay-1-${i}`,
        recipientType: "EMPLOYEE", recipientId: `emp-${i}`,
        amount: new Prisma.Decimal(amt), currency: "CAD",
        destinationSnapshotId: dest.id,
        requestedExecutionDate: new Date("2026-12-30"),
        status: "AUTHORIZED", instructionFingerprint: `ifp-${i}`,
        authorizedAt: new Date(),
      },
    });
  }
  return run;
}

describe("PAY-1C/3 · payment limits — fail closed", () => {
  beforeAll(async () => { await resetDb(); await seedRbac(); });
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("no limits configured => evaluation passes (baseline)", async () => {
    const club = await makeClub("PC3B " + Math.random().toString(36).slice(2));
    const run = await seedMinimalRun({ clubId: club.id, totalAmount: "500.00", perInstruction: ["250.00", "250.00"] });
    const r = await evaluatePaymentRunLimits({
      clubId: club.id, providerType: "SIMULATOR", runId: run.id, paymentType: "PAYROLL",
    });
    expect(r.ok).toBe(true);
    expect(r.breaches).toHaveLength(0);
  });

  it("PER_INSTRUCTION breach is detected and blocks submission", async () => {
    const club = await makeClub("PC3PI " + Math.random().toString(36).slice(2));
    const run = await seedMinimalRun({ clubId: club.id, totalAmount: "5000.00", perInstruction: ["4500.00", "500.00"] });
    await db().paymentLimit.create({
      data: {
        clubId: club.id, providerType: "SIMULATOR",
        kind: "PER_INSTRUCTION", currency: "CAD",
        amountLimit: new Prisma.Decimal("1000.00"), status: "ACTIVE",
      },
    });
    const r = await evaluatePaymentRunLimits({
      clubId: club.id, providerType: "SIMULATOR", runId: run.id, paymentType: "PAYROLL",
    });
    expect(r.ok).toBe(false);
    expect(r.breaches[0].kind).toBe("PER_INSTRUCTION");
    await expect(
      assertPaymentRunWithinLimits({
        clubId: club.id, providerType: "SIMULATOR", runId: run.id, paymentType: "PAYROLL",
      }),
    ).rejects.toThrow(/PER_INSTRUCTION/);
  });

  it("PER_RUN breach is detected", async () => {
    const club = await makeClub("PC3PR " + Math.random().toString(36).slice(2));
    const run = await seedMinimalRun({ clubId: club.id, totalAmount: "5000.00", perInstruction: ["2500.00", "2500.00"] });
    await db().paymentLimit.create({
      data: {
        clubId: club.id, providerType: null,
        kind: "PER_RUN", currency: "CAD",
        amountLimit: new Prisma.Decimal("2000.00"), status: "ACTIVE",
      },
    });
    const r = await evaluatePaymentRunLimits({
      clubId: club.id, providerType: "SIMULATOR", runId: run.id, paymentType: "PAYROLL",
    });
    expect(r.ok).toBe(false);
    expect(r.breaches[0].kind).toBe("PER_RUN");
  });

  it("PAYMENT_TYPE limit binds only when paymentType matches", async () => {
    const club = await makeClub("PC3PT " + Math.random().toString(36).slice(2));
    const run = await seedMinimalRun({ clubId: club.id, totalAmount: "5000.00", perInstruction: ["5000.00"] });
    await db().paymentLimit.create({
      data: {
        clubId: club.id, providerType: null,
        kind: "PAYMENT_TYPE", paymentType: "PAYROLL",
        currency: "CAD",
        amountLimit: new Prisma.Decimal("1000.00"), status: "ACTIVE",
      },
    });
    // PAYROLL => breach.
    const rPay = await evaluatePaymentRunLimits({
      clubId: club.id, providerType: "SIMULATOR", runId: run.id, paymentType: "PAYROLL",
    });
    expect(rPay.ok).toBe(false);
    // AP => not applicable => no breach.
    const rAp = await evaluatePaymentRunLimits({
      clubId: club.id, providerType: "SIMULATOR", runId: run.id, paymentType: "AP",
    });
    expect(rAp.ok).toBe(true);
  });

  it("retired limits are not enforced", async () => {
    const club = await makeClub("PC3R " + Math.random().toString(36).slice(2));
    const run = await seedMinimalRun({ clubId: club.id, totalAmount: "5000.00", perInstruction: ["5000.00"] });
    await db().paymentLimit.create({
      data: {
        clubId: club.id, providerType: null,
        kind: "PER_RUN", currency: "CAD",
        amountLimit: new Prisma.Decimal("100.00"), status: "RETIRED",
      },
    });
    const r = await evaluatePaymentRunLimits({
      clubId: club.id, providerType: "SIMULATOR", runId: run.id, paymentType: "PAYROLL",
    });
    expect(r.ok).toBe(true);
  });

  it("mismatched-currency limits never bind", async () => {
    const club = await makeClub("PC3C " + Math.random().toString(36).slice(2));
    const run = await seedMinimalRun({ clubId: club.id, totalAmount: "5000.00", perInstruction: ["5000.00"] });
    await db().paymentLimit.create({
      data: {
        clubId: club.id, providerType: null,
        kind: "PER_RUN", currency: "USD",
        amountLimit: new Prisma.Decimal("100.00"), status: "ACTIVE",
      },
    });
    const r = await evaluatePaymentRunLimits({
      clubId: club.id, providerType: "SIMULATOR", runId: run.id, paymentType: "PAYROLL",
    });
    expect(r.ok).toBe(true);
  });

  it("limit-failure exception is surfaced to Work Intake (WorkIntakeItem row created)", async () => {
    const club = await makeClub("PC3W " + Math.random().toString(36).slice(2));
    const run = await seedMinimalRun({ clubId: club.id, totalAmount: "500.00", perInstruction: ["500.00"] });
    await db().paymentLimit.create({
      data: {
        clubId: club.id, providerType: null,
        kind: "PER_RUN", currency: "CAD",
        amountLimit: new Prisma.Decimal("100.00"), status: "ACTIVE",
      },
    });
    await expect(
      assertPaymentRunWithinLimits({
        clubId: club.id, providerType: "SIMULATOR", runId: run.id, paymentType: "PAYROLL",
      }),
    ).rejects.toThrow(/PER_RUN/);
    const wi = await db().workIntakeItem.findFirst({
      where: { clubId: club.id, workSubtype: "PAYMENT_EXCEPTION_AMOUNT_MISMATCH" },
    });
    expect(wi).not.toBeNull();
  });
});
