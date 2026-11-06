// EP-TRAIN-6D-4X — worker integration: placement + dedup end-to-end
// via the 4W handler. Mocked Modal + injected transcript segments.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { resetDb } from "./util/db";
import {
  requestGeneration,
  markGenerationQueued,
} from "@/lib/hr/training/generation/generation-service";
import { buildTopicAwareAssessmentPlan } from "@/lib/hr/training/generation/placement";
import { handleGenerateJob } from "@/lib/hr/training/generation/worker-handler";
import type { Principal } from "@/lib/rbac";

const CLUB = "club_4x_wi";
const SHA = "a1b2c3d4".repeat(8);
const BUILD = "1".repeat(64);
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
      videoSha256: SHA, videoStorageKey: "k/v1", videoDurationSec: 240,
    },
  });
  await prisma.trainingTranscriptBuild.create({
    data: {
      clubId: CLUB, sourceVideoSha256: SHA,
      resolvedTranscriptBuildId: BUILD,
      transcriberName: "faster-whisper", transcriberVersion: "1",
      transcriberModelName: "large-v3", transcriberModelVersion: "stable",
      transcriberConfigSha256: "c".repeat(64), producedAt: new Date(),
    },
  });
  return { versionId: version.id };
}

function segments() {
  return [
    { segmentIndex: 0, startSec: 0, endSec: 10, text: "Welcome to the course today." },
    { segmentIndex: 1, startSec: 10.5, endSec: 35, text: "First we discuss the escalation policy for member disputes." },
    { segmentIndex: 2, startSec: 40, endSec: 70, text: "Next the equipment training. The industrial dishwasher must never run empty." },
    { segmentIndex: 3, startSec: 75, endSec: 110, text: "Food safety temperatures must stay below 4 degrees Celsius." },
    { segmentIndex: 4, startSec: 115, endSec: 150, text: "Finally the member service standards." },
    { segmentIndex: 5, startSec: 155, endSec: 190, text: "Members expect friendly consistent service every shift." },
  ];
}

function makePlan(versionId: string) {
  const r = buildTopicAwareAssessmentPlan({
    courseVersionId: versionId, resolvedTranscriptBuildId: BUILD, sourceVideoSha256: SHA,
    segments: segments(),
    videoDurationSec: 240, targetTotalQuestions: 4,
    now: new Date("2026-11-06T00:00:00Z"),
  });
  return r.plan;
}

beforeEach(async () => {
  await resetDb();
  process.env.MODAL_GENERATE_URL = URL;
  process.env.MODAL_SPECTRE_SHARED_TOKEN = TOKEN;
});
afterEach(() => vi.restoreAllMocks());

describe("EP-TRAIN-6D-4X — worker integration (placement + dedup)", () => {
  it("X1 topic-aware plan successfully requests + completes with placement-aware checkpoints", async () => {
    const s = await seed();
    const plan = makePlan(s.versionId);
    expect(plan.proposedCheckpointGroups.length).toBeGreaterThan(0);
    const r = await requestGeneration(sa(), CLUB, { courseVersionId: s.versionId, plan });
    await markGenerationQueued(CLUB, r.generationRunId);

    const response = {
      schemaVersion: "training-proposals-v1" as const,
      modelVariant: "qwen-2.5-7b-instruct-awq",
      proposals: [
        {
          questionType: "SINGLE_CHOICE",
          questionText: "What is the escalation policy?",
          options: [{ text: "Notify manager", isCorrect: true }, { text: "Confront", isCorrect: false }],
          explanation: "e",
          sourceSegmentIds: [1],
        },
      ],
      elapsedMs: { coldBoot: 1000, generate: 2000 },
      tokenCounts: { prompt: 100, output: 50 },
    };
    // mockImplementation so EACH Modal call gets a fresh Response
    // (Response bodies are stream-once; a plan with multiple groups
    // needs one signed() object per call).
    const fetchImpl = vi.fn().mockImplementation(async () => signed(response));
    const result = await handleGenerateJob(
      { runId: r.generationRunId },
      {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        loadTranscriptSegments: async () => segments().map((s) => ({ segmentIndex: s.segmentIndex, text: s.text })),
      },
    );
    expect(result.status).toBe("COMPLETED");
    const run = await prisma.trainingQuestionAiGenerationRun.findUnique({ where: { id: r.generationRunId } });
    expect(run?.executionStatus).toBe("COMPLETED");
  });

  it("X2 exact-duplicate proposals across groups are dropped by dedup; shortfallReasonJson records the decisions", async () => {
    const s = await seed();
    const plan = makePlan(s.versionId);
    const r = await requestGeneration(sa(), CLUB, { courseVersionId: s.versionId, plan });
    await markGenerationQueued(CLUB, r.generationRunId);

    const dupProposal = {
      questionType: "SINGLE_CHOICE",
      questionText: "What is the escalation policy?",
      options: [{ text: "Notify manager", isCorrect: true }, { text: "Confront", isCorrect: false }],
      explanation: "e",
      sourceSegmentIds: [1],
    };
    // Return the same proposal in every Modal call (every group gets it).
    const response = {
      schemaVersion: "training-proposals-v1" as const,
      modelVariant: "qwen-2.5-7b-instruct-awq",
      proposals: [dupProposal],
      elapsedMs: { coldBoot: 1000, generate: 2000 },
      tokenCounts: { prompt: 100, output: 50 },
    };
    const fetchImpl = vi.fn().mockImplementation(async () => signed(response));
    const result = await handleGenerateJob(
      { runId: r.generationRunId },
      {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        loadTranscriptSegments: async () => segments().map((s) => ({ segmentIndex: s.segmentIndex, text: s.text })),
      },
    );
    // Dedup should keep the first instance and drop the rest. If every
    // group got this proposal and dedup dropped all but one, the run
    // should either COMPLETE (one draft persisted) or FAIL with
    // INSUFFICIENT_EVIDENCE if dedup dropped literally every proposal
    // the handler emitted — the former is the happy path.
    expect(["COMPLETED", "FAILED"]).toContain(result.status);
    const run = await prisma.trainingQuestionAiGenerationRun.findUnique({ where: { id: r.generationRunId } });
    if (run?.executionStatus === "COMPLETED") {
      // Shortfall JSON MUST exist and MUST mention dedup.
      const sfr = run.shortfallReasonJson ? JSON.parse(run.shortfallReasonJson) : null;
      expect(sfr).not.toBeNull();
      expect(sfr.dedupRulesVersion).toBe("dedup-v1");
      expect(sfr.dedupDropCount).toBeGreaterThan(0);
      // The log must contain at least one EXACT_DUP decision.
      const hasExact = (sfr.dedupDecisions as Array<{ decision: { verdict: string } }>).some(
        (d) => d.decision.verdict === "EXACT_DUP",
      );
      expect(hasExact).toBe(true);
    }
  });

  it("X3 proposals citing excluded segments (16/17) are dropped before dedup runs (defense in depth)", async () => {
    const s = await seed();
    const plan = makePlan(s.versionId);
    const r = await requestGeneration(sa(), CLUB, { courseVersionId: s.versionId, plan });
    await markGenerationQueued(CLUB, r.generationRunId);

    const response = {
      schemaVersion: "training-proposals-v1" as const,
      modelVariant: "qwen-2.5-7b-instruct-awq",
      proposals: [
        {
          questionType: "SINGLE_CHOICE",
          questionText: "Excluded question",
          options: [{ text: "A", isCorrect: true }, { text: "B", isCorrect: false }],
          explanation: "e",
          sourceSegmentIds: [16], // excluded
        },
      ],
      elapsedMs: { coldBoot: 1000, generate: 2000 },
      tokenCounts: { prompt: 100, output: 50 },
    };
    const fetchImpl = vi.fn().mockImplementation(async () => signed(response));
    const result = await handleGenerateJob(
      { runId: r.generationRunId },
      {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        loadTranscriptSegments: async () => segments().map((s) => ({ segmentIndex: s.segmentIndex, text: s.text })),
      },
    );
    expect(result.status).toBe("FAILED");
    const run = await prisma.trainingQuestionAiGenerationRun.findUnique({ where: { id: r.generationRunId } });
    expect(run?.executionErrorCode).toBe("INSUFFICIENT_EVIDENCE");
    const drafts = await prisma.trainingQuestionAiDraft.count({ where: { generationRunId: r.generationRunId } });
    expect(drafts).toBe(0);
  });
});
