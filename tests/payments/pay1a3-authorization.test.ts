// PAY-1A/3 — Authorization + Work Intake + SoD.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { Prisma } from "@prisma/client";
import { db, resetDb, seedRbac, makeClub, makeUser, principalFor } from "../util/db";
import { preparePayrollPayments } from "@/lib/payments/payroll-source";
import {
  submitForAuthorization,
  authorizePaymentRun,
  returnPaymentRun,
  cancelPaymentRun,
  invalidateAuthorization,
} from "@/lib/payments/authorization";

const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));

async function makeFixture(netPays: string[] = ["100.00", "200.00"]) {
  const c = db();
  const club = await makeClub("PAY-1A/3 " + Date.now());
  const paEmail = `pa-${Date.now()}@t.test`;
  const cEmail = `ctrl-${Date.now()}@t.test`;
  const clubAdminEmail = `admin-${Date.now()}@t.test`;
  await makeUser({ email: paEmail, role: "PAYROLL_ADMIN", clubId: club.id });
  await makeUser({ email: cEmail, role: "CONTROLLER", clubId: club.id });
  await makeUser({ email: clubAdminEmail, role: "CLUB_ADMIN", clubId: club.id });
  const pa = await principalFor(paEmail);
  const ctrl = await principalFor(cEmail);
  const admin = await principalFor(clubAdminEmail);

  const cashAcct = await c.account.create({
    data: {
      clubId: club.id, accountNumber: "1010", name: "Cash", type: "ASSET",
      normalBalance: "DEBIT", isBankAccount: true, isCashAccount: true, isActive: true,
      allowManualPosting: false, accountRole: "CASH",
    },
  });
  const bank = await c.bankAccount.create({
    data: {
      clubId: club.id, institutionReference: "TEST", displayName: "Ops",
      maskedIdentifier: "••••1234", currency: "CAD", status: "ACTIVE", glAccountId: cashAcct.id,
    },
  });
  const payGroup = await c.payrollPayGroup.create({
    data: { clubId: club.id, code: `PG-${Date.now()}`, name: "G", payFrequency: "BIWEEKLY", payDateOffsetDays: 5 },
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
      status: "POSTED", transactionType: "STANDARD",
      postedAt: new Date(), calculatedAt: new Date(), calculationVersion: 1,
    },
  });
  for (let i = 0; i < netPays.length; i++) {
    const emp = await c.employee.create({
      data: {
        clubId: club.id, employeeNumber: `E-${Date.now()}-${i}`,
        firstName: `E${i}`, lastName: "X", email: `e${i}-${Date.now()}@t.test`,
        status: "ACTIVE", employeeLifecycle: "ACTIVE",
      },
    });
    await c.employeeBankAccount.create({
      data: {
        clubId: club.id, employeeId: emp.id,
        institutionSecretRef: `kms:i-${emp.id}`, transitSecretRef: `kms:t-${emp.id}`,
        accountSecretRef: `kms:a-${emp.id}`, accountLastFour: `100${i}`.slice(-4),
        holderName: `E${i} X`, status: "ACTIVE", activatedAt: new Date(),
      },
    });
    await c.payrollBatchEmployee.create({
      data: {
        clubId: club.id, batchId: batch.id, employeeId: emp.id,
        jurisdictionCountry: "CA", jurisdictionProvince: "AB",
        employeeLifecycleAtPrep: "ACTIVE",
        bankingReady: true, sinReady: true, federalTd1Ready: true,
        provincialTd1Ready: true, compensationReady: true, status: "INCLUDED",
        netPay: new Prisma.Decimal(netPays[i]),
      },
    });
  }
  return { club, pa, ctrl, admin, bank, batch };
}

describe("PAY-1A/3 · Authorization lifecycle", () => {
  beforeAll(async () => { await resetDb(); await seedRbac(); });
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("prepare → submit → authorize freezes fingerprint + resolves WI + flips instructions", async () => {
    const fx = await makeFixture(["100.00", "200.00"]);
    const prep = await preparePayrollPayments(fx.pa, {
      clubId: fx.club.id, payrollBatchId: fx.batch.id, fundingBankAccountId: fx.bank.id,
    });
    const submit = await submitForAuthorization(fx.pa, prep.runId);
    expect(submit.workIntakeItemId).toBeTruthy();

    const wiOpen = await db().workIntakeItem.findUniqueOrThrow({ where: { id: submit.workIntakeItemId } });
    expect(wiOpen.status).toBe("OPEN");
    expect(wiOpen.workDomain).toBe("PAYROLL");
    expect(wiOpen.workSubtype).toBe("PAYMENT_AUTHORIZATION");

    const auth = await authorizePaymentRun(fx.ctrl, prep.runId);
    expect(auth.paymentFingerprint).toMatch(/^pfp-v1-[0-9a-f]{64}$/);

    const run = await db().paymentRun.findUniqueOrThrow({ where: { id: prep.runId } });
    expect(run.status).toBe("AUTHORIZED");
    expect(run.paymentFingerprint).toBe(auth.paymentFingerprint);
    expect(run.authorizedByUserId).toBe(fx.ctrl.id);

    const instructions = await db().paymentInstruction.findMany({ where: { runId: prep.runId } });
    for (const i of instructions) expect(i.status).toBe("AUTHORIZED");

    const wi = await db().workIntakeItem.findUniqueOrThrow({ where: { id: submit.workIntakeItemId } });
    expect(wi.status).toBe("RESOLVED");
    expect(wi.resolvedByUserId).toBe(fx.ctrl.id);

    const authRow = await db().paymentAuthorization.findUniqueOrThrow({ where: { runId: prep.runId } });
    expect(authRow.status).toBe("ACTIVE");
    expect(authRow.paymentFingerprint).toBe(auth.paymentFingerprint);
    // Snapshot is a canonical JSON blob.
    const snap = JSON.parse(authRow.snapshotJson);
    expect(snap.runMaterial).toBeDefined();
    expect(snap.instructionCount).toBe(2);
  });

  it("SoD: maker (PA) cannot self-authorize even if they hold payment:authorize", async () => {
    const fx = await makeFixture();
    const prep = await preparePayrollPayments(fx.pa, {
      clubId: fx.club.id, payrollBatchId: fx.batch.id, fundingBankAccountId: fx.bank.id,
    });
    await submitForAuthorization(fx.pa, prep.runId);
    // fx.pa is PAYROLL_ADMIN — does not have payment:authorize; will fail on RBAC.
    await expect(authorizePaymentRun(fx.pa, prep.runId)).rejects.toThrow();
  });

  it("SoD: even if the maker somehow has payment:authorize, same-user auth is refused", async () => {
    const fx = await makeFixture();
    // Simulate a two-hat user: give the CLUB_ADMIN an ADDITIONAL
    // PAYROLL_ADMIN grant at the same club so they hold BOTH
    // payment:prepare (PAYROLL_ADMIN) AND payment:authorize (CLUB_ADMIN).
    // Even so, the service-level maker/checker guard must fire.
    await db().userClubRole.create({
      data: {
        userId: fx.admin.id, clubId: fx.club.id, roleKey: "PAYROLL_ADMIN",
      },
    });
    const twoHat = await principalFor((await db().user.findUniqueOrThrow({ where: { id: fx.admin.id } })).email);
    const prep = await preparePayrollPayments(twoHat, {
      clubId: fx.club.id, payrollBatchId: fx.batch.id, fundingBankAccountId: fx.bank.id,
    });
    await submitForAuthorization(twoHat, prep.runId);
    await expect(authorizePaymentRun(twoHat, prep.runId)).rejects.toThrow(/maker\/checker/);
  });

  it("Controller can return a submitted run for changes; run goes back to PREPARED", async () => {
    const fx = await makeFixture();
    const prep = await preparePayrollPayments(fx.pa, {
      clubId: fx.club.id, payrollBatchId: fx.batch.id, fundingBankAccountId: fx.bank.id,
    });
    await submitForAuthorization(fx.pa, prep.runId);
    await returnPaymentRun(fx.ctrl, prep.runId, "please double-check destination for emp 2");

    const run = await db().paymentRun.findUniqueOrThrow({ where: { id: prep.runId } });
    expect(run.status).toBe("PREPARED");
    expect(run.workIntakeItemId).toBeNull(); // detached
  });

  it("cancel from PREPARED sets status CANCELLED and records event", async () => {
    const fx = await makeFixture();
    const prep = await preparePayrollPayments(fx.pa, {
      clubId: fx.club.id, payrollBatchId: fx.batch.id, fundingBankAccountId: fx.bank.id,
    });
    await cancelPaymentRun(fx.ctrl, prep.runId, "keying error");
    const run = await db().paymentRun.findUniqueOrThrow({ where: { id: prep.runId } });
    expect(run.status).toBe("CANCELLED");
    expect(run.cancelReason).toBe("keying error");
    const events = await db().paymentEvent.findMany({ where: { runId: prep.runId, eventType: "PAYMENT_CANCELLED" } });
    expect(events).toHaveLength(1);
  });

  it("invalidateAuthorization flips ACTIVE authorization → INVALIDATED + records event", async () => {
    const fx = await makeFixture();
    const prep = await preparePayrollPayments(fx.pa, {
      clubId: fx.club.id, payrollBatchId: fx.batch.id, fundingBankAccountId: fx.bank.id,
    });
    await submitForAuthorization(fx.pa, prep.runId);
    await authorizePaymentRun(fx.ctrl, prep.runId);
    await db().$transaction(async (tx) => {
      await invalidateAuthorization(prep.runId, "test", tx);
    });
    const authRow = await db().paymentAuthorization.findUniqueOrThrow({ where: { runId: prep.runId } });
    expect(authRow.status).toBe("INVALIDATED");
    expect(authRow.invalidatedReason).toBe("test");
    const events = await db().paymentEvent.findMany({
      where: { runId: prep.runId, eventType: "AUTHORIZATION_INVALIDATED" },
    });
    expect(events).toHaveLength(1);
  });
});
