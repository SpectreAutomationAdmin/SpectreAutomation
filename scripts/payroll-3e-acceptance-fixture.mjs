// Payroll Admin Slice 3E acceptance (2026-09-12) — synthetic
// Controller + Payroll Admin actors + PayrollClubConfig wiring for
// staging Submit/Approve/Return lifecycle acceptance.
//
// Adds:
//   1. Synthetic Payroll Admin user  fixture.payroll-admin.3e@spectre.test
//      with role PAYROLL_ADMIN at Coulee.
//   2. Synthetic Controller user     fixture.controller.3e@spectre.test
//      with role CONTROLLER at Coulee.
//   3. PayrollClubConfig for Coulee — points payrollAdminUserId +
//      controllerUserId at the two fixture users so the Submit +
//      Return orchestration knows where to route Work Intake cards.
//
// The 3D acceptance batch (3D-ACCEPT pay group / Nov 8 – Nov 21) is
// reused by 3E. It already reaches CALCULATED with Sam Salary
// ($2,000 gross · $1,592.52 net) after the 3D salary hotfix.
//
// Idempotent. Never touches real users or real HR data.

import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

const COULEE      = "cmrvdeny7000144372ktmmg9c";
const PA_EMAIL    = "fixture.payroll-admin.3e@spectre.test";
const CTRL_EMAIL  = "fixture.controller.3e@spectre.test";
const PASSWORD_HASH = "$2b$12$K0.7pWM9OKvJTG8kSwF/CuI2xY8ZQqiBRTFcXFHmpXPn7GtVJa7A6"; // "spectre-3e-fixture" bcrypted

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

async function main() {
  console.log(`\n== Payroll 3E acceptance fixture @ ${new Date().toISOString()} ==`);
  const payrollAdminId = await ensureUserWithRole(PA_EMAIL, "Payroll Admin (3E)", "PAYROLL_ADMIN");
  const controllerId   = await ensureUserWithRole(CTRL_EMAIL, "Controller (3E)", "CONTROLLER");

  // Wire PayrollClubConfig — payrollAdminUserId + controllerUserId.
  const existing = await prisma.payrollClubConfig.findUnique({
    where: { clubId: COULEE },
    select: { payrollAdminUserId: true, controllerUserId: true },
  });
  const desiredPa = payrollAdminId;
  const desiredCtrl = controllerId;
  if (!existing) {
    await prisma.payrollClubConfig.create({
      data: {
        clubId: COULEE, provinceOfEmployment: "AB",
        payrollAdminUserId: desiredPa, controllerUserId: desiredCtrl,
      },
    });
    console.log(`  + Created PayrollClubConfig for Coulee (payrollAdmin=${desiredPa}, controller=${desiredCtrl})`);
  } else if (existing.payrollAdminUserId !== desiredPa || existing.controllerUserId !== desiredCtrl) {
    await prisma.payrollClubConfig.update({
      where: { clubId: COULEE },
      data: { payrollAdminUserId: desiredPa, controllerUserId: desiredCtrl },
    });
    console.log(`  ~ Repointed PayrollClubConfig to 3E fixture actors`);
  } else {
    console.log(`  = PayrollClubConfig already points at 3E fixture actors`);
  }

  console.log(`\n== Summary ==`);
  console.log(`  Payroll Admin: ${payrollAdminId} (${PA_EMAIL})`);
  console.log(`  Controller:    ${controllerId} (${CTRL_EMAIL})`);
  console.log(`  Coulee 3D-ACCEPT batch continues to serve as the acceptance batch.`);
  console.log(`  Password for both fixture users: spectre-3e-fixture`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
