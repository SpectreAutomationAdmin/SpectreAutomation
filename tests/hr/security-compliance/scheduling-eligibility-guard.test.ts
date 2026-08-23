// HR-2C B4 (2026-08-23) — Scheduling-eligibility guard + Availability
// write path behaviour.
//
// Enforces the founder's §15 mandatory list:
//   * Availability write allowed when eligible
//   * Availability write refused when ineligible
//   * crafted/direct mutation cannot bypass
//   * optional incomplete course does not block
//   * cross-department requirement does not block
//   * cross-Club requirement does not block
//   * new applicable required course dynamically revokes eligibility
//   * completion dynamically restores eligibility
//   * existing availability survives eligibility loss
//   * stale browser state cannot bypass the server guard
//
// Reuses the B1 eligibility fixture (`publishSimpleCourse`) via a
// small local helper to keep this file self-contained.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { prisma } from "@/lib/prisma";
import { createCourse, publishDraft, updateDraft } from "@/lib/hr/training/courses";
import { createQuestion } from "@/lib/hr/training/questions";
import { uploadTrainingVideo } from "@/lib/hr/training/video";
import {
  recordVideoProgress,
  startAttempt,
  submitAttempt,
} from "@/lib/hr/training/attempts";
import { getEmployeeCourseView } from "@/lib/hr/training/employee-read";
import {
  assertSchedulingEligibility,
  isSchedulingEligible,
  getSchedulingEligibilitySummary,
  SchedulingIneligibleError,
} from "@/lib/hr/scheduling-eligibility";
import {
  saveAvailabilityWeek,
  listAvailabilityWeeks,
  normaliseWeekStart,
} from "@/lib/hr/availability";
import { resetDb, seedRbac } from "../../util/db";
import { makeAdminHrFixture, type AdminHrFixture } from "../admin-workflows/_helpers";
import type { EmployeePortalPrincipal } from "@/lib/employee-portal-session";

const FAKE_VIDEO = Buffer.from(new Array(1024).fill(0));

async function makeEmployeeAndActor(fx: AdminHrFixture, opts?: {
  clubId?: string;
  departmentId?: string | null;
  positionId?: string | null;
  personalEmail?: string;
}) {
  const clubId = opts?.clubId ?? fx.club.id;
  const emp = await prisma.employee.create({
    data: {
      clubId,
      employeeNumber: `E-${Math.floor(Math.random() * 90000 + 10000)}`,
      firstName: "Test", lastName: "Employee",
      personalEmail: opts?.personalEmail ?? `t-${Date.now()}-${Math.floor(Math.random() * 1000)}@x.test`,
      departmentId: opts?.departmentId ?? null,
      positionId: opts?.positionId ?? null,
    },
  });
  const actor: EmployeePortalPrincipal = {
    employeeId: emp.id,
    clubId: emp.clubId,
    generation: 1,
    establishedAt: new Date().toISOString(),
  };
  return { employeeId: emp.id, actor };
}

async function publishSimpleCourse(
  fx: AdminHrFixture,
  opts?: {
    code?: string;
    required?: boolean;
    appliesToAll?: boolean;
    appliesToDeptIds?: string[];
    appliesToPositionIds?: string[];
    clubId?: string;
  },
) {
  const clubId = opts?.clubId ?? fx.club.id;
  const admin = clubId === fx.club.id ? fx.clubAdmin : fx.foreignClubAdmin;
  const { courseId, versionId } = await createCourse(admin, clubId, {
    code: opts?.code ?? `TRAINING_${Math.floor(Math.random() * 90000 + 10000)}`,
    title: "Workplace Safety Orientation",
    category: "Safety",
    description: "Pilot course.",
    version1Defaults: { required: opts?.required ?? true, appliesToAll: opts?.appliesToAll ?? false },
  });
  await updateDraft(admin, versionId, {
    appliesToAll: opts?.appliesToAll ?? false,
    appliesToDeptIds: opts?.appliesToDeptIds ?? null,
    appliesToPositionIds: opts?.appliesToPositionIds ?? null,
    requiresKnowledgeTest: true,
  });
  await uploadTrainingVideo(admin, versionId, { bytes: FAKE_VIDEO, mimeType: "video/mp4", durationSec: 60 });
  await createQuestion(admin, versionId, {
    prompt: "When must a hazard be reported?",
    options: [
      { text: "At the end of the shift", isCorrect: false },
      { text: "Immediately", isCorrect: true },
    ],
  });
  await publishDraft(admin, versionId);
  return { courseId, versionId };
}

async function passCourse(actor: EmployeePortalPrincipal, versionId: string) {
  await recordVideoProgress(actor, { courseVersionId: versionId, secondsWatched: 60, farthestSecond: 60 });
  const s = await startAttempt(actor, { courseVersionId: versionId });
  const view = await getEmployeeCourseView(actor, versionId);
  const answers = view.questions.map((q) => ({
    questionId: q.id,
    selectedOptionId: q.options.find((_, i) => i === 1)!.id,
  }));
  return submitAttempt(actor, { attemptId: s.attemptId, answers });
}

const MONDAY_2026_08_24 = new Date(Date.UTC(2026, 7, 24)); // Monday of week 35

describe("HR-2C B4 · scheduling-eligibility guard", () => {
  let fx: AdminHrFixture;

  beforeAll(async () => { await resetDb(); await seedRbac(); });
  beforeEach(async () => {
    await resetDb();
    await seedRbac();
    fx = await makeAdminHrFixture("HR2CB4");
  });

  // -----------------------------------------------------------------------
  // Guard fundamentals
  // -----------------------------------------------------------------------

  it("assertSchedulingEligibility resolves when no training is applicable", async () => {
    const { employeeId } = await makeEmployeeAndActor(fx);
    await expect(assertSchedulingEligibility(employeeId)).resolves.toBeUndefined();
    expect(await isSchedulingEligible(employeeId)).toBe(true);
  });

  it("assertSchedulingEligibility throws SchedulingIneligibleError when required training is outstanding", async () => {
    const { courseId } = await publishSimpleCourse(fx, { appliesToAll: true, required: true });
    const { employeeId } = await makeEmployeeAndActor(fx);
    await expect(assertSchedulingEligibility(employeeId)).rejects.toBeInstanceOf(SchedulingIneligibleError);
    try {
      await assertSchedulingEligibility(employeeId);
    } catch (e) {
      const err = e as SchedulingIneligibleError;
      expect(err.outstandingCount).toBe(1);
      expect(err.outstanding[0]!.courseId).toBe(courseId);
      // The error carries display-safe titles ONLY — never internal
      // course codes or version ids.
      const serialised = JSON.stringify(err.outstanding);
      expect(serialised).not.toMatch(/TRAINING_\d{5}/); // course code prefix
      expect(serialised).not.toMatch(/versionId|courseVersionId/);
    }
  });

  it("getSchedulingEligibilitySummary returns display-safe outstanding titles only", async () => {
    await publishSimpleCourse(fx, { appliesToAll: true, required: true, code: "TRAINING_11111" });
    const { employeeId } = await makeEmployeeAndActor(fx);
    const summary = await getSchedulingEligibilitySummary(employeeId);
    expect(summary.eligible).toBe(false);
    expect(summary.outstanding).toHaveLength(1);
    const payload = JSON.stringify(summary);
    expect(payload).not.toContain("TRAINING_11111"); // code stripped
    expect(payload).not.toContain("courseVersionId");
    expect(payload).not.toContain("required"); // internal enum stripped
  });

  // -----------------------------------------------------------------------
  // Applicability cases (§10)
  // -----------------------------------------------------------------------

  it("required + everyone + incomplete → blocked", async () => {
    await publishSimpleCourse(fx, { appliesToAll: true, required: true });
    const { employeeId } = await makeEmployeeAndActor(fx);
    expect(await isSchedulingEligible(employeeId)).toBe(false);
  });

  it("required + own-department + incomplete → blocked", async () => {
    const dept = await prisma.department.create({
      data: { clubId: fx.club.id, code: "GOLF", name: "Golf", sortOrder: 1 },
    });
    await publishSimpleCourse(fx, { appliesToDeptIds: [dept.id], required: true });
    const { employeeId } = await makeEmployeeAndActor(fx, { departmentId: dept.id });
    expect(await isSchedulingEligible(employeeId)).toBe(false);
  });

  it("required course for another department → no effect", async () => {
    const golf = await prisma.department.create({
      data: { clubId: fx.club.id, code: "GOLF", name: "Golf", sortOrder: 1 },
    });
    const kitchen = await prisma.department.create({
      data: { clubId: fx.club.id, code: "KITCHEN", name: "Kitchen", sortOrder: 2 },
    });
    await publishSimpleCourse(fx, { appliesToDeptIds: [kitchen.id], required: true });
    const { employeeId } = await makeEmployeeAndActor(fx, { departmentId: golf.id });
    expect(await isSchedulingEligible(employeeId)).toBe(true);
  });

  it("required course for another Club → no effect", async () => {
    await publishSimpleCourse(fx, {
      appliesToAll: true, required: true, clubId: fx.foreignClub.id,
    });
    const { employeeId } = await makeEmployeeAndActor(fx);
    expect(await isSchedulingEligible(employeeId)).toBe(true);
  });

  it("optional applicable course incomplete → NEVER blocks", async () => {
    await publishSimpleCourse(fx, { appliesToAll: true, required: false });
    const { employeeId } = await makeEmployeeAndActor(fx);
    expect(await isSchedulingEligible(employeeId)).toBe(true);
  });

  it("all applicable required courses complete → eligible", async () => {
    const { versionId } = await publishSimpleCourse(fx, { appliesToAll: true, required: true });
    const { employeeId, actor } = await makeEmployeeAndActor(fx);
    await passCourse(actor, versionId);
    expect(await isSchedulingEligible(employeeId)).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Availability write path (§4)
  // -----------------------------------------------------------------------

  it("Availability write ALLOWED when eligible", async () => {
    const { actor } = await makeEmployeeAndActor(fx);
    const row = await saveAvailabilityWeek(actor, {
      weekStart: MONDAY_2026_08_24, monday: true, tuesday: true, wednesday: false,
      thursday: true, friday: true, saturday: false, sunday: false, notes: "afternoons only",
    });
    expect(row.monday).toBe(true);
    expect(row.wednesday).toBe(false);
    expect(row.notes).toBe("afternoons only");
    const persisted = await prisma.employeeAvailabilityWeek.findFirst({
      where: { employeeId: actor.employeeId, weekStart: MONDAY_2026_08_24 },
    });
    expect(persisted).not.toBeNull();
  });

  it("Availability write REFUSED when required training outstanding — no row created", async () => {
    await publishSimpleCourse(fx, { appliesToAll: true, required: true });
    const { actor } = await makeEmployeeAndActor(fx);
    await expect(
      saveAvailabilityWeek(actor, { weekStart: MONDAY_2026_08_24, monday: true }),
    ).rejects.toBeInstanceOf(SchedulingIneligibleError);
    const rows = await prisma.employeeAvailabilityWeek.findMany({
      where: { employeeId: actor.employeeId },
    });
    expect(rows).toHaveLength(0); // no partial mutation on refuse
  });

  it("crafted mutation cannot bypass — the guard fires INSIDE the service (calling saveAvailabilityWeek directly is the crafted path in a headless test)", async () => {
    await publishSimpleCourse(fx, { appliesToAll: true, required: true });
    const { actor } = await makeEmployeeAndActor(fx);
    // Direct service invocation with a doctored input (extra fields
    // that a client might try to slip in). The service still refuses.
    const doctored = {
      weekStart: MONDAY_2026_08_24,
      monday: true, tuesday: true, wednesday: true,
      thursday: true, friday: true, saturday: true, sunday: true,
      notes: "let me through",
      __bypass: true,
      passed: true,
      eligibilityOverride: true,
    } as unknown as Parameters<typeof saveAvailabilityWeek>[1];
    await expect(saveAvailabilityWeek(actor, doctored))
      .rejects.toBeInstanceOf(SchedulingIneligibleError);
    const rows = await prisma.employeeAvailabilityWeek.findMany({
      where: { employeeId: actor.employeeId },
    });
    expect(rows).toHaveLength(0);
  });

  // -----------------------------------------------------------------------
  // Dynamic eligibility (§9) — the marquee regression
  // -----------------------------------------------------------------------

  it("dynamic sequence: eligible → publish required → refused → complete → eligible again", async () => {
    const { actor } = await makeEmployeeAndActor(fx);

    // Step 1: no applicable training → eligible → availability save works.
    await saveAvailabilityWeek(actor, { weekStart: MONDAY_2026_08_24, monday: true });

    // Step 2: admin publishes a required applicable course. Without
    // touching Employee, the resolver flips to ineligible.
    const { versionId } = await publishSimpleCourse(fx, { appliesToAll: true, required: true });
    expect(await isSchedulingEligible(actor.employeeId)).toBe(false);

    // Step 3: existing row is still readable.
    const persistedBefore = await listAvailabilityWeeks(actor);
    expect(persistedBefore).toHaveLength(1);
    expect(persistedBefore[0]!.monday).toBe(true);

    // Step 4: new writes refused. `saveAvailabilityWeek` upserts on
    // (employeeId, weekStart), so a re-save of the SAME week is the
    // exact scenario a stale UI would attempt.
    await expect(
      saveAvailabilityWeek(actor, { weekStart: MONDAY_2026_08_24, monday: false }),
    ).rejects.toBeInstanceOf(SchedulingIneligibleError);
    // Existing row unchanged — Monday is still true.
    const persistedDuring = await listAvailabilityWeeks(actor);
    expect(persistedDuring[0]!.monday).toBe(true);

    // Step 5: employee completes the required course → eligible again.
    await passCourse(actor, versionId);
    expect(await isSchedulingEligible(actor.employeeId)).toBe(true);

    // Step 6: availability writes work again — same-week upsert now
    // flips Monday off.
    const updated = await saveAvailabilityWeek(actor, { weekStart: MONDAY_2026_08_24, monday: false, wednesday: true });
    expect(updated.monday).toBe(false);
    expect(updated.wednesday).toBe(true);
  });

  it("existing availability survives eligibility loss (never rewritten, never deleted)", async () => {
    const { actor } = await makeEmployeeAndActor(fx);
    // Save while eligible.
    const before = await saveAvailabilityWeek(actor, {
      weekStart: MONDAY_2026_08_24, monday: true, friday: true, notes: "afternoons",
    });
    // Admin publishes a required course.
    await publishSimpleCourse(fx, { appliesToAll: true, required: true });
    // Nothing on the Employee row changes; availability row untouched.
    const stillThere = await prisma.employeeAvailabilityWeek.findUnique({
      where: { employeeId_weekStart: { employeeId: actor.employeeId, weekStart: MONDAY_2026_08_24 } },
    });
    expect(stillThere?.id).toBe(before.id);
    expect(stillThere?.monday).toBe(true);
    expect(stillThere?.notes).toBe("afternoons");
    // Read is still available.
    const readable = await listAvailabilityWeeks(actor);
    expect(readable).toHaveLength(1);
  });

  // -----------------------------------------------------------------------
  // §11 — Department/Position change flows through the resolver
  // -----------------------------------------------------------------------

  it("changing department flows through the resolver automatically; historical completions are preserved", async () => {
    const golf = await prisma.department.create({
      data: { clubId: fx.club.id, code: "GOLF", name: "Golf", sortOrder: 1 },
    });
    const kitchen = await prisma.department.create({
      data: { clubId: fx.club.id, code: "KITCHEN", name: "Kitchen", sortOrder: 2 },
    });
    // Course for Kitchen only.
    const { versionId } = await publishSimpleCourse(fx, { appliesToDeptIds: [kitchen.id], required: true });
    // Employee currently in Golf → not applicable → eligible.
    const { employeeId, actor } = await makeEmployeeAndActor(fx, { departmentId: golf.id });
    expect(await isSchedulingEligible(employeeId)).toBe(true);
    // Move to Kitchen → required course now applies → ineligible.
    await prisma.employee.update({ where: { id: employeeId }, data: { departmentId: kitchen.id } });
    expect(await isSchedulingEligible(employeeId)).toBe(false);
    // Complete the course → eligible.
    await passCourse(actor, versionId);
    expect(await isSchedulingEligible(employeeId)).toBe(true);
    // Move BACK to Golf — the completion row survives.
    await prisma.employee.update({ where: { id: employeeId }, data: { departmentId: golf.id } });
    expect(await isSchedulingEligible(employeeId)).toBe(true);
    const stillHasCompletion = await prisma.trainingCompletion.findUnique({
      where: { employeeId_courseVersionId: { employeeId, courseVersionId: versionId } },
    });
    expect(stillHasCompletion).not.toBeNull();
  });

  // -----------------------------------------------------------------------
  // Week normalisation — the write uses the ISO-week Monday key
  // -----------------------------------------------------------------------

  it("normaliseWeekStart floors to the ISO-week Monday", () => {
    // 2026-08-24 is a Monday; input Friday of same week → same Monday.
    const monday = normaliseWeekStart(new Date(Date.UTC(2026, 7, 28))); // Fri
    expect(monday.toISOString().slice(0, 10)).toBe("2026-08-24");
    // Sunday still belongs to prior Monday (2026-08-24, Sunday = 30th).
    const sunday = normaliseWeekStart(new Date(Date.UTC(2026, 7, 30)));
    expect(sunday.toISOString().slice(0, 10)).toBe("2026-08-24");
  });
});
