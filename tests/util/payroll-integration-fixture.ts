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
  // Slice C closeout (2026-09-18) §22 — reusable fixture default SoD:
  //   adminP       → CLUB_ADMIN (broad-override, plan config)
  //   paP          → PAYROLL_ADMIN (Prepare / Calc / Submit / Post)
  //   controllerP  → CONTROLLER (independent Approve / Return only)
  //   posterP      → alias of `paP`. PA is the poster. Retained as a named
  //                  seam so tests read intent ("post as poster") clearly.
  // Historical: prior fixture created a separate CLUB_ADMIN poster. That
  // conflated Post authority with role-elevation. Removed 2026-09-18.
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
  /** Slice C — LTD benefit plan + enrolment (employee premium). */
  ltdPlan?: { planId: string; employeeComponentId: string; employeeExpenseAccountId: string; enrolmentId: string };
  /** Slice C — Health/Dental benefit plan + enrolment (employer premium, non-cash taxable). */
  healthPlan?: { planId: string; employerComponentId: string; employerExpenseAccountId: string; enrolmentId: string };
  /** Slice F — extra HOURLY employee with approved time entries producing OT. */
  hourly?: {
    employeeId: string;
    assignmentId: string;
    compensationId: string;
    hourlyRate: string;
    approvedTimeEntries: Array<{ id: string; workDate: Date; hours: string }>;
  };
  /** Slice D — RRSP benefit plan + enrolment (employee % election with employer match/cap). */
  rrspPlan?: {
    planId: string;
    employeeComponentId: string;
    employerComponentId: string;
    employeeExpenseAccountId: string;
    employeeLiabilityAccountId: string;
    employerExpenseAccountId: string;
    employerLiabilityAccountId: string;
    enrolmentId: string;
    employerMatchBps: number;
    employerMatchCapBps: number;
    employeePercentBps: number;
  };
}

export interface CreateFixtureOpts {
  clubName: string;
  annualSalary?: string;
  cellPhoneAmount?: string;
  bonusAmount?: string;      // if omitted, no bonus scheduled
  /** Slice C — LTD plan + employee-premium enrolment. */
  ltd?: { employeeMonthlyPremium: string };
  /** Slice C — Health/Dental plan + employer-premium enrolment.
   *  Fixture configures it as a non-cash taxable benefit — this is
   *  FIXTURE CONFIGURATION, not a hard-coded rule about Health plans. */
  healthDental?: { employerMonthlyPremium: string };
  /** Slice F — provision an additional HOURLY employee + approved time
   *  entries producing OVERTIME under the Alberta ES default policy.
   *  Provide a list of civil days with hours; the fixture creates a
   *  scope-approved PayrollApprovedTimeEntry for each. */
  hourlyEmployee?: {
    firstName?: string;
    lastName?: string;
    hourlyRate: string;
    /** approvedTime entries — one per day. `hours` is Decimal-string. */
    approvedTime: Array<{ workDate: Date; hours: string }>;
  };
  /** Slice D — RRSP plan + employee % election + employer match/cap.
   *  Both components are PERCENT_OF_ELIGIBLE_EARNINGS. Fixture is
   *  configured post-tax (all statutory effects NONE on both sides) —
   *  this is FIXTURE CONFIGURATION; Spectre honours the frozen
   *  PayrollComponent semantics, not plan.kind. */
  rrsp?: {
    employeePercent: number;   // human %, e.g. 5 = 5%
    employerMatchPercent: number;
    employerCapPercent: number;
    eligibleEarningsBasis?: "REGULAR_EARNINGS_ONLY" | "CASH_EARNINGS";
  };
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
  const adminP = await principalFor(admin.email);
  const paP    = await principalFor(pa.email);
  const controllerP = await principalFor(ctl.email);
  // Slice C closeout (2026-09-18) §22 — PA is the poster. Retain a named
  // alias so tests remain readable.
  const posterP = paP;
  const poster = pa;

  const { profile, salaryExpense } = await seedGlProfileAccounts(club.id);

  await upsertPayrollClubConfig(adminP, club.id, {
    provinceOfEmployment: "AB",
    payrollAdminUserId: pa.id,
    controllerUserId: ctl.id,
  });
  await c.payrollClubConfig.updateMany({
    where: { clubId: club.id },
    // Slice F workweek-closeout (2026-09-19) — the test fixture seeds
    // an explicit workweekStartsOn so hourly Prepare doesn't fail-close
    // on WORKWEEK_NOT_CONFIGURED. Default SUNDAY (matches Alberta's
    // historical convention and the 40/10 reference acceptance results).
    data: { glAccountingProfileId: profile.id, workweekStartsOn: "SUNDAY" },
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

  // Slice C — LTD benefit plan (employee premium as a post-tax
  // deduction, per FIXTURE CONFIGURATION). Component semantics:
  // EMPLOYEE_DEDUCTION + DECREASES_NET_PAY + all statutory effects NONE.
  let ltdPlan: PayrollIntegrationFixture["ltdPlan"];
  if (opts.ltd) {
    // Employee post-tax deduction: credited to a payable (liability),
    // not an employer expense. The `expenseAccountId` is retained (kept
    // as a mirror of the audit's founder-neutral pattern) so the LTD
    // line still shows an accountable debit on the preview.
    const ltdExpense = await acct(club.id, "5150", "LTD Employee Premium Expense", "EXPENSE");
    const ltdLiab = await acct(club.id, "2150", "LTD Employee Payable", "LIABILITY");
    const ltdComp = await c.payrollComponent.create({
      data: {
        clubId: club.id, code: "LTD_EE", displayName: "LTD Employee Premium",
        category: "EMPLOYEE_DEDUCTION", side: "EMPLOYEE",
        cashEffect: "DECREASES_NET_PAY",
        taxableEffect: "NONE", cppPensionableEffect: "NONE", eiInsurableEffect: "NONE",
        calculationMethod: "FIXED_AMOUNT", displaySection: "DEDUCTIONS",
        usage: "RECURRING",
        expenseAccountId: ltdExpense.id,
        liabilityAccountId: ltdLiab.id,
      },
    });
    const { createBenefitPlan } = await import("@/lib/payroll/benefit-plans");
    const { enrolEmployeeInBenefitPlan } = await import("@/lib/payroll/benefit-enrolments");
    const plan = await createBenefitPlan(adminP, club.id, {
      kind: "LTD", code: "LTD_FIXTURE", name: "LTD Standard (Fixture)",
      description: "Fixture-configured LTD plan for integration testing",
      effectiveFrom: utc(2020, 1, 1),
      employeeComponentId: ltdComp.id,
      defaultElectionKind: "FIXED_AMOUNT",
    });
    const enrolment = await enrolEmployeeInBenefitPlan(adminP, club.id, {
      employeeId: emp.id, planId: plan.id,
      effectiveFrom: utc(2020, 1, 1),
      electionKind: "FIXED_AMOUNT",
      amount: opts.ltd.employeeMonthlyPremium,
      notes: "Fixture enrolment",
    });
    ltdPlan = {
      planId: plan.id,
      employeeComponentId: ltdComp.id,
      employeeExpenseAccountId: ltdExpense.id,
      enrolmentId: enrolment.id,
    };
  }

  // Slice C — Health/Dental benefit plan (employer premium as a
  // non-cash taxable benefit, per FIXTURE CONFIGURATION — not a hard-
  // coded rule about Health plans). Component semantics: TAXABLE_BENEFIT
  // + EMPLOYER + NO_NET_PAY_EFFECT + taxableEffect=ADD.
  let healthPlan: PayrollIntegrationFixture["healthPlan"];
  if (opts.healthDental) {
    const healthExpense = await acct(club.id, "5160", "Employer Health Premium Expense", "EXPENSE");
    const healthLiab = await acct(club.id, "2160", "Health Benefit Liability", "LIABILITY");
    const healthComp = await c.payrollComponent.create({
      data: {
        clubId: club.id, code: "HEALTH_ER", displayName: "Employer Health Premium",
        category: "TAXABLE_BENEFIT", side: "EMPLOYER",
        cashEffect: "NO_NET_PAY_EFFECT",
        taxableEffect: "ADD", cppPensionableEffect: "ADD", eiInsurableEffect: "NONE",
        calculationMethod: "FIXED_AMOUNT", displaySection: "BENEFITS",
        usage: "RECURRING", expenseAccountId: healthExpense.id, liabilityAccountId: healthLiab.id,
      },
    });
    const { createBenefitPlan } = await import("@/lib/payroll/benefit-plans");
    const { enrolEmployeeInBenefitPlan } = await import("@/lib/payroll/benefit-enrolments");
    const plan = await createBenefitPlan(adminP, club.id, {
      kind: "HEALTH_DENTAL", code: "HEALTH_FIXTURE", name: "Group Health (Fixture)",
      effectiveFrom: utc(2020, 1, 1),
      employerComponentId: healthComp.id,
      defaultElectionKind: "FIXED_AMOUNT",
    });
    const enrolment = await enrolEmployeeInBenefitPlan(adminP, club.id, {
      employeeId: emp.id, planId: plan.id,
      effectiveFrom: utc(2020, 1, 1),
      electionKind: "FIXED_AMOUNT",
      amount: opts.healthDental.employerMonthlyPremium,
    });
    healthPlan = {
      planId: plan.id,
      employerComponentId: healthComp.id,
      employerExpenseAccountId: healthExpense.id,
      enrolmentId: enrolment.id,
    };
  }

  // Slice D — RRSP benefit plan with percent employee election +
  // employer match/cap. Both components configured POST-TAX (all
  // statutory effects NONE) per fixture configuration — Spectre
  // executes what the linked components declare, not plan.kind.
  let rrspPlan: PayrollIntegrationFixture["rrspPlan"];
  if (opts.rrsp) {
    const eeExpense = await acct(club.id, "5170", "RRSP Employee Contribution Expense", "EXPENSE");
    const eeLiab    = await acct(club.id, "2170", "RRSP Employee Payable",              "LIABILITY");
    const erExpense = await acct(club.id, "5180", "RRSP Employer Match Expense",        "EXPENSE");
    const erLiab    = await acct(club.id, "2180", "RRSP Employer Payable",              "LIABILITY");
    const eeComp = await c.payrollComponent.create({
      data: {
        clubId: club.id, code: "RRSP_EE", displayName: "RRSP Employee Contribution",
        category: "EMPLOYEE_DEDUCTION", side: "EMPLOYEE",
        cashEffect: "DECREASES_NET_PAY",
        taxableEffect: "NONE", cppPensionableEffect: "NONE", eiInsurableEffect: "NONE",
        calculationMethod: "PERCENT_OF_ELIGIBLE_EARNINGS",
        eligibleEarningsBase: opts.rrsp.eligibleEarningsBasis ?? "REGULAR_EARNINGS_ONLY",
        displaySection: "DEDUCTIONS", usage: "RECURRING",
        expenseAccountId: eeExpense.id, liabilityAccountId: eeLiab.id,
      },
    });
    const erComp = await c.payrollComponent.create({
      data: {
        clubId: club.id, code: "RRSP_ER", displayName: "RRSP Employer Match",
        category: "EMPLOYER_CONTRIBUTION", side: "EMPLOYER",
        cashEffect: "NO_NET_PAY_EFFECT",
        taxableEffect: "NONE", cppPensionableEffect: "NONE", eiInsurableEffect: "NONE",
        calculationMethod: "PERCENT_OF_ELIGIBLE_EARNINGS",
        eligibleEarningsBase: opts.rrsp.eligibleEarningsBasis ?? "REGULAR_EARNINGS_ONLY",
        displaySection: "BENEFITS", usage: "RECURRING",
        expenseAccountId: erExpense.id, liabilityAccountId: erLiab.id,
      },
    });
    const { createBenefitPlan } = await import("@/lib/payroll/benefit-plans");
    const { enrolEmployeeInBenefitPlan } = await import("@/lib/payroll/benefit-enrolments");
    const employerMatchBps    = Math.round(opts.rrsp.employerMatchPercent * 100);
    const employerMatchCapBps = Math.round(opts.rrsp.employerCapPercent   * 100);
    const employeePercentBps  = Math.round(opts.rrsp.employeePercent      * 100);
    const plan = await createBenefitPlan(adminP, club.id, {
      kind: "RRSP", code: "RRSP_FIXTURE", name: "RRSP Standard (Fixture)",
      description: "Fixture RRSP plan for Slice D integration testing",
      effectiveFrom: utc(2020, 1, 1),
      employeeComponentId: eeComp.id,
      employerComponentId: erComp.id,
      defaultElectionKind: "PERCENT_OF_ELIGIBLE_EARNINGS",
      eligibleEarningsBasis: opts.rrsp.eligibleEarningsBasis ?? "REGULAR_EARNINGS_ONLY",
      employerMatchBps,
      employerMatchCapBps,
    });
    const enrolment = await enrolEmployeeInBenefitPlan(adminP, club.id, {
      employeeId: emp.id, planId: plan.id,
      effectiveFrom: utc(2020, 1, 1),
      electionKind: "PERCENT_OF_ELIGIBLE_EARNINGS",
      percentBps: employeePercentBps,
    });
    rrspPlan = {
      planId: plan.id,
      employeeComponentId: eeComp.id,
      employerComponentId: erComp.id,
      employeeExpenseAccountId: eeExpense.id,
      employeeLiabilityAccountId: eeLiab.id,
      employerExpenseAccountId: erExpense.id,
      employerLiabilityAccountId: erLiab.id,
      enrolmentId: enrolment.id,
      employerMatchBps,
      employerMatchCapBps,
      employeePercentBps,
    };
  }

  // Slice F (2026-09-19) — additional HOURLY employee producing OT.
  // Salaried default fixture employee remains for pipeline continuity;
  // this hourly employee is provisioned as a SEPARATE population row.
  let hourly: PayrollIntegrationFixture["hourly"];
  if (opts.hourlyEmployee) {
    const hEmpEmail = `hourly.${club.id}@t.test`;
    const hEmp = await c.employee.create({
      data: {
        clubId: club.id,
        firstName: opts.hourlyEmployee.firstName ?? "SliceF",
        lastName:  opts.hourlyEmployee.lastName  ?? "HourlyOT",
        email: hEmpEmail, hireDate: utc(2020, 1, 1),
        dateOfBirth: utc(1990, 5, 12),
        status: "ACTIVE", employeeNumber: `H-${club.id.slice(-6)}`,
        employeeLifecycle: "ACTIVE", compensationType: "HOURLY",
        homeProvince: "AB", departmentId: department.id,
      },
    });
    const hAssn = await c.employeeEmploymentAssignment.create({
      data: {
        clubId: club.id, employeeId: hEmp.id, role: "PRIMARY",
        employmentType: "FULL_TIME", effectiveFrom: utc(2020, 1, 1),
        departmentId: department.id,
      },
    });
    const hComp = await c.employeeCompensation.create({
      data: {
        clubId: club.id, employeeId: hEmp.id, assignmentId: hAssn.id,
        cadence: "HOURLY", rate: opts.hourlyEmployee.hourlyRate, currency: "CAD",
        effectiveFrom: utc(2020, 1, 1),
      },
    });
    await writeEncryptedTd1Claims({
      clubId: club.id, employeeId: hEmp.id, effectiveFrom: utc(2020, 1, 1),
      province: "AB", td1FormVersion: "2026-01",
      federalClaim: "16452.00", provincialClaim: "22769.00",
    });
    await c.payrollPayGroupMember.create({
      data: { clubId: club.id, payGroupId: pg.id, employeeId: hEmp.id, effectiveFrom: utc(2020, 1, 1) },
    });
    // Create a PayrollDepartmentTimeApproval row that pre-approves the
    // pay period's scope so the approved-time rows are consumable at
    // Prepare. Simpler shortcut for the test: create rows directly as
    // approvalState=APPROVED with `approvedByUserId` set.
    const approvedTimeCreated: Array<{ id: string; workDate: Date; hours: string }> = [];
    for (const t of opts.hourlyEmployee.approvedTime) {
      const row = await c.payrollApprovedTimeEntry.create({
        data: {
          clubId: club.id, employeeId: hEmp.id,
          employmentAssignmentId: hAssn.id,
          workDate: t.workDate,
          hours: t.hours,
          approvalState: "APPROVED",
          approvedByUserId: pa.id,
          approvedAt: new Date(),
          earningClassification: "REGULAR",
        },
      });
      approvedTimeCreated.push({ id: row.id, workDate: row.workDate, hours: row.hours.toString() });
    }
    // Prepare requires PayrollDepartmentTimeApproval for every
    // department that has approved-time entries INSIDE the period.
    // Null approvedRevision + null approvedScopeVersion is the legacy
    // 3D-2 compat path and passes preparation's currency gate.
    await c.payrollDepartmentTimeApproval.create({
      data: {
        clubId: club.id, payPeriodId: pp.id, departmentId: department.id,
        state: "APPROVED", approvedAt: new Date(),
        approvedByUserId: pa.id,
      },
    });
    hourly = {
      employeeId: hEmp.id,
      assignmentId: hAssn.id,
      compensationId: hComp.id,
      hourlyRate: opts.hourlyEmployee.hourlyRate,
      approvedTimeEntries: approvedTimeCreated,
    };
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
    bonus, cellPhone, ltdPlan, healthPlan, rrspPlan, hourly,
  };
}
