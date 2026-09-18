// Slice B acceptance-blocker (2026-09-18) — reusable payroll integration
// fixture. Composes the full stack a real payroll batch needs (statutory
// package, GL profile + accounts, fiscal year/period, Club config, pay group
// + calendar, employee + assignment + compensation + TD1, pay-group member,
// implementation declaration) so a test can exercise the real
// preparePayrollBatch → calculatePayrollBatch → submitPayrollBatch →
// approvePayrollBatch → postPayrollBatch → buildPayStatement → getEmployeePayrollYtd
// pipeline end-to-end.
//
// Intended re-users: Slice B acceptance-blocker (this file), Slice C (LTD /
// Health enrolment integration), Slice D (RRSP plan integration).
//
// The harness lives in tests/ only — no production coupling.

import { db, makeClub, makeUser, principalFor } from "./db";
import { Prisma } from "@prisma/client";
import { upsertPayrollClubConfig } from "@/lib/payroll/club-config";
import { writeEncryptedTd1Claims } from "@/lib/hr/td1-secure-write";
import { declareImplementation } from "@/lib/payroll/implementation-declaration";
import { seedCanadaAlbertaPackages2026 } from "@/lib/payroll/statutory/seed-ca-ab-2026";

const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));

async function superAdminP() {
  const c = db();
  const email = `super-fixture-${Math.random().toString(36).slice(2, 8)}@spectre.test`;
  const u = await c.user.create({
    data: { email, name: "SuperFixture", role: "SUPER_ADMIN", passwordHash: "x", status: "ACTIVE" },
  });
  await c.userClubRole.create({ data: { userId: u.id, clubId: null, roleKey: "SUPER_ADMIN" } });
  return principalFor(email);
}

async function seedFiscalYearMonth(clubId: string, payDate: Date) {
  const c = db();
  const y = payDate.getUTCFullYear();
  const fy = await c.fiscalYear.create({
    data: { clubId, label: `FY${y}`, startDate: utc(y, 1, 1), endDate: utc(y, 12, 31), status: "OPEN" },
  });
  const m = payDate.getUTCMonth() + 1;
  await c.fiscalPeriod.create({
    data: {
      clubId, fiscalYearId: fy.id, label: `FY${y}-M${String(m).padStart(2, "0")}`,
      startDate: utc(y, m, 1), endDate: utc(y, m + 1, 0),
      sequence: m, status: "OPEN",
    },
  });
}

/** Create an Account row scoped to the club. */
async function acct(clubId: string, number: string, name: string, type: "EXPENSE" | "LIABILITY") {
  return db().account.create({
    data: {
      clubId, accountNumber: number, name, type,
      normalBalance: type === "EXPENSE" ? "DEBIT" : "CREDIT",
      isActive: true, allowManualPosting: false,
    },
  });
}

async function seedGlProfileAccounts(clubId: string) {
  const c = db();
  const salaryExpense       = await acct(clubId, "5100", "Salary Expense", "EXPENSE");
  const employerCppExpense  = await acct(clubId, "5110", "Employer CPP Expense", "EXPENSE");
  const employerEiExpense   = await acct(clubId, "5120", "Employer EI Expense", "EXPENSE");
  const netPayPayable       = await acct(clubId, "2100", "Net Pay Payable", "LIABILITY");
  const cppPayable          = await acct(clubId, "2110", "CPP Payable", "LIABILITY");
  const eiPayable           = await acct(clubId, "2120", "EI Payable", "LIABILITY");
  const federalTaxPayable   = await acct(clubId, "2130", "Federal Tax Payable", "LIABILITY");
  const provincialTaxPayable = await acct(clubId, "2140", "AB Tax Payable", "LIABILITY");

  const profile = await c.payrollGlAccountingProfile.create({
    data: {
      clubId,
      salaryExpenseAccountId: salaryExpense.id,
      employerCppExpenseAccountId: employerCppExpense.id,
      employerEiExpenseAccountId: employerEiExpense.id,
      netPayPayableAccountId: netPayPayable.id,
      cppPayableAccountId: cppPayable.id,
      eiPayableAccountId: eiPayable.id,
      federalTaxPayableAccountId: federalTaxPayable.id,
      provincialTaxPayableAccountId: provincialTaxPayable.id,
    },
  });
  return { profile, salaryExpense };
}

/** Semi-monthly 2026 calendar generator (24 rows). Sept + surrounding months
 *  are the interesting ones; we seed the whole year so
 *  resolvePeriodsPerYearFromCalendar is satisfied. */
async function seedSemiMonthlyCalendar(clubId: string, payGroupId: string) {
  const c = db();
  let seq = 0;
  for (let m = 0; m < 12; m++) {
    seq += 1;
    await c.payrollPayPeriod.create({
      data: {
        clubId, payGroupId, taxYear: 2026, sequenceInYear: seq,
        periodStart: utc(2026, m + 1, 1), periodEnd: utc(2026, m + 1, 16),
        payDate: utc(2026, m + 1, 15), status: "OPEN",
      },
    });
    seq += 1;
    // LAST calendar day of month (day 0 of next month in UTC).
    const lastDay = new Date(Date.UTC(2026, m + 1, 0)).getUTCDate();
    await c.payrollPayPeriod.create({
      data: {
        clubId, payGroupId, taxYear: 2026, sequenceInYear: seq,
        periodStart: utc(2026, m + 1, 16), periodEnd: utc(2026, m + 2, 1),
        payDate: utc(2026, m + 1, lastDay), status: "OPEN",
      },
    });
  }
}

export interface PayrollIntegrationFixture {
  club: { id: string; slug: string; name: string };
  clubId: string;
  adminP: Awaited<ReturnType<typeof principalFor>>;
  paP: Awaited<ReturnType<typeof principalFor>>;
  controllerP: Awaited<ReturnType<typeof principalFor>>;
  posterP: Awaited<ReturnType<typeof principalFor>>;
  paUser: { id: string };
  controllerUser: { id: string };
  posterUser: { id: string };
  emp: { id: string };
  department: { id: string; name: string; code: string };
  payGroupId: string;
  payPeriodId: string;
  periodStart: Date;
  periodEnd: Date;
  payDate: Date;
  glProfile: { id: string; salaryExpenseAccountId: string };
  /** Optional Bonus catalogue component + its dedicated expense account. */
  bonus?: { id: string; code: string; expenseAccountId: string };
  cellPhone?: { id: string; code: string };
}

export interface CreateFixtureOpts {
  clubName: string;
  annualSalary?: string;
  cellPhoneAmount?: string;
  bonusAmount?: string;      // if omitted, no bonus scheduled
  /** Which SM period sequence to target (default 18 = Sep 16 → Oct 1). */
  targetSequence?: number;
}

/**
 * Compose the full payroll fixture. Returns a ready-to-use scenario for
 * the caller to Prepare → Calculate → Submit → Approve → Post against.
 *
 * If `cellPhoneAmount` is set, a recurring Cell Phone Allowance is
 * assigned (Phase 4 canonical).
 *
 * If `bonusAmount` is set, a PayrollScheduledOneTimeEarning is created
 * for the target pay period with the given amount and a dedicated
 * expense account (so GL frozen-account assertions are unambiguous).
 */
export async function createPayrollIntegrationFixture(
  opts: CreateFixtureOpts,
): Promise<PayrollIntegrationFixture> {
  const c = db();
  const sup = await superAdminP();
  const existingPkg = await c.payrollStatutoryPackage.count({ where: { jurisdictionCountry: "CA" } });
  if (existingPkg === 0) await seedCanadaAlbertaPackages2026(sup);

  const club = await makeClub(opts.clubName);
  const admin = await makeUser({ email: `admin.${club.id}@t.test`, role: "CLUB_ADMIN", clubId: club.id });
  const pa    = await makeUser({ email: `pa.${club.id}@t.test`,    role: "PAYROLL_ADMIN", clubId: club.id });
  const ctl   = await makeUser({ email: `ctl.${club.id}@t.test`,   role: "CONTROLLER",    clubId: club.id });
  const poster = await makeUser({ email: `poster.${club.id}@t.test`, role: "CLUB_ADMIN", clubId: club.id });
  const adminP = await principalFor(admin.email);
  const paP    = await principalFor(pa.email);
  const controllerP = await principalFor(ctl.email);
  const posterP = await principalFor(poster.email);

  const { profile, salaryExpense } = await seedGlProfileAccounts(club.id);

  await upsertPayrollClubConfig(adminP, club.id, {
    provinceOfEmployment: "AB",
    payrollAdminUserId: pa.id,
    controllerUserId: ctl.id,
  });
  await c.payrollClubConfig.updateMany({
    where: { clubId: club.id }, data: { glAccountingProfileId: profile.id },
  });

  await declareImplementation(paP, club.id, {
    taxYear: 2026, mode: "ZERO_OPENING_YTD",
  });

  const department = await c.department.create({
    data: { clubId: club.id, code: "ADMIN", name: "Administration" },
  });

  // Employee + PRIMARY assignment + compensation + TD1.
  const empEmail = `emp.${club.id}@t.test`;
  const emp = await c.employee.create({
    data: {
      clubId: club.id, firstName: "Full", lastName: "Pipeline",
      email: empEmail, hireDate: utc(2020, 1, 1),
      dateOfBirth: utc(1985, 5, 12),
      status: "ACTIVE", employeeNumber: `E-${club.id.slice(-6)}`,
      employeeLifecycle: "ACTIVE", compensationType: "SALARY",
      homeProvince: "AB", departmentId: department.id,
    },
  });
  const assn = await c.employeeEmploymentAssignment.create({
    data: {
      clubId: club.id, employeeId: emp.id, role: "PRIMARY",
      employmentType: "FULL_TIME", effectiveFrom: utc(2020, 1, 1),
      departmentId: department.id,
    },
  });
  await c.employeeCompensation.create({
    data: {
      clubId: club.id, employeeId: emp.id, assignmentId: assn.id,
      cadence: "SALARY", rate: opts.annualSalary ?? "110000", currency: "CAD",
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
      clubId: club.id, code: "SAL-SM", name: "Salary Semi-Monthly",
      payFrequency: "SEMI_MONTHLY", payDateOffsetDays: 0,
      calendarAnchorDate: null, active: true,
    },
  });
  await seedSemiMonthlyCalendar(club.id, pg.id);
  const targetSeq = opts.targetSequence ?? 18; // Sep 16 → Oct 1 → payDate Sep 30
  const pp = await c.payrollPayPeriod.findFirstOrThrow({
    where: { clubId: club.id, payGroupId: pg.id, sequenceInYear: targetSeq },
  });
  await c.payrollPayGroupMember.create({
    data: { clubId: club.id, payGroupId: pg.id, employeeId: emp.id, effectiveFrom: utc(2020, 1, 1) },
  });

  // Optional Cell Phone recurring.
  let cellPhone: PayrollIntegrationFixture["cellPhone"];
  if (opts.cellPhoneAmount) {
    const cellExpense = await acct(club.id, "5130", "Cell Phone Allowance Expense", "EXPENSE");
    const cell = await c.payrollComponent.create({
      data: {
        clubId: club.id, code: "CELL_PHONE_ALLOWANCE", displayName: "Cell Phone Allowance",
        category: "ALLOWANCE", side: "EMPLOYEE",
        cashEffect: "INCREASES_NET_PAY",
        taxableEffect: "ADD", cppPensionableEffect: "ADD", eiInsurableEffect: "NONE",
        calculationMethod: "FIXED_AMOUNT", displaySection: "EARNINGS",
        usage: "RECURRING", expenseAccountId: cellExpense.id,
      },
    });
    await c.employeeRecurringPayrollComponent.create({
      data: {
        clubId: club.id, employeeId: emp.id, componentId: cell.id,
        amount: opts.cellPhoneAmount, effectiveFrom: utc(2020, 1, 1),
        active: true,
      },
    });
    cellPhone = { id: cell.id, code: cell.code };
  }

  // Optional Bonus scheduled (one-time).
  let bonus: PayrollIntegrationFixture["bonus"];
  if (opts.bonusAmount) {
    const bonusExpense = await acct(club.id, "5140", "Performance Bonus Expense", "EXPENSE");
    const b = await c.payrollComponent.create({
      data: {
        clubId: club.id, code: "PERF_BONUS", displayName: "Performance Bonus",
        category: "ADDITIONAL_EARNING", side: "EMPLOYEE",
        cashEffect: "INCREASES_NET_PAY",
        taxableEffect: "ADD", cppPensionableEffect: "ADD", eiInsurableEffect: "ADD",
        calculationMethod: "FIXED_AMOUNT", displaySection: "EARNINGS",
        usage: "ONE_TIME", expenseAccountId: bonusExpense.id,
      },
    });
    await c.payrollScheduledOneTimeEarning.create({
      data: {
        clubId: club.id, employeeId: emp.id, payPeriodId: pp.id, componentId: b.id,
        amount: new Prisma.Decimal(opts.bonusAmount), reason: "Performance bonus",
        status: "SCHEDULED", enteredByUserId: pa.id,
      },
    });
    bonus = { id: b.id, code: b.code, expenseAccountId: bonusExpense.id };
  }

  // Fiscal year + month covering the payDate — Post writes to
  // JournalEntry which requires an OPEN fiscal period.
  await seedFiscalYearMonth(club.id, pp.payDate);

  return {
    club, clubId: club.id,
    adminP, paP, controllerP, posterP,
    paUser: { id: pa.id }, controllerUser: { id: ctl.id }, posterUser: { id: poster.id },
    emp: { id: emp.id },
    department: { id: department.id, name: department.name, code: department.code },
    payGroupId: pg.id, payPeriodId: pp.id,
    periodStart: pp.periodStart, periodEnd: pp.periodEnd, payDate: pp.payDate,
    glProfile: { id: profile.id, salaryExpenseAccountId: salaryExpense.id },
    bonus, cellPhone,
  };
}
