// EP-TRAIN-6D-4M (2026-11-05) — Authenticated evidence reader service.
//
// Composes the EP-TRAIN-6D-4K schema (TrainingTranscriptBuild +
// TrainingTranscriptSegment + TrainingGroundingProjection) and the
// EP-TRAIN-6D-4L ingestion-service canonical hashing to resolve, for
// a single AI-review candidate:
//
//   - the stored grounding projection (via the non-null FK on the
//     draft row),
//   - the server-recomputed sha256 of the projection body (defence-
//     in-depth: compared against both the projection row's stored
//     sha256 AND the draft's scalar groundingProjectionSha256),
//   - the transcript build row + its transcriber provenance,
//   - every CITED transcript segment (exact text + startSec + endSec
//     + per-segment flags), plus any segment that is cited but
//     excluded by pilot authorisation (16/17) or missing from the
//     authorised projection,
//   - validation state the UI already renders.
//
// Design principles honoured:
//   - READ-ONLY. No mutation path. No API route added (the detail
//     API route can be extended later; 4M consumes this through the
//     server page component).
//   - Tenant-scoped at every lookup. Same-shape 404 on cross-tenant
//     access (returns null; caller maps to 404 copy).
//   - Fail closed on evidence inconsistency. The three evidence-
//     integrity signals below are REFUSED at service layer — the
//     caller receives an `EvidenceIntegrityFailure` payload, NOT a
//     half-populated segment body:
//       * stored projection.sha256 ≠ draft.groundingProjectionSha256
//       * server-recomputed sha256 ≠ stored projection.sha256
//       * cited segmentIndex missing from the authorised projection
//         OR excluded by pilot authorisation (16/17)
//   - Never fabricates transcript text, timestamps, or verified-
//     correct answer labels.
//
// Historical 6D-4H candidates (groundingProjectionId IS NULL) resolve
// as `kind: "historical-unavailable"` — the UI renders the accepted
// "Historical evidence unavailable" treatment without ever synthesising
// segment bodies from the fixture SHA.

import { prisma as defaultPrisma } from "@/lib/prisma";
import type { PrismaClient } from "@prisma/client";
import type { Principal } from "@/lib/rbac";
import { hasPermission } from "@/lib/rbac";
import { canonicalise, sha256Hex } from "./content-hash";
import {
  buildCanonicalProjectionBody,
  projectionSha256,
} from "./grounding-canonical";

export type EvidenceKind =
  | "authentic"
  | "historical-unavailable"
  | "evidence-integrity-failure";

export type SegmentUnavailableReason =
  | "SEGMENT_NOT_IN_AUTHORISED_PROJECTION"
  | "SEGMENT_EXCLUDED_BY_AUTHORISATION"
  | "SEGMENT_NOT_PERSISTED";

export type IntegrityFailureCode =
  | "PROJECTION_HASH_MISMATCH_VS_DRAFT"
  | "PROJECTION_HASH_MISMATCH_VS_RECOMPUTE"
  | "CITED_SEGMENTS_UNRESOLVABLE"
  | "BUILD_MISSING_FOR_PROJECTION";

/** The segment indices that are refused as trusted grounding across
 *  the whole system. Duplicate of 4L's EXCLUDED_SEGMENT_INDICES —
 *  the reader intentionally does NOT import the writer's constant so
 *  the two surfaces stay independently verifiable. */
export const EXCLUDED_SEGMENT_INDICES: ReadonlySet<number> = Object.freeze(new Set([16, 17]));

export interface SourceMaterialSummary {
  readonly courseTitle: string | null;
  readonly versionTitle: string | null;
  readonly versionNumber: number | null;
  readonly videoStorageKeyPresent: boolean;
  readonly videoDurationSec: number | null;
}

export interface TranscriberProvenance {
  readonly transcriberName: string;
  readonly transcriberVersion: string;
  readonly transcriberModelName: string;
  readonly transcriberModelVersion: string;
  readonly producedAt: Date;
}

export interface CitedSegmentResolution {
  readonly segmentIndex: number;
  /** Non-null ONLY when the segment is both present in the authorised
   *  projection AND persisted in the transcript build. Null otherwise
   *  (see `unavailableReason`). */
  readonly text: string | null;
  readonly startSec: string | null;
  readonly endSec: string | null;
  readonly pendingReview: readonly string[];
  readonly sourceOrgMismatch: readonly string[];
  readonly uncertaintyWarning: string | null;
  readonly unavailableReason: SegmentUnavailableReason | null;
}

export interface AuthenticEvidence {
  readonly kind: "authentic";
  readonly projectionId: string;
  readonly projectionSha256: string;
  readonly transcriptBuildId: string;
  readonly transcriber: TranscriberProvenance;
  readonly sourceMaterial: SourceMaterialSummary;
  readonly sourceOrgMismatchFlagsPresent: boolean;
  readonly pendingReviewPresent: boolean;
  readonly citedSegments: readonly CitedSegmentResolution[];
  /** Video is playable + click-to-seek is allowed iff:
   *    1. videoStorageKeyPresent == true (set above), AND
   *    2. at least one citedSegment has non-null text + timestamps.
   *  Pre-computed here so the client never has to re-derive. */
  readonly videoSeekEnabled: boolean;
  /** The `TrainingCourseVersion.id` that owns the uploaded video.
   *  The UI streams via `/api/hr/training/versions/{id}/video`. */
  readonly videoSourceVersionId: string;
}

export interface HistoricalUnavailableEvidence {
  readonly kind: "historical-unavailable";
  readonly reason: "HISTORICAL_PILOT_NO_PROJECTION";
  readonly sourceMaterial: SourceMaterialSummary;
  /** Segment IDs the draft cites, rendered as bare numbers in the UI.
   *  Text + timestamps are NOT available. */
  readonly citedSegmentIndices: readonly number[];
  /** The 6D-4H historical candidates carry a `fixture-<label>` string
   *  in `groundingProjectionSha256`. Preserved verbatim so the UI
   *  continues to render the honest "fixture placeholder" callout. */
  readonly groundingProjectionFingerprint: string;
}

export interface EvidenceIntegrityFailure {
  readonly kind: "evidence-integrity-failure";
  readonly code: IntegrityFailureCode;
  /** Opaque safe-to-render diagnostic. Hashes are NOT included.
   *  The UI surfaces this to the reviewer with "contact support" copy. */
  readonly safeMessage: string;
  readonly sourceMaterial: SourceMaterialSummary;
  /** Segment indices the draft cited; rendered as numbers only. */
  readonly citedSegmentIndices: readonly number[];
}

export type CandidateEvidence =
  | AuthenticEvidence
  | HistoricalUnavailableEvidence
  | EvidenceIntegrityFailure;

/** Tenant-scoped evidence resolution for a single AI-review candidate.
 *
 *  Returns:
 *    - `null` when the draft is not visible to the principal (cross-
 *      tenant / no row). Caller maps to a 404 same-shape response.
 *    - an EvidenceIntegrityFailure when the stored row's provenance
 *      cannot be verified (hash mismatch, missing build, unresolvable
 *      cited segments). Fail-closed.
 *    - a HistoricalUnavailableEvidence when the draft is a 6D-4H
 *      historical row (groundingProjectionId IS NULL).
 *    - an AuthenticEvidence payload otherwise.
 *
 *  Never throws for a legitimate "no evidence here" case. Throws only
 *  on UNAUTHENTICATED / FORBIDDEN. */
export async function resolveCandidateEvidence(
  principal: Principal | null | undefined,
  clubId: string,
  draftId: string,
  opts: { prisma?: PrismaClient } = {},
): Promise<CandidateEvidence | null> {
  const prisma = opts.prisma ?? defaultPrisma;
  if (!principal) {
    throw new EvidenceReaderError("UNAUTHENTICATED", 401);
  }
  if (!hasPermission(principal, clubId, "hr:training:ai:read")) {
    throw new EvidenceReaderError("FORBIDDEN", 403);
  }

  // Load the draft + its course-version context + the projection FK +
  // the (optional) projection row + the transcript build row. Every
  // join scoped by clubId.
  const draft = await prisma.trainingQuestionAiDraft.findFirst({
    where: { id: draftId, clubId },
    select: {
      id: true,
      clubId: true,
      courseVersionId: true,
      draftJson: true,
      sourceVideoSha256: true,
      resolvedTranscriptBuildId: true,
      groundingProjectionSha256: true,
      groundingProjectionId: true,
      groundingProjection: {
        select: {
          id: true,
          clubId: true,
          courseVersionId: true,
          sha256: true,
          sourceVideoSha256: true,
          resolvedTranscriptBuildId: true,
          passagesJson: true,
          excludedPassagesJson: true,
          sourceOrgMismatchFlagsPresent: true,
          pendingReviewPresent: true,
        },
      },
      courseVersion: {
        select: {
          id: true,
          title: true,
          version: true,
          videoStorageKey: true,
          videoDurationSec: true,
          course: {
            select: { clubId: true, title: true },
          },
        },
      },
    },
  });
  if (!draft) return null;

  // Tenant assertion on the course join is belt-and-braces — the
  // draft's own clubId already equals the request's clubId, but a
  // mis-joined row would surface here and we abort to a safe 404.
  if (draft.courseVersion?.course?.clubId !== clubId) return null;

  const citedSegmentIndices = citedSegmentIndicesOf(draft.draftJson);
  const sourceMaterial = sourceMaterialOf(draft.courseVersion);

  // Branch 1 — historical 6D-4H candidate. `groundingProjectionId` is
  // NULL and the stored hash is a fixture placeholder.
  if (!draft.groundingProjectionId || !draft.groundingProjection) {
    return {
      kind: "historical-unavailable",
      reason: "HISTORICAL_PILOT_NO_PROJECTION",
      sourceMaterial,
      citedSegmentIndices,
      groundingProjectionFingerprint: draft.groundingProjectionSha256,
    };
  }

  // Branch 2 — the FK is populated. The projection must belong to the
  // same clubId AND the same courseVersionId as the draft.
  const projection = draft.groundingProjection;
  if (projection.clubId !== clubId || projection.courseVersionId !== draft.courseVersionId) {
    return integrityFailure({
      code: "PROJECTION_HASH_MISMATCH_VS_DRAFT",
      safeMessage: "Evidence integrity check failed. The stored grounding projection does not belong to this candidate's tenant or course version. Contact support.",
      sourceMaterial,
      citedSegmentIndices,
    });
  }

  // Integrity check #1 — stored projection sha256 must equal the
  // draft's scalar groundingProjectionSha256.
  if (projection.sha256 !== draft.groundingProjectionSha256) {
    return integrityFailure({
      code: "PROJECTION_HASH_MISMATCH_VS_DRAFT",
      safeMessage: "Evidence integrity check failed. The stored grounding projection fingerprint does not match the candidate's recorded fingerprint. Contact support.",
      sourceMaterial,
      citedSegmentIndices,
    });
  }

  // Parse the projection's passages array once — we need both the
  // membership set AND the canonical body for the recompute check.
  const passages = safeParsePassages(projection.passagesJson);
  const excluded = safeParsePassages(projection.excludedPassagesJson);
  if (!passages) {
    return integrityFailure({
      code: "PROJECTION_HASH_MISMATCH_VS_RECOMPUTE",
      safeMessage: "Evidence integrity check failed. The stored grounding projection body is unreadable. Contact support.",
      sourceMaterial,
      citedSegmentIndices,
    });
  }

  // Integrity check #2 — recompute the canonical body hash + compare.
  // EP-TRAIN-4Y-S §9 — both writer and reader call the same helper
  // (`buildCanonicalProjectionBody` + `projectionSha256`) so the stored
  // sha256 is byte-stable across the materialiser → DB → reader loop.
  const recomputedSha256 = projectionSha256(
    buildCanonicalProjectionBody({
      tenantId: clubId,
      courseVersionId: projection.courseVersionId,
      sourceVideoSha256: projection.sourceVideoSha256,
      resolvedTranscriptBuildId: projection.resolvedTranscriptBuildId,
      passages: passages.map((p) => ({
        passageId: Number(p.passageId),
        sourceSegmentIds: Array.isArray(p.sourceSegmentIds)
          ? (p.sourceSegmentIds as readonly number[])
          : [],
        sourceStartSec: Number(p.sourceStartSec),
        sourceEndSec: Number(p.sourceEndSec),
        text: String(p.text ?? ""),
        citationHandle: String(p.citationHandle ?? ""),
        flags: (p.flags ?? null) as never,
      })),
      excludedPassages: (excluded ?? []).map((e) => ({
        passageId: Number(e.passageId),
        sourceSegmentIds: Array.isArray(e.sourceSegmentIds)
          ? (e.sourceSegmentIds as readonly number[])
          : [],
        reason: (e as unknown as { reason?: unknown }).reason,
      })),
    }),
  );
  if (recomputedSha256 !== projection.sha256) {
    return integrityFailure({
      code: "PROJECTION_HASH_MISMATCH_VS_RECOMPUTE",
      safeMessage: "Evidence integrity check failed. The stored grounding projection body does not hash to its recorded fingerprint. Contact support.",
      sourceMaterial,
      citedSegmentIndices,
    });
  }

  // Resolve the transcript build row by (clubId, sourceVideoSha256,
  // resolvedTranscriptBuildId). The FK is scoped on segments, not on
  // the projection directly — the projection carries the same two
  // hashes so they must agree.
  if (
    projection.sourceVideoSha256 !== draft.sourceVideoSha256 ||
    projection.resolvedTranscriptBuildId !== draft.resolvedTranscriptBuildId
  ) {
    return integrityFailure({
      code: "PROJECTION_HASH_MISMATCH_VS_DRAFT",
      safeMessage: "Evidence integrity check failed. The grounding projection does not reference the same source video or transcript build as this candidate. Contact support.",
      sourceMaterial,
      citedSegmentIndices,
    });
  }

  const build = await prisma.trainingTranscriptBuild.findUnique({
    where: {
      clubId_sourceVideoSha256_resolvedTranscriptBuildId: {
        clubId,
        sourceVideoSha256: projection.sourceVideoSha256,
        resolvedTranscriptBuildId: projection.resolvedTranscriptBuildId,
      },
    },
    select: {
      id: true,
      transcriberName: true,
      transcriberVersion: true,
      transcriberModelName: true,
      transcriberModelVersion: true,
      producedAt: true,
    },
  });
  if (!build) {
    return integrityFailure({
      code: "BUILD_MISSING_FOR_PROJECTION",
      safeMessage: "Evidence integrity check failed. The projection references a transcript build that is not persisted. Contact support.",
      sourceMaterial,
      citedSegmentIndices,
    });
  }

  // Build the set of segment indices authorised by this projection.
  const authorisedSegmentIndices = new Set<number>();
  for (const p of passages) {
    const sids = Array.isArray(p.sourceSegmentIds) ? p.sourceSegmentIds : [];
    for (const sid of sids) {
      if (typeof sid === "number" && Number.isFinite(sid)) {
        authorisedSegmentIndices.add(sid);
      }
    }
  }

  // Load every segment for the cited indices in one query. Partition
  // the response by whether each cited index is:
  //   - excluded by authorisation (16/17 OR appears in the projection's
  //     excludedPassages),
  //   - not in the projection's authorised set,
  //   - persisted on the build (populated with text + timestamps).
  const excludedSegmentIndices = new Set<number>();
  for (const e of excluded ?? []) {
    const sids = Array.isArray(e.sourceSegmentIds) ? e.sourceSegmentIds : [];
    for (const sid of sids) {
      if (typeof sid === "number" && Number.isFinite(sid)) {
        excludedSegmentIndices.add(sid);
      }
    }
  }

  const persistedSegments = await prisma.trainingTranscriptSegment.findMany({
    where: {
      clubId,
      transcriptBuildId: build.id,
      segmentIndex: { in: citedSegmentIndices },
    },
    select: {
      segmentIndex: true,
      text: true,
      startSec: true,
      endSec: true,
      pendingReviewJson: true,
      sourceOrgMismatchJson: true,
      uncertaintyWarning: true,
    },
    orderBy: [{ segmentIndex: "asc" }],
  });
  const persistedByIndex = new Map(persistedSegments.map((s) => [s.segmentIndex, s]));

  const resolvedSegments: CitedSegmentResolution[] = citedSegmentIndices.map((idx) => {
    if (EXCLUDED_SEGMENT_INDICES.has(idx) || excludedSegmentIndices.has(idx)) {
      return unresolvedSegment(idx, "SEGMENT_EXCLUDED_BY_AUTHORISATION");
    }
    if (!authorisedSegmentIndices.has(idx)) {
      return unresolvedSegment(idx, "SEGMENT_NOT_IN_AUTHORISED_PROJECTION");
    }
    const row = persistedByIndex.get(idx);
    if (!row) {
      return unresolvedSegment(idx, "SEGMENT_NOT_PERSISTED");
    }
    return {
      segmentIndex: idx,
      text: row.text,
      startSec: row.startSec.toString(),
      endSec: row.endSec.toString(),
      pendingReview: safeJsonArray(row.pendingReviewJson),
      sourceOrgMismatch: safeJsonArray(row.sourceOrgMismatchJson),
      uncertaintyWarning: row.uncertaintyWarning ?? null,
      unavailableReason: null,
    };
  });

  // Fail-closed when NOTHING cited is resolvable. (Partial resolution
  // is OK and surfaces as per-segment unavailable reasons, but a 100%
  // cited-missing case is a provenance failure.)
  const anyResolved = resolvedSegments.some((s) => s.unavailableReason === null);
  if (citedSegmentIndices.length > 0 && !anyResolved) {
    return integrityFailure({
      code: "CITED_SEGMENTS_UNRESOLVABLE",
      safeMessage: "Evidence integrity check failed. None of the cited segments could be resolved to authorised persisted transcript text. Contact support.",
      sourceMaterial,
      citedSegmentIndices,
    });
  }

  return {
    kind: "authentic",
    projectionId: projection.id,
    projectionSha256: projection.sha256,
    transcriptBuildId: build.id,
    transcriber: {
      transcriberName: build.transcriberName,
      transcriberVersion: build.transcriberVersion,
      transcriberModelName: build.transcriberModelName,
      transcriberModelVersion: build.transcriberModelVersion,
      producedAt: build.producedAt,
    },
    sourceMaterial,
    sourceOrgMismatchFlagsPresent: projection.sourceOrgMismatchFlagsPresent,
    pendingReviewPresent: projection.pendingReviewPresent,
    citedSegments: resolvedSegments,
    videoSeekEnabled: sourceMaterial.videoStorageKeyPresent && anyResolved,
    videoSourceVersionId: draft.courseVersionId,
  };
}

// ---------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------

export class EvidenceReaderError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status: number) {
    super(code);
    this.name = "EvidenceReaderError";
    this.code = code;
    this.status = status;
  }
}

function citedSegmentIndicesOf(draftJson: string | null | undefined): number[] {
  if (!draftJson) return [];
  try {
    const parsed = JSON.parse(draftJson) as Record<string, unknown>;
    const ids = parsed?.sourceSegmentIds;
    if (!Array.isArray(ids)) return [];
    const out: number[] = [];
    for (const v of ids) {
      if (typeof v === "number" && Number.isFinite(v) && Number.isInteger(v) && v >= 0) {
        out.push(v);
      }
    }
    return out;
  } catch {
    return [];
  }
}

function sourceMaterialOf(
  version: {
    title: string | null;
    version: number | null;
    videoStorageKey: string | null;
    videoDurationSec: number | null;
    course: { title: string | null } | null;
  } | null,
): SourceMaterialSummary {
  return {
    courseTitle: version?.course?.title ?? null,
    versionTitle: version?.title ?? null,
    versionNumber: version?.version ?? null,
    videoStorageKeyPresent: Boolean(version?.videoStorageKey),
    videoDurationSec: version?.videoDurationSec ?? null,
  };
}

interface RawPassage {
  readonly passageId?: unknown;
  readonly sourceSegmentIds?: unknown;
  readonly sourceStartSec?: unknown;
  readonly sourceEndSec?: unknown;
  readonly text?: unknown;
  readonly citationHandle?: unknown;
  readonly flags?: unknown;
}

function safeParsePassages(json: string | null | undefined): RawPassage[] | null {
  if (!json) return null;
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? (v as RawPassage[]) : null;
  } catch {
    return null;
  }
}

function safeJsonArray(s: string | null | undefined): string[] {
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function unresolvedSegment(idx: number, reason: SegmentUnavailableReason): CitedSegmentResolution {
  return {
    segmentIndex: idx,
    text: null,
    startSec: null,
    endSec: null,
    pendingReview: [],
    sourceOrgMismatch: [],
    uncertaintyWarning: null,
    unavailableReason: reason,
  };
}

function integrityFailure(opts: {
  code: IntegrityFailureCode;
  safeMessage: string;
  sourceMaterial: SourceMaterialSummary;
  citedSegmentIndices: readonly number[];
}): EvidenceIntegrityFailure {
  return {
    kind: "evidence-integrity-failure",
    code: opts.code,
    safeMessage: opts.safeMessage,
    sourceMaterial: opts.sourceMaterial,
    citedSegmentIndices: opts.citedSegmentIndices,
  };
}
