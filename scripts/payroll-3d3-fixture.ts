// Payroll-3D-3 (2026-09-05) — Manager Timesheet Approval fixture.
//
// Extends the 3D-1 Taylor Hourly fixture so a founder can drive the
// end-to-end manager acceptance flow on localhost.
//
// Creates (or reuses) inside Coulee Ridge (never a new tenant):
//   • Grounds department (dept-code: GROUNDS)
//   • Banquets department (dept-code: BANQUETS) — for the routing
//     regression proof in §53 (primary dept ≠ worked assignment dept)
//   • Grounds manager user (grounds.manager@preview.spectre.test)
//   • Banquets manager user (banquets.manager@preview.spectre.test)
//   • DepartmentResponsibility rows binding each manager to
//     DEPARTMENT_TIME_APPROVAL for their department
//   • Taylor's primary EmployeeEmploymentAssignment is bound to
//     GROUNDS so cleanly-clocked time routes to the Grounds manager
//   • Optional Banquets EmployeeEmploymentAssignment for Taylor
//     (kept as a distinct row so a per-session clock-in can be
//     targeted at Banquets and prove multi-scope routing)
//
// Resets, on every re-run:
//   • Taylor's clock events / timesheets / correction requests
//   • 3D-3 PayrollDepartmentTimeApproval rows for the Grounds and
//     Banquets scopes in the current pay period
//   • Any TIMESHEET_APPROVAL / _CONFIG_GAP Work Intake cards for
//     those scopes
//
// All identifiers synthetic. No real employee PII. Idempotent.

import { loadEnvFiles } from "./_lib/load-env";
loadEnvFiles();

import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

const TAYLOR_EMAIL          = "taylor.hourly@preview.spectre.test";
const GROUNDS_MGR_EMAIL     = "grounds.manager@preview.spectre.test";
const BANQUETS_MGR_EMAIL    = "banquets.manager@preview.spectre.test";
const PREVIEW_PASSWORD      = "TA1C-Preview-99";
const HIRE_DATE             = new Date("2026-04-01T00:00:00.000Z");
const GROUNDS_CODE          = "GROUNDS";
const BANQUETS_CODE         = "BANQUETS";

async function ensureUser(email: string, name: string, clubId: string, passwordHash: string) {
  let u = await prisma.user.findFirst({ where: { email } });
  if (!u) {
    u = await prisma.user.create({
      data: {
        email, name, role: "DEPARTMENT_MANAGER", status: "ACTIVE",
        clubId, passwordHash,
      },
    });
  } else if (u.status !== "ACTIVE") {
    await prisma.user.update({ where: { id: u.id }, data: { status: "ACTIVE" } });
  }
  // Ensure UserClubRole with DEPARTMENT_MANAGER at this club.
  const role = await prisma.userClubRole.findFirst({
    where: { userId: u.id, clubId, roleKey: "DEPARTMENT_MANAGER" },
  });
  if (!role) {
    await prisma.userClubRole.create({
      data: { userId: u.id, clubId, roleKey: "DEPARTMENT_MANAGER" },
    });
  }
  return u;
}

async function ensureDepartment(clubId: string, code: string, name: string) {
  const existing = await prisma.department.findUnique({
    where: { clubId_code: { clubId, code } },
  });
  if (existing) return existing;
  return prisma.department.create({
    data: { clubId, code, name, isActive: true, sortOrder: code === "GROUNDS" ? 1 : 2 },
  });
}

async function ensureDeptResponsibility(clubId: string, departmentId: string, userId: string) {
  await prisma.departmentResponsibility.upsert({
    where: {
      clubId_departmentId_responsibilityKey: {
        clubId, departmentId, responsibilityKey: "DEPARTMENT_TIME_APPROVAL",
      },
    },
    update: { userId, assignedAt: new Date() },
    create: {
      clubId, departmentId, responsibilityKey: "DEPARTMENT_TIME_APPROVAL",
      userId,
    },
  });
}

async function ensureAssignment(
  clubId: string, employeeId: string,
  role: "PRIMARY" | "SECONDARY", departmentId: string,
) {
  const existing = await prisma.employeeEmploymentAssignment.findFirst({
    where: { clubId, employeeId, role, effectiveTo: null },
  });
  if (existing) {
    if (existing.departmentId !== departmentId) {
      await prisma.employeeEmploymentAssignment.update({
        where: { id: existing.id }, data: { departmentId },
      });
    }
    return existing;
  }
  return prisma.employeeEmploymentAssignment.create({
    data: {
      clubId, employeeId, role,
      employmentType: role === "PRIMARY" ? "PART_TIME" : "PART_TIME",
      effectiveFrom: HIRE_DATE,
      departmentId,
    },
  });
}

async function currentPayPeriod(clubId: string) {
  const now = new Date();
  return prisma.payrollPayPeriod.findFirst({
    where: {
      clubId,
      periodStart: { lte: now },
      periodEnd:   { gt: now },
    },
  });
}

async function wipeTaylorTimesheets(clubId: string, employeeId: string): Promise<number> {
  const ts = await prisma.payrollTimesheet.findMany({
    where: { clubId, employeeId }, select: { id: true },
  });
  if (ts.length) {
    const tsIds = ts.map((t) => t.id);
    const entries = await prisma.payrollTimesheetEntry.findMany({
      where: { timesheetId: { in: tsIds } }, select: { id: true },
    });
    if (entries.length) {
      await prisma.payrollTimesheetEntryClockEvent.deleteMany({
        where: { timesheetEntryId: { in: entries.map((e) => e.id) } },
      });
      await prisma.payrollTimesheetEntry.deleteMany({ where: { id: { in: entries.map((e) => e.id) } } });
    }
    await prisma.payrollTimesheet.deleteMany({ where: { id: { in: tsIds } } });
  }
  await prisma.timeClockCorrectionRequest.deleteMany({ where: { clubId, employeeId } });
  const del = await prisma.timeClockEvent.deleteMany({ where: { clubId, employeeId } });
  await prisma.employee.update({ where: { id: employeeId }, data: { timekeepingStateVersion: 0 } });
  return del.count;
}

async function wipeScopeApprovalArtifacts(
  clubId: string, payPeriodId: string, departmentIds: string[],
) {
  // Delete PayrollDepartmentTimeApproval rows for the scopes.
  await prisma.payrollDepartmentTimeApproval.deleteMany({
    where: { clubId, payPeriodId, departmentId: { in: departmentIds } },
  });
  // Delete TIMESHEET_APPROVAL + _CONFIG_GAP Work Intake origins and their items.
  for (const departmentId of departmentIds) {
    const referenceId = `${payPeriodId}:${departmentId}`;
    for (const kind of ["PAYROLL_TIMESHEET_APPROVAL", "PAYROLL_TIMESHEET_APPROVAL_CONFIG_GAP"]) {
      const origins = await prisma.workIntakeOrigin.findMany({
        where: { clubId, kind, referenceId },
        select: { workIntakeItemId: true, id: true },
      });
      for (const o of origins) {
        await prisma.workIntakeActivity.deleteMany({ where: { workIntakeItemId: o.workIntakeItemId } });
        await prisma.workIntakeOrigin.deleteMany({ where: { workIntakeItemId: o.workIntakeItemId } });
        await prisma.workIntakeItemRead.deleteMany({ where: { workIntakeItemId: o.workIntakeItemId } });
        await prisma.workIntakeFinding.deleteMany({ where: { workIntakeItemId: o.workIntakeItemId } });
        await prisma.workIntakeItem.delete({ where: { id: o.workIntakeItemId } });
      }
    }
  }
}

async function main() {
  const club = await prisma.club.findFirstOrThrow({ where: { slug: "coulee-ridge" } });
  const hash = await bcrypt.hash(PREVIEW_PASSWORD, 8);

  // Taylor must exist first (3D-1 fixture prerequisite).
  const taylor = await prisma.employee.findFirst({
    where: { clubId: club.id, email: TAYLOR_EMAIL },
  });
  if (!taylor) {
    throw new Error(
      "Taylor Hourly employee not found. Run `npm run fixture:payroll-3d1-taylor-hourly` first.",
    );
  }

  // Departments.
  const grounds  = await ensureDepartment(club.id, GROUNDS_CODE,  "Grounds");
  const banquets = await ensureDepartment(club.id, BANQUETS_CODE, "Banquets");

  // Managers (users).
  const groundsMgr  = await ensureUser(GROUNDS_MGR_EMAIL,  "Sam Grounds",  club.id, hash);
  const banquetsMgr = await ensureUser(BANQUETS_MGR_EMAIL, "Sam Banquets", club.id, hash);

  // DepartmentResponsibility bindings.
  await ensureDeptResponsibility(club.id, grounds.id,  groundsMgr.id);
  await ensureDeptResponsibility(club.id, banquets.id, banquetsMgr.id);

  // Taylor's PRIMARY assignment → Grounds.
  await ensureAssignment(club.id, taylor.id, "PRIMARY", grounds.id);
  // Payroll-3D-3A — Taylor's SECONDARY assignment → Banquets so the
  // multi-assignment picker appears at Clock In and the founder can
  // prove worked-assignment routing (primary != worked dept) entirely
  // through the browser.
  await ensureAssignment(club.id, taylor.id, "SECONDARY", banquets.id);

  // Reset Taylor's clock state + timesheets.
  const wipedEvents = await wipeTaylorTimesheets(club.id, taylor.id);

  // Reset Work Intake + Approval artifacts for both scopes in the
  // current pay period so acceptance starts clean.
  const period = await currentPayPeriod(club.id);
  if (period) {
    await wipeScopeApprovalArtifacts(club.id, period.id, [grounds.id, banquets.id]);
  }

  // eslint-disable-next-line no-console
  console.log(JSON.stringify({
    clubId: club.id,
    club: club.slug,
    taylorEmployeeId: taylor.id,
    grounds: {
      departmentId: grounds.id,
      managerEmail: GROUNDS_MGR_EMAIL,
      managerUserId: groundsMgr.id,
    },
    banquets: {
      departmentId: banquets.id,
      managerEmail: BANQUETS_MGR_EMAIL,
      managerUserId: banquetsMgr.id,
    },
    payPeriodId: period?.id ?? null,
    payPeriodStartIso: period?.periodStart.toISOString() ?? null,
    payPeriodEndIso:   period?.periodEnd.toISOString() ?? null,
    wipedClockEvents: wipedEvents,
    credentials: {
      password: PREVIEW_PASSWORD,
      taylor: TAYLOR_EMAIL,
      groundsManager: GROUNDS_MGR_EMAIL,
      banquetsManager: BANQUETS_MGR_EMAIL,
    },
    urls: {
      login: "http://localhost:3000/employee/login",
      adminLogin: "http://localhost:3000/login",
      managerWorkspaceHint:
        `http://localhost:3000/app/admin/payroll/time?payPeriodId=${period?.id ?? "…"}&departmentId=${grounds.id}&scope=timesheet`,
    },
  }));
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
