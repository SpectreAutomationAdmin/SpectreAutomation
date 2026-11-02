// EP-TRAIN-5C-1 (2026-11-02) — Obligation-aware compliance resolver
// contract tests.  Pure read-side classifier; dormant in 5C-1
// (consumed only by the backfill dry-run + eventual 5C-3 UI swap).
//
// Verifies the 7 compliance states on isolated fixtures.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { prisma } from "@/lib/prisma";
import { resetDb, seedRbac } from "../../util/db";
import {
  resolveEmployeeTrainingCompliance,
  outstandingCourses,
  type ComplianceState,
} from "@/lib/hr/training/compliance-resolver";

interface Fixture {
  clubId: string;
  employeeId: string;
  courseId: string;
  v1Id: string;
  v2Id: string | null;
}

async function makeClub(name: string) {
  return prisma.club.create({ data: { name, slug: `${name}-${Math.random().toString(36).slice(2, 8)}` } });
}

async function makeEmployee(clubId: string, personalEmail: string) {
  return prisma.employee.create({
    data: {
      clubId,
      employeeNumber: `C-${Math.floor(Math.random() * 90000 + 10000)}`,
      firstName: "Test", lastName: "Employee",
      personalEmail, employeeLifecycle: "ACTIVE",
    },
  });
}

async function makeCourseWithPublishedV1(clubId: string, opts: { required: boolean; appliesToAll: boolean }): Promise<{ courseId: string; v1Id: string }> {
  const course = await prisma.trainingCourse.create({
    data: { clubId, code: `CR_${Math.random().toString(36).slice(2, 6).toUpperCase()}`, title: "Compliance Resolver Course", category: "Safety" },
  });
  const v1 = await prisma.trainingCourseVersion.create({
    data: {
      courseId: course.id, version: 1, state: "PUBLISHED",
      title: "Compliance Resolver Course", publishedAt: new Date(),
      appliesToAll: opts.appliesToAll, required: opts.required,
      requiresKnowledgeTest: false,
    },
  });
  await prisma.trainingCourse.update({ where: { id: course.id }, data: { currentVersionId: v1.id } });
  return { courseId: course.id, v1Id: v1.id };
}

async function publishV2(courseId: string): Promise<string> {
  const v1 = await prisma.trainingCourseVersion.findFirst({ where: { courseId, state: "PUBLISHED" } });
  if (v1) await prisma.trainingCourseVersion.update({ where: { id: v1.id }, data: { state: "RETIRED", retiredAt: new Date() } });
  const v2 = await prisma.trainingCourseVersion.create({
    data: {
      courseId, version: 2, state: "PUBLISHED",
      title: "Compliance Resolver Course v2", publishedAt: new Date(),
      appliesToAll: true, required: true, requiresKnowledgeTest: false,
    },
  });
  await prisma.trainingCourse.update({ where: { id: courseId }, data: { currentVersionId: v2.id } });
  return v2.id;
}

async function seedCompletion(args: { clubId: string; employeeId: string; courseId: string; courseVersionId: string; completedAt: Date; attemptNumber?: number }) {
  const a = await prisma.trainingAttempt.create({
    data: {
      clubId: args.clubId, employeeId: args.employeeId, courseVersionId: args.courseVersionId,
      attemptNumber: args.attemptNumber ?? 1, submittedAt: args.completedAt,
      score: 100, passed: true,
    },
  });
  return prisma.trainingCompletion.create({
    data: {
      clubId: args.clubId, employeeId: args.employeeId, courseId: args.courseId,
      courseVersionId: args.courseVersionId, attemptId: a.id, score: 100,
      completedAt: args.completedAt,
    },
  });
}

async function seedOutstandingObligation(args: {
  clubId: string; employeeId: string; courseId: string; courseVersionId: string;
  reason: "INITIAL" | "REVISION" | "MANUAL_REINSTATE";
  issuedAt?: Date; reasonNote?: string;
}) {
  return prisma.trainingObligation.create({
    data: {
      clubId: args.clubId, employeeId: args.employeeId,
      courseId: args.courseId, courseVersionId: args.courseVersionId,
      reason: args.reason,
      reasonNote: args.reasonNote ?? null,
      issuedByUserId: null,
      issuedAt: args.issuedAt ?? new Date(),
      status: "OUTSTANDING",
      issuanceKey: `test:${args.reason}:${Math.random().toString(36).slice(2, 8)}`,
    },
  });
}

async function buildFixture(opts: { required: boolean; appliesToAll: boolean }): Promise<Fixture> {
  await resetDb(); await seedRbac();
  const club = await makeClub("CR Fx");
  const emp = await makeEmployee(club.id, `cr-${Date.now()}@x.test`);
  const course = await makeCourseWithPublishedV1(club.id, opts);
  return { clubId: club.id, employeeId: emp.id, courseId: course.courseId, v1Id: course.v1Id, v2Id: null };
}

describe("EP-TRAIN-5C-1 · compliance resolver (dormant)", () => {
  beforeAll(async () => { await resetDb(); await seedRbac(); });

  it("NO_REQUIREMENT when no course is applicable", async () => {
    await resetDb(); await seedRbac();
    const club = await makeClub("No Req");
    const emp = await makeEmployee(club.id, `no-req-${Date.now()}@x.test`);
    const result = await resolveEmployeeTrainingCompliance(emp.id);
    expect(result.summary.applicableCourseCount).toBe(0);
    expect(result.courses).toEqual([]);
    expect(outstandingCourses(result)).toEqual([]);
  });

  it("INITIAL_REQUIRED for a required applicable course with no completion + no obligation", async () => {
    const fx = await buildFixture({ required: true, appliesToAll: true });
    const result = await resolveEmployeeTrainingCompliance(fx.employeeId);
    expect(result.courses.length).toBe(1);
    expect(result.courses[0].state).toBe<ComplianceState>("INITIAL_REQUIRED");
    expect(result.courses[0].activeObligation).toBeNull();
    expect(result.courses[0].latestCompletion).toBeNull();
    expect(result.summary.compliantCount).toBe(0);
  });

  it("COMPLIANT when valid completion exists on the current PUBLISHED version AND no obligation", async () => {
    const fx = await buildFixture({ required: true, appliesToAll: true });
    await seedCompletion({ clubId: fx.clubId, employeeId: fx.employeeId, courseId: fx.courseId, courseVersionId: fx.v1Id, completedAt: new Date(Date.now() - 60_000) });
    const result = await resolveEmployeeTrainingCompliance(fx.employeeId);
    expect(result.courses[0].state).toBe<ComplianceState>("COMPLIANT");
    expect(result.courses[0].latestCompletion).not.toBeNull();
    expect(result.summary.compliantCount).toBe(1);
    expect(result.summary.outstandingObligationCount).toBe(0);
  });

  it("UPDATED_REQUIRED when an OUTSTANDING REVISION obligation is present", async () => {
    const fx = await buildFixture({ required: true, appliesToAll: true });
    await seedCompletion({ clubId: fx.clubId, employeeId: fx.employeeId, courseId: fx.courseId, courseVersionId: fx.v1Id, completedAt: new Date(Date.now() - 60_000) });
    const v2 = await publishV2(fx.courseId);
    await seedOutstandingObligation({ clubId: fx.clubId, employeeId: fx.employeeId, courseId: fx.courseId, courseVersionId: v2, reason: "REVISION" });
    const result = await resolveEmployeeTrainingCompliance(fx.employeeId);
    expect(result.courses[0].state).toBe<ComplianceState>("UPDATED_REQUIRED");
    expect(result.courses[0].activeObligation?.reason).toBe("REVISION");
    expect(result.courses[0].history.length).toBe(1); // v1 completion preserved
    expect(result.summary.outstandingObligationCount).toBe(1);
  });

  it("RETAKE_REQUIRED when an OUTSTANDING MANUAL_REINSTATE obligation is present", async () => {
    const fx = await buildFixture({ required: true, appliesToAll: true });
    await seedCompletion({ clubId: fx.clubId, employeeId: fx.employeeId, courseId: fx.courseId, courseVersionId: fx.v1Id, completedAt: new Date(Date.now() - 60_000) });
    await seedOutstandingObligation({ clubId: fx.clubId, employeeId: fx.employeeId, courseId: fx.courseId, courseVersionId: fx.v1Id, reason: "MANUAL_REINSTATE", reasonNote: "Policy refresh" });
    const result = await resolveEmployeeTrainingCompliance(fx.employeeId);
    expect(result.courses[0].state).toBe<ComplianceState>("RETAKE_REQUIRED");
    expect(result.courses[0].activeObligation?.reason).toBe("MANUAL_REINSTATE");
    expect(result.courses[0].activeObligation?.reasonNote).toBe("Policy refresh");
    expect(result.courses[0].latestCompletion).not.toBeNull();
  });

  it("MULTIPLE_OUTSTANDING when 2+ OUTSTANDING coexist (Keep Both)", async () => {
    const fx = await buildFixture({ required: true, appliesToAll: true });
    await seedOutstandingObligation({ clubId: fx.clubId, employeeId: fx.employeeId, courseId: fx.courseId, courseVersionId: fx.v1Id, reason: "MANUAL_REINSTATE", issuedAt: new Date(Date.now() - 120_000), reasonNote: "First ask" });
    await seedOutstandingObligation({ clubId: fx.clubId, employeeId: fx.employeeId, courseId: fx.courseId, courseVersionId: fx.v1Id, reason: "MANUAL_REINSTATE", issuedAt: new Date(Date.now() - 60_000), reasonNote: "Second ask" });
    const result = await resolveEmployeeTrainingCompliance(fx.employeeId);
    expect(result.courses[0].state).toBe<ComplianceState>("MULTIPLE_OUTSTANDING");
    expect(result.courses[0].outstandingObligationCount).toBe(2);
    // FIFO: oldest is the active obligation.
    expect(result.courses[0].activeObligation?.reasonNote).toBe("First ask");
  });

  it("IN_PROGRESS when the active obligation's version has progress", async () => {
    const fx = await buildFixture({ required: true, appliesToAll: true });
    await seedOutstandingObligation({ clubId: fx.clubId, employeeId: fx.employeeId, courseId: fx.courseId, courseVersionId: fx.v1Id, reason: "INITIAL" });
    await prisma.trainingProgress.create({
      data: {
        clubId: fx.clubId, employeeId: fx.employeeId, courseVersionId: fx.v1Id,
        secondsWatched: 15, farthestSecond: 15, percentComplete: 50,
      },
    });
    const result = await resolveEmployeeTrainingCompliance(fx.employeeId);
    expect(result.courses[0].state).toBe<ComplianceState>("IN_PROGRESS");
    expect(result.summary.inProgressCount).toBe(1);
  });

  it("history preserves every historical completion sorted DESC by completedAt", async () => {
    const fx = await buildFixture({ required: true, appliesToAll: true });
    const t1 = new Date("2026-01-01T00:00:00Z");
    const t2 = new Date("2026-06-01T00:00:00Z");
    await seedCompletion({ clubId: fx.clubId, employeeId: fx.employeeId, courseId: fx.courseId, courseVersionId: fx.v1Id, completedAt: t1, attemptNumber: 1 });
    await seedCompletion({ clubId: fx.clubId, employeeId: fx.employeeId, courseId: fx.courseId, courseVersionId: fx.v1Id, completedAt: t2, attemptNumber: 2 });
    const result = await resolveEmployeeTrainingCompliance(fx.employeeId);
    expect(result.courses[0].history.length).toBe(2);
    expect(result.courses[0].history[0].completedAt.getTime()).toBe(t2.getTime());
    expect(result.courses[0].history[1].completedAt.getTime()).toBe(t1.getTime());
  });

  it("outstandingCourses() returns only actionable courses sorted FIFO", async () => {
    const fx = await buildFixture({ required: true, appliesToAll: true });
    // Add a second published course so we have TWO applicable, one COMPLIANT + one OUTSTANDING.
    const extraCourse = await makeCourseWithPublishedV1(fx.clubId, { required: true, appliesToAll: true });
    await seedCompletion({ clubId: fx.clubId, employeeId: fx.employeeId, courseId: extraCourse.courseId, courseVersionId: extraCourse.v1Id, completedAt: new Date(Date.now() - 60_000) });
    await seedOutstandingObligation({ clubId: fx.clubId, employeeId: fx.employeeId, courseId: fx.courseId, courseVersionId: fx.v1Id, reason: "MANUAL_REINSTATE" });

    const result = await resolveEmployeeTrainingCompliance(fx.employeeId);
    expect(result.courses.length).toBe(2);
    const outstanding = outstandingCourses(result);
    expect(outstanding.length).toBe(1);
    expect(outstanding[0].courseId).toBe(fx.courseId);
  });

  it("tenant isolation: cross-club obligations are not surfaced", async () => {
    const fx = await buildFixture({ required: true, appliesToAll: true });
    // Fabricate an obligation in a DIFFERENT club with the SAME courseId
    // -- shouldn't actually happen in prod, but a defensive assertion.
    const foreignClub = await makeClub("Foreign CR");
    // Resolver takes employeeId; employee's clubId is used.  No way to
    // smuggle a foreign-club obligation into the resolver without
    // creating a foreign employee.  Instead verify: a second employee
    // in a DIFFERENT club with a REQUIRED applicable course sees ONLY
    // their own course + obligations.
    const foreignEmp = await makeEmployee(foreignClub.id, `f-${Date.now()}@x.test`);
    const foreignCourse = await makeCourseWithPublishedV1(foreignClub.id, { required: true, appliesToAll: true });
    await seedOutstandingObligation({ clubId: foreignClub.id, employeeId: foreignEmp.id, courseId: foreignCourse.courseId, courseVersionId: foreignCourse.v1Id, reason: "INITIAL" });

    const result = await resolveEmployeeTrainingCompliance(fx.employeeId);
    expect(result.clubId).toBe(fx.clubId);
    expect(result.courses.every((c) => c.courseId !== foreignCourse.courseId)).toBe(true);
  });
});
