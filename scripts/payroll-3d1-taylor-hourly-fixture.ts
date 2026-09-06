// Payroll-3D-1 (2026-09-05) — Taylor Hourly synthetic fixture.
//
// Creates (or reuses) a synthetic Coulee Ridge employee configured
// with `timekeepingMethod: CLOCK_REQUIRED` so the founder can drive
// the /employee/time flow end-to-end without touching real payroll
// data. All fields synthetic — no real employee PII.
//
// Also resets any open clock state (no open session, no open break)
// so acceptance runs deterministically.
//
// Reuses the accepted preview password `TA1C-Preview-99` and the
// Coulee Ridge personalEmail convention `<slug>@preview.spectre.test`.
//
// Idempotent. Emits a single JSON line with employee id + credentials.

import { loadEnvFiles } from "./_lib/load-env";
loadEnvFiles();

import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

const EMAIL = "taylor.hourly@preview.spectre.test";
const PASSWORD = "TA1C-Preview-99";
const HIRE_DATE = new Date("2026-04-01T00:00:00.000Z");

async function main() {
  const club = await prisma.club.findFirstOrThrow({ where: { slug: "coulee-ridge" } });

  // Ensure User + Employee.
  const hash = await bcrypt.hash(PASSWORD, 8);
  let user = await prisma.user.findFirst({ where: { email: EMAIL } });
  if (!user) {
    user = await prisma.user.create({
      data: {
        email: EMAIL, name: "Taylor Hourly",
        role: "STAFF", status: "ACTIVE", clubId: club.id,
        passwordHash: hash,
      },
    });
  }

  let emp = await prisma.employee.findFirst({ where: { clubId: club.id, email: EMAIL } });
  if (!emp) {
    emp = await prisma.employee.create({
      data: {
        clubId: club.id,
        firstName: "Taylor", lastName: "Hourly",
        email: EMAIL, personalEmail: EMAIL,
        hireDate: HIRE_DATE,
        dateOfBirth: new Date("1990-05-15T00:00:00.000Z"),
        status: "ACTIVE",
        employeeNumber: "E-TAYLOR-HOURLY",
        employeeLifecycle: "ACTIVE",
        compensationType: "HOURLY",
        homeProvince: "AB",
        userId: user.id,
        // Payroll-3D-1 — CLOCK_REQUIRED (the ONLY non-default synthetic
        // employee; every other preview employee stays on the safe
        // NO_TIME_ENTRY_REQUIRED default).
        timekeepingMethod: "CLOCK_REQUIRED",
      },
    });
    const assn = await prisma.employeeEmploymentAssignment.create({
      data: {
        clubId: club.id, employeeId: emp.id, role: "PRIMARY",
        employmentType: "PART_TIME", effectiveFrom: HIRE_DATE,
      },
    });
    await prisma.employeeCompensation.create({
      data: {
        clubId: club.id, employeeId: emp.id, assignmentId: assn.id,
        cadence: "HOURLY", rate: "22.50", currency: "CAD",
        effectiveFrom: HIRE_DATE,
      },
    });
  } else {
    if (
      emp.timekeepingMethod !== "CLOCK_REQUIRED" ||
      emp.personalEmail !== EMAIL ||
      emp.status !== "ACTIVE" ||
      emp.employeeLifecycle !== "ACTIVE"
    ) {
      await prisma.employee.update({
        where: { id: emp.id },
        data: {
          timekeepingMethod: "CLOCK_REQUIRED",
          personalEmail: EMAIL,
          status: "ACTIVE",
          employeeLifecycle: "ACTIVE",
        },
      });
    }
  }
  // Payroll-3D-2 — ensure pay-group membership so the timesheet
  // page can resolve a current pay period. Reuses the basic SAL-SM
  // preview group (semi-monthly, has 2026 calendar seeded).
  const pg = await prisma.payrollPayGroup.findFirst({
    where: { clubId: club.id, code: "SAL-SM" },
  });
  if (pg) {
    const membership = await prisma.payrollPayGroupMember.findFirst({
      where: { clubId: club.id, payGroupId: pg.id, employeeId: emp.id },
    });
    if (!membership) {
      await prisma.payrollPayGroupMember.create({
        data: {
          clubId: club.id, payGroupId: pg.id, employeeId: emp.id,
          effectiveFrom: HIRE_DATE,
        },
      });
    }
  }

  // Portal credential — required for /employee/login.
  const cred = await prisma.employeePortalCredential.findUnique({ where: { employeeId: emp.id } });
  if (!cred) {
    await prisma.employeePortalCredential.create({
      data: {
        clubId: club.id, employeeId: emp.id,
        passwordHash: hash, passwordUpdatedAt: new Date(),
      },
    });
  } else {
    await prisma.employeePortalCredential.update({
      where: { employeeId: emp.id },
      data: { passwordHash: hash, failedAttemptCount: 0, lockedUntil: null },
    });
  }

  // Reset any open clock state — wipe all Taylor Hourly clock events
  // + derived 3D-2 timesheets + correction requests so acceptance
  // starts from OFF_CLOCK. Historical events are NOT preserved for
  // this synthetic fixture (this is a test employee, not a real
  // user); production behaviour never destructively rewrites events
  // (3D-1 §9). Also resets the timekeepingStateVersion so the CAS
  // counter starts from 0.
  //
  // FK-safe order: provenance → timesheet entries → timesheet
  //                → correction requests → clock events.
  const timesheets = await prisma.payrollTimesheet.findMany({
    where: { clubId: club.id, employeeId: emp.id }, select: { id: true },
  });
  if (timesheets.length) {
    const timesheetIds = timesheets.map((t) => t.id);
    const entries = await prisma.payrollTimesheetEntry.findMany({
      where: { timesheetId: { in: timesheetIds } }, select: { id: true },
    });
    if (entries.length) {
      await prisma.payrollTimesheetEntryClockEvent.deleteMany({
        where: { timesheetEntryId: { in: entries.map((e) => e.id) } },
      });
      await prisma.payrollTimesheetEntry.deleteMany({ where: { id: { in: entries.map((e) => e.id) } } });
    }
    await prisma.payrollTimesheet.deleteMany({ where: { id: { in: timesheetIds } } });
  }
  await prisma.timeClockCorrectionRequest.deleteMany({
    where: { clubId: club.id, employeeId: emp.id },
  });
  const deleted = await prisma.timeClockEvent.deleteMany({
    where: { clubId: club.id, employeeId: emp.id },
  });
  await prisma.employee.update({
    where: { id: emp.id }, data: { timekeepingStateVersion: 0 },
  });

  // eslint-disable-next-line no-console
  console.log(JSON.stringify({
    clubId: club.id,
    employeeId: emp.id,
    email: EMAIL,
    password: PASSWORD,
    hireDateIso: HIRE_DATE.toISOString(),
    timekeepingMethod: "CLOCK_REQUIRED",
    wipedClockEvents: deleted.count,
    loginUrl: "http://localhost:3000/employee/login",
    timeClockUrl: "http://localhost:3000/employee/time",
  }));
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
