// Payroll Admin Slice 3F acceptance (2026-09-13) — GL config + Payroll
// Admin poster + save/restore for Coulee staging.
//
// Setup:
//   node payroll-3f-acceptance-fixture.mjs
//     - Reuses fixture.payroll-admin.3e@spectre.test (submitter/PA) and
//       fixture.controller.3e@spectre.test (approver) — created by
//       scripts/payroll-3e-acceptance-fixture.mjs. Grants CLUB_ADMIN
//       to a NEW fixture.poster.3f@spectre.test so the poster is
//       distinct from the submitter (SoD).
//     - Ensures a PayrollGlAccountingProfile exists on Coulee with 8
//       synthetic test accounts (numbers 5100-5120 EXPENSE + 2100-2140
//       LIABILITY). Saves the prior config to
//       /app/tmp/payroll-3f-fixture/coulee-payroll-config-prerestore.json
//       before repointing so `--restore` can undo the change.
//
// Restore:
//   node payroll-3f-acceptance-fixture.mjs --restore
//     - Reads the save file and restores Coulee's prior
//       PayrollClubConfig.glAccountingProfileId + payrollAdminUserId +
//       controllerUserId.
//     - Deletes the fixture GL profile if it was created by 3F.

import { PrismaClient } from "@prisma/client";
import fs from "node:fs";
const prisma = new PrismaClient();

const COULEE       = "cmrvdeny7000144372ktmmg9c";
const POSTER_EMAIL = "fixture.poster.3f@spectre.test";
const PA_EMAIL     = "fixture.payroll-admin.3e@spectre.test";
const CTRL_EMAIL   = "fixture.controller.3e@spectre.test";
// bcryptjs hash of "spectre-3e-fixture" — reused across 3E + 3F.
const PASSWORD_HASH = "$2a$10$3NdHFZO.5GJLWfOVhv033e6OKjo5Rll5.G5Qjpl.BsbifK9pVWofq";

const SAVE_DIR  = "/app/tmp/payroll-3f-fixture";
const SAVE_FILE = `${SAVE_DIR}/coulee-payroll-config-prerestore.json`;

const ACCOUNTS = [
  { number: "5100", name: "Salary Expense (3F fixture)", type: "EXPENSE" },
  { number: "5110", name: "Employer CPP Expense (3F fixture)", type: "EXPENSE" },
  { number: "5120", name: "Employer EI Expense (3F fixture)", type: "EXPENSE" },
  { number: "2100", name: "Net Pay Payable (3F fixture)", type: "LIABILITY" },
  { number: "2110", name: "CPP Payable (3F fixture)", type: "LIABILITY" },
  { number: "2120", name: "EI Payable (3F fixture)", type: "LIABILITY" },
  { number: "2130", name: "Federal Tax Payable (3F fixture)", type: "LIABILITY" },
  { number: "2140", name: "AB Tax Payable (3F fixture)", type: "LIABILITY" },
];

async function ensureUser(email, name, roleKey) {
  const existing = await prisma.user.findFirst({ where: { email }, select: { id: true } });
  const user = existing
    ? existing
    : await prisma.user.create({
        data: {
          email, name, role: roleKey === "CONTROLLER" ? "CONTROLLER" : roleKey === "CLUB_ADMIN" ? "CLUB_ADMIN" : "PAYROLL_ADMIN",
          passwordHash: PASSWORD_HASH, status: "ACTIVE",
        },
        select: { id: true },
      });
  if (!existing) console.log(`  + Created user ${email}: ${user.id}`);
  else console.log(`  = User ${email} exists: ${user.id}`);
  // Ensure role at Coulee.
  const link = await prisma.userClubRole.findFirst({
    where: { userId: user.id, clubId: COULEE, roleKey },
    select: { id: true },
  });
  if (!link) {
    await prisma.userClubRole.create({
      data: { userId: user.id, clubId: COULEE, roleKey },
    });
    console.log(`  + Granted role ${roleKey} at Coulee to ${email}`);
  } else {
    console.log(`  = Role ${roleKey} at Coulee already on ${email}`);
  }
  // Normalise password hash (idempotent).
  await prisma.user.update({
    where: { id: user.id },
    data: { passwordHash: PASSWORD_HASH, status: "ACTIVE" },
  });
  return user.id;
}

async function ensureAccounts() {
  const accts = {};
  for (const spec of ACCOUNTS) {
    const existing = await prisma.account.findFirst({
      where: { clubId: COULEE, accountNumber: spec.number },
      select: { id: true, isActive: true },
    });
    if (existing) {
      if (!existing.isActive) {
        await prisma.account.update({ where: { id: existing.id }, data: { isActive: true } });
      }
      accts[spec.number] = existing.id;
      console.log(`  = Account ${spec.number} ${spec.name} exists`);
    } else {
      const created = await prisma.account.create({
        data: {
          clubId: COULEE, accountNumber: spec.number, name: spec.name, type: spec.type,
          normalBalance: spec.type === "EXPENSE" ? "DEBIT" : "CREDIT",
          isActive: true, allowManualPosting: false,
        },
        select: { id: true },
      });
      accts[spec.number] = created.id;
      console.log(`  + Created account ${spec.number} ${spec.name}`);
    }
  }
  return accts;
}

async function ensureFiscalPeriod() {
  // Ensure a fiscal year + period covering Nov 8-21 pay date (2026-11-21).
  let fy = await prisma.fiscalYear.findFirst({
    where: { clubId: COULEE, startDate: { lte: new Date(Date.UTC(2026, 10, 21)) },
             endDate: { gte: new Date(Date.UTC(2026, 10, 21)) } },
    select: { id: true },
  });
  if (!fy) {
    fy = await prisma.fiscalYear.create({
      data: {
        clubId: COULEE, label: "FY2026 (3F fixture)",
        startDate: new Date(Date.UTC(2026, 0, 1)), endDate: new Date(Date.UTC(2026, 11, 31)),
        status: "OPEN",
      },
      select: { id: true },
    });
    console.log(`  + Created fiscal year 2026`);
  } else {
    console.log(`  = Fiscal year 2026 exists`);
  }
  let period = await prisma.fiscalPeriod.findFirst({
    where: { clubId: COULEE, startDate: { lte: new Date(Date.UTC(2026, 10, 21)) },
             endDate: { gte: new Date(Date.UTC(2026, 10, 21)) } },
    select: { id: true, status: true },
  });
  if (!period) {
    await prisma.fiscalPeriod.create({
      data: {
        clubId: COULEE, fiscalYearId: fy.id, label: "FY2026-M11 (3F fixture)",
        startDate: new Date(Date.UTC(2026, 10, 1)), endDate: new Date(Date.UTC(2026, 10, 30)),
        sequence: 11, status: "OPEN",
      },
    });
    console.log(`  + Created fiscal period Nov 2026`);
  } else {
    if (period.status !== "OPEN") {
      await prisma.fiscalPeriod.update({ where: { id: period.id }, data: { status: "OPEN" } });
      console.log(`  ~ Reopened fiscal period covering Nov 21, 2026`);
    } else {
      console.log(`  = Fiscal period covering Nov 21, 2026 is OPEN`);
    }
  }
}

async function setup() {
  console.log(`\n== Payroll 3F acceptance fixture SETUP @ ${new Date().toISOString()} ==`);
  // Users (poster distinct from PA).
  const paId     = await ensureUser(PA_EMAIL,   "Payroll Admin (3E)",  "PAYROLL_ADMIN");
  const ctrlId   = await ensureUser(CTRL_EMAIL, "Controller (3E)",     "CONTROLLER");
  const posterId = await ensureUser(POSTER_EMAIL, "Poster Admin (3F)", "CLUB_ADMIN");

  // Save prior Coulee config if we don't already have a save file.
  const priorConfig = await prisma.payrollClubConfig.findUnique({
    where: { clubId: COULEE },
    select: { payrollAdminUserId: true, controllerUserId: true, glAccountingProfileId: true },
  });
  if (!fs.existsSync(SAVE_FILE)) {
    fs.mkdirSync(SAVE_DIR, { recursive: true });
    fs.writeFileSync(SAVE_FILE, JSON.stringify({
      savedAt: new Date().toISOString(),
      clubId: COULEE,
      priorConfig,
    }, null, 2));
    console.log(`  + Saved prior config to ${SAVE_FILE}`);
  } else {
    console.log(`  = Save file already exists at ${SAVE_FILE}`);
  }

  // GL accounts + profile.
  const accts = await ensureAccounts();
  let profile = await prisma.payrollGlAccountingProfile.findFirst({
    where: { clubId: COULEE },
    select: { id: true },
  });
  if (!profile) {
    profile = await prisma.payrollGlAccountingProfile.create({
      data: {
        clubId: COULEE,
        salaryExpenseAccountId:       accts["5100"],
        employerCppExpenseAccountId:  accts["5110"],
        employerEiExpenseAccountId:   accts["5120"],
        netPayPayableAccountId:       accts["2100"],
        cppPayableAccountId:          accts["2110"],
        eiPayableAccountId:           accts["2120"],
        federalTaxPayableAccountId:   accts["2130"],
        provincialTaxPayableAccountId:accts["2140"],
      },
      select: { id: true },
    });
    console.log(`  + Created PayrollGlAccountingProfile: ${profile.id}`);
  } else {
    // Ensure all 8 fields point at the fixture accounts.
    await prisma.payrollGlAccountingProfile.update({
      where: { id: profile.id },
      data: {
        salaryExpenseAccountId:       accts["5100"],
        employerCppExpenseAccountId:  accts["5110"],
        employerEiExpenseAccountId:   accts["5120"],
        netPayPayableAccountId:       accts["2100"],
        cppPayableAccountId:          accts["2110"],
        eiPayableAccountId:           accts["2120"],
        federalTaxPayableAccountId:   accts["2130"],
        provincialTaxPayableAccountId:accts["2140"],
      },
    });
    console.log(`  = PayrollGlAccountingProfile exists ${profile.id} (fields normalised)`);
  }

  await prisma.payrollClubConfig.update({
    where: { clubId: COULEE },
    data: {
      payrollAdminUserId: paId,
      controllerUserId: ctrlId,
      glAccountingProfileId: profile.id,
    },
  });
  console.log(`  ~ Repointed PayrollClubConfig: PA=${paId}, Ctrl=${ctrlId}, GL profile=${profile.id}`);

  await ensureFiscalPeriod();

  console.log(`\n== Summary ==`);
  console.log(`  Payroll Admin (submitter): ${paId} (${PA_EMAIL})`);
  console.log(`  Controller (approver):     ${ctrlId} (${CTRL_EMAIL})`);
  console.log(`  Poster (CLUB_ADMIN):       ${posterId} (${POSTER_EMAIL})`);
  console.log(`  Passwords: spectre-3e-fixture`);
  console.log(`\nRestore after acceptance: node ${process.argv[1].split(/[\\/]/).pop()} --restore`);
}

async function restore() {
  console.log(`\n== Payroll 3F acceptance fixture RESTORE @ ${new Date().toISOString()} ==`);
  if (!fs.existsSync(SAVE_FILE)) {
    console.error(`  ! No save file at ${SAVE_FILE}. Nothing to restore.`);
    process.exitCode = 2;
    return;
  }
  const saved = JSON.parse(fs.readFileSync(SAVE_FILE, "utf8"));
  if (saved.clubId !== COULEE) {
    console.error(`  ! Save file targets clubId ${saved.clubId}, not Coulee. Refusing.`);
    process.exitCode = 2;
    return;
  }
  await prisma.payrollClubConfig.update({
    where: { clubId: COULEE },
    data: {
      payrollAdminUserId: saved.priorConfig?.payrollAdminUserId ?? null,
      controllerUserId:   saved.priorConfig?.controllerUserId ?? null,
      glAccountingProfileId: saved.priorConfig?.glAccountingProfileId ?? null,
    },
  });
  console.log(`  ~ Restored PayrollClubConfig for Coulee`);
  console.log(`      payrollAdminUserId:    ${saved.priorConfig?.payrollAdminUserId ?? "(null)"}`);
  console.log(`      controllerUserId:      ${saved.priorConfig?.controllerUserId ?? "(null)"}`);
  console.log(`      glAccountingProfileId: ${saved.priorConfig?.glAccountingProfileId ?? "(null)"}`);
}

async function main() {
  const mode = process.argv.includes("--restore") ? "restore" : "setup";
  if (mode === "restore") await restore();
  else await setup();
}

main().then(() => process.exit(process.exitCode ?? 0)).catch((e) => { console.error(e); process.exit(1); });
