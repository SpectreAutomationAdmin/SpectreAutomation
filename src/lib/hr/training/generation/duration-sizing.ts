// EP-TRAIN-4Y-BB §2 — Duration-based AI question sizing policy.
//
// Purpose: a 643-second video should NOT default to targetTotalQuestions=6
// (the historical plan-builder constant). It should get ~12 questions
// sized to its content: 4 checkpoint events + 8 final-assessment
// questions. Short videos get fewer; long ones get more — the table
// below is the authoritative default.
//
// Pure, deterministic, no I/O. The service layer calls this; the plan
// builder consumes the returned `checkpointCount` + `finalCount` via
// the explicit-split path (which bypasses the ratio math).
//
// Managers may always author manual questions over and above these
// defaults — this policy sizes AUTO-GENERATION only (§2 of the
// directive: "Treat these as AI-generation defaults, not limits on
// manager-authored questions").

export interface DurationSizingBucket {
  readonly label: string;
  readonly minSec: number;
  readonly maxSec: number;      // exclusive upper bound
  readonly checkpointMin: number;
  readonly checkpointMax: number;
  readonly finalMin: number;
  readonly finalMax: number;
  readonly defaultCheckpointCount: number;
  readonly defaultFinalCount: number;
}

/** Published policy — exact copy of the founder-directive table.
 *  Order matters; first matching bucket wins. */
export const DURATION_SIZING_POLICY: readonly DurationSizingBucket[] = [
  {
    label: "under 3 minutes",
    minSec: 0, maxSec: 180,
    checkpointMin: 0, checkpointMax: 1, finalMin: 3, finalMax: 5,
    defaultCheckpointCount: 1, defaultFinalCount: 4,
  },
  {
    label: "3-5 minutes",
    minSec: 180, maxSec: 300,
    checkpointMin: 1, checkpointMax: 2, finalMin: 4, finalMax: 6,
    defaultCheckpointCount: 2, defaultFinalCount: 5,
  },
  {
    label: "5-10 minutes",
    minSec: 300, maxSec: 600,
    checkpointMin: 2, checkpointMax: 3, finalMin: 5, finalMax: 8,
    defaultCheckpointCount: 3, defaultFinalCount: 6,
  },
  {
    label: "10-15 minutes",
    minSec: 600, maxSec: 900,
    checkpointMin: 3, checkpointMax: 5, finalMin: 6, finalMax: 10,
    defaultCheckpointCount: 4, defaultFinalCount: 8,
  },
  {
    label: "15-30 minutes",
    minSec: 900, maxSec: 1800,
    checkpointMin: 5, checkpointMax: 8, finalMin: 8, finalMax: 12,
    defaultCheckpointCount: 6, defaultFinalCount: 10,
  },
  {
    label: "30-60 minutes",
    minSec: 1800, maxSec: 3600,
    checkpointMin: 8, checkpointMax: 12, finalMin: 10, finalMax: 15,
    defaultCheckpointCount: 10, defaultFinalCount: 12,
  },
  {
    label: "over 60 minutes",
    minSec: 3600, maxSec: Number.POSITIVE_INFINITY,
    checkpointMin: 10, checkpointMax: 20, finalMin: 12, finalMax: 20,
    defaultCheckpointCount: 14, defaultFinalCount: 16,
  },
];

export interface SizingResult {
  readonly bucket: DurationSizingBucket;
  readonly checkpointCount: number;
  readonly finalCount: number;
  /** Total question count = checkpointCount + finalCount. */
  readonly totalCount: number;
}

/**
 * Pick the AI-generation question counts for a video of the given
 * duration. Returns the bucket's default split. Callers may adjust
 * downward (e.g. transcript density) but should not inflate above
 * the bucket's max.
 *
 * `durationSec` of 0 or null is treated as the first bucket
 * ("under 3 minutes") — a defensive default; the plan builder will
 * refuse a video with no eligible segments at request-time.
 */
export function sizeForDuration(durationSec: number | null | undefined): SizingResult {
  const sec = Math.max(0, durationSec ?? 0);
  const bucket =
    DURATION_SIZING_POLICY.find((b) => sec >= b.minSec && sec < b.maxSec)
    ?? DURATION_SIZING_POLICY[0];
  return {
    bucket,
    checkpointCount: bucket.defaultCheckpointCount,
    finalCount: bucket.defaultFinalCount,
    totalCount: bucket.defaultCheckpointCount + bucket.defaultFinalCount,
  };
}

/**
 * Clamp manager / caller overrides to the bucket's min/max range.
 * Used when a caller explicitly asks for e.g. 10 CP on a 643-s video
 * — we refuse to go above the 10-15 min bucket's max of 5.
 */
export function clampToBucket(
  bucket: DurationSizingBucket,
  input: { checkpointCount?: number; finalCount?: number },
): { readonly checkpointCount: number; readonly finalCount: number } {
  const cp = typeof input.checkpointCount === "number"
    ? Math.max(bucket.checkpointMin, Math.min(bucket.checkpointMax, Math.floor(input.checkpointCount)))
    : bucket.defaultCheckpointCount;
  const fa = typeof input.finalCount === "number"
    ? Math.max(bucket.finalMin, Math.min(bucket.finalMax, Math.floor(input.finalCount)))
    : bucket.defaultFinalCount;
  return { checkpointCount: cp, finalCount: fa };
}
