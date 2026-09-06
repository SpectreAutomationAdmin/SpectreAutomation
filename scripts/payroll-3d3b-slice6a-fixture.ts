// Payroll-3D-3B Slice 6A (2026-09-06) — local browser-acceptance
// fixture. Seeds a fresh synthetic tenant with:
//   * Events + Grounds departments
//   * Events Manager, Grounds Manager, Tenant Admin (each a login-able User)
//   * Taylor employee (Grounds primary, Events secondary — the founder's
//     canonical routing case)
//   * PayrollPayGroup + open PayrollPayPeriod
//   * A materialized timesheet + a PENDING correction so the manager
//     Mission Control shows a correction review card + a blocked scope
//     card (blocked by the pending correction)
//
// LOCAL ONLY. Does NOT touch Coulee Ridge staging. Does NOT touch Chris
// Turcato or Lise Montsion. Idempotent — re-runs wipe the fixture tenant
// first (by well-known slug prefix) before re-seeding.
//
// Usage:
//   npm run db:reset          # first time only (rebuilds SQLite schema)
//   tsx scripts/payroll-3d3b-slice6a-fixture.ts

import { loadEnvFiles } from "./_lib/load-env";
loadEnvFiles();

import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { PERMISSIONS, ROLES, ROLE_PERMISSIONS } from "../src/lib/permissions";

const prisma = new PrismaClient();
const TENANT_SLUG = "slice6a-events-mgr";
const TENANT_NAME = "Slice 6A Test Club";
const PASSWORD = "password";

const EVENTS_MGR_EMAIL   = "slice6a.events.mgr@spectre.test";
const GROUNDS_MGR_EMAIL  = "slice6a.grounds.mgr@spectre.test";
const TENANT_ADMIN_EMAIL = "slice6a.admin@spectre.test";

async function seedRbacIfMissing() {
  for (const [key, def] of Object.entries(PERMISSIONS)) {
    await prisma.permission.upsert({
      where: { key }, update: {},
      create: { key, name: def.name, category: def.category },
    });
  }
  for (const [key, def] of Object.entries(ROLES)) {
    await prisma.role.upsert({
      where: { key }, update: {},
      create: { key, name: def.name, description: def.description, isSystem: true },
    });
  }
  for (const [roleKey, grants] of Object.entries(ROLE_PERMISSIONS) as [string, string[]][]) {
    for (const permissionKey of grants) {
      await prisma.rolePermission.upsert({
        where: { roleKey_permissionKey: { roleKey, permissionKey } },
        update: {},
        create: { roleKey, permissionKey },
      });
    }
  }
  await prisma.responsibility.upsert({
    where: { key: "TENANT_ADMINISTRATION" },
    update: {},
    create: {
      key: "TENANT_ADMINISTRATION", displayLabel: "Tenant Administrator",
      scopeKind: "CLUB", cardinality: "PRIMARY_AND_BACKUPS",
      description: "Tenant Administration authority.", isSpectreDefined: true,
    },
  });
  await prisma.responsibility.upsert({
    where: { key: "DEPARTMENT_TIME_APPROVAL" },
    update: {},
    create: {
      key: "DEPARTMENT_TIME_APPROVAL", displayLabel: "Timesheet Approver",
      scopeKind: "DEPARTMENT", cardinality: "SINGLE_PRIMARY",
      description: "Reviews and approves recorded time.", isSpectreDefined: true,
    },
  });
}

async function wipeExistingFixture() {
  const club = await prisma.club.findFirst({ where: { slug: TENANT_SLUG } });
  if (!club) return;
  console.log(`[slice6a-fixture] wiping existing tenant ${club.id}...`);
  // FK-safe teardown for the fixture. Only wipe rows under this club.
  await prisma.workIntakeActivity.deleteMany({
    where: { workIntakeItem: { clubId: club.id } },
  });
  await prisma.workIntakeOrigin.deleteMany({ where: { clubId: club.id } });
  await prisma.workCompletionEvent.deleteMany({ where: { clubId: club.id } });
  await prisma.workIntakeItem.deleteMany({ where: { clubId: club.id } });
  await prisma.backgroundJob.deleteMany({ where: { clubId: club.id } });
  await prisma.payrollTimesheetEntryClockEvent.deleteMany({
    where: { timesheetEntry: { clubId: club.id } },
  });
  await prisma.payrollTimesheetEntry.deleteMany({ where: { clubId: club.id } });
  await prisma.payrollTimesheet.deleteMany({ where: { clubId: club.id } });
  await prisma.timeClockCorrectionRequest.deleteMany({ where: { clubId: club.id } });
  await prisma.timeClockEvent.deleteMany({ where: { clubId: club.id } });
  await prisma.payrollPayGroupMember.deleteMany({ where: { clubId: club.id } });
  await prisma.payrollPayPeriod.deleteMany({ where: { clubId: club.id } });
  await prisma.payrollPayGroup.deleteMany({ where: { clubId: club.id } });
  await prisma.employeeEmploymentAssignment.deleteMany({ where: { clubId: club.id } });
  await prisma.employee.deleteMany({ where: { clubId: club.id } });
  await prisma.departmentResponsibility.deleteMany({ where: { clubId: club.id } });
  await prisma.department.deleteMany({ where: { clubId: club.id } });
  await prisma.responsibilityAssignment.deleteMany({ where: { clubId: club.id } });
  await prisma.userClubRole.deleteMany({ where: { clubId: club.id } });
  await prisma.club.delete({ where: { id: club.id } });
  // Wipe the 3 test users by email (they belong to this club only).
  await prisma.user.deleteMany({
    where: { email: { in: [EVENTS_MGR_EMAIL, GROUNDS_MGR_EMAIL, TENANT_ADMIN_EMAIL] } },
  });
}

async function seed() {
  const utcAt = (y: number, m: number, d: number, h = 0, mi = 0) =>
    new Date(Date.UTC(y, m - 1, d, h, mi));
  const passwordHash = await bcrypt.hash(PASSWORD, 4);

  const club = await prisma.club.create({
    data: {
      name: TENANT_NAME, slug: TENANT_SLUG, region: "AB",
      salesTaxRegion: "GST", foundedYear: 2020,
    },
  });

  // Departments.
  const events = await prisma.department.create({
    data: { clubId: club.id, code: "EVENTS", name: "Events", isActive: true },
  });
  const grounds = await prisma.department.create({
    data: { clubId: club.id, code: "GROUNDS", name: "Course & Grounds", isActive: true },
  });

  // Users.
  const eventsMgr = await prisma.user.create({
    data: {
      email: EVENTS_MGR_EMAIL, name: "Events Manager", role: "DEPARTMENT_MANAGER",
      passwordHash, clubId: club.id, status: "ACTIVE",
    },
  });
  await prisma.userClubRole.create({
    data: { userId: eventsMgr.id, clubId: club.id, roleKey: "DEPARTMENT_MANAGER" },
  });
  const groundsMgr = await prisma.user.create({
    data: {
      email: GROUNDS_MGR_EMAIL, name: "Grounds Manager", role: "DEPARTMENT_MANAGER",
      passwordHash, clubId: club.id, status: "ACTIVE",
    },
  });
  await prisma.userClubRole.create({
    data: { userId: groundsMgr.id, clubId: club.id, roleKey: "DEPARTMENT_MANAGER" },
  });
  const admin = await prisma.user.create({
    data: {
      email: TENANT_ADMIN_EMAIL, name: "Tenant Administrator", role: "CLUB_ADMIN",
      passwordHash, clubId: club.id, status: "ACTIVE",
    },
  });
  await prisma.userClubRole.create({
    data: { userId: admin.id, clubId: club.id, roleKey: "CLUB_ADMIN" },
  });
  await prisma.responsibilityAssignment.create({
    data: {
      clubId: club.id, userId: admin.id,
      responsibilityKey: "TENANT_ADMINISTRATION", role: "PRIMARY",
      effectiveFrom: new Date(),
    },
  });

  // Approver responsibilities.
  await prisma.departmentResponsibility.create({
    data: {
      clubId: club.id, departmentId: events.id, userId: eventsMgr.id,
      responsibilityKey: "DEPARTMENT_TIME_APPROVAL",
    },
  });
  await prisma.departmentResponsibility.create({
    data: {
      clubId: club.id, departmentId: grounds.id, userId: groundsMgr.id,
      responsibilityKey: "DEPARTMENT_TIME_APPROVAL",
    },
  });

  // Employee — Taylor. Primary=Grounds, Secondary=Events per founder brief.
  const taylor = await prisma.employee.create({
    data: {
      clubId: club.id, firstName: "Taylor", lastName: "Fixture",
      email: "taylor.slice6a@spectre.test",
      hireDate: utcAt(2026, 1, 1), status: "ACTIVE", employeeLifecycle: "ACTIVE",
      employeeNumber: "SLICE6A-01", compensationType: "HOURLY",
      homeProvince: "AB", timekeepingMethod: "CLOCK_REQUIRED",
    },
  });
  await prisma.employeeEmploymentAssignment.create({
    data: {
      clubId: club.id, employeeId: taylor.id, role: "PRIMARY",
      employmentType: "PART_TIME", effectiveFrom: utcAt(2026, 1, 1),
      departmentId: grounds.id,
    },
  });
  const eventsAssn = await prisma.employeeEmploymentAssignment.create({
    data: {
      clubId: club.id, employeeId: taylor.id, role: "ADDITIONAL",
      employmentType: "PART_TIME", effectiveFrom: utcAt(2026, 1, 1),
      departmentId: events.id,
    },
  });

  // Pay group + open pay period + membership.
  const pg = await prisma.payrollPayGroup.create({
    data: {
      clubId: club.id, code: "PG-SLICE6A", name: "Slice 6A Semi-Monthly",
      payFrequency: "SEMI_MONTHLY", payDateOffsetDays: 5,
      calendarAnchorDate: utcAt(2026, 1, 1), active: true,
    },
  });
  const period = await prisma.payrollPayPeriod.create({
    data: {
      clubId: club.id, payGroupId: pg.id, taxYear: 2026, sequenceInYear: 17,
      periodStart: utcAt(2026, 9, 1), periodEnd: utcAt(2026, 9, 16),
      payDate: utcAt(2026, 9, 20), status: "OPEN",
    },
  });
  await prisma.payrollPayGroupMember.create({
    data: {
      clubId: club.id, payGroupId: pg.id, employeeId: taylor.id,
      effectiveFrom: utcAt(2020, 1, 1),
    },
  });

  // Clock events — Taylor worked ONE clean Events shift.
  const clockIn = await prisma.timeClockEvent.create({
    data: {
      clubId: club.id, employeeId: taylor.id, kind: "CLOCK_IN",
      occurredAt: utcAt(2026, 9, 5, 14, 0),
      source: "EMPLOYEE_PORTAL",
      employmentAssignmentId: eventsAssn.id,
    },
  });
  await prisma.timeClockEvent.create({
    data: {
      clubId: club.id, employeeId: taylor.id, kind: "CLOCK_OUT",
      occurredAt: utcAt(2026, 9, 5, 22, 0),
      source: "EMPLOYEE_PORTAL",
      employmentAssignmentId: eventsAssn.id,
    },
  });

  // Materialize + submit a PENDING correction so the manager sees both
  // a correction review card AND a blocked scope card.
  const { materializeEmployeeTimesheet } = await import("../src/lib/timesheets/service");
  const { submitCorrectionRequest } = await import("../src/lib/timesheets/correction-service");
  await materializeEmployeeTimesheet(club.id, taylor.id, period.id);
  await submitCorrectionRequest(
    { clubId: club.id, employeeId: taylor.id, generation: 1, establishedAt: new Date().toISOString() },
    {
      requestType: "CORRECT_CLOCK_IN", originalClockEventId: clockIn.id,
      requestedLocalIso: "2026-09-05T14:15",
      reason: "Rounded to top of the hour by mistake.",
      employmentAssignmentId: eventsAssn.id,
    },
  );

  console.log(`[slice6a-fixture] SEEDED`);
  console.log(`  clubId:           ${club.id}`);
  console.log(`  Events Manager:   ${EVENTS_MGR_EMAIL} / ${PASSWORD}`);
  console.log(`  Grounds Manager:  ${GROUNDS_MGR_EMAIL} / ${PASSWORD}`);
  console.log(`  Tenant Admin:     ${TENANT_ADMIN_EMAIL} / ${PASSWORD}`);
  console.log(`  Taylor employee:  ${taylor.id}`);
  console.log(`  Pay period:       ${period.id}`);
  console.log(`  Correction card + blocked-scope card wait for Events Manager.`);
}

async function main() {
  await seedRbacIfMissing();
  await wipeExistingFixture();
  await seed();
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
