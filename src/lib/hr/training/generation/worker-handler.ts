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
// EP-TRAIN-4Y-AA §7 — employee-facing text sanitiser. Applied inside
// the per-group loop below so internal pipeline terminology never
// lands in the DB.
import {
  checkEmployeeFacingText,
  codesForAudit,
} from "../ai-review/question-text-sanitizer";
import {
  normaliseQuestionStem,
  normalisationAuditSummary,
  type NormalisationTransform,
} from "../ai-review/question-text-normaliser";
import {
  issuePilotAuthorization,
  ModalContractError,
  ENV_FINGERPRINT_SECRET,
} from "../modal-shared";
// EP-TRAIN-4Y-Z §3 — per-pilot cumulative spending guard. See the
// module header in pilot-budget-guard.ts for the three-layer spending
// protection model and concurrency protection argument.
import {
  loadPriorPilotCostMicros,
  msToCostMicros,
  preInvocationBudgetGate,
  PILOT_BUDGET_USD_MICROS,
  getPilotBudgetMicros,
} from "./pilot-budget-guard";

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

  // EP-TRAIN-4Y-Z §3 — pilot cumulative spending guard.
  //
  // Load the prior-attempt cost basis BEFORE any Modal invocation
  // this attempt. Scope = (clubId, courseVersionId), covering every
  // earlier run (COMPLETED + FAILED + CANCELLED + QUEUED). A retry
  // sees the true cost of its earlier sibling attempt, not zero.
  // See pilot-budget-guard.ts for the concurrency argument.
  const priorAttemptCostMicros = await loadPriorPilotCostMicros(
    {
      clubId: claim.clubId,
      courseVersionId: claim.courseVersionId,
      excludeRunId: claim.runId,
    },
    { prisma: db },
  );
  // Planned Modal calls this attempt: 1 metadata + 1 per group
  // (checkpoints + final). Metadata may be skipped by the
  // attribution-column guard, but we project worst-case to pre-gate
  // honestly.
  const plannedGroupCount = plan.proposedCheckpointGroups.length + 1;
  const plannedCallsThisAttempt = 1 + plannedGroupCount;

  // EP-TRAIN-4Y-AN §2 — per-pilot budget override. Falls back to the
  // $1 global when no override exists. ALL downstream
  // preInvocationBudgetGate calls thread this same value.
  const pilotBudgetMicros = getPilotBudgetMicros(claim.courseVersionId);
  const gatePreMetadata = preInvocationBudgetGate({
    priorAttemptCostMicros,
    currentAttemptCostMicros: 0,
    callsRemainingThisAttempt: plannedCallsThisAttempt,
    coldBootConsumed: false,
  }, { budgetMicros: pilotBudgetMicros });
  if (!gatePreMetadata.allow) {
    logger.warn("training.generation.worker.pilot_budget_exceeded_pre_metadata", {
      runId: claim.runId,
      clubId: claim.clubId,
      courseVersionId: claim.courseVersionId,
      priorAttemptCostMicros,
      projectedTotalMicros: gatePreMetadata.projectedTotalMicros,
      budgetMicros: pilotBudgetMicros,
    });
    await safeFail(
      db,
      claim,
      "PILOT_BUDGET_EXCEEDED",
      gatePreMetadata.reason ?? "Pilot budget exceeded (pre-metadata gate).",
      false,
      0,
    );
    return { status: "FAILED" };
  }

  // EP-TRAIN-4Y-V §4 — Qwen-sourced course metadata (title +
  // description) runs in the worker because the Modal fingerprint +
  // HMAC secrets are bound here, not on the web app. Fires BEFORE
  // the question-group loop so the manager sees a correct title as
  // soon as the first poll cycle returns after this run completes.
  // Idempotent via the attribution-column guard on TrainingCourse —
  // a retry (or any subsequent generation run on this course) checks
  // the attributed-title snapshot and does nothing if the manager
  // has already edited it since the system wrote it.
  // EP-TRAIN-4Y-Z §3 — `claim` does not carry `courseId` (see
  // GenerationClaimResult in generation-service.ts); the 4Y-V diff
  // referenced `claim.courseId` which does not exist and did not
  // typecheck. Resolve it once from the courseVersion.
  const resolvedCourseId = await resolveCourseId(db, claim.courseVersionId);
  // EP-TRAIN-4Y-AI §3 — suppress the course-metadata path on FA
  // recovery runs. The detection is structural: a recovery plan has
  // zero proposedCheckpointGroups AND a non-empty
  // proposedFinalAssessmentChunks array. Legacy plans (which always
  // carry checkpoint groups OR a single-FA proposedFinalAssessment
  // call) still exercise the metadata call. This gate prevents
  // course.title + course.description + attribution records from
  // being touched during recovery even in the no-op "ai → ai" case
  // that AG's post-fire report flagged.
  const isFinalAssessmentRecoveryShape =
    plan.proposedCheckpointGroups.length === 0 &&
    Array.isArray(plan.proposedFinalAssessmentChunks) &&
    plan.proposedFinalAssessmentChunks.length > 0;
  const metadataResult = isFinalAssessmentRecoveryShape
    ? { inferenceMs: 0, modalCalled: false }
    : await maybeGenerateCourseMetadata({
        db,
        clubId: claim.clubId,
        courseId: resolvedCourseId,
        courseVersionId: claim.courseVersionId,
        sourceVideoSha256: plan.sourceVideoSha256,
        resolvedTranscriptBuildId: plan.resolvedTranscriptBuildId,
        transcriptText: fullTranscriptText,
        runId: claim.runId,
        fetchImpl: deps.fetchImpl,
        env: deps.env,
      });
  if (isFinalAssessmentRecoveryShape) {
    logger.info("training.generation.worker.metadata_suppressed_for_fa_recovery", {
      runId: claim.runId, clubId: claim.clubId, courseVersionId: claim.courseVersionId,
      proposedChunkCount: plan.proposedFinalAssessmentChunks?.length ?? 0,
    });
  }

  // Fold metadata Modal time into the attempt's cumulative cost.
  let coldBootConsumed = metadataResult.modalCalled;
  let totalInferenceMsPreLoop = metadataResult.inferenceMs;

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
    // on a long plan. EP-TRAIN-4Y-AL §2 — unions external (cross-run)
    // priors from `priorQuestionTextsForDedup` with this run's drafts.
    const union: Array<{ questionText: string }> = [
      ...externalPriorHints,
      ...drafts.map((d) => ({ questionText: d.draft.questionText })),
    ];
    const recent = union.slice(-max);
    return recent.map((d) => {
      const first10 = d.questionText.trim().split(/\s+/).slice(0, 10).join(" ");
      return `• "${first10}${first10.length < d.questionText.length ? "…" : ""}"`;
    });
  }
  // Populated below after the plan is parsed, so priorTopicHints can
  // read it. Kept as a module-local hoisted binding (closure capture).
  let externalPriorHints: Array<{ questionText: string }> = [];


  // Iterate plan groups (checkpoints + final).
  const generatedDrafts: {
    group: string;
    kind: "CHECKPOINT" | "FINAL_ASSESSMENT";
    draft: ModalGenerateProposal;
    contentHash: string;
    dedupDecision: DedupDecision;
  }[] = [];

  // EP-TRAIN-4Y-AL §2 — pre-seed cross-run priors from existing FA
  // drafts (when a recovery plan carries `priorQuestionTextsForDedup`).
  // These feed dedup's `evaluateAgainstPriors` AND `priorTopicHints`
  // so Qwen is warned off re-generating existing topics. They are
  // NEVER re-persisted — they live only as synthetic prior candidates.
  const externalPriors: Array<{
    group: string;
    kind: "FINAL_ASSESSMENT";
    draft: ModalGenerateProposal;
    contentHash: string;
    dedupDecision: DedupDecision;
  }> = [];
  if (Array.isArray(plan.priorQuestionTextsForDedup) && plan.priorQuestionTextsForDedup.length > 0) {
    for (let i = 0; i < plan.priorQuestionTextsForDedup.length; i++) {
      const qt = plan.priorQuestionTextsForDedup[i];
      if (typeof qt !== "string" || qt.length === 0) continue;
      externalPriors.push({
        group: `external-prior-${i + 1}`,
        kind: "FINAL_ASSESSMENT",
        draft: {
          questionType: "SINGLE_CHOICE",
          questionText: qt,
          options: [],
          explanation: "",
          sourceSegmentIds: [],
        } as unknown as ModalGenerateProposal,
        contentHash: `external-prior-${i + 1}`,
        dedupDecision: { verdict: "DISTINCT" } as unknown as DedupDecision,
      });
    }
  }
  // Point the closure at the populated list.
  // EP-TRAIN-4Y-AP §3 — if the plan carries a SEPARATE hints list
  // (`priorTopicHintsForPrompt`), use it for the prompt bullet lines
  // ONLY. Worker-side dedup (`externalPriors` above) continues to use
  // `priorQuestionTextsForDedup` in full. This gates the prompt's size
  // without weakening dedup coverage.
  const hintsSource = Array.isArray(plan.priorTopicHintsForPrompt) && plan.priorTopicHintsForPrompt.length > 0
    ? plan.priorTopicHintsForPrompt
    : externalPriors.map((ep) => ep.draft.questionText);
  externalPriorHints = hintsSource.map((qt) => ({ questionText: qt }));
  // Per-candidate dedup decision log for shortfallReasonJson.
  const dedupLog: Array<{
    group: string;
    candidateContentHash: string;
    decision: DedupDecision;
    kept: boolean;
  }> = [];
  // EP-TRAIN-4Y-AA §8 — per-group diagnostic ledger. Written to
  // shortfallReasonJson so future shortfalls are diagnosable without a
  // GPU re-run. Every field is truthful — if Modal returned zero
  // proposals, `proposalCountFromModal` is zero; the three drop
  // counters describe why each unaccepted proposal disappeared.
  const perGroupDiagnostics: Array<{
    group: string;
    kind: "CHECKPOINT" | "FINAL_ASSESSMENT";
    requestedCount: number;
    proposalCountFromModal: number;
    groundingDroppedCount: number;
    groundingDropReasons: Array<{
      proposalIndex: number;
      citedSegmentIds: number[];
      citedOutsideEligible: number[];
      citedExcluded: number[];
    }>;
    sanitizerDroppedCount: number;
    sanitizerDropReasons: Array<{
      proposalIndex: number;
      findingCodes: string;
    }>;
    // EP-TRAIN-4Y-AQ §3 — deterministic normalisation trace. Records
    // every transform applied to a stem BEFORE the sanitiser saw it,
    // so audit can reconstruct the original text + the rule(s) used.
    // Refusals (safety-gate trips) are recorded too, with
    // appliedTransforms empty and refusalReason set. Normalisation
    // NEVER bypasses the sanitiser — it only changes the TEXT the
    // sanitiser then validates.
    normalisationTrace: Array<{
      proposalIndex: number;
      beforeText: string;
      afterText: string;
      appliedTransforms: NormalisationTransform[];
      refusedForSafety: boolean;
      refusalReason?: string;
    }>;
    dedupDroppedCount: number;
    persistedCount: number;
    modalElapsedMs: number;
    modalPromptTokens: number;
    modalOutputTokens: number;
  }> = [];
  let shortfallCount = 0;
  let dedupDropCount = 0;
  // EP-TRAIN-4Y-AA §7 — cumulative sanitiser drop counter, surfaced
  // alongside shortfallCount so the acceptance report reconciles.
  let sanitizerDropCount = 0;
  // EP-TRAIN-4Y-Z §3 — seed with the metadata-call cost so the
  // pilot-budget guard inside the group loop, and the terminal
  // `recordGenerationCompleted`, see a truthful cumulative figure.
  let totalInferenceMs = totalInferenceMsPreLoop;
  let totalPromptTokens = 0;
  let totalOutputTokens = 0;

  // Preserve the full checkpoint-group data (LO ids, atSec) and
  // compose it with resolved LO + windowed transcript at prompt
  // time. The FINAL_ASSESSMENT group carries the course-wide LO
  // coverage from the plan.
  //
  // EP-TRAIN-4Y-AF (2026-11-10) — if the plan carries
  // `proposedFinalAssessmentChunks`, emit one FA group per chunk
  // (each at `targetQuestionCount: ≤3`) instead of a single `"final"`
  // group at target=10. The 4Y-Z pilot proved a single call at
  // target=10 returned ZERO proposals; chunks of ≤3 match the
  // checkpoint call shape that Qwen 2.5 7B AWQ handles reliably.
  const finalAssessmentChunks = Array.isArray(plan.proposedFinalAssessmentChunks)
    ? plan.proposedFinalAssessmentChunks
    : [];
  const faGroups: {
    id: string;
    kind: "FINAL_ASSESSMENT";
    target: number;
    atSec?: number;
    learningObjectiveIds: readonly string[];
  }[] = finalAssessmentChunks.length > 0
    ? finalAssessmentChunks.map((c) => ({
        id: c.id,
        kind: "FINAL_ASSESSMENT" as const,
        target: c.targetQuestionCount,
        learningObjectiveIds: c.coverageLearningObjectiveIds,
      }))
    : [
        {
          id: "final",
          kind: "FINAL_ASSESSMENT" as const,
          target: plan.proposedFinalAssessment.targetQuestionCount,
          learningObjectiveIds: plan.proposedFinalAssessment.coverageLearningObjectiveIds,
        },
      ];
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
    ...faGroups,
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

  // EP-TRAIN-4Y-Z §3 — track Modal calls remaining this attempt so
  // the budget gate can project worst-case cumulative cost before
  // each invocation.
  let remainingGroupCallsThisAttempt = groups.filter((g) => g.target > 0).length;

  for (const g of groups) {
    if (g.target <= 0) continue;
    try {
      // EP-TRAIN-4Y-Z §3 — pilot cumulative budget gate BEFORE any
      // Modal-side work for this group. Projects:
      //   priorCost + currentCost + (remaining * 180s ceiling) +
      //   (0 or 60s cold-boot).
      const gateBeforeGroup = preInvocationBudgetGate({
        priorAttemptCostMicros,
        currentAttemptCostMicros: msToCostMicros(totalInferenceMs),
        callsRemainingThisAttempt: remainingGroupCallsThisAttempt,
        coldBootConsumed,
      }, { budgetMicros: pilotBudgetMicros });
      if (!gateBeforeGroup.allow) {
        logger.warn("training.generation.worker.pilot_budget_exceeded_mid_loop", {
          runId: claim.runId,
          clubId: claim.clubId,
          courseVersionId: claim.courseVersionId,
          groupId: g.id,
          priorAttemptCostMicros,
          currentInferenceMs: totalInferenceMs,
          projectedTotalMicros: gateBeforeGroup.projectedTotalMicros,
          budgetMicros: pilotBudgetMicros,
          remainingGroupCalls: remainingGroupCallsThisAttempt,
        });
        await safeFail(
          db,
          claim,
          "PILOT_BUDGET_EXCEEDED",
          gateBeforeGroup.reason ?? "Pilot budget exceeded (mid-loop gate).",
          false,
          totalInferenceMs,
        );
        return { status: "FAILED" };
      }

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
        // EP-TRAIN-4Y-AH §3 — per-chunk eligible segment ids drive both
        // the prompt's allowed-id enumeration AND the transcript window
        // the model sees. Pre-AH plans (and the legacy single-FA path)
        // have no chunk.eligibleSegmentIds; those fall back to the full
        // filtered transcript + no explicit allowed-id line (AF
        // behaviour).
        let chunkAllowedIds: readonly number[] | undefined;
        const chunkFromPlan = (plan.proposedFinalAssessmentChunks ?? []).find(
          (c) => c.id === g.id,
        );
        if (chunkFromPlan && Array.isArray(chunkFromPlan.eligibleSegmentIds) && chunkFromPlan.eligibleSegmentIds.length > 0) {
          chunkAllowedIds = chunkFromPlan.eligibleSegmentIds;
        }
        // The transcript window FOR THIS CHUNK is the intersection of
        // (eligible segments the worker loaded) with (chunk's allowed
        // ids). Falls back to full transcript when no chunk window.
        let chunkTranscriptText = fullTranscriptText;
        if (chunkAllowedIds && chunkAllowedIds.length > 0) {
          const allowed = new Set<number>(chunkAllowedIds);
          const subset = eligibleSegments.filter((s) => allowed.has(s.segmentIndex));
          if (subset.length > 0) {
            chunkTranscriptText = subset.map((s) => `[${s.segmentIndex}] ${s.text}`).join("\n");
          }
        }
        windowSegmentIds = chunkAllowedIds ?? plan.eligibleSegmentIds;
        systemPromptForGroup = buildFinalSystemPromptCtxV1({
          target: g.target,
          los: los.map((lo) => ({ id: lo.id, title: lo.title })),
          videoEndSec,
          priorTopics: priorTopicHints(generatedDrafts),
          allowedSegmentIds: chunkAllowedIds,
        });
        transcriptForGroup = chunkTranscriptText;
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
      // EP-TRAIN-4Y-Z §3 — call complete; one fewer Modal invocation
      // remains this attempt; cold-boot (if not already fired by the
      // metadata call) is now consumed.
      remainingGroupCallsThisAttempt = Math.max(0, remainingGroupCallsThisAttempt - 1);
      coldBootConsumed = true;

      // Track shortfall if the model returned fewer than target.
      if (modalResponse.proposals.length < g.target) {
        shortfallCount += g.target - modalResponse.proposals.length;
      }

      // EP-TRAIN-4Y-AA §8 — seed the per-group diagnostic row. The
      // counts below are incremented in the proposal loop; the modal
      // counters are set now.
      const diag: (typeof perGroupDiagnostics)[number] = {
        group: g.id,
        kind: g.kind,
        requestedCount: g.target,
        proposalCountFromModal: modalResponse.proposals.length,
        groundingDroppedCount: 0,
        groundingDropReasons: [],
        sanitizerDroppedCount: 0,
        sanitizerDropReasons: [],
        normalisationTrace: [],
        dedupDroppedCount: 0,
        persistedCount: 0,
        modalElapsedMs: modalResponse.elapsedMs.coldBoot + modalResponse.elapsedMs.generate,
        modalPromptTokens: modalResponse.tokenCounts.prompt,
        modalOutputTokens: modalResponse.tokenCounts.output,
      };
      perGroupDiagnostics.push(diag);

      // Light validation: ensure cited segments are inside the
      // plan's eligibleSegmentIds (full grounding-validator is the
      // next layer in; this handler only enforces the plan's
      // boundary).
      const eligible = new Set(plan.eligibleSegmentIds);
      for (let pi = 0; pi < modalResponse.proposals.length; pi++) {
        const p = modalResponse.proposals[pi];
        const citedOutside = p.sourceSegmentIds.filter((id) => !eligible.has(id));
        const citedExcluded = p.sourceSegmentIds.filter((id) => WORKER_EXCLUDED_SEGMENT_INDICES.has(id));
        const citedOk = citedOutside.length === 0 && citedExcluded.length === 0;
        if (!citedOk) {
          // EP-TRAIN-4Y-AA §8 — record WHY this proposal was skipped.
          diag.groundingDroppedCount++;
          diag.groundingDropReasons.push({
            proposalIndex: pi,
            citedSegmentIds: [...p.sourceSegmentIds],
            citedOutsideEligible: citedOutside,
            citedExcluded,
          });
          continue;
        }

        // EP-TRAIN-4Y-AQ §3 — deterministic normalisation stage.
        // Runs BETWEEN structured parse and sanitiser. Only alters
        // the questionText (stem). Only strips unambiguous leading
        // source-reference framing + trailing parenthetical segment
        // references. ANY ambiguous situation (multiple competing
        // leading rules, empty result, lost WH-word, idempotency
        // violation) is a safety-fail — the original text is handed
        // unchanged to the sanitiser. Options, correct-answer,
        // explanation, provenance are NEVER touched.
        const norm = normaliseQuestionStem({ questionText: p.questionText });
        const textForSanitiser = norm.ok ? norm.normalisedText : p.questionText;
        diag.normalisationTrace.push({
          proposalIndex: pi,
          beforeText: norm.originalText.slice(0, 240),
          afterText: norm.normalisedText.slice(0, 240),
          appliedTransforms: [...norm.transforms],
          refusedForSafety: norm.refusedForSafety,
          refusalReason: norm.refusalReason,
        });

        // EP-TRAIN-4Y-AA §7 — sanitiser drop BEFORE dedup. A
        // proposal that passes grounding but carries internal
        // pipeline terminology ("according to the transcript",
        // "Segment IDs: [...]", "[Last Name]", etc.) is discarded
        // so it never reaches persistence.
        //
        // AQ: the sanitiser sees the (potentially) NORMALISED stem,
        // so a proposal whose ONLY sin was a leading "According to
        // the training material, …" or a trailing "(see segment 4)"
        // can now pass. Every other sanitiser rule still fires
        // untouched — options, explanation, mid-sentence refs.
        const san = checkEmployeeFacingText({
          questionText: textForSanitiser,
          options: p.options.map((o) => ({ text: o.text })),
          explanation: p.explanation ?? null,
        });
        if (!san.ok) {
          diag.sanitizerDroppedCount++;
          sanitizerDropCount++;
          diag.sanitizerDropReasons.push({
            proposalIndex: pi,
            findingCodes: codesForAudit(san),
          });
          continue;
        }

        // EP-TRAIN-4Y-AE §4 (2026-11-10) — structural validator at
        // worker-persist. Composes with the 4Y-AA sanitiser above.
        // A proposal whose stem embeds the options block, whose
        // options duplicate each other, whose correct designation is
        // missing/multiple, etc. is dropped here so it NEVER reaches
        // the DB.
        const { checkQuestionStructure } = await import("@/lib/hr/training/ai-review/question-structure-validator");
        const struct = checkQuestionStructure({
          questionText: textForSanitiser,
          options: p.options.map((o) => ({ text: o.text, isCorrect: !!o.isCorrect })),
          explanation: p.explanation ?? null,
        });
        if (!struct.ok) {
          diag.sanitizerDroppedCount++;
          sanitizerDropCount++;
          diag.sanitizerDropReasons.push({
            proposalIndex: pi,
            findingCodes: ["STRUCTURE:" + struct.findings.map((f) => f.code).join(",")].join(""),
          });
          continue;
        }

        // Compute canonical body + content hash for dedup + persist.
        //
        // EP-TRAIN-4Y-AQ §4 — the NORMALISED stem is the one that
        // participates in content-hashing, dedup, and persistence,
        // because that's what the employee will read. Options,
        // correct-answer identity, explanation, sourceSegmentIds —
        // ALL untouched. The audit trail in diag.normalisationTrace
        // preserves the original for forensics.
        const canonicalBody = {
          questionType: p.questionType,
          questionText: textForSanitiser,
          options: p.options.map((o) => ({ text: o.text, isCorrect: o.isCorrect })),
          explanation: p.explanation,
          sourceSegmentIds: [...p.sourceSegmentIds],
        };
        const candidateContentHash = sha256Hex(canonicalise(canonicalBody));

        // Dedup against EVERY previously-kept candidate across all
        // groups (checkpoints + final) in this plan. EP-TRAIN-4Y-N:
        // `sourceSegmentIds` participates in the grounded near-dup
        // rule inside `evaluatePair`.
        // EP-TRAIN-4Y-AL §2 — union the in-run drafts with external
        // priors (cross-run EXISTING FA drafts) so a shortfall recovery
        // dedups against the baseline the review page is already showing.
        const priors: QuestionCandidate[] = [
          ...externalPriors.map((ep) => ({
            id: ep.contentHash,
            questionText: ep.draft.questionText,
            options: ep.draft.options,
            explanation: ep.draft.explanation,
            destination: ep.group,
            sourceSegmentIds: ep.draft.sourceSegmentIds,
          })),
          ...generatedDrafts.map((gd) => ({
            id: gd.contentHash,
            questionText: gd.draft.questionText,
            options: gd.draft.options,
            explanation: gd.draft.explanation,
            destination: gd.group,
            sourceSegmentIds: gd.draft.sourceSegmentIds,
          })),
        ];
        // AQ: dedup also sees the normalised stem so a Qwen proposal
        // that would collide with a prior question under its framed
        // form keeps colliding under its stripped form.
        const candidate: QuestionCandidate = {
          id: candidateContentHash,
          questionText: textForSanitiser,
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
          diag.dedupDroppedCount++;
          continue;
        }

        // AQ: persisted draft body carries the NORMALISED stem.
        const persistedProposal = { ...p, questionText: textForSanitiser };
        generatedDrafts.push({
          group: g.id,
          kind: g.kind,
          draft: persistedProposal,
          contentHash: candidateContentHash,
          dedupDecision: decision,
        });
        diag.persistedCount++;
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
        // EP-TRAIN-4Y-Z §3 — persist whatever Modal time was burned
        // on this attempt so the pilot-budget guard on a retry sees
        // the true prior-attempt cost.
        totalInferenceMs,
      );
      // EP-TRAIN-4Y-W §6 — retry governance.
      //
      // Before 4Y-W, this handler returned `{status: "FAILED"}` on
      // a retryable error. The queue runOne wrapper treats a normal
      // return as "job succeeded" and does NOT schedule a retry. But
      // `safeFail(retryable=true)` + `recordGenerationFailed` have
      // already moved the TrainingQuestionAiGenerationRun to QUEUED,
      // expecting the BackgroundJob to be re-queued with backoff. The
      // two contracts were decoupled: the run would sit in QUEUED
      // forever, no retry would occur, and (worse) no GPU cost would
      // be billed on a retry we never asked for.
      //
      // Fix: throw on retryable errors so the queue's runOne catch
      // block records a JobFailure + reschedules the BackgroundJob
      // with exponential backoff. The retry budget is enforced in
      // BOTH places: BackgroundJob.maxAttempts caps queue retries,
      // and TrainingQuestionAiGenerationRun.maxAttempts caps the
      // Spectre lifecycle. Non-retryable errors still return
      // cleanly below so the BackgroundJob terminates immediately.
      if (retryable) {
        throw new Error(
          `TRAINING_GENERATE_QUESTIONS retryable failure (${code}): ${(err as Error)?.message ?? String(err)}`,
        );
      }
      return { status: "FAILED" };
    }
  }

  if (generatedDrafts.length === 0) {
    // EP-TRAIN-4Y-AH §5 — persist durable diagnostics BEFORE safeFail
    // transitions the row out of RUNNING. The AF slice left
    // shortfallReasonJson NULL on INSUFFICIENT_EVIDENCE, so operators
    // could not reconstruct which chunk returned how many proposals or
    // which filter dropped them. We now write the same v2 shortfall
    // payload as COMPLETED runs. inferenceMs is forwarded via safeFail
    // (worker-handler had been passing it to transport-fail paths; the
    // INSUFFICIENT_EVIDENCE branch now receives it too).
    const insufficientShortfallJson = JSON.stringify({
      schemaVersion: "shortfall-v2",
      targetCount: plan.totalTargetQuestionCount,
      generatedCount: 0,
      shortfall: plan.totalTargetQuestionCount,
      sanitizerDropCount,
      dedupDropCount,
      dedupRulesVersion: DEDUP_RULES_VERSION,
      dedupDecisions: dedupLog,
      perGroupDiagnostics,
      reason: "No grounded proposals produced.",
      failureCode: "INSUFFICIENT_EVIDENCE",
    });
    try {
      await db.trainingQuestionAiGenerationRun.updateMany({
        where: { id: claim.runId, executionStatus: "RUNNING", leaseToken: claim.leaseToken },
        data: {
          shortfallReasonJson: insufficientShortfallJson,
          promptTokenCount: totalPromptTokens,
          outputTokenCount: totalOutputTokens,
        },
      });
    } catch (persistErr) {
      logger.warn("training.generation.worker.insufficient_evidence_shortfall_persist_failed", {
        runId: claim.runId, error: (persistErr as Error)?.message ?? String(persistErr),
      });
    }
    await safeFail(db, claim, "INSUFFICIENT_EVIDENCE", "No grounded proposals produced.", false, totalInferenceMs);
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
  // EP-TRAIN-4Y-Z §3 — reuse the courseId already resolved pre-metadata.
  const courseId = resolvedCourseId;
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
        // EP-TRAIN-4Y-AA §8 — always emit the shortfall JSON when any
        // group ran (`perGroupDiagnostics.length > 0`) so a run with
        // zero FA proposals is diagnosable too. The old code only
        // emitted when shortfall/dedup had entries, which hid the
        // 4Y-Z FA-shortfall root cause.
        shortfallReasonJson: (
          shortfallCount > 0 ||
          dedupDropCount > 0 ||
          dedupLog.length > 0 ||
          sanitizerDropCount > 0 ||
          perGroupDiagnostics.length > 0
        )
          ? JSON.stringify({
              // Bumped — perGroupDiagnostics field added. v1 consumers
              // (destination resolver, existing acceptance reports) read
              // only dedupDecisions and are unaffected.
              schemaVersion: "shortfall-v2",
              targetCount: plan.totalTargetQuestionCount,
              generatedCount: persistedCount,
              shortfall: shortfallCount,
              dedupDropCount,
              // EP-TRAIN-4Y-AA §7 — proposals dropped at the employee-
              // facing text sanitiser (BEFORE dedup, AFTER grounding).
              sanitizerDropCount,
              dedupRulesVersion: DEDUP_RULES_VERSION,
              dedupDecisions: dedupLog,
              // EP-TRAIN-4Y-AA §8 — the per-group diagnostic ledger.
              // One row per group that ran. `proposalCountFromModal`
              // is the exact number of proposals Modal returned;
              // `groundingDropReasons` shows the segment-id mismatch
              // on each ungrounded proposal; `sanitizerDropReasons`
              // surfaces the finding-code bundle; `dedupDroppedCount`
              // + `persistedCount` reconcile against `dedupDecisions`.
              perGroupDiagnostics,
              reason: (
                shortfallCount > 0 && dedupDropCount > 0
                  ? "model returned fewer grounded candidates than target and duplicates dropped"
                  : shortfallCount > 0
                    ? "model returned fewer grounded candidates than target"
                    : dedupDropCount > 0
                      ? "duplicates dropped by dedup pipeline"
                      : sanitizerDropCount > 0
                        ? "proposals dropped by employee-facing text sanitiser"
                        : "candidates flagged for manager review as topic-related"
              ),
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
6. Prefer a question that tests APPLICATION or JUDGMENT (what should the employee do?) over bare recall when the source material supports it.
7. QUESTION STRUCTURE — \`questionText\` is the stem ONLY. Do NOT include answer choices in the stem. Do NOT include "A)" / "B)" / "C)" / "D)" labels, "Correct Answer: …", "Segment IDs: …", or option bodies in the stem. The stem is independently understandable without the options.
8. \`options[].text\` is the answer body ONLY. Do NOT prefix with "A) " / "B) ". Do NOT duplicate the stem. One option has \`isCorrect: true\`; every other option has \`isCorrect: false\`.
9. \`explanation\` is grounded context for WHY the correct option is correct. Do NOT append the explanation to the stem.${priorBlock}`;
}

/** EP-TRAIN-4Y-N (2026-11-08) — context-aware final-assessment prompt.
 *  Exported for offline fixture tests.
 *
 *  EP-TRAIN-4Y-AJ (2026-11-10) — the 4Y-AH slice added an explicit
 *  "Allowed segment ids: [45, 46, …]" enumeration. The 4Y-AI run proved
 *  this TEACHES the model to echo the ids back into questionText
 *  (e.g. "What does segment [45] teach us…?"). The text-leakage
 *  sanitiser then correctly rejected every one of the 7 returned
 *  proposals via EXPLICIT_SEGMENT_ID_REFERENCE.
 *
 *  AJ repair:
 *   - The prompt NO LONGER enumerates permitted ids in natural language.
 *   - The prompt frames the `[N]` prefix on every transcript line as
 *     an internal "reference tag" used ONLY for the structured
 *     `sourceSegmentIds` field — NOT for employee-facing text.
 *   - The prompt lists an explicit "forbidden mentions" set so Qwen
 *     avoids the phrases that trip the sanitiser.
 *   - `sourceSegmentIds` size is bounded (≤ 3 per question) to keep
 *     the structured output tractable and reduce fa-1's token budget
 *     pressure (see 4Y-AI §3).
 *   - The worker-side grounding validator CONTINUES to reject cites
 *     outside the permitted set; `allowedSegmentIds` therefore remains
 *     a soft worker-side signal, NOT a prompt enumeration.
 *   - If `allowedSegmentIds` is provided it is used ONLY to pass a
 *     terse "evidence count" line (e.g. "27 evidence items available")
 *     so the model sizes its citations sensibly. The actual numbers
 *     are NEVER written to the prompt text. */
export function buildFinalSystemPromptCtxV1(args: {
  readonly target: number;
  readonly los: readonly { readonly id: string; readonly title: string }[];
  readonly videoEndSec: number;
  readonly priorTopics: readonly string[];
  /** EP-TRAIN-4Y-AJ §2 — kept as a soft signal for the "evidence count"
   *  line only. Qwen is NOT shown the integer list in the prompt;
   *  worker grounding still enforces the canonical set. */
  readonly allowedSegmentIds?: readonly number[];
}): string {
  const totalStr = formatTimestamp(args.videoEndSec);
  const loLines = args.los.length > 0
    ? args.los.map((lo) => `  • ${lo.title}`).join("\n")
    : "  • (none)";
  const priorBlock = args.priorTopics.length > 0
    ? `\n10. The following question topics have ALREADY been generated for earlier checkpoints. You MAY reinforce an important concept ONLY if your question tests a meaningfully different application or decision; do NOT verbatim-restate or paraphrase any of these:\n${args.priorTopics.join("\n")}`
    : "";
  const evidenceCount =
    Array.isArray(args.allowedSegmentIds) && args.allowedSegmentIds.length > 0
      ? args.allowedSegmentIds.length
      : null;
  const evidenceLine = evidenceCount !== null
    ? `\n\nEvidence passages available: ${evidenceCount}. Each passage is shown to you in the Transcript below, prefixed by a bracketed reference tag like [NN]. These tags are INTERNAL METADATA for the \`sourceSegmentIds\` JSON field ONLY.`
    : "";
  return `You are a training-content authoring assistant for Spectre, a training platform used by private golf and country clubs.

Produce up to ${args.target} multiple-choice question${args.target === 1 ? "" : "s"} for the FINAL assessment of a ${totalStr} training course. Final-assessment questions sit at the END of the course after the employee has watched all content.

Course-level coverage learning objectives:
${loLines}${evidenceLine}

Constraints:
1. Prioritize important POLICIES, PROCEDURES, and EMPLOYEE DECISIONS the learner must retain after training — not trivia.
2. Ground every question in content from the Transcript passages shown below. Put the bracketed reference tag(s) of each supporting passage into \`sourceSegmentIds\` ONLY. Cite 1-3 tags per question; do NOT list the whole passage set.
3. Prefer SINGLE_CHOICE; TRUE_FALSE is acceptable when the source material directly supports a binary claim. Diverse question types are encouraged across the final-assessment set.
4. Do NOT invent facts — every answer must be explicitly stated or directly supported by the cited passage(s).
5. Prefer questions that test APPLICATION or JUDGMENT (what should the employee do in a situation?) over bare recall.
6. EMPLOYEE-FACING TEXT PURITY — \`questionText\`, every \`options[].text\`, and \`explanation\` are read by employees. They MUST NOT contain the words "segment", "segments", "transcript", "passage id", "source", "reference", bracketed numbers like "[12]" / "[12, 13]", or any digit used as a provenance reference. They MUST NOT begin with or contain the phrases "According to the transcript", "According to the training", "According to the training material", "According to the course content", "According to the course", "According to the material", "According to the presentation", "Per the transcript", "Per the training", "As stated in the video", "As stated in the training", "Based on the presentation", "Based on the training", "Based on the course", or any similar pointer that cites, quotes or refers to the source document. The question stem must be answerable by someone who watched the video but is tested on retention — it must NEVER mention how the information was conveyed. Phrase every sentence as if you had learned the content yourself; the employee already knows the context.
7. QUESTION STRUCTURE — \`questionText\` is the stem ONLY. Do NOT include answer choices in the stem. Do NOT include "A)" / "B)" / "C)" / "D)" labels, "Correct Answer: …", or option bodies in the stem. The stem is independently understandable without the options.
8. \`options[].text\` is the answer body ONLY. Do NOT prefix with "A) " / "B) ". Do NOT duplicate the stem. One option has \`isCorrect: true\`; every other option has \`isCorrect: false\`.
9. \`explanation\` is grounded context for WHY the correct option is correct. Do NOT append the explanation to the stem. Phrase it as a short teaching note — not as a citation.${priorBlock}`;
}

async function safeFail(
  db: PrismaClient,
  claim: { runId: string; leaseToken: string },
  code: GenerationFailureCode,
  message: string,
  retryable: boolean,
  /** EP-TRAIN-4Y-Z §3 — accumulated Modal inference time for this
   *  attempt BEFORE the failure. Omit if no Modal call has executed
   *  yet (e.g. budget-gate refusal before any invocation). */
  inferenceMs?: number,
): Promise<void> {
  try {
    await recordGenerationFailed(
      {
        runId: claim.runId,
        leaseToken: claim.leaseToken,
        failureCode: code,
        failureMessage: message,
        retryable,
        inferenceMs,
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

// EP-TRAIN-4Y-V §4 — Qwen-sourced course metadata, worker-side.
//
// Called before the question-group loop. Guard order:
//   1. Load the course row. Bail if the attribution snapshot shows a
//      manager edit since the last system write (same OR-semantics as
//      /generate-metadata's HTTP guard).
//   2. Call `callQwenForCourseMetadata` with a specialised prompt +
//      maxQuestions=1. Reuses the existing generate app — no Modal
//      re-deploy.
//   3. Write title + description + code + attribution snapshot in a
//      single `trainingCourse.update`. Retry up to 3 times on P2002
//      (unique-code collision) with a fresh random suffix.
//   4. Record Modal metrics on the run row (modalElapsedMsTotal gets
//      added to the run's inferenceMs so cost tracking is honest).
//
// Fall-through on failure: a Qwen error does NOT fail the whole
// generation run — the questions still get generated and the manager
// gets to see them. The audit log + run metrics show the metadata
// attempt was tried; the deterministic path (via /generate-metadata)
// will still populate the course when the manager polls.
interface MetadataCallResult {
  /** Modal inference time charged by the metadata call this attempt
   *  (cold-boot + generate). Zero if skipped because the course was
   *  already attributed to a manager edit, or if the call failed
   *  before Modal returned metrics. */
  readonly inferenceMs: number;
  /** Did we make a Modal call at all this attempt? Used by the
   *  pilot-budget guard to decide whether cold-boot has been charged. */
  readonly modalCalled: boolean;
}

async function maybeGenerateCourseMetadata(args: {
  db: PrismaClient;
  clubId: string;
  courseId: string;
  courseVersionId: string;
  sourceVideoSha256: string;
  resolvedTranscriptBuildId: string;
  transcriptText: string;
  runId: string;
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
}): Promise<MetadataCallResult> {
  const PROVISIONAL_TITLE = "Untitled training course";
  const PROVISIONAL_CODE_PREFIX = "AUTO-DRAFT";
  try {
    const course = await args.db.trainingCourse.findUnique({
      where: { id: args.courseId },
      select: {
        id: true,
        code: true,
        title: true,
        clubId: true,
        club: { select: { name: true } },
        aiMetadataAttributionAt: true,
        aiMetadataAttributionSource: true,
        aiMetadataAttributedTitle: true,
      },
    });
    if (!course) return { inferenceMs: 0, modalCalled: false };
    // EP-TRAIN-4Y-AD §4+§6 (2026-11-10) — consult the shared
    // provenance helper so the worker and the deterministic HTTP
    // fallback apply the same rules. For the "ai" proposed source
    // this allows writes over provisional / deterministic / earlier
    // "ai" (retry refresh) and refuses writes over "manager" — which
    // protects a founder edit even when a background retry fires.
    const { evaluateMetadataWrite } = await import("@/lib/hr/training/ai-metadata/metadata-provenance");
    const writeDecision = evaluateMetadataWrite({
      currentSnapshot: {
        title: course.title,
        code: course.code,
        aiMetadataAttributionAt: course.aiMetadataAttributionAt,
        aiMetadataAttributionSource: course.aiMetadataAttributionSource,
        aiMetadataAttributedTitle: course.aiMetadataAttributedTitle,
      },
      proposedSource: "ai",
    });
    if (!writeDecision.allow) {
      logger.info("training.generation.worker.metadata.skipped_finalised", {
        courseId: args.courseId,
        courseVersionId: args.courseVersionId,
        reasonCode: writeDecision.reasonCode,
        currentSource: writeDecision.currentSource,
      });
      return { inferenceMs: 0, modalCalled: false };
    }

    // EP-TRAIN-4Y-X §4 (2026-11-09) — swap to the dedicated
    // `spectre.training.metadata.v1` client. Replaces the 4Y-V
    // `callQwenForCourseMetadata` which repurposed the question-
    // generation schema. The new client speaks a real `{title,
    // description, sourceSegmentIds}` contract and verifies the
    // response HMAC on both success + error paths. Requires the
    // Modal-side `/metadata` route (deployed in Batch C).
    const { callModalMetadata } = await import(
      "@/lib/hr/training/ai-metadata/metadata-modal-client"
    );
    const { issuePilotAuthorization, ENV_FINGERPRINT_SECRET } = await import(
      "@/lib/hr/training/modal-shared"
    );
    const { createHash } = await import("node:crypto");
    const env = args.env ?? process.env;
    const fingerprintSecret = env[ENV_FINGERPRINT_SECRET];
    if (!fingerprintSecret) {
      throw new Error(`[worker-metadata] missing ${ENV_FINGERPRINT_SECRET}`);
    }
    const pilotAuth = issuePilotAuthorization({
      tenantId: args.clubId,
      courseId: `course:${args.courseId}`,
      versionId: args.courseVersionId,
      sourceVideoSha256: args.sourceVideoSha256,
      resolvedTranscriptBuildId: args.resolvedTranscriptBuildId,
      approvedGroundingProjectionSha256: createHash("sha256")
        .update(`metadata:${args.resolvedTranscriptBuildId}`)
        .digest("hex"),
      operation: "GENERATE_DRAFT_QUESTIONS",
      maxRequestedQuestions: 1,
      pilotRestrictions: {
        publicationProhibited: true,
        employeeAssignmentProhibited: true,
        databaseWritesProhibited: false,
        automaticRetriesProhibited: true,
        excludedSegmentIds: [],
        scope: `metadata:${args.courseVersionId}`,
      },
      ttlSec: 3600,
      issuedBy: `system:training-metadata:${args.clubId}`,
      fingerprintSecret,
    });
    const r = await callModalMetadata(
      {
        pilotAuthorization: pilotAuth,
        systemPrompt: buildMetadataSystemPromptForWorker(course.club?.name),
        transcript: args.transcriptText,
        clubName: course.club?.name,
      },
      { fetchImpl: args.fetchImpl, env: args.env },
    );
    const modalInferenceMs =
      (r.elapsedMs?.coldBoot ?? 0) + (r.elapsedMs?.generate ?? 0);

    // EP-TRAIN-4Y-AD §5 (2026-11-10) — validate the Qwen output
    // before persisting. If the model returned a title that looks
    // like a transcript fragment, or a description that opens with
    // "Hello everyone, welcome to …" (the Silver Springs transcript's
    // own opening), REFUSE the write. The directive explicitly bans
    // labelling transcript extraction as AI metadata.
    const { validateProposedAiMetadata } = await import("@/lib/hr/training/ai-metadata/metadata-provenance");
    const validation = validateProposedAiMetadata({
      title: r.title,
      description: r.description,
    });
    if (!validation.ok) {
      logger.warn("training.generation.worker.metadata.rejected_by_validator", {
        courseId: args.courseId,
        courseVersionId: args.courseVersionId,
        runId: args.runId,
        titleFirst60: r.title.slice(0, 60),
        findings: validation.findings.map((f) => f.code),
      });
      return { inferenceMs: modalInferenceMs, modalCalled: true };
    }

    const { randomBytes } = await import("node:crypto");
    const codeSuffix = randomBytes(3).toString("hex").toUpperCase();
    let code = deriveMetadataCode(r.title, codeSuffix);
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await args.db.trainingCourse.update({
          where: { id: args.courseId },
          data: {
            title: r.title,
            description: r.description,
            code,
            aiMetadataAttributionAt: new Date(),
            aiMetadataAttributionRunId: args.runId,
            aiMetadataAttributionSource: "ai",
            aiMetadataAttributedTitle: r.title,
          },
        });
        logger.info("training.generation.worker.metadata.applied", {
          courseId: args.courseId,
          courseVersionId: args.courseVersionId,
          runId: args.runId,
          titleFirst60: r.title.slice(0, 60),
          modalRequestId: r.requestId,
          modalElapsedMsTotal: modalInferenceMs,
          modalPromptTokens: r.tokenCounts?.prompt ?? 0,
          modalOutputTokens: r.tokenCounts?.output ?? 0,
        });
        return { inferenceMs: modalInferenceMs, modalCalled: true };
      } catch (err) {
        if ((err as { code?: string })?.code === "P2002" && attempt < 2) {
          code = `${code.slice(0, 50)}_${randomBytes(3).toString("hex").toUpperCase()}`.slice(0, 64);
          continue;
        }
        throw err;
      }
    }
    // The 3-attempt P2002 loop exited without a successful update
    // (every suffix collided). The Modal call did complete though —
    // its elapsedMs still contributes to cumulative pilot cost.
    return { inferenceMs: modalInferenceMs, modalCalled: true };
  } catch (err) {
    logger.error("training.generation.worker.metadata.failed", {
      courseId: args.courseId,
      courseVersionId: args.courseVersionId,
      runId: args.runId,
      error: (err as Error)?.message ?? String(err),
    });
    // Non-fatal — the question-generation loop continues. The
    // deterministic /generate-metadata HTTP route serves as the
    // fallback path for the title; it fires on every browser poll
    // once the transcript is COMPLETED. The Modal client surfaces
    // elapsedMs only on success — on failure we conservatively assume
    // some CPU + possibly cold-boot time was consumed; for budget
    // purposes we treat `modalCalled=true` (cold-boot may have fired)
    // but inferenceMs=0 because we have no truthful metric. The
    // guard's cold-boot ceiling absorbs this uncertainty.
    return { inferenceMs: 0, modalCalled: true };
  }
}

/** EP-TRAIN-4Y-X §4 — system prompt for the dedicated metadata
 *  endpoint. Instructs Qwen to emit a REAL `{title, description,
 *  sourceSegmentIds}` object (not a repurposed proposal). The
 *  Modal-side schema enforcer (`JsonSchemaParser` on
 *  `generate_metadata`) rejects anything that doesn't conform. */
function buildMetadataSystemPromptForWorker(clubName?: string): string {
  const who = clubName
    ? `the ${clubName} team — a private country club`
    : "a private country-club team";
  return [
    `You are helping prepare a staff training course for ${who}.`,
    "",
    "The user will provide a flat transcript of the course video.",
    "You must emit EXACTLY one JSON object with these fields:",
    "- title: concise, professional, Title Case, 3–10 words, 10–80 chars.",
    "  No leading verb like \"Welcome to\" or \"Introduction to\".",
    "  Represent the actual subject of the course (e.g. \"Workplace",
    "  Safety Orientation\").",
    "- description: 1–3 complete sentences, 120–320 chars. Describe",
    "  the key learning objectives. Executive, not promotional.",
    "- sourceSegmentIds: an array of up to 5 integer segment indices",
    "  from the transcript that most strongly anchor the title.",
    "",
    "Return ONLY valid JSON. No commentary, no markdown fences.",
  ].join("\n");
}

/** Derive a stable code from the title. Same shape as the deterministic
 *  path's helper — keeps the course-code shape consistent whether
 *  metadata comes from Qwen or extractive summarisation. */
function deriveMetadataCode(title: string, suffix: string): string {
  const base = title
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
  const safeBase = base.length >= 2 ? base : "COURSE";
  return `${safeBase}_${suffix}`.slice(0, 64);
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
