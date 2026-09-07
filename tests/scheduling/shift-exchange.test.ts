// Scheduling Foundation · Phase E (2026-09-07) — shift-exchange
// service-level tests.
//
// Covers the amendments layered on top of Phase B's offer/pickup:
//   §11 position/role qualification (Busser cannot pick up a Bartender shift)
//   §12 availability profile enforcement on eligibility + pickup
//   §13 overlap detection (including overnight)
//   §14 offering employee identity NOT surfaced to eligible list
//   §16 concurrent pickup — exactly one wins, others ConflictError
//   §18 notifyShiftReassignment emitted with SHIFT_REASSIGNMENT_NOTIFICATION
//        origin, correct department routing
//   §19 notification idempotency (repeated calls update same WI item)

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { db, resetDb, seedRbac, makeClub } from "../util/db";
import {
  offerShift,
  listEligibleOpportunitiesForEmployee,
  withdrawOpportunity,
} from "@/lib/scheduling/shift-opportunities";
import { pickUpShift } from "@/lib/scheduling/shift-pickup";
import { notifyShiftReassignment } from "@/lib/scheduling/shift-reassignment-notification";
import { saveAvailabilityProfile } from "@/lib/scheduling/availability-profiles";
import { ConflictError, ForbiddenError, NotFoundError } from "@/lib/errors";

const utc = (y: number, m: number, d: number, h = 0, mi = 0) =>
  new Date(Date.UTC(y, m - 1, d, h, mi));

async function makeDept(clubId: string, code: string, name: string) {
  return db().department.create({ data: { clubId, code, name, isActive: true } });
}
async function makePosition(clubId: string, departmentId: string, code: string, name: string) {
  return db().employeePosition.create({
    data: { clubId, departmentId, code, name, defaultPayRate: 20, isActive: true },
  });
}
async function makeEmp(clubId: string, seed: string) {
  return db().employee.create({
    data: {
      clubId, firstName: "Test", lastName: `Emp-${seed}`,
      email: `${seed}@t.test`, hireDate: utc(2026, 1, 1),
      status: "ACTIVE", employeeLifecycle: "ACTIVE",
      employeeNumber: `E-${seed}`, compensationType: "HOURLY",
      homeProvince: "AB", timekeepingMethod: "CLOCK_REQUIRED",
    },
  });
}
async function makeAssn(
  clubId: string, employeeId: string, departmentId: string,
  positionId: string | null = null,
  role: "PRIMARY" | "ADDITIONAL" = "PRIMARY",
) {
  return db().employeeEmploymentAssignment.create({
    data: {
      clubId, employeeId, role, employmentType: "PART_TIME",
      effectiveFrom: utc(2026, 1, 1),
      departmentId, positionId,
    },
  });
}
async function makeTemplate(clubId: string, departmentId: string, code: string, name: string, startMin: number, endMin: number) {
  return db().shiftTemplate.create({
    data: { clubId, departmentId, code, name, startTimeMinutes: startMin, endTimeMinutes: endMin, active: true },
  });
}
async function makeShiftAssignment(
  clubId: string, departmentId: string, templateId: string, employeeId: string,
  employmentAssignmentId: string, startAt: Date, endAt: Date, positionId: string | null = null,
) {
  const shift = await db().shift.create({
    data: {
      clubId, departmentId, shiftTemplateId: templateId, positionId,
      shiftDate: startAt, startAt, endAt, state: "PUBLISHED",
    },
  });
  const assn = await db().shiftAssignment.create({
    data: {
      clubId, shiftId: shift.id, employeeId, employmentAssignmentId, state: "ASSIGNED",
    },
  });
  return { shift, assignment: assn };
}

describe("Scheduling Foundation · Phase E · shift exchange", () => {
  beforeAll(async () => { /* schema pre-applied */ });
  beforeEach(async () => {
    await resetDb();
    await seedRbac();
  });

  // ----------------------------------------------------------------
  // §11 position/role qualification
  // ----------------------------------------------------------------
  it("§11 Busser cannot pick up a Bartender-pinned shift", async () => {
    const club = await makeClub("phE-pos");
    const fnb = await makeDept(club.id, "FNB", "Food & Beverage");
    const bartender = await makePosition(club.id, fnb.id, "BAR", "Bartender");
    const busser = await makePosition(club.id, fnb.id, "BUS", "Busser");
    const alice = await makeEmp(club.id, "alice-bar");
    const aAsn = await makeAssn(club.id, alice.id, fnb.id, bartender.id);
    const bob = await makeEmp(club.id, "bob-bus");
    await makeAssn(club.id, bob.id, fnb.id, busser.id);

    const t = await makeTemplate(club.id, fnb.id, "EVENING", "Evening", 17 * 60, 23 * 60);
    const { assignment } = await makeShiftAssignment(
      club.id, fnb.id, t.id, alice.id, aAsn.id,
      utc(2027, 1, 12, 17), utc(2027, 1, 12, 23), bartender.id,
    );
    const offer = await offerShift({
      clubId: club.id, employeeId: alice.id, shiftAssignmentId: assignment.id,
    });

    // Bob is NOT in Bob's eligibility list.
    const bobList = await listEligibleOpportunitiesForEmployee(club.id, bob.id);
    expect(bobList.length).toBe(0);
    // Pickup is refused server-side too.
    await expect(pickUpShift({
      clubId: club.id, employeeId: bob.id, opportunityId: offer.opportunityId,
    })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("§11 Bartender with an ADDITIONAL assignment IS qualified", async () => {
    const club = await makeClub("phE-pos-add");
    const fnb = await makeDept(club.id, "FNB", "Food & Beverage");
    const bartender = await makePosition(club.id, fnb.id, "BAR", "Bartender");
    const busser = await makePosition(club.id, fnb.id, "BUS", "Busser");
    const alice = await makeEmp(club.id, "alice-bar2");
    const aAsn = await makeAssn(club.id, alice.id, fnb.id, bartender.id);
    const chris = await makeEmp(club.id, "chris-cross");
    await makeAssn(club.id, chris.id, fnb.id, busser.id, "PRIMARY");
    await makeAssn(club.id, chris.id, fnb.id, bartender.id, "ADDITIONAL");
    const t = await makeTemplate(club.id, fnb.id, "EVENING", "Evening", 17 * 60, 23 * 60);
    const { assignment } = await makeShiftAssignment(
      club.id, fnb.id, t.id, alice.id, aAsn.id,
      utc(2027, 1, 13, 17), utc(2027, 1, 13, 23), bartender.id,
    );
    const offer = await offerShift({
      clubId: club.id, employeeId: alice.id, shiftAssignmentId: assignment.id,
    });
    const chrisList = await listEligibleOpportunitiesForEmployee(club.id, chris.id);
    expect(chrisList.map((o) => o.id)).toContain(offer.opportunityId);
    const result = await pickUpShift({
      clubId: club.id, employeeId: chris.id, opportunityId: offer.opportunityId,
    });
    expect(result.newAssignmentId).toBeTruthy();
  });

  // ----------------------------------------------------------------
  // §13 overlap detection (including overnight)
  // ----------------------------------------------------------------
  it("§13 overlapping ASSIGNED shift prevents pickup (evening + evening)", async () => {
    const club = await makeClub("phE-overlap");
    const events = await makeDept(club.id, "EVENTS", "Events");
    const alice = await makeEmp(club.id, "alice-o1");
    const aAsn = await makeAssn(club.id, alice.id, events.id);
    const bob = await makeEmp(club.id, "bob-o1");
    const bAsn = await makeAssn(club.id, bob.id, events.id);
    const t = await makeTemplate(club.id, events.id, "EVENING", "Evening", 17 * 60, 23 * 60);
    // Bob already has 18:00-22:00 that day.
    await makeShiftAssignment(
      club.id, events.id, t.id, bob.id, bAsn.id,
      utc(2027, 1, 15, 18), utc(2027, 1, 15, 22),
    );
    // Alice offers 17:00-23:00 same day.
    const { assignment } = await makeShiftAssignment(
      club.id, events.id, t.id, alice.id, aAsn.id,
      utc(2027, 1, 15, 17), utc(2027, 1, 15, 23),
    );
    const offer = await offerShift({
      clubId: club.id, employeeId: alice.id, shiftAssignmentId: assignment.id,
    });
    // Bob's list excludes the overlapping offer.
    const bobList = await listEligibleOpportunitiesForEmployee(club.id, bob.id);
    expect(bobList.length).toBe(0);
    await expect(pickUpShift({
      clubId: club.id, employeeId: bob.id, opportunityId: offer.opportunityId,
    })).rejects.toBeInstanceOf(ConflictError);
  });

  it("§13 overnight shift overlap detected across midnight", async () => {
    const club = await makeClub("phE-overlap-mid");
    const events = await makeDept(club.id, "EVENTS", "Events");
    const alice = await makeEmp(club.id, "alice-mid");
    const aAsn = await makeAssn(club.id, alice.id, events.id);
    const bob = await makeEmp(club.id, "bob-mid");
    const bAsn = await makeAssn(club.id, bob.id, events.id);
    const t = await makeTemplate(club.id, events.id, "EVENING", "Evening", 17 * 60, 23 * 60);
    // Bob has 01:00-05:00 on Jan 20 (early morning).
    await makeShiftAssignment(
      club.id, events.id, t.id, bob.id, bAsn.id,
      utc(2027, 1, 20, 1), utc(2027, 1, 20, 5),
    );
    // Alice offers an overnight shift Jan 19 22:00 → Jan 20 02:00.
    const { assignment } = await makeShiftAssignment(
      club.id, events.id, t.id, alice.id, aAsn.id,
      utc(2027, 1, 19, 22), utc(2027, 1, 20, 2),
    );
    const offer = await offerShift({
      clubId: club.id, employeeId: alice.id, shiftAssignmentId: assignment.id,
    });
    // Bob's existing 01:00-05:00 overlaps the overnight tail — must exclude.
    const bobList = await listEligibleOpportunitiesForEmployee(club.id, bob.id);
    expect(bobList.length).toBe(0);
    await expect(pickUpShift({
      clubId: club.id, employeeId: bob.id, opportunityId: offer.opportunityId,
    })).rejects.toBeInstanceOf(ConflictError);
  });

  // ----------------------------------------------------------------
  // §12 availability enforcement
  // ----------------------------------------------------------------
  it("§12 EXPLICITLY unavailable claimant excluded from list + refused on pickup", async () => {
    const club = await makeClub("phE-avail");
    const events = await makeDept(club.id, "EVENTS", "Events");
    const alice = await makeEmp(club.id, "alice-av");
    const aAsn = await makeAssn(club.id, alice.id, events.id);
    const bob = await makeEmp(club.id, "bob-av");
    await makeAssn(club.id, bob.id, events.id);
    const t = await makeTemplate(club.id, events.id, "EVENING", "Evening", 17 * 60, 23 * 60);
    // Bob explicitly marks Friday Evening unavailable.
    // The shift below falls on a Friday.
    const shiftStart = utc(2027, 1, 15, 17); // Friday Jan 15 2027
    await saveAvailabilityProfile({
      clubId: club.id, employeeId: bob.id,
      effectiveFrom: utc(2026, 12, 1),
      preferredHoursPerWeek: 10, maximumHoursPerWeek: 40,
      rules: [
        // 5 = Friday (JS getUTCDay: Sun=0…Sat=6).
        { weekday: 5, shiftTemplateId: t.id, available: false },
      ],
    });
    const { assignment } = await makeShiftAssignment(
      club.id, events.id, t.id, alice.id, aAsn.id,
      shiftStart, utc(2027, 1, 15, 23),
    );
    const offer = await offerShift({
      clubId: club.id, employeeId: alice.id, shiftAssignmentId: assignment.id,
    });
    const bobList = await listEligibleOpportunitiesForEmployee(club.id, bob.id);
    expect(bobList.length).toBe(0);
    await expect(pickUpShift({
      clubId: club.id, employeeId: bob.id, opportunityId: offer.opportunityId,
    })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("§12 no-profile permissive default — claimant with no availability CAN claim", async () => {
    const club = await makeClub("phE-avail-none");
    const events = await makeDept(club.id, "EVENTS", "Events");
    const alice = await makeEmp(club.id, "alice-noav");
    const aAsn = await makeAssn(club.id, alice.id, events.id);
    const bob = await makeEmp(club.id, "bob-noav");
    await makeAssn(club.id, bob.id, events.id);
    const t = await makeTemplate(club.id, events.id, "EVENING", "Evening", 17 * 60, 23 * 60);
    const { assignment } = await makeShiftAssignment(
      club.id, events.id, t.id, alice.id, aAsn.id,
      utc(2027, 1, 22, 17), utc(2027, 1, 22, 23),
    );
    const offer = await offerShift({
      clubId: club.id, employeeId: alice.id, shiftAssignmentId: assignment.id,
    });
    // Bob has no EmployeeAvailabilityProfile — permissive default.
    const bobList = await listEligibleOpportunitiesForEmployee(club.id, bob.id);
    expect(bobList.map((o) => o.id)).toContain(offer.opportunityId);
    const result = await pickUpShift({
      clubId: club.id, employeeId: bob.id, opportunityId: offer.opportunityId,
    });
    expect(result.newAssignmentId).toBeTruthy();
  });

  // ----------------------------------------------------------------
  // §14 offering employee identity NOT surfaced to eligible list
  // (positive assertion: list rows carry no "offeredByEmployee*" field)
  // ----------------------------------------------------------------
  it("§14 EligibleOpportunityRow shape does NOT expose offering employee identity", async () => {
    const club = await makeClub("phE-id");
    const events = await makeDept(club.id, "EVENTS", "Events");
    const alice = await makeEmp(club.id, "alice-id");
    const aAsn = await makeAssn(club.id, alice.id, events.id);
    const bob = await makeEmp(club.id, "bob-id");
    await makeAssn(club.id, bob.id, events.id);
    const t = await makeTemplate(club.id, events.id, "EVENING", "Evening", 17 * 60, 23 * 60);
    const { assignment } = await makeShiftAssignment(
      club.id, events.id, t.id, alice.id, aAsn.id,
      utc(2027, 2, 5, 17), utc(2027, 2, 5, 23),
    );
    await offerShift({
      clubId: club.id, employeeId: alice.id, shiftAssignmentId: assignment.id,
    });
    const bobList = await listEligibleOpportunitiesForEmployee(club.id, bob.id);
    expect(bobList.length).toBe(1);
    const row = bobList[0];
    // Positive: the row has the operational fields
    expect(row.shiftId).toBeTruthy();
    expect(row.startAt).toBeInstanceOf(Date);
    // Negative: no offering-employee identifier surface (matching brief §14).
    expect(Object.keys(row).some((k) => k.toLowerCase().includes("offeredby"))).toBe(false);
    expect(Object.keys(row).some((k) => k.toLowerCase().includes("employee"))).toBe(false);
  });

  // ----------------------------------------------------------------
  // §16 concurrent pickup — from Phase B tests, reasserted with the
  // additional Phase E constraints layered on top.
  // ----------------------------------------------------------------
  it("§16 concurrent pickups against a position-pinned shift → exactly one succeeds", async () => {
    const club = await makeClub("phE-race");
    const events = await makeDept(club.id, "EVENTS", "Events");
    const server = await makePosition(club.id, events.id, "SRV", "Server");
    const alice = await makeEmp(club.id, "alice-race");
    const aAsn = await makeAssn(club.id, alice.id, events.id, server.id);
    const claimants = await Promise.all(
      [0, 1, 2, 3, 4].map((i) => makeEmp(club.id, `race-c${i}`)),
    );
    await Promise.all(claimants.map((c) => makeAssn(club.id, c.id, events.id, server.id)));
    const t = await makeTemplate(club.id, events.id, "EVENING", "Evening", 17 * 60, 23 * 60);
    const { assignment } = await makeShiftAssignment(
      club.id, events.id, t.id, alice.id, aAsn.id,
      utc(2027, 3, 5, 17), utc(2027, 3, 5, 23), server.id,
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
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(4);
    const activeCount = await db().shiftAssignment.count({
      where: { shiftId: assignment.shiftId, state: "ASSIGNED" },
    });
    expect(activeCount).toBe(1);
  });

  // ----------------------------------------------------------------
  // §18 notifyShiftReassignment — origin kind + routing
  // ----------------------------------------------------------------
  it("§18 successful reassignment emits ONE WI item with SHIFT_REASSIGNMENT_NOTIFICATION origin", async () => {
    const club = await makeClub("phE-wi");
    const events = await makeDept(club.id, "EVENTS", "Events");
    const alice = await makeEmp(club.id, "alice-wi");
    const aAsn = await makeAssn(club.id, alice.id, events.id);
    const bob = await makeEmp(club.id, "bob-wi");
    await makeAssn(club.id, bob.id, events.id);
    // Seed department manager owner for routing.
    const bcrypt = await import("bcryptjs");
    const managerUser = await db().user.create({
      data: {
        email: "mgr.wi@t.test", name: "mgr", role: "DEPARTMENT_MANAGER",
        passwordHash: await bcrypt.default.hash("x", 4), clubId: club.id, status: "ACTIVE",
      },
    });
    await db().departmentResponsibility.create({
      data: { clubId: club.id, departmentId: events.id, userId: managerUser.id,
        responsibilityKey: "DEPARTMENT_TIME_APPROVAL" },
    });

    const t = await makeTemplate(club.id, events.id, "EVENING", "Evening", 17 * 60, 23 * 60);
    const { shift, assignment } = await makeShiftAssignment(
      club.id, events.id, t.id, alice.id, aAsn.id,
      utc(2027, 4, 1, 17), utc(2027, 4, 1, 23),
    );
    const offer = await offerShift({
      clubId: club.id, employeeId: alice.id, shiftAssignmentId: assignment.id,
    });
    const pickup = await pickUpShift({
      clubId: club.id, employeeId: bob.id, opportunityId: offer.opportunityId,
    });
    const first = await notifyShiftReassignment({
      clubId: club.id, shiftId: shift.id, departmentId: events.id,
      originalEmployeeId: alice.id, newEmployeeId: bob.id,
      opportunityId: pickup.opportunityId,
    });
    expect(first.gap).toBe(false);
    expect(first.ownerUserId).toBe(managerUser.id);
    expect(first.created).toBe(true);
    const wi = await db().workIntakeItem.findUniqueOrThrow({ where: { id: first.workIntakeItemId } });
    expect(wi.workSubtype).toBe("SHIFT_REASSIGNMENT");
    expect(wi.workIntent).toBe("NOTIFY");
    // §19 idempotent re-emit
    const second = await notifyShiftReassignment({
      clubId: club.id, shiftId: shift.id, departmentId: events.id,
      originalEmployeeId: alice.id, newEmployeeId: bob.id,
      opportunityId: pickup.opportunityId,
    });
    expect(second.workIntakeItemId).toBe(first.workIntakeItemId);
    expect(second.created).toBe(false);
    // Exactly ONE WI item for this shiftId.
    const count = await db().workIntakeItem.count({
      where: { clubId: club.id, workSubtype: "SHIFT_REASSIGNMENT" },
    });
    expect(count).toBe(1);
  });

  // ----------------------------------------------------------------
  // Withdraw — same-tenant + only-owner
  // ----------------------------------------------------------------
  it("withdrawOpportunity: OPEN → WITHDRAWN, assignment stays ASSIGNED", async () => {
    const club = await makeClub("phE-wd");
    const events = await makeDept(club.id, "EVENTS", "Events");
    const emp = await makeEmp(club.id, "wd-emp");
    const asn = await makeAssn(club.id, emp.id, events.id);
    const t = await makeTemplate(club.id, events.id, "DAY", "Day", 11 * 60, 17 * 60);
    const { assignment } = await makeShiftAssignment(
      club.id, events.id, t.id, emp.id, asn.id,
      utc(2027, 5, 1, 11), utc(2027, 5, 1, 17),
    );
    const offer = await offerShift({
      clubId: club.id, employeeId: emp.id, shiftAssignmentId: assignment.id,
    });
    await withdrawOpportunity({
      clubId: club.id, employeeId: emp.id, opportunityId: offer.opportunityId,
    });
    const opp = await db().shiftOpportunity.findUniqueOrThrow({ where: { id: offer.opportunityId } });
    expect(opp.state).toBe("WITHDRAWN");
    const asnAfter = await db().shiftAssignment.findUniqueOrThrow({ where: { id: assignment.id } });
    expect(asnAfter.state).toBe("ASSIGNED");
  });
});
