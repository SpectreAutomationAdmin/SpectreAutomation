// EP-TRAIN-6D-4M — SQLite-backed evidence reader contract tests.
//
// Covers the authenticated evidence resolver's service-layer business
// logic against the shared SQLite template DB. Real-PostgreSQL CHECK
// behaviour + SERIALIZABLE semantics are already covered by the 4L
// real-PG harness; the reader is a pure read path with no new DB-
// level constraint, so SQLite coverage is sufficient here.

import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db, resetDb, seedRbac, makeUser } from "./util/db";
import {
  resolveCandidateEvidence,
  EvidenceReaderError,
  EXCLUDED_SEGMENT_INDICES,
  type AuthenticEvidence,
  type HistoricalUnavailableEvidence,
  type EvidenceIntegrityFailure,
} from "@/lib/hr/training/ai-review/evidence-reader";
import {
  persistTranscriptBuild,
  persistTranscriptSegments,
  persistGroundingProjection,
} from "@/lib/hr/training/transcription";
import type { Principal } from "@/lib/rbac";

const CLUB_A = "club_4m_a";
const CLUB_B = "club_4m_b";
const COURSE_A = "crs_4m_a";
const VER_A_V1 = "ver_4m_a_v1";
const VER_B_V1 = "ver_4m_b_v1";
const VID_A = "a1" + "0".repeat(62);
const VID_B = "b1" + "0".repeat(62);
const BUILD_SHA = "01" + "a".repeat(62);
const CONFIG_SHA = "c" + "0".repeat(63);

let SA_USER_ID = "";
let STAFF_USER_ID = "";
let CLUB_ADMIN_USER_ID = "";

async function seedUsers() {
  const sa = await makeUser({
    email: `sa-4m-${Date.now()}@test.local`,
    name: "SA 4M",
    role: "SUPER_ADMIN",
    clubId: null,
  });
  SA_USER_ID = sa.id;
  const staff = await makeUser({
    email: `staff-4m-${Date.now()}@test.local`,
    name: "Staff 4M",
    role: "STAFF",
    clubId: CLUB_A,
  });
  STAFF_USER_ID = staff.id;
  const ca = await makeUser({
    email: `ca-4m-${Date.now()}@test.local`,
    name: "CA 4M",
    role: "CLUB_ADMIN",
    clubId: CLUB_A,
  });
  CLUB_ADMIN_USER_ID = ca.id;
}

function superAdmin(): Principal {
  return {
    id: SA_USER_ID,
    name: "SA 4M",
    email: "sa-4m@test.local",
    status: "ACTIVE",
    memberships: [{ clubId: null, roleKey: "SUPER_ADMIN" }],
    activeClubId: null,
    memberId: null,
  };
}

function clubAdmin(): Principal {
  return {
    id: CLUB_ADMIN_USER_ID,
    name: "CA 4M",
    email: "ca-4m@test.local",
    status: "ACTIVE",
    memberships: [{ clubId: CLUB_A, roleKey: "CLUB_ADMIN" }],
    activeClubId: CLUB_A,
    memberId: null,
  };
}

function staff(): Principal {
  return {
    id: STAFF_USER_ID,
    name: "Staff 4M",
    email: "staff-4m@test.local",
    status: "ACTIVE",
    memberships: [{ clubId: CLUB_A, roleKey: "STAFF" }],
    activeClubId: CLUB_A,
    memberId: null,
  };
}

async function seedFixtures() {
  const c = db();
  await c.club.createMany({
    data: [
      { id: CLUB_A, name: "Alpha 4M", slug: `alpha-4m-${Date.now()}`, primaryColor: "#111" },
      { id: CLUB_B, name: "Beta 4M", slug: `beta-4m-${Date.now()}`, primaryColor: "#222" },
    ],
  });
  await c.trainingCourse.createMany({
    data: [
      { id: COURSE_A, clubId: CLUB_A, code: "A1_4M", title: "A1", category: "ORIENTATION" },
      { id: "crs_4m_b", clubId: CLUB_B, code: "B1_4M", title: "B1", category: "ORIENTATION" },
    ],
  });
  await c.trainingCourseVersion.createMany({
    data: [
      { id: VER_A_V1, courseId: COURSE_A, version: 1, state: "DRAFT", title: "A1 v1", videoSha256: VID_A },
      { id: VER_B_V1, courseId: "crs_4m_b", version: 1, state: "DRAFT", title: "B1 v1", videoSha256: VID_B },
    ],
  });
}

async function seedAuthenticEvidence(opts: { withSegment16?: boolean } = {}) {
  const sa = superAdmin();
  const { build } = await persistTranscriptBuild(sa, CLUB_A, {
    courseVersionId: VER_A_V1,
    sourceVideoSha256: VID_A,
    resolvedTranscriptBuildId: BUILD_SHA,
    transcriberName: "faster-whisper",
    transcriberVersion: "1.0.3",
    transcriberModelName: "large-v3",
    transcriberModelVersion: "stub",
    transcriberConfigSha256: CONFIG_SHA,
    producedAt: new Date("2026-11-05T12:00:00.000Z"),
  });
  const segmentCount = opts.withSegment16 ? 20 : 5;
  await persistTranscriptSegments(sa, CLUB_A, build.id, {
    expectedResolvedTranscriptBuildId: BUILD_SHA,
    segments: Array.from({ length: segmentCount }, (_, i) => ({
      segmentIndex: i,
      text: `Transcript segment ${i} body`,
      startSec: i * 2,
      endSec: i * 2 + 2,
    })),
  });
  const passages = [
    {
      passageId: 0,
      sourceSegmentIds: [0, 1],
      sourceStartSec: 0,
      sourceEndSec: 4,
      text: "composite passage",
      citationHandle: "seg-0-1",
    },
  ];
  if (opts.withSegment16) {
    // DO NOT cite excluded segments in a real projection (writer refuses); but we need a non-empty authorised set.
    passages.push({
      passageId: 1,
      sourceSegmentIds: [2],
      sourceStartSec: 4,
      sourceEndSec: 6,
      text: "p2",
      citationHandle: "seg-2",
    });
  }
  const { projection, sha256 } = await persistGroundingProjection(sa, CLUB_A, {
    courseVersionId: VER_A_V1,
    sourceVideoSha256: VID_A,
    resolvedTranscriptBuildId: BUILD_SHA,
    authoredAt: new Date("2026-11-05T12:30:00.000Z"),
    passages,
  });
  return { buildId: build.id, projectionId: projection.id, projectionSha: sha256 };
}

async function makeDraft(opts: {
  draftId: string;
  clubId: string;
  courseVersionId: string;
  sourceVideoSha256: string;
  resolvedTranscriptBuildId: string;
  groundingProjectionSha256: string;
  groundingProjectionId: string | null;
  citedSegmentIds: number[];
}) {
  const c = db();
  await c.trainingQuestionAiDraft.create({
    data: {
      id: opts.draftId,
      clubId: opts.clubId,
      courseId: COURSE_A,
      courseVersionId: opts.courseVersionId,
      draftJson: JSON.stringify({
        questionType: "SINGLE_CHOICE",
        questionText: "Q",
        options: [{ text: "x", isCorrect: true }],
        explanation: "e",
        sourceSegmentIds: opts.citedSegmentIds,
      }),
      contentHash: "h".repeat(64),
      sourceVideoSha256: opts.sourceVideoSha256,
      resolvedTranscriptBuildId: opts.resolvedTranscriptBuildId,
      groundingProjectionSha256: opts.groundingProjectionSha256,
      pilotAuthorizationId: "auth-stub",
      pilotAuthorizationFingerprint: "fp-stub",
      groundingProjectionId: opts.groundingProjectionId,
      state: "REQUIRES_HUMAN_REVIEW",
      generatedAt: new Date(),
    },
  });
}

beforeAll(async () => {
  await seedRbac();
});

describe("EP-TRAIN-6D-4M — resolveCandidateEvidence authorisation", () => {
  beforeEach(async () => {
    await resetDb();
    await seedRbac();
    await seedFixtures();
    await seedUsers();
  });

  it("throws UNAUTHENTICATED on null principal", async () => {
    await expect(resolveCandidateEvidence(null, CLUB_A, "draft_x")).rejects.toBeInstanceOf(EvidenceReaderError);
    try {
      await resolveCandidateEvidence(null, CLUB_A, "draft_x");
    } catch (err) {
      expect((err as EvidenceReaderError).code).toBe("UNAUTHENTICATED");
      expect((err as EvidenceReaderError).status).toBe(401);
    }
  });

  it("throws FORBIDDEN on a principal without hr:training:ai:read (STAFF)", async () => {
    await expect(resolveCandidateEvidence(staff(), CLUB_A, "draft_x")).rejects.toMatchObject({
      code: "FORBIDDEN",
      status: 403,
    });
  });

  it("returns null on cross-tenant draft (CLUB_ADMIN of A asking for a B-tenant draft)", async () => {
    // Seed a draft on CLUB_B (no evidence, but enough to exercise the lookup).
    const sa = superAdmin();
    await makeDraft({
      draftId: "draft_b1",
      clubId: CLUB_B,
      courseVersionId: VER_B_V1,
      sourceVideoSha256: VID_B,
      resolvedTranscriptBuildId: BUILD_SHA,
      groundingProjectionSha256: "fixture-x",
      groundingProjectionId: null,
      citedSegmentIds: [0],
    });
    // CLUB_A admin asks for the B-tenant draft → null (mapped to 404 downstream).
    const ev = await resolveCandidateEvidence(clubAdmin(), CLUB_A, "draft_b1");
    expect(ev).toBeNull();
  });

  it("returns null when the draft does not exist at all", async () => {
    const ev = await resolveCandidateEvidence(clubAdmin(), CLUB_A, "draft_never_existed");
    expect(ev).toBeNull();
  });
});

describe("EP-TRAIN-6D-4M — historical-unavailable branch", () => {
  beforeEach(async () => {
    await resetDb();
    await seedRbac();
    await seedFixtures();
    await seedUsers();
  });

  it("returns historical-unavailable for a 6D-4H candidate (null groundingProjectionId)", async () => {
    await makeDraft({
      draftId: "draft_hist_1",
      clubId: CLUB_A,
      courseVersionId: VER_A_V1,
      sourceVideoSha256: VID_A,
      resolvedTranscriptBuildId: BUILD_SHA,
      groundingProjectionSha256: "fixture-q1",
      groundingProjectionId: null,
      citedSegmentIds: [5, 8],
    });
    const ev = await resolveCandidateEvidence(clubAdmin(), CLUB_A, "draft_hist_1");
    expect(ev).not.toBeNull();
    expect(ev!.kind).toBe("historical-unavailable");
    const hist = ev as HistoricalUnavailableEvidence;
    expect(hist.reason).toBe("HISTORICAL_PILOT_NO_PROJECTION");
    expect(hist.groundingProjectionFingerprint).toBe("fixture-q1");
    expect(hist.citedSegmentIndices).toEqual([5, 8]);
    expect(hist.sourceMaterial.courseTitle).toBe("A1");
  });

  it("never fabricates transcript text or timestamps for a historical candidate", async () => {
    await makeDraft({
      draftId: "draft_hist_2",
      clubId: CLUB_A,
      courseVersionId: VER_A_V1,
      sourceVideoSha256: VID_A,
      resolvedTranscriptBuildId: BUILD_SHA,
      groundingProjectionSha256: "fixture-q2",
      groundingProjectionId: null,
      citedSegmentIds: [0],
    });
    const ev = await resolveCandidateEvidence(clubAdmin(), CLUB_A, "draft_hist_2");
    expect(ev!.kind).toBe("historical-unavailable");
    // The historical branch does NOT include a citedSegments payload
    // — only indices. This structurally prevents text / timestamp
    // fabrication.
    const hist = ev as HistoricalUnavailableEvidence;
    expect(Object.keys(hist)).not.toContain("citedSegments");
  });
});

describe("EP-TRAIN-6D-4M — authentic branch", () => {
  beforeEach(async () => {
    await resetDb();
    await seedRbac();
    await seedFixtures();
    await seedUsers();
  });

  it("returns authentic evidence with resolved segments + click-to-seek enabled", async () => {
    const { projectionId, projectionSha } = await seedAuthenticEvidence();
    await makeDraft({
      draftId: "draft_new_1",
      clubId: CLUB_A,
      courseVersionId: VER_A_V1,
      sourceVideoSha256: VID_A,
      resolvedTranscriptBuildId: BUILD_SHA,
      groundingProjectionSha256: projectionSha,
      groundingProjectionId: projectionId,
      citedSegmentIds: [0, 1],
    });
    const ev = await resolveCandidateEvidence(clubAdmin(), CLUB_A, "draft_new_1");
    expect(ev!.kind).toBe("authentic");
    const a = ev as AuthenticEvidence;
    expect(a.projectionSha256).toBe(projectionSha);
    expect(a.transcriber.transcriberName).toBe("faster-whisper");
    expect(a.citedSegments.length).toBe(2);
    expect(a.citedSegments[0].segmentIndex).toBe(0);
    expect(a.citedSegments[0].text).toBe("Transcript segment 0 body");
    expect(a.citedSegments[0].startSec).toBeTruthy();
    expect(a.citedSegments[0].endSec).toBeTruthy();
    expect(a.citedSegments[0].unavailableReason).toBeNull();
  });

  it("marks cited segment as SEGMENT_NOT_IN_AUTHORISED_PROJECTION when the citation is outside the projection", async () => {
    const { projectionId, projectionSha } = await seedAuthenticEvidence();
    await makeDraft({
      draftId: "draft_new_2",
      clubId: CLUB_A,
      courseVersionId: VER_A_V1,
      sourceVideoSha256: VID_A,
      resolvedTranscriptBuildId: BUILD_SHA,
      groundingProjectionSha256: projectionSha,
      groundingProjectionId: projectionId,
      citedSegmentIds: [0, 3], // 3 is persisted but NOT in the projection's passages
    });
    const ev = await resolveCandidateEvidence(clubAdmin(), CLUB_A, "draft_new_2");
    expect(ev!.kind).toBe("authentic");
    const a = ev as AuthenticEvidence;
    const resolved = a.citedSegments.find((s) => s.segmentIndex === 0);
    const unresolved = a.citedSegments.find((s) => s.segmentIndex === 3);
    expect(resolved!.unavailableReason).toBeNull();
    expect(unresolved!.unavailableReason).toBe("SEGMENT_NOT_IN_AUTHORISED_PROJECTION");
    expect(unresolved!.text).toBeNull();
    expect(unresolved!.startSec).toBeNull();
  });

  it("marks cited segment as SEGMENT_EXCLUDED_BY_AUTHORISATION for indices 16 or 17", async () => {
    const { projectionId, projectionSha } = await seedAuthenticEvidence({ withSegment16: true });
    await makeDraft({
      draftId: "draft_new_3",
      clubId: CLUB_A,
      courseVersionId: VER_A_V1,
      sourceVideoSha256: VID_A,
      resolvedTranscriptBuildId: BUILD_SHA,
      groundingProjectionSha256: projectionSha,
      groundingProjectionId: projectionId,
      citedSegmentIds: [0, 16], // 16 is in the excluded set
    });
    const ev = await resolveCandidateEvidence(clubAdmin(), CLUB_A, "draft_new_3");
    expect(ev!.kind).toBe("authentic");
    const a = ev as AuthenticEvidence;
    const excluded = a.citedSegments.find((s) => s.segmentIndex === 16);
    expect(excluded!.unavailableReason).toBe("SEGMENT_EXCLUDED_BY_AUTHORISATION");
    expect(excluded!.text).toBeNull();
  });

  it("confirms EXCLUDED_SEGMENT_INDICES contains 16 and 17 exactly", () => {
    expect(EXCLUDED_SEGMENT_INDICES.has(16)).toBe(true);
    expect(EXCLUDED_SEGMENT_INDICES.has(17)).toBe(true);
    expect(EXCLUDED_SEGMENT_INDICES.size).toBe(2);
  });

  it("enables videoSeekEnabled iff videoStorageKey is set AND at least one segment is resolved", async () => {
    // First, set the version's videoStorageKey so the uploaded check passes.
    await db().trainingCourseVersion.update({
      where: { id: VER_A_V1 },
      data: { videoStorageKey: "clubs/x/training/y/z/sha" },
    });
    const { projectionId, projectionSha } = await seedAuthenticEvidence();
    await makeDraft({
      draftId: "draft_seek",
      clubId: CLUB_A,
      courseVersionId: VER_A_V1,
      sourceVideoSha256: VID_A,
      resolvedTranscriptBuildId: BUILD_SHA,
      groundingProjectionSha256: projectionSha,
      groundingProjectionId: projectionId,
      citedSegmentIds: [0, 1],
    });
    const ev = await resolveCandidateEvidence(clubAdmin(), CLUB_A, "draft_seek");
    const a = ev as AuthenticEvidence;
    expect(a.videoSeekEnabled).toBe(true);
    expect(a.videoSourceVersionId).toBe(VER_A_V1);
  });
});

describe("EP-TRAIN-6D-4M — evidence-integrity-failure branch (fail-closed)", () => {
  beforeEach(async () => {
    await resetDb();
    await seedRbac();
    await seedFixtures();
    await seedUsers();
  });

  it("returns PROJECTION_HASH_MISMATCH_VS_DRAFT when draft.groundingProjectionSha256 disagrees with the FK target's sha256", async () => {
    const { projectionId, projectionSha } = await seedAuthenticEvidence();
    await makeDraft({
      draftId: "draft_mismatch",
      clubId: CLUB_A,
      courseVersionId: VER_A_V1,
      sourceVideoSha256: VID_A,
      resolvedTranscriptBuildId: BUILD_SHA,
      // The FK points at projectionId, but the scalar says something else.
      groundingProjectionSha256: "0".repeat(64),
      groundingProjectionId: projectionId,
      citedSegmentIds: [0],
    });
    const ev = await resolveCandidateEvidence(clubAdmin(), CLUB_A, "draft_mismatch");
    expect(ev!.kind).toBe("evidence-integrity-failure");
    const f = ev as EvidenceIntegrityFailure;
    expect(f.code).toBe("PROJECTION_HASH_MISMATCH_VS_DRAFT");
    // Safe message does NOT include any raw hash.
    expect(f.safeMessage).not.toMatch(/[0-9a-f]{64}/);
    // Note: projectionSha + projection row still exists; not leaked.
    expect(projectionSha).toMatch(/^[0-9a-f]{64}$/);
  });

  it("returns CITED_SEGMENTS_UNRESOLVABLE when every cited index is unresolvable", async () => {
    const { projectionId, projectionSha } = await seedAuthenticEvidence();
    await makeDraft({
      draftId: "draft_unresolvable",
      clubId: CLUB_A,
      courseVersionId: VER_A_V1,
      sourceVideoSha256: VID_A,
      resolvedTranscriptBuildId: BUILD_SHA,
      groundingProjectionSha256: projectionSha,
      groundingProjectionId: projectionId,
      // 99 and 100 are not persisted + not in the projection.
      citedSegmentIds: [99, 100],
    });
    const ev = await resolveCandidateEvidence(clubAdmin(), CLUB_A, "draft_unresolvable");
    expect(ev!.kind).toBe("evidence-integrity-failure");
    expect((ev as EvidenceIntegrityFailure).code).toBe("CITED_SEGMENTS_UNRESOLVABLE");
  });
});
