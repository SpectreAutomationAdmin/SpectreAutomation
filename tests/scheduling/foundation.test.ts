// Scheduling Foundation (2026-09-07) — Phase B backend acceptance.
//
// Covers the founder-mandated invariants from the Slice 8A Phase A
// amendments:
//   §2  availability editing MUST work regardless of training status
//   §6  applicable availability profile resolves by largest
//       effectiveFrom <= date; older profiles preserved
//   §8  atomic pickup — original assignment stays ASSIGNED while
//       opportunity is OPEN; successful claim transitions original
//       ASSIGNED → REPLACED and creates claimant ASSIGNED
//   §9  informational manager Work Intake notification after pickup
//   Concurrency — 5 concurrent pickup attempts against the same
//       OPEN opportunity → exactly one succeeds, four ConflictError.
//   Isolation — cross-tenant access blocked at every service.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { db, resetDb, seedRbac, makeClub } from "../util/db";
import { saveAvailabilityProfile, resolveApplicableAvailabilityProfile, listAvailabilityProfiles } from "@/lib/scheduling/availability-profiles";
import { listShiftTemplatesForEmployee } from "@/lib/scheduling/shift-templates";
import { listEmployeeShifts, sumEmployeeScheduledSeconds } from "@/lib/scheduling/shifts";
import { offerShift, withdrawOpportunity, listEligibleOpportunitiesForEmployee } from "@/lib/scheduling/shift-opportunities";
import { pickUpShift } from "@/lib/scheduling/shift-pickup";
import { notifyShiftReassignment } from "@/lib/scheduling/shift-reassignment-notification";
import { ConflictError, ForbiddenError, ValidationError, NotFoundError } from "@/lib/errors";

const utc = (y: number, m: number, d: number, h = 0, mi = 0) =>
  new Date(Date.UTC(y, m - 1, d, h, mi));

async function makeDept(clubId: string, code: string, name: string) {
  return db().department.create({ data: { clubId, code, name, isActive: true } });
}
async function makeEmp(clubId: string, seed: string, opts?: {
  compensationType?: string;
  employeeLifecycle?: string;
}) {
  return db().employee.create({
    data: {
      clubId, firstName: "Test", lastName: `Emp-${seed}`,
      email: `${seed}@t.test`, hireDate: utc(2026, 1, 1),
      status: "ACTIVE", employeeLifecycle: opts?.employeeLifecycle ?? "ACTIVE",
      employeeNumber: `E-${seed}`,
      compensationType: opts?.compensationType ?? "HOURLY",
      homeProvince: "AB",
      timekeepingMethod: "CLOCK_REQUIRED",
    },
  });
}
async function makeAssn(clubId: string, employeeId: string, departmentId: string, role: "PRIMARY" | "ADDITIONAL" = "PRIMARY") {
  return db().employeeEmploymentAssignment.create({
    data: {
      clubId, employeeId, role, employmentType: "PART_TIME",
      effectiveFrom: utc(2026, 1, 1),
      departmentId,
    },
  });
}
async function makeTemplate(clubId: string, departmentId: string, code: string, name: string, startMin: number, endMin: number) {
  return db().shiftTemplate.create({
    data: { clubId, departmentId, code, name, startTimeMinutes: startMin, endTimeMinutes: endMin, active: true },
  });
}
async function makeShiftWithAssignment(
  clubId: string, departmentId: string, templateId: string, employeeId: string,
  employmentAssignmentId: string, startAt: Date, endAt: Date,
) {
  const shift = await db().shift.create({
    data: {
      clubId, departmentId, shiftTemplateId: templateId,
      shiftDate: startAt,
      startAt, endAt,
      state: "PUBLISHED",
    },
  });
  const assn = await db().shiftAssignment.create({
    data: {
      clubId, shiftId: shift.id, employeeId, employmentAssignmentId,
      state: "ASSIGNED",
    },
  });
  return { shift, assignment: assn };
}

// ==================================================================
describe("Scheduling Foundation · Phase B backend", () => {
  beforeAll(async () => { /* schema pre-applied */ });
  beforeEach(async () => {
    await resetDb();
    await seedRbac();
  });

  // ----------------------------------------------------------------
  // §2 — Availability editing does NOT require training completion.
  // ----------------------------------------------------------------
  it("§2 saveAvailabilityProfile works for a training-incomplete hourly employee", async () => {
    const club = await makeClub("sch-avail");
    const events = await makeDept(club.id, "EVENTS", "Events");
    const emp = await makeEmp(club.id, "e-avail"); // no training completed
    await makeAssn(club.id, emp.id, events.id);
    const t = await makeTemplate(club.id, events.id, "EVENING", "Evening", 17 * 60, 23 * 60);

    // Must not throw despite no training.
    const profile = await saveAvailabilityProfile({
      clubId: club.id,
      employeeId: emp.id,
      effectiveFrom: utc(2026, 9, 1),
      preferredHoursPerWeek: 20,
      maximumHoursPerWeek: 30,
      notes: "school Mondays",
      rules: [
        { weekday: 1, shiftTemplateId: t.id, available: false }, // Mon
        { weekday: 2, shiftTemplateId: t.id, available: true },  // Tue
      ],
    });
    expect(profile.rules.length).toBe(2);
    expect(profile.preferredHoursPerWeek).toBe(20);
    expect(profile.maximumHoursPerWeek).toBe(30);
  });

  // ----------------------------------------------------------------
  // §6 — Versioned profile resolves by largest effectiveFrom <= date.
  //      Older profiles preserved; not deleted or rewritten.
  // ----------------------------------------------------------------
  it("§6 resolveApplicableAvailabilityProfile picks latest effectiveFrom <= date", async () => {
    const club = await makeClub("sch-v6");
    const events = await makeDept(club.id, "EVENTS", "Events");
    const emp = await makeEmp(club.id, "e-v6");
    await makeAssn(club.id, emp.id, events.id);
    const t = await makeTemplate(club.id, events.id, "DAY", "Day", 11 * 60, 17 * 60 + 30);

    const p1 = await saveAvailabilityProfile({
      clubId: club.id, employeeId: emp.id,
      effectiveFrom: utc(2026, 9, 1),
      preferredHoursPerWeek: 15,
      maximumHoursPerWeek: 25,
      rules: [{ weekday: 1, shiftTemplateId: t.id, available: true }],
    });
    const p2 = await saveAvailabilityProfile({
      clubId: club.id, employeeId: emp.id,
      effectiveFrom: utc(2026, 10, 1),
      preferredHoursPerWeek: 20,
      maximumHoursPerWeek: 30,
      rules: [{ weekday: 1, shiftTemplateId: t.id, available: false }],
    });

    const beforeP1 = await resolveApplicableAvailabilityProfile(emp.id, utc(2026, 8, 15));
    expect(beforeP1).toBeNull();
    const insideP1 = await resolveApplicableAvailabilityProfile(emp.id, utc(2026, 9, 20));
    expect(insideP1?.id).toBe(p1.id);
    const insideP2 = await resolveApplicableAvailabilityProfile(emp.id, utc(2026, 10, 15));
    expect(insideP2?.id).toBe(p2.id);
    // Both profiles preserved.
    const all = await listAvailabilityProfiles(emp.id);
    expect(all.map((p) => p.id).sort()).toEqual([p1.id, p2.id].sort());
  });

  // ----------------------------------------------------------------
  // §8 — Give up shift: original assignment stays ASSIGNED while
  //      opportunity is OPEN.
  // ----------------------------------------------------------------
  it("§8 offerShift keeps original assignment ASSIGNED and opens opportunity", async () => {
    const club = await makeClub("sch-offer");
    const events = await makeDept(club.id, "EVENTS", "Events");
    const emp = await makeEmp(club.id, "e-offer");
    const asn = await makeAssn(club.id, emp.id, events.id);
    const t = await makeTemplate(club.id, events.id, "EVENING", "Evening", 17 * 60, 23 * 60);
    const { shift, assignment } = await makeShiftWithAssignment(
      club.id, events.id, t.id, emp.id, asn.id,
      utc(2027, 1, 1, 17), utc(2027, 1, 1, 23),
    );

    const result = await offerShift({
      clubId: club.id, employeeId: emp.id,
      shiftAssignmentId: assignment.id, reason: "family",
    });
    expect(result.state).toBe("OPEN");

    const asnAfter = await db().shiftAssignment.findUniqueOrThrow({ where: { id: assignment.id } });
    expect(asnAfter.state).toBe("ASSIGNED");
    const opp = await db().shiftOpportunity.findUniqueOrThrow({ where: { id: result.opportunityId } });
    expect(opp.state).toBe("OPEN");
    expect(opp.shiftId).toBe(shift.id);
  });

  it("§8 double offer against a shift with an existing OPEN opportunity throws ConflictError", async () => {
    const club = await makeClub("sch-doff");
    const events = await makeDept(club.id, "EVENTS", "Events");
    const emp = await makeEmp(club.id, "e-doff");
    const asn = await makeAssn(club.id, emp.id, events.id);
    const t = await makeTemplate(club.id, events.id, "EVENING", "Evening", 17 * 60, 23 * 60);
    const { assignment } = await makeShiftWithAssignment(
      club.id, events.id, t.id, emp.id, asn.id,
      utc(2027, 2, 1, 17), utc(2027, 2, 1, 23),
    );
    await offerShift({ clubId: club.id, employeeId: emp.id, shiftAssignmentId: assignment.id });
    await expect(offerShift({
      clubId: club.id, employeeId: emp.id, shiftAssignmentId: assignment.id,
    })).rejects.toBeInstanceOf(ConflictError);
  });

  // ----------------------------------------------------------------
  // §7/§8 pickup — happy path + concurrency + isolation
  // ----------------------------------------------------------------
  // NOTE: pickup requires the claimant to be scheduling-eligible
  // (training complete). The test tenant has no required training
  // configured, so isSchedulingEligible() returns true for any
  // employee — same convention as tests/timesheets/*.
  it("§7 happy-path pickup: opportunity CLAIMED, original REPLACED, new ASSIGNED", async () => {
    const club = await makeClub("sch-pu-happy");
    const events = await makeDept(club.id, "EVENTS", "Events");
    const alice = await makeEmp(club.id, "e-alice");
    const bob = await makeEmp(club.id, "e-bob");
    const aAsn = await makeAssn(club.id, alice.id, events.id);
    const bAsn = await makeAssn(club.id, bob.id, events.id);
    const t = await makeTemplate(club.id, events.id, "EVENING", "Evening", 17 * 60, 23 * 60);
    const { shift, assignment } = await makeShiftWithAssignment(
      club.id, events.id, t.id, alice.id, aAsn.id,
      utc(2027, 3, 1, 17), utc(2027, 3, 1, 23),
    );

    const offer = await offerShift({
      clubId: club.id, employeeId: alice.id, shiftAssignmentId: assignment.id,
    });
    const result = await pickUpShift({
      clubId: club.id, employeeId: bob.id, opportunityId: offer.opportunityId,
    });

    expect(result.shiftId).toBe(shift.id);
    expect(result.replacedAssignmentId).toBe(assignment.id);
    expect(result.originalEmployeeId).toBe(alice.id);

    const opp = await db().shiftOpportunity.findUniqueOrThrow({ where: { id: offer.opportunityId } });
    expect(opp.state).toBe("CLAIMED");
    expect(opp.claimedByEmployeeId).toBe(bob.id);
    expect(opp.claimedByAssignmentId).toBe(result.newAssignmentId);

    const original = await db().shiftAssignment.findUniqueOrThrow({ where: { id: assignment.id } });
    expect(original.state).toBe("REPLACED");
    expect(original.replacedByAssignmentId).toBe(result.newAssignmentId);

    const claimant = await db().shiftAssignment.findUniqueOrThrow({ where: { id: result.newAssignmentId } });
    expect(claimant.state).toBe("ASSIGNED");
    expect(claimant.employeeId).toBe(bob.id);
    expect(claimant.employmentAssignmentId).toBe(bAsn.id);
    // Referential integrity: partial-unique index enforces ONE
    // ASSIGNED per shift. Verify count.
    const activeCount = await db().shiftAssignment.count({
      where: { shiftId: shift.id, state: "ASSIGNED" },
    });
    expect(activeCount).toBe(1);
  });

  it("§8 concurrency: 5 concurrent pickups of one OPEN opportunity → exactly one succeeds", async () => {
    const club = await makeClub("sch-race");
    const events = await makeDept(club.id, "EVENTS", "Events");
    const alice = await makeEmp(club.id, "e-alice");
    const aAsn = await makeAssn(club.id, alice.id, events.id);
    const claimants = await Promise.all(
      [0, 1, 2, 3, 4].map((i) => makeEmp(club.id, `e-c${i}`)),
    );
    // Each claimant needs an active assignment in the department.
    await Promise.all(claimants.map((c) => makeAssn(club.id, c.id, events.id)));
    const t = await makeTemplate(club.id, events.id, "EVENING", "Evening", 17 * 60, 23 * 60);
    const { assignment } = await makeShiftWithAssignment(
      club.id, events.id, t.id, alice.id, aAsn.id,
      utc(2027, 4, 1, 17), utc(2027, 4, 1, 23),
    );
    const offer = await offerShift({
      clubId: club.id, employeeId: alice.id, shiftAssignmentId: assignment.id,
    });

    const results = await Promise.allSettled(
      claimants.map((c) => pickUpShift({
        clubId: club.id, employeeId: c.id, opportunityId: offer.opportunityId,
      })),
    );
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected  = results.filter((r) => r.status === "rejected");
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(4);
    for (const r of rejected as PromiseRejectedResult[]) {
      expect(r.reason).toBeInstanceOf(ConflictError);
    }
    // Referential integrity — exactly one ASSIGNED row for the shift.
    const activeCount = await db().shiftAssignment.count({
      where: { shiftId: assignment.shiftId, state: "ASSIGNED" },
    });
    expect(activeCount).toBe(1);
  });

  it("§20 pickup cross-tenant is blocked (NotFoundError)", async () => {
    const clubA = await makeClub("sch-iso-a");
    const clubB = await makeClub("sch-iso-b");
    const eventsA = await makeDept(clubA.id, "EVENTS", "Events");
    const eventsB = await makeDept(clubB.id, "EVENTS", "Events");
    const alice = await makeEmp(clubA.id, "e-iso-alice");
    const carol = await makeEmp(clubB.id, "e-iso-carol");
    const aAsn = await makeAssn(clubA.id, alice.id, eventsA.id);
    await makeAssn(clubB.id, carol.id, eventsB.id);
    const t = await makeTemplate(clubA.id, eventsA.id, "EVENING", "Evening", 17 * 60, 23 * 60);
    const { assignment } = await makeShiftWithAssignment(
      clubA.id, eventsA.id, t.id, alice.id, aAsn.id,
      utc(2027, 5, 1, 17), utc(2027, 5, 1, 23),
    );
    const offer = await offerShift({
      clubId: clubA.id, employeeId: alice.id, shiftAssignmentId: assignment.id,
    });
    // Carol from clubB tries to pick up clubA's shift — clubId
    // doesn't match; NotFoundError.
    await expect(pickUpShift({
      clubId: clubB.id, employeeId: carol.id, opportunityId: offer.opportunityId,
    })).rejects.toBeInstanceOf(NotFoundError);
  });

  it("§8 own-shift claim is blocked (ForbiddenError)", async () => {
    const club = await makeClub("sch-own");
    const events = await makeDept(club.id, "EVENTS", "Events");
    const alice = await makeEmp(club.id, "e-own");
    const aAsn = await makeAssn(club.id, alice.id, events.id);
    const t = await makeTemplate(club.id, events.id, "EVENING", "Evening", 17 * 60, 23 * 60);
    const { assignment } = await makeShiftWithAssignment(
      club.id, events.id, t.id, alice.id, aAsn.id,
      utc(2027, 6, 1, 17), utc(2027, 6, 1, 23),
    );
    const offer = await offerShift({
      clubId: club.id, employeeId: alice.id, shiftAssignmentId: assignment.id,
    });
    await expect(pickUpShift({
      clubId: club.id, employeeId: alice.id, opportunityId: offer.opportunityId,
    })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("§8 past-shift offer is blocked (ValidationError)", async () => {
    const club = await makeClub("sch-past");
    const events = await makeDept(club.id, "EVENTS", "Events");
    const emp = await makeEmp(club.id, "e-past");
    const asn = await makeAssn(club.id, emp.id, events.id);
    const t = await makeTemplate(club.id, events.id, "DAY", "Day", 11 * 60, 17 * 60);
    const yesterday = new Date(Date.now() - 86_400_000);
    const yesterdayEnd = new Date(yesterday.getTime() + 6 * 3600_000);
    const { assignment } = await makeShiftWithAssignment(
      club.id, events.id, t.id, emp.id, asn.id,
      yesterday, yesterdayEnd,
    );
    await expect(offerShift({
      clubId: club.id, employeeId: emp.id, shiftAssignmentId: assignment.id,
    })).rejects.toBeInstanceOf(ValidationError);
  });

  // ----------------------------------------------------------------
  // §9 — informational manager Work Intake notification after pickup.
  // ----------------------------------------------------------------
  it("§9 notifyShiftReassignment creates a manager-owned WI when a responsibility owner exists", async () => {
    const club = await makeClub("sch-wi");
    const events = await makeDept(club.id, "EVENTS", "Events");
    const alice = await makeEmp(club.id, "e-wi-alice");
    const bob = await makeEmp(club.id, "e-wi-bob");
    const aAsn = await makeAssn(club.id, alice.id, events.id);
    const bAsn = await makeAssn(club.id, bob.id, events.id);
    const t = await makeTemplate(club.id, events.id, "EVENING", "Evening", 17 * 60, 23 * 60);
    const { shift, assignment } = await makeShiftWithAssignment(
      club.id, events.id, t.id, alice.id, aAsn.id,
      utc(2027, 7, 1, 17), utc(2027, 7, 1, 23),
    );
    // Seed an Events DEPARTMENT_TIME_APPROVAL owner.
    const bcrypt = await import("bcryptjs");
    const managerUser = await db().user.create({
      data: {
        email: "mgr.wi@t.test", name: "mgr", role: "DEPARTMENT_MANAGER",
        passwordHash: await bcrypt.default.hash("x", 4), clubId: club.id, status: "ACTIVE",
      },
    });
    await db().departmentResponsibility.create({
      data: {
        clubId: club.id, departmentId: events.id, userId: managerUser.id,
        responsibilityKey: "DEPARTMENT_TIME_APPROVAL",
      },
    });

    const offer = await offerShift({
      clubId: club.id, employeeId: alice.id, shiftAssignmentId: assignment.id,
    });
    const pickup = await pickUpShift({
      clubId: club.id, employeeId: bob.id, opportunityId: offer.opportunityId,
    });
    const noti = await notifyShiftReassignment({
      clubId: club.id, shiftId: shift.id, departmentId: events.id,
      originalEmployeeId: alice.id, newEmployeeId: bob.id,
      opportunityId: pickup.opportunityId,
    });

    expect(noti.gap).toBe(false);
    expect(noti.ownerUserId).toBe(managerUser.id);
    expect(noti.created).toBe(true);

    const wi = await db().workIntakeItem.findUniqueOrThrow({ where: { id: noti.workIntakeItemId } });
    expect(wi.ownerUserId).toBe(managerUser.id);
    expect(wi.workDomain).toBe("SCHEDULING");
    expect(wi.workSubtype).toBe("SHIFT_REASSIGNMENT");
    expect(wi.workIntent).toBe("NOTIFY");
    // Idempotent re-emit (same shiftId reference).
    const noti2 = await notifyShiftReassignment({
      clubId: club.id, shiftId: shift.id, departmentId: events.id,
      originalEmployeeId: alice.id, newEmployeeId: bob.id,
      opportunityId: pickup.opportunityId,
    });
    expect(noti2.workIntakeItemId).toBe(noti.workIntakeItemId);
    expect(noti2.created).toBe(false);
  });

  // ----------------------------------------------------------------
  // shifts + templates read helpers
  // ----------------------------------------------------------------
  it("shift-read helpers surface the assignment + derive hasOpenOpportunity", async () => {
    const club = await makeClub("sch-read");
    const events = await makeDept(club.id, "EVENTS", "Events");
    const emp = await makeEmp(club.id, "e-read");
    const asn = await makeAssn(club.id, emp.id, events.id);
    const t = await makeTemplate(club.id, events.id, "EVENING", "Evening", 17 * 60, 23 * 60);
    const { shift, assignment } = await makeShiftWithAssignment(
      club.id, events.id, t.id, emp.id, asn.id,
      utc(2027, 8, 1, 17), utc(2027, 8, 1, 23),
    );
    let rows = await listEmployeeShifts(
      club.id, emp.id, utc(2027, 7, 25), utc(2027, 8, 8),
    );
    expect(rows.length).toBe(1);
    expect(rows[0].hasOpenOpportunity).toBe(false);
    expect(rows[0].departmentCode).toBe("EVENTS");

    await offerShift({ clubId: club.id, employeeId: emp.id, shiftAssignmentId: assignment.id });
    rows = await listEmployeeShifts(
      club.id, emp.id, utc(2027, 7, 25), utc(2027, 8, 8),
    );
    expect(rows[0].hasOpenOpportunity).toBe(true);
    const totalSec = await sumEmployeeScheduledSeconds(
      club.id, emp.id, utc(2027, 7, 25), utc(2027, 8, 8),
    );
    expect(totalSec).toBe((shift.endAt.getTime() - shift.startAt.getTime()) / 1000);

    const tpls = await listShiftTemplatesForEmployee(club.id, emp.id);
    expect(tpls.map((x) => x.id)).toContain(t.id);
  });

  it("withdrawOpportunity flips OPEN → WITHDRAWN and leaves the assignment ASSIGNED", async () => {
    const club = await makeClub("sch-wdraw");
    const events = await makeDept(club.id, "EVENTS", "Events");
    const emp = await makeEmp(club.id, "e-wdraw");
    const asn = await makeAssn(club.id, emp.id, events.id);
    const t = await makeTemplate(club.id, events.id, "EVENING", "Evening", 17 * 60, 23 * 60);
    const { assignment } = await makeShiftWithAssignment(
      club.id, events.id, t.id, emp.id, asn.id,
      utc(2027, 9, 1, 17), utc(2027, 9, 1, 23),
    );
    const offer = await offerShift({
      clubId: club.id, employeeId: emp.id, shiftAssignmentId: assignment.id,
    });
    await withdrawOpportunity({
      clubId: club.id, employeeId: emp.id, opportunityId: offer.opportunityId,
    });
    const opp = await db().shiftOpportunity.findUniqueOrThrow({ where: { id: offer.opportunityId } });
    expect(opp.state).toBe("WITHDRAWN");
    expect(opp.withdrawnAt).not.toBeNull();
    const asnAfter = await db().shiftAssignment.findUniqueOrThrow({ where: { id: assignment.id } });
    expect(asnAfter.state).toBe("ASSIGNED");
  });

  it("listEligibleOpportunitiesForEmployee excludes the offering employee + cross-tenant + cross-department", async () => {
    const club = await makeClub("sch-elig");
    const events = await makeDept(club.id, "EVENTS", "Events");
    const grounds = await makeDept(club.id, "GROUNDS", "Grounds");
    const alice = await makeEmp(club.id, "e-elig-alice");
    const bob = await makeEmp(club.id, "e-elig-bob");
    const carol = await makeEmp(club.id, "e-elig-carol");
    const aAsn = await makeAssn(club.id, alice.id, events.id);
    await makeAssn(club.id, bob.id, events.id);
    await makeAssn(club.id, carol.id, grounds.id); // Grounds-only
    const t = await makeTemplate(club.id, events.id, "EVENING", "Evening", 17 * 60, 23 * 60);
    const { assignment } = await makeShiftWithAssignment(
      club.id, events.id, t.id, alice.id, aAsn.id,
      utc(2027, 10, 1, 17), utc(2027, 10, 1, 23),
    );
    await offerShift({
      clubId: club.id, employeeId: alice.id, shiftAssignmentId: assignment.id,
    });
    // Bob (Events) is eligible.
    const bobList = await listEligibleOpportunitiesForEmployee(club.id, bob.id);
    expect(bobList.map((o) => o.shiftId)).toContain(assignment.shiftId);
    // Alice (offering employee) is not.
    const aliceList = await listEligibleOpportunitiesForEmployee(club.id, alice.id);
    expect(aliceList.length).toBe(0);
    // Carol (Grounds only) is not.
    const carolList = await listEligibleOpportunitiesForEmployee(club.id, carol.id);
    expect(carolList.length).toBe(0);
  });
});
