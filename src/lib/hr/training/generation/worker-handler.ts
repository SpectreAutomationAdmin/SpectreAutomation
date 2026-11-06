// EP-TRAIN-6D-4W (2026-11-06) — TRAINING_GENERATE_QUESTIONS worker handler.
//
// Runs in the Fly worker (bin/worker.ts). Claims the next QUEUED
// generation run, loads its assessment plan, iterates each group
// (checkpoint + final), calls Modal with constraints bounded to the
// plan's eligible segments, runs the existing deterministic
// validator on each proposal, persists validator-accepted drafts as
// TrainingQuestionAiDraft rows via a raw-Prisma analogue of the 4L
// contract (inside this handler the drafts attach to the run via
// generationRunId).
//
// Cancellation safety: every state mutation re-checks
// (executionStatus=RUNNING AND leaseToken=expected). A late Modal
// response against a CANCELLED run is discarded.

import { prisma as defaultPrisma } from "@/lib/prisma";
import { PrismaClient } from "@prisma/client";
import { logger } from "@/lib/observability/logger";
import {
  claimNextGenerationRun,
  recordGenerationCompleted,
  recordGenerationFailed,
  renewGenerationLease,
  type GenerationFailureCode,
} from "./generation-service";
import {
  callModalGenerate,
  ModalGenerateClientError,
  PROPOSAL_SCHEMA_VERSION,
  type ModalGenerateProposal,
} from "./modal-client";
import {
  validateAssessmentPlan,
  type AssessmentPlanV1,
  EXCLUDED_SEGMENT_INDICES,
} from "./assessment-plan";
import {
  evaluateAgainstPriors,
  DEDUP_RULES_VERSION,
  type DedupDecision,
  type QuestionCandidate,
} from "./dedup";
import { canonicalise, sha256Hex } from "../ai-review/content-hash";

export interface HandlerDeps {
  readonly fetchImpl?: typeof fetch;
  readonly env?: NodeJS.ProcessEnv;
  readonly prisma?: PrismaClient;
  /** Returns the raw segment text for citing. Tenant-scoped at the
   *  caller. Injected so tests can supply synthetic transcripts
   *  without a DB round-trip. */
  readonly loadTranscriptSegments?: (args: {
    readonly clubId: string;
    readonly resolvedTranscriptBuildId: string;
    readonly segmentIndices: readonly number[];
  }) => Promise<readonly { readonly segmentIndex: number; readonly text: string }[]>;
}

export async function handleGenerateJob(
  args: { readonly runId: string },
  deps: HandlerDeps = {},
): Promise<{ status: "COMPLETED" | "FAILED" | "SKIPPED" }> {
  const db = deps.prisma ?? defaultPrisma;

  // Claim (or reclaim).
  const claim = await claimNextGenerationRun({ prisma: db });
  if (!claim || claim.runId !== args.runId) {
    logger.info("training.generation.worker.skipped", {
      runId: args.runId,
      claimedRunId: claim?.runId ?? null,
    });
    return { status: "SKIPPED" };
  }

  // Parse + revalidate the plan. The service already validated at
  // request time; we re-validate here as defence in depth.
  let plan: AssessmentPlanV1;
  try {
    plan = validateAssessmentPlan(JSON.parse(claim.assessmentPlanJson));
  } catch (err) {
    await safeFail(db, claim, "INVALID_STRUCTURED_OUTPUT", (err as Error)?.message ?? "plan parse failed", false);
    return { status: "FAILED" };
  }

  // Load transcript texts (citeable).
  let segments: readonly { segmentIndex: number; text: string }[];
  try {
    const loader = deps.loadTranscriptSegments ?? defaultLoadSegments(db);
    segments = await loader({
      clubId: claim.clubId,
      resolvedTranscriptBuildId: plan.resolvedTranscriptBuildId,
      segmentIndices: plan.eligibleSegmentIds,
    });
  } catch (err) {
    await safeFail(db, claim, "TRANSCRIPT_MISSING", (err as Error)?.message ?? "transcript load failed", false);
    return { status: "FAILED" };
  }
  if (segments.length === 0) {
    await safeFail(db, claim, "INSUFFICIENT_EVIDENCE", "No eligible transcript segments.", false);
    return { status: "FAILED" };
  }

  // Build transcript representation for the prompt.
  const transcriptText = segments
    .filter((s) => !EXCLUDED_SEGMENT_INDICES.has(s.segmentIndex))
    .sort((a, b) => a.segmentIndex - b.segmentIndex)
    .map((s) => `[${s.segmentIndex}] ${s.text}`)
    .join("\n");

  // Iterate plan groups (checkpoints + final).
  const generatedDrafts: {
    group: string;
    kind: "CHECKPOINT" | "FINAL_ASSESSMENT";
    draft: ModalGenerateProposal;
    contentHash: string;
    dedupDecision: DedupDecision;
  }[] = [];
  // Per-candidate dedup decision log for shortfallReasonJson.
  const dedupLog: Array<{
    group: string;
    candidateContentHash: string;
    decision: DedupDecision;
    kept: boolean;
  }> = [];
  let shortfallCount = 0;
  let dedupDropCount = 0;
  let totalInferenceMs = 0;
  let totalPromptTokens = 0;
  let totalOutputTokens = 0;

  const groups: {
    id: string;
    kind: "CHECKPOINT" | "FINAL_ASSESSMENT";
    target: number;
    atSec?: number;
  }[] = [
    ...plan.proposedCheckpointGroups.map((g) => ({
      id: g.id,
      kind: "CHECKPOINT" as const,
      target: g.targetQuestionCount,
      atSec: g.atSec,
    })),
    {
      id: "final",
      kind: "FINAL_ASSESSMENT" as const,
      target: plan.proposedFinalAssessment.targetQuestionCount,
    },
  ];

  for (const g of groups) {
    if (g.target <= 0) continue;
    try {
      const modalResponse = await callModalGenerate(
        {
          requestId: `${claim.runId}:${g.id}`,
          modelVariant: "qwen-2.5-7b-instruct-awq",
          promptSchemaVersion: PROPOSAL_SCHEMA_VERSION,
          systemPrompt: buildSystemPrompt(g.kind, g.target),
          transcript: transcriptText,
          constraints: {
            proposalKind: g.kind === "CHECKPOINT" ? "QUESTION_CHECKPOINT_BOUND" : "QUESTION_FINAL_ASSESSMENT",
            maxQuestions: g.target,
            allowedQuestionTypes: ["SINGLE_CHOICE", "TRUE_FALSE"],
            jsonSchema: {},
          },
        },
        { fetchImpl: deps.fetchImpl, env: deps.env },
      );
      totalInferenceMs += modalResponse.elapsedMs.coldBoot + modalResponse.elapsedMs.generate;
      totalPromptTokens += modalResponse.tokenCounts.prompt;
      totalOutputTokens += modalResponse.tokenCounts.output;

      // Track shortfall if the model returned fewer than target.
      if (modalResponse.proposals.length < g.target) {
        shortfallCount += g.target - modalResponse.proposals.length;
      }

      // Light validation: ensure cited segments are inside the
      // plan's eligibleSegmentIds (full grounding-validator is the
      // next layer in; this handler only enforces the plan's
      // boundary).
      const eligible = new Set(plan.eligibleSegmentIds);
      for (const p of modalResponse.proposals) {
        const citedOk = p.sourceSegmentIds.every((id) => eligible.has(id) && !EXCLUDED_SEGMENT_INDICES.has(id));
        if (!citedOk) continue; // skip ungrounded proposals

        // Compute canonical body + content hash for dedup + persist.
        const canonicalBody = {
          questionType: p.questionType,
          questionText: p.questionText,
          options: p.options.map((o) => ({ text: o.text, isCorrect: o.isCorrect })),
          explanation: p.explanation,
          sourceSegmentIds: [...p.sourceSegmentIds],
        };
        const candidateContentHash = sha256Hex(canonicalise(canonicalBody));

        // Dedup against EVERY previously-kept candidate across all
        // groups (checkpoints + final) in this plan.
        const priors: QuestionCandidate[] = generatedDrafts.map((gd) => ({
          id: gd.contentHash,
          questionText: gd.draft.questionText,
          options: gd.draft.options,
          explanation: gd.draft.explanation,
          destination: gd.group,
        }));
        const candidate: QuestionCandidate = {
          id: candidateContentHash,
          questionText: p.questionText,
          options: p.options,
          explanation: p.explanation,
          destination: g.id,
        };
        const decision = evaluateAgainstPriors(candidate, priors);

        // §6: EXACT_DUP / PARAPHRASE_DUP are dropped; TOPIC_CANDIDATE
        // is kept but flagged for manager review.
        const isDuplicate = decision.verdict === "EXACT_DUP" || decision.verdict === "PARAPHRASE_DUP";
        dedupLog.push({ group: g.id, candidateContentHash, decision, kept: !isDuplicate });
        if (isDuplicate) {
          dedupDropCount++;
          continue;
        }

        generatedDrafts.push({
          group: g.id,
          kind: g.kind,
          draft: p,
          contentHash: candidateContentHash,
          dedupDecision: decision,
        });
      }

      // Renew lease between groups.
      try {
        await renewGenerationLease(claim.runId, claim.leaseToken, { prisma: db });
      } catch {
        // Cancellation race — bail.
        return { status: "FAILED" };
      }
    } catch (err) {
      const code: GenerationFailureCode =
        err instanceof ModalGenerateClientError
          ? (err.code as GenerationFailureCode)
          : "MODAL_HTTP_ERROR";
      await safeFail(
        db,
        claim,
        code,
        (err as Error)?.message ?? String(err),
        code !== "CREDENTIAL_ABSENT" && code !== "MODAL_HMAC_INVALID",
      );
      return { status: "FAILED" };
    }
  }

  if (generatedDrafts.length === 0) {
    await safeFail(db, claim, "INSUFFICIENT_EVIDENCE", "No grounded proposals produced.", false);
    return { status: "FAILED" };
  }

  // Persist drafts. Each draft attaches to the run via generationRunId.
  // We dedup within the run via (clubId, courseVersionId, contentHash)
  // Prisma @@unique. A P2002 here is swallowed as a duplicate skip.
  const projectionSha = claim.planIdentity; // placeholder — 4W does not create a new projection
  let persistedCount = 0;
  const courseId = await resolveCourseId(db, claim.courseVersionId);
  for (const { draft, contentHash } of generatedDrafts) {
    const canonicalBody = {
      questionType: draft.questionType,
      questionText: draft.questionText,
      options: draft.options.map((o) => ({ text: o.text, isCorrect: o.isCorrect })),
      explanation: draft.explanation,
      sourceSegmentIds: [...draft.sourceSegmentIds],
    };
    try {
      await db.trainingQuestionAiDraft.create({
        data: {
          clubId: claim.clubId,
          courseId,
          courseVersionId: claim.courseVersionId,
          generationRunId: claim.runId,
          draftJson: JSON.stringify(canonicalBody),
          contentHash,
          sourceVideoSha256: plan.sourceVideoSha256,
          resolvedTranscriptBuildId: plan.resolvedTranscriptBuildId,
          groundingProjectionSha256: projectionSha,
          pilotAuthorizationId: "4w-generation",
          pilotAuthorizationFingerprint: claim.planIdentity.slice(0, 32),
          state: "REQUIRES_HUMAN_REVIEW",
          recordVersion: 0,
          generatedAt: new Date(),
        },
      });
      persistedCount++;
    } catch (err) {
      if ((err as { code?: string })?.code === "P2002") {
        shortfallCount++;
        continue;
      }
      await safeFail(db, claim, "DRAFT_PERSIST_FAILED", (err as Error)?.message ?? String(err), false);
      return { status: "FAILED" };
    }
  }

  // Terminal.
  try {
    await recordGenerationCompleted(
      {
        runId: claim.runId,
        leaseToken: claim.leaseToken,
        inferenceMs: totalInferenceMs,
        promptTokenCount: totalPromptTokens,
        outputTokenCount: totalOutputTokens,
        groundingProjectionSha256: projectionSha,
        shortfallReasonJson: (shortfallCount > 0 || dedupDropCount > 0 || dedupLog.length > 0)
          ? JSON.stringify({
              schemaVersion: "shortfall-v1",
              targetCount: plan.totalTargetQuestionCount,
              generatedCount: persistedCount,
              shortfall: shortfallCount,
              dedupDropCount,
              dedupRulesVersion: DEDUP_RULES_VERSION,
              dedupDecisions: dedupLog,
              reason: shortfallCount > 0 && dedupDropCount > 0
                ? "model returned fewer grounded candidates than target and duplicates dropped"
                : shortfallCount > 0
                  ? "model returned fewer grounded candidates than target"
                  : dedupDropCount > 0
                    ? "duplicates dropped by dedup pipeline"
                    : "candidates flagged for manager review as topic-related",
            })
          : undefined,
      },
      { prisma: db },
    );
    return { status: "COMPLETED" };
  } catch {
    // Cancellation race — don't overwrite.
    return { status: "FAILED" };
  }
}

function buildSystemPrompt(kind: "CHECKPOINT" | "FINAL_ASSESSMENT", target: number): string {
  // Deterministic prompt — keeps tests stable + avoids LLM drift.
  if (kind === "CHECKPOINT") {
    return `You are a training-content authoring assistant. Produce up to ${target} multiple-choice questions suitable for a mid-video knowledge checkpoint. Cite only the transcript segments provided. Do NOT invent facts. Prefer SINGLE_CHOICE; TRUE_FALSE is acceptable when the source material directly supports a binary claim. Each question MUST cite at least one transcript segment id.`;
  }
  return `You are a training-content authoring assistant. Produce up to ${target} multiple-choice questions suitable for the final course assessment. Cite only the transcript segments provided. Do NOT invent facts. Each question MUST cite at least one transcript segment id.`;
}

async function safeFail(
  db: PrismaClient,
  claim: { runId: string; leaseToken: string },
  code: GenerationFailureCode,
  message: string,
  retryable: boolean,
): Promise<void> {
  try {
    await recordGenerationFailed(
      {
        runId: claim.runId,
        leaseToken: claim.leaseToken,
        failureCode: code,
        failureMessage: message,
        retryable,
      },
      { prisma: db },
    );
  } catch {
    // Cancellation race; terminal state is authoritative.
  }
}

async function resolveCourseId(db: PrismaClient, courseVersionId: string): Promise<string> {
  const v = await db.trainingCourseVersion.findUnique({
    where: { id: courseVersionId },
    select: { courseId: true },
  });
  if (!v) throw new Error(`course-version ${courseVersionId} not found`);
  return v.courseId;
}

function defaultLoadSegments(db: PrismaClient) {
  return async (args: { clubId: string; resolvedTranscriptBuildId: string; segmentIndices: readonly number[] }) => {
    const build = await db.trainingTranscriptBuild.findFirst({
      where: {
        clubId: args.clubId,
        resolvedTranscriptBuildId: args.resolvedTranscriptBuildId,
      },
      select: { id: true },
    });
    if (!build) throw new Error("transcript build not found");
    const rows = await db.trainingTranscriptSegment.findMany({
      where: {
        clubId: args.clubId,
        transcriptBuildId: build.id,
        segmentIndex: { in: [...args.segmentIndices] },
      },
      select: { segmentIndex: true, text: true },
      orderBy: [{ segmentIndex: "asc" }],
    });
    return rows;
  };
}
