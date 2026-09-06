// Payroll Founder Preview fixture — Coulee Ridge, 2026-09-05.
//
// Configures the nine TA-1C synthetic management people for a
// complete salaried-payroll walkthrough (prepare → calculate →
// review → approve → post → GL → paystubs).
//
// Founder direction (§2): Coulee Ridge is Spectre's canonical dev
// tenant. This script does NOT create a second Club. It reads the
// existing Coulee Ridge tenant established by
// scripts/ta1c-founder-preview-fixture.ts and augments it with the
// payroll configuration needed for the end-to-end walkthrough.
//
// Idempotent — safe to rerun. Only synthetic data (@preview.spectre.test).
//
// Founder direction (§15, §16, §50, §51): the Payroll Admin +
// Controller bridges use PayrollClubConfig.payrollAdminUserId +
// controllerUserId (existing accepted TA-1B compatibility). No
// title-based routing. Marked in comments for removal during TA
// responsibility integration.

// Load .env.local / .env FIRST so the KMS provider selected here
// matches the dev server. A mismatch silently produces TD1
// ciphertext the Payroll runtime cannot decrypt.
import { loadEnvFiles } from "./_lib/load-env";
loadEnvFiles();

import { PrismaClient, Prisma } from "@prisma/client";
import { writeEncryptedTd1Claims } from "../src/lib/hr/td1-secure-write";
import { ensurePayrollAdminProcessingCardForSalaryPeriod } from "../src/lib/payroll/orchestration";

const prisma = new PrismaClient();

const COULEE_SLUG = "coulee-ridge";

// Synthetic annual salaries (§7). Round numbers chosen for
// statutory-formula clarity. NOT product defaults. Coulee Ridge
// real compensation is unrelated.
const SALARIES: Record<string, number> = {
  "General Manager":              150_000,
  "Controller":                   120_000,
  "Office Manager":                75_000,
  "Head Professional":            110_000,
  "Grounds Superintendent":       115_000,
  "Head Chef":                     90_000,
  "Front of House Manager":        70_000,
  "Banquets & Events Manager":     72_000,
  "Communications Coordinator":    65_000,
};

// CRA 2026 Alberta federal + provincial basic-personal amounts —
// safe synthetic defaults that satisfy the accepted calculator's
// TD1 readiness check. Real employees complete TD1 through HR
// onboarding.
const TD1_FEDERAL_CLAIM   = 16_452;
const TD1_PROVINCIAL_CLAIM = 22_769;

// Semi-monthly pay period for the current founder preview walkthrough.
// Deterministic date so re-runs land the same period.
const PAY_GROUP_CODE = "SAL-SM";
const PAY_GROUP_NAME = "Salary — Semi-monthly";
const PAY_PERIOD_START      = new Date("2026-09-01T00:00:00.000Z");
const PAY_PERIOD_END_INCL   = new Date("2026-09-15T00:00:00.000Z"); // display
const PAY_PERIOD_END        = new Date("2026-09-16T00:00:00.000Z"); // EXCLUSIVE — schema half-open
const PAY_DATE              = new Date("2026-09-16T00:00:00.000Z");

// ---------------------------------------------------------------------
// Coulee Ridge lookup
// ---------------------------------------------------------------------
async function findCouleeRidge() {
  const c = await prisma.club.findFirst({ where: { slug: COULEE_SLUG } });
  if (!c) throw new Error("Coulee Ridge not found. Run scripts/ta1c-founder-preview-fixture.ts first.");
  return c;
}

// ---------------------------------------------------------------------
// Coulee Ridge preview people — read the TA-1C-seeded profiles +
// linked Employees, keyed by position name.
// ---------------------------------------------------------------------
async function loadPreviewPeople(clubId: string) {
  const profiles = await prisma.userClubProfile.findMany({
    where: {
      clubId,
      user: { email: { endsWith: "@preview.spectre.test" } },
      NOT: { employeeId: null },
    },
    include: {
      user: { select: { id: true, email: true, name: true } },
      employee: true,
      position: true,
    },
  });
  if (profiles.length < 9) {
    throw new Error(
      `Expected 9 preview profiles inside Coulee Ridge — found ${profiles.length}. ` +
      `Run scripts/ta1c-founder-preview-fixture.ts first.`,
    );
  }
  return profiles;
}

// ---------------------------------------------------------------------
// GL accounts — ensure the eight accounts that PayrollGlAccountingProfile
// points at exist. Idempotent per (clubId, accountNumber).
// ---------------------------------------------------------------------
async function ensurePayrollGlAccounts(clubId: string) {
  type Spec = { number: string; name: string; type: "EXPENSE" | "LIABILITY"; normalBalance: "DEBIT" | "CREDIT" };
  const specs: Spec[] = [
    { number: "5100", name: "Salary & Wage Expense",             type: "EXPENSE",   normalBalance: "DEBIT"  },
    { number: "5110", name: "Employer CPP Expense",              type: "EXPENSE",   normalBalance: "DEBIT"  },
    { number: "5120", name: "Employer EI Expense",               type: "EXPENSE",   normalBalance: "DEBIT"  },
    { number: "2100", name: "Net Pay Payable",                   type: "LIABILITY", normalBalance: "CREDIT" },
    { number: "2110", name: "CPP Payable",                       type: "LIABILITY", normalBalance: "CREDIT" },
    { number: "2120", name: "EI Payable",                        type: "LIABILITY", normalBalance: "CREDIT" },
    { number: "2130", name: "Federal Income Tax Payable",        type: "LIABILITY", normalBalance: "CREDIT" },
    { number: "2140", name: "Alberta Income Tax Payable",        type: "LIABILITY", normalBalance: "CREDIT" },
    // Payroll-3C-6 (2026-09-05) — synthetic accounts for component-aware
    // GL posting. Assigned by the Coulee Ridge fixture only; production
    // tenants configure their own Chart of Accounts.
    { number: "5130", name: "Employer Benefits Expense",         type: "EXPENSE",   normalBalance: "DEBIT"  },
    { number: "5131", name: "Cell Phone Allowance Expense",      type: "EXPENSE",   normalBalance: "DEBIT"  },
    { number: "5132", name: "Employer RRSP Expense",             type: "EXPENSE",   normalBalance: "DEBIT"  },
    { number: "5133", name: "One-Time Bonus Expense",            type: "EXPENSE",   normalBalance: "DEBIT"  },
    { number: "5134", name: "Reimbursement Clearing Expense",    type: "EXPENSE",   normalBalance: "DEBIT"  },
    { number: "2150", name: "RRSP Contributions Payable",        type: "LIABILITY", normalBalance: "CREDIT" },
    { number: "2160", name: "Benefits Payable",                  type: "LIABILITY", normalBalance: "CREDIT" },
    { number: "2170", name: "Employee Deductions Payable",       type: "LIABILITY", normalBalance: "CREDIT" },
  ];
  const map = new Map<string, string>();
  for (const s of specs) {
    const row = await prisma.account.upsert({
      where: { clubId_accountNumber: { clubId, accountNumber: s.number } },
      update: { name: s.name },
      create: {
        clubId, accountNumber: s.number, name: s.name,
        type: s.type, normalBalance: s.normalBalance,
        allowManualPosting: false, // control-adjacent — posts via adapter only
        isActive: true,
      },
    });
    map.set(s.number, row.id);
  }
  return map;
}

async function ensurePayrollGlProfile(clubId: string, accounts: Map<string, string>) {
  return prisma.payrollGlAccountingProfile.upsert({
    where: { clubId },
    update: {
      salaryExpenseAccountId:        accounts.get("5100")!,
      employerCppExpenseAccountId:   accounts.get("5110")!,
      employerEiExpenseAccountId:    accounts.get("5120")!,
      netPayPayableAccountId:        accounts.get("2100")!,
      cppPayableAccountId:           accounts.get("2110")!,
      eiPayableAccountId:            accounts.get("2120")!,
      federalTaxPayableAccountId:    accounts.get("2130")!,
      provincialTaxPayableAccountId: accounts.get("2140")!,
    },
    create: {
      clubId,
      salaryExpenseAccountId:        accounts.get("5100")!,
      employerCppExpenseAccountId:   accounts.get("5110")!,
      employerEiExpenseAccountId:    accounts.get("5120")!,
      netPayPayableAccountId:        accounts.get("2100")!,
      cppPayableAccountId:           accounts.get("2110")!,
      eiPayableAccountId:            accounts.get("2120")!,
      federalTaxPayableAccountId:    accounts.get("2130")!,
      provincialTaxPayableAccountId: accounts.get("2140")!,
    },
  });
}

// ---------------------------------------------------------------------
// Fiscal year + period — required by the GL adapter's
// resolvePostingPeriod. Idempotent: reuses any existing OPEN /
// SOFT_LOCKED period that covers the pay date, otherwise creates
// the minimum synthetic month (and FiscalYear if none exists) so
// posting succeeds without manual accounting setup.
//
// Never overwrites or deletes unrelated fiscal periods.
// ---------------------------------------------------------------------
async function ensureFiscalPeriodForPayDate(clubId: string, payDate: Date): Promise<{
  fiscalYearId: string; fiscalPeriodId: string; created: { fiscalYear: boolean; fiscalPeriod: boolean };
}> {
  // 1. Look for any existing period covering payDate that is not
  //    hard-locked. HARD_LOCKED / CLOSED periods block adapter writes.
  const existing = await prisma.fiscalPeriod.findFirst({
    where: {
      clubId,
      startDate: { lte: payDate },
      endDate:   { gte: payDate },
      status:    { in: ["OPEN", "SOFT_LOCKED"] },
    },
    include: { fiscalYear: { select: { id: true } } },
  });
  if (existing) {
    return {
      fiscalYearId:  existing.fiscalYearId,
      fiscalPeriodId: existing.id,
      created: { fiscalYear: false, fiscalPeriod: false },
    };
  }

  // 2. No usable period. Find or create the enclosing fiscal year.
  const year = payDate.getUTCFullYear();
  const yearStart = new Date(Date.UTC(year, 0, 1));
  const yearEnd   = new Date(Date.UTC(year, 11, 31, 23, 59, 59, 999));
  let fy = await prisma.fiscalYear.findFirst({
    where: {
      clubId,
      startDate: { lte: payDate },
      endDate:   { gte: payDate },
    },
  });
  let createdFy = false;
  if (!fy) {
    fy = await prisma.fiscalYear.create({
      data: {
        clubId, label: `FY${year}`,
        startDate: yearStart, endDate: yearEnd, status: "OPEN",
      },
    });
    createdFy = true;
  }

  // 3. Create the enclosing month as a fiscal period inside that year.
  const month      = payDate.getUTCMonth();      // 0-based
  const monthStart = new Date(Date.UTC(year, month, 1));
  const monthEnd   = new Date(Date.UTC(year, month + 1, 1) - 1); // last moment of the month
  const label      = `FY${year}-M${String(month + 1).padStart(2, "0")}`;

  const period = await prisma.fiscalPeriod.create({
    data: {
      clubId, fiscalYearId: fy.id, label,
      startDate: monthStart, endDate: monthEnd,
      sequence: month + 1, status: "OPEN",
    },
  });
  return {
    fiscalYearId: fy.id, fiscalPeriodId: period.id,
    created: { fiscalYear: createdFy, fiscalPeriod: true },
  };
}

// ---------------------------------------------------------------------
// Pay group + period
// ---------------------------------------------------------------------
async function ensurePayGroup(clubId: string) {
  const existing = await prisma.payrollPayGroup.findUnique({
    where: { clubId_code: { clubId, code: PAY_GROUP_CODE } },
  });
  if (existing) return existing;
  return prisma.payrollPayGroup.create({
    data: {
      clubId, code: PAY_GROUP_CODE, name: PAY_GROUP_NAME,
      payFrequency: "SEMI_MONTHLY",
      active: true,
      payDateOffsetDays: 1,
      notes: "Founder preview salaried payroll group.",
    },
  });
}

// Semi-monthly calendar for the whole 2026 tax year (24 periods).
// The Payroll calculator resolves `periodsPerYear` by counting the
// PayrollPayPeriod rows for (clubId, payGroupId, taxYear) — CRA
// T4127 requires the ACTUAL calendar count, not a hard-coded 24.
// Seeding just one period would make `annualSalary / periodsPerYear`
// collapse to `annualSalary / 1` — the exact defect the founder saw
// ($150k paid per semi-monthly period). Seed the whole year.
function semiMonthlyPeriodsForYear(year: number): Array<{
  sequenceInYear: number; periodStart: Date; periodEnd: Date; payDate: Date;
}> {
  const out: Array<{ sequenceInYear: number; periodStart: Date; periodEnd: Date; payDate: Date }> = [];
  let seq = 0;
  for (let m = 0; m < 12; m++) {
    // First half: 1st → 15th inclusive; pay date 15th.
    const firstStart = new Date(Date.UTC(year, m, 1));
    const firstEnd   = new Date(Date.UTC(year, m, 16));   // EXCLUSIVE half-open
    const firstPay   = new Date(Date.UTC(year, m, 16));   // pay date 16th (SM offset +1)
    seq += 1;
    out.push({ sequenceInYear: seq, periodStart: firstStart, periodEnd: firstEnd, payDate: firstPay });
    // Second half: 16th → end-of-month inclusive; pay date 1st of next month.
    const secondStart = new Date(Date.UTC(year, m, 16));
    const secondEnd   = new Date(Date.UTC(year, m + 1, 1)); // EXCLUSIVE half-open
    const secondPay   = new Date(Date.UTC(year, m + 1, 1));
    seq += 1;
    out.push({ sequenceInYear: seq, periodStart: secondStart, periodEnd: secondEnd, payDate: secondPay });
  }
  return out;
}

async function ensurePayPeriod(clubId: string, payGroupId: string) {
  // Seed the full 24-period 2026 calendar if it doesn't already
  // exist. Idempotent per (clubId, payGroupId, taxYear, sequenceInYear).
  const existingCount = await prisma.payrollPayPeriod.count({
    where: { clubId, payGroupId, taxYear: 2026 },
  });
  if (existingCount < 24) {
    const calendar = semiMonthlyPeriodsForYear(2026);
    for (const p of calendar) {
      const already = await prisma.payrollPayPeriod.findFirst({
        where: { clubId, payGroupId, taxYear: 2026, sequenceInYear: p.sequenceInYear },
      });
      if (already) continue;
      await prisma.payrollPayPeriod.create({
        data: {
          clubId, payGroupId, taxYear: 2026,
          sequenceInYear: p.sequenceInYear,
          periodStart:    p.periodStart,
          periodEnd:      p.periodEnd,
          payDate:        p.payDate,
          status: "OPEN",
        },
      });
    }
  }
  // Return the founder-preview period specifically (Sept 1–15 → pay Sept 16).
  return prisma.payrollPayPeriod.findFirstOrThrow({
    where: {
      clubId, payGroupId, taxYear: 2026,
      periodStart: PAY_PERIOD_START,
    },
  });
}

async function ensurePayGroupMembership(
  clubId: string, payGroupId: string, employeeId: string, effectiveFrom: Date,
) {
  const existing = await prisma.payrollPayGroupMember.findFirst({
    where: { clubId, payGroupId, employeeId, effectiveTo: null },
  });
  if (existing) return existing;
  return prisma.payrollPayGroupMember.create({
    data: {
      clubId, payGroupId, employeeId,
      effectiveFrom, effectiveTo: null,
      notes: "Founder preview salaried assignment.",
    },
  });
}

// ---------------------------------------------------------------------
// Per-employee payroll readiness — compensation + TD1 + PayrollProfile
// + activate + DOB + start date.
// ---------------------------------------------------------------------
async function ensureEmployeeReady(args: {
  clubId: string;
  employeeId: string;
  firstName: string;
  lastName: string;
  positionName: string;
  hireDate: Date;
  dateOfBirth: Date;
}) {
  const { clubId, employeeId, firstName, lastName, positionName, hireDate, dateOfBirth } = args;
  const annualSalary = SALARIES[positionName];
  if (annualSalary === undefined) throw new Error(`No salary configured for position "${positionName}"`);

  // Employee — activate + fill DOB + hire date + province.
  await prisma.employee.update({
    where: { id: employeeId },
    data: {
      employeeLifecycle: "ACTIVE",
      status: "ACTIVE",
      activatedAt: new Date(),
      hireDate,
      dateOfBirth,
      compensationType: "SALARY",
      // Salary source of truth is EmployeeCompensation (below), but
      // populate the legacy payRate scalar so any older reader stays
      // consistent.
      payRate: new Prisma.Decimal(annualSalary),
      homeProvince: "AB",
    },
  });

  // Active employment assignment covering the pay period. The payroll
  // preparation service requires an EmployeeEmploymentAssignment to
  // classify the employee as "included" and to resolve compensation.
  let assn = await prisma.employeeEmploymentAssignment.findFirst({
    where: { clubId, employeeId, role: "PRIMARY", effectiveTo: null },
  });
  if (!assn) {
    assn = await prisma.employeeEmploymentAssignment.create({
      data: {
        clubId, employeeId, role: "PRIMARY",
        employmentType: "FULL_TIME",
        effectiveFrom: hireDate,
        notes: `Founder preview PRIMARY assignment — ${positionName}`,
      },
    });
  }

  // Effective-dated SALARY compensation row, linked to the assignment
  // (preparation resolves compensation via assignmentId).
  const existingComp = await prisma.employeeCompensation.findFirst({
    where: { clubId, employeeId, assignmentId: assn.id, cadence: "SALARY", effectiveTo: null },
  });
  if (!existingComp) {
    await prisma.employeeCompensation.create({
      data: {
        clubId, employeeId, assignmentId: assn.id,
        effectiveFrom: hireDate,
        cadence: "SALARY",
        rate: new Prisma.Decimal(annualSalary),
        currency: "CAD",
        notes: `Founder preview annual salary — ${positionName}`,
      },
    });
  }

  // PayrollProfile — jurisdiction + pay frequency.
  await prisma.payrollProfile.upsert({
    where: { employeeId },
    update: {
      jurisdiction: "CA-AB",
      payGroup: "SAL-SM",
      payFrequency: "SEMI_MONTHLY",
    },
    create: {
      clubId, employeeId,
      jurisdiction: "CA-AB",
      payGroup: "SAL-SM",
      payFrequency: "SEMI_MONTHLY",
      directDepositActive: false, // §10 — banking is payment readiness, not calc readiness
    },
  });

  // EmployeeTaxProfile — TD1 written through the canonical secure
  // primitive. writeEncryptedTd1Claims encrypts via encryptSecret,
  // then round-trips through decryptSecret BEFORE persisting; a KMS
  // provider mismatch surfaces here rather than as a downstream
  // TD1_CLAIM_RESOLUTION_FAILED BLOCKER at Payroll preparation.
  //
  // The founder-preview fixture always refreshes ciphertext so that
  // any stale envelope written by a previous run (under a different
  // KMS provider) is replaced — never left in the DB for the
  // Payroll runtime to fail on.
  await prisma.employeeTaxProfile.deleteMany({
    where: { clubId, employeeId },
  });
  await writeEncryptedTd1Claims({
    clubId,
    employeeId,
    effectiveFrom: hireDate,
    province: "AB",
    td1FormVersion: "2026-01",
    federalClaim: TD1_FEDERAL_CLAIM.toFixed(2),
    provincialClaim: TD1_PROVINCIAL_CLAIM.toFixed(2),
    actorUserId: null,
    notes: `Founder preview TD1 — safe synthetic amounts (basic personal). Not real employee TD1.`,
  });

  // Provide a firstName / lastName consistency note for the log.
  return { firstName, lastName, annualSalary };
}

// ---------------------------------------------------------------------
// PayrollClubConfig — Raelene = PayrollAdmin, Chris = Controller.
//
// ⚠️  Local Founder Preview assignment via the existing accepted TA-1B
// PayrollClubConfig bridge. Not a title-based inference — the fixture
// resolves the two users by their known synthetic emails and writes
// the ids into PayrollClubConfig. The Responsibility Resolver (TA-1F)
// will replace this bridge with resolveResponsibilityOwner reads.
// ---------------------------------------------------------------------
async function configurePayrollClubConfig(args: {
  clubId: string; payrollAdminUserId: string; controllerUserId: string; glProfileId: string;
}) {
  const { clubId, payrollAdminUserId, controllerUserId, glProfileId } = args;
  const existing = await prisma.payrollClubConfig.findUnique({ where: { clubId } });
  if (existing) {
    return prisma.payrollClubConfig.update({
      where: { clubId },
      data: {
        enabled: true,
        country: "CA",
        provinceOfEmployment: "AB",
        defaultPayFrequency: "SEMI_MONTHLY",
        payrollAdminUserId, controllerUserId,
        glAccountingProfileId: glProfileId,
      },
    });
  }
  return prisma.payrollClubConfig.create({
    data: {
      clubId, enabled: true,
      country: "CA", provinceOfEmployment: "AB",
      defaultPayFrequency: "SEMI_MONTHLY",
      defaultPaymentMethod: "DIRECT_DEPOSIT",
      payrollAdminUserId, controllerUserId,
      glAccountingProfileId: glProfileId,
    },
  });
}

// ---------------------------------------------------------------------
// Reset — safe local-only wipe of the founder preview payroll data.
// Called by npm run fixture:payroll-founder-preview:reset via a
// separate wrapper. Never runs against staging/prod.
// ---------------------------------------------------------------------
async function resetPreviewPayroll(clubId: string) {
  const preview = await prisma.userClubProfile.findMany({
    where: { clubId, user: { email: { endsWith: "@preview.spectre.test" } } },
    select: { employeeId: true },
  });
  const previewEmpIds = preview.map((p) => p.employeeId).filter((id): id is string => id !== null);
  if (previewEmpIds.length === 0) return;

  // Batches for preview employees — cascade wipes earnings/deductions/snapshots/exceptions.
  const batches = await prisma.payrollBatch.findMany({
    where: {
      clubId,
      employees: { some: { employeeId: { in: previewEmpIds } } },
    },
    select: { id: true, glJournalEntryId: true, workIntakeItemId: true },
  });
  for (const b of batches) {
    // Detach WI + JE + delete batch cascade.
    if (b.workIntakeItemId) {
      await prisma.workIntakeItem.delete({ where: { id: b.workIntakeItemId } }).catch(() => null);
    }
    await prisma.payrollBatch.delete({ where: { id: b.id } });
    if (b.glJournalEntryId) {
      // Void the journal — a POSTED JE is normally immutable; this is
      // a local dev-only reset path.
      await prisma.journalEntryLine.deleteMany({ where: { journalEntryId: b.glJournalEntryId } });
      await prisma.journalEntry.delete({ where: { id: b.glJournalEntryId } }).catch(() => null);
    }
  }
  // Also clear any Final-Approval / Admin-Processing WI items still open.
  const wiOrigins = await prisma.workIntakeOrigin.findMany({
    where: {
      clubId,
      kind: { in: ["PAYROLL_FINAL_APPROVAL", "PAYROLL_ADMIN_PROCESSING", "PAYROLL_REVIEW"] },
    },
    select: { workIntakeItemId: true },
  });
  for (const w of wiOrigins) {
    await prisma.workIntakeItem.delete({ where: { id: w.workIntakeItemId } }).catch(() => null);
  }
}

// ---------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------
async function main() {
  const shouldReset = process.argv.includes("--reset");
  console.log("Payroll Founder Preview fixture — Coulee Ridge\n");

  const club = await findCouleeRidge();
  console.log(`Using tenant: ${club.name} (id: ${club.id})`);

  if (shouldReset) {
    console.log("Resetting preview payroll batches + WI…");
    await resetPreviewPayroll(club.id);
    console.log("  reset complete.\n");
  }

  // GL accounts + profile.
  const accounts = await ensurePayrollGlAccounts(club.id);
  const glProfile = await ensurePayrollGlProfile(club.id, accounts);
  console.log(`GL profile: ${glProfile.id}`);

  // Preview people.
  const profiles = await loadPreviewPeople(club.id);
  console.log(`Preview people: ${profiles.length}`);

  // Raelene / Chris lookup (email is stable per TA-1C fixture).
  const raelene = profiles.find((p) => p.user.email === "raelene.sample@preview.spectre.test");
  const chris   = profiles.find((p) => p.user.email === "chris.fixture@preview.spectre.test");
  if (!raelene || !chris) throw new Error("Raelene or Chris not found in preview people.");

  // Employee readiness for each of the 9.
  const hireDate = new Date("2020-01-15T00:00:00.000Z");
  let seq = 0;
  for (const p of profiles) {
    if (!p.employee) continue;
    const positionName = p.position?.name ?? "General Manager";
    // Give each person a distinct synthetic DOB — deterministic per employee id.
    const yearOffset = seq++ % 25;
    const dob = new Date(Date.UTC(1965 + yearOffset, seq % 12, 1 + (seq % 27)));
    await ensureEmployeeReady({
      clubId: club.id,
      employeeId: p.employee.id,
      firstName: p.employee.firstName,
      lastName: p.employee.lastName,
      positionName,
      hireDate,
      dateOfBirth: dob,
    });
  }

  // Pay group + period + memberships.
  const payGroup = await ensurePayGroup(club.id);
  const payPeriod = await ensurePayPeriod(club.id, payGroup.id);
  for (const p of profiles) {
    if (!p.employee) continue;
    await ensurePayGroupMembership(club.id, payGroup.id, p.employee.id, hireDate);
  }
  console.log(`Pay group: ${payGroup.code} (${payGroup.id})`);
  console.log(`Pay period: ${PAY_PERIOD_START.toISOString().slice(0, 10)} → ${PAY_PERIOD_END_INCL.toISOString().slice(0, 10)}, pay date ${PAY_DATE.toISOString().slice(0, 10)}`);
  void payPeriod;

  // Fiscal period covering the pay date — needed by the GL adapter.
  const fp = await ensureFiscalPeriodForPayDate(club.id, PAY_DATE);
  const reused = !fp.created.fiscalYear && !fp.created.fiscalPeriod;
  console.log(
    `Fiscal period: ${fp.fiscalPeriodId} (` +
    (reused ? "reused existing"
      : `${fp.created.fiscalYear ? "FY created" : "FY reused"}, ${fp.created.fiscalPeriod ? "period created" : "period reused"}`) +
    `)`,
  );

  // PayrollClubConfig — Raelene + Chris bridges.
  await configurePayrollClubConfig({
    clubId: club.id,
    payrollAdminUserId: raelene.userId,
    controllerUserId: chris.userId,
    glProfileId: glProfile.id,
  });
  console.log(`PayrollClubConfig: Payroll Admin = ${raelene.user.name}, Controller = ${chris.user.name}`);

  // Mission Control readiness — surface the Payroll Admin preparation
  // card on Raelene's Work Intake so she starts from Mission Control,
  // not a hidden URL. Idempotent — re-running refreshes the card.
  const periodLabel =
    `${PAY_PERIOD_START.toISOString().slice(0, 10)} → ${PAY_PERIOD_END_INCL.toISOString().slice(0, 10)}`;
  const adminCard = await ensurePayrollAdminProcessingCardForSalaryPeriod({
    clubId:      club.id,
    payPeriodId: payPeriod.id,
    ownerUserId: raelene.userId,
    subject:     `Payroll ready to process — ${periodLabel}`,
    preview:     `${profiles.length} salaried employees · Prepare, calculate, and hand off for final approval.`,
  });
  console.log(
    `Payroll Admin Work Intake card: ${adminCard.workIntakeItemId} ` +
    `(${adminCard.created ? "created" : "reused"})`,
  );

  console.log("\nPayroll Founder Preview fixture ready.");
  console.log("Sign in as Raelene (Payroll Admin):");
  console.log(`  email:    raelene.sample@preview.spectre.test`);
  console.log(`  password: TA1C-Preview-99`);
  console.log("Sign in as Chris (Final Approver):");
  console.log(`  email:    chris.fixture@preview.spectre.test`);
  console.log(`  password: TA1C-Preview-99`);
  console.log("Founder walkthrough starts at Mission Control:");
  console.log("  http://localhost:3000/app/admin");
  console.log("Raelene will see a Work Intake card titled");
  console.log(`  \"Payroll ready to process — ${periodLabel}\"`);
  console.log("Open the card to reach Payroll preparation.\n");
}

main()
  .catch((err) => { console.error(err); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
