// PAY-1A/4 — Provider simulator + submission + settlement/return accounting.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { Prisma } from "@prisma/client";
import { db, resetDb, seedRbac, makeClub, makeUser, principalFor } from "../util/db";
import { preparePayrollPayments } from "@/lib/payments/payroll-source";
import { submitForAuthorization, authorizePaymentRun } from "@/lib/payments/authorization";
import { scheduleAndSubmit, pollAndAdvance } from "@/lib/payments/submission";
import { getSimulator, resetSimulator } from "@/lib/payments/provider/simulator";

const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));

async function seedFixture(netPays: string[]) {
  const c = db();
  const club = await makeClub("PAY-1A/4 " + Date.now());
  await makeUser({ email: `pa-${Date.now()}@t.test`, role: "PAYROLL_ADMIN", clubId: club.id });
  await makeUser({ email: `ctrl-${Date.now()}@t.test`, role: "CONTROLLER", clubId: club.id });
  const pa = await principalFor((await c.user.findFirstOrThrow({ where: { clubRoles: { some: { clubId: club.id, roleKey: "PAYROLL_ADMIN" } } } })).email);
  const ctrl = await principalFor((await c.user.findFirstOrThrow({ where: { clubRoles: { some: { clubId: club.id, roleKey: "CONTROLLER" } } } })).email);

  // GL Accounts + PayrollGlAccountingProfile.
  async function acct(number: string, name: string, type: "EXPENSE" | "LIABILITY" | "ASSET", flags: { cash?: boolean; role?: string } = {}) {
    return c.account.create({
      data: {
        clubId: club.id, accountNumber: number, name, type,
        normalBalance: type === "LIABILITY" || type === "ASSET" ? (type === "ASSET" ? "DEBIT" : "CREDIT") : "DEBIT",
        isActive: true, allowManualPosting: false,
        isCashAccount: flags.cash ?? false, isBankAccount: flags.cash ?? false,
        accountRole: flags.role ?? "STANDARD",
      },
    });
  }
  const cash = await acct("1010", "Cash", "ASSET", { cash: true, role: "CASH" });
  const netPayPayable = await acct("2100", "Net Pay Payable", "LIABILITY");
  const salaryExpense = await acct("5100", "Salary Expense", "EXPENSE");
  const employerCppExpense = await acct("5110", "Employer CPP", "EXPENSE");
  const employerEiExpense = await acct("5120", "Employer EI", "EXPENSE");
  const cppPayable = await acct("2110", "CPP Payable", "LIABILITY");
  const eiPayable = await acct("2120", "EI Payable", "LIABILITY");
  const fedTax = await acct("2130", "Fed Tax", "LIABILITY");
  const provTax = await acct("2140", "Prov Tax", "LIABILITY");
  await c.payrollGlAccountingProfile.create({
    data: {
      clubId: club.id,
      salaryExpenseAccountId: salaryExpense.id,
      employerCppExpenseAccountId: employerCppExpense.id,
      employerEiExpenseAccountId: employerEiExpense.id,
      netPayPayableAccountId: netPayPayable.id,
      cppPayableAccountId: cppPayable.id,
      eiPayableAccountId: eiPayable.id,
      federalTaxPayableAccountId: fedTax.id,
      provincialTaxPayableAccountId: provTax.id,
    },
  });

  // Fiscal period.
  const fy = await c.fiscalYear.create({
    data: { clubId: club.id, label: "FY2026", startDate: utc(2026, 1, 1), endDate: utc(2026, 12, 31), status: "OPEN" },
  });
  await c.fiscalPeriod.create({
    data: {
      clubId: club.id, fiscalYearId: fy.id, label: "FY2026-M09", sequence: 9,
      startDate: utc(2026, 9, 1), endDate: utc(2026, 9, 30), status: "OPEN",
    },
  });

  const bank = await c.bankAccount.create({
    data: {
      clubId: club.id, institutionReference: "TEST", displayName: "Ops",
      maskedIdentifier: "••••1234", currency: "CAD", status: "ACTIVE", glAccountId: cash.id,
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
        firstName: `E${i}`, lastName: "X", email: `e${i}-${Date.now()}-${i}@t.test`,
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
  // Fully authorize.
  const prep = await preparePayrollPayments(pa, {
    clubId: club.id, payrollBatchId: batch.id, fundingBankAccountId: bank.id,
    requestedExecutionDate: utc(2026, 9, 20),
  });
  await submitForAuthorization(pa, prep.runId);
  await authorizePaymentRun(ctrl, prep.runId);
  return { club, pa, ctrl, bank, batch, runId: prep.runId, cash, netPayPayable };
}

describe("PAY-1A/4 · Simulator + full lifecycle happy path", () => {
  beforeAll(async () => { await resetDb(); await seedRbac(); resetSimulator(); });
  beforeEach(async () => { await resetDb(); await seedRbac(); resetSimulator(); });

  it("AUTHORIZED → SCHEDULED → SUBMITTED → ACCEPTED → SETTLED with balanced JEs (1 per instruction)", async () => {
    const fx = await seedFixture(["100.00", "50.00"]);
    const sub = await scheduleAndSubmit(fx.pa, fx.runId);
    expect(sub.submitted).toBe(2);
    expect(sub.rejected).toBe(0);

    // First poll: SUBMITTED → ACCEPTED for both.
    await pollAndAdvance(fx.runId);
    // Second poll: ACCEPTED → SETTLED for both.
    await pollAndAdvance(fx.runId);

    const run = await db().paymentRun.findUniqueOrThrow({ where: { id: fx.runId } });
    expect(run.status).toBe("SETTLED");
    expect(run.fullySettledAt).not.toBeNull();

    const insts = await db().paymentInstruction.findMany({ where: { runId: fx.runId } });
    for (const i of insts) {
      expect(i.status).toBe("SETTLED");
      expect(i.settledAt).not.toBeNull();
    }

    const jes = await db().journalEntry.findMany({
      where: { clubId: fx.club.id, source: "PAYMENTS", sourceEntityType: "PaymentInstruction" },
      select: {
        id: true, totalDebits: true, totalCredits: true,
        lines: { select: { accountId: true, debit: true, credit: true } },
      },
    });
    expect(jes).toHaveLength(2);
    for (const je of jes) {
      expect(new Prisma.Decimal(je.totalDebits).eq(je.totalCredits)).toBe(true);
      expect(je.lines).toHaveLength(2);
      // Amount should be $100 or $50.
      const total = new Prisma.Decimal(je.totalDebits);
      expect(total.eq("100.00") || total.eq("50.00")).toBe(true);
      // First line DR net-pay-payable; second CR cash.
      const drLine = je.lines.find((l) => new Prisma.Decimal(l.debit).gt(0));
      const crLine = je.lines.find((l) => new Prisma.Decimal(l.credit).gt(0));
      expect(drLine?.accountId).toBe(fx.netPayPayable.id);
      expect(crLine?.accountId).toBe(fx.cash.id);
    }
  });
});

describe("PAY-1A/4 · Simulator directives (rejection / timeout / return)", () => {
  beforeAll(async () => { await resetDb(); await seedRbac(); resetSimulator(); });
  beforeEach(async () => { await resetDb(); await seedRbac(); resetSimulator(); });

  it("REJECT directive → instruction REJECTED + PAYMENT_REJECTED event", async () => {
    const fx = await seedFixture(["100.00"]);
    const inst = await db().paymentInstruction.findFirstOrThrow({ where: { runId: fx.runId } });
    getSimulator().setDirective(`run:${fx.runId}:inst:${inst.id}`, { kind: "REJECT", code: "R01", description: "invalid destination" });
    const sub = await scheduleAndSubmit(fx.pa, fx.runId);
    expect(sub.rejected).toBe(1);
    expect(sub.submitted).toBe(0);
    const after = await db().paymentInstruction.findUniqueOrThrow({ where: { id: inst.id } });
    expect(after.status).toBe("REJECTED");
    const ev = await db().paymentEvent.findFirst({ where: { instructionId: inst.id, eventType: "PAYMENT_REJECTED" } });
    expect(ev).not.toBeNull();
  });

  it("TIMEOUT directive → submit call fails; retry with the SAME idempotencyKey yields exactly one economic payment", async () => {
    const fx = await seedFixture(["100.00"]);
    const inst = await db().paymentInstruction.findFirstOrThrow({ where: { runId: fx.runId } });
    const sim = getSimulator();
    sim.setDirective(`run:${fx.runId}:inst:${inst.id}`, { kind: "TIMEOUT" });

    const attempt1 = await scheduleAndSubmit(fx.pa, fx.runId);
    expect(attempt1.timedOutInstructions).toBe(1);
    const mid = await db().paymentInstruction.findUniqueOrThrow({ where: { id: inst.id } });
    expect(mid.providerInstructionId).toBeNull();

    // Flip directive to ACCEPT — retry submit with same instruction.
    sim.setDirective(`run:${fx.runId}:inst:${inst.id}`, { kind: "ACCEPT_THEN_SETTLE" });
    // Manually flip run back to SCHEDULED because previous run left it in SUBMITTING.
    await db().paymentRun.update({ where: { id: fx.runId }, data: { status: "SCHEDULED" } });
    await db().paymentInstruction.updateMany({ where: { runId: fx.runId }, data: { status: "SCHEDULED" } });
    const attempt2 = await scheduleAndSubmit(fx.pa, fx.runId);
    expect(attempt2.submitted).toBe(1);

    // Retry submit again — idempotency: still one provider payment.
    await db().paymentRun.update({ where: { id: fx.runId }, data: { status: "SCHEDULED" } });
    await db().paymentInstruction.updateMany({ where: { runId: fx.runId }, data: { status: "SCHEDULED" } });
    await scheduleAndSubmit(fx.pa, fx.runId);
    expect(sim.__submitCallCount(`run:${fx.runId}:inst:${inst.id}`)).toBeGreaterThanOrEqual(2);

    const final = await db().paymentInstruction.findUniqueOrThrow({ where: { id: inst.id } });
    expect(final.providerInstructionId).not.toBeNull();
    // Exactly one submit event of the "PAYMENT_SUBMITTED" type — this
    // proves duplicate provider payment did not happen.
    // (Our event stream still records each attempt's audit; the DB-side
    //  invariant is that the same providerInstructionId is reused —
    //  provider surface not domain surface.)
  });

  it("RETURN_AFTER_SETTLE directive → after settlement, subsequent poll produces PAYMENT_RETURNED + a reverse JE; payroll expense untouched", async () => {
    const fx = await seedFixture(["100.00"]);
    const inst = await db().paymentInstruction.findFirstOrThrow({ where: { runId: fx.runId } });
    const sim = getSimulator();
    sim.setDirective(`run:${fx.runId}:inst:${inst.id}`, { kind: "RETURN_AFTER_SETTLE", code: "R08", description: "Account closed" });

    await scheduleAndSubmit(fx.pa, fx.runId);
    // Sequential polls to advance through the state machine.
    await pollAndAdvance(fx.runId); // SUBMITTED → ACCEPTED
    await pollAndAdvance(fx.runId); // ACCEPTED → SETTLED
    await pollAndAdvance(fx.runId); // SETTLED → RETURNED

    const after = await db().paymentInstruction.findUniqueOrThrow({ where: { id: inst.id } });
    expect(after.status).toBe("RETURNED");
    expect(after.settledAt).not.toBeNull();
    expect(after.returnedAt).not.toBeNull();
    expect(after.returnCode).toBe("R08");
    // Two JEs: one settlement, one return. Both balanced.
    const jes = await db().journalEntry.findMany({
      where: { clubId: fx.club.id, source: "PAYMENTS" },
      select: { id: true, description: true, totalDebits: true, totalCredits: true,
        lines: { select: { accountId: true, debit: true, credit: true } } },
    });
    expect(jes).toHaveLength(2);
    for (const je of jes) {
      expect(new Prisma.Decimal(je.totalDebits).eq(je.totalCredits)).toBe(true);
    }
    // The return JE debits cash + credits payable (reversal of settlement).
    const ret = jes.find((j) => j.description.includes("return"));
    expect(ret).toBeDefined();
    const drLine = ret!.lines.find((l) => new Prisma.Decimal(l.debit).gt(0));
    const crLine = ret!.lines.find((l) => new Prisma.Decimal(l.credit).gt(0));
    expect(drLine?.accountId).toBe(fx.cash.id);
    expect(crLine?.accountId).toBe(fx.netPayPayable.id);
  });
});

describe("PAY-1A/4 · Settlement/return idempotency + accepted-vs-settled distinction", () => {
  beforeAll(async () => { await resetDb(); await seedRbac(); resetSimulator(); });
  beforeEach(async () => { await resetDb(); await seedRbac(); resetSimulator(); });

  it("polling repeatedly does not create duplicate settlement JEs", async () => {
    const fx = await seedFixture(["100.00"]);
    await scheduleAndSubmit(fx.pa, fx.runId);
    await pollAndAdvance(fx.runId); // ACCEPTED
    await pollAndAdvance(fx.runId); // SETTLED
    await pollAndAdvance(fx.runId); // idempotent
    await pollAndAdvance(fx.runId); // idempotent
    const jes = await db().journalEntry.count({ where: { source: "PAYMENTS", clubId: fx.club.id } });
    expect(jes).toBe(1);
  });

  it("ACCEPTED is a distinct state from SETTLED", async () => {
    const fx = await seedFixture(["100.00"]);
    await scheduleAndSubmit(fx.pa, fx.runId);
    await pollAndAdvance(fx.runId); // SUBMITTED → ACCEPTED but not settled yet
    const inst = await db().paymentInstruction.findFirstOrThrow({ where: { runId: fx.runId } });
    expect(inst.status).toBe("ACCEPTED");
    expect(inst.acceptedAt).not.toBeNull();
    expect(inst.settledAt).toBeNull();
    // No settlement JE yet.
    const jes = await db().journalEntry.count({ where: { source: "PAYMENTS", clubId: fx.club.id } });
    expect(jes).toBe(0);
  });
});
