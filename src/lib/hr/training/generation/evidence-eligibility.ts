// EP-TRAIN-4Y-AH §3 — canonical evidence eligibility for generation.
//
// A single source of truth for which transcript segment ids are allowed
// to appear anywhere in the FA generation pipeline:
//   - coverage planning (chunk LO slices trim ineligible segment ids)
//   - prompt construction (FA prompt enumerates allowedSegmentIds and
//     renders a transcript window containing ONLY those ids)
//   - grounding validation (unchanged belt-and-suspenders check)
//   - persistence provenance (draft rows cite only permitted ids)
//
// The 4Y-AG recovery failed because these four concerns consulted
// DIFFERENT eligibility sets:
//   - plan-level: plan.eligibleSegmentIds (161 ids: {0..162} \ {16, 17})
//   - worker-level: plan.eligibleSegmentIds \ RUNTIME_EXCLUDED
//     = 144 ids ({0..162} \ {16, 17, 68..82, 160, 161})
//   - FA prompt: no enumeration at all (asked Qwen to cite "any id from
//     the transcript provided", with the transcript's `[N]` prefix the
//     only hint)
//   - Modal JSON schema: no enum on sourceSegmentIds (any integer)
//
// Qwen was therefore PERMITTED to cite ids the worker later rejected.
// This module centralises the canonical set so every seam consults it.

/** Plan-level exclusions — carried on `AssessmentPlanV1.sourceEvidenceRequirements`.
 *  Known value for the Silver Springs pilot: {16, 17} (per-plan content
 *  policy for that transcript's known anomalies). */
export type PlanExcludedSegmentIndices = ReadonlySet<number>;

/** EP-TRAIN-4Y-M (2026-11-08) — runtime-only grounding-hygiene filter.
 *  Not consumed by plan-build or plan-validate, so it does not
 *  invalidate pre-existing plans. These are transcript-wide Whisper
 *  artefacts (duplication + end-of-video hallucination) that apply
 *  regardless of plan. Historically owned by worker-handler.ts;
 *  re-exported here so the coverage planner + prompt builder can
 *  consult the same set at offline build time.
 *
 *  68–82 — 15 consecutive "Thank you." Whisper duplication artifacts
 *    within 237.18–242.04 s on the Silver Springs orientation transcript.
 *  160, 161 — End-of-video Whisper hallucination at 634.93–636.03 s
 *    (multi-script garble). Segment 162 remains eligible.
 *
 *  This set is correct for the Silver Springs transcript. Future
 *  transcripts should carry their own runtime exclusions (either as a
 *  plan field OR via a per-transcript hygiene registry — follow-up work). */
export const RUNTIME_EXCLUDED_SEGMENT_INDICES: ReadonlySet<number> = Object.freeze(
  new Set<number>([
    68, 69, 70, 71, 72, 73, 74, 75, 76, 77, 78, 79, 80, 81, 82,
    160, 161,
  ]),
);

/** The authoritative set of segment ids the generator is NOT permitted
 *  to cite. Union of plan-level + runtime exclusions. Every seam that
 *  reasons about eligibility MUST derive from this helper or an
 *  equivalent explicit filter — never from a hand-maintained list
 *  pasted elsewhere. */
export function computeWorkerExcludedSegmentIndices(
  planExcluded: readonly number[] | PlanExcludedSegmentIndices,
): ReadonlySet<number> {
  const out = new Set<number>(RUNTIME_EXCLUDED_SEGMENT_INDICES);
  for (const n of planExcluded) out.add(n);
  return out;
}

/** The authoritative eligible set for the current plan. Intersection
 *  of plan.eligibleSegmentIds with the complement of the worker
 *  exclusion set. Pure / offline. */
export function computeEligibleSegmentIds(args: {
  readonly planEligibleSegmentIds: readonly number[];
  readonly workerExcludedSegmentIndices: ReadonlySet<number>;
}): readonly number[] {
  const out: number[] = [];
  for (const id of args.planEligibleSegmentIds) {
    if (!args.workerExcludedSegmentIndices.has(id)) out.push(id);
  }
  out.sort((a, b) => a - b);
  return out;
}

/** Trim a learning objective's segmentIds down to only the permitted
 *  ids. An LO with zero permitted ids after trimming is effectively
 *  "ungrounded for FA purposes" and should be skipped by the coverage
 *  planner — see `buildFinalAssessmentCoverage`. */
export function trimLearningObjectiveSegments<LO extends { readonly segmentIds: readonly number[] }>(
  lo: LO,
  workerExcluded: ReadonlySet<number>,
): LO {
  const filtered = lo.segmentIds.filter((id) => !workerExcluded.has(id));
  if (filtered.length === lo.segmentIds.length) return lo;
  return { ...lo, segmentIds: filtered };
}
