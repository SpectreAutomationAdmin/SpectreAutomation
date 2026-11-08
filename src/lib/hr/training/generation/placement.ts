// EP-TRAIN-6D-4X (2026-11-06) — Topic-aware checkpoint placement.
//
// Replaces the even-interval baseline in 4W's assessment-plan builder
// with a deterministic topic-aware algorithm:
//
//   1. Filter out permanently-excluded segments (16, 17).
//   2. Detect topic boundaries from three independent signals:
//      - PAUSE   — gap between segment end and the next segment's
//                  start > PAUSE_SEC.
//      - SENTENCE — segment text ends with "." / "!" / "?" AND the
//                  next segment's text begins uppercase.
//      - DRIFT   — token-set drift between sliding windows of three
//                  segments exceeds DRIFT_THRESHOLD.
//   3. Group contiguous eligible segments between boundaries into
//      learning objectives.
//   4. Propose checkpoints at the end of each LO's last segment,
//      subject to:
//      - min MIN_SPACING_SEC between adjacent checkpoints,
//      - min MIN_LEAD_IN_SEC into the video,
//      - max (videoDurationSec - MIN_TAIL_SEC).
//   5. Each checkpoint carries a human-readable rationale naming
//      the boundary signal(s) that chose its timestamp.
//
// Pure functions. No I/O. No model call. Same input → same output.
// The service layer calls this; the worker re-validates the plan
// before using it.

import type {
  AssessmentPlanV1,
  AssessmentPlanLearningObjective,
  AssessmentPlanTopicBoundary,
  AssessmentPlanCheckpointGroup,
  AssessmentPlanFinalAssessment,
} from "./assessment-plan";
import {
  ASSESSMENT_PLAN_SCHEMA_VERSION,
  EXCLUDED_SEGMENT_INDICES,
} from "./assessment-plan";

// ─── Tunable constants (versioned) ──────────────────────────────────

export const PLACEMENT_RULES_VERSION = "placement-v1" as const;

export const PAUSE_SEC = 0.5;          // gap signalling a topic boundary
export const DRIFT_THRESHOLD = 0.55;   // 1 - jaccard(prev, next) > this → drift
export const DRIFT_WINDOW = 3;         // sliding window size for token-set drift
export const MIN_SPACING_SEC = 15;     // min gap between adjacent checkpoints
export const MIN_LEAD_IN_SEC = 30;     // first checkpoint must be ≥ this seconds in
export const MIN_TAIL_SEC = 10;        // last checkpoint must be ≥ this seconds before end
export const SENTENCE_TERMINATORS = new Set([".", "!", "?"]);

// ─── Public types ───────────────────────────────────────────────────

export interface PlacementSegment {
  readonly segmentIndex: number;
  readonly text: string;
  readonly startSec: number;
  readonly endSec: number;
}

export type BoundarySignal = "PAUSE" | "SENTENCE" | "DRIFT";

export interface DetectedBoundary {
  readonly beforeSegmentIndex: number;  // the segment AFTER which the boundary falls
  readonly atSec: number;               // candidate timestamp (endSec of beforeSegmentIndex)
  readonly signals: readonly BoundarySignal[];
  readonly rationale: string;
}

export interface PlacementShortfall {
  readonly reason:
    | "NO_ELIGIBLE_SEGMENTS"
    | "DURATION_TOO_SHORT"
    | "SPACING_FORCED_FEWER_CHECKPOINTS";
  readonly detail: string;
}

export interface PlacementResult {
  readonly plan: AssessmentPlanV1;
  readonly boundaries: readonly DetectedBoundary[];
  readonly shortfalls: readonly PlacementShortfall[];
  readonly rulesVersion: typeof PLACEMENT_RULES_VERSION;
}

export interface BuildTopicAwarePlanInput {
  readonly courseVersionId: string;
  readonly resolvedTranscriptBuildId: string;
  readonly sourceVideoSha256: string;
  readonly segments: readonly PlacementSegment[];
  readonly videoDurationSec: number | null;
  readonly targetTotalQuestions?: number;
  readonly generatedByUserId?: string | null;
  readonly now?: Date;
}

// ─── Normalisation + tokenisation ───────────────────────────────────

const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "but", "by", "do", "for",
  "from", "has", "have", "he", "her", "his", "i", "in", "is", "it",
  "its", "of", "on", "or", "our", "she", "that", "the", "their",
  "this", "to", "was", "we", "were", "what", "when", "where", "which",
  "who", "will", "with", "would", "you", "your", "about", "all", "any",
  "can", "if", "into", "like", "more", "no", "not", "one", "only",
  "out", "over", "so", "some", "than", "then", "there", "they", "up",
  "very",
]);

function normaliseText(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

function tokenise(s: string): string[] {
  return normaliseText(s).split(" ").filter((t) => t.length > 2 && !STOPWORDS.has(t));
}

function tokenSet(segs: readonly PlacementSegment[], from: number, count: number): Set<string> {
  const tokens = new Set<string>();
  for (let i = from; i < Math.min(from + count, segs.length); i++) {
    for (const t of tokenise(segs[i].text)) tokens.add(t);
  }
  return tokens;
}

function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 1 : inter / union;
}

function endsWithSentence(text: string): boolean {
  const trimmed = text.trimEnd();
  if (trimmed.length === 0) return false;
  return SENTENCE_TERMINATORS.has(trimmed.charAt(trimmed.length - 1));
}

function startsCapitalised(text: string): boolean {
  const trimmed = text.trimStart();
  if (trimmed.length === 0) return false;
  const c = trimmed.charAt(0);
  return c >= "A" && c <= "Z";
}

// ─── Boundary detection ─────────────────────────────────────────────

export function detectBoundaries(
  segments: readonly PlacementSegment[],
): DetectedBoundary[] {
  const boundaries: DetectedBoundary[] = [];
  if (segments.length < 2) return boundaries;

  const sorted = [...segments].sort((a, b) => a.segmentIndex - b.segmentIndex);

  for (let i = 0; i < sorted.length - 1; i++) {
    const cur = sorted[i];
    const next = sorted[i + 1];
    const signals: BoundarySignal[] = [];
    const rationales: string[] = [];

    const gap = next.startSec - cur.endSec;
    if (gap > PAUSE_SEC) {
      signals.push("PAUSE");
      rationales.push(`${gap.toFixed(2)}s pause between segments`);
    }

    if (endsWithSentence(cur.text) && startsCapitalised(next.text)) {
      signals.push("SENTENCE");
      rationales.push("sentence terminator + capitalised new sentence");
    }

    if (i + 1 + DRIFT_WINDOW <= sorted.length && i - DRIFT_WINDOW + 1 >= 0) {
      const prevWin = tokenSet(sorted, i - DRIFT_WINDOW + 1, DRIFT_WINDOW);
      const nextWin = tokenSet(sorted, i + 1, DRIFT_WINDOW);
      const sim = jaccard(prevWin, nextWin);
      const drift = 1 - sim;
      if (drift > DRIFT_THRESHOLD) {
        signals.push("DRIFT");
        rationales.push(`token-set drift ${drift.toFixed(2)} across ±${DRIFT_WINDOW}-segment windows`);
      }
    }

    if (signals.length > 0) {
      boundaries.push({
        beforeSegmentIndex: cur.segmentIndex,
        atSec: cur.endSec,
        signals,
        rationale: rationales.join("; "),
      });
    }
  }
  return boundaries;
}

// ─── Learning objective grouping ────────────────────────────────────

function groupLearningObjectives(
  segments: readonly PlacementSegment[],
  boundaries: readonly DetectedBoundary[],
): AssessmentPlanLearningObjective[] {
  if (segments.length === 0) return [];
  const boundarySet = new Set(boundaries.map((b) => b.beforeSegmentIndex));
  const los: AssessmentPlanLearningObjective[] = [];
  let currentGroup: PlacementSegment[] = [];
  const sorted = [...segments].sort((a, b) => a.segmentIndex - b.segmentIndex);
  for (const seg of sorted) {
    currentGroup.push(seg);
    if (boundarySet.has(seg.segmentIndex)) {
      los.push(makeLo(los.length + 1, currentGroup));
      currentGroup = [];
    }
  }
  if (currentGroup.length > 0) {
    los.push(makeLo(los.length + 1, currentGroup));
  }
  return los;
}

function makeLo(ix: number, group: PlacementSegment[]): AssessmentPlanLearningObjective {
  const firstSentence = group[0].text.trim().replace(/\s+/g, " ").slice(0, 120);
  return {
    id: `lo-${ix}`,
    title: firstSentence.length > 0 ? firstSentence : `Objective ${ix}`,
    segmentIds: group.map((s) => s.segmentIndex),
  };
}

// ─── Checkpoint placement ───────────────────────────────────────────

interface InternalCheckpoint {
  readonly loId: string;
  readonly atSec: number;
  readonly rationale: string;
  readonly boundarySignals: readonly BoundarySignal[];
}

function proposeCheckpointPositions(
  los: readonly AssessmentPlanLearningObjective[],
  segments: readonly PlacementSegment[],
  boundaries: readonly DetectedBoundary[],
  videoDurationSec: number,
): { placed: InternalCheckpoint[]; droppedForSpacing: number } {
  const byIndex = new Map(segments.map((s) => [s.segmentIndex, s]));
  const boundaryByIx = new Map(boundaries.map((b) => [b.beforeSegmentIndex, b]));
  const placed: InternalCheckpoint[] = [];
  let droppedForSpacing = 0;

  const upperBound = videoDurationSec - MIN_TAIL_SEC;

  for (const lo of los) {
    if (lo.segmentIds.length === 0) continue;
    const lastIx = lo.segmentIds[lo.segmentIds.length - 1];
    const lastSeg = byIndex.get(lastIx);
    if (!lastSeg) continue;
    const at = lastSeg.endSec;
    if (at < MIN_LEAD_IN_SEC) continue;
    if (at > upperBound) continue;
    const prev = placed[placed.length - 1];
    if (prev && at - prev.atSec < MIN_SPACING_SEC) {
      droppedForSpacing++;
      continue;
    }
    const boundary = boundaryByIx.get(lastIx);
    placed.push({
      loId: lo.id,
      atSec: at,
      rationale: boundary
        ? `end of ${lo.id} at segment ${lastIx} (${boundary.rationale})`
        : `end of ${lo.id} at segment ${lastIx}`,
      boundarySignals: boundary?.signals ?? [],
    });
  }
  return { placed, droppedForSpacing };
}

// ─── Public builder ─────────────────────────────────────────────────

export function buildTopicAwareAssessmentPlan(
  input: BuildTopicAwarePlanInput,
): PlacementResult {
  const shortfalls: PlacementShortfall[] = [];

  const eligibleSegments = input.segments
    .filter((s) => !EXCLUDED_SEGMENT_INDICES.has(s.segmentIndex))
    .sort((a, b) => a.segmentIndex - b.segmentIndex);

  const eligibleSegmentIds = eligibleSegments.map((s) => s.segmentIndex);

  // No eligible content: emit a plan with zero LOs, zero checkpoints,
  // zero final questions. The service refuses this at REQUESTED time.
  if (eligibleSegments.length === 0) {
    shortfalls.push({ reason: "NO_ELIGIBLE_SEGMENTS", detail: "no eligible transcript segments" });
    return {
      plan: {
        schemaVersion: ASSESSMENT_PLAN_SCHEMA_VERSION,
        courseVersionId: input.courseVersionId,
        resolvedTranscriptBuildId: input.resolvedTranscriptBuildId,
        sourceVideoSha256: input.sourceVideoSha256,
        learningObjectives: [{ id: "lo-1", title: "No eligible segments", segmentIds: [] }],
        topicBoundaries: [],
        eligibleSegmentIds: [],
        proposedCheckpointGroups: [],
        proposedFinalAssessment: { targetQuestionCount: 0, coverageLearningObjectiveIds: [] },
        totalTargetQuestionCount: 0,
        sourceEvidenceRequirements: {
          mustCiteAtLeastOneSegmentPerQuestion: true,
          excludedSegmentIndices: [16, 17],
        },
        generatedAt: (input.now ?? new Date()).toISOString(),
        generatedByUserId: input.generatedByUserId ?? null,
        generationPromptContract: "ctx-v1",
      },
      boundaries: [],
      shortfalls,
      rulesVersion: PLACEMENT_RULES_VERSION,
    };
  }

  const target = Math.max(1, Math.min(20, input.targetTotalQuestions ?? 6));
  const videoDurationSec = input.videoDurationSec ?? 0;

  const boundaries = detectBoundaries(eligibleSegments);
  const los = groupLearningObjectives(eligibleSegments, boundaries);

  // Cannot place any checkpoint if the video is too short for even
  // the required lead-in + tail. The plan still emits learning
  // objectives + a final-assessment target that uses the full target.
  let checkpointTarget: number;
  let finalTarget: number;
  let placed: InternalCheckpoint[] = [];
  let droppedForSpacing = 0;

  if (videoDurationSec <= MIN_LEAD_IN_SEC + MIN_TAIL_SEC) {
    shortfalls.push({
      reason: "DURATION_TOO_SHORT",
      detail: `video duration ${videoDurationSec}s < lead-in ${MIN_LEAD_IN_SEC}s + tail ${MIN_TAIL_SEC}s`,
    });
    checkpointTarget = 0;
    finalTarget = target;
  } else {
    const placement = proposeCheckpointPositions(los, eligibleSegments, boundaries, videoDurationSec);
    placed = placement.placed;
    droppedForSpacing = placement.droppedForSpacing;
    if (droppedForSpacing > 0) {
      shortfalls.push({
        reason: "SPACING_FORCED_FEWER_CHECKPOINTS",
        detail: `${droppedForSpacing} candidate checkpoint(s) dropped for ≤${MIN_SPACING_SEC}s spacing`,
      });
    }
    // 30 / 70 split anchored to placed checkpoint count.
    const groupCount = placed.length;
    const idealCheckpoint = Math.floor(target * 0.3);
    checkpointTarget = Math.min(groupCount * 2, idealCheckpoint);
    // If we placed fewer checkpoints than requested, final absorbs
    // the remainder (per §6 "reduce final size and report shortfall"
    // is reserved for insufficient grounded questions, not fewer
    // checkpoints).
    finalTarget = Math.max(0, target - checkpointTarget);
  }

  const proposedCheckpointGroups: AssessmentPlanCheckpointGroup[] = placed.map((p, i) => ({
    id: `cg-${i + 1}`,
    atSec: Math.round(p.atSec * 1000) / 1000,
    learningObjectiveIds: [p.loId],
    targetQuestionCount: Math.max(1, Math.floor(checkpointTarget / Math.max(1, placed.length))),
  }));
  // Rebalance remainder into the first group so the sum matches.
  let allocated = 0;
  for (const cg of proposedCheckpointGroups) allocated += cg.targetQuestionCount;
  if (proposedCheckpointGroups.length > 0 && allocated !== checkpointTarget) {
    const delta = checkpointTarget - allocated;
    (proposedCheckpointGroups[0] as { targetQuestionCount: number }).targetQuestionCount += delta;
  }
  // If after rebalance the first group dropped to zero, the group
  // itself is a defect — cull it.
  const culledCheckpointGroups = proposedCheckpointGroups.filter((cg) => cg.targetQuestionCount > 0);

  const proposedFinalAssessment: AssessmentPlanFinalAssessment = {
    targetQuestionCount: finalTarget,
    coverageLearningObjectiveIds: los.map((lo) => lo.id),
  };

  const topicBoundaries: AssessmentPlanTopicBoundary[] = boundaries.map((b) => ({
    atSec: Math.round(b.atSec * 1000) / 1000,
    rationale: b.rationale,
  }));

  const plan: AssessmentPlanV1 = {
    schemaVersion: ASSESSMENT_PLAN_SCHEMA_VERSION,
    courseVersionId: input.courseVersionId,
    resolvedTranscriptBuildId: input.resolvedTranscriptBuildId,
    sourceVideoSha256: input.sourceVideoSha256,
    learningObjectives: los.length > 0 ? los : [{ id: "lo-1", title: "No eligible segments", segmentIds: [] }],
    topicBoundaries,
    eligibleSegmentIds,
    proposedCheckpointGroups: culledCheckpointGroups,
    proposedFinalAssessment,
    totalTargetQuestionCount:
      culledCheckpointGroups.reduce((n, cg) => n + cg.targetQuestionCount, 0) + finalTarget,
    sourceEvidenceRequirements: {
      mustCiteAtLeastOneSegmentPerQuestion: true,
      excludedSegmentIndices: [16, 17],
    },
    generatedAt: (input.now ?? new Date()).toISOString(),
    generatedByUserId: input.generatedByUserId ?? null,
    // EP-TRAIN-4Y-N (2026-11-08) — mark this plan as targeting the
    // context-aware worker prompt contract. The worker reads this
    // field to switch to per-checkpoint LO + windowed-transcript
    // prompt construction.
    generationPromptContract: "ctx-v1",
  };

  return {
    plan,
    boundaries,
    shortfalls,
    rulesVersion: PLACEMENT_RULES_VERSION,
  };
}
