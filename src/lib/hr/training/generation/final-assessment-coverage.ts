// EP-TRAIN-4Y-AF §4 — deterministic final-assessment coverage planner.
//
// The 4Y-Z pilot proved a single Modal call at `maxQuestions: 10` with
// 54 learning objectives returned ZERO proposals. The chunked contract
// partitions the FA target into N calls of ≤3 questions each, each
// covering a NARROWER slice of the course's learning-objective list.
//
// Design properties:
//   - Deterministic: same (plan, target, maxPerChunk) → identical chunks.
//   - Topic-contiguous: each chunk covers a CONTIGUOUS slice of LOs by
//     index, matching the plan's time-ordered LO list.
//   - Pure offline: no DB, no transcript parsing, no I/O. Takes an
//     AssessmentPlanV1 and returns chunks.
//   - Respects support ceiling: refuses to fabricate chunks when the
//     underlying plan has fewer LOs than can support the requested
//     number of questions.
//
// Called by `requestFinalAssessmentRecovery` to populate
// `proposedFinalAssessmentChunks` on a recovery plan.

import type {
  AssessmentPlanV1,
  AssessmentPlanFinalAssessmentChunk,
  AssessmentPlanLearningObjective,
} from "./assessment-plan";

/** Hard ceiling on per-chunk target: the observed-safe Modal call size
 *  for Qwen 2.5 7B AWQ at FA scope. Checkpoints at target=1 succeeded
 *  reliably in 4Y-Z; FA at target=10 produced zero. 3 is the largest
 *  tested ask in the 4Y-M pilot that returned a complete set. */
export const FA_CHUNK_MAX_TARGET = 3;

/** Minimum LOs a chunk should cover. If the course has FEWER LOs than
 *  chunks would produce, chunks may still be built but their coverage
 *  overlaps the same LO (acceptable — the prompt focus narrows the
 *  model, and dedup catches any duplicate output). */
export const FA_CHUNK_MIN_LO_COUNT = 1;

export interface BuildFinalAssessmentCoverageInput {
  readonly learningObjectives: readonly AssessmentPlanLearningObjective[];
  readonly target: number;
  readonly maxPerChunk?: number;
}

export interface BuildFinalAssessmentCoverageResult {
  readonly chunks: readonly AssessmentPlanFinalAssessmentChunk[];
  /** Target the planner was able to cover. May be LESS than the input
   *  target when the underlying plan has too few LOs to support
   *  distinct chunks — the caller reports the shortfall rather than
   *  fabricating. */
  readonly supportedTarget: number;
  /** LO count per chunk (for operator visibility). */
  readonly losPerChunk: number;
}

/**
 * Partition a target FA question count into chunks of ≤ `maxPerChunk`,
 * each assigned a contiguous slice of learning objectives.
 *
 *   target=10, maxPerChunk=3 → chunk sizes [3,3,3,1] (4 chunks).
 *   target=10, maxPerChunk=2 → chunk sizes [2,2,2,2,2] (5 chunks).
 *   target=6,  maxPerChunk=3 → chunk sizes [3,3] (2 chunks).
 *   target=1,  maxPerChunk=3 → chunk sizes [1] (1 chunk).
 *
 * LO allocation: given N chunks and M LOs, each chunk gets a contiguous
 * slice of ⌈M/N⌉ LOs (the last slice may be shorter). No gap, no
 * overlap when M >= N; wrap-around when M < N.
 */
export function buildFinalAssessmentCoverage(
  input: BuildFinalAssessmentCoverageInput,
): BuildFinalAssessmentCoverageResult {
  const maxPerChunk = input.maxPerChunk ?? FA_CHUNK_MAX_TARGET;
  if (maxPerChunk < 1 || maxPerChunk > FA_CHUNK_MAX_TARGET) {
    throw new Error(
      `buildFinalAssessmentCoverage: maxPerChunk must be 1..${FA_CHUNK_MAX_TARGET} (got ${maxPerChunk}).`,
    );
  }
  const target = Math.max(0, Math.floor(input.target));
  if (target === 0) {
    return { chunks: [], supportedTarget: 0, losPerChunk: 0 };
  }

  // Filter LOs with at least one segment id — a chunk whose covered LOs
  // have ZERO segment ids would be ungrounded.
  const groundedLos = input.learningObjectives.filter((lo) => lo.segmentIds.length > 0);
  if (groundedLos.length === 0) {
    return { chunks: [], supportedTarget: 0, losPerChunk: 0 };
  }

  const chunkCount = Math.ceil(target / maxPerChunk);
  // Per-chunk size: fill `maxPerChunk` until the remainder is reached.
  const chunkSizes: number[] = [];
  let remaining = target;
  for (let i = 0; i < chunkCount; i++) {
    const size = Math.min(maxPerChunk, remaining);
    chunkSizes.push(size);
    remaining -= size;
  }

  // LO allocation: chunkCount slices across the grounded-LO list.
  const losPerChunk = Math.max(FA_CHUNK_MIN_LO_COUNT, Math.ceil(groundedLos.length / chunkCount));

  const chunks: AssessmentPlanFinalAssessmentChunk[] = [];
  for (let i = 0; i < chunkCount; i++) {
    const start = Math.min(i * losPerChunk, groundedLos.length - 1);
    const end = Math.min(start + losPerChunk, groundedLos.length);
    let slice = groundedLos.slice(start, end);
    if (slice.length === 0) {
      // Defensive: wrap to the first slice. Shouldn't happen given the
      // clamping above, but better a non-empty chunk than an empty one.
      slice = groundedLos.slice(0, losPerChunk);
    }
    chunks.push({
      id: `fa-${i + 1}`,
      targetQuestionCount: chunkSizes[i],
      coverageLearningObjectiveIds: slice.map((lo) => lo.id),
      focusTopicLabel: deriveTopicLabel(slice[0].title, i + 1),
    });
  }

  return {
    chunks,
    supportedTarget: target,
    losPerChunk,
  };
}

/** Derive a short topic label from the first LO's title. The LO title
 *  is a 0-80 char transcript snippet; we truncate at the first sentence
 *  break or at 50 chars, whichever comes first, and fall back to a
 *  numbered label. */
function deriveTopicLabel(firstLoTitle: string, chunkNumber: number): string {
  const trimmed = firstLoTitle.trim();
  if (trimmed.length === 0) return `Final assessment chunk ${chunkNumber}`;
  const sentenceEnd = trimmed.search(/[.!?]\s|$/);
  const candidate = sentenceEnd > 0 && sentenceEnd < 50
    ? trimmed.slice(0, sentenceEnd)
    : trimmed.slice(0, 50);
  return candidate.trim();
}
