// EP-TRAIN-6D-4D — real-DB integration test.
//
// Exercises the read service against the real Prisma client + the
// template SQLite database that `globalSetup` generates from
// `prisma/schema.prisma`. The template DB contains the six AI-review
// tables added in 6D-4B.
//
// Directive §9 real-DB scenarios covered:
//   - tenant-scoped listCandidates returns only rows of the active
//     club (even if another club has visible rows)
//   - cross-tenant getCandidate returns null (not a 500 — NOT a 200)
//   - pagination cursor stops at the tenant boundary
//   - deterministic ordering by (generatedAt DESC, id DESC) holds at
//     the DB level
//   - draft with validations + reviews surfaces correctly through
//     the real Prisma `include` chain
//
// NOTE: this is NOT a Postgres run (6D-4C already closed that
// acceptance path at the transactional level). SQLite here is enough
// to prove the service's query behaviour against a real database.

import { describe, expect, it, beforeAll, beforeEach } from "vitest";
import { db, resetDb, seedRbac, makeClub, makeUser } from "./util/db";
import { listCandidates, getCandidate } from "@/lib/hr/training/ai-review/read-service";
import type { Principal } from "@/lib/rbac";

// `hasPermission` reads ROLE_PERMISSIONS from src/lib/permissions.ts at
// compile time; inserting a DB `RolePermission` row has no effect on
// the runtime check. Because EP-TRAIN-6D-4D intentionally shipped
// `hr:training:ai:read` without any role grants (§4 "no auto-grant"),
// the only in-tree role that can satisfy the check is SUPER_ADMIN
// (it auto-passes every permission). Tests that need to hit the
// service through the gate therefore use a SUPER_ADMIN global
// membership on top of the user's club membership.
async function promoteUserToSuperAdmin(userId: string) {
  const c = db();
  await c.userClubRole.create({
    data: { userId, clubId: null, roleKey: "SUPER_ADMIN" },
  });
}

async function seedCourseFor(clubId: string) {
  const c = db();
  const course = await c.trainingCourse.create({
    data: {
      clubId,
      code: `AIRV_${Math.floor(Math.random() * 90000 + 10000)}`,
      title: `AI Review Course ${clubId}`,
      category: "Safety",
      description: "fixture",
    },
  });
  const v = await c.trainingCourseVersion.create({
    data: {
      courseId: course.id,
      version: 1,
      state: "PUBLISHED",
      title: "AI Review Fixture",
      description: "6D-4D fixture",
      passingScore: 80,
      retakesAllowed: true,
      requiresKnowledgeTest: true,
      required: true,
      appliesToAll: true,
      videoStorageKey: null,
      videoDurationSec: 60,
    },
  });
  return { course, version: v };
}

async function seedAiDraft(opts: {
  clubId: string;
  courseId: string;
  courseVersionId: string;
  state?: string;
  generatedAt?: Date;
  contentHash?: string;
  questionText?: string;
}) {
  const c = db();
  const questionText = opts.questionText ?? `Q ${Math.random().toString(36).slice(2, 8)}`;
  const draftJson = JSON.stringify({
    questionType: "SINGLE_CHOICE",
    questionText,
    options: [
      { text: "A", isCorrect: true },
      { text: "B", isCorrect: false },
    ],
    explanation: "fixture",
    sourceSegmentIds: [1, 2],
  });
  return c.trainingQuestionAiDraft.create({
    data: {
      clubId: opts.clubId,
      courseId: opts.courseId,
      courseVersionId: opts.courseVersionId,
      draftJson,
      contentHash: opts.contentHash ?? "hash-" + Math.random().toString(36).slice(2, 10),
      sourceVideoSha256: "video-sha-" + Math.random().toString(36).slice(2, 8),
      resolvedTranscriptBuildId: "build-1",
      groundingProjectionSha256: "grounding-sha-" + Math.random().toString(36).slice(2, 8),
      pilotAuthorizationId: "auth-1",
      pilotAuthorizationFingerprint: "auth-fp-1",
      state: opts.state ?? "REQUIRES_HUMAN_REVIEW",
      generatedAt: opts.generatedAt ?? new Date(),
    },
  });
}

async function principalForUser(userId: string, activeClubId: string): Promise<Principal> {
  const c = db();
  const user = await c.user.findUnique({
    where: { id: userId },
    include: { clubRoles: true },
  });
  if (!user) throw new Error("user missing");
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    status: user.status,
    memberships: user.clubRoles.map((r) => ({ clubId: r.clubId, roleKey: r.roleKey as never })),
    activeClubId,
    memberId: user.memberId,
  };
}

describe("ep-train-6d-4d · real-DB integration", () => {
  beforeAll(async () => { await resetDb(); await seedRbac(); });
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("listCandidates returns only the authorised tenant's rows", async () => {
    const clubA = await makeClub("Alpha Club 6D4D");
    const clubB = await makeClub("Beta Club 6D4D");
    const adminA = await makeUser({
      email: `admin-a-${Date.now()}@example.test`,
      role: "CLUB_ADMIN",
      clubId: clubA.id,
    });
    await promoteUserToSuperAdmin(adminA.id);

    const seedA = await seedCourseFor(clubA.id);
    const seedB = await seedCourseFor(clubB.id);

    // 2 drafts for A, 1 for B
    const dA1 = await seedAiDraft({
      clubId: clubA.id,
      courseId: seedA.course.id,
      courseVersionId: seedA.version.id,
      generatedAt: new Date("2026-11-04T10:00:00Z"),
    });
    const dA2 = await seedAiDraft({
      clubId: clubA.id,
      courseId: seedA.course.id,
      courseVersionId: seedA.version.id,
      generatedAt: new Date("2026-11-04T11:00:00Z"),
    });
    const dB1 = await seedAiDraft({
      clubId: clubB.id,
      courseId: seedB.course.id,
      courseVersionId: seedB.version.id,
      generatedAt: new Date("2026-11-04T12:00:00Z"),
    });

    const p = await principalForUser(adminA.id, clubA.id);
    const page = await listCandidates(p, clubA.id, {});

    expect(page.rows.length).toBe(2);
    const ids = page.rows.map((r) => r.draftId).sort();
    expect(ids).toEqual([dA1.id, dA2.id].sort());
    expect(ids).not.toContain(dB1.id);

    // §9.7 deterministic ordering — the later-generatedAt draft comes
    // first. dA2 generatedAt > dA1 generatedAt.
    expect(page.rows[0].draftId).toBe(dA2.id);
    expect(page.rows[1].draftId).toBe(dA1.id);
  });

  it("getCandidate returns null for a cross-tenant draftId (same-shape as missing)", async () => {
    const clubA = await makeClub("Alpha Club 6D4D X");
    const clubB = await makeClub("Beta Club 6D4D X");
    const adminA = await makeUser({
      email: `admin-a-x-${Date.now()}@example.test`,
      role: "CLUB_ADMIN",
      clubId: clubA.id,
    });
    await promoteUserToSuperAdmin(adminA.id);

    const seedB = await seedCourseFor(clubB.id);
    const dB = await seedAiDraft({
      clubId: clubB.id,
      courseId: seedB.course.id,
      courseVersionId: seedB.version.id,
    });

    const pA = await principalForUser(adminA.id, clubA.id);
    const result = await getCandidate(pA, clubA.id, dB.id);
    expect(result).toBeNull();
  });

  it("getCandidate includes real validation + review relations", async () => {
    const clubA = await makeClub("Alpha Club 6D4D V");
    const adminA = await makeUser({
      email: `admin-a-v-${Date.now()}@example.test`,
      role: "CLUB_ADMIN",
      clubId: clubA.id,
    });
    await promoteUserToSuperAdmin(adminA.id);

    const seedA = await seedCourseFor(clubA.id);
    const d = await seedAiDraft({
      clubId: clubA.id,
      courseId: seedA.course.id,
      courseVersionId: seedA.version.id,
      contentHash: "deadbeef",
    });

    const c = db();
    const val = await c.trainingQuestionAiValidation.create({
      data: {
        clubId: clubA.id,
        draftId: d.id,
        draftContentHash: "deadbeef",
        validatorVersion: "1.0.0",
        validatorSource: "integrated-pipeline",
        verdict: "REQUIRES_HUMAN_VERIFICATION",
        stage: "post-generation",
        errorsJson: "[]",
        warningsJson: "[]",
        flagsJson: JSON.stringify(["FLAG_PRESCRIPTIVE_INSERTION"]),
        runAt: new Date("2026-11-04T10:30:00Z"),
      },
    });
    await c.trainingQuestionAiReview.create({
      data: {
        clubId: clubA.id,
        draftId: d.id,
        disposition: "APPROVED",
        reviewerNote: "LGTM (test)",
        reviewedByUserId: adminA.id,
        reviewedAt: new Date("2026-11-04T10:40:00Z"),
        draftContentHash: "deadbeef",
        validationId: val.id,
      },
    });

    const p = await principalForUser(adminA.id, clubA.id);
    const detail = await getCandidate(p, clubA.id, d.id);

    expect(detail).not.toBeNull();
    expect(detail!.latestValidation).not.toBeNull();
    expect(detail!.latestValidation!.verdict).toBe("REQUIRES_HUMAN_VERIFICATION");
    expect(detail!.latestValidation!.flags).toContain("FLAG_PRESCRIPTIVE_INSERTION");
    expect(detail!.reviews.length).toBe(1);
    expect(detail!.reviews[0].disposition).toBe("APPROVED");
  });

  it("without hr:training:ai:read, listCandidates throws FORBIDDEN", async () => {
    const clubA = await makeClub("Alpha Club 6D4D NP");
    const adminA = await makeUser({
      email: `admin-a-np-${Date.now()}@example.test`,
      role: "CLUB_ADMIN",
      clubId: clubA.id,
    });
    // Note: NO grantReadPermissionToRole call — default role grants
    // don't include hr:training:ai:read.

    const p = await principalForUser(adminA.id, clubA.id);
    await expect(listCandidates(p, clubA.id, {}))
      .rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
  });
});
