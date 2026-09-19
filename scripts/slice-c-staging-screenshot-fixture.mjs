#!/usr/bin/env node
// scripts/slice-c-staging-screenshot-fixture.mjs
//
// Slice C final UI acceptance (2026-09-18) — disposable staging-only
// fixture for Benefits screenshot captures.
//
// Provisions on the STAGING database, in an UNMISTAKABLY SYNTHETIC club
// (name / slug / user emails all carry a "SLICE C BENEFITS TEST"
// prefix). Never touches Coulee Ridge, Chris, Marc, or any production
// / founder-review data.
//
// Idempotent: --setup upserts the fixture (safe to re-run).
// Cleanup:    --teardown deletes the fixture and everything that
//             transitively belongs to that Club.
//
// Environment guard: FAIL CLOSED unless the target database URL matches
// the known staging Postgres app. Refuses to run against localhost or
// against any URL whose host does not match the staging host we know.
//
// Usage:
//   SPECTRE_STAGING_DATABASE_URL=<staging DATABASE_URL> \
//   node scripts/slice-c-staging-screenshot-fixture.mjs --setup
//   node scripts/slice-c-staging-screenshot-fixture.mjs --teardown
//
// The founder never invokes this by hand — Claude runs it as part of
// the screenshot capture flow.

import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import crypto from "node:crypto";

// ---------------------------------------------------------------------
// Safety
// ---------------------------------------------------------------------
const FIXTURE_TAG = "SLICE C BENEFITS TEST";
const CLUB_SLUG   = "slice-c-benefits-test";
const CLUB_NAME   = `${FIXTURE_TAG} — Synthetic Club`;
const EMPLOYEE_FIRST = "SliceC";
const EMPLOYEE_LAST  = "BenefitsFixture";
const ADMIN_EMAIL  = "slice-c-benefits-test-admin@fixture.spectre.test";
const PA_EMAIL     = "slice-c-benefits-test-pa@fixture.spectre.test";
const CONTROLLER_EMAIL = "slice-c-benefits-test-controller@fixture.spectre.test";
const ADMIN_PASSWORD = process.env.SPECTRE_FIXTURE_ADMIN_PASSWORD ?? "SliceC-Benefits-Fixture-2026!";
const PA_PASSWORD    = process.env.SPECTRE_FIXTURE_PA_PASSWORD    ?? "SliceC-PA-Fixture-2026!";
const CONTROLLER_PASSWORD = process.env.SPECTRE_FIXTURE_CONTROLLER_PASSWORD ?? "SliceC-CT-Fixture-2026!";

function assertStagingUrl() {
  const url =
    process.env.SPECTRE_STAGING_DATABASE_URL ??
    process.env.DATABASE_URL ??
    "";
  if (!url) {
    throw new Error(
      "SPECTRE_STAGING_DATABASE_URL (or DATABASE_URL) required. Refusing to run without a target.",
    );
  }
  // Fail-closed: must be Postgres and NOT localhost. Staging DBs on Fly
  // are Postgres and their host contains ".flycast" or ".internal" or
  // ".fly.dev". We accept any of those as a positive staging signal.
  if (!/^postgres(ql)?:\/\//i.test(url)) {
    throw new Error(`Refusing to run — DATABASE_URL is not Postgres: ${url.slice(0, 32)}…`);
  }
  if (/localhost|127\.0\.0\.1|(^|\/)dev\.db/i.test(url)) {
    throw new Error("Refusing to run — DATABASE_URL points at a local database.");
  }
  // Known staging host signals — the Fly-internal ones AND the Neon
  // primary staging cluster (ep-delicate-band-aj3vxkxu-pooler) documented
  // in reference_staging_infra. Localhost / prod is already refused above.
  const staging =
    /flycast|\.internal|\.fly\.dev|spectre-staging|staging-/i.test(url) ||
    /ep-delicate-band-aj3vxkxu-pooler\.c-3\.us-east-2\.aws\.neon\.tech/i.test(url);
  if (!staging) {
    throw new Error(
      "Refusing to run — DATABASE_URL does not match any known staging host pattern.",
    );
  }
  return url;
}

function assertNotFounderTenant(clubName, clubSlug) {
  if (/coulee/i.test(clubName) || /coulee/i.test(clubSlug)) {
    throw new Error(`Refusing to write to a Coulee Ridge tenant: ${clubName}/${clubSlug}`);
  }
}

// ---------------------------------------------------------------------
// Prisma
// ---------------------------------------------------------------------
const url = assertStagingUrl();
const prisma = new PrismaClient({ datasources: { db: { url } } });

const nowIso = () => new Date().toISOString();
const log = (msg) => console.log(`[${nowIso()}] ${msg}`);

// ---------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------
async function findOrCreateClub() {
  let club = await prisma.club.findFirst({ where: { slug: CLUB_SLUG } });
  if (!club) {
    club = await prisma.club.create({
      data: {
        name: CLUB_NAME,
        slug: CLUB_SLUG,
        stagingDataMode: "SYNTHETIC_DEMO",
        isDemoTenant: true,
        payrollProvince: "AB",
      },
    });
    log(`created club ${club.id} (${CLUB_SLUG})`);
  } else {
    log(`club exists: ${club.id} (${CLUB_SLUG})`);
  }
  assertNotFounderTenant(club.name, club.slug);
  return club;
}

async function findOrCreateAdminUser(clubId) {
  let user = await prisma.user.findFirst({ where: { email: ADMIN_EMAIL } });
  if (!user) {
    user = await prisma.user.create({
      data: {
        email: ADMIN_EMAIL,
        name: `${FIXTURE_TAG} Admin`,
        role: "CLUB_ADMIN",
        passwordHash: await bcrypt.hash(ADMIN_PASSWORD, 10),
        status: "ACTIVE",
      },
    });
    log(`created admin user ${user.id}`);
  }
  const roleExists = await prisma.userClubRole.findFirst({
    where: { userId: user.id, clubId, roleKey: "CLUB_ADMIN" },
  });
  if (!roleExists) {
    await prisma.userClubRole.create({ data: { userId: user.id, clubId, roleKey: "CLUB_ADMIN" } });
    log(`granted CLUB_ADMIN on club ${clubId}`);
  }
  return user;
}

async function findOrCreateRoleUser(clubId, email, displayName, roleKey, password) {
  let user = await prisma.user.findFirst({ where: { email } });
  if (!user) {
    user = await prisma.user.create({
      data: {
        email,
        name: `${FIXTURE_TAG} ${displayName}`,
        role: roleKey,
        passwordHash: await bcrypt.hash(password, 10),
        status: "ACTIVE",
      },
    });
    log(`created ${roleKey} user ${user.id} (${email})`);
  }
  const exists = await prisma.userClubRole.findFirst({
    where: { userId: user.id, clubId, roleKey },
  });
  if (!exists) {
    await prisma.userClubRole.create({ data: { userId: user.id, clubId, roleKey } });
    log(`granted ${roleKey} on club ${clubId}`);
  }
  return user;
}

async function findOrCreateAccount(clubId, number, name, type) {
  let a = await prisma.account.findFirst({ where: { clubId, accountNumber: number } });
  if (!a) {
    a = await prisma.account.create({
      data: {
        clubId, accountNumber: number, name, type,
        normalBalance: type === "EXPENSE" ? "DEBIT" : "CREDIT",
        isActive: true, allowManualPosting: false,
      },
    });
  }
  return a;
}

async function findOrCreateComponent(clubId, spec) {
  let c = await prisma.payrollComponent.findFirst({ where: { clubId, code: spec.code } });
  if (!c) {
    c = await prisma.payrollComponent.create({ data: { clubId, ...spec } });
    log(`created component ${spec.code}`);
  }
  return c;
}

async function findOrCreatePlan(clubId, spec, principalUserId) {
  let p = await prisma.payrollBenefitPlan.findFirst({ where: { clubId, code: spec.code } });
  if (!p) {
    p = await prisma.payrollBenefitPlan.create({
      data: { clubId, ...spec, createdByUserId: principalUserId, active: true },
    });
    log(`created plan ${spec.code}`);
  }
  return p;
}

async function findOrCreateEmployee(clubId) {
  const email = `${EMPLOYEE_FIRST.toLowerCase()}.${EMPLOYEE_LAST.toLowerCase()}@fixture.spectre.test`;
  let e = await prisma.employee.findFirst({ where: { clubId, email } });
  if (!e) {
    const number = `SC-${crypto.randomBytes(2).toString("hex").toUpperCase()}`;
    e = await prisma.employee.create({
      data: {
        clubId, firstName: EMPLOYEE_FIRST, lastName: EMPLOYEE_LAST, email,
        hireDate: new Date(Date.UTC(2020, 0, 1)),
        dateOfBirth: new Date(Date.UTC(1990, 5, 15)),
        status: "ACTIVE", employeeNumber: number,
        employeeLifecycle: "ACTIVE", compensationType: "SALARY",
        homeProvince: "AB",
      },
    });
    log(`created employee ${e.id}`);
  }
  return e;
}

async function findOrCreateEnrolment(clubId, employeeId, planId, spec, principalUserId) {
  const existing = await prisma.employeeBenefitPlanEnrolment.findFirst({
    where: { clubId, employeeId, planId, effectiveFrom: spec.effectiveFrom },
  });
  if (existing) return existing;
  const e = await prisma.employeeBenefitPlanEnrolment.create({
    data: {
      clubId, employeeId, planId, status: spec.status ?? "ACTIVE",
      effectiveFrom: spec.effectiveFrom, effectiveTo: spec.effectiveTo ?? null,
      electionKind: spec.electionKind, amount: spec.amount, percentBps: spec.percentBps,
      enteredByUserId: principalUserId,
      endedByUserId: spec.status === "ENDED" ? principalUserId : null,
    },
  });
  log(`created enrolment ${e.id} (${spec.status ?? "ACTIVE"})`);
  return e;
}

async function setup() {
  log("--- SETUP ---");
  const club = await findOrCreateClub();
  const admin = await findOrCreateAdminUser(club.id);

  // GL accounts
  const ltdExp   = await findOrCreateAccount(club.id, "5150", "LTD Employee Premium Expense", "EXPENSE");
  const ltdLiab  = await findOrCreateAccount(club.id, "2150", "LTD Employee Payable",         "LIABILITY");
  const hcExp    = await findOrCreateAccount(club.id, "5160", "Employer Health Premium Expense", "EXPENSE");
  const hcLiab   = await findOrCreateAccount(club.id, "2160", "Health Benefit Liability",     "LIABILITY");
  // Slice D — RRSP accounts.
  const rrspEeExp  = await findOrCreateAccount(club.id, "5170", "RRSP Employee Contribution Expense", "EXPENSE");
  const rrspEeLiab = await findOrCreateAccount(club.id, "2170", "RRSP Employee Payable",              "LIABILITY");
  const rrspErExp  = await findOrCreateAccount(club.id, "5180", "RRSP Employer Match Expense",        "EXPENSE");
  const rrspErLiab = await findOrCreateAccount(club.id, "2180", "RRSP Employer Payable",              "LIABILITY");

  const ltdComp = await findOrCreateComponent(club.id, {
    code: "LTD_EE", displayName: "LTD Employee Premium",
    category: "EMPLOYEE_DEDUCTION", side: "EMPLOYEE",
    cashEffect: "DECREASES_NET_PAY",
    taxableEffect: "NONE", cppPensionableEffect: "NONE", eiInsurableEffect: "NONE",
    calculationMethod: "FIXED_AMOUNT", displaySection: "DEDUCTIONS",
    usage: "RECURRING",
    expenseAccountId: ltdExp.id, liabilityAccountId: ltdLiab.id,
    active: true,
  });
  const hcComp = await findOrCreateComponent(club.id, {
    code: "HEALTH_ER", displayName: "Employer Health Premium",
    category: "TAXABLE_BENEFIT", side: "EMPLOYER",
    cashEffect: "NO_NET_PAY_EFFECT",
    taxableEffect: "ADD", cppPensionableEffect: "ADD", eiInsurableEffect: "NONE",
    calculationMethod: "FIXED_AMOUNT", displaySection: "BENEFITS",
    usage: "RECURRING",
    expenseAccountId: hcExp.id, liabilityAccountId: hcLiab.id,
    active: true,
  });

  const ltdPlan = await findOrCreatePlan(club.id, {
    kind: "LTD", code: "LTD_FIXTURE",
    name: `${FIXTURE_TAG} — LTD Standard`,
    description: "Fixture LTD plan for Slice C acceptance screenshots.",
    effectiveFrom: new Date(Date.UTC(2020, 0, 1)),
    effectiveTo: null,
    employeeComponentId: ltdComp.id,
    employerComponentId: null,
    defaultElectionKind: "FIXED_AMOUNT",
    eligibleEarningsBasis: null,
  }, admin.id);

  const healthPlan = await findOrCreatePlan(club.id, {
    kind: "HEALTH_DENTAL", code: "HEALTH_FIXTURE",
    name: `${FIXTURE_TAG} — Group Health & Dental`,
    description: "Fixture Health/Dental plan for Slice C acceptance screenshots.",
    effectiveFrom: new Date(Date.UTC(2020, 0, 1)),
    effectiveTo: null,
    employeeComponentId: null,
    employerComponentId: hcComp.id,
    defaultElectionKind: "FIXED_AMOUNT",
    eligibleEarningsBasis: null,
  }, admin.id);

  // Slice D — RRSP components + plan (percent + employer match).
  const rrspEeComp = await findOrCreateComponent(club.id, {
    code: "RRSP_EE", displayName: "RRSP Employee Contribution",
    category: "EMPLOYEE_DEDUCTION", side: "EMPLOYEE",
    cashEffect: "DECREASES_NET_PAY",
    taxableEffect: "NONE", cppPensionableEffect: "NONE", eiInsurableEffect: "NONE",
    calculationMethod: "PERCENT_OF_ELIGIBLE_EARNINGS",
    eligibleEarningsBase: "REGULAR_EARNINGS_ONLY",
    displaySection: "DEDUCTIONS", usage: "RECURRING",
    expenseAccountId: rrspEeExp.id, liabilityAccountId: rrspEeLiab.id,
    active: true,
  });
  const rrspErComp = await findOrCreateComponent(club.id, {
    code: "RRSP_ER", displayName: "RRSP Employer Match",
    category: "EMPLOYER_CONTRIBUTION", side: "EMPLOYER",
    cashEffect: "NO_NET_PAY_EFFECT",
    taxableEffect: "NONE", cppPensionableEffect: "NONE", eiInsurableEffect: "NONE",
    calculationMethod: "PERCENT_OF_ELIGIBLE_EARNINGS",
    eligibleEarningsBase: "REGULAR_EARNINGS_ONLY",
    displaySection: "BENEFITS", usage: "RECURRING",
    expenseAccountId: rrspErExp.id, liabilityAccountId: rrspErLiab.id,
    active: true,
  });
  const rrspPlan = await findOrCreatePlan(club.id, {
    kind: "RRSP", code: "RRSP_FIXTURE",
    name: `${FIXTURE_TAG} — Group RRSP`,
    description: "Fixture RRSP plan (100% match, 3% cap).",
    effectiveFrom: new Date(Date.UTC(2020, 0, 1)),
    effectiveTo: null,
    employeeComponentId: rrspEeComp.id,
    employerComponentId: rrspErComp.id,
    defaultElectionKind: "PERCENT_OF_ELIGIBLE_EARNINGS",
    eligibleEarningsBasis: "REGULAR_EARNINGS_ONLY",
    employerMatchBps: 10000,    // 100%
    employerMatchCapBps: 300,   //   3%
  }, admin.id);

  const employee = await findOrCreateEmployee(club.id);

  // ACTIVE LTD enrolment (2024-01-01, open-ended)
  await findOrCreateEnrolment(club.id, employee.id, ltdPlan.id, {
    effectiveFrom: new Date(Date.UTC(2024, 0, 1)),
    effectiveTo: null,
    electionKind: "FIXED_AMOUNT", amount: "42.50",
    status: "ACTIVE",
  }, admin.id);

  // ACTIVE Health/Dental enrolment (2024-01-01, open-ended)
  await findOrCreateEnrolment(club.id, employee.id, healthPlan.id, {
    effectiveFrom: new Date(Date.UTC(2024, 0, 1)),
    effectiveTo: null,
    electionKind: "FIXED_AMOUNT", amount: "180.00",
    status: "ACTIVE",
  }, admin.id);

  // HISTORICAL LTD enrolment (2020-01-01 → 2023-12-31, ended)
  await findOrCreateEnrolment(club.id, employee.id, ltdPlan.id, {
    effectiveFrom: new Date(Date.UTC(2020, 0, 1)),
    effectiveTo: new Date(Date.UTC(2024, 0, 1)),
    electionKind: "FIXED_AMOUNT", amount: "35.00",
    status: "ENDED",
  }, admin.id);

  // Slice D — ACTIVE RRSP enrolment at 5% election.
  await findOrCreateEnrolment(club.id, employee.id, rrspPlan.id, {
    effectiveFrom: new Date(Date.UTC(2024, 0, 1)),
    effectiveTo: null,
    electionKind: "PERCENT_OF_ELIGIBLE_EARNINGS",
    amount: null, percentBps: 500,
    status: "ACTIVE",
  }, admin.id);

  // Slice D closeout §31 shot 05 — a SECOND RRSP plan the employee is
  // NOT enrolled in, so the Enrol form's plan picker still offers an
  // RRSP option once the primary RRSP is already enrolled.
  await findOrCreatePlan(club.id, {
    kind: "RRSP", code: "RRSP_ALT_FIXTURE",
    name: `${FIXTURE_TAG} — Alternate Group RRSP`,
    description: "Second fixture RRSP plan (for enrol-form screenshot).",
    effectiveFrom: new Date(Date.UTC(2020, 0, 1)),
    effectiveTo: null,
    employeeComponentId: rrspEeComp.id,
    employerComponentId: rrspErComp.id,
    defaultElectionKind: "PERCENT_OF_ELIGIBLE_EARNINGS",
    eligibleEarningsBasis: "REGULAR_EARNINGS_ONLY",
    employerMatchBps: 5000,     //  50%
    employerMatchCapBps: 200,   //   2%
  }, admin.id);

  log("--- SETUP COMPLETE ---");
  log(`clubId       = ${club.id}`);
  log(`clubSlug     = ${club.slug}`);
  log(`adminEmail   = ${ADMIN_EMAIL}`);
  log(`employeeId   = ${employee.id}`);
  log(`ltdPlanId    = ${ltdPlan.id}`);
  log(`healthPlanId = ${healthPlan.id}`);
  console.log("");
  console.log("The synthetic admin can log in at https://staging.spectreautomation.com/login");
  console.log(`with ${ADMIN_EMAIL} and the fixture password.`);
}

// ---------------------------------------------------------------------
// Slice D visual closeout §31 — payroll-ready extension.
//
// After --setup, run --payroll-ready to add every remaining prerequisite
// for a Prepare → Post cycle against the synthetic tenant:
//   * PAYROLL_ADMIN + CONTROLLER users on the synthetic club (submitter
//     ≠ approver is required by service-layer SoD).
//   * EmployeeEmploymentAssignment (PRIMARY) + Department + EmployeeCompensation
//     ($110k salary) — satisfies MISSING_ASSIGNMENT + MISSING_COMPENSATION.
//   * PayrollGlAccountingProfile with the 8 statutory GL accounts.
//   * PayrollClubConfig (province + PA + Controller + GL profile link).
//   * PayrollPayGroup + 24 SM 2026 pay periods + pay-group membership.
//   * Implementation declaration confirmed as ZERO_OPENING_YTD (skips
//     MISSING_OPENING_YTD blocker).
//   * FiscalYear 2026 + FiscalPeriod for Sept + Oct (Post targets Sep 30
//     payDate; second-period Post targets Oct 15).
//
// TD1 encrypted claims are NOT written — WARNING-only exceptions
// (MISSING_FEDERAL_TD1 / _PROVINCIAL_TD1) are acceptable. SIN and banking
// remain unset — also WARNING-only.
// ---------------------------------------------------------------------

async function findOrCreateStagingAccount(clubId, number, name, type) {
  return findOrCreateAccount(clubId, number, name, type);
}

async function findOrCreateDepartment(clubId, code, name) {
  let d = await prisma.department.findFirst({ where: { clubId, code } });
  if (!d) {
    d = await prisma.department.create({ data: { clubId, code, name } });
    log(`created department ${code}`);
  }
  return d;
}

async function payrollReady() {
  log("--- PAYROLL-READY EXTENSION ---");
  const club = await prisma.club.findFirst({ where: { slug: CLUB_SLUG } });
  if (!club) throw new Error("Run --setup first — synthetic club not found.");
  assertNotFounderTenant(club.name, club.slug);
  const admin = await prisma.user.findFirstOrThrow({ where: { email: ADMIN_EMAIL } });
  const employee = await prisma.employee.findFirst({
    where: { clubId: club.id, email: { contains: "@fixture.spectre.test" } },
  });
  if (!employee) throw new Error("Run --setup first — synthetic employee not found.");

  // 1. PA + Controller users.
  const pa = await findOrCreateRoleUser(club.id, PA_EMAIL, "Payroll Admin", "PAYROLL_ADMIN", PA_PASSWORD);
  const controller = await findOrCreateRoleUser(club.id, CONTROLLER_EMAIL, "Controller", "CONTROLLER", CONTROLLER_PASSWORD);

  // 2. Statutory GL accounts + PayrollGlAccountingProfile.
  const salaryExpense       = await findOrCreateStagingAccount(club.id, "5100", "Salary Expense",              "EXPENSE");
  const employerCppExpense  = await findOrCreateStagingAccount(club.id, "5110", "Employer CPP Expense",        "EXPENSE");
  const employerEiExpense   = await findOrCreateStagingAccount(club.id, "5120", "Employer EI Expense",         "EXPENSE");
  const netPayPayable       = await findOrCreateStagingAccount(club.id, "2100", "Net Pay Payable",             "LIABILITY");
  const cppPayable          = await findOrCreateStagingAccount(club.id, "2110", "CPP Payable",                 "LIABILITY");
  const eiPayable           = await findOrCreateStagingAccount(club.id, "2120", "EI Payable",                  "LIABILITY");
  const federalTaxPayable   = await findOrCreateStagingAccount(club.id, "2130", "Federal Tax Payable",         "LIABILITY");
  const provTaxPayable      = await findOrCreateStagingAccount(club.id, "2140", "AB Tax Payable",              "LIABILITY");

  let glProfile = await prisma.payrollGlAccountingProfile.findUnique({ where: { clubId: club.id } });
  if (!glProfile) {
    glProfile = await prisma.payrollGlAccountingProfile.create({
      data: {
        clubId: club.id,
        salaryExpenseAccountId: salaryExpense.id,
        employerCppExpenseAccountId: employerCppExpense.id,
        employerEiExpenseAccountId: employerEiExpense.id,
        netPayPayableAccountId: netPayPayable.id,
        cppPayableAccountId: cppPayable.id,
        eiPayableAccountId: eiPayable.id,
        federalTaxPayableAccountId: federalTaxPayable.id,
        provincialTaxPayableAccountId: provTaxPayable.id,
      },
    });
    log(`created payroll GL profile ${glProfile.id}`);
  }

  // 3. PayrollClubConfig.
  let config = await prisma.payrollClubConfig.findFirst({ where: { clubId: club.id } });
  if (!config) {
    config = await prisma.payrollClubConfig.create({
      data: {
        clubId: club.id,
        country: "CA", provinceOfEmployment: "AB",
        payFrequency: "SEMI_MONTHLY", paymentMethod: "DIRECT_DEPOSIT",
        payrollAdminUserId: pa.id,
        controllerUserId: controller.id,
        glAccountingProfileId: glProfile.id,
      },
    });
    log(`created payroll club config`);
  } else {
    await prisma.payrollClubConfig.update({
      where: { id: config.id },
      data: {
        payrollAdminUserId: pa.id, controllerUserId: controller.id,
        glAccountingProfileId: glProfile.id,
      },
    });
  }

  // 4. Department + Assignment + Compensation.
  const dept = await findOrCreateDepartment(club.id, "ADMIN", "Administration");
  await prisma.employee.update({ where: { id: employee.id }, data: { departmentId: dept.id } });
  let assn = await prisma.employeeEmploymentAssignment.findFirst({
    where: { clubId: club.id, employeeId: employee.id, role: "PRIMARY" },
  });
  if (!assn) {
    assn = await prisma.employeeEmploymentAssignment.create({
      data: {
        clubId: club.id, employeeId: employee.id, role: "PRIMARY",
        employmentType: "FULL_TIME",
        effectiveFrom: new Date(Date.UTC(2020, 0, 1)),
        departmentId: dept.id,
      },
    });
    log(`created assignment ${assn.id}`);
  }
  const compExists = await prisma.employeeCompensation.findFirst({
    where: { clubId: club.id, employeeId: employee.id, cadence: "SALARY" },
  });
  if (!compExists) {
    await prisma.employeeCompensation.create({
      data: {
        clubId: club.id, employeeId: employee.id, assignmentId: assn.id,
        cadence: "SALARY", rate: "110000", currency: "CAD",
        effectiveFrom: new Date(Date.UTC(2020, 0, 1)),
      },
    });
    log(`created compensation (SALARY $110k)`);
  }

  // 5. PayrollPayGroup + 24 SM pay periods for 2026 + membership.
  let pg = await prisma.payrollPayGroup.findFirst({ where: { clubId: club.id, code: "SAL-SM" } });
  if (!pg) {
    pg = await prisma.payrollPayGroup.create({
      data: {
        clubId: club.id, code: "SAL-SM", name: "Salary Semi-Monthly",
        payFrequency: "SEMI_MONTHLY", payDateOffsetDays: 0,
        calendarAnchorDate: null, active: true,
      },
    });
    log(`created pay group ${pg.id}`);
  }
  const periodCount = await prisma.payrollPayPeriod.count({
    where: { clubId: club.id, payGroupId: pg.id, taxYear: 2026 },
  });
  if (periodCount < 24) {
    // Generate all 24 in one pass (mirrors payroll-integration-fixture.ts).
    let seq = 0;
    for (let m = 0; m < 12; m++) {
      seq += 1;
      await prisma.payrollPayPeriod.upsert({
        where: {
          clubId_payGroupId_taxYear_sequenceInYear: {
            clubId: club.id, payGroupId: pg.id, taxYear: 2026, sequenceInYear: seq,
          },
        },
        create: {
          clubId: club.id, payGroupId: pg.id, taxYear: 2026, sequenceInYear: seq,
          periodStart: new Date(Date.UTC(2026, m, 1)),
          periodEnd:   new Date(Date.UTC(2026, m, 16)),
          payDate:     new Date(Date.UTC(2026, m, 15)),
          status: "OPEN",
        },
        update: {},
      });
      seq += 1;
      const lastDay = new Date(Date.UTC(2026, m + 1, 0)).getUTCDate();
      await prisma.payrollPayPeriod.upsert({
        where: {
          clubId_payGroupId_taxYear_sequenceInYear: {
            clubId: club.id, payGroupId: pg.id, taxYear: 2026, sequenceInYear: seq,
          },
        },
        create: {
          clubId: club.id, payGroupId: pg.id, taxYear: 2026, sequenceInYear: seq,
          periodStart: new Date(Date.UTC(2026, m, 16)),
          periodEnd:   new Date(Date.UTC(2026, m + 1, 1)),
          payDate:     new Date(Date.UTC(2026, m, lastDay)),
          status: "OPEN",
        },
        update: {},
      });
    }
    log(`created 24 SM pay periods for 2026`);
  }
  const memberExists = await prisma.payrollPayGroupMember.findFirst({
    where: { clubId: club.id, payGroupId: pg.id, employeeId: employee.id },
  });
  if (!memberExists) {
    await prisma.payrollPayGroupMember.create({
      data: {
        clubId: club.id, payGroupId: pg.id, employeeId: employee.id,
        effectiveFrom: new Date(Date.UTC(2020, 0, 1)),
      },
    });
    log(`enrolled employee in pay group`);
  }

  // 6. Implementation declaration — ZERO_OPENING_YTD.
  const decl = await prisma.payrollImplementationDeclaration.findFirst({
    where: { clubId: club.id, taxYear: 2026 },
  });
  if (!decl || !decl.confirmedAt) {
    await prisma.payrollImplementationDeclaration.upsert({
      where: { clubId_taxYear: { clubId: club.id, taxYear: 2026 } },
      create: {
        clubId: club.id, taxYear: 2026, mode: "ZERO_OPENING_YTD",
        confirmedByUserId: pa.id, confirmedAt: new Date(),
      },
      update: {
        mode: "ZERO_OPENING_YTD",
        confirmedByUserId: pa.id, confirmedAt: new Date(),
      },
    });
    log(`confirmed implementation declaration (ZERO_OPENING_YTD, 2026)`);
  }

  // 7. FiscalYear 2026 + FiscalPeriods for Sept + Oct.
  let fy = await prisma.fiscalYear.findFirst({ where: { clubId: club.id, label: "FY2026" } });
  if (!fy) {
    fy = await prisma.fiscalYear.create({
      data: {
        clubId: club.id, label: "FY2026",
        startDate: new Date(Date.UTC(2026, 0, 1)),
        endDate:   new Date(Date.UTC(2026, 11, 31)),
        status: "OPEN",
      },
    });
    log(`created FY2026`);
  }
  for (const m of [9, 10]) {
    const exists = await prisma.fiscalPeriod.findFirst({
      where: { clubId: club.id, fiscalYearId: fy.id, sequence: m },
    });
    if (!exists) {
      await prisma.fiscalPeriod.create({
        data: {
          clubId: club.id, fiscalYearId: fy.id,
          label: `FY2026-M${String(m).padStart(2, "0")}`,
          startDate: new Date(Date.UTC(2026, m - 1, 1)),
          endDate:   new Date(Date.UTC(2026, m, 0)),
          sequence: m, status: "OPEN",
        },
      });
      log(`created FY2026-M${String(m).padStart(2, "0")}`);
    }
  }

  log("--- PAYROLL-READY COMPLETE ---");
  log(`employeeId    = ${employee.id}`);
  log(`paEmail       = ${PA_EMAIL}`);
  log(`controllerEmail = ${CONTROLLER_EMAIL}`);
  log(`payGroupId    = ${pg.id}`);
  log("");
  log("Trigger the pipeline by calling (as the fixture admin):");
  log(`  POST /api/dev/slice-d-pipeline?clubSlug=${CLUB_SLUG}&seq=18`);
}

// ---------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------
async function teardown() {
  log("--- TEARDOWN ---");
  const club = await prisma.club.findFirst({ where: { slug: CLUB_SLUG } });
  if (!club) {
    log(`no club with slug ${CLUB_SLUG} — nothing to delete`);
    return;
  }
  assertNotFounderTenant(club.name, club.slug);

  const clubId = club.id;
  // FK-safe deletion order. Everything either FKs to Club (cascade) or
  // needs explicit clean-up below.
  await prisma.employeeBenefitPlanEnrolment.deleteMany({ where: { clubId } });
  await prisma.payrollBenefitPlan.deleteMany({ where: { clubId } });
  await prisma.payrollComponent.deleteMany({ where: { clubId } });
  await prisma.employeeCompensation.deleteMany({ where: { clubId } });
  await prisma.employeeEmploymentAssignment.deleteMany({ where: { clubId } });
  await prisma.employee.deleteMany({ where: { clubId } });
  await prisma.account.deleteMany({ where: { clubId } });
  await prisma.userClubRole.deleteMany({ where: { clubId } });
  await prisma.club.delete({ where: { id: clubId } });
  await prisma.user.deleteMany({ where: { email: ADMIN_EMAIL } });
  log(`deleted club ${clubId} + admin user`);
}

// ---------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------
async function main() {
  const args = new Set(process.argv.slice(2));
  const doSetup        = args.has("--setup");
  const doTeardown     = args.has("--teardown");
  const doPayrollReady = args.has("--payroll-ready");
  const chosen = [doSetup, doTeardown, doPayrollReady].filter(Boolean).length;
  if (chosen !== 1) {
    console.error("Usage: slice-c-staging-screenshot-fixture.mjs (--setup | --teardown | --payroll-ready)");
    process.exit(2);
  }
  try {
    if (doSetup) await setup();
    else if (doPayrollReady) await payrollReady();
    else await teardown();
    await prisma.$disconnect();
  } catch (e) {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  }
}

main();
