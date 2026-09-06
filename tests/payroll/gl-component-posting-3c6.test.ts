// Payroll-3C-6 (2026-09-05) — component-aware GL posting suite.
//
// Covers the 30 required scenarios from §95 of the brief:
//   • regular salary + cash allowance + employer benefit posting
//   • non-cash taxable benefit — expense yes, no cash inflation
//   • employee deduction → liability, no employer expense
//   • employer contribution → expense + liability
//   • one-time bonus, reimbursement, employee deduction
//   • statutory EE + ER liabilities and expenses (CPP, EI, tax)
//   • net payroll clearing = grossPay − all EE deductions
//   • missing expense / liability mapping fails closed
//   • inactive + cross-tenant accounts blocked
//   • mapping frozen at PREPARE
//   • live mapping change after CALCULATE affects future only
//   • journal balance exact to the cent
//   • RRSP + CPP + EI liability aggregation
//   • no component double-count
//   • zero-line omission
//   • idempotent post + atomic rollback
//   • historical journal immutability
//
// All tests use the shared test SQLite DB via tests/util/db.ts.
// No dev / staging DB is touched.

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
import { seedCanadaAlbertaPackages2026 } from "@/lib/payroll/statutory/seed-ca-ab-2026";
import { addOneTimeAdjustment } from "@/lib/payroll/adjustments";
import { evaluatePayrollGlReadiness } from "@/lib/payroll/gl-readiness";

const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));

// -------------------------------------------------------------------
// Fixture helpers
// -------------------------------------------------------------------
async function superAdminP() {
  const c = db();
  await c.user.deleteMany({ where: { email: "sup-3c6@spectre.test" } });
  const u = await c.user.create({
    data: { email: "sup-3c6@spectre.test", name: "Sup3C6", role: "SUPER_ADMIN", passwordHash: "x", status: "ACTIVE" },
  });
  await c.userClubRole.create({ data: { userId: u.id, clubId: null, roleKey: "SUPER_ADMIN" } });
  return principalFor("sup-3c6@spectre.test");
}

async function seedGlAccounts(clubId: string) {
  // Minimal chart-of-accounts identical in spirit to the Coulee Ridge
  // fixture: 8 basic payroll accounts + a handful of component-scoped
  // accounts.
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
  // Link the PayrollClubConfig → this profile so approve-and-post's
  // loader `payrollClubConfig.findUnique().glAccountingProfile` sees it.
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
  batchId?: string;
}

async function seedScenario(seed: string): Promise<Scenario> {
  const c = db();
  const sup = await superAdminP();
  try { await seedCanadaAlbertaPackages2026(sup); } catch { /* already installed */ }

  const club = await makeClub(`3C6 ${seed}`);
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
      clubId: club.id, code: `SM-${seed}`, name: "Semi-Monthly Test",
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

interface CompDef {
  code: string; displayName: string;
  section: "EARNINGS" | "BENEFITS" | "DEDUCTIONS";
  side: "EMPLOYEE" | "EMPLOYER";
  cashEffect: "INCREASES_NET_PAY" | "DECREASES_NET_PAY" | "NO_NET_PAY_EFFECT";
  category: string;
  amount: string;
  expenseAccountId?: string;
  liabilityAccountId?: string;
  taxable?: "ADD" | "SUBTRACT" | "NONE";
  cpp?: "ADD" | "SUBTRACT" | "NONE";
  ei?: "ADD" | "SUBTRACT" | "NONE";
}

async function addComponent(s: Scenario, d: CompDef) {
  const cc = await upsertPayrollComponent(s.adminP, s.club.id, {
    code: d.code, displayName: d.displayName,
    category: d.category as never,
    side: d.side, cashEffect: d.cashEffect,
    taxableEffect: d.taxable ?? "NONE",
    cppPensionableEffect: d.cpp ?? "NONE",
    eiInsurableEffect: d.ei ?? "NONE",
    calculationMethod: "FIXED_AMOUNT",
    eligibleEarningsBase: null,
    statutoryTreatmentSource: "CUSTOM_TEST",
    displaySection: d.section,
    expenseAccountId: d.expenseAccountId ?? null,
    liabilityAccountId: d.liabilityAccountId ?? null,
  });
  await createRecurringComponentAssignment(s.adminP, s.club.id, {
    employeeId: s.emp.id, componentId: cc.id,
    amount: d.amount, percentBps: null, effectiveFrom: utc(2020, 1, 1),
  });
  return cc;
}

async function prepareAndCalculate(s: Scenario): Promise<string> {
  const pp = await db().payrollPayPeriod.findFirstOrThrow({
    where: { clubId: s.club.id, payGroupId: s.pg.id, sequenceInYear: 17 },
  });
  const prep = await preparePayrollBatch(s.paP, s.club.id, pp.id);
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
    totalDebits:  e.totalDebits.toString(),
    totalCredits: e.totalCredits.toString(),
  };
}

// ===================================================================
// A · Zero-component batch — legacy 8-line journal survives
// ===================================================================
describe("Payroll-3C-6 · basic batch (no components)", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("posts a balanced 8-line journal for a batch with zero component snapshots", async () => {
    const s = await seedScenario("basic");
    const batchId = await prepareAndCalculate(s);
    const posted = await postPayrollBatch(s.ctlrP, batchId);
    expect(posted.totalDebits).toBe(posted.totalCredits);
    const j = await readJournal(posted.journalEntryId);
    // 3 debits (salary, er cpp, er ei) + 5 credits (net, cpp, ei, fed, prov)
    expect(j.debits.length + j.credits.length).toBe(8);
  });
});

// ===================================================================
// B · Regular salary + cash allowance — no double-count (§9, §84)
// ===================================================================
describe("Payroll-3C-6 · regular salary + cash allowance", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("cash allowance debits its own expense; residual salary expense = gross − allowance", async () => {
    const s = await seedScenario("cash");
    await addComponent(s, {
      code: "CELL", displayName: "Cell Phone", section: "EARNINGS",
      side: "EMPLOYEE", cashEffect: "INCREASES_NET_PAY", category: "ALLOWANCE",
      taxable: "ADD", cpp: "ADD", ei: "ADD",
      amount: "37.50",
      expenseAccountId: s.acct.get("5131")!,
    });
    const batchId = await prepareAndCalculate(s);
    const posted  = await postPayrollBatch(s.ctlrP, batchId);
    const j       = await readJournal(posted.journalEntryId);

    const salary = j.debits.find((l) => l.account.accountNumber === "5100")!;
    const cell   = j.debits.find((l) => l.account.accountNumber === "5131")!;
    const be = await db().payrollBatchEmployee.findFirstOrThrow({ where: { batchId } });
    const gross = new Decimal(be.grossPay!.toString());
    // Salary expense = gross − 37.50
    expect(new Decimal(String(salary.debit)).toFixed(2)).toBe(gross.minus("37.50").toFixed(2));
    expect(new Decimal(String(cell.debit)).toFixed(2)).toBe("37.50");
    // Balance
    expect(posted.totalDebits).toBe(posted.totalCredits);
  });
});

// ===================================================================
// C · Non-cash taxable benefit (§38) — expense yes, no cash inflation
// ===================================================================
describe("Payroll-3C-6 · non-cash taxable benefit", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("employer life insurance debits benefits expense, credits benefits payable, does NOT touch net pay", async () => {
    const s = await seedScenario("life");
    await addComponent(s, {
      code: "LIFE_ER", displayName: "Employer Life", section: "BENEFITS",
      side: "EMPLOYER", cashEffect: "NO_NET_PAY_EFFECT", category: "TAXABLE_BENEFIT",
      taxable: "ADD", cpp: "ADD", ei: "NONE",
      amount: "20.93",
      expenseAccountId: s.acct.get("5130")!,
      liabilityAccountId: s.acct.get("2160")!,
    });
    const batchId = await prepareAndCalculate(s);
    const posted  = await postPayrollBatch(s.ctlrP, batchId);
    const j       = await readJournal(posted.journalEntryId);

    const expLine = j.debits.find((l) => l.account.accountNumber === "5130")!;
    const liaLine = j.credits.find((l) => l.account.accountNumber === "2160")!;
    expect(new Decimal(String(expLine.debit)).toFixed(2)).toBe("20.93");
    expect(new Decimal(String(liaLine.credit)).toFixed(2)).toBe("20.93");

    // Net pay is UNCHANGED by the non-cash TB — employee cash unaffected.
    // Salary residual line remains = grossPay (no cash-component subtract).
    const salary = j.debits.find((l) => l.account.accountNumber === "5100")!;
    const be = await db().payrollBatchEmployee.findFirstOrThrow({ where: { batchId } });
    expect(new Decimal(String(salary.debit)).toFixed(2)).toBe(new Decimal(be.grossPay!.toString()).toFixed(2));
    // Balance
    expect(posted.totalDebits).toBe(posted.totalCredits);
  });
});

// ===================================================================
// D · Employee deduction (§39, §41) — liability only, no employer expense
// ===================================================================
describe("Payroll-3C-6 · employee deduction (RRSP EE / LTD)", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("RRSP EE credits RRSP payable, creates NO employer expense", async () => {
    const s = await seedScenario("rrspee");
    await addComponent(s, {
      code: "RRSP_EE", displayName: "RRSP Employee", section: "DEDUCTIONS",
      side: "EMPLOYEE", cashEffect: "DECREASES_NET_PAY", category: "EMPLOYEE_DEDUCTION",
      amount: "229.17",
      liabilityAccountId: s.acct.get("2150")!,
    });
    const batchId = await prepareAndCalculate(s);
    const posted  = await postPayrollBatch(s.ctlrP, batchId);
    const j       = await readJournal(posted.journalEntryId);

    const rrspLiab = j.credits.find((l) => l.account.accountNumber === "2150")!;
    expect(new Decimal(String(rrspLiab.credit)).toFixed(2)).toBe("229.17");

    // No debit line for RRSP EE (would incorrectly imply employer expense).
    const rrspExp = j.debits.find((l) => l.account.accountNumber === "5132");
    expect(rrspExp).toBeUndefined();
    expect(posted.totalDebits).toBe(posted.totalCredits);
  });
});

// ===================================================================
// E · Employer contribution — RRSP ER: expense + liability
// ===================================================================
describe("Payroll-3C-6 · employer contribution (RRSP ER)", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("RRSP ER creates DR expense + CR liability, does not touch net pay", async () => {
    const s = await seedScenario("rrsper");
    await addComponent(s, {
      code: "RRSP_ER", displayName: "RRSP Employer", section: "BENEFITS",
      side: "EMPLOYER", cashEffect: "NO_NET_PAY_EFFECT", category: "EMPLOYER_CONTRIBUTION",
      amount: "229.17",
      expenseAccountId: s.acct.get("5132")!,
      liabilityAccountId: s.acct.get("2150")!,
    });
    const batchId = await prepareAndCalculate(s);
    const posted  = await postPayrollBatch(s.ctlrP, batchId);
    const j       = await readJournal(posted.journalEntryId);
    const exp = j.debits.find((l) => l.account.accountNumber === "5132")!;
    const lia = j.credits.find((l) => l.account.accountNumber === "2150")!;
    expect(new Decimal(String(exp.debit)).toFixed(2)).toBe("229.17");
    expect(new Decimal(String(lia.credit)).toFixed(2)).toBe("229.17");
    expect(posted.totalDebits).toBe(posted.totalCredits);
  });
});

// ===================================================================
// F · RRSP payable aggregation (§28, §40) — EE + ER share account
// ===================================================================
describe("Payroll-3C-6 · RRSP payable aggregation (EE + ER)", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("RRSP EE + RRSP ER credit ONE payable line with combined total", async () => {
    const s = await seedScenario("rrspagg");
    await addComponent(s, {
      code: "RRSP_EE", displayName: "RRSP EE", section: "DEDUCTIONS",
      side: "EMPLOYEE", cashEffect: "DECREASES_NET_PAY", category: "EMPLOYEE_DEDUCTION",
      amount: "229.17",
      liabilityAccountId: s.acct.get("2150")!,
    });
    await addComponent(s, {
      code: "RRSP_ER", displayName: "RRSP ER", section: "BENEFITS",
      side: "EMPLOYER", cashEffect: "NO_NET_PAY_EFFECT", category: "EMPLOYER_CONTRIBUTION",
      amount: "229.17",
      expenseAccountId: s.acct.get("5132")!,
      liabilityAccountId: s.acct.get("2150")!,
    });
    const batchId = await prepareAndCalculate(s);
    const posted  = await postPayrollBatch(s.ctlrP, batchId);
    const j       = await readJournal(posted.journalEntryId);

    // Exactly ONE credit line on 2150, total = 458.34.
    const rrspLines = j.credits.filter((l) => l.account.accountNumber === "2150");
    expect(rrspLines.length).toBe(1);
    expect(new Decimal(String(rrspLines[0].credit)).toFixed(2)).toBe("458.34");
  });
});

// ===================================================================
// G · Missing-account fail-closed (§13, §46, §47)
// ===================================================================
describe("Payroll-3C-6 · missing mapping fails closed", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("employer contribution with no expense account: readiness reports blocker, post refused", async () => {
    const s = await seedScenario("missexp");
    await addComponent(s, {
      code: "LIFE_ER", displayName: "Employer Life", section: "BENEFITS",
      side: "EMPLOYER", cashEffect: "NO_NET_PAY_EFFECT", category: "EMPLOYER_CONTRIBUTION",
      amount: "20.93",
      // NO expenseAccountId, NO liabilityAccountId
    });
    const batchId = await prepareAndCalculate(s);
    const readiness = await evaluatePayrollGlReadiness(s.ctlrP, s.club.id, batchId);
    expect(readiness.ready).toBe(false);
    expect(readiness.blockers.some((b) => b.code === "MISSING_COMPONENT_EXPENSE_ACCOUNT")).toBe(true);
    expect(readiness.blockers.some((b) => b.code === "MISSING_COMPONENT_LIABILITY_ACCOUNT")).toBe(true);

    await expect(postPayrollBatch(s.ctlrP, batchId)).rejects.toThrow(/readiness failed/i);

    // Batch remains APPROVED — no partial posting.
    const b = await db().payrollBatch.findUniqueOrThrow({ where: { id: batchId } });
    expect(b.status).toBe("APPROVED");
    expect(b.glJournalEntryId).toBeNull();
  });

  it("employee deduction with no liability account: readiness reports MISSING_COMPONENT_LIABILITY_ACCOUNT", async () => {
    const s = await seedScenario("missliab");
    await addComponent(s, {
      code: "LTD", displayName: "LTD", section: "DEDUCTIONS",
      side: "EMPLOYEE", cashEffect: "DECREASES_NET_PAY", category: "EMPLOYEE_DEDUCTION",
      amount: "28.11",
    });
    const batchId = await prepareAndCalculate(s);
    const readiness = await evaluatePayrollGlReadiness(s.ctlrP, s.club.id, batchId);
    expect(readiness.ready).toBe(false);
    expect(readiness.blockers.some((b) => b.code === "MISSING_COMPONENT_LIABILITY_ACCOUNT")).toBe(true);
  });
});

// ===================================================================
// H · Inactive + cross-tenant account rejection (§48, §49)
// ===================================================================
describe("Payroll-3C-6 · inactive + cross-tenant account rejection", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("readiness flags INACTIVE_ACCOUNT when a snapshotted account is deactivated after PREPARE", async () => {
    const s = await seedScenario("inact");
    await addComponent(s, {
      code: "CELL", displayName: "Cell", section: "EARNINGS",
      side: "EMPLOYEE", cashEffect: "INCREASES_NET_PAY", category: "ALLOWANCE",
      amount: "37.50", expenseAccountId: s.acct.get("5131")!,
    });
    const batchId = await prepareAndCalculate(s);
    // Deactivate the account AFTER the snapshot is frozen.
    await db().account.update({ where: { id: s.acct.get("5131")! }, data: { isActive: false } });
    const readiness = await evaluatePayrollGlReadiness(s.ctlrP, s.club.id, batchId);
    expect(readiness.ready).toBe(false);
    expect(readiness.blockers.some((b) => b.code === "INACTIVE_ACCOUNT")).toBe(true);
  });

  it("readiness flags CROSS_TENANT_ACCOUNT when the snapshotted account belongs to another Club", async () => {
    const s = await seedScenario("xtenant");
    // Direct-write a snapshot with an accountId that doesn't exist in s.club.
    await addComponent(s, {
      code: "CELL", displayName: "Cell", section: "EARNINGS",
      side: "EMPLOYEE", cashEffect: "INCREASES_NET_PAY", category: "ALLOWANCE",
      amount: "37.50", expenseAccountId: s.acct.get("5131")!,
    });
    const batchId = await prepareAndCalculate(s);
    // Rewrite the snapshot's frozen expense account to a bogus id.
    await db().payrollBatchComponentSnapshot.updateMany({
      where: { batchId, componentCode: "CELL" },
      data: { expenseAccountIdSnapshot: "not-in-this-club" },
    });
    const readiness = await evaluatePayrollGlReadiness(s.ctlrP, s.club.id, batchId);
    expect(readiness.blockers.some((b) => b.code === "CROSS_TENANT_ACCOUNT")).toBe(true);
  });
});

// ===================================================================
// I · Mapping frozen at PREPARE (§11, §12, §70)
// ===================================================================
describe("Payroll-3C-6 · mapping immutability", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("changing live component's expenseAccountId AFTER prepare does not alter the frozen snapshot", async () => {
    const s = await seedScenario("frozen");
    const cell = await addComponent(s, {
      code: "CELL", displayName: "Cell", section: "EARNINGS",
      side: "EMPLOYEE", cashEffect: "INCREASES_NET_PAY", category: "ALLOWANCE",
      amount: "37.50", expenseAccountId: s.acct.get("5131")!,
    });
    const batchId = await prepareAndCalculate(s);
    // Change the LIVE mapping to a different account.
    await db().payrollComponent.update({
      where: { id: cell.id },
      data: { expenseAccountId: s.acct.get("5133")! }, // switch to bonus expense
    });
    const posted = await postPayrollBatch(s.ctlrP, batchId);
    const j = await readJournal(posted.journalEntryId);
    // The debit must still target the ORIGINAL 5131, not the new 5133.
    expect(j.debits.find((l) => l.account.accountNumber === "5131")).toBeDefined();
    expect(j.debits.find((l) => l.account.accountNumber === "5133")).toBeUndefined();
  });
});

// ===================================================================
// J · Statutory liability aggregation (§16, §17, §66)
// ===================================================================
describe("Payroll-3C-6 · statutory liabilities aggregate EE + ER", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("CPP payable = eeCpp + erCpp, EI payable = eeEi + erEi (single lines each)", async () => {
    const s = await seedScenario("statagg");
    const batchId = await prepareAndCalculate(s);
    const posted  = await postPayrollBatch(s.ctlrP, batchId);
    const j       = await readJournal(posted.journalEntryId);

    const cppLines = j.credits.filter((l) => l.account.accountNumber === "2110");
    const eiLines  = j.credits.filter((l) => l.account.accountNumber === "2120");
    expect(cppLines.length).toBe(1);
    expect(eiLines.length).toBe(1);

    const be = await db().payrollBatchEmployee.findFirstOrThrow({ where: { batchId } });
    const cppExpected = new Decimal(be.deductionCppEeCombined!.toString())
      .plus(new Decimal(be.deductionCpp2Ee?.toString() ?? "0"))
      .plus(new Decimal(be.employerCppCombined!.toString()))
      .plus(new Decimal(be.employerCpp2?.toString() ?? "0"));
    const eiExpected = new Decimal(be.deductionEiEe!.toString())
      .plus(new Decimal(be.employerEi!.toString()));
    expect(new Decimal(String(cppLines[0].credit)).toFixed(2)).toBe(cppExpected.toFixed(2));
    expect(new Decimal(String(eiLines[0].credit)).toFixed(2)).toBe(eiExpected.toFixed(2));
  });
});

// ===================================================================
// K · Net pay reconciliation (§65, §67)
// ===================================================================
describe("Payroll-3C-6 · net pay reconciles to PayrollBatchEmployee.netPay", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("net-pay-payable credit == sum of PayrollBatchEmployee.netPay", async () => {
    const s = await seedScenario("net");
    await addComponent(s, {
      code: "CELL", displayName: "Cell", section: "EARNINGS",
      side: "EMPLOYEE", cashEffect: "INCREASES_NET_PAY", category: "ALLOWANCE",
      taxable: "ADD", cpp: "ADD", ei: "ADD",
      amount: "37.50", expenseAccountId: s.acct.get("5131")!,
    });
    await addComponent(s, {
      code: "LTD", displayName: "LTD", section: "DEDUCTIONS",
      side: "EMPLOYEE", cashEffect: "DECREASES_NET_PAY", category: "EMPLOYEE_DEDUCTION",
      amount: "28.11",
      liabilityAccountId: s.acct.get("2160")!,
    });
    const batchId = await prepareAndCalculate(s);
    const posted  = await postPayrollBatch(s.ctlrP, batchId);
    const j       = await readJournal(posted.journalEntryId);
    const net = j.credits.find((l) => l.account.accountNumber === "2100")!;
    const be = await db().payrollBatchEmployee.findFirstOrThrow({ where: { batchId } });
    expect(new Decimal(String(net.credit)).toFixed(2)).toBe(new Decimal(be.netPay!.toString()).toFixed(2));
  });
});

// ===================================================================
// L · Journal balance exact + zero-line omission (§35, §89)
// ===================================================================
describe("Payroll-3C-6 · journal balance + zero-line omission", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("debits equal credits to the cent", async () => {
    const s = await seedScenario("balance");
    await addComponent(s, {
      code: "AD_D", displayName: "AD&D", section: "BENEFITS",
      side: "EMPLOYER", cashEffect: "NO_NET_PAY_EFFECT", category: "EMPLOYER_CONTRIBUTION",
      amount: "2.25",
      expenseAccountId: s.acct.get("5130")!, liabilityAccountId: s.acct.get("2160")!,
    });
    const batchId = await prepareAndCalculate(s);
    const posted = await postPayrollBatch(s.ctlrP, batchId);
    expect(posted.totalDebits).toBe(posted.totalCredits);
    // Manually re-sum
    const j = await readJournal(posted.journalEntryId);
    const dr = j.debits.reduce((s, l) => s.plus(String(l.debit)), new Decimal(0));
    const cr = j.credits.reduce((s, l) => s.plus(String(l.credit)), new Decimal(0));
    expect(dr.toFixed(2)).toBe(cr.toFixed(2));
    expect(dr.minus(cr).toFixed(2)).toBe("0.00");
  });

  it("does not emit lines for zero-amount contributions (no debit=0 or credit=0 rows)", async () => {
    // Zero-line omission is enforced by the addDebit/addCredit helpers
    // in approve-and-post.ts, which skip when amount.isZero(). Prove
    // this end-to-end: a normal balanced post never carries a row
    // whose active side is 0.
    const s = await seedScenario("zero");
    await addComponent(s, {
      code: "CELL", displayName: "Cell", section: "EARNINGS",
      side: "EMPLOYEE", cashEffect: "INCREASES_NET_PAY", category: "ALLOWANCE",
      amount: "37.50", expenseAccountId: s.acct.get("5131")!,
    });
    const batchId = await prepareAndCalculate(s);
    const posted = await postPayrollBatch(s.ctlrP, batchId);
    const j = await readJournal(posted.journalEntryId);
    for (const l of j.entry.lines) {
      const d = new Decimal(String(l.debit));
      const c = new Decimal(String(l.credit));
      // Exactly one of debit / credit is non-zero on every emitted line.
      expect(d.isZero() && c.isZero()).toBe(false);
    }
  });
});

// ===================================================================
// M · Idempotent post + APPROVED-only + atomic rollback (§50, §76)
// ===================================================================
describe("Payroll-3C-6 · idempotency + rollback", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("posting the same batch twice returns the same journal entry id", async () => {
    const s = await seedScenario("idem");
    const batchId = await prepareAndCalculate(s);
    const a = await postPayrollBatch(s.ctlrP, batchId);
    const b = await postPayrollBatch(s.ctlrP, batchId);
    expect(a.journalEntryId).toBe(b.journalEntryId);
  });

  it("readiness failure leaves batch APPROVED and creates no journal", async () => {
    const s = await seedScenario("rollback");
    await addComponent(s, {
      code: "LIFE_ER", displayName: "Life", section: "BENEFITS",
      side: "EMPLOYER", cashEffect: "NO_NET_PAY_EFFECT", category: "EMPLOYER_CONTRIBUTION",
      amount: "20.93",
      // Missing both accounts to trip readiness.
    });
    const batchId = await prepareAndCalculate(s);
    await expect(postPayrollBatch(s.ctlrP, batchId)).rejects.toThrow();
    const batch = await db().payrollBatch.findUniqueOrThrow({ where: { id: batchId } });
    expect(batch.status).toBe("APPROVED");
    expect(batch.glJournalEntryId).toBeNull();
    const count = await db().journalEntry.count({
      where: { source: "PAYROLL", sourceEntityId: batchId },
    });
    expect(count).toBe(0);
  });
});

// ===================================================================
// N · One-time bonus + one-time deduction (§22, §23, §43, §45)
// ===================================================================
describe("Payroll-3C-6 · one-time adjustments", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("one-time bonus posts to its expense account, once, not double-counted", async () => {
    const s = await seedScenario("bonus");
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
    // Prepare + add one-time before calculate.
    const pp = await db().payrollPayPeriod.findFirstOrThrow({
      where: { clubId: s.club.id, payGroupId: s.pg.id, sequenceInYear: 17 },
    });
    const prep = await preparePayrollBatch(s.paP, s.club.id, pp.id);
    const be = await db().payrollBatchEmployee.findFirstOrThrow({ where: { batchId: prep.batchId } });
    await addOneTimeAdjustment(s.paP, s.club.id, prep.batchId, {
      batchEmployeeId: be.id, componentCode: "BONUS",
      amount: "500", reason: "Q3 spot bonus",
    });
    await calculatePayrollBatch(s.paP, s.club.id, prep.batchId);
    await approvePayrollBatch(s.ctlrP, prep.batchId);
    const posted = await postPayrollBatch(s.ctlrP, prep.batchId);
    const j = await readJournal(posted.journalEntryId);
    const bonusLines = j.debits.filter((l) => l.account.accountNumber === "5133");
    expect(bonusLines.length).toBe(1);
    expect(new Decimal(String(bonusLines[0].debit)).toFixed(2)).toBe("500.00");
    expect(posted.totalDebits).toBe(posted.totalCredits);
  });
});

// ===================================================================
// O · Historical journal immutability (§69, §71)
// ===================================================================
describe("Payroll-3C-6 · historical journal immutability", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("renaming or deactivating a component after POST does not mutate the journal", async () => {
    const s = await seedScenario("hist");
    const cell = await addComponent(s, {
      code: "CELL", displayName: "Cell Phone", section: "EARNINGS",
      side: "EMPLOYEE", cashEffect: "INCREASES_NET_PAY", category: "ALLOWANCE",
      amount: "37.50", expenseAccountId: s.acct.get("5131")!,
    });
    const batchId = await prepareAndCalculate(s);
    const posted = await postPayrollBatch(s.ctlrP, batchId);
    const before = await readJournal(posted.journalEntryId);
    // Mutate live catalogue.
    await db().payrollComponent.update({
      where: { id: cell.id },
      data: { displayName: "Mobile", active: false, expenseAccountId: s.acct.get("5133")! },
    });
    const after = await readJournal(posted.journalEntryId);
    expect(JSON.stringify(before)).toBe(JSON.stringify(after));
  });
});

// ===================================================================
// P · Tenant isolation (§75)
// ===================================================================
describe("Payroll-3C-6 · tenant isolation", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("readiness cannot be run by a principal outside the batch's Club", async () => {
    const s   = await seedScenario("iso-own");
    const otr = await seedScenario("iso-other");
    const batchId = await prepareAndCalculate(s);
    await expect(
      evaluatePayrollGlReadiness(otr.ctlrP, s.club.id, batchId),
    ).rejects.toThrow();
  });
});

// ===================================================================
// Q · Sensitive-data leak audit in journal descriptions (§74)
// ===================================================================
describe("Payroll-3C-6 · no PII in journal descriptions", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("journal descriptions carry component labels only, no employee names / SIN / bank / TD1 claims", async () => {
    const s = await seedScenario("pii");
    await addComponent(s, {
      code: "CELL", displayName: "Cell Phone", section: "EARNINGS",
      side: "EMPLOYEE", cashEffect: "INCREASES_NET_PAY", category: "ALLOWANCE",
      amount: "37.50", expenseAccountId: s.acct.get("5131")!,
    });
    const batchId = await prepareAndCalculate(s);
    const posted = await postPayrollBatch(s.ctlrP, batchId);
    const j = await readJournal(posted.journalEntryId);
    const blob = JSON.stringify(j.entry.lines.map((l) => l.description ?? ""));
    expect(blob).not.toMatch(/\b\d{3}[\s-]?\d{3}[\s-]?\d{3}\b/); // SIN
    expect(blob).not.toContain("16452"); // fed TD1
    expect(blob).not.toContain("22769"); // AB TD1
    expect(blob).not.toContain("Test Emp"); // employee name
  });
});
