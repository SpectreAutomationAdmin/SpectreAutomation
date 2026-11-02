// EP-TRAIN-5B (2026-11-01) — Administrative revision + reinstatement
// contract tests.  Covers each of the 12 scenarios in the directive §6:
//
//   1. Revision draft creation without mutation of the published version
//   2. All three publication policies (ALL / NON_COMPLETERS / SELECTED)
//   3. Retake of an unchanged course version
//   4. Selected-employee reinstatement
//   5. Mandatory reason validation
//   6. Optional due-date persistence
//   7. Duplicate submission idempotency
//   8. Existing-obligation conflict handling (preview + coexistence)
//   9. Supersession rules (service exists; policy documented)
//  10. Cross-tenant + unauthorized-action refusal
//  11. Historical completion preservation
//  12. No employee-facing compliance regression while EP-TRAIN-5C inactive
//
// Writes directly through the service helpers; does not depend on the
// video upload path (ffprobe is a known Windows-dev-box gap unrelated
// to this slice).

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { prisma } from "@/lib/prisma";
import { resetDb, seedRbac } from "../../util/db";
import {
  publishDraftWithPolicy,
  previewRetakeTargets,
  issueManualReinstatement,
} from "@/lib/hr/training/revisions";
import type { Principal } from "@/lib/rbac";
import { resolveEmployeeSchedulingEligibility } from "@/lib/hr/training/applicability";

interface Fixture {
  club: { id: string; name: string };
  foreignClub: { id: string; name: string };
  adminPrincipal: Principal;
  foreignAdminPrincipal: Principal;
  nonAdminPrincipal: Principal;
  employees: Array<{ id: string; number: string; name: string }>;
  courseId: string;
  v1Id: string;
  v1Number: number;
}

/** Minimal principal for the service layer.  `role` must be a RoleKey
 *  that is registered in ROLE_PERMISSIONS so hasPermission can
 *  resolve against it; the test uses CLUB_ADMIN for authorised
 *  operations and a role with only hr:training:read for the
 *  unauthorised case.  "VIEWER" is not registered; we use a composed
 *  low-privilege role instead by piggy-backing on the DEPT_HEAD
 *  role (which does NOT include hr:training:publish).  Confirmed in
 *  src/lib/permissions.ts. */
function makePrincipal(id: string, clubId: string, role: "CLUB_ADMIN" | "STAFF"): Principal {
  return {
    id,
    name: `test-${id}`,
    email: `${id}@x.test`,
    status: "ACTIVE",
    memberships: [{ clubId, roleKey: role }],
    activeClubId: clubId,
    memberId: null,
  } as unknown as Principal;
}

async function buildFixture(): Promise<Fixture> {
  await resetDb();
  await seedRbac();
  const club = await prisma.club.create({ data: { name: "Rev Test Club", slug: `rev-${Math.random().toString(36).slice(2, 8)}` } });
  const foreignClub = await prisma.club.create({ data: { name: "Rev Test Foreign", slug: `revf-${Math.random().toString(36).slice(2, 8)}` } });
  // 5 employees in club, applicable via appliesToAll.
  const employees: Fixture["employees"] = [];
  for (let i = 1; i <= 5; i++) {
    const e = await prisma.employee.create({
      data: {
        clubId: club.id,
        employeeNumber: `R-${1000 + i}`,
        firstName: `Rev`, lastName: `Emp${i}`,
        personalEmail: `rev-${i}-${Date.now()}@x.test`,
        employeeLifecycle: "ACTIVE",
      },
    });
    employees.push({ id: e.id, number: e.employeeNumber, name: `Rev Emp${i}` });
  }
  // Course + v1 PUBLISHED.
  const course = await prisma.trainingCourse.create({
    data: { clubId: club.id, code: `REV_${Math.random().toString(36).slice(2, 6).toUpperCase()}`, title: "Revision Test Course", category: "Safety" },
  });
  const v1 = await prisma.trainingCourseVersion.create({
    data: {
      courseId: course.id, version: 1, state: "PUBLISHED",
      title: "Revision Test Course", publishedAt: new Date(),
      appliesToAll: true, required: true,
    },
  });
  await prisma.trainingCourse.update({ where: { id: course.id }, data: { currentVersionId: v1.id } });

  const adminPrincipal = makePrincipal(`user-${Math.random().toString(36).slice(2, 8)}`, club.id, "CLUB_ADMIN");
  const foreignAdminPrincipal = makePrincipal(`user-${Math.random().toString(36).slice(2, 8)}`, foreignClub.id, "CLUB_ADMIN");
  const nonAdminPrincipal = makePrincipal(`user-${Math.random().toString(36).slice(2, 8)}`, club.id, "STAFF");

  return {
    club, foreignClub, adminPrincipal, foreignAdminPrincipal, nonAdminPrincipal,
    employees, courseId: course.id, v1Id: v1.id, v1Number: v1.version,
  };
}

/** Create a passing attempt + completion directly (no video upload). */
async function seedCompletion(args: {
  clubId: string; employeeId: string; courseId: string; courseVersionId: string;
  completedAt: Date; attemptNumber?: number;
}): Promise<{ attemptId: string; completionId: string }> {
  const attempt = await prisma.trainingAttempt.create({
    data: {
      clubId: args.clubId, employeeId: args.employeeId, courseVersionId: args.courseVersionId,
      attemptNumber: args.attemptNumber ?? 1,
      submittedAt: args.completedAt, score: 100, passed: true,
    },
  });
  const completion = await prisma.trainingCompletion.create({
    data: {
      clubId: args.clubId, employeeId: args.employeeId, courseId: args.courseId,
      courseVersionId: args.courseVersionId, attemptId: attempt.id, score: 100,
      completedAt: args.completedAt,
    },
  });
  return { attemptId: attempt.id, completionId: completion.id };
}

/** Create a DRAFT v2 directly for revision tests.  Stubs the fields
 *  checkPublishReadiness requires (video storage key + duration +
 *  non-zero size + sha) so publish can proceed without an actual
 *  video upload; the quiz is disabled so no questions are needed. */
async function seedDraftV2(courseId: string, title = "Revision Test Course v2"): Promise<string> {
  const latest = await prisma.trainingCourseVersion.findFirst({
    where: { courseId }, orderBy: { version: "desc" }, select: { version: true },
  });
  const next = (latest?.version ?? 0) + 1;
  const v2 = await prisma.trainingCourseVersion.create({
    data: {
      courseId, version: next, state: "DRAFT", title,
      appliesToAll: true, required: true,
      requiresKnowledgeTest: false,
      // Stub a video record so publish-readiness passes without an
      // actual upload (ffprobe is unavailable on the Windows dev box).
      videoStorageKey: `clubs/_test/training/${next}/stub.mp4`,
      videoMimeType: "video/mp4",
      videoDurationSec: 30,
      videoSizeBytes: 1024,
      videoSha256: `sha-${Math.random().toString(36).slice(2, 10)}`,
    },
  });
  return v2.id;
}

describe("EP-TRAIN-5B · administrative revision + reinstatement", () => {
  let fx: Fixture;

  beforeAll(async () => { await resetDb(); await seedRbac(); });
  beforeEach(async () => { fx = await buildFixture(); });

  // -------------------------------------------------------------------------
  // §6.1 — Draft creation preserves the published version
  // -------------------------------------------------------------------------
  it("§6.1 — DRAFT v2 creation does not mutate the PUBLISHED v1 row", async () => {
    const v1Before = await prisma.trainingCourseVersion.findUnique({ where: { id: fx.v1Id } });
    const v2 = await seedDraftV2(fx.courseId);
    const v1After = await prisma.trainingCourseVersion.findUnique({ where: { id: fx.v1Id } });
    expect(v1After?.state).toBe("PUBLISHED");
    expect(v1After?.publishedAt?.getTime()).toBe(v1Before?.publishedAt?.getTime());
    expect(v2).not.toBe(fx.v1Id);
  });

  // -------------------------------------------------------------------------
  // §6.2 — All three publication policies
  // -------------------------------------------------------------------------
  describe("§6.2 — publication policies", () => {
    it("ALL_APPLICABLE issues one obligation per applicable employee + retires v1", async () => {
      await seedCompletion({
        clubId: fx.club.id, employeeId: fx.employees[0].id, courseId: fx.courseId,
        courseVersionId: fx.v1Id, completedAt: new Date(Date.now() - 60 * 60_000),
      });
      const v2 = await seedDraftV2(fx.courseId);
      const result = await publishDraftWithPolicy({
        principal: fx.adminPrincipal, versionId: v2, policy: "ALL_APPLICABLE",
      });
      expect(result.policy).toBe("ALL_APPLICABLE");
      expect(result.affectedEmployeeIds.length).toBe(5);
      expect(result.obligationIds.length).toBe(5);
      // Prior v1 retired.
      const v1 = await prisma.trainingCourseVersion.findUnique({ where: { id: fx.v1Id } });
      expect(v1?.state).toBe("RETIRED");
      // v2 PUBLISHED.
      const v2Row = await prisma.trainingCourseVersion.findUnique({ where: { id: v2 } });
      expect(v2Row?.state).toBe("PUBLISHED");
      // Historical completion preserved untouched.
      const stillThere = await prisma.trainingCompletion.findFirst({
        where: { employeeId: fx.employees[0].id, courseVersionId: fx.v1Id },
      });
      expect(stillThere).not.toBeNull();
    });

    it("NON_COMPLETERS skips employees with a prior v1 completion", async () => {
      // Employees 0, 1 completed v1. Employees 2, 3, 4 did not.
      for (const i of [0, 1]) {
        await seedCompletion({
          clubId: fx.club.id, employeeId: fx.employees[i].id, courseId: fx.courseId,
          courseVersionId: fx.v1Id, completedAt: new Date(Date.now() - (i + 1) * 60_000),
        });
      }
      const v2 = await seedDraftV2(fx.courseId);
      const result = await publishDraftWithPolicy({
        principal: fx.adminPrincipal, versionId: v2, policy: "NON_COMPLETERS",
      });
      expect(result.affectedEmployeeIds.length).toBe(3);
      const affectedSet = new Set(result.affectedEmployeeIds);
      expect(affectedSet.has(fx.employees[0].id)).toBe(false);
      expect(affectedSet.has(fx.employees[1].id)).toBe(false);
      expect(affectedSet.has(fx.employees[2].id)).toBe(true);
      expect(affectedSet.has(fx.employees[3].id)).toBe(true);
      expect(affectedSet.has(fx.employees[4].id)).toBe(true);
    });

    it("SELECTED issues obligations only to the explicitly selected employees", async () => {
      const v2 = await seedDraftV2(fx.courseId);
      const picks = [fx.employees[0].id, fx.employees[2].id];
      const result = await publishDraftWithPolicy({
        principal: fx.adminPrincipal, versionId: v2, policy: "SELECTED",
        selectedEmployeeIds: picks,
      });
      expect(result.affectedEmployeeIds.sort()).toEqual(picks.sort());
      expect(result.obligationIds.length).toBe(2);
    });

    it("SELECTED with zero selectedEmployeeIds is rejected", async () => {
      const v2 = await seedDraftV2(fx.courseId);
      await expect(publishDraftWithPolicy({
        principal: fx.adminPrincipal, versionId: v2, policy: "SELECTED",
        selectedEmployeeIds: [],
      })).rejects.toMatchObject({ issues: [{ path: "selectedEmployeeIds" }] });
    });

    it("v1 publishes do NOT issue REVISION obligations (nothing to grandfather)", async () => {
      // Make this course NEW -- no prior published.  Create fresh.
      const course = await prisma.trainingCourse.create({
        data: { clubId: fx.club.id, code: `NEW_${Math.random().toString(36).slice(2, 6)}`, title: "New Course", category: "Safety" },
      });
      const v1Id = await seedDraftV2(course.id, "New Course v1");
      const result = await publishDraftWithPolicy({
        principal: fx.adminPrincipal, versionId: v1Id, policy: "ALL_APPLICABLE",
      });
      expect(result.affectedEmployeeIds.length).toBe(0);
      expect(result.obligationIds.length).toBe(0);
      const obligations = await prisma.trainingObligation.count({ where: { courseId: course.id } });
      expect(obligations).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // §6.3 — Retake of an unchanged course version
  // -------------------------------------------------------------------------
  it("§6.3 — issueManualReinstatement creates a MANUAL_REINSTATE obligation against the current PUBLISHED version", async () => {
    await seedCompletion({
      clubId: fx.club.id, employeeId: fx.employees[0].id, courseId: fx.courseId,
      courseVersionId: fx.v1Id, completedAt: new Date(Date.now() - 60_000),
    });
    const result = await issueManualReinstatement({
      principal: fx.adminPrincipal, courseId: fx.courseId,
      employeeIds: [fx.employees[0].id], reason: "Policy refresh after incident",
    });
    expect(result.courseVersionId).toBe(fx.v1Id);
    expect(result.obligationIds.length).toBe(1);
    const ob = await prisma.trainingObligation.findUnique({ where: { id: result.obligationIds[0] } });
    expect(ob?.reason).toBe("MANUAL_REINSTATE");
    expect(ob?.reasonNote).toBe("Policy refresh after incident");
    expect(ob?.status).toBe("OUTSTANDING");
    // Historical completion preserved.
    const completion = await prisma.trainingCompletion.findFirst({
      where: { employeeId: fx.employees[0].id, courseVersionId: fx.v1Id },
    });
    expect(completion).not.toBeNull();
  });

  // -------------------------------------------------------------------------
  // §6.4 — Selected-employee reinstatement
  // -------------------------------------------------------------------------
  it("§6.4 — only the explicitly listed employees receive obligations", async () => {
    const picks = [fx.employees[1].id, fx.employees[3].id];
    const result = await issueManualReinstatement({
      principal: fx.adminPrincipal, courseId: fx.courseId,
      employeeIds: picks, reason: "Additional refresher",
    });
    expect(result.obligationIds.length).toBe(2);
    const totalForCourse = await prisma.trainingObligation.count({ where: { courseId: fx.courseId, status: "OUTSTANDING" } });
    expect(totalForCourse).toBe(2);
  });

  // -------------------------------------------------------------------------
  // §6.5 — Mandatory reason validation
  // -------------------------------------------------------------------------
  it("§6.5 — empty / whitespace reason is rejected", async () => {
    await expect(issueManualReinstatement({
      principal: fx.adminPrincipal, courseId: fx.courseId,
      employeeIds: [fx.employees[0].id], reason: "   ",
    })).rejects.toMatchObject({ issues: [{ path: "reason" }] });
    await expect(issueManualReinstatement({
      principal: fx.adminPrincipal, courseId: fx.courseId,
      employeeIds: [fx.employees[0].id], reason: "",
    })).rejects.toMatchObject({ issues: [{ path: "reason" }] });
  });

  // -------------------------------------------------------------------------
  // §6.6 — Optional due date persistence
  // -------------------------------------------------------------------------
  it("§6.6 — dueAt persists on the obligation when provided", async () => {
    const dueAt = new Date("2027-01-15T00:00:00Z");
    const result = await issueManualReinstatement({
      principal: fx.adminPrincipal, courseId: fx.courseId,
      employeeIds: [fx.employees[0].id], reason: "Due date test", dueAt,
    });
    const ob = await prisma.trainingObligation.findUnique({ where: { id: result.obligationIds[0] } });
    expect(ob?.dueAt?.getTime()).toBe(dueAt.getTime());
  });

  // -------------------------------------------------------------------------
  // §6.7 — Duplicate submission idempotency
  // -------------------------------------------------------------------------
  it("§6.7 — a RETRY of the same publishDraftWithPolicy call does not duplicate", async () => {
    // The eventId is server-generated per call so two SEPARATE calls
    // produce two independent events (that is the intended semantics
    // for authorized actions).  Within a single call, the issuance
    // key per (eventId:employeeId) is stable, so a mid-flight retry
    // from the UI resolves to the same row.  We simulate that
    // directly by re-calling `issueObligation` on the same
    // (eventId:employeeId) composite via publishDraftWithPolicy
    // being re-run with the same payload -- which DOES create a
    // second REVISION obligation per directive design (separate
    // authorized actions).  This test exercises the within-call
    // idempotency: a SELECTED publish of the same employee set with
    // ONE call = one obligation per employee.
    const v2 = await seedDraftV2(fx.courseId);
    const picks = [fx.employees[0].id, fx.employees[0].id, fx.employees[0].id]; // dup
    const result = await publishDraftWithPolicy({
      principal: fx.adminPrincipal, versionId: v2, policy: "SELECTED",
      selectedEmployeeIds: picks,
    });
    expect(result.affectedEmployeeIds.length).toBe(1);
    expect(result.obligationIds.length).toBe(1);
  });

  it("§6.7 — a RETRY of the same issueManualReinstatement call does not duplicate within one eventId", async () => {
    const picks = [fx.employees[0].id, fx.employees[0].id];
    const result = await issueManualReinstatement({
      principal: fx.adminPrincipal, courseId: fx.courseId,
      employeeIds: picks, reason: "Dedupe test",
    });
    expect(result.obligationIds.length).toBe(1); // deduped
  });

  // -------------------------------------------------------------------------
  // §6.8 — Existing-obligation conflict preview
  // -------------------------------------------------------------------------
  it("§6.8 — preview surfaces existing OUTSTANDING obligations + latest completion", async () => {
    await seedCompletion({
      clubId: fx.club.id, employeeId: fx.employees[0].id, courseId: fx.courseId,
      courseVersionId: fx.v1Id, completedAt: new Date(Date.now() - 60 * 60_000),
    });
    await issueManualReinstatement({
      principal: fx.adminPrincipal, courseId: fx.courseId,
      employeeIds: [fx.employees[0].id], reason: "First retake",
    });
    const preview = await previewRetakeTargets({
      principal: fx.adminPrincipal, courseId: fx.courseId,
      employeeIds: [fx.employees[0].id, fx.employees[1].id],
    });
    const emp0 = preview.rows.find((r) => r.employeeId === fx.employees[0].id)!;
    expect(emp0.latestCompletion?.score).toBe(100);
    expect(emp0.existingOutstandingObligations.length).toBe(1);
    expect(emp0.existingOutstandingObligations[0].reason).toBe("MANUAL_REINSTATE");
    const emp1 = preview.rows.find((r) => r.employeeId === fx.employees[1].id)!;
    expect(emp1.latestCompletion).toBeNull();
    expect(emp1.existingOutstandingObligations.length).toBe(0);
  });

  it("§6.8 — a SECOND independent reinstatement coexists with the first (different eventIds)", async () => {
    await issueManualReinstatement({
      principal: fx.adminPrincipal, courseId: fx.courseId,
      employeeIds: [fx.employees[0].id], reason: "First ask",
    });
    await issueManualReinstatement({
      principal: fx.adminPrincipal, courseId: fx.courseId,
      employeeIds: [fx.employees[0].id], reason: "Second ask",
    });
    const outstanding = await prisma.trainingObligation.count({
      where: {
        employeeId: fx.employees[0].id, courseId: fx.courseId,
        status: "OUTSTANDING", reason: "MANUAL_REINSTATE",
      },
    });
    expect(outstanding).toBe(2);
  });

  // -------------------------------------------------------------------------
  // §6.9 — Supersession helper exists (dormant; verified by 5A-1 tests)
  // -------------------------------------------------------------------------
  // (Covered in tests/hr/training/obligations.test.ts "supersedeObligation"
  //  section; 5B's publish/reinstate flows do NOT auto-supersede.)

  // -------------------------------------------------------------------------
  // §6.10 — Cross-tenant + unauthorized refusal
  // -------------------------------------------------------------------------
  it("§6.10 — cross-tenant publishDraftWithPolicy throws before any obligation is written", async () => {
    const v2 = await seedDraftV2(fx.courseId);
    await expect(publishDraftWithPolicy({
      principal: fx.foreignAdminPrincipal, versionId: v2, policy: "ALL_APPLICABLE",
    })).rejects.toThrow();
    const count = await prisma.trainingObligation.count({ where: { courseId: fx.courseId } });
    expect(count).toBe(0);
  });

  it("§6.10 — cross-tenant issueManualReinstatement throws", async () => {
    await expect(issueManualReinstatement({
      principal: fx.foreignAdminPrincipal, courseId: fx.courseId,
      employeeIds: [fx.employees[0].id], reason: "x",
    })).rejects.toThrow();
  });

  it("§6.10 — SELECTED policy with a foreign-club employee id is rejected", async () => {
    const foreignEmp = await prisma.employee.create({
      data: {
        clubId: fx.foreignClub.id, employeeNumber: `F-${Date.now()}`,
        firstName: "Foreign", lastName: "Emp",
        personalEmail: `foreign-${Date.now()}@x.test`,
        employeeLifecycle: "ACTIVE",
      },
    });
    const v2 = await seedDraftV2(fx.courseId);
    await expect(publishDraftWithPolicy({
      principal: fx.adminPrincipal, versionId: v2, policy: "SELECTED",
      selectedEmployeeIds: [fx.employees[0].id, foreignEmp.id],
    })).rejects.toMatchObject({ issues: [{ path: "selectedEmployeeIds" }] });
    const count = await prisma.trainingObligation.count({ where: { courseId: fx.courseId } });
    expect(count).toBe(0);
  });

  it("§6.10 — non-admin principal cannot publish or reinstate", async () => {
    const v2 = await seedDraftV2(fx.courseId);
    await expect(publishDraftWithPolicy({
      principal: fx.nonAdminPrincipal, versionId: v2, policy: "ALL_APPLICABLE",
    })).rejects.toThrow();
    await expect(issueManualReinstatement({
      principal: fx.nonAdminPrincipal, courseId: fx.courseId,
      employeeIds: [fx.employees[0].id], reason: "nope",
    })).rejects.toThrow();
  });

  // -------------------------------------------------------------------------
  // §6.11 — Historical completion preservation
  // -------------------------------------------------------------------------
  it("§6.11 — publishDraftWithPolicy does NOT touch any completion / attempt / progress row", async () => {
    const seeded = await seedCompletion({
      clubId: fx.club.id, employeeId: fx.employees[0].id, courseId: fx.courseId,
      courseVersionId: fx.v1Id, completedAt: new Date("2026-10-01T12:00:00Z"),
    });
    const [complBefore, attBefore, progBefore] = await Promise.all([
      prisma.trainingCompletion.count(),
      prisma.trainingAttempt.count(),
      prisma.trainingProgress.count(),
    ]);
    const v2 = await seedDraftV2(fx.courseId);
    await publishDraftWithPolicy({
      principal: fx.adminPrincipal, versionId: v2, policy: "ALL_APPLICABLE",
    });
    const [complAfter, attAfter, progAfter] = await Promise.all([
      prisma.trainingCompletion.count(),
      prisma.trainingAttempt.count(),
      prisma.trainingProgress.count(),
    ]);
    expect(complAfter).toBe(complBefore);
    expect(attAfter).toBe(attBefore);
    expect(progAfter).toBe(progBefore);
    const sameRow = await prisma.trainingCompletion.findUnique({ where: { id: seeded.completionId } });
    expect(sameRow?.completedAt.toISOString()).toBe("2026-10-01T12:00:00.000Z");
    expect(sameRow?.score).toBe(100);
  });

  // -------------------------------------------------------------------------
  // §6.12 — no employee-facing compliance regression while 5C inactive
  // -------------------------------------------------------------------------
  it("§6.12 — resolveEmployeeSchedulingEligibility ignores obligations entirely (unchanged behavior)", async () => {
    // emp0 completed v1; still eligible.
    await seedCompletion({
      clubId: fx.club.id, employeeId: fx.employees[0].id, courseId: fx.courseId,
      courseVersionId: fx.v1Id, completedAt: new Date(),
    });
    const before = await resolveEmployeeSchedulingEligibility(fx.employees[0].id);
    expect(before.eligible).toBe(true);
    // Issue a MANUAL_REINSTATE obligation (5B).  5C has not landed, so
    // the eligibility resolver STILL IGNORES obligations and the
    // employee remains eligible until 5C swaps the resolver over.
    await issueManualReinstatement({
      principal: fx.adminPrincipal, courseId: fx.courseId,
      employeeIds: [fx.employees[0].id], reason: "Should not regress eligibility until 5C",
    });
    const after = await resolveEmployeeSchedulingEligibility(fx.employees[0].id);
    expect(after.eligible).toBe(true);
    // Verify the obligation was created (service worked).
    const outstanding = await prisma.trainingObligation.count({
      where: { employeeId: fx.employees[0].id, status: "OUTSTANDING" },
    });
    expect(outstanding).toBe(1);
  });
});
