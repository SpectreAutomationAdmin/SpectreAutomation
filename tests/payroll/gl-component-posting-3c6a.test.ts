// Payroll-3C-6A (2026-09-05) — closeout test scenarios not covered by
// the initial 3C-6 suite. Uses the same seedScenario helper as
// tests/payroll/gl-component-posting-3c6.test.ts (kept inline here so
// the two files can drift independently).
//
// Covers:
//   §13 reimbursement posting
//   §14 one-time employee deduction posting
//   §15 ACCOUNT_TYPE_MISMATCH readiness blocker
//   §16 CPP2 non-zero — aggregated into CPP payable
//   §17 zero-line explicit
//   §18 negative-component behavior (fail-closed)
//   §19 global profile change AFTER post — historical journal immutable
//   §20 global profile change BEFORE post — future post uses new accounts
//   §21 atomic rollback on post failure
//   §22 concurrency / idempotency

import { describe, it, expect, beforeEach } from "vitest";
import Decimal from "decimal.js";
import {
  db, resetDb, seedRbac, makeClub, makeUser, principalFor,
} from "../util/db";
import { upsertPayrollClubConfig } from "@/lib/payroll/club-config";
import {
  upsertPayrollComponent, createRecurringComponentAssignment,
} from "@/lib/payroll/components-catalogue";
import { writeEncryptedTd1Claims } from "@/lib/hr/td1-secure-write";
import { preparePayrollBatch } from "@/lib/payroll/batch-preparation";
import { calculatePayrollBatch } from "@/lib/payroll/calculation-execute";
import { approvePayrollBatch, postPayrollBatch } from "@/lib/payroll/approve-and-post";
import { addOneTimeAdjustment } from "@/lib/payroll/adjustments";
import { evaluatePayrollGlReadiness } from "@/lib/payroll/gl-readiness";
import { seedCanadaAlbertaPackages2026 } from "@/lib/payroll/statutory/seed-ca-ab-2026";
import { ValidationError } from "@/lib/errors";

const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));

async function superAdminP() {
  const c = db();
  await c.user.deleteMany({ where: { email: "sup-3c6a@spectre.test" } });
  const u = await c.user.create({
    data: { email: "sup-3c6a@spectre.test", name: "Sup3C6A", role: "SUPER_ADMIN", passwordHash: "x", status: "ACTIVE" },
  });
  await c.userClubRole.create({ data: { userId: u.id, clubId: null, roleKey: "SUPER_ADMIN" } });
  return principalFor("sup-3c6a@spectre.test");
}

async function seedGlAccounts(clubId: string) {
  type Spec = { number: string; name: string; type: "EXPENSE" | "LIABILITY"; nb: "DEBIT" | "CREDIT" };
  const specs: Spec[] = [
    { number: "5100", name: "Salary Expense",           type: "EXPENSE",   nb: "DEBIT"  },
    { number: "5110", name: "Employer CPP Expense",     type: "EXPENSE",   nb: "DEBIT"  },
    { number: "5120", name: "Employer EI Expense",      type: "EXPENSE",   nb: "DEBIT"  },
    { number: "5130", name: "Benefits Expense",         type: "EXPENSE",   nb: "DEBIT"  },
    { number: "5131", name: "Cell Phone Allowance Exp", type: "EXPENSE",   nb: "DEBIT"  },
    { number: "5132", name: "Employer RRSP Expense",    type: "EXPENSE",   nb: "DEBIT"  },
    { number: "5133", name: "Bonus Expense",            type: "EXPENSE",   nb: "DEBIT"  },
    { number: "5134", name: "Reimbursement Expense",    type: "EXPENSE",   nb: "DEBIT"  },
    { number: "5199", name: "Alt Salary Expense",       type: "EXPENSE",   nb: "DEBIT"  },
    { number: "2100", name: "Net Pay Payable",          type: "LIABILITY", nb: "CREDIT" },
    { number: "2110", name: "CPP Payable",              type: "LIABILITY", nb: "CREDIT" },
    { number: "2120", name: "EI Payable",               type: "LIABILITY", nb: "CREDIT" },
    { number: "2130", name: "Federal Tax Payable",      type: "LIABILITY", nb: "CREDIT" },
    { number: "2140", name: "Provincial Tax Payable",   type: "LIABILITY", nb: "CREDIT" },
    { number: "2150", name: "RRSP Payable",             type: "LIABILITY", nb: "CREDIT" },
    { number: "2160", name: "Benefits Payable",         type: "LIABILITY", nb: "CREDIT" },
    { number: "2170", name: "Employee Deductions Payable", type: "LIABILITY", nb: "CREDIT" },
  ];
  const m = new Map<string, string>();
  for (const s of specs) {
    const row = await db().account.upsert({
      where: { clubId_accountNumber: { clubId, accountNumber: s.number } },
      update: { name: s.name, isActive: true },
      create: {
        clubId, accountNumber: s.number, name: s.name,
        type: s.type, normalBalance: s.nb,
        allowManualPosting: false, isActive: true,
      },
    });
    m.set(s.number, row.id);
  }
  return m;
}

async function seedGlProfile(clubId: string, acct: Map<string, string>) {
  const profile = await db().payrollGlAccountingProfile.upsert({
    where: { clubId },
    update: {
      salaryExpenseAccountId:        acct.get("5100")!,
      employerCppExpenseAccountId:   acct.get("5110")!,
      employerEiExpenseAccountId:    acct.get("5120")!,
      netPayPayableAccountId:        acct.get("2100")!,
      cppPayableAccountId:           acct.get("2110")!,
      eiPayableAccountId:            acct.get("2120")!,
      federalTaxPayableAccountId:    acct.get("2130")!,
      provincialTaxPayableAccountId: acct.get("2140")!,
    },
    create: {
      clubId,
      salaryExpenseAccountId:        acct.get("5100")!,
      employerCppExpenseAccountId:   acct.get("5110")!,
      employerEiExpenseAccountId:    acct.get("5120")!,
      netPayPayableAccountId:        acct.get("2100")!,
      cppPayableAccountId:           acct.get("2110")!,
      eiPayableAccountId:            acct.get("2120")!,
      federalTaxPayableAccountId:    acct.get("2130")!,
      provincialTaxPayableAccountId: acct.get("2140")!,
    },
  });
  await db().payrollClubConfig.update({
    where: { clubId }, data: { glAccountingProfileId: profile.id },
  });
  return profile;
}

async function ensureFiscalPeriod(clubId: string, coverDate: Date) {
  const c = db();
  const existing = await c.fiscalPeriod.findFirst({
    where: { clubId, startDate: { lte: coverDate }, endDate: { gte: coverDate } },
  });
  if (existing) return existing;
  const fy = await c.fiscalYear.create({
    data: {
      clubId, label: "FY2026",
      startDate: utc(2026, 1, 1), endDate: utc(2026, 12, 31),
      status: "OPEN",
    },
  });
  return c.fiscalPeriod.create({
    data: {
      clubId, fiscalYearId: fy.id, label: "FY2026-M09",
      startDate: utc(2026, 9, 1), endDate: utc(2026, 9, 30),
      sequence: 9, status: "OPEN",
    },
  });
}

interface Scenario {
  club: { id: string };
  adminP: Awaited<ReturnType<typeof principalFor>>;
  paP:    Awaited<ReturnType<typeof principalFor>>;
  ctlrP:  Awaited<ReturnType<typeof principalFor>>;
  emp:    { id: string };
  pg:     { id: string };
  acct:   Map<string, string>;
}

async function seedScenario(seed: string): Promise<Scenario> {
  const c = db();
  const sup = await superAdminP();
  try { await seedCanadaAlbertaPackages2026(sup); } catch { /* installed */ }
  const club = await makeClub(`3C6A ${seed}`);
  const adminU = await makeUser({ email: `a.${seed}@t.test`, role: "CLUB_ADMIN", clubId: club.id });
  const paU    = await makeUser({ email: `p.${seed}@t.test`, role: "PAYROLL_ADMIN", clubId: club.id });
  const ctlU   = await makeUser({ email: `c.${seed}@t.test`, role: "CONTROLLER", clubId: club.id });
  const adminP = await principalFor(adminU.email);
  const paP    = await principalFor(paU.email);
  const ctlrP  = await principalFor(ctlU.email);
  await upsertPayrollClubConfig(adminP, club.id, {
    provinceOfEmployment: "AB", payrollAdminUserId: paU.id, controllerUserId: ctlU.id,
  });
  const acct = await seedGlAccounts(club.id);
  await seedGlProfile(club.id, acct);
  await ensureFiscalPeriod(club.id, utc(2026, 9, 15));
  const emp = await c.employee.create({
    data: {
      clubId: club.id, firstName: "Test", lastName: "Emp",
      email: `emp.${seed}@t.test`, hireDate: utc(2020, 1, 1),
      dateOfBirth: utc(1980, 6, 1), status: "ACTIVE",
      employeeNumber: `E-${seed}`,
      employeeLifecycle: "ACTIVE", compensationType: "SALARY", homeProvince: "AB",
    },
  });
  const assn = await c.employeeEmploymentAssignment.create({
    data: {
      clubId: club.id, employeeId: emp.id, role: "PRIMARY",
      employmentType: "FULL_TIME", effectiveFrom: utc(2020, 1, 1),
    },
  });
  await c.employeeCompensation.create({
    data: {
      clubId: club.id, employeeId: emp.id, assignmentId: assn.id,
      cadence: "SALARY", rate: "110000", currency: "CAD",
      effectiveFrom: utc(2020, 1, 1),
    },
  });
  await writeEncryptedTd1Claims({
    clubId: club.id, employeeId: emp.id, effectiveFrom: utc(2020, 1, 1),
    province: "AB", td1FormVersion: "2026-01",
    federalClaim: "16452.00", provincialClaim: "22769.00",
  });
  const pg = await c.payrollPayGroup.create({
    data: {
      clubId: club.id, code: `SM-${seed}`, name: "Semi-Monthly",
      payFrequency: "SEMI_MONTHLY", payDateOffsetDays: 5,
      calendarAnchorDate: utc(2026, 1, 1), active: true,
    },
  });
  await c.payrollPayPeriod.create({
    data: {
      clubId: club.id, payGroupId: pg.id, taxYear: 2026, sequenceInYear: 17,
      periodStart: utc(2026, 9, 1), periodEnd: utc(2026, 9, 16),
      payDate: utc(2026, 9, 15), status: "OPEN",
    },
  });
  await c.payrollPayGroupMember.create({
    data: { clubId: club.id, payGroupId: pg.id, employeeId: emp.id, effectiveFrom: utc(2020, 1, 1) },
  });
  return { club, adminP, paP, ctlrP, emp, pg, acct };
}

async function preparedThenCalcThenApprove(s: Scenario, extra?: (batchId: string) => Promise<void>) {
  const pp = await db().payrollPayPeriod.findFirstOrThrow({
    where: { clubId: s.club.id, payGroupId: s.pg.id, sequenceInYear: 17 },
  });
  const prep = await preparePayrollBatch(s.paP, s.club.id, pp.id);
  if (extra) await extra(prep.batchId);
  await calculatePayrollBatch(s.paP, s.club.id, prep.batchId);
  await approvePayrollBatch(s.ctlrP, prep.batchId);
  return prep.batchId;
}

async function readJournal(entryId: string) {
  const e = await db().journalEntry.findUniqueOrThrow({
    where: { id: entryId },
    include: { lines: { include: { account: true }, orderBy: { lineNumber: "asc" } } },
  });
  return {
    entry: e,
    debits:  e.lines.filter((l) => !new Decimal(String(l.debit)).isZero()),
    credits: e.lines.filter((l) => !new Decimal(String(l.credit)).isZero()),
  };
}

// -------------------------------------------------------------------
// §13 · Reimbursement
// -------------------------------------------------------------------
describe("Payroll-3C-6A · §13 reimbursement posting", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("$72.40 reimbursement debits reimbursement expense, no statutory liability, no double-count", async () => {
    const s = await seedScenario("reimb");
    // A reimbursement is EMPLOYEE side + INCREASES_NET_PAY with NO
    // taxable / CPP / EI effect. Category = REIMBURSEMENT.
    await upsertPayrollComponent(s.adminP, s.club.id, {
      code: "REIMB", displayName: "Expense Reimbursement",
      category: "REIMBURSEMENT", side: "EMPLOYEE",
      cashEffect: "INCREASES_NET_PAY",
      taxableEffect: "NONE", cppPensionableEffect: "NONE", eiInsurableEffect: "NONE",
      calculationMethod: "FIXED_AMOUNT",
      eligibleEarningsBase: null,
      statutoryTreatmentSource: "CUSTOM_TEST",
      displaySection: "EARNINGS",
      expenseAccountId: s.acct.get("5134")!,
    });
    // Prepare + add one-time reimbursement of $72.40.
    const pp = await db().payrollPayPeriod.findFirstOrThrow({
      where: { clubId: s.club.id, payGroupId: s.pg.id, sequenceInYear: 17 },
    });
    const prep = await preparePayrollBatch(s.paP, s.club.id, pp.id);
    const be = await db().payrollBatchEmployee.findFirstOrThrow({ where: { batchId: prep.batchId } });
    await addOneTimeAdjustment(s.paP, s.club.id, prep.batchId, {
      batchEmployeeId: be.id, componentCode: "REIMB",
      amount: "72.40", reason: "Meal reimbursement",
    });
    await calculatePayrollBatch(s.paP, s.club.id, prep.batchId);
    await approvePayrollBatch(s.ctlrP, prep.batchId);
    const posted = await postPayrollBatch(s.ctlrP, prep.batchId);
    expect(posted.totalDebits).toBe(posted.totalCredits);

    const j = await readJournal(posted.journalEntryId);
    const reimbLine = j.debits.find((l) => l.account.accountNumber === "5134");
    expect(reimbLine).toBeDefined();
    expect(new Decimal(String(reimbLine!.debit)).toFixed(2)).toBe("72.40");
    // Reimbursement flows into net pay via the residual salary math.
    // No separate statutory liability line was created for it.
    // Salary residual = grossPay − reimbursement.
    const salary = j.debits.find((l) => l.account.accountNumber === "5100");
    const beAfter = await db().payrollBatchEmployee.findFirstOrThrow({ where: { batchId: prep.batchId } });
    expect(new Decimal(String(salary!.debit)).toFixed(2))
      .toBe(new Decimal(beAfter.grossPay!.toString()).minus("72.40").toFixed(2));
    // Only ONE 5134 line (no double post).
    const reimbLines = j.debits.filter((l) => l.account.accountNumber === "5134");
    expect(reimbLines.length).toBe(1);
  });
});

// -------------------------------------------------------------------
// §14 · One-time employee deduction
// -------------------------------------------------------------------
describe("Payroll-3C-6A · §14 one-time employee deduction posting", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("$50 one-time employee deduction credits configured liability, no employer expense", async () => {
    const s = await seedScenario("ded");
    await upsertPayrollComponent(s.adminP, s.club.id, {
      code: "ONE_TIME_DED", displayName: "One-time Deduction",
      category: "EMPLOYEE_DEDUCTION", side: "EMPLOYEE",
      cashEffect: "DECREASES_NET_PAY",
      taxableEffect: "NONE", cppPensionableEffect: "NONE", eiInsurableEffect: "NONE",
      calculationMethod: "FIXED_AMOUNT",
      eligibleEarningsBase: null,
      statutoryTreatmentSource: "CUSTOM_TEST",
      displaySection: "DEDUCTIONS",
      liabilityAccountId: s.acct.get("2170")!,
    });
    const pp = await db().payrollPayPeriod.findFirstOrThrow({
      where: { clubId: s.club.id, payGroupId: s.pg.id, sequenceInYear: 17 },
    });
    const prep = await preparePayrollBatch(s.paP, s.club.id, pp.id);
    const be = await db().payrollBatchEmployee.findFirstOrThrow({ where: { batchId: prep.batchId } });
    await addOneTimeAdjustment(s.paP, s.club.id, prep.batchId, {
      batchEmployeeId: be.id, componentCode: "ONE_TIME_DED",
      amount: "50", reason: "Equipment purchase",
    });
    await calculatePayrollBatch(s.paP, s.club.id, prep.batchId);
    await approvePayrollBatch(s.ctlrP, prep.batchId);
    const posted = await postPayrollBatch(s.ctlrP, prep.batchId);
    const j = await readJournal(posted.journalEntryId);

    const ded = j.credits.find((l) => l.account.accountNumber === "2170");
    expect(ded).toBeDefined();
    expect(new Decimal(String(ded!.credit)).toFixed(2)).toBe("50.00");
    // NO employer expense debit for the deduction.
    const dedExp = j.debits.find((l) => l.account.accountNumber === "5134");
    expect(dedExp).toBeUndefined();
    expect(posted.totalDebits).toBe(posted.totalCredits);
  });
});

// -------------------------------------------------------------------
// §15 · Account type mismatch
// -------------------------------------------------------------------
describe("Payroll-3C-6A · §15 ACCOUNT_TYPE_MISMATCH blocker", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("component with a LIABILITY account in the EXPENSE slot fails readiness (posting refused)", async () => {
    const s = await seedScenario("mismatch");
    // Employer contribution with the WRONG type in the expense slot
    // (using a liability account as if it were the expense).
    await upsertPayrollComponent(s.adminP, s.club.id, {
      code: "AD_D", displayName: "AD&D",
      category: "EMPLOYER_CONTRIBUTION", side: "EMPLOYER",
      cashEffect: "NO_NET_PAY_EFFECT",
      taxableEffect: "NONE", cppPensionableEffect: "NONE", eiInsurableEffect: "NONE",
      calculationMethod: "FIXED_AMOUNT",
      eligibleEarningsBase: null,
      statutoryTreatmentSource: "CUSTOM_TEST",
      displaySection: "BENEFITS",
      expenseAccountId:   s.acct.get("2160")!, // WRONG — liability
      liabilityAccountId: s.acct.get("2160")!,
    });
    await createRecurringComponentAssignment(s.adminP, s.club.id, {
      employeeId: s.emp.id,
      componentId: (await db().payrollComponent.findFirstOrThrow({ where: { code: "AD_D" } })).id,
      amount: "2.25", percentBps: null, effectiveFrom: utc(2020, 1, 1),
    });
    const batchId = await preparedThenCalcThenApprove(s);
    const readiness = await evaluatePayrollGlReadiness(s.ctlrP, s.club.id, batchId);
    expect(readiness.blockers.some((b) => b.code === "ACCOUNT_TYPE_MISMATCH")).toBe(true);
    await expect(postPayrollBatch(s.ctlrP, batchId)).rejects.toThrow(/readiness failed/i);
    // Batch remains APPROVED, no journal.
    const b = await db().payrollBatch.findUniqueOrThrow({ where: { id: batchId } });
    expect(b.status).toBe("APPROVED");
    expect(b.glJournalEntryId).toBeNull();
  });
});

// -------------------------------------------------------------------
// §16 · CPP2 non-zero
// -------------------------------------------------------------------
describe("Payroll-3C-6A · §16 CPP2 non-zero aggregation", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("employee + employer CPP2 both roll into CPP payable + employer CPP expense", async () => {
    const s = await seedScenario("cpp2");
    // Skip the calculator (its bare-salary periodization is separate
    // scope). Craft a minimal APPROVED batch with round statutory
    // columns so the aggregation math is trivially verifiable.
    const c = db();
    const pp = await c.payrollPayPeriod.findFirstOrThrow({
      where: { clubId: s.club.id, payGroupId: s.pg.id, sequenceInYear: 17 },
    });
    const batch = await c.payrollBatch.create({
      data: {
        clubId: s.club.id, payGroupId: s.pg.id, payPeriodId: pp.id,
        status: "APPROVED", sequence: 1,
        approvedAt: new Date(), approvedByUserId: s.ctlrP.id,
      },
    });
    // Numbers pinned so the balance equation is obvious:
    //   grossPay 1000, ee CPP 50, ee CPP2 10, ee EI 20, fed 100, prov 40
    //   → netPay 780 = 1000 − 50 − 10 − 20 − 100 − 40
    //   er CPP 50, er CPP2 10, er EI 28
    // Total DR: salary residual 1000 + er cpp 60 + er ei 28 = 1088
    // Total CR: net 780 + cpp payable (50+10+50+10=120) + ei (20+28=48)
    //           + fed 100 + prov 40 = 1088 ✓
    await c.payrollBatchEmployee.create({
      data: {
        clubId: s.club.id, batchId: batch.id, employeeId: s.emp.id,
        grossPay: new Decimal("1000"),
        netPay:   new Decimal("780"),
        earningsTaxable:    new Decimal("1000"),
        earningsPensionable: new Decimal("1000"),
        earningsInsurable:   new Decimal("1000"),
        deductionCppEeCombined: new Decimal("50"),
        deductionCpp2Ee:        new Decimal("10"),
        deductionEiEe:          new Decimal("20"),
        deductionFederalTax:    new Decimal("100"),
        deductionProvincialTax: new Decimal("40"),
        employerCppCombined: new Decimal("50"),
        employerCpp2:        new Decimal("10"),
        employerEi:          new Decimal("28"),
        jurisdictionCountry: "CA", jurisdictionProvince: "AB",
        employeeLifecycleAtPrep: "ACTIVE", status: "INCLUDED",
      },
    });
    const posted = await postPayrollBatch(s.ctlrP, batch.id);
    const j = await readJournal(posted.journalEntryId);

    const cppPayable = j.credits.find((l) => l.account.accountNumber === "2110")!;
    const erCppExp   = j.debits.find((l) => l.account.accountNumber === "5110")!;
    // 2110 CPP payable = ee CPP + ee CPP2 + er CPP + er CPP2 = 120.
    expect(new Decimal(String(cppPayable.credit)).toFixed(2)).toBe("120.00");
    // 5110 er CPP expense = er CPP + er CPP2 = 60.
    expect(new Decimal(String(erCppExp.debit)).toFixed(2)).toBe("60.00");
    expect(posted.totalDebits).toBe("1088.00");
    expect(posted.totalCredits).toBe("1088.00");
  });
});

// -------------------------------------------------------------------
// §17 · Zero-line explicit
// -------------------------------------------------------------------
describe("Payroll-3C-6A · §17 zero-amount rows omit journal lines", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("a snapshot with resolvedAmount = 0 contributes NO journal line", async () => {
    const s = await seedScenario("zero");
    // Seed a component with a real assignment amount so it snapshots
    // successfully, then zero it out post-prep BEFORE calculate so
    // the calculator persists 0 through to the frozen row.
    await upsertPayrollComponent(s.adminP, s.club.id, {
      code: "CELL", displayName: "Cell",
      category: "ALLOWANCE", side: "EMPLOYEE",
      cashEffect: "INCREASES_NET_PAY",
      taxableEffect: "ADD", cppPensionableEffect: "ADD", eiInsurableEffect: "ADD",
      calculationMethod: "FIXED_AMOUNT",
      eligibleEarningsBase: null,
      statutoryTreatmentSource: "CUSTOM_TEST",
      displaySection: "EARNINGS",
      expenseAccountId: s.acct.get("5131")!,
    });
    await createRecurringComponentAssignment(s.adminP, s.club.id, {
      employeeId: s.emp.id,
      componentId: (await db().payrollComponent.findFirstOrThrow({ where: { code: "CELL" } })).id,
      amount: "37.50", percentBps: null, effectiveFrom: utc(2020, 1, 1),
    });
    const pp = await db().payrollPayPeriod.findFirstOrThrow({
      where: { clubId: s.club.id, payGroupId: s.pg.id, sequenceInYear: 17 },
    });
    const prep = await preparePayrollBatch(s.paP, s.club.id, pp.id);
    await calculatePayrollBatch(s.paP, s.club.id, prep.batchId);
    // Zero the resolved amount + rebase the frozen columns to match
    // (removing $37.50 from every base — same rebase math as the calc).
    await db().payrollBatchComponentSnapshot.updateMany({
      where: { batchId: prep.batchId, componentCode: "CELL" },
      data: { resolvedAmount: "0" },
    });
    const be = await db().payrollBatchEmployee.findFirstOrThrow({ where: { batchId: prep.batchId } });
    const g = new Decimal(be.grossPay!.toString()).minus("37.50");
    const t = new Decimal(be.earningsTaxable!.toString()).minus("37.50");
    const p = new Decimal(be.earningsPensionable!.toString()).minus("37.50");
    const i = new Decimal(be.earningsInsurable!.toString()).minus("37.50");
    // Fully reduce net + all deductions to still balance — subtract the same $37.50
    // from netPay (Cell was cash-effect).
    await db().payrollBatchEmployee.update({
      where: { id: be.id },
      data: {
        grossPay: g, netPay: new Decimal(be.netPay!.toString()).minus("37.50"),
        earningsTaxable: t, earningsPensionable: p, earningsInsurable: i,
      },
    });
    await approvePayrollBatch(s.ctlrP, prep.batchId);
    const posted = await postPayrollBatch(s.ctlrP, prep.batchId);
    const j = await readJournal(posted.journalEntryId);
    // NO 5131 line — zero component omitted.
    expect(j.debits.find((l) => l.account.accountNumber === "5131")).toBeUndefined();
    // No line has debit=0 AND credit=0.
    for (const l of j.entry.lines) {
      const d = new Decimal(String(l.debit));
      const cr = new Decimal(String(l.credit));
      expect(d.isZero() && cr.isZero()).toBe(false);
    }
    expect(posted.totalDebits).toBe(posted.totalCredits);
  });
});

// -------------------------------------------------------------------
// §18 · Negative component behavior — fail-closed validation
// -------------------------------------------------------------------
describe("Payroll-3C-6A · §18 negative-amount fail-closed", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("addOneTimeAdjustment refuses a negative amount at the API boundary", async () => {
    const s = await seedScenario("neg");
    await upsertPayrollComponent(s.adminP, s.club.id, {
      code: "BONUS", displayName: "Bonus",
      category: "ADDITIONAL_EARNING", side: "EMPLOYEE",
      cashEffect: "INCREASES_NET_PAY",
      taxableEffect: "ADD", cppPensionableEffect: "ADD", eiInsurableEffect: "ADD",
      calculationMethod: "FIXED_AMOUNT",
      eligibleEarningsBase: null,
      statutoryTreatmentSource: "CUSTOM_TEST",
      displaySection: "EARNINGS",
      expenseAccountId: s.acct.get("5133")!,
    });
    const pp = await db().payrollPayPeriod.findFirstOrThrow({
      where: { clubId: s.club.id, payGroupId: s.pg.id, sequenceInYear: 17 },
    });
    const prep = await preparePayrollBatch(s.paP, s.club.id, pp.id);
    const be = await db().payrollBatchEmployee.findFirstOrThrow({ where: { batchId: prep.batchId } });
    // Negative amount MUST be refused before any snapshot is created.
    await expect(addOneTimeAdjustment(s.paP, s.club.id, prep.batchId, {
      batchEmployeeId: be.id, componentCode: "BONUS",
      amount: "-100", reason: "Should not persist",
    })).rejects.toBeInstanceOf(ValidationError);
    // Verify no ONE_TIME snapshot was created.
    const cnt = await db().payrollBatchComponentSnapshot.count({
      where: { batchId: prep.batchId, provenance: "ONE_TIME_PAYROLL_ADJUSTMENT" },
    });
    expect(cnt).toBe(0);
  });
});

// -------------------------------------------------------------------
// §19 · Global profile change AFTER post — historical immutability
// -------------------------------------------------------------------
describe("Payroll-3C-6A · §19 global profile change AFTER post", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("mutating PayrollGlAccountingProfile after POST does not rewrite historical JournalEntryLine accounts", async () => {
    const s = await seedScenario("g-after");
    const batchId = await preparedThenCalcThenApprove(s);
    const posted = await postPayrollBatch(s.ctlrP, batchId);
    const beforeEntry = await readJournal(posted.journalEntryId);
    // Change the global profile to a different salary expense.
    await db().payrollGlAccountingProfile.update({
      where: { clubId: s.club.id },
      data: { salaryExpenseAccountId: s.acct.get("5199")! },
    });
    const afterEntry = await readJournal(posted.journalEntryId);
    // The 5100 salary expense line is UNCHANGED — journal is frozen.
    expect(JSON.stringify(beforeEntry.entry.lines))
      .toBe(JSON.stringify(afterEntry.entry.lines));
  });
});

// -------------------------------------------------------------------
// §20 · Global profile change BEFORE post — future post uses new accounts
// -------------------------------------------------------------------
describe("Payroll-3C-6A · §20 global profile change BEFORE post", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("changing the global salary expense account before POST routes to the NEW account", async () => {
    const s = await seedScenario("g-before");
    const batchId = await preparedThenCalcThenApprove(s);
    // Change global profile BEFORE post — profile is loaded live at post.
    await db().payrollGlAccountingProfile.update({
      where: { clubId: s.club.id },
      data: { salaryExpenseAccountId: s.acct.get("5199")! },
    });
    const posted = await postPayrollBatch(s.ctlrP, batchId);
    const j = await readJournal(posted.journalEntryId);
    // The salary expense debit is against 5199 now, not 5100.
    expect(j.debits.find((l) => l.account.accountNumber === "5199")).toBeDefined();
    expect(j.debits.find((l) => l.account.accountNumber === "5100")).toBeUndefined();
  });
});

// -------------------------------------------------------------------
// §21 · Atomic rollback on readiness failure — no partial state
// -------------------------------------------------------------------
describe("Payroll-3C-6A · §21 atomic rollback on post failure", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("readiness failure creates no JournalEntry, no glJournalEntryId, no PayrollBatch status flip, no WI resolution", async () => {
    const s = await seedScenario("atomic");
    const batchId = await preparedThenCalcThenApprove(s);
    // Force MISSING_GLOBAL_PAYROLL_ACCOUNT (whole profile absent) so
    // readiness refuses before any journal drafting starts.
    // Un-link from the club-config first (FK), then delete the profile.
    await db().payrollClubConfig.update({
      where: { clubId: s.club.id }, data: { glAccountingProfileId: null },
    });
    await db().payrollGlAccountingProfile.delete({ where: { clubId: s.club.id } });
    await expect(postPayrollBatch(s.ctlrP, batchId)).rejects.toThrow();
    // No JournalEntry created for this batch.
    const jeCount = await db().journalEntry.count({
      where: { sourceEntityId: batchId, source: "PAYROLL" },
    });
    expect(jeCount).toBe(0);
    // Batch stays APPROVED with no journal link.
    const batch = await db().payrollBatch.findUniqueOrThrow({ where: { id: batchId } });
    expect(batch.status).toBe("APPROVED");
    expect(batch.glJournalEntryId).toBeNull();
    // Work Intake — no PAYROLL_FINAL_APPROVAL was resolved (none existed
    // in this synthetic scenario, but if it had, it would not be resolved).
    expect(batch.postedAt).toBeNull();
  });
});

// -------------------------------------------------------------------
// §22 · Concurrency / idempotency — two POSTs one journal
// -------------------------------------------------------------------
describe("Payroll-3C-6A · §22 concurrency + idempotency", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("serial POSTs are idempotent: second call returns the same journal id (unique @glJournalEntryId FK)", async () => {
    // Serial idempotency is the guarantee the founder actually needs:
    // clicking POST twice in the UI must not produce two journals.
    // The uniqueness constraint on PayrollBatch.glJournalEntryId +
    // the "already POSTED with linked JE → reuse" short-circuit in
    // postPayrollBatch prove this deterministically.
    const s = await seedScenario("idem");
    const batchId = await preparedThenCalcThenApprove(s);
    const a = await postPayrollBatch(s.ctlrP, batchId);
    const b = await postPayrollBatch(s.ctlrP, batchId);
    expect(a.journalEntryId).toBe(b.journalEntryId);
    const jeCount = await db().journalEntry.count({
      where: { sourceEntityId: batchId, source: "PAYROLL" },
    });
    expect(jeCount).toBe(1);
  });

  it("Payroll-3C-6B: parallel POSTs produce EXACTLY ONE JournalEntry — zero orphan JEs", async () => {
    // Payroll-3C-6B hotfix regression. Prior to the atomic rewrite,
    // `createPostedFromAdapter` ran its own transaction OUTSIDE the
    // batch-flip transaction, so the loser of a race could leave an
    // orphan JournalEntry behind. The new post path wraps acquire +
    // JE creation + batch link in one `prisma.$transaction`; a
    // losing tx rolls back the entire JE creation.
    const s = await seedScenario("concur");
    const batchId = await preparedThenCalcThenApprove(s);
    const jeCountBefore = await db().journalEntry.count({
      where: { source: "PAYROLL", sourceEntityId: batchId },
    });
    expect(jeCountBefore).toBe(0);

    const results = await Promise.allSettled([
      postPayrollBatch(s.ctlrP, batchId),
      postPayrollBatch(s.ctlrP, batchId),
    ]);
    const succeeded = results.filter((r) => r.status === "fulfilled");
    expect(succeeded.length).toBeGreaterThanOrEqual(1);

    const batch = await db().payrollBatch.findUniqueOrThrow({ where: { id: batchId } });
    expect(batch.status).toBe("POSTED");
    expect(batch.glJournalEntryId).not.toBeNull();

    // Core invariant: exactly ONE payroll JournalEntry for this batch.
    // ZERO orphans.
    const jes = await db().journalEntry.findMany({
      where: { source: "PAYROLL", sourceEntityId: batchId },
      select: { id: true, entryNumber: true, sourceEntityId: true },
    });
    expect(jes.length).toBe(1);
    expect(jes[0].id).toBe(batch.glJournalEntryId);

    // If both callers succeeded (both saw the canonical journal via
    // idempotent-existing path), they must return the SAME journal id.
    if (succeeded.length === 2) {
      const [a, b] = succeeded as Array<PromiseFulfilledResult<{ journalEntryId: string }>>;
      expect(a.value.journalEntryId).toBe(b.value.journalEntryId);
      expect(a.value.journalEntryId).toBe(batch.glJournalEntryId);
    }
  });

  it("Payroll-3C-6B: journal-line count matches expected (no duplicate lines from a rolled-back tx)", async () => {
    const s = await seedScenario("concur-lines");
    const batchId = await preparedThenCalcThenApprove(s);
    await Promise.allSettled([
      postPayrollBatch(s.ctlrP, batchId),
      postPayrollBatch(s.ctlrP, batchId),
    ]);
    const batch = await db().payrollBatch.findUniqueOrThrow({ where: { id: batchId } });
    // For a basic (no-component) batch: 3 debits + 5 credits = 8 lines.
    const lineCount = await db().journalEntryLine.count({
      where: { journalEntryId: batch.glJournalEntryId! },
    });
    expect(lineCount).toBe(8);
    // AND no journal-line rows dangling from an orphan (would-be
    // losing tx) JE for this batch. Since exactly ONE JE exists,
    // and its lineCount is 8, there can't be more lines.
    const allPayrollJes = await db().journalEntry.findMany({
      where: { source: "PAYROLL", sourceEntityId: batchId }, select: { id: true },
    });
    const totalPayrollLines = await db().journalEntryLine.count({
      where: { journalEntryId: { in: allPayrollJes.map((j) => j.id) } },
    });
    expect(totalPayrollLines).toBe(8);
  });

  it("Payroll-3C-6B: fault injection AFTER JE creation begins rolls back the whole tx (zero JEs, batch stays APPROVED)", async () => {
    // Uses the test-only SPECTRE_PAYROLL_FAULT_INJECT hook inside
    // postPayrollBatch: after step 2 (JE + lines written to the tx),
    // before step 3 (batch link), throw. The Prisma transaction MUST
    // roll back both — no JournalEntry, no lines, batch stays
    // APPROVED with no linked journal.
    const s = await seedScenario("rollback");
    const batchId = await preparedThenCalcThenApprove(s);
    const jesBefore = await db().journalEntry.count({
      where: { source: "PAYROLL", sourceEntityId: batchId },
    });
    expect(jesBefore).toBe(0);

    process.env.SPECTRE_PAYROLL_FAULT_INJECT = "AFTER_JE_CREATE";
    try {
      await expect(postPayrollBatch(s.ctlrP, batchId)).rejects.toThrow(/Injected fault/i);
    } finally {
      delete process.env.SPECTRE_PAYROLL_FAULT_INJECT;
    }

    // After rollback: no JournalEntry, no JournalEntryLine for this batch.
    const jesAfter = await db().journalEntry.count({
      where: { source: "PAYROLL", sourceEntityId: batchId },
    });
    expect(jesAfter).toBe(0);
    const stragglerJes = await db().journalEntry.findMany({
      where: { source: "PAYROLL", sourceEntityId: batchId }, select: { id: true },
    });
    const linesAfter = await db().journalEntryLine.count({
      where: { journalEntryId: { in: stragglerJes.map((j) => j.id) } },
    });
    expect(linesAfter).toBe(0);
    // Batch stays APPROVED with no linked journal.
    const batch = await db().payrollBatch.findUniqueOrThrow({ where: { id: batchId } });
    expect(batch.status).toBe("APPROVED");
    expect(batch.glJournalEntryId).toBeNull();
    expect(batch.postedAt).toBeNull();
  });
});
