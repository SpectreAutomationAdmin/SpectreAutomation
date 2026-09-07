// Scheduling Foundation · Phase D (2026-09-07) — local fixture for
// the Playwright My Schedule visual acceptance spec.
//
// Idempotent, dev-only. Creates a fresh Club + hourly employee with a
// portal credential, plus the scenario data required by the Playwright
// spec:
//
//   --scenario=populated  (default)
//     One completed shift with variance + 3 upcoming shifts (some
//     with time gaps) so the weekly grid, next-shift countdown,
//     this-week totals, and recent-shifts variance all render.
//     Employee is training-eligible (no required courses configured).
//
//   --scenario=locked
//     Same shape but the employee is marked training-incomplete
//     via an ACTIVE required TrainingCourseVersion with no completion.
//
//   --scenario=empty
//     Eligible employee with no shifts scheduled → empty state.
//
// Output: JSON on stdout with { clubId, employeeId, loginEmail,
// loginPassword, scenario, weekStartIso }.

import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import crypto from "node:crypto";

const prisma = new PrismaClient();

const args = process.argv.slice(2);
const scenarioArg = (args.find((a) => a.startsWith("--scenario=")) ?? "--scenario=populated").split("=")[1];
if (!["populated", "locked", "empty"].includes(scenarioArg)) {
  process.stderr.write(`Unknown --scenario=${scenarioArg}\n`);
  process.exit(2);
}
const scenario = /** @type {"populated"|"locked"|"empty"} */ (scenarioArg);

const seed = crypto.randomBytes(4).toString("hex");
const PASSWORD = "PhaseD-Preview-99";
const CLUB_SLUG = `phase-d-fixture-${seed}`;

function monday(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const back = (d.getUTCDay() + 6) % 7;
  return new Date(d.getTime() - back * 86_400_000);
}

async function ensureClub() {
  return prisma.club.create({
    data: {
      slug: CLUB_SLUG,
      name: `Phase D Fixture Club ${seed}`,
      wordmark: `Phase D Fixture Club ${seed}`,
      timezone: "America/Edmonton", payrollProvince: "AB",
      stagingDataMode: "OFF",
    },
  });
}

async function ensureDept(clubId) {
  return prisma.department.create({
    data: { clubId, code: "EVENTS", name: "Events", isActive: true },
  });
}

async function ensurePosition(clubId, departmentId) {
  return prisma.employeePosition.create({
    data: { clubId, code: "SERVER", name: "Server", departmentId, defaultPayRate: 20, isActive: true },
  });
}

async function ensureEmployee(clubId, seedKey) {
  return prisma.employee.create({
    data: {
      clubId, firstName: "Sam", lastName: "Fixture",
      email: `sam-${seedKey}@fixture.spectre.test`,
      personalEmail: `sam-${seedKey}@fixture.spectre.test`,
      hireDate: new Date("2026-04-01T00:00:00Z"),
      status: "ACTIVE", employeeLifecycle: "ACTIVE",
      employeeNumber: `PD-${seedKey}`, compensationType: "HOURLY",
      homeProvince: "AB", timekeepingMethod: "CLOCK_REQUIRED",
    },
  });
}

async function ensurePortalCredential(employeeId, clubId, password) {
  const hash = await bcrypt.hash(password, 8);
  return prisma.employeePortalCredential.create({
    data: {
      employeeId, clubId, passwordHash: hash,
      passwordUpdatedAt: new Date(),
    },
  });
}

async function ensureAssignment(clubId, employeeId, departmentId) {
  return prisma.employeeEmploymentAssignment.create({
    data: {
      clubId, employeeId, role: "PRIMARY", employmentType: "PART_TIME",
      effectiveFrom: new Date("2026-01-01T00:00:00Z"),
      departmentId,
    },
  });
}

async function ensureTemplate(clubId, departmentId, code, name, startMin, endMin, sortOrder) {
  return prisma.shiftTemplate.create({
    data: {
      clubId, departmentId, code, name,
      startTimeMinutes: startMin, endTimeMinutes: endMin,
      active: true, sortOrder,
    },
  });
}

async function ensureShiftAssignment(clubId, departmentId, templateId, positionId, employeeId, employmentAssignmentId, startAt, endAt) {
  const shift = await prisma.shift.create({
    data: {
      clubId, departmentId, shiftTemplateId: templateId, positionId,
      shiftDate: startAt, startAt, endAt, state: "PUBLISHED",
    },
  });
  return prisma.shiftAssignment.create({
    data: {
      clubId, shiftId: shift.id, employeeId, employmentAssignmentId,
      state: "ASSIGNED",
    },
  });
}

async function ensurePayGroupAndPeriod(clubId, employeeId, periodStart, periodEnd) {
  const pg = await prisma.payrollPayGroup.create({
    data: {
      clubId, code: `PG-${seed}`, name: `PhaseD-${seed}`,
      payFrequency: "BI_WEEKLY", payDateOffsetDays: 5,
      calendarAnchorDate: new Date("2026-01-01T00:00:00Z"), active: true,
    },
  });
  await prisma.payrollPayGroupMember.create({
    data: { clubId, payGroupId: pg.id, employeeId, effectiveFrom: new Date("2020-01-01T00:00:00Z") },
  });
  const period = await prisma.payrollPayPeriod.create({
    data: {
      clubId, payGroupId: pg.id, taxYear: 2026, sequenceInYear: 1,
      periodStart, periodEnd,
      payDate: new Date(periodEnd.getTime() + 5 * 86_400_000),
      status: "OPEN",
    },
  });
  return { pg, period };
}

async function ensureWorkedEntry(clubId, employeeId, periodId, employmentAssignmentId, clockIn, clockOut) {
  const timesheet = await prisma.payrollTimesheet.upsert({
    where: { clubId_employeeId_payPeriodId: { clubId, employeeId, payPeriodId: periodId } },
    update: {},
    create: { clubId, employeeId, payPeriodId: periodId, status: "OPEN" },
  });
  const seconds = Math.floor((clockOut.getTime() - clockIn.getTime()) / 1000);
  return prisma.payrollTimesheetEntry.create({
    data: {
      clubId, timesheetId: timesheet.id, employeeId,
      workDate: clockIn, employmentAssignmentId,
      earningClassification: "REGULAR",
      clockInAt: clockIn, clockOutAt: clockOut,
      recordedSeconds: seconds, breakSeconds: 0,
    },
  });
}

// Anchor the fixture to a stable "now" so week label is predictable.
// We use TODAY as anchor; the spec renders whatever week contains it.
const NOW = new Date();
const WEEK_START = monday(NOW);
const YESTERDAY = new Date(NOW.getTime() - 86_400_000);

async function main() {
  const club = await ensureClub();
  const dept = await ensureDept(club.id);
  const position = await ensurePosition(club.id, dept.id);
  const employee = await ensureEmployee(club.id, seed);
  await ensurePortalCredential(employee.id, club.id, PASSWORD);
  const assignment = await ensureAssignment(club.id, employee.id, dept.id);
  const dayTpl = await ensureTemplate(club.id, dept.id, "DAY", "Day Shift", 11 * 60, 17 * 60 + 30, 10);
  const eveTpl = await ensureTemplate(club.id, dept.id, "EVENING", "Evening Shift", 17 * 60 + 30, 23 * 60, 20);

  if (scenario === "populated") {
    // Completed shift YESTERDAY 11:00 → 17:30, worked 10:58 → 17:42.
    const yStart = new Date(Date.UTC(YESTERDAY.getUTCFullYear(), YESTERDAY.getUTCMonth(), YESTERDAY.getUTCDate(), 11, 0));
    const yEnd = new Date(yStart.getTime() + (6 * 60 + 30) * 60_000);
    await ensureShiftAssignment(club.id, dept.id, dayTpl.id, position.id, employee.id, assignment.id, yStart, yEnd);
    const { period } = await ensurePayGroupAndPeriod(
      club.id, employee.id,
      new Date(WEEK_START.getTime() - 14 * 86_400_000),
      new Date(WEEK_START.getTime() + 14 * 86_400_000),
    );
    await ensureWorkedEntry(
      club.id, employee.id, period.id, assignment.id,
      new Date(yStart.getTime() - 2 * 60_000),
      new Date(yEnd.getTime() + 12 * 60_000),
    );

    // Upcoming shifts across this week — spread through days so the
    // grid demonstrates multiple day columns populated.
    const upcomingOffsets = [1, 3, 5]; // Mon, Wed, Fri if today is Sunday
    for (const dayOffset of upcomingOffsets) {
      const start = new Date(WEEK_START.getTime() + dayOffset * 86_400_000 + (11 * 60) * 60_000);
      const end = new Date(start.getTime() + (6 * 60 + 30) * 60_000);
      // Skip if it's in the past relative to NOW to keep "upcoming".
      if (end.getTime() <= NOW.getTime()) continue;
      await ensureShiftAssignment(club.id, dept.id, dayTpl.id, position.id, employee.id, assignment.id, start, end);
    }
    // Ensure at least one future shift exists.
    const tomorrow = new Date(NOW.getTime() + 86_400_000);
    const tomorrowStart = new Date(Date.UTC(tomorrow.getUTCFullYear(), tomorrow.getUTCMonth(), tomorrow.getUTCDate(), 17, 30));
    const tomorrowEnd = new Date(tomorrowStart.getTime() + (5 * 60 + 30) * 60_000);
    await ensureShiftAssignment(club.id, dept.id, eveTpl.id, position.id, employee.id, assignment.id, tomorrowStart, tomorrowEnd);
  } else if (scenario === "locked") {
    // No shifts. Create a REQUIRED published training version with no
    // completion so the eligibility resolver marks the employee
    // ineligible.
    const course = await prisma.trainingCourse.create({
      data: {
        clubId: club.id, code: "SAFE-BASICS", title: "Safety Basics",
        category: "SAFETY",
      },
    });
    await prisma.trainingCourseVersion.create({
      data: {
        courseId: course.id, version: 1,
        state: "PUBLISHED", required: true, appliesToAll: true,
        title: "Safety Basics",
        publishedAt: new Date(),
        passingScore: 80, retakesAllowed: true, requiresKnowledgeTest: true,
      },
    });
    const course2 = await prisma.trainingCourse.create({
      data: {
        clubId: club.id, code: "HARASS-BASICS", title: "Respect at Work",
        category: "COMPLIANCE",
      },
    });
    await prisma.trainingCourseVersion.create({
      data: {
        courseId: course2.id, version: 1,
        state: "PUBLISHED", required: true, appliesToAll: true,
        title: "Respect at Work",
        publishedAt: new Date(),
        passingScore: 80, retakesAllowed: true, requiresKnowledgeTest: true,
      },
    });
  }
  // "empty" scenario needs no additional data — eligible employee, no shifts.

  const out = {
    scenario,
    clubId: club.id,
    clubSlug: CLUB_SLUG,
    employeeId: employee.id,
    loginEmail: employee.personalEmail,
    loginPassword: PASSWORD,
    weekStartIso: WEEK_START.toISOString(),
  };
  process.stdout.write(JSON.stringify(out, null, 2) + "\n");
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
