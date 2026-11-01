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
  _internal,
} from "@/lib/hr/training/obligations";

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

  describe("outstandingKey composition", () => {
    it("composes the key as `${employeeId}|${courseVersionId}|${reason}`", () => {
      expect(_internal.outstandingKey("e1", "v1", "INITIAL")).toBe("e1|v1|INITIAL");
      expect(_internal.outstandingKey("e1", "v1", "REVISION")).toBe("e1|v1|REVISION");
    });
  });

  describe("issueObligation", () => {
    it("creates an OUTSTANDING row with the composed unique key", async () => {
      const club = await makeClub("Issue A");
      const emp = await makeEmployee(club.id, `issue-a-${Date.now()}@x.test`);
      const { courseId, versionId } = await makeCourseWithVersion(club.id);
      const obligation = await issueObligation({
        clubId: club.id,
        employeeId: emp.id,
        courseId,
        courseVersionId: versionId,
        reason: "REVISION",
        issuedByUserId: null,
      });
      expect(obligation.status).toBe("OUTSTANDING");
      expect(obligation.reason).toBe("REVISION");
      const row = await prisma.trainingObligation.findUnique({ where: { id: obligation.id } });
      expect(row?.outstandingUniqueKey).toBe(`${emp.id}|${versionId}|REVISION`);
    });

    it("Invariant 1 — repeated issue returns the existing OUTSTANDING row (no duplicate)", async () => {
      const club = await makeClub("Issue B");
      const emp = await makeEmployee(club.id, `issue-b-${Date.now()}@x.test`);
      const { courseId, versionId } = await makeCourseWithVersion(club.id);
      const first = await issueObligation({
        clubId: club.id, employeeId: emp.id, courseId, courseVersionId: versionId,
        reason: "REVISION", issuedByUserId: null,
      });
      const second = await issueObligation({
        clubId: club.id, employeeId: emp.id, courseId, courseVersionId: versionId,
        reason: "REVISION", issuedByUserId: null,
      });
      expect(second.id).toBe(first.id);
      const count = await prisma.trainingObligation.count({
        where: { employeeId: emp.id, courseVersionId: versionId, reason: "REVISION" },
      });
      expect(count).toBe(1);
    });

    it("Invariant 1 — different reasons do NOT collide (both OUTSTANDING coexist)", async () => {
      const club = await makeClub("Issue C");
      const emp = await makeEmployee(club.id, `issue-c-${Date.now()}@x.test`);
      const { courseId, versionId } = await makeCourseWithVersion(club.id);
      const a = await issueObligation({
        clubId: club.id, employeeId: emp.id, courseId, courseVersionId: versionId,
        reason: "REVISION", issuedByUserId: null,
      });
      const b = await issueObligation({
        clubId: club.id, employeeId: emp.id, courseId, courseVersionId: versionId,
        reason: "MANUAL_REINSTATE", issuedByUserId: null,
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
        reason: "REVISION", issuedByUserId: null,
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
        reason: "REVISION", issuedByUserId: null,
      })).rejects.toMatchObject({ issues: [{ path: "courseId", message: expect.stringMatching(/courseId does not match/) }] });
    });
  });

  describe("satisfyObligationWithCompletion", () => {
    it("marks SATISFIED + stamps satisfiedByCompletionId + clears outstandingUniqueKey", async () => {
      const club = await makeClub("Sat A");
      const emp = await makeEmployee(club.id, `sat-a-${Date.now()}@x.test`);
      const { courseId, versionId } = await makeCourseWithVersion(club.id);
      const obligation = await issueObligation({
        clubId: club.id, employeeId: emp.id, courseId, courseVersionId: versionId,
        reason: "REVISION", issuedByUserId: null,
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
      expect(row?.outstandingUniqueKey).toBeNull();
    });

    it("Invariant 2 — a second obligation cannot be satisfied by the same completion", async () => {
      const club = await makeClub("Sat B");
      const emp = await makeEmployee(club.id, `sat-b-${Date.now()}@x.test`);
      const { courseId, versionId } = await makeCourseWithVersion(club.id);
      const first = await issueObligation({
        clubId: club.id, employeeId: emp.id, courseId, courseVersionId: versionId,
        reason: "REVISION", issuedByUserId: null,
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
        reason: "MANUAL_REINSTATE", issuedByUserId: null,
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
      // Create the completion FIRST, then issue a later obligation.
      const past = new Date(Date.now() - 10 * 60_000);
      const completion = await makeCompletion({
        clubId: club.id, employeeId: emp.id, courseId, courseVersionId: versionId,
        completedAt: past,
      });
      const obligation = await issueObligation({
        clubId: club.id, employeeId: emp.id, courseId, courseVersionId: versionId,
        reason: "MANUAL_REINSTATE", issuedByUserId: null, issuedAt: new Date(),
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
        reason: "REVISION", issuedByUserId: null,
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

  describe("cancelObligation", () => {
    it("marks CANCELED, preserves reasonNote, and clears outstandingUniqueKey", async () => {
      const club = await makeClub("Cancel A");
      const emp = await makeEmployee(club.id, `cancel-a-${Date.now()}@x.test`);
      const { courseId, versionId } = await makeCourseWithVersion(club.id);
      const obligation = await issueObligation({
        clubId: club.id, employeeId: emp.id, courseId, courseVersionId: versionId,
        reason: "MANUAL_REINSTATE", reasonNote: "Operator asked for retake", issuedByUserId: null,
      });
      const canceled = await cancelObligation({ obligationId: obligation.id, cancelReason: "duplicate" });
      expect(canceled.status).toBe("CANCELED");
      expect(canceled.reasonNote).toContain("Operator asked for retake");
      expect(canceled.reasonNote).toContain("[canceled] duplicate");
      const row = await prisma.trainingObligation.findUnique({ where: { id: obligation.id } });
      expect(row?.outstandingUniqueKey).toBeNull();
    });

    it("after cancel, a NEW obligation can be issued for the same (employee, version, reason)", async () => {
      const club = await makeClub("Cancel B");
      const emp = await makeEmployee(club.id, `cancel-b-${Date.now()}@x.test`);
      const { courseId, versionId } = await makeCourseWithVersion(club.id);
      const first = await issueObligation({
        clubId: club.id, employeeId: emp.id, courseId, courseVersionId: versionId,
        reason: "MANUAL_REINSTATE", issuedByUserId: null,
      });
      await cancelObligation({ obligationId: first.id, cancelReason: "typo" });
      const second = await issueObligation({
        clubId: club.id, employeeId: emp.id, courseId, courseVersionId: versionId,
        reason: "MANUAL_REINSTATE", issuedByUserId: null,
      });
      expect(second.id).not.toBe(first.id);
      expect(second.status).toBe("OUTSTANDING");
    });
  });

  describe("supersedeObligation", () => {
    it("marks SUPERSEDED, stamps supersededByObligationId, clears outstandingUniqueKey", async () => {
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
      const oldOb = await issueObligation({
        clubId: club.id, employeeId: emp.id, courseId: course.id, courseVersionId: v1.id,
        reason: "INITIAL", issuedByUserId: null,
      });
      const newOb = await issueObligation({
        clubId: club.id, employeeId: emp.id, courseId: course.id, courseVersionId: v2.id,
        reason: "REVISION", issuedByUserId: null,
      });
      const superseded = await supersedeObligation({
        obligationId: oldOb.id, supersededByObligationId: newOb.id,
      });
      expect(superseded.status).toBe("SUPERSEDED");
      expect(superseded.supersededByObligationId).toBe(newOb.id);
      const row = await prisma.trainingObligation.findUnique({ where: { id: oldOb.id } });
      expect(row?.outstandingUniqueKey).toBeNull();
    });

    it("refuses to supersede across (club, employee, course) boundaries", async () => {
      const club = await makeClub("Sup B");
      const empA = await makeEmployee(club.id, `sup-b-a-${Date.now()}@x.test`);
      const empB = await makeEmployee(club.id, `sup-b-b-${Date.now()}@x.test`);
      const a = await makeCourseWithVersion(club.id);
      const b = await makeCourseWithVersion(club.id);
      const obA = await issueObligation({
        clubId: club.id, employeeId: empA.id, courseId: a.courseId, courseVersionId: a.versionId,
        reason: "INITIAL", issuedByUserId: null,
      });
      const obB = await issueObligation({
        clubId: club.id, employeeId: empB.id, courseId: b.courseId, courseVersionId: b.versionId,
        reason: "REVISION", issuedByUserId: null,
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
        reason: "REVISION", issuedByUserId: null,
      });
      const completion = await makeCompletion({
        clubId: club.id, employeeId: emp.id, courseId, courseVersionId: versionId,
        completedAt: new Date(obSat.issuedAt.getTime() + 60_000),
      });
      await satisfyObligationWithCompletion({ obligationId: obSat.id, completionId: completion.id });

      // Issue a MANUAL_REINSTATE (should appear)
      await issueObligation({
        clubId: club.id, employeeId: emp.id, courseId, courseVersionId: versionId,
        reason: "MANUAL_REINSTATE", issuedByUserId: null,
      });

      const list = await listOutstandingObligationsForEmployee(emp.id);
      expect(list.length).toBe(1);
      expect(list[0].reason).toBe("MANUAL_REINSTATE");
      expect(list[0].courseTitle).toBe("Obligation Test Course");
      expect(list[0].versionNumber).toBe(1);
    });
  });
});
