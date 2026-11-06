// EP-TRAIN-6D-4W — worker handler end-to-end tests.
// Mocked Modal + injected transcript segments. Zero network call.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { resetDb } from "./util/db";
import {
  requestGeneration,
  markGenerationQueued,
} from "@/lib/hr/training/generation/generation-service";
import { buildBaselineAssessmentPlan } from "@/lib/hr/training/generation/assessment-plan";
import { handleGenerateJob } from "@/lib/hr/training/generation/worker-handler";
import type { Principal } from "@/lib/rbac";

const CLUB = "club_4w_wh";
const SHA = "a1b2c3d4".repeat(8);
const BUILD_SHA = "1".repeat(64);
const URL = "https://modal.example/generate";
const TOKEN = "tok";

function sa(): Principal {
  return {
    id: "u", name: "A", email: "a@t.local", status: "ACTIVE",
    memberships: [{ clubId: null, roleKey: "SUPER_ADMIN" }],
    activeClubId: CLUB, memberId: null,
  };
}

function signed(body: Record<string, unknown>): Response {
  const t = JSON.stringify(body);
  const sig = createHmac("sha256", TOKEN).update(t).digest("base64");
  return new Response(t, {
    status: 200,
    headers: { "content-type": "application/json", "x-spectre-signature": sig },
  });
}

async function seed() {
  const ts = Date.now() + Math.floor(Math.random() * 1_000_000);
  await prisma.club.upsert({
    where: { id: CLUB },
    create: { id: CLUB, name: CLUB, slug: `s-${ts}`, primaryColor: "#111" },
    update: {},
  });
  await prisma.user.upsert({
    where: { id: "u" },
    create: { id: "u", email: `u-${ts}@t.local`, name: "u", status: "ACTIVE", passwordHash: "x", role: "SUPER_ADMIN" },
    update: {},
  });
  const course = await prisma.trainingCourse.create({
    data: { clubId: CLUB, code: `C-${ts}`, title: "T", category: "ORIENTATION" },
  });
  const version = await prisma.trainingCourseVersion.create({
    data: {
      courseId: course.id, version: 1, state: "DRAFT", title: "V1",
      videoSha256: SHA, videoStorageKey: "k/v1", videoDurationSec: 120,
    },
  });
  await prisma.trainingTranscriptBuild.create({
    data: {
      clubId: CLUB, sourceVideoSha256: SHA,
      resolvedTranscriptBuildId: BUILD_SHA,
      transcriberName: "faster-whisper", transcriberVersion: "1",
      transcriberModelName: "large-v3", transcriberModelVersion: "stable",
      transcriberConfigSha256: "c".repeat(64), producedAt: new Date(),
    },
  });
  return { versionId: version.id };
}

function makePlan(opts: { versionId: string; target?: number }) {
  return buildBaselineAssessmentPlan({
    courseVersionId: opts.versionId,
    resolvedTranscriptBuildId: BUILD_SHA,
    sourceVideoSha256: SHA,
    segments: [
      { segmentIndex: 0, text: "Welcome." },
      { segmentIndex: 1, text: "Policy." },
      { segmentIndex: 2, text: "Escalation." },
      { segmentIndex: 3, text: "Safety." },
    ],
    videoDurationSec: 120,
    targetTotalQuestions: opts.target ?? 3,
    now: new Date("2026-11-06T00:00:00Z"),
  });
}

const GOOD_RESPONSE = {
  schemaVersion: "training-proposals-v1" as const,
  modelVariant: "qwen-2.5-7b-instruct-awq",
  proposals: [
    {
      questionType: "SINGLE_CHOICE",
      questionText: "What is the escalation policy?",
      options: [
        { text: "Confront", isCorrect: false },
        { text: "Notify manager", isCorrect: true },
      ],
      explanation: "e",
      sourceSegmentIds: [0, 2],
    },
  ],
  elapsedMs: { coldBoot: 1000, generate: 2000 },
  tokenCounts: { prompt: 500, output: 100 },
};

beforeEach(async () => {
  await resetDb();
  process.env.MODAL_GENERATE_URL = URL;
  process.env.MODAL_SPECTRE_SHARED_TOKEN = TOKEN;
});
afterEach(() => vi.restoreAllMocks());

describe("EP-TRAIN-6D-4W — worker handler", () => {
  it("W1 happy path: run REQUESTED -> QUEUED -> RUNNING -> COMPLETED + at least one draft persisted", async () => {
    const s = await seed();
    const plan = makePlan({ versionId: s.versionId });
    const r = await requestGeneration(sa(), CLUB, { courseVersionId: s.versionId, plan });
    await markGenerationQueued(CLUB, r.generationRunId);

    const fetchImpl = vi.fn().mockResolvedValue(signed(GOOD_RESPONSE));
    const result = await handleGenerateJob(
      { runId: r.generationRunId },
      {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        loadTranscriptSegments: async () => [
          { segmentIndex: 0, text: "Welcome." },
          { segmentIndex: 1, text: "Policy." },
          { segmentIndex: 2, text: "Escalation." },
          { segmentIndex: 3, text: "Safety." },
        ],
      },
    );
    expect(result.status).toBe("COMPLETED");

    const run = await prisma.trainingQuestionAiGenerationRun.findUnique({ where: { id: r.generationRunId } });
    expect(run?.executionStatus).toBe("COMPLETED");
    expect(run?.inferenceMs).toBeGreaterThan(0);
    const drafts = await prisma.trainingQuestionAiDraft.findMany({
      where: { generationRunId: r.generationRunId },
    });
    expect(drafts.length).toBeGreaterThan(0);
    // All drafts land in REQUIRES_HUMAN_REVIEW; no auto-approval.
    for (const d of drafts) {
      expect(d.state).toBe("REQUIRES_HUMAN_REVIEW");
    }
  });

  it("W2 proposals that cite excluded segments (16/17) are dropped", async () => {
    const s = await seed();
    const plan = makePlan({ versionId: s.versionId });
    const r = await requestGeneration(sa(), CLUB, { courseVersionId: s.versionId, plan });
    await markGenerationQueued(CLUB, r.generationRunId);

    const badCite = {
      ...GOOD_RESPONSE,
      proposals: [
        { ...GOOD_RESPONSE.proposals[0], sourceSegmentIds: [16, 17] }, // excluded
        GOOD_RESPONSE.proposals[0], // good
      ],
    };
    const fetchImpl = vi.fn().mockResolvedValue(signed(badCite));
    const result = await handleGenerateJob(
      { runId: r.generationRunId },
      {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        loadTranscriptSegments: async () => [
          { segmentIndex: 0, text: "Welcome." },
          { segmentIndex: 1, text: "Policy." },
          { segmentIndex: 2, text: "Escalation." },
          { segmentIndex: 3, text: "Safety." },
        ],
      },
    );
    expect(result.status).toBe("COMPLETED");
    const drafts = await prisma.trainingQuestionAiDraft.findMany({
      where: { generationRunId: r.generationRunId },
    });
    // Only the good one is persisted.
    expect(drafts.length).toBeGreaterThan(0);
    for (const d of drafts) {
      const body = JSON.parse(d.draftJson);
      expect(body.sourceSegmentIds).not.toContain(16);
      expect(body.sourceSegmentIds).not.toContain(17);
    }
  });

  it("W3 zero grounded proposals -> INSUFFICIENT_EVIDENCE + FAILED", async () => {
    const s = await seed();
    const plan = makePlan({ versionId: s.versionId });
    const r = await requestGeneration(sa(), CLUB, { courseVersionId: s.versionId, plan });
    await markGenerationQueued(CLUB, r.generationRunId);

    const ungrounded = {
      ...GOOD_RESPONSE,
      proposals: [{ ...GOOD_RESPONSE.proposals[0], sourceSegmentIds: [99] }], // not eligible
    };
    const fetchImpl = vi.fn().mockResolvedValue(signed(ungrounded));
    const result = await handleGenerateJob(
      { runId: r.generationRunId },
      {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        loadTranscriptSegments: async () => [
          { segmentIndex: 0, text: "Welcome." },
          { segmentIndex: 1, text: "Policy." },
          { segmentIndex: 2, text: "Escalation." },
          { segmentIndex: 3, text: "Safety." },
        ],
      },
    );
    expect(result.status).toBe("FAILED");
    const run = await prisma.trainingQuestionAiGenerationRun.findUnique({ where: { id: r.generationRunId } });
    expect(run?.executionStatus).toBe("FAILED");
    expect(run?.executionErrorCode).toBe("INSUFFICIENT_EVIDENCE");
  });

  it("W4 Modal HMAC invalid -> FAILED (non-retryable)", async () => {
    const s = await seed();
    const plan = makePlan({ versionId: s.versionId });
    const r = await requestGeneration(sa(), CLUB, { courseVersionId: s.versionId, plan });
    await markGenerationQueued(CLUB, r.generationRunId);

    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(GOOD_RESPONSE), {
        status: 200,
        headers: { "content-type": "application/json" }, // missing HMAC
      }),
    );
    const result = await handleGenerateJob(
      { runId: r.generationRunId },
      {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        loadTranscriptSegments: async () => [
          { segmentIndex: 0, text: "x" },
          { segmentIndex: 1, text: "y" },
        ],
      },
    );
    expect(result.status).toBe("FAILED");
    const run = await prisma.trainingQuestionAiGenerationRun.findUnique({ where: { id: r.generationRunId } });
    expect(run?.executionErrorCode).toBe("MODAL_HMAC_INVALID");
    expect(run?.executionStatus).toBe("FAILED");
  });

  it("W5 handler SKIPs when no QUEUED run exists", async () => {
    const result = await handleGenerateJob(
      { runId: "does-not-exist" },
      {
        fetchImpl: vi.fn() as unknown as typeof fetch,
        loadTranscriptSegments: async () => [],
      },
    );
    expect(result.status).toBe("SKIPPED");
  });
});
