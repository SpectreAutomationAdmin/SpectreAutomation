// EP-TRAIN-6D-4W (2026-11-06) — Course-level assessment plan.
//
// The "plan" is a versioned, validated JSON document that captures
// the generation intent for a (courseVersion, transcriptBuild) pair
// BEFORE any Modal call runs. The plan is persisted on the
// TrainingQuestionAiGenerationRun row (assessmentPlanJson column)
// and is immutable once the run leaves REQUESTED state.
//
// 4W deliberately keeps automatic topic-boundary detection
// rudimentary (segment-count heuristic + even distribution). The
// sophisticated placement + semantic dedup live in 4X.

import { createHash } from "node:crypto";
import { canonicalise } from "../ai-review/content-hash";

export const ASSESSMENT_PLAN_SCHEMA_VERSION = "training-assessment-plan-v1" as const;

/** Plan-level excluded segments. Enforced by `validateAssessmentPlan`
 *  AND consumed by `buildBaselineAssessmentPlan` /
 *  `buildTopicAwareAssessmentPlan` when NEW plans are built.
 *
 *  Any segment in this set is rejected from `eligibleSegmentIds` at
 *  plan-creation + plan-validation time. Changing this set invalidates
 *  pre-existing assessment plans whose `eligibleSegmentIds` contain
 *  the newly-added indices, so the set is kept stable (16, 17) across
 *  4Y-M. New grounding-hygiene exclusions live in
 *  `RUNTIME_EXCLUDED_SEGMENT_INDICES` (worker-handler.ts) which is
 *  applied as a second-defence filter at prompt + proposal time
 *  without re-validating stored plans. */
export const EXCLUDED_SEGMENT_INDICES: ReadonlySet<number> = Object.freeze(new Set([16, 17]));

export interface AssessmentPlanLearningObjective {
  readonly id: string;
  readonly title: string;
  readonly segmentIds: readonly number[];
}

export interface AssessmentPlanTopicBoundary {
  readonly atSec: number;
  readonly rationale: string;
}

export interface AssessmentPlanCheckpointGroup {
  readonly id: string;
  readonly atSec: number;
  readonly learningObjectiveIds: readonly string[];
  readonly targetQuestionCount: number;
}

export interface AssessmentPlanFinalAssessment {
  readonly targetQuestionCount: number;
  readonly coverageLearningObjectiveIds: readonly string[];
}

// EP-TRAIN-4Y-AF (2026-11-10) — Chunked final-assessment generation.
// The 4Y-Z pilot proved a single Modal call at `maxQuestions: 10` with
// 54 learning objectives returned ZERO proposals. Splitting the FA ask
// into N chunks of ≤3 each matches the checkpoint-group call shape that
// Qwen 2.5 7B AWQ handles reliably. The sum of each chunk's
// targetQuestionCount MUST equal `proposedFinalAssessment.targetQuestionCount`.
// When `proposedFinalAssessmentChunks` is absent the worker uses the
// legacy single-call FA path; existing plans are unchanged.
//
// EP-TRAIN-4Y-AH (2026-11-10) — `eligibleSegmentIds` added as the
// canonical per-chunk evidence set. The 4Y-AG recovery failed because
// coverage planning, prompt construction and grounding validation
// consulted DIFFERENT eligibility sets; Qwen cited ids the worker then
// rejected. Every seam now reads `chunk.eligibleSegmentIds`:
//   - coverage planning builds it from the LO slice ∩ permitted ids
//   - prompt construction enumerates it as "Allowed segment ids: [...]"
//   - transcript window is built from exactly these ids
//   - grounding validation stays as belt-and-suspenders
// `focusTopicSummary` additionally surfaces LO-title context for
// operator-facing preflight (meaningful content, not transcript scraps).
export interface AssessmentPlanFinalAssessmentChunk {
  readonly id: string; // "fa-1", "fa-2", …
  readonly targetQuestionCount: number;
  readonly coverageLearningObjectiveIds: readonly string[];
  readonly focusTopicLabel: string;
  /** EP-TRAIN-4Y-AH §3 — the canonical evidence set for THIS chunk.
   *  Intersection of (plan.eligibleSegmentIds, this chunk's LO
   *  segmentIds, complement of worker-excluded ids). The worker uses
   *  this list verbatim as the prompt's allowed-id enumeration and as
   *  the transcript-window source. Optional for backwards compat with
   *  AF-era plans; the worker falls back to the LO slice's segmentIds
   *  when absent. */
  readonly eligibleSegmentIds?: readonly number[];
  /** EP-TRAIN-4Y-AH §4 — human-readable summary of what this chunk
   *  covers. Used by the preflight response (operator visibility) and
   *  NOT fed back to the model. Derived offline from LO titles. */
  readonly focusTopicSummary?: string;
}

/** EP-TRAIN-4Y-N (2026-11-08) — worker-side prompt construction
 *  contract this plan was BUILT to drive. The value is participating
 *  in `planIdentityHash` (via canonicalise of the whole plan), so
 *  bumping it produces a new plan hash and allows a new generation
 *  run against the same (clubId, courseVersionId, transcriptBuild).
 *
 *  - omitted / undefined (legacy / pre-4Y-N)       → worker uses
 *    the flat per-group prompt (`buildSystemPrompt(kind, target)`);
 *    this is what the 4Y-M pilot ran on.
 *  - "ctx-v1"                                      → worker builds
 *    a per-checkpoint context-aware prompt (LO title + checkpoint
 *    timestamp + windowed transcript + prior-topic-avoidance hints)
 *    and a separate course-level final-assessment prompt. */
export type GenerationPromptContract = "ctx-v1";

export interface AssessmentPlanV1 {
  readonly schemaVersion: typeof ASSESSMENT_PLAN_SCHEMA_VERSION;
  readonly courseVersionId: string;
  readonly resolvedTranscriptBuildId: string;
  readonly sourceVideoSha256: string;
  readonly learningObjectives: readonly AssessmentPlanLearningObjective[];
  readonly topicBoundaries: readonly AssessmentPlanTopicBoundary[];
  readonly eligibleSegmentIds: readonly number[];
  readonly proposedCheckpointGroups: readonly AssessmentPlanCheckpointGroup[];
  readonly proposedFinalAssessment: AssessmentPlanFinalAssessment;
  // EP-TRAIN-4Y-AF — optional chunked FA generation.
  readonly proposedFinalAssessmentChunks?: readonly AssessmentPlanFinalAssessmentChunk[];
  readonly totalTargetQuestionCount: number;
  readonly sourceEvidenceRequirements: {
    readonly mustCiteAtLeastOneSegmentPerQuestion: true;
    readonly excludedSegmentIndices: readonly number[];
  };
  readonly generatedAt: string;
  readonly generatedByUserId: string | null;
  readonly generationPromptContract?: GenerationPromptContract;
}

// ─── Validator ──────────────────────────────────────────────────────

export interface PlanValidationIssue {
  readonly path: string;
  readonly message: string;
}

export class AssessmentPlanInvalidError extends Error {
  readonly issues: readonly PlanValidationIssue[];
  constructor(issues: readonly PlanValidationIssue[]) {
    super(`Assessment plan is invalid: ${issues.map((i) => i.path).join(", ")}`);
    this.name = "AssessmentPlanInvalidError";
    this.issues = issues;
  }
}

/** Server-side validator. Rejects a plan that doesn't satisfy the
 *  §4 contract. The service-layer calls this BEFORE persisting
 *  `assessmentPlanJson` on the run. */
export function validateAssessmentPlan(raw: unknown): AssessmentPlanV1 {
  const issues: PlanValidationIssue[] = [];
  function fail(path: string, message: string): never {
    issues.push({ path, message });
    throw new AssessmentPlanInvalidError(issues);
  }
  function push(path: string, message: string): void {
    issues.push({ path, message });
  }
  if (typeof raw !== "object" || raw === null) {
    fail("_root", "plan must be an object");
  }
  const r = raw as Record<string, unknown>;
  if (r.schemaVersion !== ASSESSMENT_PLAN_SCHEMA_VERSION) {
    push("schemaVersion", `expected ${ASSESSMENT_PLAN_SCHEMA_VERSION}`);
  }
  if (typeof r.courseVersionId !== "string" || r.courseVersionId.length === 0) {
    push("courseVersionId", "required");
  }
  if (typeof r.resolvedTranscriptBuildId !== "string" || !/^[0-9a-f]{64}$/.test(r.resolvedTranscriptBuildId)) {
    push("resolvedTranscriptBuildId", "64-char lowercase hex required");
  }
  if (typeof r.sourceVideoSha256 !== "string" || !/^[0-9a-f]{64}$/.test(r.sourceVideoSha256)) {
    push("sourceVideoSha256", "64-char lowercase hex required");
  }
  if (!Array.isArray(r.learningObjectives)) {
    push("learningObjectives", "must be an array");
  }
  if (!Array.isArray(r.eligibleSegmentIds)) {
    push("eligibleSegmentIds", "must be an array");
  }
  if (!Array.isArray(r.proposedCheckpointGroups)) {
    push("proposedCheckpointGroups", "must be an array");
  }
  if (typeof r.proposedFinalAssessment !== "object" || r.proposedFinalAssessment === null) {
    push("proposedFinalAssessment", "must be an object");
  }
  if (typeof r.totalTargetQuestionCount !== "number" || r.totalTargetQuestionCount < 0 || r.totalTargetQuestionCount > 100) {
    push("totalTargetQuestionCount", "0-100");
  }
  if (typeof r.generatedAt !== "string") {
    push("generatedAt", "ISO string required");
  }

  // Cross-field: eligibleSegmentIds must not include excluded indices.
  if (Array.isArray(r.eligibleSegmentIds)) {
    for (const i of r.eligibleSegmentIds as unknown[]) {
      if (typeof i !== "number" || !Number.isInteger(i) || i < 0) {
        push("eligibleSegmentIds", `invalid index ${JSON.stringify(i)}`);
        break;
      }
      if (EXCLUDED_SEGMENT_INDICES.has(i)) {
        push("eligibleSegmentIds", `segment ${i} is permanently excluded`);
      }
    }
  }

  // Cross-field: checkpoint groups' LO ids resolve to a defined LO.
  if (Array.isArray(r.proposedCheckpointGroups) && Array.isArray(r.learningObjectives)) {
    const loIds = new Set<string>();
    for (const lo of r.learningObjectives as unknown[]) {
      if (typeof lo === "object" && lo !== null && typeof (lo as Record<string, unknown>).id === "string") {
        loIds.add((lo as { id: string }).id);
      }
    }
    for (const cg of r.proposedCheckpointGroups as unknown[]) {
      if (typeof cg !== "object" || cg === null) continue;
      const refs = (cg as Record<string, unknown>).learningObjectiveIds;
      if (!Array.isArray(refs)) continue;
      for (const id of refs as unknown[]) {
        if (typeof id === "string" && !loIds.has(id)) {
          push("proposedCheckpointGroups", `references unknown learning objective ${id}`);
        }
      }
    }
  }

  // Cross-field: target counts sum.
  if (Array.isArray(r.proposedCheckpointGroups) && typeof r.proposedFinalAssessment === "object" && r.proposedFinalAssessment !== null) {
    let sum = 0;
    for (const cg of r.proposedCheckpointGroups as unknown[]) {
      if (typeof cg === "object" && cg !== null) {
        const t = (cg as Record<string, unknown>).targetQuestionCount;
        if (typeof t === "number") sum += t;
      }
    }
    const fa = (r.proposedFinalAssessment as Record<string, unknown>).targetQuestionCount;
    if (typeof fa === "number") sum += fa;
    if (typeof r.totalTargetQuestionCount === "number" && sum !== r.totalTargetQuestionCount) {
      push("totalTargetQuestionCount", `checkpoint + final counts (${sum}) must equal totalTargetQuestionCount (${r.totalTargetQuestionCount})`);
    }
  }

  // EP-TRAIN-4Y-AF — if `proposedFinalAssessmentChunks` is present,
  // its targetSum must equal proposedFinalAssessment.targetQuestionCount
  // AND every chunk's coverageLearningObjectiveIds must resolve to a
  // defined LO. Each chunk's targetQuestionCount must be 1..3 (the
  // observed-safe Modal call size for Qwen 2.5 7B AWQ at FA scope).
  if (Array.isArray(r.proposedFinalAssessmentChunks) && (r.proposedFinalAssessmentChunks as unknown[]).length > 0) {
    const chunks = r.proposedFinalAssessmentChunks as unknown[];
    const loIds = new Set<string>();
    if (Array.isArray(r.learningObjectives)) {
      for (const lo of r.learningObjectives as unknown[]) {
        if (typeof lo === "object" && lo !== null && typeof (lo as Record<string, unknown>).id === "string") {
          loIds.add((lo as { id: string }).id);
        }
      }
    }
    let chunkSum = 0;
    const seenChunkIds = new Set<string>();
    for (const c of chunks) {
      if (typeof c !== "object" || c === null) {
        push("proposedFinalAssessmentChunks", "every chunk must be an object");
        continue;
      }
      const ch = c as Record<string, unknown>;
      if (typeof ch.id !== "string" || ch.id.length === 0) {
        push("proposedFinalAssessmentChunks.id", "non-empty string required");
        continue;
      }
      if (seenChunkIds.has(ch.id)) {
        push("proposedFinalAssessmentChunks.id", `duplicate id ${ch.id}`);
      }
      seenChunkIds.add(ch.id);
      if (typeof ch.targetQuestionCount !== "number" || ch.targetQuestionCount < 1 || ch.targetQuestionCount > 3) {
        push("proposedFinalAssessmentChunks.targetQuestionCount", `chunk ${ch.id} must have target 1..3`);
      } else {
        chunkSum += ch.targetQuestionCount;
      }
      if (!Array.isArray(ch.coverageLearningObjectiveIds)) {
        push("proposedFinalAssessmentChunks.coverageLearningObjectiveIds", `chunk ${ch.id} must have array`);
      } else {
        for (const id of ch.coverageLearningObjectiveIds as unknown[]) {
          if (typeof id === "string" && !loIds.has(id)) {
            push("proposedFinalAssessmentChunks.coverageLearningObjectiveIds", `chunk ${ch.id} references unknown LO ${id}`);
          }
        }
      }
      if (typeof ch.focusTopicLabel !== "string") {
        push("proposedFinalAssessmentChunks.focusTopicLabel", `chunk ${ch.id} must be a string`);
      }
    }
    const fa = r.proposedFinalAssessment as Record<string, unknown> | undefined;
    const faTarget = fa && typeof fa.targetQuestionCount === "number" ? fa.targetQuestionCount : null;
    if (faTarget !== null && chunkSum !== faTarget) {
      push(
        "proposedFinalAssessmentChunks",
        `chunks' targetQuestionCount sum (${chunkSum}) must equal proposedFinalAssessment.targetQuestionCount (${faTarget})`,
      );
    }
  }

  // sourceEvidenceRequirements must honour the exclusion.
  const ser = r.sourceEvidenceRequirements as Record<string, unknown> | undefined;
  if (!ser || ser.mustCiteAtLeastOneSegmentPerQuestion !== true) {
    push("sourceEvidenceRequirements.mustCiteAtLeastOneSegmentPerQuestion", "must be true");
  }
  if (!Array.isArray(ser?.excludedSegmentIndices) || !ser.excludedSegmentIndices.includes(16) || !ser.excludedSegmentIndices.includes(17)) {
    push("sourceEvidenceRequirements.excludedSegmentIndices", "must include 16 and 17 (pilot policy)");
  }

  if (issues.length > 0) {
    throw new AssessmentPlanInvalidError(issues);
  }
  return raw as AssessmentPlanV1;
}

// ─── Canonical hash ─────────────────────────────────────────────────

/** Canonical SHA-256 of the plan body. Used as `planIdentity` on
 *  the generation run; forms the DB-boundary dedup key together
 *  with (clubId, courseVersionId, transcriptBuildId, state). */
export function planIdentityHash(plan: AssessmentPlanV1): string {
  return createHash("sha256").update(canonicalise(plan), "utf-8").digest("hex");
}

// ─── Deterministic baseline builder ─────────────────────────────────

export interface BuildPlanInput {
  readonly courseVersionId: string;
  readonly resolvedTranscriptBuildId: string;
  readonly sourceVideoSha256: string;
  /** Segment index + text for every persisted segment the plan
   *  builder is allowed to cite. Already filtered for tenant scope
   *  by the caller. */
  readonly segments: readonly { readonly segmentIndex: number; readonly text: string }[];
  readonly videoDurationSec: number | null;
  /** Operator-supplied target (clamped to 1-20). */
  readonly targetTotalQuestions?: number;
  readonly generatedByUserId?: string | null;
  /** Deterministic timestamp for testing; defaults to new Date(). */
  readonly now?: Date;
  // EP-TRAIN-4Y-V (2026-11-09) — narrow, safe overrides for pilot
  // call sites that need an exact split (e.g. the founder pilot
  // asked for 5 checkpoint + 10 final-assessment questions). When
  // BOTH are provided they bypass the 30/70 ratio and set the
  // total to their sum; validation + segment-cap still apply.
  readonly checkpointCount?: number;
  readonly finalCount?: number;
  /** "DEFAULT" keeps the pre-existing group chunking (up to 2
   *  questions per group). "ONE_PER_GROUP" produces N separate
   *  checkpoint groups of 1 question each at N evenly spaced
   *  timestamps — matches the "5 timestamped checkpoints" reading
   *  of the pilot directive. Defaults to "DEFAULT". */
  readonly checkpointGroupStrategy?: "DEFAULT" | "ONE_PER_GROUP";
}

/**
 * Deterministic baseline builder. Given segments + duration,
 * proposes:
 *   - 1 learning objective per 3 contiguous eligible segments
 *     (no topic detection; placeholder for 4X).
 *   - checkpoint groups at even intervals of the video duration
 *     (1 group per 2 learning objectives, minimum 1).
 *   - final-assessment covering ALL learning objectives.
 *   - 70%/30% split between final and checkpoints by default.
 *
 * NEVER includes excluded segments. Never returns a plan with
 * fewer eligible segments than would support the target count.
 */
export function buildBaselineAssessmentPlan(input: BuildPlanInput): AssessmentPlanV1 {
  // EP-TRAIN-4Y-V (2026-11-09) — explicit split overrides for pilots.
  // When BOTH checkpointCount and finalCount are provided, they drive
  // the plan shape directly; `targetTotalQuestions` is ignored. When
  // only one is provided, we fall back to the ratio split (defensive).
  const hasExplicitSplit =
    typeof input.checkpointCount === "number" &&
    typeof input.finalCount === "number";
  if (hasExplicitSplit) {
    if (input.checkpointCount! < 0 || input.finalCount! < 0) {
      throw new Error(
        `buildBaselineAssessmentPlan: checkpointCount + finalCount must be non-negative (got ${input.checkpointCount}/${input.finalCount}).`,
      );
    }
    const sum = input.checkpointCount! + input.finalCount!;
    if (sum < 1 || sum > 20) {
      throw new Error(
        `buildBaselineAssessmentPlan: checkpointCount + finalCount must be 1-20 (got ${sum}).`,
      );
    }
  }
  const target = hasExplicitSplit
    ? input.checkpointCount! + input.finalCount!
    : Math.max(1, Math.min(20, input.targetTotalQuestions ?? 6));
  const eligibleSegments = input.segments
    .filter((s) => !EXCLUDED_SEGMENT_INDICES.has(s.segmentIndex))
    .sort((a, b) => a.segmentIndex - b.segmentIndex);
  const eligibleSegmentIds = eligibleSegments.map((s) => s.segmentIndex);

  // Learning objectives: group every 3 segments.
  const learningObjectives: AssessmentPlanLearningObjective[] = [];
  for (let i = 0; i < eligibleSegments.length; i += 3) {
    const slice = eligibleSegments.slice(i, i + 3);
    learningObjectives.push({
      id: `lo-${Math.floor(i / 3) + 1}`,
      title: slice.length > 0 && typeof slice[0].text === "string"
        ? slice[0].text.slice(0, 80)
        : `Objective ${Math.floor(i / 3) + 1}`,
      segmentIds: slice.map((s) => s.segmentIndex),
    });
  }
  if (learningObjectives.length === 0) {
    // No eligible segments: a plan with zero LOs is still a valid
    // document; the service refuses to accept it at REQUESTED time
    // with an INSUFFICIENT_EVIDENCE rejection.
    learningObjectives.push({ id: "lo-1", title: "No eligible segments", segmentIds: [] });
  }

  // Topic boundaries: even splits across the duration.
  const topicBoundaries: AssessmentPlanTopicBoundary[] = [];
  if (input.videoDurationSec !== null && input.videoDurationSec > 30 && learningObjectives.length > 1) {
    const step = input.videoDurationSec / learningObjectives.length;
    for (let i = 1; i < learningObjectives.length; i++) {
      topicBoundaries.push({
        atSec: Math.round(step * i),
        rationale: `baseline even split (deterministic; 4X will refine)`,
      });
    }
  }

  // Count split. Explicit overrides win; otherwise fall back to the
  // 30%/70% ratio used since 4W.
  const checkpointTarget = hasExplicitSplit
    ? input.checkpointCount!
    : Math.floor(target * 0.3);
  const finalTarget = hasExplicitSplit
    ? input.finalCount!
    : target - checkpointTarget;

  const groupStrategy = input.checkpointGroupStrategy ?? "DEFAULT";
  const proposedCheckpointGroups: AssessmentPlanCheckpointGroup[] = [];
  // Group count:
  //   - ONE_PER_GROUP → one group per question (N groups of 1).
  //   - DEFAULT       → prior 4W behaviour (up to ceil(N/2) groups,
  //                     capped at #learningObjectives).
  const groupCount =
    groupStrategy === "ONE_PER_GROUP"
      ? checkpointTarget
      : Math.max(1, Math.min(learningObjectives.length, Math.ceil(checkpointTarget / 2)));
  const stepSec = input.videoDurationSec && input.videoDurationSec > 0
    ? input.videoDurationSec / (groupCount + 1)
    : 30;
  if (checkpointTarget > 0 && groupCount > 0) {
    if (groupStrategy === "ONE_PER_GROUP") {
      // N groups of exactly 1 question each at evenly spaced
      // timestamps. Each group targets the single LO closest to its
      // atSec (approximated by index).
      for (let i = 0; i < groupCount; i++) {
        const loAssignment = learningObjectives[Math.min(i, learningObjectives.length - 1)];
        proposedCheckpointGroups.push({
          id: `cg-${i + 1}`,
          atSec: Math.round(stepSec * (i + 1)),
          learningObjectiveIds: [loAssignment.id],
          targetQuestionCount: 1,
        });
      }
    } else {
      // DEFAULT (legacy) — up to 2 questions per group, remainder
      // on first group.
      for (let i = 0; i < groupCount; i++) {
        const loAssignment = learningObjectives[Math.min(i, learningObjectives.length - 1)];
        proposedCheckpointGroups.push({
          id: `cg-${i + 1}`,
          atSec: Math.round(stepSec * (i + 1)),
          learningObjectiveIds: [loAssignment.id],
          targetQuestionCount: Math.max(1, Math.floor(checkpointTarget / groupCount)),
        });
      }
      let allocated = 0;
      for (const cg of proposedCheckpointGroups) allocated += cg.targetQuestionCount;
      if (allocated !== checkpointTarget && proposedCheckpointGroups.length > 0) {
        const delta = checkpointTarget - allocated;
        (proposedCheckpointGroups[0] as { targetQuestionCount: number }).targetQuestionCount += delta;
      }
    }
  }

  const proposedFinalAssessment: AssessmentPlanFinalAssessment = {
    targetQuestionCount: finalTarget,
    coverageLearningObjectiveIds: learningObjectives.map((lo) => lo.id),
  };

  const plan: AssessmentPlanV1 = {
    schemaVersion: ASSESSMENT_PLAN_SCHEMA_VERSION,
    courseVersionId: input.courseVersionId,
    resolvedTranscriptBuildId: input.resolvedTranscriptBuildId,
    sourceVideoSha256: input.sourceVideoSha256,
    learningObjectives,
    topicBoundaries,
    eligibleSegmentIds,
    proposedCheckpointGroups,
    proposedFinalAssessment,
    totalTargetQuestionCount: target,
    sourceEvidenceRequirements: {
      mustCiteAtLeastOneSegmentPerQuestion: true,
      excludedSegmentIndices: [16, 17],
    },
    generatedAt: (input.now ?? new Date()).toISOString(),
    generatedByUserId: input.generatedByUserId ?? null,
    // EP-TRAIN-4Y-N (2026-11-08) — see GenerationPromptContract.
    generationPromptContract: "ctx-v1",
  };
  return plan;
}
