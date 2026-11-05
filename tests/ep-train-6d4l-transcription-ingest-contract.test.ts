// EP-TRAIN-6D-4L — SQLite-backed service contract tests.
//
// This file covers the service-layer business logic (input validation,
// idempotent return shapes, cross-tenant 404, drift detection, audit
// emission) against the shared SQLite test DB. CHECK-constraint
// enforcement, SERIALIZABLE isolation, and real concurrency are
// covered separately by the disposable Postgres 16 harness at
// `scratchpad/ep-train-6d4l/integration-test.ts`.
//
// Convention matches `tests/ep-train-6d4d-read-service-contract.test.ts`:
// the shared `tests/util/db.ts` resets to a clean state per describe
// block; principals that need the 4L ingestion permission are made
// SUPER_ADMIN because no in-code role currently grants
// `hr:training:transcription:write` (see src/lib/permissions.ts).

import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db, resetDb, seedRbac, makeUser } from "./util/db";
import {
  persistTranscriptBuild,
  persistTranscriptSegments,
  persistGroundingProjection,
} from "@/lib/hr/training/transcription";
import { AppError } from "@/lib/errors";
import type { Principal } from "@/lib/rbac";

const CLUB_A = "club_4l_contract_a";
const CLUB_B = "club_4l_contract_b";
const COURSE_A = "crs_4l_contract_a";
const COURSE_B = "crs_4l_contract_b";
const VER_A_V1 = "ver_4l_contract_a_v1";
const VER_B_V1 = "ver_4l_contract_b_v1";

const VID_A = "a1" + "0".repeat(62);
const VID_B = "b1" + "0".repeat(62);
const BUILD_SHA_1 = "01" + "a".repeat(62);
const CONFIG_SHA = "c" + "0".repeat(63);

let SA_USER_ID = "";
let UNAUTH_USER_ID = "";

async function seedUsers() {
  const sa = await makeUser({
    email: `sa-4l-${Date.now()}@test.local`,
    name: "SA 4L",
    role: "SUPER_ADMIN",
    clubId: null,
  });
  SA_USER_ID = sa.id;
  const un = await makeUser({
    email: `u-4l-${Date.now()}@test.local`,
    name: "Unauth 4L",
    role: "CLUB_ADMIN",
    clubId: CLUB_A,
  });
  UNAUTH_USER_ID = un.id;
}

function superAdmin(): Principal {
  return {
    id: SA_USER_ID,
    name: "SA 4L",
    email: "sa-4l@test.local",
    status: "ACTIVE",
    memberships: [{ clubId: null, roleKey: "SUPER_ADMIN" }],
    activeClubId: null,
    memberId: null,
  };
}

function unauthorised(): Principal {
  return {
    id: UNAUTH_USER_ID,
    name: "Unauth 4L",
    email: "u-4l@test.local",
    status: "ACTIVE",
    memberships: [{ clubId: CLUB_A, roleKey: "CLUB_ADMIN" }],
    activeClubId: CLUB_A,
    memberId: null,
  };
}

async function seedFixtures() {
  const c = db();
  await c.club.createMany({
    data: [
      { id: CLUB_A, name: "Alpha CC 4L", slug: `alpha-4l-${Date.now()}`, primaryColor: "#111" },
      { id: CLUB_B, name: "Beta CC 4L", slug: `beta-4l-${Date.now()}`, primaryColor: "#222" },
    ],
  });
  await c.trainingCourse.createMany({
    data: [
      { id: COURSE_A, clubId: CLUB_A, code: "A1_4L", title: "A1", category: "ORIENTATION" },
      { id: COURSE_B, clubId: CLUB_B, code: "B1_4L", title: "B1", category: "ORIENTATION" },
    ],
  });
  await c.trainingCourseVersion.createMany({
    data: [
      { id: VER_A_V1, courseId: COURSE_A, version: 1, state: "DRAFT", title: "A1 v1", videoSha256: VID_A },
      { id: VER_B_V1, courseId: COURSE_B, version: 1, state: "DRAFT", title: "B1 v1", videoSha256: VID_B },
    ],
  });
}

function buildInput(overrides: Partial<Parameters<typeof persistTranscriptBuild>[2]> = {}) {
  return {
    courseVersionId: VER_A_V1,
    sourceVideoSha256: VID_A,
    resolvedTranscriptBuildId: BUILD_SHA_1,
    transcriberName: "faster-whisper",
    transcriberVersion: "1.0.3",
    transcriberModelName: "large-v3",
    transcriberModelVersion: "stub",
    transcriberConfigSha256: CONFIG_SHA,
    producedAt: new Date("2026-11-05T12:00:00.000Z"),
    ...overrides,
  };
}

function segments(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    segmentIndex: i,
    text: `Segment ${i}`,
    startSec: i,
    endSec: i + 1,
  }));
}

beforeAll(async () => {
  await seedRbac();
});

describe("EP-TRAIN-6D-4L — persistTranscriptBuild (service contract)", () => {
  beforeEach(async () => {
    await resetDb();
    await seedRbac();
    await seedFixtures();
    await seedUsers();
  });

  it("rejects an unauthenticated principal with UNAUTHENTICATED", async () => {
    await expect(persistTranscriptBuild(null, CLUB_A, buildInput())).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
    });
    expect(await db().trainingTranscriptBuild.count()).toBe(0);
  });

  it("rejects a principal without hr:training:transcription:write with FORBIDDEN", async () => {
    await expect(persistTranscriptBuild(unauthorised(), CLUB_A, buildInput())).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(await db().trainingTranscriptBuild.count()).toBe(0);
  });

  it("rejects malformed inputs with VALIDATION (bad hex, bad id-shape, future-less Date)", async () => {
    await expect(
      persistTranscriptBuild(superAdmin(), CLUB_A, buildInput({ sourceVideoSha256: "not-hex" })),
    ).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(
      persistTranscriptBuild(superAdmin(), CLUB_A, buildInput({ courseVersionId: "!!" })),
    ).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(
      persistTranscriptBuild(superAdmin(), CLUB_A, buildInput({ producedAt: new Date(NaN) })),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("rejects a courseVersion that does not belong to the clubId (NOT_FOUND, 404)", async () => {
    // VER_A_V1 belongs to club A; call with clubId = B.
    await expect(
      persistTranscriptBuild(superAdmin(), CLUB_B, buildInput()),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await db().trainingTranscriptBuild.count()).toBe(0);
  });

  it("rejects when sourceVideoSha256 does not match the version's uploaded video", async () => {
    await expect(
      persistTranscriptBuild(superAdmin(), CLUB_A, buildInput({ sourceVideoSha256: "f".repeat(64) })),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("persists a legitimate build and reports created=true", async () => {
    const result = await persistTranscriptBuild(superAdmin(), CLUB_A, buildInput());
    expect(result.created).toBe(true);
    expect(result.build.clubId).toBe(CLUB_A);
    expect(result.build.sourceVideoSha256).toBe(VID_A);
    expect(await db().trainingTranscriptBuild.count()).toBe(1);
  });

  it("is idempotent on identical retry (returns same row + created=false)", async () => {
    const first = await persistTranscriptBuild(superAdmin(), CLUB_A, buildInput());
    const second = await persistTranscriptBuild(superAdmin(), CLUB_A, buildInput());
    expect(second.created).toBe(false);
    expect(second.build.id).toBe(first.build.id);
    expect(await db().trainingTranscriptBuild.count()).toBe(1);
  });

  it("refuses drift on same identity (ConflictError)", async () => {
    await persistTranscriptBuild(superAdmin(), CLUB_A, buildInput());
    await expect(
      persistTranscriptBuild(superAdmin(), CLUB_A, buildInput({ transcriberVersion: "9.9.9" })),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await db().trainingTranscriptBuild.count()).toBe(1);
  });

  it("writes an AuditLog row on created=true (post-commit audit emission)", async () => {
    const before = await db().auditLog.count({ where: { action: "training.transcript.build.ingested" } });
    const { build } = await persistTranscriptBuild(superAdmin(), CLUB_A, buildInput());
    const after = await db().auditLog.count({ where: { action: "training.transcript.build.ingested" } });
    expect(after - before).toBe(1);
    // The audit row carries the entity id, not credentials.
    const row = await db().auditLog.findFirst({
      where: { action: "training.transcript.build.ingested", entityId: build.id },
    });
    expect(row).not.toBeNull();
    expect(row!.metaJson ?? "").not.toMatch(/password|secret|token/i);
  });

  it("does NOT write an audit row on idempotent retry (created=false)", async () => {
    await persistTranscriptBuild(superAdmin(), CLUB_A, buildInput());
    const between = await db().auditLog.count({ where: { action: "training.transcript.build.ingested" } });
    await persistTranscriptBuild(superAdmin(), CLUB_A, buildInput());
    const after = await db().auditLog.count({ where: { action: "training.transcript.build.ingested" } });
    expect(after).toBe(between);
  });
});

describe("EP-TRAIN-6D-4L — persistTranscriptSegments (service contract)", () => {
  beforeEach(async () => {
    await resetDb();
    await seedRbac();
    await seedFixtures();
    await seedUsers();
  });

  async function freshBuild() {
    const { build } = await persistTranscriptBuild(superAdmin(), CLUB_A, buildInput());
    return build;
  }

  it("rejects empty batch", async () => {
    const build = await freshBuild();
    await expect(
      persistTranscriptSegments(superAdmin(), CLUB_A, build.id, {
        expectedResolvedTranscriptBuildId: BUILD_SHA_1,
        segments: [],
      }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("rejects intra-batch duplicate segmentIndex", async () => {
    const build = await freshBuild();
    await expect(
      persistTranscriptSegments(superAdmin(), CLUB_A, build.id, {
        expectedResolvedTranscriptBuildId: BUILD_SHA_1,
        segments: [
          { segmentIndex: 0, text: "a", startSec: 0, endSec: 1 },
          { segmentIndex: 0, text: "b", startSec: 1, endSec: 2 },
        ],
      }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("rejects timestamps with endSec < startSec", async () => {
    const build = await freshBuild();
    await expect(
      persistTranscriptSegments(superAdmin(), CLUB_A, build.id, {
        expectedResolvedTranscriptBuildId: BUILD_SHA_1,
        segments: [{ segmentIndex: 0, text: "x", startSec: 5, endSec: 1 }],
      }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("rejects timestamps with negative startSec", async () => {
    const build = await freshBuild();
    await expect(
      persistTranscriptSegments(superAdmin(), CLUB_A, build.id, {
        expectedResolvedTranscriptBuildId: BUILD_SHA_1,
        segments: [{ segmentIndex: 0, text: "x", startSec: -0.001, endSec: 1 }],
      }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("rejects cross-tenant buildId with NOT_FOUND shape", async () => {
    const build = await freshBuild();
    await expect(
      persistTranscriptSegments(superAdmin(), CLUB_B, build.id, {
        expectedResolvedTranscriptBuildId: BUILD_SHA_1,
        segments: segments(2),
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("rejects when expectedResolvedTranscriptBuildId disagrees with the stored build", async () => {
    const build = await freshBuild();
    await expect(
      persistTranscriptSegments(superAdmin(), CLUB_A, build.id, {
        expectedResolvedTranscriptBuildId: "f" + "0".repeat(63),
        segments: segments(1),
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("creates segments and reports created count + segment indices", async () => {
    const build = await freshBuild();
    const r = await persistTranscriptSegments(superAdmin(), CLUB_A, build.id, {
      expectedResolvedTranscriptBuildId: BUILD_SHA_1,
      segments: segments(3),
    });
    expect(r.created).toBe(3);
    expect(r.idempotentSkipped).toBe(0);
    expect(r.segmentIndices).toEqual([0, 1, 2]);
    expect(await db().trainingTranscriptSegment.count()).toBe(3);
  });

  it("is idempotent on cross-call retry (created=0, idempotentSkipped=N)", async () => {
    const build = await freshBuild();
    await persistTranscriptSegments(superAdmin(), CLUB_A, build.id, {
      expectedResolvedTranscriptBuildId: BUILD_SHA_1,
      segments: segments(3),
    });
    const r = await persistTranscriptSegments(superAdmin(), CLUB_A, build.id, {
      expectedResolvedTranscriptBuildId: BUILD_SHA_1,
      segments: segments(3),
    });
    expect(r.created).toBe(0);
    expect(r.idempotentSkipped).toBe(3);
    expect(await db().trainingTranscriptSegment.count()).toBe(3);
  });

  it("refuses drift on same (build, index) with different text", async () => {
    const build = await freshBuild();
    await persistTranscriptSegments(superAdmin(), CLUB_A, build.id, {
      expectedResolvedTranscriptBuildId: BUILD_SHA_1,
      segments: [{ segmentIndex: 0, text: "canonical", startSec: 0, endSec: 1 }],
    });
    await expect(
      persistTranscriptSegments(superAdmin(), CLUB_A, build.id, {
        expectedResolvedTranscriptBuildId: BUILD_SHA_1,
        segments: [{ segmentIndex: 0, text: "TAMPERED", startSec: 0, endSec: 1 }],
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    const only = await db().trainingTranscriptSegment.findMany();
    expect(only.length).toBe(1);
    expect(only[0].text).toBe("canonical");
  });
});

describe("EP-TRAIN-6D-4L — persistGroundingProjection (service contract)", () => {
  beforeEach(async () => {
    await resetDb();
    await seedRbac();
    await seedFixtures();
    await seedUsers();
  });

  async function freshBuildAndSegments(n = 5) {
    const { build } = await persistTranscriptBuild(superAdmin(), CLUB_A, buildInput());
    await persistTranscriptSegments(superAdmin(), CLUB_A, build.id, {
      expectedResolvedTranscriptBuildId: BUILD_SHA_1,
      segments: segments(n),
    });
    return build;
  }

  it("rejects passages citing excluded segment indices 16 or 17", async () => {
    await freshBuildAndSegments(21);
    for (const excluded of [16, 17]) {
      await expect(
        persistGroundingProjection(superAdmin(), CLUB_A, {
          courseVersionId: VER_A_V1,
          sourceVideoSha256: VID_A,
          resolvedTranscriptBuildId: BUILD_SHA_1,
          authoredAt: new Date("2026-11-05T12:30:00.000Z"),
          passages: [{
            passageId: 0,
            sourceSegmentIds: [excluded],
            sourceStartSec: excluded,
            sourceEndSec: excluded + 1,
            text: `seg ${excluded}`,
            citationHandle: `seg-${excluded}`,
          }],
        }),
      ).rejects.toMatchObject({ code: "VALIDATION" });
    }
  });

  it("rejects passages citing segments that are NOT ingested on the build", async () => {
    await freshBuildAndSegments(3);
    await expect(
      persistGroundingProjection(superAdmin(), CLUB_A, {
        courseVersionId: VER_A_V1,
        sourceVideoSha256: VID_A,
        resolvedTranscriptBuildId: BUILD_SHA_1,
        authoredAt: new Date("2026-11-05T12:30:00.000Z"),
        passages: [{
          passageId: 0,
          sourceSegmentIds: [0, 99], // 99 does not exist
          sourceStartSec: 0,
          sourceEndSec: 1,
          text: "composite",
          citationHandle: "composite",
        }],
      }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("refuses when clientSuppliedSha256 disagrees with server recompute", async () => {
    await freshBuildAndSegments(3);
    await expect(
      persistGroundingProjection(superAdmin(), CLUB_A, {
        courseVersionId: VER_A_V1,
        sourceVideoSha256: VID_A,
        resolvedTranscriptBuildId: BUILD_SHA_1,
        authoredAt: new Date("2026-11-05T12:30:00.000Z"),
        clientSuppliedSha256: "0".repeat(64),
        passages: [{
          passageId: 0,
          sourceSegmentIds: [0],
          sourceStartSec: 0,
          sourceEndSec: 1,
          text: "x",
          citationHandle: "seg-0",
        }],
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("rejects when no TrainingTranscriptBuild exists for the (club, video, build) tuple", async () => {
    // Fresh clubs/courses but no build.
    await expect(
      persistGroundingProjection(superAdmin(), CLUB_A, {
        courseVersionId: VER_A_V1,
        sourceVideoSha256: VID_A,
        resolvedTranscriptBuildId: "f" + "0".repeat(63),
        authoredAt: new Date("2026-11-05T12:30:00.000Z"),
        passages: [{
          passageId: 0,
          sourceSegmentIds: [0],
          sourceStartSec: 0,
          sourceEndSec: 1,
          text: "x",
          citationHandle: "seg-0",
        }],
      }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("creates a projection and computes server-side sha256", async () => {
    await freshBuildAndSegments(3);
    const r = await persistGroundingProjection(superAdmin(), CLUB_A, {
      courseVersionId: VER_A_V1,
      sourceVideoSha256: VID_A,
      resolvedTranscriptBuildId: BUILD_SHA_1,
      authoredAt: new Date("2026-11-05T12:30:00.000Z"),
      passages: [{
        passageId: 0,
        sourceSegmentIds: [0, 1],
        sourceStartSec: 0,
        sourceEndSec: 2,
        text: "composite",
        citationHandle: "composite",
      }],
    });
    expect(r.created).toBe(true);
    expect(r.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(r.projection.sha256).toBe(r.sha256);
    expect(await db().trainingGroundingProjection.count()).toBe(1);
  });

  it("is idempotent on identical body (same sha256 → created=false)", async () => {
    await freshBuildAndSegments(3);
    const body = {
      courseVersionId: VER_A_V1,
      sourceVideoSha256: VID_A,
      resolvedTranscriptBuildId: BUILD_SHA_1,
      authoredAt: new Date("2026-11-05T12:30:00.000Z"),
      passages: [{
        passageId: 0,
        sourceSegmentIds: [0],
        sourceStartSec: 0,
        sourceEndSec: 1,
        text: "x",
        citationHandle: "seg-0",
      }],
    };
    const first = await persistGroundingProjection(superAdmin(), CLUB_A, body);
    const second = await persistGroundingProjection(superAdmin(), CLUB_A, body);
    expect(second.created).toBe(false);
    expect(second.projection.id).toBe(first.projection.id);
    expect(second.sha256).toBe(first.sha256);
    expect(await db().trainingGroundingProjection.count()).toBe(1);
  });

  it("4L never populates TrainingQuestionAiValidation.verifiedCorrectAnswerSnapshotJson", async () => {
    await freshBuildAndSegments(3);
    await persistGroundingProjection(superAdmin(), CLUB_A, {
      courseVersionId: VER_A_V1,
      sourceVideoSha256: VID_A,
      resolvedTranscriptBuildId: BUILD_SHA_1,
      authoredAt: new Date("2026-11-05T12:30:00.000Z"),
      passages: [{
        passageId: 0,
        sourceSegmentIds: [0],
        sourceStartSec: 0,
        sourceEndSec: 1,
        text: "x",
        citationHandle: "seg-0",
      }],
    });
    // 4L must not create any validation row.
    const validations = await db().trainingQuestionAiValidation.count();
    expect(validations).toBe(0);
  });
});
