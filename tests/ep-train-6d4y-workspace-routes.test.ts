// EP-TRAIN-6D-4Y — route-handler deny-shape + input-validation tests.
//
// Covers the three new HTTP routes:
//   GET  /api/admin/training/versions/[id]/transcription-status
//   GET  /api/admin/training/versions/[id]/generation-status
//   POST /api/admin/ai-training/drafts/[id]/promote
//
// Uses hoisted vi.mock to stub principal + active-club + the services
// each route reads from, so these are pure route-handler unit tests
// that NEVER hit a database.

import { beforeEach, describe, expect, it, vi } from "vitest";

const mockPrincipal = vi.fn();
const mockActiveClubId = vi.fn();
const mockHasPermission = vi.fn();
const mockPromote = vi.fn();

vi.mock("@/lib/services/principal", () => ({
  getCurrentPrincipal: (...args: unknown[]) => mockPrincipal(...args),
}));
vi.mock("@/lib/active-club", () => ({
  getActiveClubId: (...args: unknown[]) => mockActiveClubId(...args),
}));
vi.mock("@/lib/rbac", () => ({
  hasPermission: (...args: unknown[]) => mockHasPermission(...args),
}));

// Service wiring.
vi.mock("@/lib/hr/training/ai-review/promotion-service", () => {
  class MockPromoteRejectedError extends Error {
    readonly rejectionCode: string;
    readonly httpStatus: number;
    readonly detail: Record<string, unknown>;
    readonly safeMessage: string;
    readonly code: string;
    constructor(
      rejectionCode: string,
      message: string,
      httpStatus: number,
      detail: Record<string, unknown> = {},
    ) {
      super(message);
      this.code = rejectionCode;
      this.rejectionCode = rejectionCode;
      this.httpStatus = httpStatus;
      this.detail = detail;
      this.safeMessage = message;
    }
  }
  return {
    promoteApprovedDraft: (...args: unknown[]) => mockPromote(...args),
    PromoteRejectedError: MockPromoteRejectedError,
  };
});

// Prisma client stub. The three routes we test only touch these models.
// vi.hoisted() keeps the stub visible to the hoisted mock factory.
const { prismaStub } = vi.hoisted(() => {
  const mk = () => ({});
  const stub = {
    trainingCourseVersion: { findFirst: Object.assign(mk(), { _m: true }) },
    trainingTranscriptionJob: { findFirst: Object.assign(mk(), { _m: true }) },
    trainingTranscriptBuild: { findFirst: Object.assign(mk(), { _m: true }) },
    trainingTranscriptSegment: { count: Object.assign(mk(), { _m: true }) },
    trainingQuestionAiGenerationRun: { findFirst: Object.assign(mk(), { _m: true }) },
    trainingQuestionAiDraft: { groupBy: Object.assign(mk(), { _m: true }) },
  };
  return { prismaStub: stub };
});

// Each prisma method is populated as a vi.fn() in beforeEach — the hoisted
// skeleton above is just a placeholder so the mock factory can reference
// the object. We can't use vi.fn() inside the hoisted block because `vi`
// is not available during hoist.
vi.mock("@/lib/prisma", () => ({ prisma: prismaStub }));

import { GET as getTranscriptionStatus } from "@/app/api/admin/training/versions/[id]/transcription-status/route";
import { GET as getGenerationStatus } from "@/app/api/admin/training/versions/[id]/generation-status/route";
import { POST as postPromote } from "@/app/api/admin/ai-training/drafts/[id]/promote/route";
import { PromoteRejectedError } from "@/lib/hr/training/ai-review/promotion-service";

function somePrincipal() {
  return {
    id: "u1",
    name: "N",
    email: "n@example.test",
    status: "ACTIVE",
    memberships: [],
    activeClubId: "club-A",
    memberId: null,
  };
}

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

const SHA = "a".repeat(64);
const BUILD = "b".repeat(64);
const HASH = "c".repeat(64);

beforeEach(() => {
  mockPrincipal.mockReset();
  mockActiveClubId.mockReset().mockResolvedValue("club-A");
  mockHasPermission.mockReset().mockReturnValue(true);
  mockPromote.mockReset();
  // Re-populate each prisma stub method as a fresh vi.fn().
  (prismaStub as any).trainingCourseVersion.findFirst = vi.fn();
  (prismaStub as any).trainingTranscriptionJob.findFirst = vi.fn();
  (prismaStub as any).trainingTranscriptBuild.findFirst = vi.fn();
  (prismaStub as any).trainingTranscriptSegment.count = vi.fn();
  (prismaStub as any).trainingQuestionAiGenerationRun.findFirst = vi.fn();
  (prismaStub as any).trainingQuestionAiDraft.groupBy = vi.fn();
});

// ─── TRANSCRIPTION STATUS ────────────────────────────────────────────

describe("GET .../transcription-status", () => {
  it("401 when unauthenticated", async () => {
    mockPrincipal.mockResolvedValue(null);
    const res = await getTranscriptionStatus(new Request("http://x"), ctx("v1"));
    expect(res.status).toBe(401);
  });

  it("404 same-shape when missing hr:training:read", async () => {
    mockPrincipal.mockResolvedValue(somePrincipal());
    mockHasPermission.mockReturnValue(false);
    const res = await getTranscriptionStatus(new Request("http://x"), ctx("v1"));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  it("404 same-shape when cross-tenant / missing version", async () => {
    mockPrincipal.mockResolvedValue(somePrincipal());
    (prismaStub.trainingCourseVersion.findFirst as any).mockResolvedValue(null);
    const res = await getTranscriptionStatus(new Request("http://x"), ctx("v1"));
    expect(res.status).toBe(404);
  });

  it("NOT_STARTED when version has no video sha", async () => {
    mockPrincipal.mockResolvedValue(somePrincipal());
    (prismaStub.trainingCourseVersion.findFirst as any).mockResolvedValue({
      id: "v1", videoSha256: null, videoDurationSec: null, videoStorageKey: null,
    });
    const res = await getTranscriptionStatus(new Request("http://x"), ctx("v1"));
    const body = await res.json();
    expect(body.state).toBe("NOT_STARTED");
    expect(body.reason).toBe("video_missing");
  });

  it("NOT_STARTED when no job exists", async () => {
    mockPrincipal.mockResolvedValue(somePrincipal());
    (prismaStub.trainingCourseVersion.findFirst as any).mockResolvedValue({
      id: "v1", videoSha256: SHA, videoDurationSec: 60, videoStorageKey: "k",
    });
    (prismaStub.trainingTranscriptionJob.findFirst as any).mockResolvedValue(null);
    const res = await getTranscriptionStatus(new Request("http://x"), ctx("v1"));
    expect((await res.json()).state).toBe("NOT_STARTED");
  });

  it("RUNNING surfaces attempts/maxAttempts without the transcript", async () => {
    mockPrincipal.mockResolvedValue(somePrincipal());
    (prismaStub.trainingCourseVersion.findFirst as any).mockResolvedValue({
      id: "v1", videoSha256: SHA, videoDurationSec: 60, videoStorageKey: "k",
    });
    (prismaStub.trainingTranscriptionJob.findFirst as any).mockResolvedValue({
      id: "j1", state: "RUNNING", attempts: 1, maxAttempts: 2,
      requestedAt: new Date(), queuedAt: null, startedAt: null, completedAt: null,
      cancelledAt: null, failureCode: null, failureMessage: null,
      resolvedTranscriptBuildId: null, elapsedMsTotal: null,
    });
    const body = await (await getTranscriptionStatus(new Request("http://x"), ctx("v1"))).json();
    expect(body.state).toBe("RUNNING");
    expect(body.attempts).toBe(1);
    expect(body.maxAttempts).toBe(2);
    expect(body.transcript).toBeUndefined();
  });

  it("WAITING_ON_INGEST when job COMPLETED but transcript build not persisted", async () => {
    mockPrincipal.mockResolvedValue(somePrincipal());
    (prismaStub.trainingCourseVersion.findFirst as any).mockResolvedValue({
      id: "v1", videoSha256: SHA, videoDurationSec: 60, videoStorageKey: "k",
    });
    (prismaStub.trainingTranscriptionJob.findFirst as any).mockResolvedValue({
      id: "j1", state: "COMPLETED", attempts: 1, maxAttempts: 2,
      requestedAt: new Date(), queuedAt: null, startedAt: null,
      completedAt: new Date(), cancelledAt: null,
      failureCode: null, failureMessage: null,
      resolvedTranscriptBuildId: null, elapsedMsTotal: 50000,
    });
    const body = await (await getTranscriptionStatus(new Request("http://x"), ctx("v1"))).json();
    expect(body.state).toBe("WAITING_ON_INGEST");
    expect(body.reason).toBe("transcript_build_not_persisted");
  });

  it("COMPLETED only when matching transcript build exists for same tenant+sha", async () => {
    mockPrincipal.mockResolvedValue(somePrincipal());
    (prismaStub.trainingCourseVersion.findFirst as any).mockResolvedValue({
      id: "v1", videoSha256: SHA, videoDurationSec: 60, videoStorageKey: "k",
    });
    const completedAt = new Date();
    (prismaStub.trainingTranscriptionJob.findFirst as any).mockResolvedValue({
      id: "j1", state: "COMPLETED", attempts: 1, maxAttempts: 2,
      requestedAt: new Date(), queuedAt: null, startedAt: null,
      completedAt, cancelledAt: null,
      failureCode: null, failureMessage: null,
      resolvedTranscriptBuildId: BUILD, elapsedMsTotal: 42000,
    });
    (prismaStub.trainingTranscriptBuild.findFirst as any).mockResolvedValue({
      id: "tb1", resolvedTranscriptBuildId: BUILD, producedAt: new Date(),
      transcriberName: "faster-whisper", transcriberModelName: "large-v3",
    });
    (prismaStub.trainingTranscriptSegment.count as any).mockResolvedValue(12);
    const body = await (await getTranscriptionStatus(new Request("http://x"), ctx("v1"))).json();
    expect(body.state).toBe("COMPLETED");
    expect(body.transcript.segmentCount).toBe(12);
    expect(body.transcript.resolvedTranscriptBuildId).toBe(BUILD);
  });

  it("FAILED surfaces failureCode + failureMessage", async () => {
    mockPrincipal.mockResolvedValue(somePrincipal());
    (prismaStub.trainingCourseVersion.findFirst as any).mockResolvedValue({
      id: "v1", videoSha256: SHA, videoDurationSec: 60, videoStorageKey: "k",
    });
    (prismaStub.trainingTranscriptionJob.findFirst as any).mockResolvedValue({
      id: "j1", state: "FAILED", attempts: 2, maxAttempts: 2,
      requestedAt: new Date(), queuedAt: null, startedAt: null, completedAt: null,
      cancelledAt: null,
      failureCode: "MODAL_HTTP_ERROR", failureMessage: "upstream 503",
      resolvedTranscriptBuildId: null, elapsedMsTotal: null,
    });
    const body = await (await getTranscriptionStatus(new Request("http://x"), ctx("v1"))).json();
    expect(body.state).toBe("FAILED");
    expect(body.failureCode).toBe("MODAL_HTTP_ERROR");
    expect(body.failureMessage).toBe("upstream 503");
  });
});

// ─── GENERATION STATUS ───────────────────────────────────────────────

describe("GET .../generation-status", () => {
  it("401 when unauthenticated", async () => {
    mockPrincipal.mockResolvedValue(null);
    const res = await getGenerationStatus(new Request("http://x"), ctx("v1"));
    expect(res.status).toBe(401);
  });

  it("404 same-shape when missing hr:training:read", async () => {
    mockPrincipal.mockResolvedValue(somePrincipal());
    mockHasPermission.mockReturnValue(false);
    const res = await getGenerationStatus(new Request("http://x"), ctx("v1"));
    expect(res.status).toBe(404);
  });

  it("404 same-shape when cross-tenant / missing version", async () => {
    mockPrincipal.mockResolvedValue(somePrincipal());
    (prismaStub.trainingCourseVersion.findFirst as any).mockResolvedValue(null);
    const res = await getGenerationStatus(new Request("http://x"), ctx("v1"));
    expect(res.status).toBe(404);
  });

  it("NOT_STARTED when no run exists", async () => {
    mockPrincipal.mockResolvedValue(somePrincipal());
    (prismaStub.trainingCourseVersion.findFirst as any).mockResolvedValue({ id: "v1" });
    (prismaStub.trainingQuestionAiGenerationRun.findFirst as any).mockResolvedValue(null);
    const res = await getGenerationStatus(new Request("http://x"), ctx("v1"));
    expect((await res.json()).state).toBe("NOT_STARTED");
  });

  it("COMPLETED surfaces the per-lifecycle breakdown + shortfall", async () => {
    mockPrincipal.mockResolvedValue(somePrincipal());
    (prismaStub.trainingCourseVersion.findFirst as any).mockResolvedValue({ id: "v1" });
    (prismaStub.trainingQuestionAiGenerationRun.findFirst as any).mockResolvedValue({
      id: "r1", executionStatus: "COMPLETED",
      requestedAt: new Date(), queuedAt: new Date(), startedAt: new Date(),
      completedAt: new Date(),
      attempts: 1, maxAttempts: 2, leaseExpiresAt: null,
      executionErrorCode: null, executionErrorMessage: null,
      shortfallReasonJson: JSON.stringify({ shortfall: 0, dedupDropCount: 2 }),
      planIdentity: "p".repeat(64), resolvedTranscriptBuildId: BUILD,
      modelName: "qwen-2.5-7b", modelBackend: "vllm",
    });
    (prismaStub.trainingQuestionAiDraft.groupBy as any).mockResolvedValue([
      { state: "APPROVED_DRAFT", _count: { state: 3 } },
      { state: "REJECTED", _count: { state: 1 } },
      { state: "REQUIRES_HUMAN_REVIEW", _count: { state: 2 } },
    ]);
    const body = await (await getGenerationStatus(new Request("http://x"), ctx("v1"))).json();
    expect(body.state).toBe("COMPLETED");
    expect(body.draftCount).toBe(6);
    expect(body.draftBreakdown.APPROVED_DRAFT).toBe(3);
    expect(body.draftBreakdown.REJECTED).toBe(1);
    expect(body.draftBreakdown.REQUIRES_HUMAN_REVIEW).toBe(2);
    expect(body.draftBreakdown.GENERATED).toBe(0);
    expect(body.shortfall).toEqual({ shortfall: 0, dedupDropCount: 2 });
  });

  it("COMPLETED with zero drafts still reports breakdown zeros (never fabricated)", async () => {
    mockPrincipal.mockResolvedValue(somePrincipal());
    (prismaStub.trainingCourseVersion.findFirst as any).mockResolvedValue({ id: "v1" });
    (prismaStub.trainingQuestionAiGenerationRun.findFirst as any).mockResolvedValue({
      id: "r1", executionStatus: "COMPLETED",
      requestedAt: new Date(), queuedAt: null, startedAt: null,
      completedAt: new Date(),
      attempts: 1, maxAttempts: 2, leaseExpiresAt: null,
      executionErrorCode: null, executionErrorMessage: null,
      shortfallReasonJson: null,
      planIdentity: "p".repeat(64), resolvedTranscriptBuildId: BUILD,
      modelName: "qwen-2.5-7b", modelBackend: "vllm",
    });
    (prismaStub.trainingQuestionAiDraft.groupBy as any).mockResolvedValue([]);
    const body = await (await getGenerationStatus(new Request("http://x"), ctx("v1"))).json();
    expect(body.draftCount).toBe(0);
    expect(Object.values(body.draftBreakdown).every((n) => n === 0)).toBe(true);
    expect(body.shortfall).toBeNull();
  });

  it("FAILED surfaces executionErrorCode + message", async () => {
    mockPrincipal.mockResolvedValue(somePrincipal());
    (prismaStub.trainingCourseVersion.findFirst as any).mockResolvedValue({ id: "v1" });
    (prismaStub.trainingQuestionAiGenerationRun.findFirst as any).mockResolvedValue({
      id: "r1", executionStatus: "FAILED",
      requestedAt: new Date(), queuedAt: new Date(), startedAt: new Date(),
      completedAt: null,
      attempts: 2, maxAttempts: 2, leaseExpiresAt: null,
      executionErrorCode: "MODAL_TIMEOUT",
      executionErrorMessage: "modal did not respond within 10m",
      shortfallReasonJson: null,
      planIdentity: "p".repeat(64), resolvedTranscriptBuildId: BUILD,
      modelName: "qwen-2.5-7b", modelBackend: "vllm",
    });
    (prismaStub.trainingQuestionAiDraft.groupBy as any).mockResolvedValue([]);
    const body = await (await getGenerationStatus(new Request("http://x"), ctx("v1"))).json();
    expect(body.state).toBe("FAILED");
    expect(body.executionErrorCode).toBe("MODAL_TIMEOUT");
  });
});

// ─── PROMOTE ─────────────────────────────────────────────────────────

describe("POST .../drafts/[id]/promote", () => {
  function reqJson(body: unknown): Request {
    return new Request("http://x", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("401 when unauthenticated", async () => {
    mockPrincipal.mockResolvedValue(null);
    const res = await postPromote(
      reqJson({
        destination: { kind: "FINAL_ASSESSMENT" },
        expectedDraftContentHash: HASH,
        expectedValidationId: "val1",
      }),
      ctx("d1"),
    );
    expect(res.status).toBe(401);
  });

  it("400 on invalid destination", async () => {
    mockPrincipal.mockResolvedValue(somePrincipal());
    for (const bad of [
      null,
      undefined,
      { kind: "FOO" },
      { kind: "CHECKPOINT" }, // missing checkpointId
      { kind: "CHECKPOINT", checkpointId: "" },
    ]) {
      const res = await postPromote(
        reqJson({
          destination: bad,
          expectedDraftContentHash: HASH,
          expectedValidationId: "val1",
        }),
        ctx("d1"),
      );
      expect(res.status).toBe(400);
    }
  });

  it("400 on invalid content hash shape", async () => {
    mockPrincipal.mockResolvedValue(somePrincipal());
    const res = await postPromote(
      reqJson({
        destination: { kind: "FINAL_ASSESSMENT" },
        expectedDraftContentHash: "too-short",
        expectedValidationId: "val1",
      }),
      ctx("d1"),
    );
    expect(res.status).toBe(400);
  });

  it("400 on missing validation id", async () => {
    mockPrincipal.mockResolvedValue(somePrincipal());
    const res = await postPromote(
      reqJson({
        destination: { kind: "FINAL_ASSESSMENT" },
        expectedDraftContentHash: HASH,
        expectedValidationId: "",
      }),
      ctx("d1"),
    );
    expect(res.status).toBe(400);
  });

  it("200 happy path calls promoteApprovedDraft with the right args", async () => {
    mockPrincipal.mockResolvedValue(somePrincipal());
    mockPromote.mockResolvedValue({
      ok: true,
      questionId: "q1",
      destinationKind: "FINAL_ASSESSMENT",
      checkpointId: null,
      promotionId: "p1",
      replay: false,
    });
    const res = await postPromote(
      reqJson({
        destination: { kind: "FINAL_ASSESSMENT" },
        expectedDraftContentHash: HASH,
        expectedValidationId: "val1",
      }),
      ctx("d1"),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.replay).toBe(false);
    expect(mockPromote).toHaveBeenCalledWith(
      expect.objectContaining({ id: "u1" }),
      "club-A",
      {
        draftId: "d1",
        destination: { kind: "FINAL_ASSESSMENT" },
        expectedDraftContentHash: HASH,
        expectedValidationId: "val1",
      },
    );
  });

  it("200 with replay=true on idempotent same-destination promote", async () => {
    mockPrincipal.mockResolvedValue(somePrincipal());
    mockPromote.mockResolvedValue({
      ok: true,
      questionId: "q1",
      destinationKind: "CHECKPOINT",
      checkpointId: "cp1",
      promotionId: "p1",
      replay: true,
    });
    const res = await postPromote(
      reqJson({
        destination: { kind: "CHECKPOINT", checkpointId: "cp1" },
        expectedDraftContentHash: HASH,
        expectedValidationId: "val1",
      }),
      ctx("d1"),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).replay).toBe(true);
  });

  it("404 (same-shape) when draft is cross-tenant / missing", async () => {
    mockPrincipal.mockResolvedValue(somePrincipal());
    mockPromote.mockRejectedValue(
      new PromoteRejectedError("DRAFT_NOT_FOUND", "x", 404),
    );
    const res = await postPromote(
      reqJson({
        destination: { kind: "FINAL_ASSESSMENT" },
        expectedDraftContentHash: HASH,
        expectedValidationId: "val1",
      }),
      ctx("d1"),
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  it("409 passes the rejection code through", async () => {
    mockPrincipal.mockResolvedValue(somePrincipal());
    mockPromote.mockRejectedValue(
      new PromoteRejectedError("DRAFT_NOT_APPROVED", "state=REJECTED", 409, {
        currentState: "REJECTED",
      }),
    );
    const res = await postPromote(
      reqJson({
        destination: { kind: "FINAL_ASSESSMENT" },
        expectedDraftContentHash: HASH,
        expectedValidationId: "val1",
      }),
      ctx("d1"),
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.rejectionCode).toBe("DRAFT_NOT_APPROVED");
  });

  it("409 on already-promoted-different-destination", async () => {
    mockPrincipal.mockResolvedValue(somePrincipal());
    mockPromote.mockRejectedValue(
      new PromoteRejectedError(
        "ALREADY_PROMOTED_DIFFERENT_DESTINATION",
        "dest was CHECKPOINT",
        409,
      ),
    );
    const res = await postPromote(
      reqJson({
        destination: { kind: "FINAL_ASSESSMENT" },
        expectedDraftContentHash: HASH,
        expectedValidationId: "val1",
      }),
      ctx("d1"),
    );
    expect(res.status).toBe(409);
  });
});
