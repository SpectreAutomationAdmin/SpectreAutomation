// EP-TRAIN-4Y-AD §4 + §6 (2026-11-10) — course-metadata provenance
// priority rules.
//
// One pure-function module, consumed by every code path that WRITES
// to `TrainingCourse.title / description / code`. The rules exist to
// prevent a lower-authority writer from demoting a higher-authority
// writer's output, which is exactly the regression the founder
// reported on 2026-11-10T15:59:46Z (deterministic re-run overwrote
// Qwen-written "Employee Onboarding and Policies" back to the
// transcript-derived opener).
//
// Priority order (highest to lowest):
//
//   manager       — the course's current title DIFFERS from
//                   `aiMetadataAttributedTitle` (i.e. a manager
//                   edited post-system-write). Also any write via
//                   the course-metadata PATCH route in AC/AA.
//   ai            — the worker wrote Qwen-authored metadata and
//                   set `aiMetadataAttributionSource = "ai"`.
//   deterministic — the HTTP generate-metadata fallback wrote a
//                   transcript-derived title and set the source to
//                   `"deterministic"`.
//   provisional   — course.title is the AUTO-DRAFT placeholder AND
//                   no attribution row exists.
//
// Writers must call `evaluateMetadataWrite` BEFORE every write. The
// decision is:
//   - If the proposed source is STRICTLY HIGHER than the current
//     source → allow.
//   - If the proposed source is EQUAL to the current source → allow
//     (retry / refresh case; same authority).
//   - If the proposed source is LOWER than the current source →
//     refuse with a reasonCode.
//
// This is pure + offline; no I/O, no Prisma, no secrets.

export type MetadataSource = "provisional" | "deterministic" | "ai" | "manager";

/** Numeric priority. Higher wins. */
const PRIORITY: Record<MetadataSource, number> = {
  provisional: 0,
  deterministic: 1,
  ai: 2,
  manager: 3,
};

export const PROVISIONAL_TITLE = "Untitled training course";
export const PROVISIONAL_CODE_PREFIX = "AUTO-DRAFT";

export interface CurrentCourseMetadataSnapshot {
  /** Current `TrainingCourse.title`. */
  readonly title: string;
  /** Current `TrainingCourse.code`. */
  readonly code: string;
  /** Current `TrainingCourse.aiMetadataAttributionAt`. Null when no
   *  writer has recorded attribution yet. */
  readonly aiMetadataAttributionAt: Date | string | null;
  /** Current `TrainingCourse.aiMetadataAttributionSource`. One of
   *  "provisional" | "deterministic" | "ai" | "manager" | null. */
  readonly aiMetadataAttributionSource: string | null;
  /** Current `TrainingCourse.aiMetadataAttributedTitle`. The snapshot
   *  the attribution row was set against. Used to detect a subsequent
   *  manager edit (course.title differs from this snapshot). */
  readonly aiMetadataAttributedTitle: string | null;
}

export type WriteEvaluationReasonCode =
  | "ALLOWED_HIGHER_AUTHORITY"
  | "ALLOWED_EQUAL_AUTHORITY_REFRESH"
  | "REFUSED_MANAGER_EDIT_PRESENT"
  | "REFUSED_AI_AUTHORED"
  | "REFUSED_DETERMINISTIC_ALREADY_FINALISED";

export interface WriteEvaluation {
  readonly allow: boolean;
  readonly currentSource: MetadataSource;
  readonly proposedSource: MetadataSource;
  readonly reasonCode: WriteEvaluationReasonCode;
}

/** Infer the current source from the TrainingCourse snapshot. */
export function inferCurrentSource(
  snapshot: CurrentCourseMetadataSnapshot,
): MetadataSource {
  // Manager-edit detection: attribution set AND the current title
  // differs from the attributed snapshot. A fresh AI-written title
  // that no one has edited will have title === attributedTitle and
  // therefore WON'T misclassify as "manager".
  if (
    snapshot.aiMetadataAttributionAt !== null &&
    snapshot.aiMetadataAttributedTitle !== null &&
    snapshot.aiMetadataAttributedTitle !== snapshot.title
  ) {
    return "manager";
  }
  // Attribution-sourced classification. A row written by Qwen has
  // source="ai"; by deterministic fallback, source="deterministic".
  // Anything else (e.g. "manager" explicitly, future sources) lands
  // on provisional as a defensive default.
  const s = snapshot.aiMetadataAttributionSource;
  if (s === "ai") return "ai";
  if (s === "deterministic") return "deterministic";
  if (s === "manager") return "manager";
  // No attribution yet: provisional iff strings are still the
  // AUTO-DRAFT placeholders; otherwise the manager must have edited
  // pre-attribution-column (classified as "manager" to shield from
  // overwrite).
  const atPlaceholder =
    snapshot.title === PROVISIONAL_TITLE ||
    snapshot.code.startsWith(PROVISIONAL_CODE_PREFIX);
  if (snapshot.aiMetadataAttributionAt === null) {
    return atPlaceholder ? "provisional" : "manager";
  }
  return "provisional";
}

/**
 * The gate every metadata writer MUST consult before writing.
 *
 * Rule table:
 *
 *   proposed \ current | provisional | deterministic | ai   | manager
 *   -------------------|-------------|---------------|------|--------
 *   provisional        | allow       | refuse        | ref. | refuse
 *   deterministic      | allow       | allow         | ref. | refuse
 *   ai                 | allow       | allow         | allow| refuse
 *   manager            | allow       | allow         | allow| allow
 *
 * Note: "manager" writes come through the inline-edit path (4Y-AA /
 * 4Y-AB's `/api/admin/training/courses/[courseId]/metadata` PATCH)
 * which carries manager intent and is always allowed. A manager write
 * also implicitly resets the attribution snapshot to the new title so
 * a future AI retry sees the current state as "manager" (titles differ
 * from the stale snapshot).
 */
export function evaluateMetadataWrite(args: {
  readonly currentSnapshot: CurrentCourseMetadataSnapshot;
  readonly proposedSource: MetadataSource;
}): WriteEvaluation {
  const currentSource = inferCurrentSource(args.currentSnapshot);
  const proposed = args.proposedSource;
  const curP = PRIORITY[currentSource];
  const propP = PRIORITY[proposed];

  if (currentSource === "manager" && proposed !== "manager") {
    return {
      allow: false,
      currentSource,
      proposedSource: proposed,
      reasonCode: "REFUSED_MANAGER_EDIT_PRESENT",
    };
  }
  if (currentSource === "ai" && (proposed === "deterministic" || proposed === "provisional")) {
    return {
      allow: false,
      currentSource,
      proposedSource: proposed,
      reasonCode: "REFUSED_AI_AUTHORED",
    };
  }
  if (currentSource === "deterministic" && proposed === "provisional") {
    return {
      allow: false,
      currentSource,
      proposedSource: proposed,
      reasonCode: "REFUSED_DETERMINISTIC_ALREADY_FINALISED",
    };
  }
  if (propP > curP) {
    return {
      allow: true,
      currentSource,
      proposedSource: proposed,
      reasonCode: "ALLOWED_HIGHER_AUTHORITY",
    };
  }
  // Equal-authority refresh (e.g. AI retry rewrites an earlier AI
  // run's output; a second deterministic pass can refresh a
  // deterministic baseline). The writer's own idempotency keys
  // handle further protection — this helper's contract is purely
  // "does the source ladder permit this write?"
  return {
    allow: true,
    currentSource,
    proposedSource: proposed,
    reasonCode: "ALLOWED_EQUAL_AUTHORITY_REFRESH",
  };
}

/** Validate a candidate AI title against the directive's §5 rules.
 *  Returns findings when the proposed title looks like a transcript
 *  fragment rather than a professional course title. */
export interface MetadataValidationFinding {
  readonly code:
    | "TITLE_LOOKS_LIKE_TRANSCRIPT_FRAGMENT"
    | "TITLE_TOO_LONG"
    | "TITLE_TOO_SHORT"
    | "DESCRIPTION_LOOKS_LIKE_TRANSCRIPT_OPENER"
    | "DESCRIPTION_TOO_SHORT";
  readonly message: string;
}
export interface MetadataValidationResult {
  readonly ok: boolean;
  readonly findings: readonly MetadataValidationFinding[];
}

const TRANSCRIPT_FRAGMENT_PATTERNS: readonly RegExp[] = [
  // Deterministic-fallback titles start by extracting the first
  // sentence of the transcript. Those first sentences very commonly
  // open with "Hello", "Welcome", "Hi", "Getting", "Alright", etc.
  /^(hello|welcome|hi|hey|alright|okay|so|now|getting right into|right so|let's|let us)\b/i,
  // Verbatim-looking long titles that start mid-sentence or carry
  // conversational fillers.
  /\b(you know|i think|basically|um|uh|the most frequently asked question)\b/i,
];

const DESCRIPTION_OPENER_PATTERNS: readonly RegExp[] = [
  // "Hello everyone and welcome to …" style transcript openers.
  /^\s*(hello|welcome|hi|hey|good (morning|afternoon|evening))\s+(everyone|everybody|team|folks)/i,
  // "I'm X and I'll be your …" presenter intro.
  /\bi'?m\b.+(will be|am)\s+your\b/i,
];

export function validateProposedAiMetadata(args: {
  readonly title: string;
  readonly description: string;
}): MetadataValidationResult {
  const findings: MetadataValidationFinding[] = [];
  const t = (args.title ?? "").trim();
  const d = (args.description ?? "").trim();
  if (t.length < 4) {
    findings.push({ code: "TITLE_TOO_SHORT", message: "Title is empty or too short." });
  }
  if (t.length > 120) {
    findings.push({
      code: "TITLE_TOO_LONG",
      message: `Title is ${t.length} characters; good course titles stay under 120.`,
    });
  }
  for (const rx of TRANSCRIPT_FRAGMENT_PATTERNS) {
    if (rx.test(t)) {
      findings.push({
        code: "TITLE_LOOKS_LIKE_TRANSCRIPT_FRAGMENT",
        message: `Title matches a transcript-fragment pattern (${rx}).`,
      });
      break;
    }
  }
  if (d.length < 20) {
    findings.push({
      code: "DESCRIPTION_TOO_SHORT",
      message: "Description is too short to summarise a training video.",
    });
  }
  for (const rx of DESCRIPTION_OPENER_PATTERNS) {
    if (rx.test(d)) {
      findings.push({
        code: "DESCRIPTION_LOOKS_LIKE_TRANSCRIPT_OPENER",
        message: `Description opens with a transcript-opener pattern (${rx}).`,
      });
      break;
    }
  }
  return { ok: findings.length === 0, findings };
}
