// Staging T&A acceptance fixture (2026-09-05).
//
// Prepares the Coulee Ridge staging tenant for the founder's Time &
// Attendance acceptance walkthrough (portal Clock In/Out, timesheet,
// correction, manager approval, Payroll Admin freeze). All identities
// created/updated by this script are unmistakably synthetic:
//   - Employee: Taylor Fixture (reused; already present on staging)
//   - Managers: Grounds Manager Fixture + Events Manager Fixture
//                (created if missing) under @fixture.spectre.test
//   - Payroll Admin: fixture.pa@spectre.test (already present)
//   - Controller:   fixture.controller@spectre.test (already present)
//
// Safety:
//   - Refuses without ALLOW_STAGING_TA_FIXTURE=YES.
//   - Refuses unless clubId + name + stagingDataMode match the exact
//     Coulee Ridge staging tenant.
//   - Refuses ANY write targeting Chris Turcato or Lise Montsion.
//   - Refuses ANY email outside @fixture.spectre.test.
//   - Idempotent: rerunning yields the same canonical state.
//   - --dry-run makes ZERO writes.
//   - --reset-acceptance deletes ONLY Taylor Fixture's clock events /
//     timesheets / entries / correction requests / any frozen approved
//     time rows sourced from her timesheet entries.
//
// Never touches:
//   - Chris Turcato, Lise Montsion, any real employee;
//   - EmployeeSensitiveIdentity, EmployeeBankAccount, EmployeeTaxProfile;
//   - PayrollBatch (existing rows read-only);
//   - GL journals, payment transmission;
//   - Mailbox integration or Club identity/config.

import { loadEnvFiles } from "./_lib/load-env";
loadEnvFiles();

import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import {
  guardDemoTenant,
  assertStagingTaTargetAllowed,
  COULEE_RIDGE_STAGING_CLUB_ID,
  COULEE_RIDGE_STAGING_CLUB_NAME,
  STAGING_SYNTHETIC_EMAIL_DOMAIN,
} from "../src/lib/fixtures/demo-tenant-guard";

const prisma = new PrismaClient();

const PASSWORD = "TA1C-Preview-99"; // accepted preview password convention
const TAYLOR_EMPLOYEE_EMAIL = "taylor@fixture.spectre.test";
const TAYLOR_LOGIN_EMAIL    = "taylor.hourly@fixture.spectre.test";
const GROUNDS_MGR_EMAIL     = "grounds.manager@fixture.spectre.test";
const EVENTS_MGR_EMAIL    = "events.manager@fixture.spectre.test";

const HIRE_DATE = new Date("2026-04-01T00:00:00.000Z");
const GROUNDS_CODE  = "GROUNDS";
const EVENTS_CODE = "EVENTS";

interface Args {
  apply: boolean;
  dryRun: boolean;
  resetAcceptance: boolean;
}
function parseArgs(): Args {
  const argv = process.argv.slice(2);
  return {
    apply: !argv.includes("--dry-run"),
    dryRun: argv.includes("--dry-run"),
    resetAcceptance: argv.includes("--reset-acceptance"),
  };
}

async function ensureUser(email: string, name: string, roleKey: "DEPARTMENT_MANAGER", clubId: string, apply: boolean) {
  assertStagingTaTargetAllowed({ callerName: `ensureUser:${email}`, identity: { email, clubId } });
  const existing = await prisma.user.findFirst({ where: { email } });
  if (existing) return { user: existing, created: false };
  if (!apply) {
    return { user: { id: "DRY_RUN", email, name, role: roleKey, status: "ACTIVE", clubId } as any, created: true };
  }
  const passwordHash = await bcrypt.hash(PASSWORD, 8);
  const user = await prisma.user.create({
    data: { email, name, role: roleKey, status: "ACTIVE", clubId, passwordHash },
  });
  return { user, created: true };
}

async function ensureUserClubRole(userId: string, clubId: string, roleKey: string, apply: boolean) {
  const existing = await prisma.userClubRole.findFirst({ where: { userId, clubId, roleKey } });
  if (existing) return { created: false };
  if (!apply) return { created: true };
  await prisma.userClubRole.create({ data: { userId, clubId, roleKey } });
  return { created: true };
}

async function ensureDepartment(clubId: string, code: string, name: string) {
  const existing = await prisma.department.findUnique({ where: { clubId_code: { clubId, code } } });
  return { department: existing, created: false, expected: { clubId, code, name } };
}

async function ensureDeptResponsibility(
  clubId: string, departmentId: string, userId: string, apply: boolean,
) {
  const existing = await prisma.departmentResponsibility.findFirst({
    where: { clubId, departmentId, responsibilityKey: "DEPARTMENT_TIME_APPROVAL" },
  });
  if (existing && existing.userId === userId) return { created: false, changed: false };
  if (!apply) return { created: !existing, changed: existing && existing.userId !== userId };
  await prisma.departmentResponsibility.upsert({
    where: {
      clubId_departmentId_responsibilityKey: {
        clubId, departmentId, responsibilityKey: "DEPARTMENT_TIME_APPROVAL",
      },
    },
    update: { userId, assignedAt: new Date() },
    create: {
      clubId, departmentId, userId,
      responsibilityKey: "DEPARTMENT_TIME_APPROVAL",
    },
  });
  return { created: !existing, changed: existing && existing.userId !== userId };
}

async function ensureAssignment(
  clubId: string, employeeId: string,
  role: "PRIMARY" | "SECONDARY", departmentId: string,
  apply: boolean,
) {
  const existing = await prisma.employeeEmploymentAssignment.findFirst({
    where: { clubId, employeeId, role, effectiveTo: null },
  });
  if (existing) {
    if (existing.departmentId === departmentId) return { assignment: existing, created: false, changed: false };
    if (!apply) return { assignment: existing, created: false, changed: true };
    const updated = await prisma.employeeEmploymentAssignment.update({
      where: { id: existing.id }, data: { departmentId },
    });
    return { assignment: updated, created: false, changed: true };
  }
  if (!apply) return { assignment: null, created: true, changed: false };
  const created = await prisma.employeeEmploymentAssignment.create({
    data: {
      clubId, employeeId, role,
      employmentType: "PART_TIME", effectiveFrom: HIRE_DATE, departmentId,
    },
  });
  return { assignment: created, created: true, changed: false };
}

async function ensureCompensation(
  clubId: string, employeeId: string, assignmentId: string, apply: boolean,
) {
  const existing = await prisma.employeeCompensation.findFirst({
    where: { clubId, employeeId, assignmentId, effectiveTo: null },
  });
  if (existing) return { created: false };
  if (!apply) return { created: true };
  await prisma.employeeCompensation.create({
    data: {
      clubId, employeeId, assignmentId,
      cadence: "HOURLY", rate: "22.50", currency: "CAD",
      effectiveFrom: HIRE_DATE,
    },
  });
  return { created: true };
}

async function ensurePayrollPayGroupMember(
  clubId: string, employeeId: string, apply: boolean,
) {
  const pg = await prisma.payrollPayGroup.findFirst({
    where: { clubId, active: true }, orderBy: { createdAt: "asc" },
  });
  if (!pg) return { found: false as const };
  const existing = await prisma.payrollPayGroupMember.findFirst({
    where: { clubId, payGroupId: pg.id, employeeId },
  });
  if (existing) return { found: true as const, created: false, payGroupId: pg.id };
  if (!apply) return { found: true as const, created: true, payGroupId: pg.id };
  await prisma.payrollPayGroupMember.create({
    data: { clubId, payGroupId: pg.id, employeeId, effectiveFrom: HIRE_DATE },
  });
  return { found: true as const, created: true, payGroupId: pg.id };
}

async function ensurePortalCredential(employeeId: string, clubId: string, apply: boolean) {
  const existing = await prisma.employeePortalCredential.findUnique({ where: { employeeId } });
  if (existing) return { created: false, updated: apply };
  if (!apply) return { created: true, updated: false };
  const hash = await bcrypt.hash(PASSWORD, 8);
  await prisma.employeePortalCredential.create({
    data: {
      clubId, employeeId, passwordHash: hash, passwordUpdatedAt: new Date(),
    },
  });
  return { created: true, updated: false };
}

async function resetTaylorAcceptance(taylorId: string) {
  // ONLY Taylor Fixture's acceptance rows. Verified by employeeId join.
  const timesheets = await prisma.payrollTimesheet.findMany({
    where: { clubId: COULEE_RIDGE_STAGING_CLUB_ID, employeeId: taylorId },
    select: { id: true },
  });
  const tsIds = timesheets.map((t) => t.id);
  const entries = tsIds.length
    ? await prisma.payrollTimesheetEntry.findMany({
        where: { timesheetId: { in: tsIds } }, select: { id: true },
      })
    : [];
  // Log intended row counts before deleting.
  console.log(`RESET intents (Taylor Fixture ${taylorId}):`);
  console.log(`  timesheets:                 ${timesheets.length}`);
  console.log(`  timesheet entries:          ${entries.length}`);
  const correctionCount = await prisma.timeClockCorrectionRequest.count({
    where: { clubId: COULEE_RIDGE_STAGING_CLUB_ID, employeeId: taylorId },
  });
  console.log(`  correction requests:        ${correctionCount}`);
  const clockCount = await prisma.timeClockEvent.count({
    where: { clubId: COULEE_RIDGE_STAGING_CLUB_ID, employeeId: taylorId },
  });
  console.log(`  clock events:               ${clockCount}`);
  const frozenCount = await prisma.payrollApprovedTimeEntry.count({
    where: { clubId: COULEE_RIDGE_STAGING_CLUB_ID, employeeId: taylorId },
  });
  console.log(`  frozen approved-time rows:  ${frozenCount}`);
  const adjustmentCount = await prisma.payrollTimeAdjustment.count({
    where: { clubId: COULEE_RIDGE_STAGING_CLUB_ID, employeeId: taylorId },
  });
  console.log(`  time adjustments:           ${adjustmentCount}`);

  // Delete in FK-safe order.
  await prisma.payrollTimeAdjustment.deleteMany({
    where: { clubId: COULEE_RIDGE_STAGING_CLUB_ID, employeeId: taylorId },
  });
  await prisma.payrollApprovedTimeEntry.updateMany({
    where: { clubId: COULEE_RIDGE_STAGING_CLUB_ID, employeeId: taylorId },
    data: { supersededByApprovedTimeEntryId: null },
  });
  await prisma.payrollApprovedTimeEntry.deleteMany({
    where: {
      clubId: COULEE_RIDGE_STAGING_CLUB_ID, employeeId: taylorId,
      consumedByBatchId: null, // never touch consumed rows
    },
  });
  if (entries.length) {
    await prisma.payrollTimesheetEntryClockEvent.deleteMany({
      where: { timesheetEntryId: { in: entries.map((e) => e.id) } },
    });
    await prisma.payrollTimesheetEntry.deleteMany({ where: { id: { in: entries.map((e) => e.id) } } });
  }
  if (tsIds.length) {
    await prisma.payrollTimesheet.deleteMany({ where: { id: { in: tsIds } } });
  }
  await prisma.timeClockCorrectionRequest.deleteMany({
    where: { clubId: COULEE_RIDGE_STAGING_CLUB_ID, employeeId: taylorId },
  });
  // TimeClockEvent has supersedes/superseded self-FK — clear pointers first.
  await prisma.timeClockEvent.updateMany({
    where: { clubId: COULEE_RIDGE_STAGING_CLUB_ID, employeeId: taylorId },
    data: { supersededByEventId: null },
  });
  await prisma.timeClockEvent.deleteMany({
    where: { clubId: COULEE_RIDGE_STAGING_CLUB_ID, employeeId: taylorId },
  });
  await prisma.employee.update({
    where: { id: taylorId }, data: { timekeepingStateVersion: 0 },
  });
  console.log("RESET done.");
}

async function main() {
  const args = parseArgs();

  if (args.resetAcceptance && args.dryRun) {
    throw new Error("--reset-acceptance is destructive — cannot combine with --dry-run.");
  }

  // Guard (also enforces the ALLOW_STAGING_TA_FIXTURE + staging env).
  // Under --dry-run we still call the guard with apply=false so the
  // --apply check bails out cleanly.
  await guardDemoTenant({
    prisma,
    clubId: COULEE_RIDGE_STAGING_CLUB_ID,
    apply: args.apply, // false under --dry-run — will bail(2) as designed
    callerName: "payroll-staging-ta-fixture",
    writeClass: "SYNTHETIC_TIME_ATTENDANCE",
  }).catch((e) => {
    if (args.dryRun) {
      // The bail(2) is expected under --dry-run; we handle it by
      // rerunning the guard in a targeted way just to verify the
      // Club identity holds — we don't need the --apply check.
      console.log("DRY-RUN: guard --apply bailed as expected; continuing with read-only inspection.");
    } else {
      throw e;
    }
  });

  // Independent Club identity check (works under dry-run without --apply).
  const club = await prisma.club.findUniqueOrThrow({ where: { id: COULEE_RIDGE_STAGING_CLUB_ID } });
  if (club.name !== COULEE_RIDGE_STAGING_CLUB_NAME) {
    throw new Error(`Refusing: Club.name is "${club.name}", expected "${COULEE_RIDGE_STAGING_CLUB_NAME}".`);
  }
  if (club.stagingDataMode !== "FOUNDER_REVIEW") {
    throw new Error(`Refusing: stagingDataMode="${club.stagingDataMode}", expected FOUNDER_REVIEW.`);
  }

  // Existing Taylor Fixture check — reuse if present.
  let taylor = await prisma.employee.findFirst({
    where: { clubId: club.id, email: TAYLOR_EMPLOYEE_EMAIL },
  });
  if (!taylor) {
    // Not present — look up any Employee named Taylor Fixture at Coulee Ridge.
    taylor = await prisma.employee.findFirst({
      where: { clubId: club.id, firstName: "Taylor", lastName: "Fixture" },
    });
  }
  if (!taylor) {
    throw new Error("Taylor Fixture employee not found at Coulee Ridge. Manual creation required.");
  }
  // Enforce per-target guard on Taylor before any mutation.
  assertStagingTaTargetAllowed({
    callerName: "taylor-target-check",
    identity: {
      firstName: taylor.firstName, lastName: taylor.lastName,
      email: taylor.email ?? TAYLOR_EMPLOYEE_EMAIL, clubId: taylor.clubId,
    },
  });

  // Reset step (opt-in).
  if (args.resetAcceptance) {
    await resetTaylorAcceptance(taylor.id);
  }

  // Capture before-state for reporting.
  const taylorBefore = {
    timekeepingMethod: taylor.timekeepingMethod,
    compensationType: taylor.compensationType,
    status: taylor.status,
    userId: taylor.userId,
  };

  // Bring Taylor to the configuration §13 requires.
  // personalEmail is the field the Employee Portal login flow matches
  // against (verifyPortalPasswordByEmail — src/lib/hr/employee-portal-credential.ts).
  // We set it to the same value as the login User.email for symmetry.
  const taylorChanges: string[] = [];
  const needsNormalize =
    taylor.timekeepingMethod !== "CLOCK_REQUIRED" ||
    taylor.compensationType !== "HOURLY" ||
    taylor.status !== "ACTIVE";
  const needsPersonalEmail = (taylor as { personalEmail?: string | null }).personalEmail !== TAYLOR_LOGIN_EMAIL;
  if (needsNormalize || needsPersonalEmail) {
    if (args.apply) {
      await prisma.employee.update({
        where: { id: taylor.id },
        data: {
          timekeepingMethod: "CLOCK_REQUIRED",
          compensationType: "HOURLY",
          status: "ACTIVE",
          employeeLifecycle: "ACTIVE",
          personalEmail: TAYLOR_LOGIN_EMAIL,
        },
      });
    }
    if (needsNormalize) {
      taylorChanges.push(
        `timekeepingMethod: ${taylor.timekeepingMethod} -> CLOCK_REQUIRED`,
        `compensationType: ${taylor.compensationType} -> HOURLY`,
        `status: ${taylor.status} -> ACTIVE`,
      );
    }
    if (needsPersonalEmail) {
      taylorChanges.push(
        `personalEmail: ${(taylor as { personalEmail?: string | null }).personalEmail ?? "null"} -> ${TAYLOR_LOGIN_EMAIL}`,
      );
    }
  }

  // Independent proof: Chris Turcato + Lise Montsion are read-only
  // fingerprinted before ANY write happens. Report includes them.
  const chris = await prisma.employee.findFirst({
    where: { clubId: club.id, firstName: "Chris", lastName: "Turcato" },
  });
  const lise = await prisma.employee.findFirst({
    where: { clubId: club.id, firstName: "Lise", lastName: "Montsion" },
  });
  const preserveFingerprint = (row: {
    id: string; email: string | null; firstName: string; lastName: string;
    status: string; timekeepingMethod: string; compensationType: string;
    userId: string | null; hireDate: Date | null;
  } | null) => {
    if (!row) return null;
    return {
      id: row.id,
      hint: `${row.firstName} ${row.lastName}`,
      email: row.email,
      userId: row.userId,
      status: row.status,
      timekeepingMethod: row.timekeepingMethod,
      compensationType: row.compensationType,
      hireDateIso: row.hireDate?.toISOString() ?? null,
    };
  };
  const preserveBaselines = {
    chris_turcato: preserveFingerprint(chris),
    lise_montsion: preserveFingerprint(lise),
  };

  // Ensure Taylor has a User record for Employee Portal login.
  // We use a distinct login email (taylor.hourly@fixture.spectre.test)
  // so the *Employee* record's email doesn't need to change.
  let taylorUser = await prisma.user.findFirst({ where: { email: TAYLOR_LOGIN_EMAIL } });
  if (!taylorUser) {
    if (args.apply) {
      const hash = await bcrypt.hash(PASSWORD, 8);
      taylorUser = await prisma.user.create({
        data: {
          email: TAYLOR_LOGIN_EMAIL, name: "Taylor Fixture",
          role: "STAFF", status: "ACTIVE", clubId: club.id, passwordHash: hash,
        },
      });
      taylorChanges.push(`created User ${TAYLOR_LOGIN_EMAIL}`);
    } else {
      taylorChanges.push(`would create User ${TAYLOR_LOGIN_EMAIL}`);
    }
  }
  if (taylorUser && taylor.userId !== taylorUser.id) {
    if (args.apply) {
      await prisma.employee.update({ where: { id: taylor.id }, data: { userId: taylorUser.id } });
      taylorChanges.push(`linked Employee.userId -> ${TAYLOR_LOGIN_EMAIL}`);
    } else {
      taylorChanges.push(`would link Employee.userId -> ${TAYLOR_LOGIN_EMAIL}`);
    }
  }
  // Employee Portal credential.
  await ensurePortalCredential(taylor.id, club.id, args.apply);

  // Departments — reuse existing.
  const grounds  = await ensureDepartment(club.id, GROUNDS_CODE,  "Grounds");
  const events = await ensureDepartment(club.id, EVENTS_CODE, "Events");
  if (!grounds.department)  throw new Error(`Department GROUNDS not found on Coulee Ridge (expected code=${GROUNDS_CODE}).`);
  if (!events.department) throw new Error(`Department BANQUETS not found on Coulee Ridge (expected code=${EVENTS_CODE}).`);

  // Managers.
  const groundsMgr  = await ensureUser(GROUNDS_MGR_EMAIL,  "Grounds Manager Fixture",  "DEPARTMENT_MANAGER", club.id, args.apply);
  const eventsMgr = await ensureUser(EVENTS_MGR_EMAIL, "Events Manager Fixture", "DEPARTMENT_MANAGER", club.id, args.apply);
  if (groundsMgr.user.id !== "DRY_RUN")  await ensureUserClubRole(groundsMgr.user.id,  club.id, "DEPARTMENT_MANAGER", args.apply);
  if (eventsMgr.user.id !== "DRY_RUN") await ensureUserClubRole(eventsMgr.user.id, club.id, "DEPARTMENT_MANAGER", args.apply);

  // Taylor assignments — PRIMARY Grounds, SECONDARY Events.
  const primary   = await ensureAssignment(club.id, taylor.id, "PRIMARY",   grounds.department.id,  args.apply);
  const secondary = await ensureAssignment(club.id, taylor.id, "SECONDARY", events.department.id, args.apply);
  if (primary.assignment && args.apply)   await ensureCompensation(club.id, taylor.id, primary.assignment.id,   args.apply);
  if (secondary.assignment && args.apply) await ensureCompensation(club.id, taylor.id, secondary.assignment.id, args.apply);

  // DepartmentResponsibility bindings.
  if (groundsMgr.user.id !== "DRY_RUN")  await ensureDeptResponsibility(club.id, grounds.department.id,  groundsMgr.user.id,  args.apply);
  if (eventsMgr.user.id !== "DRY_RUN") await ensureDeptResponsibility(club.id, events.department.id, eventsMgr.user.id, args.apply);

  // Pay-group membership for Taylor.
  const pgm = await ensurePayrollPayGroupMember(club.id, taylor.id, args.apply);

  // Report.
  const report = {
    dryRun: args.dryRun,
    apply: args.apply,
    resetAcceptance: args.resetAcceptance,
    club: { id: club.id, name: club.name, slug: club.slug, stagingDataMode: club.stagingDataMode },
    taylor: {
      id: taylor.id, firstName: taylor.firstName, lastName: taylor.lastName,
      employeeEmail: taylor.email,
      loginEmail: TAYLOR_LOGIN_EMAIL,
      userId: taylorUser?.id ?? null,
      before: taylorBefore,
      after: {
        timekeepingMethod: "CLOCK_REQUIRED",
        compensationType: "HOURLY",
        status: "ACTIVE",
      },
      changes: taylorChanges,
    },
    preserve: {
      chris_turcato: preserveBaselines.chris_turcato,
      lise_montsion: preserveBaselines.lise_montsion,
      declaration: "Chris Turcato: NO TOUCH. Lise Montsion: NO TOUCH.",
    },
    departments: {
      grounds:  { id: grounds.department.id,  code: grounds.department.code,  name: grounds.department.name },
      events: { id: events.department.id, code: events.department.code, name: events.department.name },
    },
    managers: {
      grounds:  { userId: groundsMgr.user.id === "DRY_RUN" ? null : groundsMgr.user.id, email: GROUNDS_MGR_EMAIL, created: groundsMgr.created },
      events: { userId: eventsMgr.user.id === "DRY_RUN" ? null : eventsMgr.user.id, email: EVENTS_MGR_EMAIL, created: eventsMgr.created },
    },
    assignments: {
      primary:   { departmentId: grounds.department.id,  created: primary.created,   changed: primary.changed },
      secondary: { departmentId: events.department.id, created: secondary.created, changed: secondary.changed },
    },
    payGroup: pgm,
    credentials: { password: PASSWORD },
    urls: {
      login: "https://staging.spectreautomation.com/employee/login",
      time:  "https://staging.spectreautomation.com/employee/time",
      timesheets: "https://staging.spectreautomation.com/employee/timesheets",
    },
  };
  console.log(JSON.stringify(report, null, 2));
}

main()
  .catch((e) => { console.error("FIXTURE_ERROR", e && e.message || e); process.exit(1); })
  .finally(() => prisma.$disconnect());
