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
import { randomBytes } from "node:crypto";
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
  materialiseGroundingProjection,
  materialiseValidationForDraft,
  synthesizePilotAuthorizationFromRun,
} from "../ai-review/projection-and-validation-persistence";

/** EP-TRAIN-4Y-M (2026-11-08) — runtime-only grounding-hygiene filter.
 *  Applied at prompt-build + proposal-validation time inside this
 *  handler. Not consumed by plan-build or plan-validate, so it does
 *  NOT invalidate pre-existing assessment plans whose stored
 *  `eligibleSegmentIds` contain these indices.
 *
 *  68–82 — 15 consecutive "Thank you." Whisper duplication artifacts
 *    within 237.18–242.04 s on the Silver Springs orientation transcript
 *    (each segment ≤0.02–0.26 s duration). Pure repetition artifact.
 *  160, 161 — End-of-video Whisper hallucination at 634.93–636.03 s
 *    (multi-script garble mixing Korean + Portuguese + Turkish + CJK
 *    glyphs with English). Segment 162 is coherent English and remains
 *    eligible.
 *  Union with EXCLUDED_SEGMENT_INDICES gives the full worker-time
 *  exclusion set. */
const RUNTIME_EXCLUDED_SEGMENT_INDICES: ReadonlySet<number> = new Set([
  68, 69, 70, 71, 72, 73, 74, 75, 76, 77, 78, 79, 80, 81, 82,
  160, 161,
]);

/** Full set actually applied by this handler: plan-level exclusions
 *  union runtime hygiene exclusions. */
const WORKER_EXCLUDED_SEGMENT_INDICES: ReadonlySet<number> = new Set<number>([
  ...EXCLUDED_SEGMENT_INDICES,
  ...RUNTIME_EXCLUDED_SEGMENT_INDICES,
]);
import {
  evaluateAgainstPriors,
  DEDUP_RULES_VERSION,
  type DedupDecision,
  type QuestionCandidate,
} from "./dedup";
import { canonicalise, sha256Hex } from "../ai-review/content-hash";
import {
  issuePilotAuthorization,
  ModalContractError,
  ENV_FINGERPRINT_SECRET,
} from "../modal-shared";

export interface HandlerDeps {
  readonly fetchImpl?: typeof fetch;
  readonly env?: NodeJS.ProcessEnv;
  readonly prisma?: PrismaClient;
  /** Returns the raw segment text + timing for citing. Tenant-scoped
   *  at the caller. Injected so tests can supply synthetic transcripts
   *  without a DB round-trip. `startSec` + `endSec` enable the 4Y-N
   *  per-checkpoint windowing (checkpoint questions must assess only
   *  content shown before their `atSec`). */
  readonly loadTranscriptSegments?: (args: {
    readonly clubId: string;
    readonly resolvedTranscriptBuildId: string;
    readonly segmentIndices: readonly number[];
  }) => Promise<readonly {
    readonly segmentIndex: number;
    readonly text: string;
    readonly startSec: number;
    readonly endSec: number;
  }[]>;
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

  // Load transcript texts + timing (citeable). EP-TRAIN-4Y-N adds
  // `startSec`/`endSec` so the per-checkpoint windowing can filter
  // out content shown AFTER the checkpoint moment.
  let segments: readonly { segmentIndex: number; text: string; startSec: number; endSec: number }[];
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

  // Filter segments to the worker exclusion set (plan-level +
  // runtime grounding hygiene) so Whisper duplication + end-of-video
  // hallucination don't reach the model.
  const eligibleSegments = [...segments]
    .filter((s) => !WORKER_EXCLUDED_SEGMENT_INDICES.has(s.segmentIndex))
    .sort((a, b) => a.segmentIndex - b.segmentIndex);

  // Full-course transcript text — used by FINAL_ASSESSMENT groups and
  // (for legacy / non-ctx-v1 plans) all groups.
  const fullTranscriptText = eligibleSegments
    .map((s) => `[${s.segmentIndex}] ${s.text}`)
    .join("\n");

  // EP-TRAIN-4Y-N (2026-11-08) — context-aware prompt contract.
  // When the plan declares `generationPromptContract: "ctx-v1"`, the
  // worker produces per-checkpoint windowed transcripts + per-group
  // system prompts referencing the LO + checkpoint timestamp.
  const useCtxV1 = plan.generationPromptContract === "ctx-v1";
  const loById = new Map(plan.learningObjectives.map((lo) => [lo.id, lo]));
  const sortedCheckpoints = [...plan.proposedCheckpointGroups].sort((a, b) => a.atSec - b.atSec);
  const checkpointOrderIndex = new Map<string, number>(
    sortedCheckpoints.map((g, i) => [g.id, i]),
  );
  const videoEndSec = eligibleSegments.length > 0
    ? Math.max(...eligibleSegments.map((s) => s.endSec))
    : 0;

  function windowForCheckpoint(cgId: string, atSec: number): typeof eligibleSegments {
    // Window = segments whose endSec ≤ atSec (fully shown before
    // the checkpoint). Lower bound = the prior checkpoint's atSec
    // (so each checkpoint focuses on NEW material); first checkpoint
    // uses 0.
    const idx = checkpointOrderIndex.get(cgId) ?? 0;
    const lowerSec = idx > 0 ? sortedCheckpoints[idx - 1].atSec : 0;
    return eligibleSegments.filter(
      (s) => s.startSec >= lowerSec && s.endSec <= atSec,
    );
  }

  function windowTextFor(window: typeof eligibleSegments): string {
    return window.map((s) => `[${s.segmentIndex}] ${s.text}`).join("\n");
  }

  function priorTopicHints(drafts: typeof generatedDrafts, max = 12): string[] {
    // Compact hints: first 10 words of each prior question text,
    // bounded to the last `max` entries so the prompt doesn't balloon
    // on a long plan.
    const recent = drafts.slice(-max);
    return recent.map((d) => {
      const first10 = d.draft.questionText.trim().split(/\s+/).slice(0, 10).join(" ");
      return `• "${first10}${first10.length < d.draft.questionText.length ? "…" : ""}"`;
    });
  }


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

  // Preserve the full checkpoint-group data (LO ids, atSec) and
  // compose it with resolved LO + windowed transcript at prompt
  // time. The FINAL_ASSESSMENT group carries the course-wide LO
  // coverage from the plan.
  const groups: {
    id: string;
    kind: "CHECKPOINT" | "FINAL_ASSESSMENT";
    target: number;
    atSec?: number;
    learningObjectiveIds: readonly string[];
  }[] = [
    ...plan.proposedCheckpointGroups.map((g) => ({
      id: g.id,
      kind: "CHECKPOINT" as const,
      target: g.targetQuestionCount,
      atSec: g.atSec,
      learningObjectiveIds: g.learningObjectiveIds,
    })),
    {
      id: "final",
      kind: "FINAL_ASSESSMENT" as const,
      target: plan.proposedFinalAssessment.targetQuestionCount,
      learningObjectiveIds: plan.proposedFinalAssessment.coverageLearningObjectiveIds,
    },
  ];

  // §D.1 + §Q.4 — per-group FRESH PilotAuthorizationV1. Reused
  // once per Modal call. The authorizationId / requestId / timestamp
  // / fingerprint all change each loop iteration AND on every
  // queue-level retry.
  const env = deps.env ?? process.env;
  const fingerprintSecret = env[ENV_FINGERPRINT_SECRET];
  if (!fingerprintSecret) {
    await recordGenerationFailed(
      {
        runId: claim.runId,
        leaseToken: claim.leaseToken,
        failureCode: "CREDENTIAL_ABSENT",
        failureMessage: `Modal credentials not configured: ${ENV_FINGERPRINT_SECRET}.`,
        retryable: false,
      },
      { prisma: db },
    );
    return { status: "FAILED" };
  }

  for (const g of groups) {
    if (g.target <= 0) continue;
    try {
      // Fresh auth + requestId per Modal call.
      const groupRequestId = `g-${claim.runId}-${g.id}-${randomBytes(12).toString("hex")}`;
      const pilotAuth = issuePilotAuthorization({
        tenantId: claim.clubId,
        courseId: `course:${claim.courseVersionId}`,
        versionId: claim.courseVersionId,
        sourceVideoSha256: plan.sourceVideoSha256,
        resolvedTranscriptBuildId: plan.resolvedTranscriptBuildId,
        approvedGroundingProjectionSha256: claim.planIdentity,
        operation: "GENERATE_DRAFT_QUESTIONS",
        maxRequestedQuestions: g.target,
        pilotRestrictions: {
          publicationProhibited: true,
          employeeAssignmentProhibited: true,
          databaseWritesProhibited: false,
          automaticRetriesProhibited: false,
          excludedSegmentIds: Array.from(WORKER_EXCLUDED_SEGMENT_INDICES).sort((a, b) => a - b),
          scope: `generate:${claim.runId}:${g.id}`,
        },
        ttlSec: 3600,
        issuedBy: `system:training-generation:${claim.clubId}`,
        fingerprintSecret,
      });

      // EP-TRAIN-4Y-N (2026-11-08) — build the per-group prompt + the
      // transcript window the model sees, based on the plan's
      // generation-prompt contract.
      let systemPromptForGroup: string;
      let transcriptForGroup: string;
      let windowSegmentIds: readonly number[] = plan.eligibleSegmentIds;
      if (useCtxV1 && g.kind === "CHECKPOINT" && typeof g.atSec === "number") {
        const window = windowForCheckpoint(g.id, g.atSec);
        windowSegmentIds = window.map((s) => s.segmentIndex);
        const los = g.learningObjectiveIds
          .map((id) => loById.get(id))
          .filter((lo): lo is NonNullable<typeof lo> => lo !== undefined);
        systemPromptForGroup = buildCheckpointSystemPromptCtxV1({
          atSec: g.atSec,
          target: g.target,
          los: los.map((lo) => ({ id: lo.id, title: lo.title })),
          windowSegmentIds,
          videoEndSec,
          priorTopics: priorTopicHints(generatedDrafts),
        });
        transcriptForGroup = window.length > 0 ? windowTextFor(window) : fullTranscriptText;
      } else if (useCtxV1 && g.kind === "FINAL_ASSESSMENT") {
        const los = g.learningObjectiveIds
          .map((id) => loById.get(id))
          .filter((lo): lo is NonNullable<typeof lo> => lo !== undefined);
        systemPromptForGroup = buildFinalSystemPromptCtxV1({
          target: g.target,
          los: los.map((lo) => ({ id: lo.id, title: lo.title })),
          videoEndSec,
          priorTopics: priorTopicHints(generatedDrafts),
        });
        transcriptForGroup = fullTranscriptText;
      } else {
        // Legacy (pre-4Y-N) path — kept behaviourally identical.
        systemPromptForGroup = buildSystemPrompt(g.kind, g.target);
        transcriptForGroup = fullTranscriptText;
      }

      const modalResponse = await callModalGenerate(
        {
          requestId: groupRequestId,
          pilotAuthorization: pilotAuth,
          modelVariant: "qwen-2.5-7b-instruct-awq",
          systemPrompt: systemPromptForGroup,
          transcript: transcriptForGroup,
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
        const citedOk = p.sourceSegmentIds.every((id) => eligible.has(id) && !WORKER_EXCLUDED_SEGMENT_INDICES.has(id));
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
        // groups (checkpoints + final) in this plan. EP-TRAIN-4Y-N:
        // `sourceSegmentIds` participates in the grounded near-dup
        // rule inside `evaluatePair`.
        const priors: QuestionCandidate[] = generatedDrafts.map((gd) => ({
          id: gd.contentHash,
          questionText: gd.draft.questionText,
          options: gd.draft.options,
          explanation: gd.draft.explanation,
          destination: gd.group,
          sourceSegmentIds: gd.draft.sourceSegmentIds,
        }));
        const candidate: QuestionCandidate = {
          id: candidateContentHash,
          questionText: p.questionText,
          options: p.options,
          explanation: p.explanation,
          destination: g.id,
          sourceSegmentIds: p.sourceSegmentIds,
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
      const contractCode =
        err instanceof ModalGenerateClientError ? (err as ModalContractError).code : null;
      const code: GenerationFailureCode = (contractCode as GenerationFailureCode | null) ?? "MODAL_HTTP_ERROR";
      const NON_RETRYABLE: ReadonlySet<string> = new Set([
        "CREDENTIAL_ABSENT",
        "MODAL_HMAC_INVALID",
        "REQUEST_HMAC_INVALID",
        "REQUEST_BODY_INVALID",
        "MODAL_BODY_INVALID",
        "PILOT_AUTH_FINGERPRINT_MISMATCH",
        "PILOT_AUTH_SCHEMA_MISMATCH",
        "PILOT_AUTH_OPERATION_MISMATCH",
        "TENANT_MISMATCH",
        "COURSE_VERSION_MISMATCH",
        "VIDEO_SHA_MISMATCH_AT_BOUNDARY",
        "OPERATION_MISMATCH",
        "UNKNOWN_OPERATION",
        "CONTRACT_VERSION_MISMATCH",
        "ASCII_SCOPE_REQUIRED",
        "RESPONSE_REQUEST_ID_MISMATCH",
        "RESPONSE_OPERATION_MISMATCH",
      ]);
      const retryable = !NON_RETRYABLE.has(code);
      await safeFail(
        db,
        claim,
        code,
        (err as Error)?.message ?? String(err),
        retryable,
      );
      return { status: "FAILED" };
    }
  }

  if (generatedDrafts.length === 0) {
    await safeFail(db, claim, "INSUFFICIENT_EVIDENCE", "No grounded proposals produced.", false);
    return { status: "FAILED" };
  }

  // EP-TRAIN-4Y-P §6 — materialise the TrainingGroundingProjection
  // row BEFORE we persist drafts, so each draft can be bound to it
  // via FK and the real projection sha256 is persisted (rather than
  // the pre-4Y-P planIdentity placeholder). The upsert is idempotent
  // on (clubId, courseVersionId, sha256) so safe on retries.
  //
  // If projection materialisation fails (eg. an environment where the
  // transcript build row is unreachable), we log + fall back to the
  // pre-4Y-P placeholder behaviour so the run still COMPLETES. The
  // reviewer-eligibility gate will push HISTORICAL_EVIDENCE_UNAVAILABLE
  // for such drafts, matching the 4Y-M / 4Y-N baseline — that is the
  // safe-fall-through contract.
  const courseId = await resolveCourseId(db, claim.courseVersionId);
  let materialised: Awaited<ReturnType<typeof materialiseGroundingProjection>> | null = null;
  try {
    materialised = await materialiseGroundingProjection(
      {
        clubId: claim.clubId,
        courseId,
        courseVersionId: claim.courseVersionId,
        plan,
      },
      { prisma: db },
    );
  } catch (err) {
    logger.warn("training.generation.projection_materialise_failed", {
      runId: claim.runId,
      error: (err as Error)?.message ?? String(err),
    });
  }
  const projectionSha = materialised?.projectionSha256 ?? claim.planIdentity;
  const projectionRowId = materialised?.projectionRowId ?? null;

  // Persist drafts. Each draft attaches to the run via generationRunId.
  // We dedup within the run via (clubId, courseVersionId, contentHash)
  // Prisma @@unique. A P2002 here is swallowed as a duplicate skip.
  let persistedCount = 0;
  const persistedDraftIds: string[] = [];
  for (const { draft, contentHash } of generatedDrafts) {
    const canonicalBody = {
      questionType: draft.questionType,
      questionText: draft.questionText,
      options: draft.options.map((o) => ({ text: o.text, isCorrect: o.isCorrect })),
      explanation: draft.explanation,
      sourceSegmentIds: [...draft.sourceSegmentIds],
    };
    try {
      const persisted = await db.trainingQuestionAiDraft.create({
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
          // EP-TRAIN-4Y-P §6 — bind the FK so evidence-reader
          // classifies as `authentic`, not `historical-unavailable`.
          // Nullable: fall-through when projection materialisation
          // failed above (matches pre-4Y-P behaviour for that case).
          ...(projectionRowId ? { groundingProjectionId: projectionRowId } : {}),
          pilotAuthorizationId: "4w-generation",
          pilotAuthorizationFingerprint: claim.planIdentity.slice(0, 32),
          state: "REQUIRES_HUMAN_REVIEW",
          recordVersion: 0,
          generatedAt: new Date(),
        },
        select: { id: true },
      });
      persistedDraftIds.push(persisted.id);
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

  // EP-TRAIN-4Y-P §6 — emit a TrainingQuestionAiValidation row per
  // persisted draft. The reviewer-eligibility gate requires
  // `latestValidation`; without this every modern-pipeline draft
  // stayed VALIDATION_ROW_MISSING and thus unapprovable (proven live
  // in 4Y-O). If projection materialisation failed above, the
  // deterministic validator cannot be run (no grounding object),
  // so we skip this step — drafts remain visible but ineligible,
  // matching pre-4Y-P behaviour.
  if (materialised && projectionRowId) {
    const authorization = synthesizePilotAuthorizationFromRun({
      runId: claim.runId,
      clubId: claim.clubId,
      courseId,
      versionId: claim.courseVersionId,
      plan,
      pilotAuthorizationId: "4w-generation",
      pilotAuthorizationFingerprint: claim.planIdentity.slice(0, 32),
      approvedGroundingProjectionSha256: projectionSha,
    });
    for (const draftId of persistedDraftIds) {
      try {
        await materialiseValidationForDraft(
          {
            draftId,
            clubId: claim.clubId,
            projectionRowId,
            projection: materialised.projection,
            authorization,
          },
          { prisma: db },
        );
      } catch (err) {
        logger.warn("training.generation.validation_persist_failed", {
          runId: claim.runId,
          draftId,
          error: (err as Error)?.message ?? String(err),
        });
      }
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

function formatTimestamp(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function buildSystemPrompt(kind: "CHECKPOINT" | "FINAL_ASSESSMENT", target: number): string {
  // Legacy prompt (pre-4Y-N) — kept for plans that don't declare
  // `generationPromptContract: "ctx-v1"`. Deterministic, stable,
  // identical per group; this was what produced the 32 duplicate
  // checkpoint questions in 4Y-M. New plans use the ctx-v1
  // branches below.
  if (kind === "CHECKPOINT") {
    return `You are a training-content authoring assistant. Produce up to ${target} multiple-choice questions suitable for a mid-video knowledge checkpoint. Cite only the transcript segments provided. Do NOT invent facts. Prefer SINGLE_CHOICE; TRUE_FALSE is acceptable when the source material directly supports a binary claim. Each question MUST cite at least one transcript segment id.`;
  }
  return `You are a training-content authoring assistant. Produce up to ${target} multiple-choice questions suitable for the final course assessment. Cite only the transcript segments provided. Do NOT invent facts. Each question MUST cite at least one transcript segment id.`;
}

/** EP-TRAIN-4Y-N (2026-11-08) — context-aware checkpoint prompt.
 *  Exported for offline fixture tests. */
export function buildCheckpointSystemPromptCtxV1(args: {
  readonly atSec: number;
  readonly target: number;
  readonly los: readonly { readonly id: string; readonly title: string }[];
  readonly windowSegmentIds: readonly number[];
  readonly videoEndSec: number;
  readonly priorTopics: readonly string[];
}): string {
  const atStr = formatTimestamp(args.atSec);
  const totalStr = formatTimestamp(args.videoEndSec);
  const loLines = args.los.length > 0
    ? args.los.map((lo) => `  • ${lo.title}`).join("\n")
    : "  • (none assigned for this checkpoint)";
  const windowStr = args.windowSegmentIds.length > 0
    ? `[${args.windowSegmentIds.join(", ")}]`
    : "(empty)";
  const priorBlock = args.priorTopics.length > 0
    ? `\n7. The following question topics have ALREADY been generated for earlier checkpoints — do NOT ask a question that duplicates or paraphrases any of these:\n${args.priorTopics.join("\n")}`
    : "";
  return `You are a training-content authoring assistant for Spectre, a training platform used by private golf and country clubs.

Produce up to ${args.target} multiple-choice question${args.target === 1 ? "" : "s"} for a mid-video knowledge checkpoint placed at ${atStr} into a ${totalStr} training video.

Checkpoint learning objective${args.los.length === 1 ? "" : "s"}:
${loLines}

Evidence window — the transcript segments shown BEFORE this checkpoint moment, which are the ONLY content the employee has seen so far:
  segment ids: ${windowStr}

Constraints:
1. Assess ONLY material covered in the evidence window. Do NOT ask about anything later in the course that the employee has not yet watched.
2. Each question MUST cite at least one transcript segment id that appears in the evidence window.
3. Prefer SINGLE_CHOICE; TRUE_FALSE is acceptable when the source material directly supports a binary claim.
4. Do NOT invent facts — every answer must be explicitly stated or directly supported by the cited segment(s).
5. Keep the question focused on the LISTED learning objective(s), not peripheral content.
6. Prefer a question that tests APPLICATION or JUDGMENT (what should the employee do?) over bare recall when the source material supports it.${priorBlock}`;
}

/** EP-TRAIN-4Y-N (2026-11-08) — context-aware final-assessment prompt.
 *  Exported for offline fixture tests. */
export function buildFinalSystemPromptCtxV1(args: {
  readonly target: number;
  readonly los: readonly { readonly id: string; readonly title: string }[];
  readonly videoEndSec: number;
  readonly priorTopics: readonly string[];
}): string {
  const totalStr = formatTimestamp(args.videoEndSec);
  const loLines = args.los.length > 0
    ? args.los.map((lo) => `  • ${lo.title}`).join("\n")
    : "  • (none)";
  const priorBlock = args.priorTopics.length > 0
    ? `\n6. The following question topics have ALREADY been generated for earlier checkpoints. You MAY reinforce an important concept ONLY if your question tests a meaningfully different application or decision; do NOT verbatim-restate or paraphrase any of these:\n${args.priorTopics.join("\n")}`
    : "";
  return `You are a training-content authoring assistant for Spectre, a training platform used by private golf and country clubs.

Produce up to ${args.target} multiple-choice question${args.target === 1 ? "" : "s"} for the FINAL assessment of a ${totalStr} training course. Final-assessment questions sit at the END of the course after the employee has watched all content.

Course-level coverage learning objectives:
${loLines}

Constraints:
1. Prioritize important POLICIES, PROCEDURES, and EMPLOYEE DECISIONS the learner must retain after training — not trivia.
2. Each question MUST cite at least one transcript segment id from the full course transcript provided.
3. Prefer SINGLE_CHOICE; TRUE_FALSE is acceptable when the source material directly supports a binary claim. Diverse question types are encouraged across the final-assessment set.
4. Do NOT invent facts — every answer must be explicitly stated or directly supported by the cited segment(s).
5. Prefer questions that test APPLICATION or JUDGMENT (what should the employee do in a situation?) over bare recall.${priorBlock}`;
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
      select: { segmentIndex: true, text: true, startSec: true, endSec: true },
      orderBy: [{ segmentIndex: "asc" }],
    });
    // Decimal → number for the handler's segment-window arithmetic.
    return rows.map(r => ({
      segmentIndex: r.segmentIndex,
      text: r.text,
      startSec: Number(r.startSec),
      endSec: Number(r.endSec),
    }));
  };
}
