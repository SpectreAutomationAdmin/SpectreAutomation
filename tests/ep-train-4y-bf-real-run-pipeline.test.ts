/**
 * EP-TRAIN-4Y-BF §3 — the 13 proposals of the first unattended real run,
 * replayed through the COMPLETE worker pipeline:
 *
 *   plan → provider response → grounding → normalisation → sanitiser →
 *   structural validator → duplicate check → persistence → validation
 *
 * The provider is a local stub that returns the captured proposals over
 * the real signed wire contract. No GPU, no network. The database is the
 * real (SQLite) test database, so what is asserted is what would be
 * stored: which questions survive, with which text, and with their
 * provenance and answer key intact.
 *
 * As returned by the model, that run kept 0 of 5 checkpoint questions
 * and 4 of 8 final-assessment questions.
 */
import { beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { prisma } from "@/lib/prisma";
import { resetDb } from "./util/db";
import {
  CONTRACT_VERSION,
  OPERATION_GENERATE,
  signResponse,
} from "@/lib/hr/training/modal-shared";
import { buildPlanAndRequestGeneration } from "@/lib/hr/training/generation/enqueue-helper";
import { handleGenerateJob } from "@/lib/hr/training/generation/worker-handler";
import { checkEmployeeFacingText } from "@/lib/hr/training/ai-review/question-text-sanitizer";
import type { Principal } from "@/lib/rbac";

interface FixtureProposal {
  questionType: string;
  questionText: string;
  options: Array<{ text: string; isCorrect: boolean }>;
  explanation: string;
  sourceSegmentIds: number[];
}
interface Fixture {
  groups: Array<{
    group: string;
    kind: string;
    returned: number;
    rejected: Array<FixtureProposal & { proposalIndex: number }>;
  }>;
  kept: Array<FixtureProposal & { group: string }>;
  segments: Array<{ segmentIndex: number; text: string; startSec: number; endSec: number }>;
}

const fixture = JSON.parse(
  fs.readFileSync(path.join(__dirname, "fixtures", "ep-train-4y-bf-real-run-proposals.json"), "utf8"),
) as Fixture;

const CLUB = "club_4ybf_pipeline";
const USER = "user_4ybf_pipeline";
const SHA = "b7".repeat(32);
const BUILD = "2".repeat(64);
const DURATION_SEC = 643;
const SEGMENT_COUNT = 105;

const RESPONSE_KEY = "test-response-hmac-key-0000000000";
const ENV = {
  MODAL_KEY: "k",
  MODAL_SECRET: "s",
  MODAL_SPECTRE_HMAC_KEY: "test-hmac-key-32-bytes-0000000000",
  SPECTRE_PILOT_AUTH_FINGERPRINT_SECRET: "test-fingerprint-secret-00000000",
  MODAL_SPECTRE_RESPONSE_HMAC_KEY: RESPONSE_KEY,
  MODAL_TRANSCRIBE_URL: "https://modal.example/transcribe",
  MODAL_GENERATE_URL: "https://modal.example/generate",
  TRAINING_BILLABLE_INFERENCE: "enabled",
} as unknown as NodeJS.ProcessEnv;

function principal(): Principal {
  return {
    id: USER,
    name: "Manager",
    email: "manager-4ybf@t.local",
    status: "ACTIVE",
    memberships: [{ clubId: null, roleKey: "SUPER_ADMIN" }],
    activeClubId: CLUB,
    memberId: null,
  };
}

/** The captured transcript lines the proposals cite, plus neutral filler
 *  for the lines nobody cited, tiled across the whole video. */
function transcript(): Array<{ segmentIndex: number; text: string; startSec: number; endSec: number }> {
  const known = new Map(fixture.segments.map((s) => [s.segmentIndex, s]));
  const step = DURATION_SEC / SEGMENT_COUNT;
  const out = [];
  for (let i = 0; i < SEGMENT_COUNT; i++) {
    const k = known.get(i);
    out.push({
      segmentIndex: i,
      text: k ? k.text : `Narration continues with station upkeep detail number ${i}.`,
      startSec: Math.round(i * step * 100) / 100,
      endSec: Math.round((i + 1) * step * 100) / 100,
    });
  }
  return out;
}

/** What the model returned for each group, in the order it returned it. */
function responsesByGroup(): Map<string, FixtureProposal[]> {
  const out = new Map<string, FixtureProposal[]>();
  for (const g of fixture.groups) {
    const slots: (FixtureProposal | null)[] = Array.from({ length: g.returned }, () => null);
    for (const r of g.rejected) slots[r.proposalIndex] = r;
    const kept = fixture.kept.filter((k) => k.group === g.group);
    for (let i = 0; i < slots.length; i++) if (slots[i] === null) slots[i] = kept.shift() ?? null;
    out.set(
      g.group,
      slots.filter((s): s is FixtureProposal => s !== null).map((s) => ({
        questionType: s.questionType,
        questionText: s.questionText,
        options: s.options,
        explanation: s.explanation,
        sourceSegmentIds: s.sourceSegmentIds,
      })),
    );
  }
  return out;
}

/** Local provider stub speaking the real signed contract. */
function providerStub(
  duringCall?: (group: string) => Promise<void>,
): { fetchImpl: typeof fetch; calls: string[] } {
  const byGroup = responsesByGroup();
  const calls: string[] = [];
  let checkpointCalls = 0;
  let finalCalls = 0;
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    const headers = init?.headers as Record<string, string>;
    const requestId = headers["x-spectre-request-id"] ?? headers["X-Spectre-Request-Id"];
    const body = JSON.parse(String(init?.body)) as {
      operation: string;
      payload: { constraints?: { proposalKind?: string } };
    };
    if (body.operation !== OPERATION_GENERATE) {
      // The optional course-title call: not part of this replay.
      calls.push("metadata");
      return new Response("{}", { status: 500 });
    }
    const group =
      body.payload.constraints?.proposalKind === "QUESTION_CHECKPOINT_BOUND"
        ? `cg-${++checkpointCalls}`
        : `fa-${++finalCalls}`;
    calls.push(group);
    if (duringCall) await duringCall(group);
    const responseBody = {
      contractVersion: CONTRACT_VERSION,
      operation: OPERATION_GENERATE,
      requestId,
      modelVariant: "qwen-2.5-7b-instruct-awq",
      proposals: byGroup.get(group) ?? [],
      elapsedMs: { coldBoot: 0, generate: 1000 },
      tokenCounts: { prompt: 100, output: 50 },
    };
    const bodyText = JSON.stringify(responseBody);
    const signature = signResponse({
      operation: OPERATION_GENERATE,
      requestId,
      httpStatus: 200,
      bodyText,
      responseHmacKey: RESPONSE_KEY,
    });
    return new Response(bodyText, { status: 200, headers: { "Content-Type": "application/json", ...signature } });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

async function seed(): Promise<{ versionId: string }> {
  const stamp = Date.now() + Math.floor(Math.random() * 1_000_000);
  await prisma.club.create({ data: { id: CLUB, name: CLUB, slug: `s-${stamp}`, primaryColor: "#111" } });
  await prisma.user.create({
    data: { id: USER, email: `u-${stamp}@t.local`, name: "Manager", status: "ACTIVE", passwordHash: "x", role: "SUPER_ADMIN" },
  });
  const course = await prisma.trainingCourse.create({
    data: { clubId: CLUB, code: `BF-${stamp}`, title: "Carving station", category: "ORIENTATION", createdByUserId: USER },
  });
  const version = await prisma.trainingCourseVersion.create({
    data: {
      courseId: course.id,
      version: 1,
      state: "DRAFT",
      title: "V1",
      videoSha256: SHA,
      videoStorageKey: "k/v1",
      videoDurationSec: DURATION_SEC,
    },
  });
  const build = await prisma.trainingTranscriptBuild.create({
    data: {
      clubId: CLUB,
      sourceVideoSha256: SHA,
      resolvedTranscriptBuildId: BUILD,
      transcriberName: "faster-whisper",
      transcriberVersion: "1.0.3",
      transcriberModelName: "faster-whisper-large-v3",
      transcriberModelVersion: "stable-v1",
      transcriberConfigSha256: "c".repeat(64),
      producedAt: new Date(),
    },
  });
  for (const s of transcript()) {
    await prisma.trainingTranscriptSegment.create({
      data: {
        clubId: CLUB,
        transcriptBuildId: build.id,
        segmentIndex: s.segmentIndex,
        text: s.text,
        startSec: s.startSec,
        endSec: s.endSec,
      },
    });
  }
  return { versionId: version.id };
}

beforeEach(async () => {
  await resetDb();
  // Web-side precheck signal only; the worker reads its own env below.
  process.env.MODAL_HYBRID_ENABLED = "1";
});

describe("EP-TRAIN-4Y-BF §3 — the real run's 13 proposals through the complete pipeline", () => {
  it("5 of 5 checkpoint and 8 of 8 final-assessment questions now survive, cleaned and intact", async () => {
    const { versionId } = await seed();

    // The plan a real upload produces for a 643-second video.
    const requested = await buildPlanAndRequestGeneration(principal(), { clubId: CLUB, courseVersionId: versionId });
    expect(requested.idempotent).toBe(false);
    const runRow = await prisma.trainingQuestionAiGenerationRun.findUniqueOrThrow({
      where: { id: requested.generationRunId },
    });
    const plan = JSON.parse(runRow.assessmentPlanJson ?? "{}") as {
      proposedCheckpointGroups: Array<{ id: string }>;
      proposedFinalAssessmentChunks: Array<{ id: string; targetQuestionCount: number }>;
    };
    expect(plan.proposedCheckpointGroups.map((g) => g.id)).toEqual(["cg-1", "cg-2", "cg-3", "cg-4", "cg-5"]);
    expect(plan.proposedFinalAssessmentChunks.map((c) => `${c.id}x${c.targetQuestionCount}`)).toEqual([
      "fa-1x3",
      "fa-2x3",
      "fa-3x2",
    ]);

    const stub = providerStub();
    const result = await handleGenerateJob({ runId: requested.generationRunId }, { fetchImpl: stub.fetchImpl, env: ENV });
    expect(result.status).toBe("COMPLETED");
    expect(stub.calls.filter((c) => c !== "metadata")).toEqual([
      "cg-1", "cg-2", "cg-3", "cg-4", "cg-5", "fa-1", "fa-2", "fa-3",
    ]);

    const run = await prisma.trainingQuestionAiGenerationRun.findUniqueOrThrow({
      where: { id: requested.generationRunId },
    });
    const shortfall = JSON.parse(run.shortfallReasonJson ?? "{}") as {
      perGroupDiagnostics: Array<{
        group: string;
        kind: string;
        proposalCountFromModal: number;
        groundingDroppedCount: number;
        sanitizerDroppedCount: number;
        dedupDroppedCount: number;
        persistedCount: number;
        normalisationTrace: Array<{
          proposalIndex: number;
          proposalTransforms?: Array<{ ruleId: string }>;
          original?: { questionText: string; options: Array<{ text: string }>; explanation: string | null };
          normalised?: { questionText: string };
        }>;
      }>;
    };
    const table = shortfall.perGroupDiagnostics.map((g) => ({
      group: g.group,
      returned: g.proposalCountFromModal,
      grounding: g.groundingDroppedCount,
      sanitiserOrStructure: g.sanitizerDroppedCount,
      duplicate: g.dedupDroppedCount,
      kept: g.persistedCount,
    }));
    // eslint-disable-next-line no-console
    console.log("4Y-BF pipeline result per group:\n" + table.map((r) => JSON.stringify(r)).join("\n"));

    const checkpointKept = shortfall.perGroupDiagnostics
      .filter((g) => g.kind === "CHECKPOINT")
      .reduce((sum, g) => sum + g.persistedCount, 0);
    const finalKept = shortfall.perGroupDiagnostics
      .filter((g) => g.kind === "FINAL_ASSESSMENT")
      .reduce((sum, g) => sum + g.persistedCount, 0);
    expect(checkpointKept).toBe(5);
    expect(finalKept).toBe(8);
    expect(shortfall.perGroupDiagnostics.every((g) => g.sanitizerDroppedCount === 0)).toBe(true);

    // What was stored.
    const drafts = await prisma.trainingQuestionAiDraft.findMany({
      where: { generationRunId: requested.generationRunId },
      select: { id: true, draftJson: true, state: true },
    });
    expect(drafts.length).toBe(13);
    const stored = drafts.map((d) => JSON.parse(d.draftJson) as FixtureProposal);
    const everyOriginal = [...fixture.groups.flatMap((g) => g.rejected), ...fixture.kept];
    for (const body of stored) {
      // Employee-facing text is clean.
      expect(
        checkEmployeeFacingText({ questionText: body.questionText, options: body.options, explanation: body.explanation }).ok,
      ).toBe(true);
      const everything = [body.questionText, body.explanation, ...body.options.map((o) => o.text)].join(" ");
      expect(everything).not.toMatch(/according to the training/i);
      expect(everything).not.toMatch(/\bsegment\b/i);
      expect(everything).not.toMatch(/correct answer\s*:/i);
      expect(body.explanation).not.toMatch(/\[\s*\d+(\s*,\s*\d+)*\s*\]\s*$/);

      // Provenance and answer key are exactly the model's.
      const original = everyOriginal.find(
        (o) => JSON.stringify(o.sourceSegmentIds) === JSON.stringify(body.sourceSegmentIds) &&
          o.options.length === body.options.length &&
          o.options.every((opt, i) => opt.text.startsWith(body.options[i].text)),
      );
      expect(original, `no captured proposal matches stored question: ${body.questionText}`).toBeDefined();
      expect(body.options.map((o) => o.isCorrect)).toEqual(original!.options.map((o) => o.isCorrect));
      expect(body.sourceSegmentIds).toEqual(original!.sourceSegmentIds);
    }
    expect(drafts.every((d) => d.state === "REQUIRES_HUMAN_REVIEW")).toBe(true);

    // Every stored question went through answer-integrity / grounding
    // validation, and none was rejected by it.
    const validations = await prisma.trainingQuestionAiValidation.findMany({
      where: { draftId: { in: drafts.map((d) => d.id) } },
      select: { draftId: true, verdict: true, errorsJson: true },
    });
    expect(new Set(validations.map((v) => v.draftId)).size).toBe(13);
    // eslint-disable-next-line no-console
    console.log(
      "4Y-BF validation verdicts: " +
        JSON.stringify(
          validations.reduce<Record<string, number>>((acc, v) => {
            acc[v.verdict] = (acc[v.verdict] ?? 0) + 1;
            return acc;
          }, {}),
        ),
    );
    expect(validations.filter((v) => v.verdict === "REJECTED")).toEqual([]);

    // Restricted diagnostics keep BOTH versions of every changed proposal.
    const traces = shortfall.perGroupDiagnostics.flatMap((g) => g.normalisationTrace);
    const changed = traces.filter((t) => (t.proposalTransforms ?? []).length > 0);
    expect(changed.length).toBe(10); // the 9 rejected + 1 trailing citation list
    for (const t of changed) {
      expect(t.original).toBeDefined();
      expect(t.normalised).toBeDefined();
    }
    const cg2 = shortfall.perGroupDiagnostics.find((g) => g.group === "cg-2")!.normalisationTrace[0];
    expect(cg2.original!.questionText).toMatch(/according to the training material\?$/);
    expect(cg2.normalised!.questionText).toBe(
      "If a guest requests a half-inch slice of roast beef, how should you respond?",
    );

    // The transformations are audited (rule ids only; no question text).
    const auditRow = await prisma.auditLog.findFirst({
      where: {
        action: "hr.training.generation.normalisation_applied",
        entityType: "TrainingQuestionAiGenerationRun",
        entityId: requested.generationRunId,
      },
    });
    expect(auditRow).not.toBeNull();
    const audited = JSON.parse(auditRow!.afterJson ?? "{}") as {
      proposalsNormalised: number;
      proposalsRefused: number;
      normalisedAndAccepted: number;
      byRule: Record<string, number>;
    };
    expect(audited.proposalsNormalised).toBe(10);
    expect(audited.proposalsRefused).toBe(0);
    expect(audited.normalisedAndAccepted).toBe(10);
    expect(audited.byRule.SOURCE_REFERENCE_TRAILING).toBeGreaterThanOrEqual(6);
    expect(auditRow!.afterJson).not.toMatch(/roast beef|carving knife/i);
  }, 120_000);

  it("fencing: a run superseded while the provider is still answering stores nothing", async () => {
    const { versionId } = await seed();
    const requested = await buildPlanAndRequestGeneration(principal(), { clubId: CLUB, courseVersionId: versionId });

    // While the LAST provider call is in flight, the run is retired as
    // abandoned (exactly what automatic recovery does to a run whose
    // lease expired): FAILED, lease token cleared.
    const stub = providerStub(async (group) => {
      if (group !== "fa-3") return;
      await prisma.trainingQuestionAiGenerationRun.update({
        where: { id: requested.generationRunId },
        data: {
          executionStatus: "FAILED",
          executionErrorCode: "MODAL_TIMEOUT",
          executionErrorMessage: "Stalled run superseded by automatic recovery.",
          completedAt: new Date(),
          leaseToken: null,
          leaseExpiresAt: null,
        },
      });
    });
    const result = await handleGenerateJob({ runId: requested.generationRunId }, { fetchImpl: stub.fetchImpl, env: ENV });

    // The old worker had 13 accepted questions in hand and wrote none.
    expect(result.status).toBe("FAILED");
    expect(await prisma.trainingQuestionAiDraft.count({ where: { courseVersionId: versionId } })).toBe(0);
    expect(await prisma.trainingQuestionAiValidation.count()).toBe(0);
    const run = await prisma.trainingQuestionAiGenerationRun.findUniqueOrThrow({ where: { id: requested.generationRunId } });
    // It could not overwrite the outcome recorded by the recovery either.
    expect(run.executionStatus).toBe("FAILED");
    expect(run.executionErrorMessage).toMatch(/superseded/i);
  }, 120_000);
});
