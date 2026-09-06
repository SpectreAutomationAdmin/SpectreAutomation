// Payroll-3C-1 (2026-09-07) — Founder Preview complex-pay fixture.
//
// Extends the Coulee Ridge preview with a Payroll Component catalogue
// modeled on the structure of the source paystub the founder supplied,
// and assigns those components to Chris Fixture ONLY (not the other
// eight preview employees). All amounts are synthetic and are not
// derived from any real employee. Idempotent — safe to rerun.
//
// This fixture wires component DEFINITIONS + ASSIGNMENTS. It does
// NOT touch the calculator, review DTO, or GL adapter. Those are
// wired in later 3C-2..3C-6 slices.

import { loadEnvFiles } from "./_lib/load-env";
loadEnvFiles();

import { PrismaClient } from "@prisma/client";
import {
  upsertPayrollComponent,
  createRecurringComponentAssignment,
  listActiveEmployeeComponentAssignments,
  type UpsertComponentInput,
} from "../src/lib/payroll/components-catalogue";

const prisma = new PrismaClient();

// Component catalogue for Coulee Ridge preview. Each entry mirrors a
// concept present in the founder-supplied paystub (cell phone
// allowance, life / AD&D / dependent-life employer premiums, RRSP
// employee + employer, LTD employee deduction). Statutory-base
// classification here is DELIBERATELY CONSERVATIVE — where the source
// paystub does not conclusively establish a Canadian tax treatment,
// we flag the field with the closest safe default and note it below.
// A later slice may adjust these once treatment is verified.
const CATALOGUE: Array<UpsertComponentInput & { assignmentAmount?: string; assignmentPercentBps?: number }> = [
  {
    code: "CELL_PHONE_ALLOWANCE",
    displayName: "Cell Phone Allowance",
    description: "Flat cash cell-phone allowance paid to the employee.",
    // Payroll-3C-3D — promoted to SPECTRE_LIBRARY per founder §5.
    // Founder confirmed the $37.50 item is a FLAT CASH ALLOWANCE
    // (not a reimbursement). CRA T4130 treats a flat taxable cash
    // allowance as taxable + CPP + EI. Rise's paystub excluded it
    // from EI insurable — Spectre now follows CRA (§18 3C-3D).
    category: "ALLOWANCE", side: "EMPLOYEE",
    cashEffect: "INCREASES_NET_PAY",
    taxableEffect: "ADD", cppPensionableEffect: "ADD", eiInsurableEffect: "ADD",
    calculationMethod: "FIXED_AMOUNT",
    statutoryTreatmentSource: "SPECTRE_LIBRARY",
    statutoryRuleKey: "CA-TAXABLE-CASH-ALLOWANCE-V1",
    statutoryRuleVariant: "DEFAULT",
    displaySection: "EARNINGS", displayOrder: 20,
    notes: "Rule: CA-TAXABLE-CASH-ALLOWANCE-V1. Founder-clarified flat taxable cash allowance (not reimbursement).",
    assignmentAmount: "37.50",
  },
  {
    code: "LIFE_INSURANCE_ER_PREMIUM",
    displayName: "Employer Life Insurance Premium",
    description: "Employer-paid group life insurance premium — taxable benefit.",
    // Payroll-3C-3C — TAXABLE_BENEFIT category preserved; side=EMPLOYER
    // routes it into the Employer Benefits & Contributions display
    // section (§25). Statutory treatment now comes from SPECTRE_LIBRARY.
    category: "TAXABLE_BENEFIT", side: "EMPLOYER",
    cashEffect: "NO_NET_PAY_EFFECT",
    taxableEffect: "ADD", cppPensionableEffect: "ADD", eiInsurableEffect: "NONE",
    calculationMethod: "FIXED_AMOUNT",
    statutoryTreatmentSource: "SPECTRE_LIBRARY",
    statutoryRuleKey: "CA-ER-GROUP-LIFE-INSURANCE-PREMIUM-V1",
    statutoryRuleVariant: "DEFAULT",
    displaySection: "BENEFITS", displayOrder: 10,
    notes: "Rule: CA-ER-GROUP-LIFE-INSURANCE-PREMIUM-V1. CRA T4130 — Group term life insurance policies.",
    assignmentAmount: "20.93",
  },
  {
    code: "AD_D_ER_PREMIUM",
    displayName: "Employer AD&D Premium",
    description: "Employer-paid accidental death & dismemberment premium.",
    // Payroll-3C-3C — promoted to SPECTRE_LIBRARY per §5. AD&D is a
    // non-cash taxable benefit: taxable + CPP-pensionable, NOT EI
    // insurable. This changes Sam's Taxable + Pensionable bases +$2.25.
    category: "EMPLOYER_CONTRIBUTION", side: "EMPLOYER",
    cashEffect: "NO_NET_PAY_EFFECT",
    taxableEffect: "ADD", cppPensionableEffect: "ADD", eiInsurableEffect: "NONE",
    calculationMethod: "FIXED_AMOUNT",
    statutoryTreatmentSource: "SPECTRE_LIBRARY",
    statutoryRuleKey: "CA-ER-AD-AND-D-PREMIUM-V1",
    statutoryRuleVariant: "DEFAULT",
    displaySection: "BENEFITS", displayOrder: 20,
    notes: "Rule: CA-ER-AD-AND-D-PREMIUM-V1. CRA T4130 — Employer-paid accident insurance premiums.",
    assignmentAmount: "2.25",
  },
  {
    code: "DEPENDENT_LIFE_ER_PREMIUM",
    displayName: "Employer Dependent Life Premium",
    description: "Employer-paid dependent-life insurance premium.",
    // Payroll-3C-3D — promoted to SPECTRE_LIBRARY per §7. CRA T4130
    // treats employer-paid dependent-life the same as employer-paid
    // group life: taxable + CPP-pensionable, non-EI-insurable.
    category: "EMPLOYER_CONTRIBUTION", side: "EMPLOYER",
    cashEffect: "NO_NET_PAY_EFFECT",
    taxableEffect: "ADD", cppPensionableEffect: "ADD", eiInsurableEffect: "NONE",
    calculationMethod: "FIXED_AMOUNT",
    statutoryTreatmentSource: "SPECTRE_LIBRARY",
    statutoryRuleKey: "CA-ER-GROUP-DEPENDENT-LIFE-PREMIUM-V1",
    statutoryRuleVariant: "DEFAULT",
    displaySection: "BENEFITS", displayOrder: 30,
    notes: "Rule: CA-ER-GROUP-DEPENDENT-LIFE-PREMIUM-V1. CRA T4130 — employer-paid dependent-life is a taxable non-cash benefit.",
    assignmentAmount: "0.83",
  },
  {
    code: "RRSP_ER",
    displayName: "Employer RRSP Contribution",
    description: "Employer-side RRSP contribution, percentage of eligible earnings.",
    // Payroll-3C-3C — promoted to SPECTRE_LIBRARY per §8-9. Sam's
    // synthetic fixture uses the RESTRICTED variant so historical
    // parity with the Rise-reference paystub is preserved (taxable +
    // CPP-pensionable but NOT EI-insurable). This is a fixture
    // condition, not a founder-confirmed Silver Springs plan fact —
    // see script header notes.
    category: "EMPLOYER_CONTRIBUTION", side: "EMPLOYER",
    cashEffect: "NO_NET_PAY_EFFECT",
    taxableEffect: "ADD", cppPensionableEffect: "ADD", eiInsurableEffect: "NONE",
    calculationMethod: "PERCENT_OF_ELIGIBLE_EARNINGS",
    eligibleEarningsBase: "REGULAR_EARNINGS_ONLY",
    statutoryTreatmentSource: "SPECTRE_LIBRARY",
    statutoryRuleKey: "CA-ER-GROUP-RRSP-CONTRIBUTION-RESTRICTED-V1",
    statutoryRuleVariant: "RRSP_RESTRICTED_UNTIL_RETIREMENT_OR_TERMINATION",
    displaySection: "BENEFITS", displayOrder: 40,
    notes: "Rule: CA-ER-GROUP-RRSP-CONTRIBUTION-RESTRICTED-V1. Synthetic RESTRICTED variant; Silver Springs plan withdrawal terms remain founder-confirmed.",
    assignmentPercentBps: 500, // 5%
  },
  {
    code: "RRSP_EE",
    displayName: "Employee RRSP Contribution",
    description: "Employee-side RRSP contribution, percentage of eligible earnings.",
    category: "EMPLOYEE_DEDUCTION", side: "EMPLOYEE",
    cashEffect: "DECREASES_NET_PAY",
    // Payroll-3C-3D — CPP / EI / TAXABLE remain NONE (RRSP EE is
    // NOT a reduction to statutory remuneration bases). But the
    // resolved amount now feeds T4127 F on both federal + Alberta
    // tax calcs via `taxFormulaDeductionType`.
    taxableEffect: "NONE", cppPensionableEffect: "NONE", eiInsurableEffect: "NONE",
    calculationMethod: "PERCENT_OF_ELIGIBLE_EARNINGS",
    eligibleEarningsBase: "REGULAR_EARNINGS_ONLY",
    statutoryTreatmentSource: "CUSTOM_TEST",
    taxFormulaDeductionType: "RRSP_DEDUCTED_AT_SOURCE",
    displaySection: "DEDUCTIONS", displayOrder: 10,
    notes: "Payroll-3C-3D — 5% of REGULAR salary earnings. cashEffect=DECREASES_NET_PAY; statutory bases NONE; taxFormulaDeductionType=RRSP_DEDUCTED_AT_SOURCE feeds T4127 F on federal + Alberta tax.",
    assignmentPercentBps: 500, // 5%
  },
  {
    code: "LTD_EE",
    displayName: "Employee LTD Premium",
    description: "Employee-paid long-term disability premium.",
    category: "EMPLOYEE_DEDUCTION", side: "EMPLOYEE",
    cashEffect: "DECREASES_NET_PAY",
    taxableEffect: "NONE", cppPensionableEffect: "NONE", eiInsurableEffect: "NONE",
    calculationMethod: "FIXED_AMOUNT",
    statutoryTreatmentSource: "CUSTOM",
    displaySection: "DEDUCTIONS", displayOrder: 20,
    notes: "Employee LTD is commonly post-tax so benefit is non-taxable if claimed. Verify against plan wording.",
    assignmentAmount: "28.11",
  },
];

// Payroll-3C-4 (2026-09-09) — one-time adjustment fixture components.
//
// These are Club-scoped catalogue definitions ONLY. They are NOT
// assigned to any employee. Raelene (Payroll Admin) adds them as
// one-time adjustments on a PREPARED batch through the review UI.
//
// Statutory treatment lives in the catalogue definition (§5 of the
// brief). Payroll Admin never invents statutory effects on the
// payroll screen — she picks a Component and the calculator applies
// its treatment.
const ONE_TIME_CATALOGUE: UpsertComponentInput[] = [
  {
    code: "ONE_TIME_BONUS_TEST",
    displayName: "One-time Bonus (Test)",
    description: "Ad-hoc performance / discretionary cash bonus paid on a specific pay run.",
    category: "ADDITIONAL_EARNING", side: "EMPLOYEE",
    cashEffect: "INCREASES_NET_PAY",
    // Cash bonuses are typically fully taxable AND CPP-pensionable AND EI-insurable.
    taxableEffect: "ADD", cppPensionableEffect: "ADD", eiInsurableEffect: "ADD",
    calculationMethod: "FIXED_AMOUNT",
    statutoryTreatmentSource: "CUSTOM_TEST",
    displaySection: "EARNINGS", displayOrder: 90,
    notes: "SYNTHETIC CUSTOM_TEST — used by 3C-4 one-time bonus acceptance test.",
  },
  {
    code: "EXPENSE_REIMBURSEMENT_TEST",
    displayName: "Expense Reimbursement (Test)",
    description: "Employee reimbursement for out-of-pocket business expenses.",
    category: "REIMBURSEMENT", side: "EMPLOYEE",
    cashEffect: "INCREASES_NET_PAY",
    // A true expense reimbursement is neither taxable nor CPP / EI insurable.
    taxableEffect: "NONE", cppPensionableEffect: "NONE", eiInsurableEffect: "NONE",
    calculationMethod: "FIXED_AMOUNT",
    statutoryTreatmentSource: "CUSTOM_TEST",
    displaySection: "EARNINGS", displayOrder: 95,
    notes: "SYNTHETIC CUSTOM_TEST — used by 3C-4 reimbursement acceptance test. Must not touch statutory bases.",
  },
  {
    code: "ONE_TIME_DEDUCTION_TEST",
    displayName: "One-time Deduction (Test)",
    description: "Ad-hoc post-tax employee deduction (e.g. equipment purchase, loan repayment).",
    category: "EMPLOYEE_DEDUCTION", side: "EMPLOYEE",
    cashEffect: "DECREASES_NET_PAY",
    // Post-tax deduction — does not reduce statutory bases.
    taxableEffect: "NONE", cppPensionableEffect: "NONE", eiInsurableEffect: "NONE",
    calculationMethod: "FIXED_AMOUNT",
    statutoryTreatmentSource: "CUSTOM_TEST",
    displaySection: "DEDUCTIONS", displayOrder: 90,
    notes: "SYNTHETIC CUSTOM_TEST — used by 3C-4 deduction acceptance test.",
  },
  {
    code: "ONE_TIME_TAXABLE_BENEFIT_TEST",
    displayName: "One-time Taxable Benefit (Test)",
    description: "Non-cash taxable benefit (e.g. gift card, ticket). Adds to taxable income but not to cash.",
    category: "TAXABLE_BENEFIT", side: "EMPLOYER",
    cashEffect: "NO_NET_PAY_EFFECT",
    // Non-cash taxable benefit: taxable + CPP-pensionable; EI-insurable
    // treatment is off in this synthetic entry pending SPECTRE_LIBRARY.
    taxableEffect: "ADD", cppPensionableEffect: "ADD", eiInsurableEffect: "NONE",
    calculationMethod: "FIXED_AMOUNT",
    statutoryTreatmentSource: "CUSTOM_TEST",
    displaySection: "BENEFITS", displayOrder: 90,
    notes: "SYNTHETIC CUSTOM_TEST — used by 3C-4 non-cash benefit acceptance test. Must NOT add to employee cash.",
  },
];

async function superAdminPrincipal() {
  const su = await prisma.user.findFirstOrThrow({ where: { role: "SUPER_ADMIN" } });
  const roles = await prisma.userClubRole.findMany({ where: { userId: su.id } });
  return {
    id: su.id, email: su.email, name: su.name,
    clubId: su.clubId, role: su.role,
    memberships: roles.map((r) => ({ clubId: r.clubId, roleKey: r.roleKey })),
  } as never;
}

async function main() {
  const club = await prisma.club.findFirstOrThrow({ where: { slug: "coulee-ridge" } });
  const principal = await superAdminPrincipal();

  console.log("Payroll-3C-1 complex-pay fixture — Coulee Ridge\n");

  // Payroll-3C-6 (2026-09-05) — resolve the club's Chart-of-Accounts
  // by number so we can attach every component to a real expense +
  // liability GL account before posting. Accounts are seeded by the
  // basic Founder Preview fixture (payroll-founder-preview-fixture.ts).
  async function acct(number: string): Promise<string> {
    const a = await prisma.account.findUnique({
      where: { clubId_accountNumber: { clubId: club.id, accountNumber: number } },
      select: { id: true },
    });
    if (!a) throw new Error(
      `Payroll-3C-6 fixture requires Account ${number} for Coulee Ridge. ` +
      `Run \`npm run fixture:payroll-founder-preview\` first.`,
    );
    return a.id;
  }
  const ACCT = {
    salaryExpense:        await acct("5100"),
    cellPhoneExpense:     await acct("5131"),
    benefitsExpense:      await acct("5130"),
    rrspExpense:          await acct("5132"),
    bonusExpense:         await acct("5133"),
    reimbursementExpense: await acct("5134"),
    benefitsPayable:      await acct("2160"),
    rrspPayable:          await acct("2150"),
    empDeductionsPayable: await acct("2170"),
  };

  // Per-component GL mapping. Keyed by code; §27 target composition.
  //   Expense (employer cost)      → debited
  //   Liability (owed to third-party) → credited
  const componentGlMap: Record<string, { expenseAccountId?: string; liabilityAccountId?: string }> = {
    CELL_PHONE_ALLOWANCE:        { expenseAccountId: ACCT.cellPhoneExpense },
    LIFE_INSURANCE_ER_PREMIUM:   { expenseAccountId: ACCT.benefitsExpense, liabilityAccountId: ACCT.benefitsPayable },
    AD_D_ER_PREMIUM:             { expenseAccountId: ACCT.benefitsExpense, liabilityAccountId: ACCT.benefitsPayable },
    DEPENDENT_LIFE_ER_PREMIUM:   { expenseAccountId: ACCT.benefitsExpense, liabilityAccountId: ACCT.benefitsPayable },
    RRSP_ER:                     { expenseAccountId: ACCT.rrspExpense,     liabilityAccountId: ACCT.rrspPayable },
    RRSP_EE:                     { liabilityAccountId: ACCT.rrspPayable },
    LTD_EE:                      { liabilityAccountId: ACCT.benefitsPayable },
    // One-time catalogue (assigned per-adjustment; still needs mapping).
    ONE_TIME_BONUS_TEST:         { expenseAccountId: ACCT.bonusExpense },
    EXPENSE_REIMBURSEMENT_TEST:  { expenseAccountId: ACCT.reimbursementExpense },
    ONE_TIME_DEDUCTION_TEST:     { liabilityAccountId: ACCT.empDeductionsPayable },
    ONE_TIME_TAXABLE_BENEFIT_TEST: { expenseAccountId: ACCT.benefitsExpense, liabilityAccountId: ACCT.benefitsPayable },
  };

  // Ensure every catalogue entry exists (idempotent) with GL mapping.
  const componentIdByCode = new Map<string, string>();
  for (const c of CATALOGUE) {
    const { assignmentAmount, assignmentPercentBps, ...def } = c;
    const gl = componentGlMap[c.code] ?? {};
    const r = await upsertPayrollComponent(principal, club.id, { ...def, ...gl });
    componentIdByCode.set(c.code, r.id);
    console.log(`  ${r.createdOrUpdated}: ${c.code}`);
    void assignmentAmount; void assignmentPercentBps;
  }

  // Payroll-3C-4 — seed the one-time-adjustment catalogue entries.
  // Definitions only; NOT assigned to any employee. Same GL mapping.
  for (const c of ONE_TIME_CATALOGUE) {
    const gl = componentGlMap[c.code] ?? {};
    const r = await upsertPayrollComponent(principal, club.id, { ...c, ...gl });
    console.log(`  ${r.createdOrUpdated}: ${c.code}  (one-time catalogue — unassigned)`);
  }

  // Payroll-3C-2 (2026-09-07) — attach components to a SEPARATE
  // synthetic Complex-Pay employee that is NOT a member of the
  // basic 9-salary preview pay group. Rationale (§10 of the 3C-2
  // brief): the basic salary Founder Preview must remain a stable
  // regression baseline ($36,125 batch gross, Alex $6,250). Adding
  // component snapshots to any of those 9 employees would contaminate
  // that baseline. The complex-pay employee lives in its own dedicated
  // pay group so its batches are entirely independent.
  const COMPLEX_EMAIL = "complex.pay@preview.spectre.test";
  const COMPLEX_PAY_GROUP_CODE = "SAL-SM-COMPLEX";

  // Ensure the complex-pay pay group (semi-monthly, seeded across 2026).
  let complexPg = await prisma.payrollPayGroup.findFirst({
    where: { clubId: club.id, code: COMPLEX_PAY_GROUP_CODE },
  });
  if (!complexPg) {
    complexPg = await prisma.payrollPayGroup.create({
      data: {
        clubId: club.id, code: COMPLEX_PAY_GROUP_CODE,
        name: "Salary — Semi-monthly (Complex Pay Preview)",
        // Payroll-3C-3E — 5-day payDateOffsetDays gives an
        // operationally realistic processing window: period close →
        // time approval → Payroll Admin prep → Controller approval →
        // employer funding → EFT settlement → employee pay date.
        // (1 day was too short and produced Aug 31 pay for an Aug 31
        // period close, which was operationally impossible.)
        payFrequency: "SEMI_MONTHLY", active: true,
        payDateOffsetDays: 5, calendarAnchorDate: new Date("2026-09-01T00:00:00.000Z"),
        notes: "Founder preview — complex-pay Employee only. Not part of the 9-salary regression baseline.",
      },
    });
  }
  // Payroll-3C-3E.1 — Spectre semi-monthly payday = 15th / EOM with
  // Sat/Sun → preceding Friday adjustment. Payroll cutoff = payday
  // − 5 calendar days (backward from payday, per founder rule).
  // Pay period (employee-facing) is always 1st–15th / 16th–EOM per
  // §7 conceptual separation of period vs cutoff vs payday.
  {
    const { generateSemiMonthlySchedule } = await import("../src/lib/payroll/semi-monthly-payday");
    const schedule = generateSemiMonthlySchedule(2026, /* leadCalendarDays */ 5);
    for (const row of schedule) {
      const p = { seq: row.seq, start: row.periodStart, end: row.periodEnd, pay: row.payDate };
      {
        const already = await prisma.payrollPayPeriod.findFirst({
          where: { clubId: club.id, payGroupId: complexPg.id, taxYear: 2026, sequenceInYear: p.seq },
        });
        if (already) {
          // Payroll-3C-3E — realign existing period dates to the
          // corrected calendar (idempotent). Only touches OPEN /
          // FUTURE periods; a CLOSED period is left alone to
          // preserve historical immutability.
          if (already.status === "OPEN" || already.status === "FUTURE") {
            if (
              already.periodStart.getTime() !== p.start.getTime() ||
              already.periodEnd.getTime()   !== p.end.getTime() ||
              already.payDate.getTime()     !== p.pay.getTime()
            ) {
              await prisma.payrollPayPeriod.update({
                where: { id: already.id },
                data: { periodStart: p.start, periodEnd: p.end, payDate: p.pay },
              });
            }
          }
          continue;
        }
        await prisma.payrollPayPeriod.create({
          data: {
            clubId: club.id, payGroupId: complexPg.id, taxYear: 2026,
            sequenceInYear: p.seq, periodStart: p.start, periodEnd: p.end, payDate: p.pay,
            status: "OPEN",
          },
        });
      }
    }
  }

  // Ensure the synthetic complex-pay employee.
  // Payroll-3C-3D.1 (2026-09-09) — Sam Complex hire date aligned to
  // the source employee's employment timeline so YTD can be tested
  // through Spectre-posted history instead of manufactured opening
  // balances. No real personal identifiers are copied — only the
  // start-date shape.
  const hireDate = new Date("2026-02-02T00:00:00.000Z");
  // Payroll-3C-5B (2026-09-04) — Sam Complex is now a signable
  // Employee-Portal user so §21/§22 Playwright can drive the
  // employee-portal pay history + statement detail flows. Password
  // matches the other preview accounts (TA1C-Preview-99); no real
  // PII is used. Prior state stored a literal "x" which failed
  // bcrypt.compare and left Sam unable to sign in.
  const bcrypt = (await import("bcryptjs")).default;
  const complexHash = await bcrypt.hash("TA1C-Preview-99", 8);
  let complexUser = await prisma.user.findFirst({ where: { email: COMPLEX_EMAIL } });
  if (!complexUser) {
    complexUser = await prisma.user.create({
      data: {
        email: COMPLEX_EMAIL, name: "Sam Complex",
        role: "STAFF", passwordHash: complexHash, status: "ACTIVE",
        clubId: club.id,
      },
    });
  } else if (complexUser.passwordHash === "x") {
    await prisma.user.update({
      where: { id: complexUser.id },
      data: { passwordHash: complexHash },
    });
  }
  // Payroll-3C-5B also ensures an EmployeePortalCredential row so
  // Sam can sign in via /employee/login (the portal login uses
  // EmployeePortalCredential.passwordHash, NOT User.passwordHash).
  // The row is upserted post-Employee-create below.
  let complexEmp = await prisma.employee.findFirst({
    where: { clubId: club.id, email: COMPLEX_EMAIL },
  });
  // Payroll-3C-3 (2026-09-08) — founder-requested acceptance:
  // Sam Complex annual salary $110,000 → semi-monthly regular
  // $4,583.33 (matches the structural target from the supplied
  // source paystub). RRSP EE/ER at 5% of REGULAR_EARNINGS_ONLY
  // then resolves to $229.17 each.
  const SAM_ANNUAL_SALARY = "110000";
  if (!complexEmp) {
    complexEmp = await prisma.employee.create({
      data: {
        clubId: club.id, firstName: "Sam", lastName: "Complex",
        email: COMPLEX_EMAIL, hireDate, dateOfBirth: new Date("1980-06-01T00:00:00.000Z"),
        status: "ACTIVE", employeeNumber: "E-COMPLEX-1",
        employeeLifecycle: "ACTIVE", compensationType: "SALARY", homeProvince: "AB",
        userId: complexUser.id, payRate: SAM_ANNUAL_SALARY,
      },
    });
    const assn = await prisma.employeeEmploymentAssignment.create({
      data: {
        clubId: club.id, employeeId: complexEmp.id, role: "PRIMARY",
        employmentType: "FULL_TIME", effectiveFrom: hireDate,
      },
    });
    await prisma.employeeCompensation.create({
      data: {
        clubId: club.id, employeeId: complexEmp.id, assignmentId: assn.id,
        effectiveFrom: hireDate, cadence: "SALARY", rate: SAM_ANNUAL_SALARY, currency: "CAD",
      },
    });
    await prisma.payrollPayGroupMember.create({
      data: { clubId: club.id, payGroupId: complexPg.id, employeeId: complexEmp.id, effectiveFrom: hireDate },
    });
  } else {
    // Idempotent update — keep the existing employee/assignment/comp
    // rows but bring the annual salary in line with the acceptance
    // fixture. Historical batches remain immutable via their
    // frozen sourceFactsJson (see salary-snapshot-immutability tests).
    if (complexEmp.payRate?.toString() !== SAM_ANNUAL_SALARY) {
      await prisma.employee.update({
        where: { id: complexEmp.id },
        data: { payRate: SAM_ANNUAL_SALARY },
      });
    }
    const activeComp = await prisma.employeeCompensation.findFirst({
      where: { clubId: club.id, employeeId: complexEmp.id, cadence: "SALARY", effectiveTo: null },
    });
    if (activeComp && activeComp.rate.toString() !== SAM_ANNUAL_SALARY) {
      await prisma.employeeCompensation.update({
        where: { id: activeComp.id }, data: { rate: SAM_ANNUAL_SALARY },
      });
    }
  }

  // Payroll-3C-5B — ensure Sam has an EmployeePortalCredential so he
  // can sign in at /employee/login (the portal login reads THIS row,
  // not User.passwordHash). Uses the shared preview password
  // TA1C-Preview-99 for Playwright + founder-test workflows.
  //
  // ALSO ensure `personalEmail` is populated — the portal login
  // lookup keys on Employee.personalEmail (not Employee.email),
  // which is the fixture's User-mailbox account and is only
  // meaningful for onboarding invitations.
  if (complexEmp.personalEmail !== COMPLEX_EMAIL) {
    await prisma.employee.update({
      where: { id: complexEmp.id },
      data: { personalEmail: COMPLEX_EMAIL },
    });
  }
  const existingCred = await prisma.employeePortalCredential.findUnique({
    where: { employeeId: complexEmp.id },
  });
  if (!existingCred) {
    await prisma.employeePortalCredential.create({
      data: {
        clubId: club.id, employeeId: complexEmp.id,
        passwordHash: complexHash, passwordUpdatedAt: new Date(),
      },
    });
  } else {
    await prisma.employeePortalCredential.update({
      where: { employeeId: complexEmp.id },
      data: { passwordHash: complexHash, failedAttemptCount: 0, lockedUntil: null },
    });
  }

  // Payroll-3C-3D (2026-09-09) — Sam Complex TD1 fixture.
  //
  // Founder-supplied values from the completed 2026 TD1 / TD1AB.
  // Federal $16,542 is the exact value entered on the signed form,
  // differing by $90 from the printed 2026 federal Basic Personal
  // Amount ($16,452). Preserved verbatim for source reconciliation;
  // flagged as SOURCE_TD1_INPUT_ANOMALY in the reconciliation report.
  // No real personal identifiers are stored — only these two
  // non-sensitive numeric claim amounts on the synthetic Sam profile.
  const { writeEncryptedTd1Claims } = await import("../src/lib/hr/td1-secure-write");
  await prisma.employeeTaxProfile.deleteMany({
    where: { clubId: club.id, employeeId: complexEmp.id },
  });
  await writeEncryptedTd1Claims({
    clubId: club.id, employeeId: complexEmp.id,
    effectiveFrom: hireDate, province: "AB", td1FormVersion: "2026-01",
    federalClaim:    "16542.00",
    provincialClaim: "22769.00",
    actorUserId: null,
    notes:
      "Payroll-3C-3D Sam Complex source-reconciliation TD1. Federal $16,542 preserved verbatim from the " +
      "founder-supplied completed form; $90 above the printed 2026 BPA (SOURCE_TD1_INPUT_ANOMALY).",
  });

  const existing = await listActiveEmployeeComponentAssignments(principal, club.id, complexEmp.id);
  const alreadyAssigned = new Set(existing.map((a) => a.component.code));

  let created = 0, skipped = 0;
  for (const c of CATALOGUE) {
    if (alreadyAssigned.has(c.code)) { skipped += 1; continue; }
    await createRecurringComponentAssignment(principal, club.id, {
      employeeId: complexEmp.id,
      componentId: componentIdByCode.get(c.code)!,
      amount: c.assignmentAmount ?? null,
      percentBps: c.assignmentPercentBps ?? null,
      effectiveFrom: hireDate,
    });
    created += 1;
  }
  console.log(`\nSam Complex recurring components: ${created} created, ${skipped} reused.`);
  console.log(`Pay group: ${COMPLEX_PAY_GROUP_CODE} (isolated from the basic 9-salary preview).`);
  console.log("\nComplex-pay fixture ready. In 3C-2, FIXED_AMOUNT components flow into the");
  console.log("calculator's four independent bases; PERCENT components surface as WARNINGs.");
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
