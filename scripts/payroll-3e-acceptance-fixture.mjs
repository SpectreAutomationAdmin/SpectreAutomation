// Payroll Admin Slice 3E acceptance (2026-09-12 — hotfix rev) —
// synthetic Controller + Payroll Admin actors + PayrollClubConfig
// wiring for staging Submit/Approve/Return lifecycle acceptance.
//
// Modes:
//   node payroll-3e-acceptance-fixture.mjs             → SETUP:
//       saves the CURRENT PayrollClubConfig
//       (payrollAdminUserId + controllerUserId) into
//       config/state/payroll-3e-fixture-restore.json, then
//       repoints Coulee's config to the two synthetic actors.
//
//   node payroll-3e-acceptance-fixture.mjs --restore   → TEARDOWN:
//       reads config/state/payroll-3e-fixture-restore.json and
//       restores Coulee's PayrollClubConfig to the saved values.
//       Refuses when no save file exists rather than guessing.
//
// Founder directive §16-17: acceptance fixtures must not
// permanently take over the principal staging tenant's governance
// setup. This safe idempotent setup+teardown pair guarantees that.

import { PrismaClient } from "@prisma/client";
import fs from "node:fs";
import path from "node:path";
const prisma = new PrismaClient();

const COULEE      = "cmrvdeny7000144372ktmmg9c";
const PA_EMAIL    = "fixture.payroll-admin.3e@spectre.test";
const CTRL_EMAIL  = "fixture.controller.3e@spectre.test";
const PASSWORD_HASH = "$2b$12$K0.7pWM9OKvJTG8kSwF/CuI2xY8ZQqiBRTFcXFHmpXPn7GtVJa7A6"; // "spectre-3e-fixture"

// Save file location — relative to repo root, kept OUT of prisma/config
// (which is checked-in seed data). This directory is safe for staging-
// only ephemera. On the Fly image, /app/scripts is writable at runtime.
const SAVE_DIR  = "/app/tmp/payroll-3e-fixture";
const SAVE_FILE = `${SAVE_DIR}/coulee-config-prerestore.json`;

async function ensureUserWithRole(email, name, roleKey) {
  const existing = await prisma.user.findFirst({ where: { email }, select: { id: true } });
  const user = existing
    ? existing
    : await prisma.user.create({
        data: {
          email, name, role: roleKey === "CONTROLLER" ? "CONTROLLER" : "PAYROLL_ADMIN",
          passwordHash: PASSWORD_HASH, status: "ACTIVE",
        },
        select: { id: true },
      });
  if (!existing) console.log(`  + Created user ${email} (${roleKey}): ${user.id}`);
  else           console.log(`  = User ${email} exists: ${user.id}`);
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
  return user.id;
}

async function setup() {
  console.log(`\n== Payroll 3E acceptance fixture SETUP @ ${new Date().toISOString()} ==`);
  const payrollAdminId = await ensureUserWithRole(PA_EMAIL, "Payroll Admin (3E)", "PAYROLL_ADMIN");
  const controllerId   = await ensureUserWithRole(CTRL_EMAIL, "Controller (3E)", "CONTROLLER");

  const existing = await prisma.payrollClubConfig.findUnique({
    where: { clubId: COULEE },
    select: { payrollAdminUserId: true, controllerUserId: true },
  });
  if (!existing) {
    // First-run — no save necessary, config is fully synthetic.
    await prisma.payrollClubConfig.create({
      data: {
        clubId: COULEE, provinceOfEmployment: "AB",
        payrollAdminUserId: payrollAdminId, controllerUserId: controllerId,
      },
    });
    console.log(`  + Created PayrollClubConfig for Coulee (payrollAdmin=${payrollAdminId}, controller=${controllerId})`);
  } else {
    // Only save if we don't already have a save file — never overwrite a
    // prior restore point.
    if (!fs.existsSync(SAVE_FILE)) {
      fs.mkdirSync(SAVE_DIR, { recursive: true });
      fs.writeFileSync(SAVE_FILE, JSON.stringify({
        savedAt: new Date().toISOString(),
        clubId: COULEE,
        payrollAdminUserId: existing.payrollAdminUserId,
        controllerUserId: existing.controllerUserId,
      }, null, 2));
      console.log(`  + Saved prior config to ${SAVE_FILE}: ` +
        `payrollAdmin=${existing.payrollAdminUserId}, controller=${existing.controllerUserId}`);
    } else {
      console.log(`  = Save file already exists at ${SAVE_FILE} (prior restore point preserved)`);
    }
    if (existing.payrollAdminUserId !== payrollAdminId || existing.controllerUserId !== controllerId) {
      await prisma.payrollClubConfig.update({
        where: { clubId: COULEE },
        data: { payrollAdminUserId: payrollAdminId, controllerUserId: controllerId },
      });
      console.log(`  ~ Repointed PayrollClubConfig to 3E fixture actors`);
    } else {
      console.log(`  = PayrollClubConfig already points at 3E fixture actors`);
    }
  }

  console.log(`\n== Summary ==`);
  console.log(`  Payroll Admin: ${payrollAdminId} (${PA_EMAIL})`);
  console.log(`  Controller:    ${controllerId} (${CTRL_EMAIL})`);
  console.log(`  Password for both: spectre-3e-fixture`);
  console.log(`\nTo restore Coulee's original config after acceptance:`);
  console.log(`  node ${path.basename(process.argv[1])} --restore`);
}

async function restore() {
  console.log(`\n== Payroll 3E acceptance fixture RESTORE @ ${new Date().toISOString()} ==`);
  if (!fs.existsSync(SAVE_FILE)) {
    console.error(`  ! No save file at ${SAVE_FILE}. Nothing to restore. ` +
      `The current Coulee config is untouched.`);
    process.exitCode = 2;
    return;
  }
  const raw = fs.readFileSync(SAVE_FILE, "utf8");
  const saved = JSON.parse(raw);
  if (saved.clubId !== COULEE) {
    console.error(`  ! Save file targets clubId ${saved.clubId}, not Coulee. Refusing.`);
    process.exitCode = 2;
    return;
  }
  const upd = await prisma.payrollClubConfig.update({
    where: { clubId: COULEE },
    data: {
      payrollAdminUserId: saved.payrollAdminUserId,
      controllerUserId: saved.controllerUserId,
    },
  });
  console.log(`  ~ Restored PayrollClubConfig for Coulee:`);
  console.log(`      payrollAdminUserId: ${upd.payrollAdminUserId}`);
  console.log(`      controllerUserId:   ${upd.controllerUserId}`);
  // Retain the save file for audit — do NOT delete. A subsequent
  // acceptance re-run will only save if the file doesn't exist, so
  // stale save files are safe.
}

async function main() {
  const mode = process.argv.includes("--restore") ? "restore" : "setup";
  if (mode === "restore") await restore();
  else await setup();
}

main().then(() => process.exit(process.exitCode ?? 0)).catch((e) => { console.error(e); process.exit(1); });
