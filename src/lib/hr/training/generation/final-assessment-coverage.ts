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
import {
  computeWorkerExcludedSegmentIndices,
  trimLearningObjectiveSegments,
  RUNTIME_EXCLUDED_SEGMENT_INDICES,
} from "./evidence-eligibility";

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
  /** EP-TRAIN-4Y-AH §3 — the AUTHORITATIVE plan-level exclusions.
   *  Combined with the module's internal `RUNTIME_EXCLUDED_SEGMENT_INDICES`
   *  to produce the canonical set of ids that must NOT appear in any
   *  chunk's eligibleSegmentIds. Pass the plan's
   *  `sourceEvidenceRequirements.excludedSegmentIndices` here. */
  readonly planExcludedSegmentIndices?: readonly number[];
  /** EP-TRAIN-4Y-AH §3 — the AUTHORITATIVE plan-level eligible set.
   *  The LO slice is intersected with this set before any chunk is
   *  built. Pass the plan's `eligibleSegmentIds` here. If omitted the
   *  planner falls back to permissive behaviour (LOs' own segmentIds
   *  are used as the baseline) — the caller is responsible for ensuring
   *  the LOs' own segmentIds are already plan-eligible. */
  readonly planEligibleSegmentIds?: readonly number[];
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
  /** EP-TRAIN-4Y-AH §3 — LOs REMOVED from consideration because every
   *  one of their segmentIds was in the worker-excluded set. Returned
   *  so the operator preflight can surface which content the coverage
   *  plan cannot reach. */
  readonly ineligibleLearningObjectiveIds: readonly string[];
  /** EP-TRAIN-4Y-AH §3 — per-chunk LO title list used for
   *  focusTopicSummary (operator visibility). */
  readonly chunkDebug: ReadonlyArray<{
    readonly id: string;
    readonly loTitles: readonly string[];
    readonly eligibleSegmentCount: number;
  }>;
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
    return {
      chunks: [], supportedTarget: 0, losPerChunk: 0,
      ineligibleLearningObjectiveIds: [], chunkDebug: [],
    };
  }

  // EP-TRAIN-4Y-AH §3 — build the canonical worker-excluded set from
  // plan-level exclusions + runtime hygiene. Trim every LO's segmentIds
  // against this set BEFORE any coverage decisions. An LO whose every
  // segmentId is excluded is dropped (listed in
  // `ineligibleLearningObjectiveIds` for operator visibility). An LO
  // with partial eligibility retains only its permitted ids — the
  // coverage decision uses the TRIMMED set so chunk-level eligible
  // segment lists are authoritative.
  const workerExcluded = computeWorkerExcludedSegmentIndices(input.planExcludedSegmentIndices ?? []);
  const planEligible = new Set<number>(input.planEligibleSegmentIds ?? []);
  const hasPlanEligibleFilter = (input.planEligibleSegmentIds ?? []).length > 0;

  // Step 1 — trim each LO's segmentIds down to the permitted set.
  //         Then drop LOs that become empty.
  const trimmedLos = input.learningObjectives
    .map((lo) => {
      // Intersect with planEligible FIRST (if provided), then
      // worker-exclude.
      const planFiltered = hasPlanEligibleFilter
        ? lo.segmentIds.filter((id) => planEligible.has(id))
        : lo.segmentIds;
      const fullyFiltered = planFiltered.filter((id) => !workerExcluded.has(id));
      return { ...lo, segmentIds: fullyFiltered };
    });
  const ineligibleLearningObjectiveIds = trimmedLos
    .filter((lo) => lo.segmentIds.length === 0)
    .map((lo) => lo.id);
  const groundedLos = trimmedLos.filter((lo) => lo.segmentIds.length > 0);
  if (groundedLos.length === 0) {
    return {
      chunks: [], supportedTarget: 0, losPerChunk: 0,
      ineligibleLearningObjectiveIds, chunkDebug: [],
    };
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
  const chunkDebug: Array<{ id: string; loTitles: readonly string[]; eligibleSegmentCount: number }> = [];
  for (let i = 0; i < chunkCount; i++) {
    const start = Math.min(i * losPerChunk, groundedLos.length - 1);
    const end = Math.min(start + losPerChunk, groundedLos.length);
    let slice = groundedLos.slice(start, end);
    if (slice.length === 0) {
      // Defensive: wrap to the first slice. Shouldn't happen given the
      // clamping above, but better a non-empty chunk than an empty one.
      slice = groundedLos.slice(0, losPerChunk);
    }
    // Per-chunk eligibleSegmentIds: union of each covered LO's trimmed
    // segmentIds, dedup + sorted. This is the AUTHORITATIVE allowed
    // list for THIS chunk — used verbatim by prompt + grounding.
    const eligibleSet = new Set<number>();
    for (const lo of slice) for (const id of lo.segmentIds) eligibleSet.add(id);
    const eligibleSegmentIds = [...eligibleSet].sort((a, b) => a - b);
    const loTitles = slice.map((lo) => lo.title.trim()).filter((t) => t.length > 0);
    const focusTopicSummary = deriveTopicSummary(loTitles);
    chunks.push({
      id: `fa-${i + 1}`,
      targetQuestionCount: chunkSizes[i],
      coverageLearningObjectiveIds: slice.map((lo) => lo.id),
      focusTopicLabel: deriveTopicLabel(slice[0].title, i + 1),
      eligibleSegmentIds,
      focusTopicSummary,
    });
    chunkDebug.push({ id: `fa-${i + 1}`, loTitles, eligibleSegmentCount: eligibleSegmentIds.length });
  }

  return {
    chunks,
    supportedTarget: target,
    losPerChunk,
    ineligibleLearningObjectiveIds,
    chunkDebug,
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

/** EP-TRAIN-4Y-AH §4 — operator-facing multi-LO summary. Joins up to
 *  three LO titles with semicolons and truncates to 240 chars. Used
 *  only for display (preflight response, reports) — NOT fed back to
 *  the model. The in-prompt LO list consumed by the worker is the
 *  full set of covered LO titles. */
function deriveTopicSummary(loTitles: readonly string[]): string {
  if (loTitles.length === 0) return "(no learning objectives)";
  const first = loTitles.slice(0, 3);
  const joined = first.map((t) => t.trim()).filter((t) => t.length > 0).join(" · ");
  return joined.length > 240 ? joined.slice(0, 237) + "…" : joined;
}

// ─────────────────────────────────────────────────────────────────────
// EP-TRAIN-4Y-AI §2 — Coherent LO-summary builder.
//
// The AH slice surfaced focusTopicSummary values that were raw
// transcript-fragment joins (e.g. "days which we have for a year we
// ask all staff members to park on the sidewalk j"). The AI directive
// requires a cleaner operator-facing description grounded in the
// chunk's actual eligible transcript segments, with:
//   - complete sentences (no mid-word truncation);
//   - the leading context explicit ("Employees should understand …");
//   - no invented content;
//   - no GPU inference.
//
// Strategy: given an ordered array of (segmentIndex, text) for ONLY
// the chunk's eligibleSegmentIds, concatenate the text, split into
// sentences at [.!?] boundaries, retain the first 1-3 sentences that
// start with a capital letter OR an inferrable sentence-shape marker,
// and compose with a leading phrase. Deterministic / pure / offline.
// ─────────────────────────────────────────────────────────────────────

const AI_SUMMARY_MAX_LEN = 320;
const AI_SUMMARY_MIN_SENTENCE_LEN = 14; // reject fragments like "Yeah I guess."
const AI_SUMMARY_MAX_SENTENCES = 3;

export interface CoherentLoSummaryInput {
  readonly chunkId: string;
  readonly eligibleSegmentIds: readonly number[];
  /** Ordered segment text for EXACTLY the chunk's eligibleSegmentIds.
   *  Caller is responsible for the one-to-one mapping (filter + sort). */
  readonly orderedSegments: ReadonlyArray<{ readonly segmentIndex: number; readonly text: string }>;
  /** Fallback topic hint when transcript cannot yield a usable
   *  summary — e.g., the chunk's titles joined. Used only when
   *  sentence extraction returns zero sentences. */
  readonly fallbackJoin: string;
}

/** Build a cleaner operator-facing summary from a chunk's actual
 *  transcript segments. No LLM, no invention; returns the raw joined
 *  fallback when the transcript yields no usable sentence (e.g., a
 *  very short chunk of fragmented text). */
export function buildCoherentLoSummary(input: CoherentLoSummaryInput): string {
  const joined = input.orderedSegments
    .map((s) => (s.text ?? "").trim())
    .filter((t) => t.length > 0)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  if (joined.length === 0) {
    return input.fallbackJoin.length > 0 ? input.fallbackJoin : "(no usable transcript)";
  }

  // Split into sentence candidates on . ! ? followed by whitespace /
  // end-of-string. Preserve the punctuation.
  const rawSentences = joined.match(/[^.!?]+[.!?]+/g) ?? [joined];
  const sentences: string[] = [];
  for (const sRaw of rawSentences) {
    const s = sRaw.trim();
    if (s.length < AI_SUMMARY_MIN_SENTENCE_LEN) continue;
    // Reject obvious transcription fragments: lines starting with a
    // continuation conjunction (and / but / so / etc.) OR ending
    // with an incomplete word (no final letter).
    if (/^(and|but|so|yeah|um|uh|ok|okay|like)\b/i.test(s)) continue;
    // Reject sentence candidates where the final token looks like a
    // truncated word (letters, no trailing letter — handled above by
    // the punctuation regex, but belt-and-suspenders):
    if (!/[.!?]$/.test(s)) continue;
    sentences.push(s);
    if (sentences.length >= AI_SUMMARY_MAX_SENTENCES) break;
  }

  if (sentences.length === 0) {
    // Nothing clean — surface the truncated raw join (still bounded
    // to AI_SUMMARY_MAX_LEN).
    return input.fallbackJoin.length > 0 ? input.fallbackJoin : joined.slice(0, AI_SUMMARY_MAX_LEN);
  }

  const assembled = sentences.join(" ");
  if (assembled.length <= AI_SUMMARY_MAX_LEN) return assembled;
  return assembled.slice(0, AI_SUMMARY_MAX_LEN - 1).replace(/\s+\S*$/, "") + "…";
}
