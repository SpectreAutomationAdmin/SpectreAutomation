// EP-TRAIN-5A (2026-11-01) — Training obligation contract tests.
//
// Verifies the four invariants documented against TrainingObligation
// in prisma/schema.prisma:
//
//   1. At most ONE OUTSTANDING obligation per (employee, courseVersionId, reason)
//   2. One completion satisfies AT MOST one obligation
//   3. An old completion must not automatically satisfy a newly issued obligation
//   4. Tenant isolation: cross-club writes are refused
//
// Also exercises the full state-machine (OUTSTANDING → SATISFIED /
// CANCELED / SUPERSEDED) and the read-side helper.
//
// Writes directly into Prisma to avoid depending on uploadTrainingVideo
// (which needs ffprobe + is not relevant to the obligation model).

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { prisma } from "@/lib/prisma";
import { resetDb, seedRbac } from "../../util/db";
import {
  issueObligation,
  satisfyObligationWithCompletion,
  cancelObligation,
  supersedeObligation,
  listOutstandingObligationsForEmployee,
  pickObligationToSatisfy,
  composeIssuanceKey,
} from "@/lib/hr/training/obligations";
import { randomUUID } from "node:crypto";

/** EP-TRAIN-5A-1 helper — fresh per-event issuance key. */
function k(): string { return `evt:${randomUUID()}`; }

async function makeClub(name: string) {
  return prisma.club.create({ data: { name, slug: `${name}-${Math.random().toString(36).slice(2, 8)}` } });
}

async function makeEmployee(clubId: string, personalEmail: string) {
  return prisma.employee.create({
    data: {
      clubId,
      employeeNumber: `E-${Math.floor(Math.random() * 90000 + 10000)}`,
      firstName: "Test", lastName: "Employee",
      personalEmail,
    },
  });
}

async function makeCourseWithVersion(clubId: string, opts?: { versionNumber?: number }): Promise<{ courseId: string; versionId: string }> {
  const course = await prisma.trainingCourse.create({
    data: {
      clubId,
      code: `OBG_${Math.floor(Math.random() * 90000 + 10000)}`,
      title: "Obligation Test Course",
      category: "Safety",
    },
  });
  const version = await prisma.trainingCourseVersion.create({
    data: {
      courseId: course.id,
      version: opts?.versionNumber ?? 1,
      state: "PUBLISHED",
      title: "Obligation Test Course",
      publishedAt: new Date(),
    },
  });
  return { courseId: course.id, versionId: version.id };
}

/** Create a passing TrainingAttempt + the corresponding TrainingCompletion
 *  (both are required to satisfy an obligation).  `completedAt` is
 *  the key input — the service rejects satisfying with a completion
 *  older than the obligation's issuedAt. */
async function makeCompletion(args: {
  clubId: string;
  employeeId: string;
  courseId: string;
  courseVersionId: string;
  completedAt: Date;
  attemptNumber?: number;
}) {
  const attempt = await prisma.trainingAttempt.create({
    data: {
      clubId: args.clubId,
      employeeId: args.employeeId,
      courseVersionId: args.courseVersionId,
      attemptNumber: args.attemptNumber ?? 1,
      startedAt: new Date(args.completedAt.getTime() - 60_000),
      submittedAt: args.completedAt,
      score: 100,
      passed: true,
    },
  });
  const completion = await prisma.trainingCompletion.create({
    data: {
      clubId: args.clubId,
      employeeId: args.employeeId,
      courseId: args.courseId,
      courseVersionId: args.courseVersionId,
      attemptId: attempt.id,
      score: 100,
      completedAt: args.completedAt,
    },
  });
  return completion;
}

describe("EP-TRAIN-5A · TrainingObligation contract", () => {
  beforeAll(async () => { await resetDb(); await seedRbac(); });
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  describe("composeIssuanceKey", () => {
    it("prefixes by reason", () => {
      expect(composeIssuanceKey("INITIAL", "abc")).toBe("init:abc");
      expect(composeIssuanceKey("REVISION", "abc")).toBe("rev:abc");
      expect(composeIssuanceKey("MANUAL_REINSTATE", "abc")).toBe("rtk:abc");
      expect(composeIssuanceKey("RECERTIFICATION", "abc")).toBe("rec:abc");
    });
  });

  describe("issueObligation", () => {
    it("creates an OUTSTANDING row stamped with the supplied issuanceKey", async () => {
      const club = await makeClub("Issue A");
      const emp = await makeEmployee(club.id, `issue-a-${Date.now()}@x.test`);
      const { courseId, versionId } = await makeCourseWithVersion(club.id);
      const issuanceKey = k();
      const obligation = await issueObligation({
        clubId: club.id, employeeId: emp.id, courseId, courseVersionId: versionId,
        reason: "REVISION", issuedByUserId: null, issuanceKey,
      });
      expect(obligation.status).toBe("OUTSTANDING");
      expect(obligation.reason).toBe("REVISION");
      const row = await prisma.trainingObligation.findUnique({ where: { id: obligation.id } });
      expect(row?.issuanceKey).toBe(issuanceKey);
    });

    it("EP-TRAIN-5A-1 — repeat call with SAME issuanceKey is idempotent (no duplicate)", async () => {
      const club = await makeClub("Issue B");
      const emp = await makeEmployee(club.id, `issue-b-${Date.now()}@x.test`);
      const { courseId, versionId } = await makeCourseWithVersion(club.id);
      const issuanceKey = k();
      const first = await issueObligation({
        clubId: club.id, employeeId: emp.id, courseId, courseVersionId: versionId,
        reason: "REVISION", issuedByUserId: null, issuanceKey,
      });
      const second = await issueObligation({
        clubId: club.id, employeeId: emp.id, courseId, courseVersionId: versionId,
        reason: "REVISION", issuedByUserId: null, issuanceKey, // SAME key
      });
      expect(second.id).toBe(first.id);
      const count = await prisma.trainingObligation.count({
        where: { employeeId: emp.id, courseVersionId: versionId, reason: "REVISION" },
      });
      expect(count).toBe(1);
    });

    it("EP-TRAIN-5A-1 — two authorized retakes with DIFFERENT issuanceKeys coexist OUTSTANDING", async () => {
      const club = await makeClub("Issue B2");
      const emp = await makeEmployee(club.id, `issue-b2-${Date.now()}@x.test`);
      const { courseId, versionId } = await makeCourseWithVersion(club.id);
      const first = await issueObligation({
        clubId: club.id, employeeId: emp.id, courseId, courseVersionId: versionId,
        reason: "MANUAL_REINSTATE", issuedByUserId: null, issuanceKey: k(),
      });
      const second = await issueObligation({
        clubId: club.id, employeeId: emp.id, courseId, courseVersionId: versionId,
        reason: "MANUAL_REINSTATE", issuedByUserId: null, issuanceKey: k(), // DIFFERENT key
      });
      expect(second.id).not.toBe(first.id);
      expect(first.status).toBe("OUTSTANDING");
      expect(second.status).toBe("OUTSTANDING");
      const rows = await prisma.trainingObligation.findMany({
        where: { employeeId: emp.id, courseVersionId: versionId, reason: "MANUAL_REINSTATE", status: "OUTSTANDING" },
      });
      expect(rows.length).toBe(2);
    });

    it("EP-TRAIN-5A-1 — missing issuanceKey is rejected", async () => {
      const club = await makeClub("Issue B3");
      const emp = await makeEmployee(club.id, `issue-b3-${Date.now()}@x.test`);
      const { courseId, versionId } = await makeCourseWithVersion(club.id);
      await expect(issueObligation({
        clubId: club.id, employeeId: emp.id, courseId, courseVersionId: versionId,
        reason: "REVISION", issuedByUserId: null, issuanceKey: "", // empty
      })).rejects.toMatchObject({ issues: [{ path: "issuanceKey", message: expect.stringMatching(/issuanceKey is required/) }] });
    });

    it("different reasons do NOT collide (both OUTSTANDING coexist)", async () => {
      const club = await makeClub("Issue C");
      const emp = await makeEmployee(club.id, `issue-c-${Date.now()}@x.test`);
      const { courseId, versionId } = await makeCourseWithVersion(club.id);
      const a = await issueObligation({
        clubId: club.id, employeeId: emp.id, courseId, courseVersionId: versionId,
        reason: "REVISION", issuedByUserId: null, issuanceKey: k(),
      });
      const b = await issueObligation({
        clubId: club.id, employeeId: emp.id, courseId, courseVersionId: versionId,
        reason: "MANUAL_REINSTATE", issuedByUserId: null, issuanceKey: k(),
      });
      expect(a.id).not.toBe(b.id);
      expect(a.status).toBe("OUTSTANDING");
      expect(b.status).toBe("OUTSTANDING");
    });

    it("Invariant 4 — refuses when clubId does not match the course's club", async () => {
      const clubA = await makeClub("Issue D-A");
      const clubB = await makeClub("Issue D-B");
      const emp = await makeEmployee(clubA.id, `issue-d-${Date.now()}@x.test`);
      const { courseId, versionId } = await makeCourseWithVersion(clubA.id);
      await expect(issueObligation({
        clubId: clubB.id, // wrong club
        employeeId: emp.id, courseId, courseVersionId: versionId,
        reason: "REVISION", issuedByUserId: null, issuanceKey: k(),
      })).rejects.toMatchObject({ issues: [{ path: "clubId", message: expect.stringMatching(/clubId does not match/) }] });
    });

    it("refuses when courseId does not match the version's courseId", async () => {
      const club = await makeClub("Issue E");
      const emp = await makeEmployee(club.id, `issue-e-${Date.now()}@x.test`);
      const a = await makeCourseWithVersion(club.id);
      const b = await makeCourseWithVersion(club.id);
      await expect(issueObligation({
        clubId: club.id, employeeId: emp.id,
        courseId: a.courseId,
        courseVersionId: b.versionId, // belongs to a different course
        reason: "REVISION", issuedByUserId: null, issuanceKey: k(),
      })).rejects.toMatchObject({ issues: [{ path: "courseId", message: expect.stringMatching(/courseId does not match/) }] });
    });
  });

  describe("satisfyObligationWithCompletion", () => {
    it("marks SATISFIED + stamps satisfiedByCompletionId; issuanceKey preserved", async () => {
      const club = await makeClub("Sat A");
      const emp = await makeEmployee(club.id, `sat-a-${Date.now()}@x.test`);
      const { courseId, versionId } = await makeCourseWithVersion(club.id);
      const issuanceKey = k();
      const obligation = await issueObligation({
        clubId: club.id, employeeId: emp.id, courseId, courseVersionId: versionId,
        reason: "REVISION", issuedByUserId: null, issuanceKey,
      });
      const completion = await makeCompletion({
        clubId: club.id, employeeId: emp.id, courseId, courseVersionId: versionId,
        completedAt: new Date(obligation.issuedAt.getTime() + 60_000),
      });
      const updated = await satisfyObligationWithCompletion({
        obligationId: obligation.id, completionId: completion.id,
      });
      expect(updated.status).toBe("SATISFIED");
      expect(updated.satisfiedByCompletionId).toBe(completion.id);
      const row = await prisma.trainingObligation.findUnique({ where: { id: obligation.id } });
      expect(row?.issuanceKey).toBe(issuanceKey); // EP-TRAIN-5A-1 — preserved on terminal
    });

    it("Invariant 2 — a second obligation cannot be satisfied by the same completion", async () => {
      const club = await makeClub("Sat B");
      const emp = await makeEmployee(club.id, `sat-b-${Date.now()}@x.test`);
      const { courseId, versionId } = await makeCourseWithVersion(club.id);
      const first = await issueObligation({
        clubId: club.id, employeeId: emp.id, courseId, courseVersionId: versionId,
        reason: "REVISION", issuedByUserId: null, issuanceKey: k(),
      });
      const completion = await makeCompletion({
        clubId: club.id, employeeId: emp.id, courseId, courseVersionId: versionId,
        completedAt: new Date(first.issuedAt.getTime() + 60_000),
      });
      await satisfyObligationWithCompletion({ obligationId: first.id, completionId: completion.id });

      // Issue a second obligation (different reason so it can coexist)
      // and try to double-claim the same completion id.
      const second = await issueObligation({
        clubId: club.id, employeeId: emp.id, courseId, courseVersionId: versionId,
        reason: "MANUAL_REINSTATE", issuedByUserId: null, issuanceKey: k(),
        issuedAt: new Date(first.issuedAt.getTime() - 60_000), // issue date before completion
      });
      await expect(satisfyObligationWithCompletion({
        obligationId: second.id, completionId: completion.id,
      })).rejects.toThrow(); // DB unique-constraint error on satisfiedByCompletionId
    });

    it("Invariant 3 — refuses to satisfy with a completion created BEFORE the obligation was issued", async () => {
      const club = await makeClub("Sat C");
      const emp = await makeEmployee(club.id, `sat-c-${Date.now()}@x.test`);
      const { courseId, versionId } = await makeCourseWithVersion(club.id);
      const past = new Date(Date.now() - 10 * 60_000);
      const completion = await makeCompletion({
        clubId: club.id, employeeId: emp.id, courseId, courseVersionId: versionId,
        completedAt: past,
      });
      const obligation = await issueObligation({
        clubId: club.id, employeeId: emp.id, courseId, courseVersionId: versionId,
        reason: "MANUAL_REINSTATE", issuedByUserId: null, issuedAt: new Date(), issuanceKey: k(),
      });
      await expect(satisfyObligationWithCompletion({
        obligationId: obligation.id, completionId: completion.id,
      })).rejects.toMatchObject({ issues: [{ path: "completionId", message: expect.stringMatching(/predates obligation issuance/) }] });
    });

    it("refuses to satisfy a completion from a different (course, employee, club) subject", async () => {
      const club = await makeClub("Sat D");
      const empA = await makeEmployee(club.id, `sat-d-a-${Date.now()}@x.test`);
      const empB = await makeEmployee(club.id, `sat-d-b-${Date.now()}@x.test`);
      const { courseId, versionId } = await makeCourseWithVersion(club.id);
      const obligation = await issueObligation({
        clubId: club.id, employeeId: empA.id, courseId, courseVersionId: versionId,
        reason: "REVISION", issuedByUserId: null, issuanceKey: k(),
      });
      const completion = await makeCompletion({
        clubId: club.id, employeeId: empB.id, courseId, courseVersionId: versionId,
        completedAt: new Date(obligation.issuedAt.getTime() + 60_000),
      });
      await expect(satisfyObligationWithCompletion({
        obligationId: obligation.id, completionId: completion.id,
      })).rejects.toMatchObject({ issues: [{ path: "completionId", message: expect.stringMatching(/does not match obligation subject/) }] });
    });
  });

  describe("EP-TRAIN-5A-1 — TrainingCompletion history", () => {
    it("two completions of the SAME courseVersion coexist with distinct ids + timestamps", async () => {
      const club = await makeClub("Hist A");
      const emp = await makeEmployee(club.id, `hist-a-${Date.now()}@x.test`);
      const { courseId, versionId } = await makeCourseWithVersion(club.id);
      const t1 = new Date(Date.now() - 60 * 60_000);
      const t2 = new Date(Date.now() -  5 * 60_000);
      const c1 = await makeCompletion({
        clubId: club.id, employeeId: emp.id, courseId, courseVersionId: versionId,
        completedAt: t1, attemptNumber: 1,
      });
      const c2 = await makeCompletion({
        clubId: club.id, employeeId: emp.id, courseId, courseVersionId: versionId,
        completedAt: t2, attemptNumber: 2,
      });
      expect(c1.id).not.toBe(c2.id);
      expect(c1.completedAt.getTime()).toBe(t1.getTime());
      expect(c2.completedAt.getTime()).toBe(t2.getTime());

      // The original completion is unmodified by the retake.
      const stillOriginal = await prisma.trainingCompletion.findUnique({ where: { id: c1.id } });
      expect(stillOriginal?.completedAt.getTime()).toBe(t1.getTime());
      expect(stillOriginal?.score).toBe(100);

      // findMany returns both; findFirst-latest returns the retake.
      const all = await prisma.trainingCompletion.findMany({
        where: { employeeId: emp.id, courseVersionId: versionId },
        orderBy: { completedAt: "asc" },
      });
      expect(all.map((r) => r.id)).toEqual([c1.id, c2.id]);
      const latest = await prisma.trainingCompletion.findFirst({
        where: { employeeId: emp.id, courseVersionId: versionId },
        orderBy: { completedAt: "desc" },
      });
      expect(latest?.id).toBe(c2.id);
    });

    it("Invariant 2 (per-attempt) — two completions cannot share the same attemptId", async () => {
      const club = await makeClub("Hist B");
      const emp = await makeEmployee(club.id, `hist-b-${Date.now()}@x.test`);
      const { courseId, versionId } = await makeCourseWithVersion(club.id);
      const attempt = await prisma.trainingAttempt.create({
        data: {
          clubId: club.id, employeeId: emp.id, courseVersionId: versionId,
          attemptNumber: 1, submittedAt: new Date(), score: 100, passed: true,
        },
      });
      await prisma.trainingCompletion.create({
        data: {
          clubId: club.id, employeeId: emp.id, courseId, courseVersionId: versionId,
          attemptId: attempt.id, score: 100,
        },
      });
      // Second create with the SAME attemptId must fail -- this is the
      // guard that prevents a browser double-submit from writing twice.
      await expect(prisma.trainingCompletion.create({
        data: {
          clubId: club.id, employeeId: emp.id, courseId, courseVersionId: versionId,
          attemptId: attempt.id, score: 100,
        },
      })).rejects.toThrow();
    });
  });

  describe("EP-TRAIN-5A-1 — pickObligationToSatisfy (FIFO)", () => {
    it("picks the OLDEST OUTSTANDING obligation whose issuedAt <= completion.completedAt", async () => {
      const club = await makeClub("Fifo A");
      const emp = await makeEmployee(club.id, `fifo-a-${Date.now()}@x.test`);
      const { courseId, versionId } = await makeCourseWithVersion(club.id);
      const now = new Date();
      const earlier = new Date(now.getTime() - 60 * 60_000);
      const later   = new Date(now.getTime() - 10 * 60_000);
      const future  = new Date(now.getTime() + 60 * 60_000);
      const older = await issueObligation({
        clubId: club.id, employeeId: emp.id, courseId, courseVersionId: versionId,
        reason: "MANUAL_REINSTATE", issuedByUserId: null, issuanceKey: k(),
        issuedAt: earlier,
      });
      const newer = await issueObligation({
        clubId: club.id, employeeId: emp.id, courseId, courseVersionId: versionId,
        reason: "MANUAL_REINSTATE", issuedByUserId: null, issuanceKey: k(),
        issuedAt: later,
      });
      const futureOne = await issueObligation({
        clubId: club.id, employeeId: emp.id, courseId, courseVersionId: versionId,
        reason: "MANUAL_REINSTATE", issuedByUserId: null, issuanceKey: k(),
        issuedAt: future, // not yet eligible for `now` completion
      });
      // All three OUTSTANDING, differ only in issuedAt.
      const pickedForNow = await pickObligationToSatisfy({
        employeeId: emp.id, courseVersionId: versionId,
        completionCompletedAt: now,
      });
      expect(pickedForNow?.id).toBe(older.id);

      // After satisfying older, the next FIFO pick is newer.
      const completion = await makeCompletion({
        clubId: club.id, employeeId: emp.id, courseId, courseVersionId: versionId,
        completedAt: now, attemptNumber: 1,
      });
      await satisfyObligationWithCompletion({ obligationId: older.id, completionId: completion.id });
      const pickedAfter = await pickObligationToSatisfy({
        employeeId: emp.id, courseVersionId: versionId,
        completionCompletedAt: now,
      });
      expect(pickedAfter?.id).toBe(newer.id);

      // future-issued obligation ignored for now-completion.
      expect(pickedAfter?.id).not.toBe(futureOne.id);
    });

    it("returns null when nothing is OUTSTANDING or everything is in the future", async () => {
      const club = await makeClub("Fifo B");
      const emp = await makeEmployee(club.id, `fifo-b-${Date.now()}@x.test`);
      const { courseId, versionId } = await makeCourseWithVersion(club.id);
      const future = new Date(Date.now() + 60 * 60_000);
      await issueObligation({
        clubId: club.id, employeeId: emp.id, courseId, courseVersionId: versionId,
        reason: "REVISION", issuedByUserId: null, issuanceKey: k(),
        issuedAt: future,
      });
      const nothing = await pickObligationToSatisfy({
        employeeId: emp.id, courseVersionId: versionId,
        completionCompletedAt: new Date(),
      });
      expect(nothing).toBeNull();
    });
  });

  describe("cancelObligation", () => {
    it("marks CANCELED, preserves reasonNote, preserves issuanceKey", async () => {
      const club = await makeClub("Cancel A");
      const emp = await makeEmployee(club.id, `cancel-a-${Date.now()}@x.test`);
      const { courseId, versionId } = await makeCourseWithVersion(club.id);
      const issuanceKey = k();
      const obligation = await issueObligation({
        clubId: club.id, employeeId: emp.id, courseId, courseVersionId: versionId,
        reason: "MANUAL_REINSTATE", reasonNote: "Operator asked for retake",
        issuedByUserId: null, issuanceKey,
      });
      const canceled = await cancelObligation({ obligationId: obligation.id, cancelReason: "duplicate" });
      expect(canceled.status).toBe("CANCELED");
      expect(canceled.reasonNote).toContain("Operator asked for retake");
      expect(canceled.reasonNote).toContain("[canceled] duplicate");
      const row = await prisma.trainingObligation.findUnique({ where: { id: obligation.id } });
      expect(row?.issuanceKey).toBe(issuanceKey);
    });

    it("after cancel, a NEW obligation with a NEW issuanceKey can be issued; same key is still blocked", async () => {
      const club = await makeClub("Cancel B");
      const emp = await makeEmployee(club.id, `cancel-b-${Date.now()}@x.test`);
      const { courseId, versionId } = await makeCourseWithVersion(club.id);
      const originalKey = k();
      const first = await issueObligation({
        clubId: club.id, employeeId: emp.id, courseId, courseVersionId: versionId,
        reason: "MANUAL_REINSTATE", issuedByUserId: null, issuanceKey: originalKey,
      });
      await cancelObligation({ obligationId: first.id, cancelReason: "typo" });

      // NEW issuanceKey -> a NEW obligation is created.
      const second = await issueObligation({
        clubId: club.id, employeeId: emp.id, courseId, courseVersionId: versionId,
        reason: "MANUAL_REINSTATE", issuedByUserId: null, issuanceKey: k(),
      });
      expect(second.id).not.toBe(first.id);
      expect(second.status).toBe("OUTSTANDING");

      // Replaying the ORIGINAL issuanceKey returns the CANCELED row,
      // never resurrects or creates a new OUTSTANDING -- which is the
      // intended "replay is idempotent, retry is not accidental" behavior.
      const replayed = await issueObligation({
        clubId: club.id, employeeId: emp.id, courseId, courseVersionId: versionId,
        reason: "MANUAL_REINSTATE", issuedByUserId: null, issuanceKey: originalKey,
      });
      expect(replayed.id).toBe(first.id);
      expect(replayed.status).toBe("CANCELED");
    });
  });

  describe("supersedeObligation", () => {
    it("marks SUPERSEDED, stamps supersededByObligationId, preserves issuanceKey", async () => {
      const club = await makeClub("Sup A");
      const emp = await makeEmployee(club.id, `sup-a-${Date.now()}@x.test`);
      const course = await prisma.trainingCourse.create({
        data: { clubId: club.id, code: `SUP_${Math.random().toString(36).slice(2, 8)}`, title: "Sup", category: "Safety" },
      });
      const v1 = await prisma.trainingCourseVersion.create({
        data: { courseId: course.id, version: 1, state: "RETIRED", title: "Sup", publishedAt: new Date(), retiredAt: new Date() },
      });
      const v2 = await prisma.trainingCourseVersion.create({
        data: { courseId: course.id, version: 2, state: "PUBLISHED", title: "Sup", publishedAt: new Date() },
      });
      const oldKey = k();
      const oldOb = await issueObligation({
        clubId: club.id, employeeId: emp.id, courseId: course.id, courseVersionId: v1.id,
        reason: "INITIAL", issuedByUserId: null, issuanceKey: oldKey,
      });
      const newOb = await issueObligation({
        clubId: club.id, employeeId: emp.id, courseId: course.id, courseVersionId: v2.id,
        reason: "REVISION", issuedByUserId: null, issuanceKey: k(),
      });
      const superseded = await supersedeObligation({
        obligationId: oldOb.id, supersededByObligationId: newOb.id,
      });
      expect(superseded.status).toBe("SUPERSEDED");
      expect(superseded.supersededByObligationId).toBe(newOb.id);
      const row = await prisma.trainingObligation.findUnique({ where: { id: oldOb.id } });
      expect(row?.issuanceKey).toBe(oldKey);
    });

    it("refuses to supersede across (club, employee, course) boundaries", async () => {
      const club = await makeClub("Sup B");
      const empA = await makeEmployee(club.id, `sup-b-a-${Date.now()}@x.test`);
      const empB = await makeEmployee(club.id, `sup-b-b-${Date.now()}@x.test`);
      const a = await makeCourseWithVersion(club.id);
      const b = await makeCourseWithVersion(club.id);
      const obA = await issueObligation({
        clubId: club.id, employeeId: empA.id, courseId: a.courseId, courseVersionId: a.versionId,
        reason: "INITIAL", issuedByUserId: null, issuanceKey: k(),
      });
      const obB = await issueObligation({
        clubId: club.id, employeeId: empB.id, courseId: b.courseId, courseVersionId: b.versionId,
        reason: "REVISION", issuedByUserId: null, issuanceKey: k(),
      });
      await expect(supersedeObligation({
        obligationId: obA.id, supersededByObligationId: obB.id,
      })).rejects.toMatchObject({ issues: [{ path: "supersededByObligationId", message: expect.stringMatching(/replacement obligation must share/) }] });
    });
  });

  describe("listOutstandingObligationsForEmployee", () => {
    it("returns only OUTSTANDING rows, enriched with course title + version", async () => {
      const club = await makeClub("List A");
      const emp = await makeEmployee(club.id, `list-a-${Date.now()}@x.test`);
      const { courseId, versionId } = await makeCourseWithVersion(club.id);

      // Issue + satisfy (should NOT appear in list)
      const obSat = await issueObligation({
        clubId: club.id, employeeId: emp.id, courseId, courseVersionId: versionId,
        reason: "REVISION", issuedByUserId: null, issuanceKey: k(),
      });
      const completion = await makeCompletion({
        clubId: club.id, employeeId: emp.id, courseId, courseVersionId: versionId,
        completedAt: new Date(obSat.issuedAt.getTime() + 60_000),
      });
      await satisfyObligationWithCompletion({ obligationId: obSat.id, completionId: completion.id });

      // Issue a MANUAL_REINSTATE (should appear)
      await issueObligation({
        clubId: club.id, employeeId: emp.id, courseId, courseVersionId: versionId,
        reason: "MANUAL_REINSTATE", issuedByUserId: null, issuanceKey: k(),
      });

      const list = await listOutstandingObligationsForEmployee(emp.id);
      expect(list.length).toBe(1);
      expect(list[0].reason).toBe("MANUAL_REINSTATE");
      expect(list[0].courseTitle).toBe("Obligation Test Course");
      expect(list[0].versionNumber).toBe(1);
    });
  });
});
