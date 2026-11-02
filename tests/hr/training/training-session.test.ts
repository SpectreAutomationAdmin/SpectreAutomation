// EP-TRAIN-5C-2 (2026-11-02) — Obligation-scoped training session + atomic completion
// contract tests.  Covers the 10 scenarios in directive §11.
//
// Writes directly through the service helpers; avoids the video
// upload path (ffprobe is a known Windows-dev-box gap unrelated to
// this slice).

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { prisma } from "@/lib/prisma";
import { resetDb, seedRbac } from "../../util/db";
import {
  resolveActiveObligationForSession,
  upsertObligationScopedProgress,
  completeAndSatisfyAtomic,
} from "@/lib/hr/training/training-session";
import { issueObligation } from "@/lib/hr/training/obligations";

interface Fixture {
  clubId: string;
  foreignClubId: string;
  employeeId: string;
  foreignEmployeeId: string;
  courseId: string;
  v1Id: string;
}

async function build(): Promise<Fixture> {
  await resetDb(); await seedRbac();
  const club = await prisma.club.create({ data: { name: "Sess", slug: `sess-${Math.random().toString(36).slice(2, 8)}` } });
  const foreignClub = await prisma.club.create({ data: { name: "SessF", slug: `sessf-${Math.random().toString(36).slice(2, 8)}` } });
  const emp = await prisma.employee.create({
    data: {
      clubId: club.id, employeeNumber: `S-${Math.floor(Math.random() * 90000 + 10000)}`,
      firstName: "Sess", lastName: "Emp",
      personalEmail: `sess-${Date.now()}@x.test`, employeeLifecycle: "ACTIVE",
    },
  });
  const foreignEmp = await prisma.employee.create({
    data: {
      clubId: foreignClub.id, employeeNumber: `SF-${Math.floor(Math.random() * 90000 + 10000)}`,
      firstName: "Sess", lastName: "ForeignEmp",
      personalEmail: `sessf-${Date.now()}@x.test`, employeeLifecycle: "ACTIVE",
    },
  });
  const course = await prisma.trainingCourse.create({
    data: { clubId: club.id, code: `S_${Math.random().toString(36).slice(2, 6).toUpperCase()}`, title: "Session Course", category: "Safety" },
  });
  const v1 = await prisma.trainingCourseVersion.create({
    data: {
      courseId: course.id, version: 1, state: "PUBLISHED",
      title: "Session Course", publishedAt: new Date(),
      appliesToAll: true, required: true, requiresKnowledgeTest: false,
    },
  });
  await prisma.trainingCourse.update({ where: { id: course.id }, data: { currentVersionId: v1.id } });
  return { clubId: club.id, foreignClubId: foreignClub.id, employeeId: emp.id, foreignEmployeeId: foreignEmp.id, courseId: course.id, v1Id: v1.id };
}

async function seedCompletion(args: {
  clubId: string; employeeId: string; courseId: string; courseVersionId: string;
  completedAt: Date; attemptNumber: number; obligationId?: string | null;
}): Promise<{ attemptId: string; completionId: string }> {
  const a = await prisma.trainingAttempt.create({
    data: {
      clubId: args.clubId, employeeId: args.employeeId, courseVersionId: args.courseVersionId,
      attemptNumber: args.attemptNumber, submittedAt: args.completedAt,
      score: 100, passed: true,
      obligationId: args.obligationId ?? null,
    },
  });
  const c = await prisma.trainingCompletion.create({
    data: {
      clubId: args.clubId, employeeId: args.employeeId, courseId: args.courseId,
      courseVersionId: args.courseVersionId, attemptId: a.id, score: 100,
      completedAt: args.completedAt,
    },
  });
  return { attemptId: a.id, completionId: c.id };
}

async function seedOutstandingObligation(args: {
  clubId: string; employeeId: string; courseId: string; courseVersionId: string;
  reason: "INITIAL" | "REVISION" | "MANUAL_REINSTATE";
  issuedAt?: Date; reasonNote?: string;
}) {
  return issueObligation({
    clubId: args.clubId, employeeId: args.employeeId,
    courseId: args.courseId, courseVersionId: args.courseVersionId,
    reason: args.reason, reasonNote: args.reasonNote ?? null,
    issuedByUserId: null,
    issuedAt: args.issuedAt ?? new Date(),
    issuanceKey: `test-5c2:${args.reason}:${Math.random().toString(36).slice(2, 8)}`,
  });
}

describe("EP-TRAIN-5C-2 · obligation-scoped training session", () => {
  let fx: Fixture;
  beforeAll(async () => { await resetDb(); await seedRbac(); });
  beforeEach(async () => { fx = await build(); });

  // §11.A — Original completion retained when a new obligation is issued.
  it("§11.A — original completion/attempt rows survive issuance of a new obligation", async () => {
    const seeded = await seedCompletion({
      clubId: fx.clubId, employeeId: fx.employeeId, courseId: fx.courseId,
      courseVersionId: fx.v1Id, completedAt: new Date("2026-01-15T00:00:00Z"), attemptNumber: 1,
    });
    await seedOutstandingObligation({
      clubId: fx.clubId, employeeId: fx.employeeId, courseId: fx.courseId,
      courseVersionId: fx.v1Id, reason: "MANUAL_REINSTATE", reasonNote: "test",
    });
    const stillCompletion = await prisma.trainingCompletion.findUnique({ where: { id: seeded.completionId } });
    const stillAttempt = await prisma.trainingAttempt.findUnique({ where: { id: seeded.attemptId } });
    expect(stillCompletion?.completedAt.toISOString()).toBe("2026-01-15T00:00:00.000Z");
    expect(stillAttempt?.score).toBe(100);
    expect(stillCompletion?.score).toBe(100);
  });

  // §11.B — New obligation starts with zero watched coverage + no cleared checkpoints.
  it("§11.B — new obligation progress starts at zero (separate row from legacy)", async () => {
    // Legacy singleton progress with 42s watched.
    await prisma.trainingProgress.create({
      data: {
        clubId: fx.clubId, employeeId: fx.employeeId, courseVersionId: fx.v1Id,
        secondsWatched: 42, farthestSecond: 42, percentComplete: 100,
        checkpointClearedJson: '["cp-legacy"]',
      },
    });
    const ob = await seedOutstandingObligation({
      clubId: fx.clubId, employeeId: fx.employeeId, courseId: fx.courseId,
      courseVersionId: fx.v1Id, reason: "MANUAL_REINSTATE",
    });
    // First obligation-scoped progress read -> no row yet.
    const initial = await prisma.trainingProgress.findFirst({
      where: {
        employeeId: fx.employeeId, courseVersionId: fx.v1Id, obligationId: ob.id,
      },
    });
    expect(initial).toBeNull();
    // Legacy row still intact.
    const legacy = await prisma.trainingProgress.findFirst({
      where: {
        employeeId: fx.employeeId, courseVersionId: fx.v1Id, obligationId: null,
      },
    });
    expect(legacy?.secondsWatched).toBe(42);
    expect(legacy?.checkpointClearedJson).toBe('["cp-legacy"]');
    // Scoped upsert creates a NEW row that does NOT inherit legacy state.
    const written = await upsertObligationScopedProgress({
      clubId: fx.clubId, employeeId: fx.employeeId, courseVersionId: fx.v1Id,
      obligationId: ob.id,
      nextSecondsWatched: 5, nextFarthestSecond: 5, nextPercentComplete: 10,
    });
    expect(written.secondsWatched).toBe(5);
    expect(written.checkpointClearedJson).toBeNull();
    // Legacy row STILL unchanged.
    const legacyAfter = await prisma.trainingProgress.findFirst({
      where: { employeeId: fx.employeeId, courseVersionId: fx.v1Id, obligationId: null },
    });
    expect(legacyAfter?.secondsWatched).toBe(42);
  });

  // §11.D — New completion event has a distinct id + attempt id.
  it("§11.D — completeAndSatisfyAtomic creates a new TrainingCompletion for a retake attempt + satisfies the obligation", async () => {
    const first = await seedCompletion({
      clubId: fx.clubId, employeeId: fx.employeeId, courseId: fx.courseId,
      courseVersionId: fx.v1Id, completedAt: new Date(Date.now() - 60_000), attemptNumber: 1,
    });
    const ob = await seedOutstandingObligation({
      clubId: fx.clubId, employeeId: fx.employeeId, courseId: fx.courseId,
      courseVersionId: fx.v1Id, reason: "MANUAL_REINSTATE",
    });
    // New retake attempt (attemptNumber=2) stamped with the obligation.
    const retakeAttempt = await prisma.trainingAttempt.create({
      data: {
        clubId: fx.clubId, employeeId: fx.employeeId, courseVersionId: fx.v1Id,
        attemptNumber: 2, submittedAt: new Date(), score: 95, passed: true,
        obligationId: ob.id,
      },
    });
    const result = await completeAndSatisfyAtomic({
      clubId: fx.clubId, employeeId: fx.employeeId, courseId: fx.courseId,
      courseVersionId: fx.v1Id, attemptId: retakeAttempt.id, score: 95,
      activeObligationId: ob.id,
    });
    expect(result.createdCompletion).toBe(true);
    expect(result.satisfiedObligationId).toBe(ob.id);
    expect(result.completionId).not.toBe(first.completionId);
    const obAfter = await prisma.trainingObligation.findUnique({ where: { id: ob.id } });
    expect(obAfter?.status).toBe("SATISFIED");
    expect(obAfter?.satisfiedByCompletionId).toBe(result.completionId);
    // History: 2 completions on this (employee, version).
    const historyCount = await prisma.trainingCompletion.count({
      where: { employeeId: fx.employeeId, courseVersionId: fx.v1Id },
    });
    expect(historyCount).toBe(2);
  });

  // §11.E — Atomicity: a failing satisfaction rolls back the completion.
  it("§11.E — atomic rollback: issue an obligation THEN cancel it, then verify completeAndSatisfy rolls back the completion when satisfaction fails", async () => {
    const ob = await seedOutstandingObligation({
      clubId: fx.clubId, employeeId: fx.employeeId, courseId: fx.courseId,
      courseVersionId: fx.v1Id, reason: "MANUAL_REINSTATE",
    });
    // Make the obligation terminal mid-flight by cancelling it first.
    await prisma.trainingObligation.update({ where: { id: ob.id }, data: { status: "CANCELED" } });
    const attempt = await prisma.trainingAttempt.create({
      data: {
        clubId: fx.clubId, employeeId: fx.employeeId, courseVersionId: fx.v1Id,
        attemptNumber: 1, submittedAt: new Date(), score: 100, passed: true,
        obligationId: ob.id,
      },
    });
    await expect(completeAndSatisfyAtomic({
      clubId: fx.clubId, employeeId: fx.employeeId, courseId: fx.courseId,
      courseVersionId: fx.v1Id, attemptId: attempt.id, score: 100,
      activeObligationId: ob.id,
    })).rejects.toThrow();
    // Rollback verification: no TrainingCompletion for this attempt exists.
    const orphan = await prisma.trainingCompletion.findUnique({ where: { attemptId: attempt.id } });
    expect(orphan).toBeNull();
  });

  // §11.F — Duplicate submission idempotent.
  it("§11.F — a repeated completeAndSatisfyAtomic for the SAME attempt returns the existing completion + does not re-satisfy", async () => {
    const ob = await seedOutstandingObligation({
      clubId: fx.clubId, employeeId: fx.employeeId, courseId: fx.courseId,
      courseVersionId: fx.v1Id, reason: "MANUAL_REINSTATE",
    });
    const attempt = await prisma.trainingAttempt.create({
      data: {
        clubId: fx.clubId, employeeId: fx.employeeId, courseVersionId: fx.v1Id,
        attemptNumber: 1, submittedAt: new Date(), score: 100, passed: true,
        obligationId: ob.id,
      },
    });
    const first = await completeAndSatisfyAtomic({
      clubId: fx.clubId, employeeId: fx.employeeId, courseId: fx.courseId,
      courseVersionId: fx.v1Id, attemptId: attempt.id, score: 100,
      activeObligationId: ob.id,
    });
    const second = await completeAndSatisfyAtomic({
      clubId: fx.clubId, employeeId: fx.employeeId, courseId: fx.courseId,
      courseVersionId: fx.v1Id, attemptId: attempt.id, score: 100,
      activeObligationId: ob.id,
    });
    expect(second.completionId).toBe(first.completionId);
    expect(second.createdCompletion).toBe(false);
    expect(second.satisfiedObligationId).toBeNull();
    const count = await prisma.trainingCompletion.count({ where: { employeeId: fx.employeeId, courseVersionId: fx.v1Id } });
    expect(count).toBe(1);
  });

  // §11.G — Keep Both: two obligations, each requires its own completion.
  it("§11.G — resolveActiveObligationForSession returns FIFO oldest; completing it leaves the newer OUTSTANDING", async () => {
    const first = await seedOutstandingObligation({
      clubId: fx.clubId, employeeId: fx.employeeId, courseId: fx.courseId,
      courseVersionId: fx.v1Id, reason: "MANUAL_REINSTATE",
      issuedAt: new Date(Date.now() - 60 * 60_000), reasonNote: "First",
    });
    const second = await seedOutstandingObligation({
      clubId: fx.clubId, employeeId: fx.employeeId, courseId: fx.courseId,
      courseVersionId: fx.v1Id, reason: "MANUAL_REINSTATE",
      issuedAt: new Date(), reasonNote: "Second",
    });
    const active = await resolveActiveObligationForSession({
      employeeId: fx.employeeId, courseVersionId: fx.v1Id,
    });
    expect(active?.id).toBe(first.id);
    // Satisfy the first.
    const attempt = await prisma.trainingAttempt.create({
      data: {
        clubId: fx.clubId, employeeId: fx.employeeId, courseVersionId: fx.v1Id,
        attemptNumber: 1, submittedAt: new Date(), score: 100, passed: true,
        obligationId: first.id,
      },
    });
    await completeAndSatisfyAtomic({
      clubId: fx.clubId, employeeId: fx.employeeId, courseId: fx.courseId,
      courseVersionId: fx.v1Id, attemptId: attempt.id, score: 100,
      activeObligationId: first.id,
    });
    // Now the next active is the second.
    const activeAfter = await resolveActiveObligationForSession({
      employeeId: fx.employeeId, courseVersionId: fx.v1Id,
    });
    expect(activeAfter?.id).toBe(second.id);
  });

  // §11.H — Cross-tenant refusal.
  it("§11.H — completeAndSatisfyAtomic refuses when the attempt belongs to a different subject", async () => {
    // Create an attempt in the foreign club.
    const foreignCourse = await prisma.trainingCourse.create({
      data: { clubId: fx.foreignClubId, code: `F_${Math.random().toString(36).slice(2, 6)}`, title: "F", category: "Safety" },
    });
    const foreignVersion = await prisma.trainingCourseVersion.create({
      data: { courseId: foreignCourse.id, version: 1, state: "PUBLISHED", title: "F", publishedAt: new Date(), appliesToAll: true },
    });
    const foreignAttempt = await prisma.trainingAttempt.create({
      data: {
        clubId: fx.foreignClubId, employeeId: fx.foreignEmployeeId, courseVersionId: foreignVersion.id,
        attemptNumber: 1, submittedAt: new Date(), score: 100, passed: true,
      },
    });
    // Try to submit the completion against the HOME club's authenticated subject.
    await expect(completeAndSatisfyAtomic({
      clubId: fx.clubId, employeeId: fx.employeeId, courseId: fx.courseId,
      courseVersionId: fx.v1Id, attemptId: foreignAttempt.id, score: 100,
      activeObligationId: null,
    })).rejects.toThrow();
    const orphan = await prisma.trainingCompletion.findUnique({ where: { attemptId: foreignAttempt.id } });
    expect(orphan).toBeNull();
  });

  // §11.I — Existing completed replay unchanged (legacy path).
  it("§11.I — resolveActiveObligationForSession returns null when no OUTSTANDING exists, enabling the legacy replay path", async () => {
    await seedCompletion({
      clubId: fx.clubId, employeeId: fx.employeeId, courseId: fx.courseId,
      courseVersionId: fx.v1Id, completedAt: new Date(), attemptNumber: 1,
    });
    const active = await resolveActiveObligationForSession({
      employeeId: fx.employeeId, courseVersionId: fx.v1Id,
    });
    expect(active).toBeNull();
    // Reading the legacy singleton row works unchanged.
    const legacyProgress = await prisma.trainingProgress.create({
      data: {
        clubId: fx.clubId, employeeId: fx.employeeId, courseVersionId: fx.v1Id,
        secondsWatched: 30, farthestSecond: 30, percentComplete: 100,
      },
    });
    const fetched = await prisma.trainingProgress.findFirst({
      where: { employeeId: fx.employeeId, courseVersionId: fx.v1Id, obligationId: null },
    });
    expect(fetched?.id).toBe(legacyProgress.id);
  });

  // §11.C — assessment gating: historical passing score cannot unlock the new assessment.
  it("§11.C — satisfyObligationWithCompletion refuses to link a historical completion to a later-issued obligation", async () => {
    // Legacy completion first.
    const historical = await seedCompletion({
      clubId: fx.clubId, employeeId: fx.employeeId, courseId: fx.courseId,
      courseVersionId: fx.v1Id, completedAt: new Date("2026-01-01T00:00:00Z"), attemptNumber: 1,
    });
    // Later obligation.
    const ob = await seedOutstandingObligation({
      clubId: fx.clubId, employeeId: fx.employeeId, courseId: fx.courseId,
      courseVersionId: fx.v1Id, reason: "MANUAL_REINSTATE",
      issuedAt: new Date(),
    });
    // Attempt to satisfy with the OLD completion is refused by EP-TRAIN-5A-1
    // invariant 3 (predates obligation issuance).
    const { satisfyObligationWithCompletion } = await import("@/lib/hr/training/obligations");
    await expect(satisfyObligationWithCompletion({
      obligationId: ob.id, completionId: historical.completionId,
    })).rejects.toMatchObject({ issues: [{ path: "completionId", message: expect.stringMatching(/predates obligation issuance/) }] });
    // Obligation remains OUTSTANDING.
    const obAfter = await prisma.trainingObligation.findUnique({ where: { id: ob.id } });
    expect(obAfter?.status).toBe("OUTSTANDING");
  });
});
