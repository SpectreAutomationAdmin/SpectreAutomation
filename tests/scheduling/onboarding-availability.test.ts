// Scheduling Foundation · Phase C (2026-09-07) — hourly onboarding
// availability continuation + persistence tests.
//
// Covers the founder-mandated invariants from the Phase C brief:
//   §3  hourly Photo → Availability; salaried Photo → SIN
//   §3  availability completion signal = presence of profile
//   §7  preferences + effective-date + rules persist
//   §8  training-incomplete hourly employee can still save availability
//   §10 returning to step prepopulates data
//   §11 salaried employees never land on this step
//   §12 no training gate

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { db, resetDb, seedRbac, makeClub } from "../util/db";
import { resolveOnboardingContinuation, ONBOARDING_CONTINUATION_URLS } from "@/lib/hr/onboarding-continuation";
import {
  saveAvailabilityProfile,
  resolveApplicableAvailabilityProfile,
} from "@/lib/scheduling/availability-profiles";
import { listShiftTemplatesForEmployee } from "@/lib/scheduling/shift-templates";

const utc = (y: number, m: number, d: number, h = 0, mi = 0) =>
  new Date(Date.UTC(y, m - 1, d, h, mi));

async function makeDept(clubId: string, code: string, name: string) {
  return db().department.create({ data: { clubId, code, name, isActive: true } });
}
async function makeEmployee(clubId: string, seed: string, opts: {
  compensationType?: "HOURLY" | "SALARY";
  departmentId?: string | null;
  hasPhoto?: boolean;
}) {
  const employee = await db().employee.create({
    data: {
      clubId, firstName: "Onb", lastName: `Emp-${seed}`,
      email: `${seed}@t.test`, hireDate: utc(2026, 1, 1),
      status: "ACTIVE", employeeLifecycle: "ACTIVE",
      employeeNumber: `E-${seed}`,
      compensationType: opts.compensationType ?? "HOURLY",
      homeProvince: "AB",
      timekeepingMethod: "CLOCK_REQUIRED",
      departmentId: opts.departmentId ?? null,
    },
  });
  if (opts.hasPhoto) {
    const photo = await db().employeeDocument.create({
      data: {
        clubId, employeeId: employee.id,
        storageKey: `photo/${seed}`, contentSha256: `sha-${seed}`, sizeBytes: 100,
        mimeType: "image/png", category: "PROFILE_PHOTO",
      },
    });
    await db().employee.update({
      where: { id: employee.id },
      data: { profilePhotoDocumentId: photo.id },
    });
    return { ...employee, profilePhotoDocumentId: photo.id };
  }
  return employee;
}
async function makeSession(clubId: string, employeeId: string, seed: string) {
  // Minimal invitation → session so resolveOnboardingContinuation
  // has a valid resumable session row.
  const bcrypt = await import("bcryptjs");
  const initiator = await db().user.create({
    data: {
      email: `init-${seed}@t.test`, name: "Initiator", role: "CLUB_ADMIN",
      passwordHash: await bcrypt.default.hash("x", 4),
      clubId, status: "ACTIVE",
    },
  });
  const invitation = await db().employeeOnboardingInvitation.create({
    data: {
      clubId, employeeId,
      tokenHash: `hash-${seed}-${Date.now()}`,
      expiresAt: new Date(Date.now() + 7 * 86_400_000),
      redeemedAt: new Date(),
      issuedByUserId: initiator.id,
    },
  });
  const session = await db().employeeOnboardingSession.create({
    data: {
      clubId, employeeId, initiatedByUserId: initiator.id,
      state: "IN_PROGRESS",
    },
  });
  return { invitation, session };
}
async function markAboutYouComplete(sessionId: string, clubId: string, employeeId: string) {
  const kinds = [
    "about_you_name_confirmation",
    "about_you_contact_confirmation",
    "about_you_address_confirmation",
    "employment_confirmation",
  ];
  for (const kind of kinds) {
    await db().employeeOnboardingAcknowledgement.create({
      data: { sessionId, clubId, employeeId, kind, acknowledgedAt: new Date() },
    });
  }
}
async function makeAssignment(clubId: string, employeeId: string, departmentId: string) {
  return db().employeeEmploymentAssignment.create({
    data: {
      clubId, employeeId, role: "PRIMARY",
      employmentType: "PART_TIME",
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

describe("Scheduling Foundation · Phase C · hourly onboarding availability", () => {
  beforeAll(async () => { /* schema pre-applied */ });
  beforeEach(async () => {
    await resetDb();
    await seedRbac();
  });

  it("§3 hourly Photo → Availability continuation", async () => {
    const club = await makeClub("onb-hourly");
    const events = await makeDept(club.id, "EVENTS", "Events");
    const emp = await makeEmployee(club.id, "hourly-1", {
      compensationType: "HOURLY", departmentId: events.id, hasPhoto: true,
    });
    await makeAssignment(club.id, emp.id, events.id);
    await makeTemplate(club.id, events.id, "EVENING", "Evening", 17 * 60, 23 * 60);
    const { session } = await makeSession(club.id, emp.id, "hourly-1");
    await markAboutYouComplete(session.id, club.id, emp.id);

    const next = await resolveOnboardingContinuation({
      sessionId: session.id, employeeId: emp.id, clubId: club.id,
    });
    expect(next).toBe(ONBOARDING_CONTINUATION_URLS.availability);
  });

  it("§3 salaried Photo → SIN continuation (Availability is skipped)", async () => {
    const club = await makeClub("onb-salary");
    const events = await makeDept(club.id, "EVENTS", "Events");
    const emp = await makeEmployee(club.id, "salary-1", {
      compensationType: "SALARY", departmentId: events.id, hasPhoto: true,
    });
    await makeAssignment(club.id, emp.id, events.id);
    await makeTemplate(club.id, events.id, "EVENING", "Evening", 17 * 60, 23 * 60);
    const { session } = await makeSession(club.id, emp.id, "salary-1");
    await markAboutYouComplete(session.id, club.id, emp.id);

    const next = await resolveOnboardingContinuation({
      sessionId: session.id, employeeId: emp.id, clubId: club.id,
    });
    expect(next).toBe(ONBOARDING_CONTINUATION_URLS.payrollSin);
  });

  it("§3 saved profile satisfies availability completion — hourly next = SIN", async () => {
    const club = await makeClub("onb-done");
    const events = await makeDept(club.id, "EVENTS", "Events");
    const emp = await makeEmployee(club.id, "hourly-done", {
      compensationType: "HOURLY", departmentId: events.id, hasPhoto: true,
    });
    await makeAssignment(club.id, emp.id, events.id);
    const t = await makeTemplate(club.id, events.id, "EVENING", "Evening", 17 * 60, 23 * 60);
    const { session } = await makeSession(club.id, emp.id, "hourly-done");
    await markAboutYouComplete(session.id, club.id, emp.id);

    await saveAvailabilityProfile({
      clubId: club.id, employeeId: emp.id,
      effectiveFrom: utc(2026, 9, 1),
      preferredHoursPerWeek: 20, maximumHoursPerWeek: 30,
      rules: [{ weekday: 1, shiftTemplateId: t.id, available: true }],
    });

    const next = await resolveOnboardingContinuation({
      sessionId: session.id, employeeId: emp.id, clubId: club.id,
    });
    expect(next).toBe(ONBOARDING_CONTINUATION_URLS.payrollSin);
  });

  it("§7 saved profile persists rules, preferred/max hours, effective date, notes", async () => {
    const club = await makeClub("onb-persist");
    const events = await makeDept(club.id, "EVENTS", "Events");
    const emp = await makeEmployee(club.id, "hourly-persist", {
      compensationType: "HOURLY", departmentId: events.id, hasPhoto: true,
    });
    await makeAssignment(club.id, emp.id, events.id);
    const t = await makeTemplate(club.id, events.id, "EVENING", "Evening", 17 * 60, 23 * 60);

    await saveAvailabilityProfile({
      clubId: club.id, employeeId: emp.id,
      effectiveFrom: utc(2026, 10, 15),
      preferredHoursPerWeek: 18, maximumHoursPerWeek: 28,
      notes: "school Mondays",
      rules: [
        { weekday: 1, shiftTemplateId: t.id, available: false },
        { weekday: 2, shiftTemplateId: t.id, available: true },
      ],
    });
    const applicable = await resolveApplicableAvailabilityProfile(emp.id, utc(2026, 10, 20));
    expect(applicable).toBeTruthy();
    expect(applicable!.preferredHoursPerWeek).toBe(18);
    expect(applicable!.maximumHoursPerWeek).toBe(28);
    expect(applicable!.notes).toBe("school Mondays");
    expect(applicable!.effectiveFrom.toISOString().slice(0, 10)).toBe("2026-10-15");
    expect(applicable!.rules.length).toBe(2);
  });

  it("§10 returning to step re-loads the saved profile (prepopulation source)", async () => {
    const club = await makeClub("onb-prep");
    const events = await makeDept(club.id, "EVENTS", "Events");
    const emp = await makeEmployee(club.id, "hourly-prep", {
      compensationType: "HOURLY", departmentId: events.id, hasPhoto: true,
    });
    await makeAssignment(club.id, emp.id, events.id);
    const t = await makeTemplate(club.id, events.id, "EVENING", "Evening", 17 * 60, 23 * 60);

    const initialEffective = utc(2026, 11, 1);
    await saveAvailabilityProfile({
      clubId: club.id, employeeId: emp.id,
      effectiveFrom: initialEffective,
      preferredHoursPerWeek: 15,
      maximumHoursPerWeek: 25,
      rules: [{ weekday: 2, shiftTemplateId: t.id, available: true }],
    });
    // Same effectiveFrom = update in place (child rules replaced).
    await saveAvailabilityProfile({
      clubId: club.id, employeeId: emp.id,
      effectiveFrom: initialEffective,
      preferredHoursPerWeek: 16,
      maximumHoursPerWeek: 26,
      rules: [
        { weekday: 2, shiftTemplateId: t.id, available: true },
        { weekday: 3, shiftTemplateId: t.id, available: true },
      ],
    });
    const applicable = await resolveApplicableAvailabilityProfile(emp.id, utc(2026, 11, 5));
    expect(applicable!.preferredHoursPerWeek).toBe(16);
    expect(applicable!.maximumHoursPerWeek).toBe(26);
    expect(applicable!.rules.length).toBe(2);
    // Only one profile row exists (no version drift from same effectiveFrom).
    const all = await db().employeeAvailabilityProfile.findMany({ where: { employeeId: emp.id } });
    expect(all.length).toBe(1);
  });

  it("§12 no training gate — hourly employee with zero training completions can save availability", async () => {
    const club = await makeClub("onb-notraining");
    const events = await makeDept(club.id, "EVENTS", "Events");
    const emp = await makeEmployee(club.id, "hourly-notraining", {
      compensationType: "HOURLY", departmentId: events.id, hasPhoto: true,
    });
    await makeAssignment(club.id, emp.id, events.id);
    const t = await makeTemplate(club.id, events.id, "EVENING", "Evening", 17 * 60, 23 * 60);
    // No TrainingCompletion rows created. saveAvailabilityProfile
    // must not call assertSchedulingEligibility and must not throw.
    await expect(saveAvailabilityProfile({
      clubId: club.id, employeeId: emp.id,
      effectiveFrom: utc(2026, 9, 1),
      preferredHoursPerWeek: 20, maximumHoursPerWeek: 30,
      rules: [{ weekday: 1, shiftTemplateId: t.id, available: true }],
    })).resolves.toBeTruthy();
  });

  it("§4 templates resolve from employee's assigned department (no hardcoded Day/Evening)", async () => {
    const club = await makeClub("onb-tpl");
    const grounds = await makeDept(club.id, "GROUNDS", "Grounds");
    const emp = await makeEmployee(club.id, "hourly-tpl", {
      compensationType: "HOURLY", departmentId: grounds.id, hasPhoto: true,
    });
    await makeAssignment(club.id, emp.id, grounds.id);
    // Custom department-specific template with a non-"DAY" / non-"EVENING" code.
    const morning = await makeTemplate(club.id, grounds.id, "MORNING", "Grounds Morning", 5 * 60 + 30, 13 * 60 + 30);
    const templates = await listShiftTemplatesForEmployee(club.id, emp.id);
    expect(templates.map((x) => x.id)).toEqual([morning.id]);
    expect(templates[0].code).toBe("MORNING");
  });

  it("§7 tenant isolation — resolveOnboardingContinuation refuses cross-club session", async () => {
    const clubA = await makeClub("onb-iso-a");
    const clubB = await makeClub("onb-iso-b");
    const eventsA = await makeDept(clubA.id, "EVENTS", "Events");
    const empA = await makeEmployee(clubA.id, "hourly-iso-a", {
      compensationType: "HOURLY", departmentId: eventsA.id, hasPhoto: true,
    });
    await makeAssignment(clubA.id, empA.id, eventsA.id);
    await makeTemplate(clubA.id, eventsA.id, "EVENING", "Evening", 17 * 60, 23 * 60);
    const { session } = await makeSession(clubA.id, empA.id, "hourly-iso-a");

    // Pass clubB as the club context — resolver must refuse.
    const next = await resolveOnboardingContinuation({
      sessionId: session.id, employeeId: empA.id, clubId: clubB.id,
    });
    expect(next).toBe(ONBOARDING_CONTINUATION_URLS.expired);
  });

  it("§3 availability signal is the profile row (not an ack) — deleting the profile un-completes the step", async () => {
    const club = await makeClub("onb-signal");
    const events = await makeDept(club.id, "EVENTS", "Events");
    const emp = await makeEmployee(club.id, "hourly-signal", {
      compensationType: "HOURLY", departmentId: events.id, hasPhoto: true,
    });
    await makeAssignment(club.id, emp.id, events.id);
    const t = await makeTemplate(club.id, events.id, "EVENING", "Evening", 17 * 60, 23 * 60);
    const { session } = await makeSession(club.id, emp.id, "hourly-signal");
    await markAboutYouComplete(session.id, club.id, emp.id);
    const profile = await saveAvailabilityProfile({
      clubId: club.id, employeeId: emp.id,
      effectiveFrom: utc(2026, 9, 1),
      preferredHoursPerWeek: 20, maximumHoursPerWeek: 30,
      rules: [{ weekday: 1, shiftTemplateId: t.id, available: true }],
    });
    let next = await resolveOnboardingContinuation({
      sessionId: session.id, employeeId: emp.id, clubId: club.id,
    });
    expect(next).toBe(ONBOARDING_CONTINUATION_URLS.payrollSin);

    // Delete the profile → cascade child rules first for FK.
    await db().employeeAvailabilityRule.deleteMany({ where: { availabilityProfileId: profile.id } });
    await db().employeeAvailabilityProfile.delete({ where: { id: profile.id } });

    next = await resolveOnboardingContinuation({
      sessionId: session.id, employeeId: emp.id, clubId: club.id,
    });
    expect(next).toBe(ONBOARDING_CONTINUATION_URLS.availability);
  });
});
