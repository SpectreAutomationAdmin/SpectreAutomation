// EP-TRAIN-6D-4D — Read-only AI candidate retrieval service.
//
// Tenant-scoped service layer for the manager review UI. Exposes TWO
// functions:
//
//   listCandidates(principal, clubId, pagination)
//   getCandidate(principal, clubId, draftId)
//
// Both:
//   - Require `hr:training:ai:read` on the active club (authorisation
//     check is the caller's responsibility; see assertions below).
//   - Scope every Prisma query by clubId.
//   - Return a projected DTO (never the raw row). The DTO deliberately
//     OMITS:
//       - `draftJson` tail (never useful to the UI; the structured
//         fields come from the pipeline-derived draft shape)
//       - pilotAuthorisation fingerprints (sensitive provenance; not
//         needed for review)
//       - every "*Json" blob except the normalised `validationResult`
//         projection that the UI consumes
//
// No mutation code. No audit writes. No side effects.

import { prisma } from "@/lib/prisma";
import type { Principal } from "@/lib/rbac";
import { hasPermission } from "@/lib/rbac";

export type Verdict = "GROUNDED" | "REQUIRES_HUMAN_VERIFICATION" | "REJECTED";
export type LifecycleState =
  | "GENERATED"
  | "VALIDATION_PENDING"
  | "REQUIRES_HUMAN_REVIEW"
  | "APPROVED_DRAFT"
  | "REJECTED"
  | "EDITED_VALIDATION_STALE"
  | "VALIDATION_FAILED"
  | "ARCHIVED";

export interface ListPagination {
  readonly cursor?: string | null; // draft id
  readonly limit?: number;         // 1..50, default 20
  readonly states?: readonly LifecycleState[]; // optional filter
}

export interface CandidateQueueRow {
  readonly draftId: string;
  readonly topic: string;                // derived from draft questionText (truncated)
  readonly state: LifecycleState;
  readonly contentHash: string;
  readonly recordVersion: number;
  readonly generatedAt: Date;
  readonly updatedAt: Date;
  readonly courseVersionId: string;
  readonly latestVerdict: Verdict | null; // null when no validation yet
  readonly latestValidatorSource: string | null;
  readonly latestHardErrorCount: number;
  readonly latestAdvisoryCount: number;
  readonly latestValidationAt: Date | null;
}

export interface CandidateQueueResult {
  readonly rows: readonly CandidateQueueRow[];
  readonly nextCursor: string | null;
  readonly limit: number;
  readonly states: readonly LifecycleState[] | null;
}

export interface CandidateDetailValidation {
  readonly id: string;
  readonly draftContentHash: string;
  readonly validatorVersion: string;
  readonly validatorSource: string;
  readonly verdict: Verdict;
  readonly stage: string;
  readonly errors: readonly { code: string; message: string }[];
  readonly flags: readonly string[];
  readonly runAt: Date;
}

export interface CandidateDetailReview {
  readonly id: string;
  readonly disposition: string;
  readonly reviewerNote: string | null;
  readonly reviewedByUserId: string;
  readonly reviewedAt: Date;
  readonly draftContentHash: string;
  readonly validationId: string | null;
}

export interface CandidateDetail {
  readonly draftId: string;
  readonly clubId: string;
  readonly courseId: string;
  readonly courseVersionId: string;
  readonly state: LifecycleState;
  readonly contentHash: string;
  readonly recordVersion: number;
  readonly generatedAt: Date;
  readonly updatedAt: Date;

  // Content — derived from the canonical draftJson.
  readonly draft: {
    readonly questionType: string;
    readonly questionText: string;
    readonly options: readonly { text: string; isCorrect: boolean }[];
    readonly explanation: string;
    readonly sourceSegmentIds: readonly number[];
  };

  // Source-material metadata only. NO transcript bodies.
  readonly sourceVideoSha256: string;
  readonly resolvedTranscriptBuildId: string;
  readonly groundingProjectionSha256: string;

  readonly latestValidation: CandidateDetailValidation | null;
  readonly historicalValidations: readonly CandidateDetailValidation[];
  readonly reviews: readonly CandidateDetailReview[];
}

// ---------- Helpers ----------

const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 20;

function requireReadPermission(principal: Principal | null | undefined, clubId: string): void {
  if (!principal) throw new ReadServiceError("UNAUTHENTICATED", 401);
  if (!hasPermission(principal, clubId, "hr:training:ai:read")) {
    throw new ReadServiceError("FORBIDDEN", 403);
  }
}

export class ReadServiceError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status: number) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

function countFromJson(json: string | null | undefined): number {
  if (!json) return 0;
  try {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return 0;
    return parsed.length;
  } catch {
    // Malformed JSON — treat as "has at least one" so the UI never
    // under-reports a problem.
    return 1;
  }
}

function truncateTopic(text: string, max = 140): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + "…";
}

function safeJsonParse<T>(json: string | null | undefined, fallback: T): T {
  if (!json) return fallback;
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}

function toCanonicalDraftShape(raw: unknown): CandidateDetail["draft"] {
  const r = (raw ?? {}) as Record<string, unknown>;
  const options = Array.isArray(r.options)
    ? (r.options as unknown[]).map((o) => {
        const obj = (o ?? {}) as Record<string, unknown>;
        return {
          text: typeof obj.text === "string" ? obj.text : "",
          isCorrect: obj.isCorrect === true,
        };
      })
    : [];
  const sourceSegmentIds = Array.isArray(r.sourceSegmentIds)
    ? (r.sourceSegmentIds as unknown[]).filter((n) => typeof n === "number") as number[]
    : [];
  return {
    questionType: typeof r.questionType === "string" ? r.questionType : "",
    questionText: typeof r.questionText === "string" ? r.questionText : "",
    options,
    explanation: typeof r.explanation === "string" ? r.explanation : "",
    sourceSegmentIds,
  };
}

function mapValidation(v: {
  id: string;
  draftContentHash: string;
  validatorVersion: string;
  validatorSource: string;
  verdict: string;
  stage: string;
  errorsJson: string;
  flagsJson: string;
  runAt: Date;
}): CandidateDetailValidation {
  const errors = safeJsonParse<{ code?: unknown; message?: unknown }[]>(v.errorsJson, []);
  const flags = safeJsonParse<string[]>(v.flagsJson, []);
  return {
    id: v.id,
    draftContentHash: v.draftContentHash,
    validatorVersion: v.validatorVersion,
    validatorSource: v.validatorSource,
    verdict: v.verdict as Verdict,
    stage: v.stage,
    errors: errors.map((e) => ({
      code: typeof e?.code === "string" ? e.code : "",
      message: typeof e?.message === "string" ? e.message : "",
    })),
    flags: Array.isArray(flags) ? flags.filter((f) => typeof f === "string") : [],
    runAt: v.runAt,
  };
}

// ---------- Public API ----------

/**
 * List tenant-scoped candidates for the review queue. Cursor-paginated
 * via `(generatedAt DESC, id DESC)` — deterministic.
 */
export async function listCandidates(
  principal: Principal | null | undefined,
  clubId: string,
  pagination: ListPagination = {},
): Promise<CandidateQueueResult> {
  requireReadPermission(principal, clubId);

  const limit = Math.min(
    Math.max(1, pagination.limit ?? DEFAULT_LIMIT),
    MAX_LIMIT,
  );
  const states = pagination.states ?? null;

  const where: Record<string, unknown> = { clubId };
  if (states && states.length > 0) {
    where.state = { in: [...states] };
  }
  if (pagination.cursor) {
    // Cursor pagination semantics: return rows strictly AFTER the
    // provided id in (generatedAt DESC, id DESC) order.
    const cursorRow = await prisma.trainingQuestionAiDraft.findFirst({
      where: { id: pagination.cursor, clubId },
      select: { id: true, generatedAt: true },
    });
    if (cursorRow) {
      where.OR = [
        { generatedAt: { lt: cursorRow.generatedAt } },
        {
          AND: [
            { generatedAt: cursorRow.generatedAt },
            { id: { lt: cursorRow.id } },
          ],
        },
      ];
    }
  }

  // Fetch limit+1 so we can tell if there's a next page.
  const rows = await prisma.trainingQuestionAiDraft.findMany({
    where,
    orderBy: [{ generatedAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    select: {
      id: true,
      draftJson: true,
      state: true,
      contentHash: true,
      recordVersion: true,
      generatedAt: true,
      updatedAt: true,
      courseVersionId: true,
      validations: {
        orderBy: [{ runAt: "desc" }],
        take: 1,
        select: {
          verdict: true,
          validatorSource: true,
          errorsJson: true,
          flagsJson: true,
          runAt: true,
        },
      },
    },
  });

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor = hasMore ? page[page.length - 1].id : null;

  const mapped: CandidateQueueRow[] = page.map((r) => {
    const draft = toCanonicalDraftShape(safeJsonParse<unknown>(r.draftJson, {}));
    const v = r.validations[0];
    return {
      draftId: r.id,
      topic: truncateTopic(draft.questionText || "(unknown question)"),
      state: r.state as LifecycleState,
      contentHash: r.contentHash,
      recordVersion: r.recordVersion,
      generatedAt: r.generatedAt,
      updatedAt: r.updatedAt,
      courseVersionId: r.courseVersionId,
      latestVerdict: v ? (v.verdict as Verdict) : null,
      latestValidatorSource: v ? v.validatorSource : null,
      latestHardErrorCount: v ? countFromJson(v.errorsJson) : 0,
      latestAdvisoryCount: v ? countFromJson(v.flagsJson) : 0,
      latestValidationAt: v ? v.runAt : null,
    };
  });

  return {
    rows: mapped,
    nextCursor,
    limit,
    states,
  };
}

/**
 * Load one tenant-scoped candidate detail. Returns NULL (not throws)
 * when the candidate is not visible to the principal — the caller's
 * route-handler should map NULL to a 404 same-shape response so
 * cross-tenant probes cannot distinguish "wrong tenant" from "no row".
 */
export async function getCandidate(
  principal: Principal | null | undefined,
  clubId: string,
  draftId: string,
): Promise<CandidateDetail | null> {
  requireReadPermission(principal, clubId);

  // Tenant-scoped WHERE — single query, no inference from draftId alone.
  const d = await prisma.trainingQuestionAiDraft.findFirst({
    where: { id: draftId, clubId },
    select: {
      id: true,
      clubId: true,
      courseId: true,
      courseVersionId: true,
      state: true,
      contentHash: true,
      recordVersion: true,
      generatedAt: true,
      updatedAt: true,
      draftJson: true,
      sourceVideoSha256: true,
      resolvedTranscriptBuildId: true,
      groundingProjectionSha256: true,
      validations: {
        orderBy: [{ runAt: "desc" }],
        select: {
          id: true,
          draftContentHash: true,
          validatorVersion: true,
          validatorSource: true,
          verdict: true,
          stage: true,
          errorsJson: true,
          flagsJson: true,
          runAt: true,
        },
      },
      reviews: {
        orderBy: [{ reviewedAt: "desc" }],
        select: {
          id: true,
          disposition: true,
          reviewerNote: true,
          reviewedByUserId: true,
          reviewedAt: true,
          draftContentHash: true,
          validationId: true,
        },
      },
    },
  });
  if (!d) return null;

  const validations = d.validations.map(mapValidation);
  return {
    draftId: d.id,
    clubId: d.clubId,
    courseId: d.courseId,
    courseVersionId: d.courseVersionId,
    state: d.state as LifecycleState,
    contentHash: d.contentHash,
    recordVersion: d.recordVersion,
    generatedAt: d.generatedAt,
    updatedAt: d.updatedAt,
    draft: toCanonicalDraftShape(safeJsonParse<unknown>(d.draftJson, {})),
    sourceVideoSha256: d.sourceVideoSha256,
    resolvedTranscriptBuildId: d.resolvedTranscriptBuildId,
    groundingProjectionSha256: d.groundingProjectionSha256,
    latestValidation: validations[0] ?? null,
    historicalValidations: validations.slice(1),
    reviews: d.reviews.map((r) => ({
      id: r.id,
      disposition: r.disposition,
      reviewerNote: r.reviewerNote,
      reviewedByUserId: r.reviewedByUserId,
      reviewedAt: r.reviewedAt,
      draftContentHash: r.draftContentHash,
      validationId: r.validationId,
    })),
  };
}
