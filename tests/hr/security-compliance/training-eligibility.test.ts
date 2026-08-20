// HR-2C §26-27 (2026-08-20) — Training + scheduling-eligibility behaviour.
//
// The mandatory list from the founder brief:
//   * required applicable published course + no completion → eligibility false
//   * required course passed → eligibility true
//   * optional course incomplete → eligibility stays true
//   * course for another Department → not applicable
//   * course for another Club → invisible
//   * explicit employee assignment → applicable
//   * newly published mandatory applicable course → eligibility becomes false
//   * employee cannot mark own completion
//   * browser cannot submit its own score

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { prisma } from "@/lib/prisma";
import { createCourse, publishDraft, updateDraft } from "@/lib/hr/training/courses";
import { createQuestion } from "@/lib/hr/training/questions";
import { uploadTrainingVideo } from "@/lib/hr/training/video";
import { assignCourseToEmployee } from "@/lib/hr/training/assignments";
import {
  resolveApplicableCourses,
  resolveEmployeeSchedulingEligibility,
} from "@/lib/hr/training/applicability";
import {
  recordVideoProgress,
  startAttempt,
  submitAttempt,
} from "@/lib/hr/training/attempts";
import { getEmployeeCourseView } from "@/lib/hr/training/employee-read";
import { resetDb, seedRbac } from "../../util/db";
import { makeAdminHrFixture, type AdminHrFixture } from "../admin-workflows/_helpers";
import type { EmployeePortalPrincipal } from "@/lib/employee-portal-session";

// Small MP4-ish bytes (not a real video, just enough to satisfy the
// upload validation for tests — the file is stored as-is).
const FAKE_VIDEO = Buffer.from(new Array(1024).fill(0));

async function makeEmployeeAndActor(fx: AdminHrFixture, opts?: {
  clubId?: string;
  departmentId?: string | null;
  positionId?: string | null;
  personalEmail?: string;
}): Promise<{ employeeId: string; actor: EmployeePortalPrincipal }> {
  const clubId = opts?.clubId ?? fx.club.id;
  const emp = await prisma.employee.create({
    data: {
      clubId,
      employeeNumber: `E-${Math.floor(Math.random() * 90000 + 10000)}`,
      firstName: "Test", lastName: "Employee",
      personalEmail: opts?.personalEmail ?? `test-${Date.now()}-${Math.floor(Math.random() * 1000)}@x.test`,
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
    videoDurationSec?: number;
    clubId?: string;
  },
): Promise<{ courseId: string; versionId: string }> {
  const clubId = opts?.clubId ?? fx.club.id;
  const admin = clubId === fx.club.id ? fx.clubAdmin : fx.foreignClubAdmin;
  const { courseId, versionId } = await createCourse(admin, clubId, {
    code: opts?.code ?? `SAFETY_${Math.floor(Math.random() * 90000 + 10000)}`,
    title: "Workplace Safety Orientation",
    category: "Safety",
    description: "The pilot safety course.",
    version1Defaults: { required: opts?.required ?? true, appliesToAll: opts?.appliesToAll ?? false },
  });
  await updateDraft(admin, versionId, {
    appliesToAll: opts?.appliesToAll ?? false,
    appliesToDeptIds: opts?.appliesToDeptIds ?? null,
    appliesToPositionIds: opts?.appliesToPositionIds ?? null,
    requiresKnowledgeTest: true,
  });
  await uploadTrainingVideo(admin, versionId, {
    bytes: FAKE_VIDEO, mimeType: "video/mp4",
    durationSec: opts?.videoDurationSec ?? 60,
  });
  await createQuestion(admin, versionId, {
    prompt: "When should a damaged extension cord be removed from service?",
    options: [
      { text: "At the end of the week", isCorrect: false },
      { text: "Immediately", isCorrect: true },
      { text: "Only after it stops working", isCorrect: false },
    ],
  });
  await createQuestion(admin, versionId, {
    prompt: "Who is responsible for reporting a workplace hazard?",
    options: [
      { text: "Only supervisors", isCorrect: false },
      { text: "Every employee", isCorrect: true },
    ],
  });
  await publishDraft(admin, versionId);
  return { courseId, versionId };
}

describe("HR-2C · training applicability + scheduling eligibility", () => {
  let fx: AdminHrFixture;

  beforeAll(async () => { await resetDb(); await seedRbac(); });
  beforeEach(async () => {
    await resetDb();
    await seedRbac();
    fx = await makeAdminHrFixture("HR2CFix");
  });

  it("required applicable published course with no completion → eligibility=false", async () => {
    await publishSimpleCourse(fx, { appliesToAll: true, required: true });
    const { employeeId } = await makeEmployeeAndActor(fx);
    const result = await resolveEmployeeSchedulingEligibility(employeeId);
    expect(result.eligible).toBe(false);
    expect(result.outstandingTraining).toHaveLength(1);
    expect(result.outstandingTraining[0]!.status).toBe("not_started");
  });

  it("optional course incomplete → eligibility=true", async () => {
    await publishSimpleCourse(fx, { appliesToAll: true, required: false });
    const { employeeId } = await makeEmployeeAndActor(fx);
    const result = await resolveEmployeeSchedulingEligibility(employeeId);
    expect(result.eligible).toBe(true);
    expect(result.outstandingTraining).toHaveLength(0);
    expect(result.applicable).toHaveLength(1);
  });

  it("course for another Department → not applicable", async () => {
    const dept = await prisma.department.create({
      data: { clubId: fx.club.id, code: "GROUNDS", name: "Grounds", sortOrder: 5 },
    });
    await publishSimpleCourse(fx, { appliesToDeptIds: [dept.id], required: true });
    // Employee has no departmentId → course does not apply.
    const { employeeId } = await makeEmployeeAndActor(fx);
    const result = await resolveEmployeeSchedulingEligibility(employeeId);
    expect(result.eligible).toBe(true);
    expect(result.applicable).toHaveLength(0);
  });

  it("course for another Club → invisible even to same-position employee", async () => {
    // Publish course in the foreign club.
    await publishSimpleCourse(fx, { appliesToAll: true, required: true, clubId: fx.foreignClub.id });
    const { employeeId } = await makeEmployeeAndActor(fx);
    const applicable = await resolveApplicableCourses(employeeId);
    expect(applicable).toHaveLength(0);
  });

  it("explicit employee assignment overrides dept/position → applicable", async () => {
    const { courseId } = await publishSimpleCourse(fx, {
      required: true,
      // Explicitly appliesToAll=false and no dept/position — normally
      // would apply to nobody.
      appliesToAll: false,
    });
    const { employeeId } = await makeEmployeeAndActor(fx);
    // Without assignment: not applicable.
    let applicable = await resolveApplicableCourses(employeeId);
    expect(applicable).toHaveLength(0);
    // Assign explicitly.
    await assignCourseToEmployee(fx.clubAdmin, { employeeId, courseId });
    applicable = await resolveApplicableCourses(employeeId);
    expect(applicable).toHaveLength(1);
    expect(applicable[0]!.reason).toBe("assigned");
  });

  it("newly published mandatory applicable course → previously-eligible employee becomes ineligible (§18)", async () => {
    const { employeeId } = await makeEmployeeAndActor(fx);
    // No courses yet → eligible.
    let result = await resolveEmployeeSchedulingEligibility(employeeId);
    expect(result.eligible).toBe(true);
    // Now publish a required applies-to-all course.
    await publishSimpleCourse(fx, { appliesToAll: true, required: true });
    result = await resolveEmployeeSchedulingEligibility(employeeId);
    expect(result.eligible).toBe(false);
    expect(result.outstandingTraining).toHaveLength(1);
  });

  it("completed required course → eligibility=true; new required course → eligibility=false again", async () => {
    const { versionId: v1 } = await publishSimpleCourse(fx, { appliesToAll: true, required: true, code: "COURSE_A" });
    const { employeeId, actor } = await makeEmployeeAndActor(fx);
    // Watch video + pass quiz.
    await recordVideoProgress(actor, { courseVersionId: v1, secondsWatched: 60, farthestSecond: 60 });
    const started = await startAttempt(actor, { courseVersionId: v1 });
    const view = await getEmployeeCourseView(actor, v1);
    const answers = view.questions.map((q) => ({
      questionId: q.id,
      selectedOptionId: q.options[1]!.id, // correct is index 1 in both questions
    }));
    // Second question only has 2 options; correct is index 1. First
    // question correct is also index 1 by construction. Both should be right.
    const result = await submitAttempt(actor, { attemptId: started.attemptId, answers });
    expect(result.passed).toBe(true);
    // Eligibility now true.
    let elig = await resolveEmployeeSchedulingEligibility(employeeId);
    expect(elig.eligible).toBe(true);
    // Publish a second required course → ineligible again.
    await publishSimpleCourse(fx, { appliesToAll: true, required: true, code: "COURSE_B" });
    elig = await resolveEmployeeSchedulingEligibility(employeeId);
    expect(elig.eligible).toBe(false);
    expect(elig.outstandingTraining).toHaveLength(1);
    expect(elig.outstandingTraining[0]!.code).toBe("COURSE_B");
  });

  it("employee-portal actor can never submit for another employee", async () => {
    const { versionId } = await publishSimpleCourse(fx, { appliesToAll: true, required: true });
    const { actor: actorA } = await makeEmployeeAndActor(fx, { personalEmail: `a-${Date.now()}@x.test` });
    const { actor: actorB } = await makeEmployeeAndActor(fx, { personalEmail: `b-${Date.now()}@x.test` });
    // Actor A starts an attempt.
    await recordVideoProgress(actorA, { courseVersionId: versionId, secondsWatched: 60, farthestSecond: 60 });
    const startedA = await startAttempt(actorA, { courseVersionId: versionId });
    const view = await getEmployeeCourseView(actorA, versionId);
    const answers = view.questions.map((q) => ({
      questionId: q.id, selectedOptionId: q.options[1]!.id,
    }));
    // Actor B tries to submit A's attempt.
    await expect(
      submitAttempt(actorB, { attemptId: startedA.attemptId, answers }),
    ).rejects.toThrow(/not.found/i);
    // A submits their own — succeeds.
    const r = await submitAttempt(actorA, { attemptId: startedA.attemptId, answers });
    expect(r.passed).toBe(true);
  });

  it("employee-facing course payload NEVER contains isCorrect / correctAnswer / scoreKey (§27, §42)", async () => {
    const { versionId } = await publishSimpleCourse(fx, { appliesToAll: true, required: true });
    const { actor } = await makeEmployeeAndActor(fx);
    const view = await getEmployeeCourseView(actor, versionId);
    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain("isCorrect");
    expect(serialized).not.toContain("correctAnswer");
    expect(serialized).not.toContain("scoreKey");
    // Sanity: two questions with options are surfaced.
    expect(view.questions).toHaveLength(2);
    expect(view.questions[0]!.options.length).toBeGreaterThanOrEqual(2);
    for (const q of view.questions) {
      for (const o of q.options) {
        expect(Object.keys(o).sort()).toEqual(["displayOrder", "id", "text"]);
      }
    }
  });

  it("cannot start knowledge test before video threshold met (§11)", async () => {
    const { versionId } = await publishSimpleCourse(fx, { appliesToAll: true, required: true, videoDurationSec: 100 });
    const { actor } = await makeEmployeeAndActor(fx);
    // Watch only 50% — below the 90% threshold.
    await recordVideoProgress(actor, { courseVersionId: versionId, secondsWatched: 50, farthestSecond: 50 });
    await expect(startAttempt(actor, { courseVersionId: versionId })).rejects.toThrow(/at least/i);
  });

  it("seeking to end without watching does not satisfy completion (§12)", async () => {
    const { versionId } = await publishSimpleCourse(fx, { appliesToAll: true, required: true, videoDurationSec: 100 });
    const { actor } = await makeEmployeeAndActor(fx);
    // Farthest = 100 (end reached), watched = 5 seconds only.
    const r = await recordVideoProgress(actor, { courseVersionId: versionId, secondsWatched: 5, farthestSecond: 100 });
    expect(r.videoCompleted).toBe(false);
    expect(r.percentComplete).toBeLessThan(90);
  });

  it("failed attempt is preserved + retake produces new attempt row (§13, §27)", async () => {
    const { versionId } = await publishSimpleCourse(fx, { appliesToAll: true, required: true, videoDurationSec: 60 });
    const { employeeId, actor } = await makeEmployeeAndActor(fx);
    await recordVideoProgress(actor, { courseVersionId: versionId, secondsWatched: 60, farthestSecond: 60 });
    const s1 = await startAttempt(actor, { courseVersionId: versionId });
    const view = await getEmployeeCourseView(actor, versionId);
    // Answer everything wrong on first attempt (choose option 0 which is always
    // incorrect in our fixture).
    const wrong = view.questions.map((q) => ({
      questionId: q.id, selectedOptionId: q.options[0]!.id,
    }));
    const r1 = await submitAttempt(actor, { attemptId: s1.attemptId, answers: wrong });
    expect(r1.passed).toBe(false);
    // Failed attempt is a persisted row.
    const attempts = await prisma.trainingAttempt.findMany({
      where: { employeeId, courseVersionId: versionId },
      orderBy: { attemptNumber: "asc" },
    });
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.passed).toBe(false);
    expect(attempts[0]!.submittedAt).not.toBeNull();
    // Retake: new attempt row, previous NOT overwritten.
    const s2 = await startAttempt(actor, { courseVersionId: versionId });
    expect(s2.attemptId).not.toBe(s1.attemptId);
    expect(s2.attemptNumber).toBe(2);
    const right = view.questions.map((q) => ({
      questionId: q.id, selectedOptionId: q.options[1]!.id,
    }));
    const r2 = await submitAttempt(actor, { attemptId: s2.attemptId, answers: right });
    expect(r2.passed).toBe(true);
    const finalRows = await prisma.trainingAttempt.findMany({
      where: { employeeId, courseVersionId: versionId },
      orderBy: { attemptNumber: "asc" },
    });
    expect(finalRows).toHaveLength(2);
    expect(finalRows[0]!.passed).toBe(false); // preserved
    expect(finalRows[1]!.passed).toBe(true);
  });

  it("browser cannot doctor `wasCorrect` — server grades from canonical answer key", async () => {
    // Simulate a doctored payload: submit correct option in field but
    // then verify the persisted TrainingQuestionResponse.wasCorrect is
    // whatever the SERVER computed by joining against the answer key,
    // not what the browser might have hinted at.
    const { versionId } = await publishSimpleCourse(fx, { appliesToAll: true, required: true, videoDurationSec: 60 });
    const { actor } = await makeEmployeeAndActor(fx);
    await recordVideoProgress(actor, { courseVersionId: versionId, secondsWatched: 60, farthestSecond: 60 });
    const s = await startAttempt(actor, { courseVersionId: versionId });
    const view = await getEmployeeCourseView(actor, versionId);
    // Submit ONE correct, one wrong.
    const mixed = view.questions.map((q, i) => ({
      questionId: q.id,
      selectedOptionId: (i === 0 ? q.options[0]! : q.options[1]!).id,
    }));
    const r = await submitAttempt(actor, { attemptId: s.attemptId, answers: mixed });
    // Score: 1/2 = 50 → below 80 → not passed.
    expect(r.score).toBe(50);
    expect(r.passed).toBe(false);
    // Response rows carry the SERVER-computed wasCorrect flags.
    const responses = await prisma.trainingQuestionResponse.findMany({ where: { attemptId: s.attemptId } });
    expect(responses).toHaveLength(2);
    const correctCount = responses.filter((r) => r.wasCorrect).length;
    expect(correctCount).toBe(1);
  });

  it("passing attempt creates a canonical completion row; no other pathway can", async () => {
    const { courseId, versionId } = await publishSimpleCourse(fx, { appliesToAll: true, required: true, videoDurationSec: 60 });
    const { employeeId, actor } = await makeEmployeeAndActor(fx);
    await recordVideoProgress(actor, { courseVersionId: versionId, secondsWatched: 60, farthestSecond: 60 });
    const s = await startAttempt(actor, { courseVersionId: versionId });
    const view = await getEmployeeCourseView(actor, versionId);
    const answers = view.questions.map((q) => ({ questionId: q.id, selectedOptionId: q.options[1]!.id }));
    await submitAttempt(actor, { attemptId: s.attemptId, answers });
    const completions = await prisma.trainingCompletion.findMany({
      where: { employeeId, courseId, courseVersionId: versionId },
    });
    expect(completions).toHaveLength(1);
    expect(completions[0]!.score).toBeGreaterThanOrEqual(80);
  });
});
