// EP-TRAIN-4Y-S §9 — canonical projection body + sha256, shared by
// the materialiser (writer) and the evidence-reader (reader).
//
// Before this helper landed, the two sides constructed subtly different
// in-memory objects before hashing — the writer emitted `versionId`
// while the reader expected `courseVersionId`, and the writer included
// metadata fields (`courseId`, `sourceOrgMismatchFlagsPresent`,
// `pendingReviewPresent`) that the reader did NOT include. Result:
// stored `projection.sha256` != reader's recomputed sha256 for every
// newly-materialised projection, producing `PROJECTION_HASH_MISMATCH_VS_RECOMPUTE`
// at promote-time (surfaced by the 4Y-R acceptance walk).
//
// This module makes the canonical body a single source of truth. Both
// sides call `buildCanonicalProjectionBody` + `projectionSha256`; the
// sha256 is now stable round-trip: materialiser → DB → reader.
//
// The reader-side normalisation of passages (filling `flags` defaults
// byte-identically) is preserved: the writer already emits passages in
// the normalised shape, and the reader re-asserts the shape before
// hashing. The two shapes are byte-equal for well-formed projections.

import { canonicalise, sha256Hex } from "./content-hash";

export interface CanonicalProjectionPassage {
  readonly passageId: number;
  readonly sourceSegmentIds: readonly number[];
  readonly sourceStartSec: number;
  readonly sourceEndSec: number;
  readonly text: string;
  readonly citationHandle: string;
  readonly flags: {
    readonly pendingReview: readonly string[];
    readonly sourceOrgMismatch: readonly string[];
    readonly uncertaintyWarning: string | null;
  };
}

export interface CanonicalProjectionExcluded {
  readonly passageId: number;
  readonly sourceSegmentIds: readonly number[];
  readonly reason: unknown;
}

export interface CanonicalProjectionBody {
  readonly schemaVersion: "training-grounding-v1";
  readonly operation: "GENERATE_DRAFT_QUESTIONS";
  readonly tenantId: string;
  readonly courseVersionId: string;
  readonly sourceVideoSha256: string;
  readonly resolvedTranscriptBuildId: string;
  readonly passages: readonly CanonicalProjectionPassage[];
  readonly excludedPassages: readonly CanonicalProjectionExcluded[];
}

/** Normalise a passage to the byte-stable canonical shape. The reader's
 *  re-normalisation applies the SAME defaults as the writer emits for
 *  attested segments, so this function produces the same output for a
 *  freshly-materialised passage and a passage re-read from the DB. */
export function normaliseCanonicalPassage(p: {
  passageId: number;
  sourceSegmentIds: readonly number[];
  sourceStartSec: number;
  sourceEndSec: number;
  text: string;
  citationHandle: string;
  flags?: {
    pendingReview?: readonly unknown[];
    sourceOrgMismatch?: readonly unknown[];
    uncertaintyWarning?: unknown;
  } | null;
}): CanonicalProjectionPassage {
  const flags = p.flags ?? {};
  return {
    passageId: p.passageId,
    sourceSegmentIds: [...p.sourceSegmentIds],
    sourceStartSec: p.sourceStartSec,
    sourceEndSec: p.sourceEndSec,
    text: p.text,
    citationHandle: p.citationHandle,
    flags: {
      pendingReview: Array.isArray(flags.pendingReview)
        ? flags.pendingReview.map(String)
        : [],
      sourceOrgMismatch: Array.isArray(flags.sourceOrgMismatch)
        ? flags.sourceOrgMismatch.map(String)
        : [],
      uncertaintyWarning:
        typeof flags.uncertaintyWarning === "string" ? flags.uncertaintyWarning : null,
    },
  };
}

export function normaliseCanonicalExcluded(e: {
  passageId: number;
  sourceSegmentIds: readonly number[];
  reason?: unknown;
}): CanonicalProjectionExcluded {
  return {
    passageId: e.passageId,
    sourceSegmentIds: [...e.sourceSegmentIds],
    reason: e.reason ?? null,
  };
}

/** Assemble the canonical body. Passages + excluded are passed through
 *  the per-row normalisers so writer and reader end up with the same
 *  bytes. */
export function buildCanonicalProjectionBody(input: {
  tenantId: string;
  courseVersionId: string;
  sourceVideoSha256: string;
  resolvedTranscriptBuildId: string;
  passages: readonly Parameters<typeof normaliseCanonicalPassage>[0][];
  excludedPassages: readonly Parameters<typeof normaliseCanonicalExcluded>[0][];
}): CanonicalProjectionBody {
  return {
    schemaVersion: "training-grounding-v1",
    operation: "GENERATE_DRAFT_QUESTIONS",
    tenantId: input.tenantId,
    courseVersionId: input.courseVersionId,
    sourceVideoSha256: input.sourceVideoSha256,
    resolvedTranscriptBuildId: input.resolvedTranscriptBuildId,
    passages: input.passages.map(normaliseCanonicalPassage),
    excludedPassages: input.excludedPassages.map(normaliseCanonicalExcluded),
  };
}

/** sha256 of the canonicalised projection body. Matches the string
 *  `content-hash.ts` produces (the generator-pipeline canonicaliser),
 *  so a draft's `groundingProjectionSha256` and the projection row's
 *  `sha256` column are byte-stable under round-trip. */
export function projectionSha256(body: CanonicalProjectionBody): string {
  return sha256Hex(canonicalise(body));
}
