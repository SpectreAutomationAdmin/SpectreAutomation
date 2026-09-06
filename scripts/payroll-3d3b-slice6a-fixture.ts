// Payroll-3D-3B Slice 6A/6B (2026-09-06) — local browser-acceptance
// fixture. Seeds a fresh synthetic tenant with a scenario-selectable
// state for browser tests to exercise every PayrollActionCard path.
//
// Slice 6B extended the fixture with a scenario CLI argument so one
// deterministic script can prime any of the required browser test
// states. All scenarios operate on the SAME synthetic tenant
// ("Slice 6A Test Club" / slug "slice6a-events-mgr") — running any
// scenario wipes the previous state and seeds fresh.
//
// LOCAL ONLY. Does NOT touch Coulee Ridge staging. Does NOT touch
// Chris Turcato or Lise Montsion.
//
// Usage:
//   tsx scripts/payroll-3d3b-slice6a-fixture.ts                 # default
//   tsx scripts/payroll-3d3b-slice6a-fixture.ts --scenario=default
//   tsx scripts/payroll-3d3b-slice6a-fixture.ts --scenario=ready
//   tsx scripts/payroll-3d3b-slice6a-fixture.ts --scenario=review-required
//   tsx scripts/payroll-3d3b-slice6a-fixture.ts --scenario=config-gap
//   tsx scripts/payroll-3d3b-slice6a-fixture.ts --scenario=mixed-feed
//
// Scenarios:
//   default          — 1 PENDING correction + blocked scope (6A default)
//   ready            — Ready-for-approval scope, no correction card
//   review-required  — Ready → approved → drift → REVIEW_REQUIRED
//   config-gap       — Ready scope BUT no DEPARTMENT_TIME_APPROVAL
//                      owner → Tenant Admin sees the gap card
//   mixed-feed       — default + one synthetic non-payroll WorkIntake
//                      item so the feed contains a mix of card types

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

type Scenario = "default" | "ready" | "review-required" | "config-gap" | "mixed-feed";
function parseScenario(): Scenario {
  const argv = process.argv.slice(2);
  for (const a of argv) {
    if (a.startsWith("--scenario=")) {
      const v = a.slice("--scenario=".length);
      if (["default", "ready", "review-required", "config-gap", "mixed-feed"].includes(v)) {
        return v as Scenario;
      }
      throw new Error(`unknown scenario: ${v}`);
    }
  }
  return "default";
}

async function seedRbacIfMissing() {
  for (const [key, def] of Object.entries(PERMISSIONS)) {
    await prisma.permission.upsert({
      where: { key }, update: {}, create: { key, name: def.name, category: def.category },
    });
  }
  for (const [key, def] of Object.entries(ROLES)) {
    await prisma.role.upsert({
      where: { key }, update: {}, create: { key, name: def.name, description: def.description, isSystem: true },
    });
  }
  for (const [roleKey, grants] of Object.entries(ROLE_PERMISSIONS) as [string, string[]][]) {
    for (const permissionKey of grants) {
      await prisma.rolePermission.upsert({
        where: { roleKey_permissionKey: { roleKey, permissionKey } },
        update: {}, create: { roleKey, permissionKey },
      });
    }
  }
  await prisma.responsibility.upsert({
    where: { key: "TENANT_ADMINISTRATION" }, update: {},
    create: { key: "TENANT_ADMINISTRATION", displayLabel: "Tenant Administrator", scopeKind: "CLUB", cardinality: "PRIMARY_AND_BACKUPS", description: "Tenant Administration authority.", isSpectreDefined: true },
  });
  await prisma.responsibility.upsert({
    where: { key: "DEPARTMENT_TIME_APPROVAL" }, update: {},
    create: { key: "DEPARTMENT_TIME_APPROVAL", displayLabel: "Timesheet Approver", scopeKind: "DEPARTMENT", cardinality: "SINGLE_PRIMARY", description: "Reviews and approves recorded time.", isSpectreDefined: true },
  });
}

async function wipeExistingFixture() {
  const club = await prisma.club.findFirst({ where: { slug: TENANT_SLUG } });
  if (!club) return;
  console.log(`[slice6a-fixture] wiping existing tenant ${club.id}...`);
  await prisma.workIntakeActivity.deleteMany({ where: { workIntakeItem: { clubId: club.id } } });
  await prisma.workIntakeOrigin.deleteMany({ where: { clubId: club.id } });
  await prisma.workCompletionEvent.deleteMany({ where: { clubId: club.id } });
  await prisma.workIntakeItem.deleteMany({ where: { clubId: club.id } });
  await prisma.backgroundJob.deleteMany({ where: { clubId: club.id } });
  await prisma.payrollDepartmentTimeApproval.deleteMany({ where: { clubId: club.id } });
  await prisma.payrollTimesheetEntryClockEvent.deleteMany({ where: { timesheetEntry: { clubId: club.id } } });
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
  await prisma.user.deleteMany({
    where: { email: { in: [EVENTS_MGR_EMAIL, GROUNDS_MGR_EMAIL, TENANT_ADMIN_EMAIL] } },
  });
}

async function seedBase(opts: { assignEventsApprover: boolean }) {
  const utcAt = (y: number, m: number, d: number, h = 0, mi = 0) => new Date(Date.UTC(y, m - 1, d, h, mi));
  const passwordHash = await bcrypt.hash(PASSWORD, 4);

  const club = await prisma.club.create({
    data: { name: TENANT_NAME, slug: TENANT_SLUG, region: "AB", salesTaxRegion: "GST", foundedYear: 2020 },
  });
  const events = await prisma.department.create({
    data: { clubId: club.id, code: "EVENTS", name: "Events", isActive: true },
  });
  const grounds = await prisma.department.create({
    data: { clubId: club.id, code: "GROUNDS", name: "Course & Grounds", isActive: true },
  });
  const eventsMgr = await prisma.user.create({
    data: { email: EVENTS_MGR_EMAIL, name: "Events Manager", role: "DEPARTMENT_MANAGER", passwordHash, clubId: club.id, status: "ACTIVE" },
  });
  await prisma.userClubRole.create({ data: { userId: eventsMgr.id, clubId: club.id, roleKey: "DEPARTMENT_MANAGER" } });
  const groundsMgr = await prisma.user.create({
    data: { email: GROUNDS_MGR_EMAIL, name: "Grounds Manager", role: "DEPARTMENT_MANAGER", passwordHash, clubId: club.id, status: "ACTIVE" },
  });
  await prisma.userClubRole.create({ data: { userId: groundsMgr.id, clubId: club.id, roleKey: "DEPARTMENT_MANAGER" } });
  const admin = await prisma.user.create({
    data: { email: TENANT_ADMIN_EMAIL, name: "Tenant Administrator", role: "CLUB_ADMIN", passwordHash, clubId: club.id, status: "ACTIVE" },
  });
  await prisma.userClubRole.create({ data: { userId: admin.id, clubId: club.id, roleKey: "CLUB_ADMIN" } });
  await prisma.responsibilityAssignment.create({
    data: { clubId: club.id, userId: admin.id, responsibilityKey: "TENANT_ADMINISTRATION", role: "PRIMARY", effectiveFrom: new Date() },
  });
  if (opts.assignEventsApprover) {
    await prisma.departmentResponsibility.create({
      data: { clubId: club.id, departmentId: events.id, userId: eventsMgr.id, responsibilityKey: "DEPARTMENT_TIME_APPROVAL" },
    });
  }
  await prisma.departmentResponsibility.create({
    data: { clubId: club.id, departmentId: grounds.id, userId: groundsMgr.id, responsibilityKey: "DEPARTMENT_TIME_APPROVAL" },
  });
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
    data: { clubId: club.id, employeeId: taylor.id, role: "PRIMARY", employmentType: "PART_TIME", effectiveFrom: utcAt(2026, 1, 1), departmentId: grounds.id },
  });
  const eventsAssn = await prisma.employeeEmploymentAssignment.create({
    data: { clubId: club.id, employeeId: taylor.id, role: "ADDITIONAL", employmentType: "PART_TIME", effectiveFrom: utcAt(2026, 1, 1), departmentId: events.id },
  });
  const pg = await prisma.payrollPayGroup.create({
    data: { clubId: club.id, code: "PG-SLICE6A", name: "Slice 6A Semi-Monthly", payFrequency: "SEMI_MONTHLY", payDateOffsetDays: 5, calendarAnchorDate: utcAt(2026, 1, 1), active: true },
  });
  const period = await prisma.payrollPayPeriod.create({
    data: {
      clubId: club.id, payGroupId: pg.id, taxYear: 2026, sequenceInYear: 17,
      periodStart: utcAt(2026, 9, 1), periodEnd: utcAt(2026, 9, 16),
      payDate: utcAt(2026, 9, 20), status: "OPEN",
    },
  });
  await prisma.payrollPayGroupMember.create({
    data: { clubId: club.id, payGroupId: pg.id, employeeId: taylor.id, effectiveFrom: utcAt(2020, 1, 1) },
  });
  return { club, events, grounds, eventsMgr, groundsMgr, admin, taylor, eventsAssn, period };
}

async function seedScenario(scenario: Scenario) {
  const utcAt = (y: number, m: number, d: number, h = 0, mi = 0) => new Date(Date.UTC(y, m - 1, d, h, mi));

  // Scenarios that DO NOT assign the Events approver
  const withoutEventsApprover = scenario === "config-gap";
  const base = await seedBase({ assignEventsApprover: !withoutEventsApprover });

  const { materializeEmployeeTimesheet } = await import("../src/lib/timesheets/service");
  const { submitCorrectionRequest, approveCorrectionRequest } = await import("../src/lib/timesheets/correction-service");
  const { invalidateApprovalIfDrifted } = await import("../src/lib/timesheets/manager-approval");

  // ONE Events shift for every scenario (this is what gives the scope
  // materialised entries so the timesheet card can appear).
  const clockIn = await prisma.timeClockEvent.create({
    data: {
      clubId: base.club.id, employeeId: base.taylor.id, kind: "CLOCK_IN",
      occurredAt: utcAt(2026, 9, 5, 14, 0), source: "EMPLOYEE_PORTAL",
      employmentAssignmentId: base.eventsAssn.id,
    },
  });
  await prisma.timeClockEvent.create({
    data: {
      clubId: base.club.id, employeeId: base.taylor.id, kind: "CLOCK_OUT",
      occurredAt: utcAt(2026, 9, 5, 22, 0), source: "EMPLOYEE_PORTAL",
      employmentAssignmentId: base.eventsAssn.id,
    },
  });
  await materializeEmployeeTimesheet(base.club.id, base.taylor.id, base.period.id);

  const empPrincipal = { clubId: base.club.id, employeeId: base.taylor.id, generation: 1, establishedAt: new Date().toISOString() };
  const eventsMgrPrincipal = {
    id: base.eventsMgr.id, name: base.eventsMgr.name, email: base.eventsMgr.email, status: base.eventsMgr.status,
    memberships: [{ clubId: base.club.id, roleKey: "DEPARTMENT_MANAGER" as const }],
    activeClubId: base.club.id, memberId: null,
  };

  switch (scenario) {
    case "default":
    case "mixed-feed": {
      // PENDING correction → correction card + blocked scope card.
      await submitCorrectionRequest(empPrincipal, {
        requestType: "CORRECT_CLOCK_IN", originalClockEventId: clockIn.id,
        requestedLocalIso: "2026-09-05T14:15",
        reason: "Rounded to top of the hour by mistake.",
        employmentAssignmentId: base.eventsAssn.id,
      });
      if (scenario === "mixed-feed") {
        // Add a synthetic LEGACY payroll subtype WorkIntakeItem owned
        // by the Events Manager. Because the loader assembles
        // payrollCard ONLY for the four supported subtypes
        // (TIMECLOCK_CORRECTION_REVIEW, PAYROLL_TIMESHEET_APPROVAL,
        // and their config-gap siblings), this legacy subtype falls
        // through to the generic <FeedItem> renderer — proving the
        // payroll dispatch does NOT swallow non-payroll-action cards.
        // We piggy-back on workDomain=PAYROLL so the MC's payroll
        // loader picks it up (GENERAL / other domains aren't loaded
        // by any locally-testable adapter).
        const legacyWi = await prisma.workIntakeItem.create({
          data: {
            clubId: base.club.id, status: "OPEN", ownerUserId: base.eventsMgr.id,
            classification: "PAYROLL_ADMIN_PROCESSING",
            classificationReason: "Slice 6B mixed-feed proof — legacy payroll subtype",
            classificationMethod: "RULE",
            displaySourceLabel: "Spectre Payroll",
            displaySender: "Payroll orchestration",
            displaySubject: "Legacy payroll processing card",
            displayPreview: "This legacy-subtype card renders through FeedItem, not PayrollActionCard.",
            displayReceivedAt: new Date(),
            workDomain: "PAYROLL", workIntent: "REVIEW", workSubtype: "PAYROLL_ADMIN_PROCESSING",
          },
        });
        await prisma.workIntakeOrigin.create({
          data: {
            clubId: base.club.id, workIntakeItemId: legacyWi.id,
            kind: "PAYROLL_ADMIN_PROCESSING", referenceId: base.period.id, role: "PRIMARY",
          },
        });
      }
      break;
    }
    case "ready": {
      // No correction → scope is naturally READY_FOR_REVIEW.
      // Materialise already created the WI card via Slice 3.
      break;
    }
    case "review-required": {
      // Approve first (via canonical service), then add a new shift to
      // drift the revision, then invalidate.
      const { getScopeReview } = await import("../src/lib/timesheets/approval-scope");
      const { approveTimesheetScope } = await import("../src/lib/timesheets/manager-approval");
      const review = await getScopeReview(base.club.id, base.period.id, base.events.id);
      await approveTimesheetScope(eventsMgrPrincipal, {
        clubId: base.club.id, payPeriodId: base.period.id, departmentId: base.events.id,
        attestedRevision: review.currentRevision,
      });
      // Drift the revision — new shift.
      await prisma.timeClockEvent.create({
        data: {
          clubId: base.club.id, employeeId: base.taylor.id, kind: "CLOCK_IN",
          occurredAt: utcAt(2026, 9, 7, 14, 0), source: "EMPLOYEE_PORTAL",
          employmentAssignmentId: base.eventsAssn.id,
        },
      });
      await prisma.timeClockEvent.create({
        data: {
          clubId: base.club.id, employeeId: base.taylor.id, kind: "CLOCK_OUT",
          occurredAt: utcAt(2026, 9, 7, 22, 0), source: "EMPLOYEE_PORTAL",
          employmentAssignmentId: base.eventsAssn.id,
        },
      });
      await materializeEmployeeTimesheet(base.club.id, base.taylor.id, base.period.id);
      await invalidateApprovalIfDrifted(base.club.id, base.period.id, base.events.id);
      // Silence 'unused' warning — the imported approveCorrectionRequest
      // is only relevant to other scenarios in this switch.
      void approveCorrectionRequest;
      break;
    }
    case "config-gap": {
      // Materialise already created the scope-gap card (no owner →
      // tenant admin gap card). Nothing else to do.
      break;
    }
  }

  console.log(`[slice6a-fixture] SEEDED scenario=${scenario}`);
  console.log(`  clubId:           ${base.club.id}`);
  console.log(`  Events Manager:   ${EVENTS_MGR_EMAIL} / ${PASSWORD}`);
  console.log(`  Grounds Manager:  ${GROUNDS_MGR_EMAIL} / ${PASSWORD}`);
  console.log(`  Tenant Admin:     ${TENANT_ADMIN_EMAIL} / ${PASSWORD}`);
  console.log(`  Taylor employee:  ${base.taylor.id}`);
  console.log(`  Pay period:       ${base.period.id}`);
  console.log(`  Events dept:      ${base.events.id}`);
  console.log(`  Grounds dept:     ${base.grounds.id}`);
}

async function main() {
  const scenario = parseScenario();
  console.log(`[slice6a-fixture] scenario=${scenario}`);
  await seedRbacIfMissing();
  await wipeExistingFixture();
  await seedScenario(scenario);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
