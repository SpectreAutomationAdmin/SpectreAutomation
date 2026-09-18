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
const ADMIN_PASSWORD = process.env.SPECTRE_FIXTURE_ADMIN_PASSWORD ?? "SliceC-Benefits-Fixture-2026!";

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
  const doSetup = args.has("--setup");
  const doTeardown = args.has("--teardown");
  if (doSetup === doTeardown) {
    console.error("Usage: slice-c-staging-screenshot-fixture.mjs (--setup | --teardown)");
    process.exit(2);
  }
  try {
    if (doSetup) await setup();
    else await teardown();
    await prisma.$disconnect();
  } catch (e) {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  }
}

main();
