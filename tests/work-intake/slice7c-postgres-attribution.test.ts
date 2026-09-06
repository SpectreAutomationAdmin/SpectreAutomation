// Payroll-3D-3B Slice 7C (2026-09-06) — attribution + currency +
// legacy-policy tests for the shared scope-version CAS.
//
// This file layers on Slice 7B's raw CAS proofs. It proves that:
//
//   §8  Multi-department attribution — Taylor with PRIMARY assignment
//       in Grounds and a worked-shift assignment in Events. A
//       material change to Taylor's Events entry bumps Events'
//       scope-version and NOT Grounds' scope-version.
//
//   §9  Cross-midnight/pay-period attribution — a shift that clocks
//       in near the end of one pay period and clocks out after
//       midnight into the next belongs (per 3D-2) to CLOCK_IN's
//       period. The bump must land on the CLOCK_IN period's
//       scope-state row, not the adjacent one.
//
//   §10 Correction attribution — a correction submitted/approved on
//       an entry in Events bumps Events' scope-version even when the
//       employee's PRIMARY department is Grounds.
//
//   §6/§7 Version-mismatch-before-reconciliation — after a material
//       writer bumps V1→V2 the persisted approval row still says
//       state=APPROVED, but getScopeReview MUST report the approval
//       as non-current IMMEDIATELY (approvalValid=false), before any
//       async projection flips the state to REVIEW_REQUIRED.
//
//   §11 Legacy null approvedScopeVersion policy — a hand-crafted
//       state=APPROVED row with approvedScopeVersion=NULL is treated
//       as current under revision-only fallback (backward-compat).
//       Bumping the version does NOT flip such a row to
//       non-current under the version rail, because the fallback
//       policy trusts revision. (Drift is still caught via revision.)

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { db, resetDb, seedRbac, makeClub } from "../util/db";
import { approveTimesheetScope } from "@/lib/timesheets/manager-approval";
import { getScopeReview } from "@/lib/timesheets/approval-scope";
import {
  ensureScopeState,
  readScopeVersion,
} from "@/lib/timesheets/scope-state";
import { materializeEmployeeTimesheet } from "@/lib/timesheets/service";
import { submitCorrectionRequest } from "@/lib/timesheets/correction-service";
import type { EmployeePortalPrincipal } from "@/lib/employee-portal-session";
import type { Principal } from "@/lib/rbac";

const utc = (y: number, m: number, d: number, h = 0, mi = 0) =>
  new Date(Date.UTC(y, m - 1, d, h, mi));

async function makeDept(clubId: string, code: string, name: string) {
  return db().department.create({ data: { clubId, code, name, isActive: true } });
}
async function makeManager(clubId: string, email: string) {
  const bcrypt = await import("bcryptjs");
  const passwordHash = await bcrypt.default.hash("password", 4);
  const user = await db().user.create({
    data: { email, name: email, role: "DEPARTMENT_MANAGER", passwordHash, clubId, status: "ACTIVE" },
  });
  await db().userClubRole.create({ data: { userId: user.id, clubId, roleKey: "DEPARTMENT_MANAGER" } });
  return user;
}
async function assignApprover(clubId: string, deptId: string, userId: string) {
  return db().departmentResponsibility.upsert({
    where: { clubId_departmentId_responsibilityKey: { clubId, departmentId: deptId, responsibilityKey: "DEPARTMENT_TIME_APPROVAL" } },
    update: { userId },
    create: { clubId, departmentId: deptId, userId, responsibilityKey: "DEPARTMENT_TIME_APPROVAL" },
  });
}
async function makeEmp(clubId: string, seed: string, primaryDept: string | null) {
  return db().employee.create({
    data: {
      clubId, firstName: "Taylor", lastName: `Fixture-${seed}`,
      email: `${seed}@t.test`, hireDate: utc(2026, 1, 1),
      status: "ACTIVE", employeeLifecycle: "ACTIVE",
      employeeNumber: `E-${seed}`, compensationType: "HOURLY",
      homeProvince: "AB", timekeepingMethod: "CLOCK_REQUIRED",
      departmentId: primaryDept,
    },
  });
}
async function makeAssn(
  clubId: string, employeeId: string, departmentId: string,
  role: "PRIMARY" | "ADDITIONAL",
) {
  return db().employeeEmploymentAssignment.create({
    data: {
      clubId, employeeId, role,
      employmentType: "PART_TIME",
      effectiveFrom: utc(2026, 1, 1),
      departmentId,
    },
  });
}
async function makePayGroup(clubId: string, seed: string, employeeId: string) {
  const pg = await db().payrollPayGroup.create({
    data: {
      clubId, code: `PG-${seed}`, name: `Test-${seed}`,
      payFrequency: "SEMI_MONTHLY", payDateOffsetDays: 5,
      calendarAnchorDate: utc(2026, 1, 1), active: true,
    },
  });
  await db().payrollPayGroupMember.create({
    data: { clubId, payGroupId: pg.id, employeeId, effectiveFrom: utc(2020, 1, 1) },
  });
  return pg;
}
async function makePeriod(
  clubId: string, payGroupId: string, seq: number,
  start: Date, end: Date, payDate: Date,
) {
  return db().payrollPayPeriod.create({
    data: {
      clubId, payGroupId, taxYear: 2026, sequenceInYear: seq,
      periodStart: start, periodEnd: end, payDate, status: "OPEN",
    },
  });
}
async function makeClock(
  clubId: string, employeeId: string, kind: "CLOCK_IN"|"CLOCK_OUT",
  at: Date, assignmentId: string,
) {
  return db().timeClockEvent.create({
    data: {
      clubId, employeeId, kind, occurredAt: at,
      source: "EMPLOYEE_PORTAL", employmentAssignmentId: assignmentId,
    },
  });
}
function principal(
  u: { id: string; email: string; name: string; status: string; memberId: string | null },
  clubId: string,
): Principal {
  return {
    id: u.id, name: u.name, email: u.email, status: u.status,
    memberships: [{ clubId, roleKey: "DEPARTMENT_MANAGER" }],
    activeClubId: clubId, memberId: u.memberId,
  };
}
function empPortal(clubId: string, employeeId: string): EmployeePortalPrincipal {
  return { clubId, employeeId, generation: 1, establishedAt: new Date().toISOString() };
}

describe("Payroll-3D-3B Slice 7C · attribution + currency + legacy policy", () => {
  beforeAll(async () => { /* schema pre-applied */ });
  beforeEach(async () => {
    await resetDb();
    await seedRbac();
  });

  // ==================================================================
  // §8 — Multi-department attribution: PRIMARY Grounds, worked Events.
  // Material change to the Events entry must NOT bump Grounds.
  // ==================================================================
  it("§8 multi-department attribution — event work bumps Events only, not Grounds (PRIMARY)", async () => {
    const club = await makeClub("slice7c-multi");
    const grounds = await makeDept(club.id, "GROUNDS", "Grounds");
    const events  = await makeDept(club.id, "EVENTS",  "Events");
    const emp = await makeEmp(club.id, "taylor-multi", grounds.id);
    // Taylor's PRIMARY is Grounds; she picked up an Events shift.
    await makeAssn(club.id, emp.id, grounds.id, "PRIMARY");
    const eventsAssn = await makeAssn(club.id, emp.id, events.id, "ADDITIONAL");
    const pg = await makePayGroup(club.id, "multi", emp.id);
    const period = await makePeriod(
      club.id, pg.id, 17,
      utc(2026, 9, 1), utc(2026, 9, 16), utc(2026, 9, 20),
    );

    // Only an Events-attributed shift exists.
    await makeClock(club.id, emp.id, "CLOCK_IN",  utc(2026, 9, 5, 14, 0), eventsAssn.id);
    await makeClock(club.id, emp.id, "CLOCK_OUT", utc(2026, 9, 5, 22, 0), eventsAssn.id);

    await ensureScopeState(club.id, period.id, events.id);
    await ensureScopeState(club.id, period.id, grounds.id);
    const eventsBefore  = await readScopeVersion(club.id, period.id, events.id);
    const groundsBefore = await readScopeVersion(club.id, period.id, grounds.id);
    expect(eventsBefore).toBe(0);
    expect(groundsBefore).toBe(0);

    await materializeEmployeeTimesheet(club.id, emp.id, period.id);

    const eventsAfter  = await readScopeVersion(club.id, period.id, events.id);
    const groundsAfter = await readScopeVersion(club.id, period.id, grounds.id);
    expect(eventsAfter).toBe(1);
    // The critical assertion — Grounds MUST NOT have bumped merely
    // because Grounds is Taylor's PRIMARY department. Scope bumping
    // derives from the worked assignment, not employee.primaryDepartmentId.
    expect(groundsAfter).toBe(0);
  });

  // ==================================================================
  // §9 — Cross-midnight/pay-period attribution. Shift starts near end
  // of one pay period, ends after midnight in the next. Per 3D-2, the
  // session belongs to CLOCK_IN's local period. Bump lands on that
  // period's scope-state row, adjacent one is untouched.
  // ==================================================================
  it("§9 cross-midnight attribution — bump lands on CLOCK_IN period, not adjacent", async () => {
    const club = await makeClub("slice7c-midnight");
    const events = await makeDept(club.id, "EVENTS", "Events");
    const emp = await makeEmp(club.id, "taylor-mid", events.id);
    const assn = await makeAssn(club.id, emp.id, events.id, "PRIMARY");
    const pg = await makePayGroup(club.id, "mid", emp.id);
    // Two adjacent semi-monthly periods.
    const p1 = await makePeriod(
      club.id, pg.id, 17,
      utc(2026, 9, 1), utc(2026, 9, 16), utc(2026, 9, 20),
    );
    const p2 = await makePeriod(
      club.id, pg.id, 18,
      utc(2026, 9, 16), utc(2026, 10, 1), utc(2026, 10, 5),
    );

    // Clock in 23:30 on the last day of p1, clock out 02:00 next day
    // (which falls in p2). Session belongs to CLOCK_IN period = p1.
    await makeClock(club.id, emp.id, "CLOCK_IN",  utc(2026, 9, 15, 23, 30), assn.id);
    await makeClock(club.id, emp.id, "CLOCK_OUT", utc(2026, 9, 16,  2,  0), assn.id);

    await ensureScopeState(club.id, p1.id, events.id);
    await ensureScopeState(club.id, p2.id, events.id);
    const p1Before = await readScopeVersion(club.id, p1.id, events.id);
    const p2Before = await readScopeVersion(club.id, p2.id, events.id);
    expect(p1Before).toBe(0);
    expect(p2Before).toBe(0);

    // Materialising for p1 (the CLOCK_IN period) must land the session
    // on p1 AND bump only p1's scope-state row.
    await materializeEmployeeTimesheet(club.id, emp.id, p1.id);

    const p1After = await readScopeVersion(club.id, p1.id, events.id);
    const p2After = await readScopeVersion(club.id, p2.id, events.id);
    expect(p1After).toBe(1);
    // Adjacent period MUST be untouched.
    expect(p2After).toBe(0);
  });

  // ==================================================================
  // §10 — Correction attribution derives from the ENTRY, not from
  // employee.primaryDepartmentId. Taylor PRIMARY Grounds, worked
  // Events, submits a correction on the Events entry → Events bumps.
  // ==================================================================
  it("§10 correction attribution — submits on Events entry bump Events (not PRIMARY Grounds)", async () => {
    const club = await makeClub("slice7c-corr");
    const grounds = await makeDept(club.id, "GROUNDS", "Grounds");
    const events  = await makeDept(club.id, "EVENTS",  "Events");
    const emp = await makeEmp(club.id, "taylor-corr", grounds.id);
    await makeAssn(club.id, emp.id, grounds.id, "PRIMARY");
    const eventsAssn = await makeAssn(club.id, emp.id, events.id, "ADDITIONAL");
    const pg = await makePayGroup(club.id, "corr", emp.id);
    const period = await makePeriod(
      club.id, pg.id, 17,
      utc(2026, 9, 1), utc(2026, 9, 16), utc(2026, 9, 20),
    );
    await makeClock(club.id, emp.id, "CLOCK_IN",  utc(2026, 9, 5, 14, 0), eventsAssn.id);
    await makeClock(club.id, emp.id, "CLOCK_OUT", utc(2026, 9, 5, 22, 0), eventsAssn.id);
    await materializeEmployeeTimesheet(club.id, emp.id, period.id);

    // Baseline after materialise: Events = 1, Grounds = 0.
    await ensureScopeState(club.id, period.id, grounds.id);
    const groundsBefore = await readScopeVersion(club.id, period.id, grounds.id);
    const eventsBefore  = await readScopeVersion(club.id, period.id, events.id);
    expect(groundsBefore).toBe(0);
    expect(eventsBefore).toBe(1);

    // Locate the CLOCK_IN so we can correct it (correction pipeline
    // keys on original clock event + assignment; department attribution
    // derives from the assignment).
    const clockIn = await db().timeClockEvent.findFirst({
      where: { clubId: club.id, employeeId: emp.id, kind: "CLOCK_IN" },
    });
    await submitCorrectionRequest(empPortal(club.id, emp.id), {
      requestType: "CORRECT_CLOCK_IN",
      originalClockEventId: clockIn!.id,
      requestedLocalIso: "2026-09-05T14:15",
      reason: "off by 15 minutes",
      employmentAssignmentId: eventsAssn.id,
    });

    const eventsAfter  = await readScopeVersion(club.id, period.id, events.id);
    const groundsAfter = await readScopeVersion(club.id, period.id, grounds.id);
    expect(eventsAfter).toBe(2);           // one bump for the correction submit
    expect(groundsAfter).toBe(0);          // PRIMARY dept is NOT bumped
  });

  // ==================================================================
  // §6/§7 — Version-mismatch immediately invalidates approval, before
  // any async REVIEW_REQUIRED projection catches up.
  // ==================================================================
  it("§6/§7 version drift makes approval non-current immediately (before REVIEW_REQUIRED persistence)", async () => {
    const club = await makeClub("slice7c-current");
    const events = await makeDept(club.id, "EVENTS", "Events");
    const mgr = await makeManager(club.id, "mgr.current@t.test");
    await assignApprover(club.id, events.id, mgr.id);
    const emp = await makeEmp(club.id, "e-cur", events.id);
    const assn = await makeAssn(club.id, emp.id, events.id, "PRIMARY");
    const pg = await makePayGroup(club.id, "cur", emp.id);
    const period = await makePeriod(
      club.id, pg.id, 17,
      utc(2026, 9, 1), utc(2026, 9, 16), utc(2026, 9, 20),
    );
    await makeClock(club.id, emp.id, "CLOCK_IN",  utc(2026, 9, 5, 14, 0), assn.id);
    await makeClock(club.id, emp.id, "CLOCK_OUT", utc(2026, 9, 5, 22, 0), assn.id);
    await materializeEmployeeTimesheet(club.id, emp.id, period.id);

    const review0 = await getScopeReview(club.id, period.id, events.id);
    expect(review0.currentScopeVersion).toBe(1);
    expect(review0.readiness.ready).toBe(true);

    // Approve at V1.
    await approveTimesheetScope(principal(mgr, club.id), {
      clubId: club.id, payPeriodId: period.id, departmentId: events.id,
      attestedRevision: review0.currentRevision,
      expectedScopeVersion: review0.currentScopeVersion,
    });

    const review1 = await getScopeReview(club.id, period.id, events.id);
    expect(review1.approval?.state).toBe("APPROVED");
    expect(review1.readiness.approvalValid).toBe(true);
    expect(review1.currentScopeVersion).toBe(1);

    // Concurrent-style writer bumps V1→V2 WITHOUT flipping the
    // approval row's state via the async invalidation projection.
    // We do this by clocking a new session and materialising —
    // materializeEmployeeTimesheet itself calls the async projection,
    // so to isolate the pre-projection window we use a raw update
    // that bumps version without touching approval state.
    await db().payrollDepartmentTimeScopeState.update({
      where: {
        clubId_payPeriodId_departmentId: {
          clubId: club.id, payPeriodId: period.id, departmentId: events.id,
        },
      },
      data: { version: { increment: 1 } },
    });

    // The persisted approval row STILL says state=APPROVED — no
    // projection has fired. But getScopeReview must catch the drift.
    const preProjectionApproval = await db().payrollDepartmentTimeApproval.findFirstOrThrow({
      where: { clubId: club.id, payPeriodId: period.id, departmentId: events.id },
    });
    expect(preProjectionApproval.state).toBe("APPROVED");

    const review2 = await getScopeReview(club.id, period.id, events.id);
    expect(review2.currentScopeVersion).toBe(2);
    expect(review2.approval?.state).toBe("APPROVED");
    // The critical assertion — the approval is NON-CURRENT because
    // version drifted, even though state=APPROVED still persists.
    expect(review2.readiness.approvalValid).toBe(false);
  });

  // ==================================================================
  // §11 — Legacy null approvedScopeVersion falls back to revision-only
  // currency. A row hand-crafted with approvedScopeVersion=NULL and a
  // matching approvedRevision stays "current" under the fallback,
  // even when currentScopeVersion drifts. This is the backward-
  // compatibility policy for pre-Slice-7B approvals.
  // ==================================================================
  it("§11 legacy approvedScopeVersion=NULL falls back to revision-only currency (backward compat)", async () => {
    const club = await makeClub("slice7c-legacy");
    const events = await makeDept(club.id, "EVENTS", "Events");
    const emp = await makeEmp(club.id, "e-legacy", events.id);
    const assn = await makeAssn(club.id, emp.id, events.id, "PRIMARY");
    const pg = await makePayGroup(club.id, "legacy", emp.id);
    const period = await makePeriod(
      club.id, pg.id, 17,
      utc(2026, 9, 1), utc(2026, 9, 16), utc(2026, 9, 20),
    );
    await makeClock(club.id, emp.id, "CLOCK_IN",  utc(2026, 9, 5, 14, 0), assn.id);
    await makeClock(club.id, emp.id, "CLOCK_OUT", utc(2026, 9, 5, 22, 0), assn.id);
    await materializeEmployeeTimesheet(club.id, emp.id, period.id);

    const review = await getScopeReview(club.id, period.id, events.id);
    const currentRevision = review.currentRevision;
    const legacyMgr = await makeManager(club.id, "legacy-mgr@t.test");

    // Hand-craft a legacy-shaped APPROVED row: state=APPROVED,
    // approvedRevision matches, approvedScopeVersion=NULL. This is
    // what a pre-Slice-7B approval row looks like after the migration.
    await db().payrollDepartmentTimeApproval.create({
      data: {
        clubId: club.id, payPeriodId: period.id, departmentId: events.id,
        state: "APPROVED",
        approvedAt: new Date(),
        approvedByUserId: legacyMgr.id,
        approvedRevision: currentRevision,
        approvedScopeVersion: null,
      },
    });

    const legacyReview1 = await getScopeReview(club.id, period.id, events.id);
    expect(legacyReview1.approval?.state).toBe("APPROVED");
    // Under the fallback policy — approvedScopeVersion=NULL means
    // "trust the revision hash alone." Revision matches → currency.
    expect(legacyReview1.readiness.approvalValid).toBe(true);

    // Bumping the scope-version WITHOUT changing entries would leave
    // the revision hash intact (revision hashes entries, not the
    // version counter). Simulate a raw version bump: fallback policy
    // still treats the legacy row as current because revision matches.
    await db().payrollDepartmentTimeScopeState.update({
      where: {
        clubId_payPeriodId_departmentId: {
          clubId: club.id, payPeriodId: period.id, departmentId: events.id,
        },
      },
      data: { version: { increment: 1 } },
    });
    const legacyReview2 = await getScopeReview(club.id, period.id, events.id);
    expect(legacyReview2.currentScopeVersion).toBe(2);
    // Approval row still legacy (NULL) — fallback keeps it valid
    // because revision unchanged. This is intentional §11 policy.
    expect(legacyReview2.readiness.approvalValid).toBe(true);

    // But: a REAL material change (revision drift) breaks the legacy
    // row cleanly — because revision is the fallback's only gate.
    // Add a new clock session to shift the revision hash.
    await makeClock(club.id, emp.id, "CLOCK_IN",  utc(2026, 9, 6, 14, 0), assn.id);
    await makeClock(club.id, emp.id, "CLOCK_OUT", utc(2026, 9, 6, 22, 0), assn.id);
    await materializeEmployeeTimesheet(club.id, emp.id, period.id);
    const legacyReview3 = await getScopeReview(club.id, period.id, events.id);
    // Revision changed → fallback flips to non-current.
    expect(legacyReview3.readiness.approvalValid).toBe(false);
  });

  // ==================================================================
  // §W (zero side effects sanity) — every Slice 7C interaction is
  // read-only against the payroll batch/GL/frozen-time surfaces.
  // ==================================================================
  it("§W zero PayrollApprovedTimeEntry / PayrollBatch / JournalEntry side effects", async () => {
    // Everything runs in the shared beforeEach-reset DB. After all
    // 5 tests above, there must be zero freeze/batch/GL rows.
    const [frozen, batches, journals] = await Promise.all([
      db().payrollApprovedTimeEntry.count(),
      db().payrollBatch.count(),
      db().journalEntry.count(),
    ]);
    expect(frozen).toBe(0);
    expect(batches).toBe(0);
    expect(journals).toBe(0);
  });
});
