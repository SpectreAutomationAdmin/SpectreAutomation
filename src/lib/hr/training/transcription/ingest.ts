// EP-TRAIN-6D-4L (2026-11-05) — Authenticated transcript + grounding-
// projection evidence ingestion services.
//
// Write-path only. No worker wiring, no API routes, no UI, no
// inference. The three services below are the SOLE authorised writers
// for the three evidence tables introduced in EP-TRAIN-6D-4K:
//   - persistTranscriptBuild
//   - persistTranscriptSegments
//   - persistGroundingProjection
//
// Each service:
//   1. Requires the `hr:training:transcription:write` permission on
//      the target `clubId`. No role currently holds this permission
//      (per 4L directive + 4K slice §9). It exists in the catalogue
//      awaiting a future narrowly-authorised ingestion identity.
//   2. Performs the complete ownership chain check INSIDE the same
//      database transaction as the write. Tenant / course / version
//      / build mismatches abort the transaction — no partial rows.
//   3. Treats repeated identical requests as idempotent no-ops
//      (returns `created: false` + the existing row). Repeated
//      requests with DIFFERENT content for the same identity are
//      treated as TAMPER and throw.
//   4. Writes a durable audit row (AuditLog via `audit()`) AFTER the
//      transaction commits. The per-draft lifecycle table
//      TrainingQuestionAiStateTransition is NOT written by 4L — these
//      services deal with pre-draft evidence, not drafts.
//   5. NEVER populates `verifiedCorrectAnswerSnapshotJson`. That
//      column is reserved for 4N (approval route) and must be
//      written by a qualified reviewer decision with exact immutable
//      draft + content-hash binding + server-side eligibility checks.
//      Verified-answer provenance is NOT inferred from any 4L write.
//
// Historical fixture isolation:
//   - The eight EP-TRAIN-6D-4H historical candidates carry
//     `groundingProjectionSha256` values of the form `fixture-<label>`
//     and NULL `groundingProjectionId`. These services NEVER populate
//     either field for a historical row; nor do they upgrade a
//     historical draft's trust classification.
//   - Pilot restrictions `excludedSegmentIds: [16, 17]` are refused
//     from any grounding projection's `passagesJson`; the ingestion
//     service rejects any passage that cites an excluded segment.
//
// Trust classification:
//   - Authoritative evidence: rows written here through the three
//     services below, bound to a real `TrainingCourseVersion.videoSha256`.
//   - Historical pilot evidence: the eight 6D-4H candidates. Never
//     promoted by 4L.
//   - Fixture placeholders: `groundingProjectionSha256 LIKE 'fixture-%'`.
//     Never promoted by 4L.
//   - Unverified model explanations: the Lite draft's `explanation`
//     string. NOT authoritative transcript evidence; the ingestion
//     service NEVER consumes or trusts it.

import { createHash } from "node:crypto";
import { Prisma, PrismaClient } from "@prisma/client";
import type { TrainingTranscriptBuild, TrainingTranscriptSegment, TrainingGroundingProjection } from "@prisma/client";
import { prisma as defaultPrisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import { type Principal, requirePermission } from "@/lib/rbac";
import { AppError, ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { canonicalise, sha256Hex } from "@/lib/hr/training/ai-review/content-hash";

export type TxClient = Prisma.TransactionClient | PrismaClient;

/** The segment indices the EP-TRAIN-6C pilot authorisation excludes
 *  from trusted grounding. Hard-coded here because the exclusion is a
 *  property of the SOURCE VIDEO, not the pilot authorisation —
 *  segments 16 and 17 of the Staff Orientation video are unverified
 *  regardless of which pilot cites them.
 *
 *  Per 4L directive: "Unverified transcript segments 16 and 17 remain
 *  excluded from eligible grounding." If a future, differently-sourced
 *  video legitimately contains trustworthy segments 16 and 17, the
 *  exclusion must be moved to a per-video configuration before this
 *  service can accept projections that cite them. */
export const EXCLUDED_SEGMENT_INDICES: ReadonlySet<number> = Object.freeze(new Set([16, 17]));

const HEX_SHA256_RE = /^[0-9a-f]{64}$/;
// Accepts Prisma CUIDs AND any tenant-/fixture-shaped id of
// [A-Za-z0-9_-]{6,60}. The real security check is the ownership query
// that runs INSIDE the transaction; this regex is a shape guard
// against obviously-invalid inputs and SQL injection surface.
const ID_SHAPE_RE = /^[A-Za-z0-9_-]{6,60}$/;

// ---------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------

export interface PersistTranscriptBuildInput {
  /** The `TrainingCourseVersion.id` that hosts the source video. The
   *  service verifies this version belongs to `clubId` AND that its
   *  `videoSha256` equals `sourceVideoSha256`. */
  readonly courseVersionId: string;
  /** SHA-256 (64 hex) of the exact MP4 bytes uploaded to the version. */
  readonly sourceVideoSha256: string;
  /** SHA-256 (64 hex) of the deterministic transcription-run output.
   *  Within `(clubId, sourceVideoSha256)` this is unique. */
  readonly resolvedTranscriptBuildId: string;
  /** e.g. "faster-whisper". Open-ended text; the ingestion contract
   *  records the value supplied by the caller rather than assuming a
   *  global default (per founder decision §4 of 4K acceptance). */
  readonly transcriberName: string;
  readonly transcriberVersion: string;
  readonly transcriberModelName: string;
  readonly transcriberModelVersion: string;
  /** SHA-256 (64 hex) of the deterministic config JSON used by the
   *  transcription run. */
  readonly transcriberConfigSha256: string;
  readonly producedAt: Date;
}

export interface PersistTranscriptBuildResult {
  readonly build: TrainingTranscriptBuild;
  /** `true` when a new row was inserted. `false` when the exact same
   *  build identity already existed and this call was a no-op. */
  readonly created: boolean;
}

export interface PersistTranscriptSegmentInput {
  readonly segmentIndex: number;
  readonly text: string;
  /** Seconds, accepts number | string | Prisma.Decimal. Stored as
   *  NUMERIC in Postgres; the service never does float math beyond
   *  input-validation range checks. */
  readonly startSec: number | string | Prisma.Decimal;
  readonly endSec: number | string | Prisma.Decimal;
  readonly pendingReview?: readonly string[];
  readonly sourceOrgMismatch?: readonly string[];
  readonly uncertaintyWarning?: string | null;
}

export interface PersistTranscriptSegmentsInput {
  /** Defence-in-depth: the caller must re-assert the build identity
   *  it intends to write into. The service refuses when this does not
   *  match the build row's `resolvedTranscriptBuildId`. */
  readonly expectedResolvedTranscriptBuildId: string;
  readonly segments: readonly PersistTranscriptSegmentInput[];
}

export interface PersistTranscriptSegmentsResult {
  readonly created: number;
  /** Segments that already existed with IDENTICAL content. */
  readonly idempotentSkipped: number;
  readonly segmentIndices: readonly number[];
}

export interface PersistGroundingProjectionPassageInput {
  readonly passageId: number;
  readonly sourceSegmentIds: readonly number[];
  readonly sourceStartSec: number;
  readonly sourceEndSec: number;
  readonly text: string;
  readonly citationHandle: string;
  readonly flags?: {
    readonly pendingReview?: readonly string[];
    readonly sourceOrgMismatch?: readonly string[];
    readonly uncertaintyWarning?: string | null;
  };
}

export interface PersistGroundingProjectionExcludedPassageInput {
  readonly passageId: number;
  readonly sourceSegmentIds: readonly number[];
  readonly reason: string;
}

export interface PersistGroundingProjectionInput {
  readonly courseVersionId: string;
  readonly sourceVideoSha256: string;
  readonly resolvedTranscriptBuildId: string;
  readonly passages: readonly PersistGroundingProjectionPassageInput[];
  readonly excludedPassages?: readonly PersistGroundingProjectionExcludedPassageInput[];
  readonly authoredAt: Date;
  /** Optional client-supplied canonical SHA-256. When provided, the
   *  service recomputes server-side and refuses on disagreement. The
   *  server's recomputed hash is the authoritative identity. */
  readonly clientSuppliedSha256?: string;
}

export interface PersistGroundingProjectionResult {
  readonly projection: TrainingGroundingProjection;
  readonly created: boolean;
  /** The authoritative server-recomputed sha256 of the projection. */
  readonly sha256: string;
}

// ---------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------

function assertHexSha256(value: unknown, path: string): asserts value is string {
  if (typeof value !== "string" || !HEX_SHA256_RE.test(value)) {
    throw new ValidationError([{ path, message: `${path} must be a 64-character lower-case hex SHA-256` }]);
  }
}

function assertIdShape(value: unknown, path: string): asserts value is string {
  if (typeof value !== "string" || !ID_SHAPE_RE.test(value)) {
    throw new ValidationError([{ path, message: `${path} must be a 6-60 char [A-Za-z0-9_-] identifier` }]);
  }
}

function toDecimal(value: number | string | Prisma.Decimal, path: string): Prisma.Decimal {
  if (value instanceof Prisma.Decimal) {
    if (!value.isFinite()) {
      throw new ValidationError([{ path, message: `${path} must be a finite number` }]);
    }
    return value;
  }
  const asStr = typeof value === "number" ? String(value) : value;
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new ValidationError([{ path, message: `${path} must be a finite number` }]);
  }
  try {
    const d = new Prisma.Decimal(asStr);
    if (!d.isFinite()) {
      throw new ValidationError([{ path, message: `${path} must be a finite number` }]);
    }
    return d;
  } catch {
    throw new ValidationError([{ path, message: `${path} is not a valid decimal` }]);
  }
}

/** Canonical JSON of the projection body. The same deterministic shape
 *  the Modal server-side canonicaliser produces for the grounding
 *  projection, so a client-supplied sha256 can be verified. */
function canonicalProjectionBody(input: {
  tenantId: string;
  courseVersionId: string;
  sourceVideoSha256: string;
  resolvedTranscriptBuildId: string;
  passages: readonly PersistGroundingProjectionPassageInput[];
  excludedPassages: readonly PersistGroundingProjectionExcludedPassageInput[];
}): string {
  // Normalise passage shape to match the upstream GroundingProjection
  // type in src/lib/training/ai-generation/types.ts. Fields are
  // alphabetised by the canonicaliser automatically.
  const passages = input.passages.map((p) => ({
    passageId: p.passageId,
    sourceSegmentIds: [...p.sourceSegmentIds],
    sourceStartSec: p.sourceStartSec,
    sourceEndSec: p.sourceEndSec,
    text: p.text,
    citationHandle: p.citationHandle,
    flags: {
      pendingReview: [...(p.flags?.pendingReview ?? [])],
      sourceOrgMismatch: [...(p.flags?.sourceOrgMismatch ?? [])],
      uncertaintyWarning: p.flags?.uncertaintyWarning ?? null,
    },
  }));
  const excluded = input.excludedPassages.map((e) => ({
    passageId: e.passageId,
    sourceSegmentIds: [...e.sourceSegmentIds],
    reason: e.reason,
  }));
  return canonicalise({
    schemaVersion: "training-grounding-v1",
    operation: "GENERATE_DRAFT_QUESTIONS",
    tenantId: input.tenantId,
    courseVersionId: input.courseVersionId,
    sourceVideoSha256: input.sourceVideoSha256,
    resolvedTranscriptBuildId: input.resolvedTranscriptBuildId,
    passages,
    excludedPassages: excluded,
  });
}

/** Throws unless the caller is non-null AND holds the ingestion
 *  permission on the target club. Delegates to `requirePermission`,
 *  which handles the Principal-null + Forbidden branches. */
function requireIngestPermission(principal: Principal | null | undefined, clubId: string): asserts principal is Principal {
  requirePermission(principal ?? null, clubId, "hr:training:transcription:write");
}

/** Prisma unique-violation code. Raced inserts between concurrent
 *  transactions surface this on the losing side even when both saw
 *  `findUnique = null` inside their own snapshot. */
const PG_UNIQUE_VIOLATION = "P2002";

/** Runs a Prisma transaction and, on a losing-side P2002 unique-
 *  violation, retries the transaction once. The retry's `findUnique`
 *  now sees the winning write and returns `created: false`. The retry
 *  budget is 1 — a second P2002 after a retry indicates a corrupted
 *  caller (e.g. three concurrent writers with different content
 *  collapsing through this service), and we surface the raw Prisma
 *  error so the caller can diagnose. */
async function runWithUniqueRetry<T>(
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err && typeof err === "object" && (err as { code?: unknown }).code === PG_UNIQUE_VIOLATION) {
      // Second attempt — the losing side now sees the winner.
      return await fn();
    }
    throw err;
  }
}

/** Hash-redacted representation of a build row for audit meta. */
function buildIdentityForAudit(b: TrainingTranscriptBuild): Record<string, unknown> {
  return {
    buildId: b.id,
    sourceVideoSha256: b.sourceVideoSha256,
    resolvedTranscriptBuildId: b.resolvedTranscriptBuildId,
    transcriberName: b.transcriberName,
    transcriberVersion: b.transcriberVersion,
    transcriberModelName: b.transcriberModelName,
    transcriberModelVersion: b.transcriberModelVersion,
  };
}

// ---------------------------------------------------------------------
// Service #1 — persistTranscriptBuild
// ---------------------------------------------------------------------

/**
 * Persist (or idempotently re-confirm) a transcription-run row.
 *
 * The transaction performs:
 *   1. Permission assertion inside the tx.
 *   2. Course-version lookup + ownership chain validation
 *      (version.courseId.clubId == clubId AND version.videoSha256 ==
 *      input.sourceVideoSha256).
 *   3. Idempotent upsert on the (clubId, sourceVideoSha256,
 *      resolvedTranscriptBuildId) unique key.
 *   4. On pre-existing match: drift check. If any field differs from
 *      the stored row, throws ConflictError without mutating anything.
 *
 * Post-commit:
 *   5. audit() emits `training.transcript.build.ingested` with
 *      non-sensitive metadata (hashes + identifiers only).
 */
export async function persistTranscriptBuild(
  principal: Principal | null,
  clubId: string,
  input: PersistTranscriptBuildInput,
  opts: { prisma?: PrismaClient } = {},
): Promise<PersistTranscriptBuildResult> {
  const db = opts.prisma ?? defaultPrisma;

  // Input validation (pre-tx, so bad input doesn't cost a round trip).
  requireIngestPermission(principal, clubId);
  assertIdShape(input.courseVersionId, "courseVersionId");
  assertHexSha256(input.sourceVideoSha256, "sourceVideoSha256");
  assertHexSha256(input.resolvedTranscriptBuildId, "resolvedTranscriptBuildId");
  assertHexSha256(input.transcriberConfigSha256, "transcriberConfigSha256");
  for (const field of ["transcriberName", "transcriberVersion", "transcriberModelName", "transcriberModelVersion"] as const) {
    if (typeof input[field] !== "string" || input[field].length === 0 || input[field].length > 256) {
      throw new ValidationError([{ path: field, message: `${field} must be a non-empty string ≤ 256 chars` }]);
    }
  }
  if (!(input.producedAt instanceof Date) || Number.isNaN(input.producedAt.getTime())) {
    throw new ValidationError([{ path: "producedAt", message: "producedAt must be a valid Date" }]);
  }

  const tx = await runWithUniqueRetry(() => db.$transaction(async (tx) => {
    // Permission re-check inside the tx is a defence-in-depth measure
    // against the edge case where principal mutation races the
    // transaction. requirePermission is pure (no DB I/O).
    requireIngestPermission(principal, clubId);

    // Ownership chain: TrainingCourseVersion must belong to the club
    // AND its videoSha256 must match the input.
    const version = await tx.trainingCourseVersion.findUnique({
      where: { id: input.courseVersionId },
      select: {
        id: true,
        videoSha256: true,
        course: { select: { clubId: true } },
      },
    });
    if (!version) throw new NotFoundError("TrainingCourseVersion", input.courseVersionId);
    if (version.course.clubId !== clubId) {
      throw new NotFoundError("TrainingCourseVersion", input.courseVersionId);
    }
    if (!version.videoSha256) {
      throw new ValidationError([{
        path: "sourceVideoSha256",
        message: "Course version has no uploaded video; cannot bind a transcript build",
      }]);
    }
    if (version.videoSha256 !== input.sourceVideoSha256) {
      throw new ValidationError([{
        path: "sourceVideoSha256",
        message: "sourceVideoSha256 does not match the course version's uploaded video SHA-256",
      }]);
    }

    // Idempotency + drift check.
    const existing = await tx.trainingTranscriptBuild.findUnique({
      where: {
        clubId_sourceVideoSha256_resolvedTranscriptBuildId: {
          clubId,
          sourceVideoSha256: input.sourceVideoSha256,
          resolvedTranscriptBuildId: input.resolvedTranscriptBuildId,
        },
      },
    });
    if (existing) {
      const drift = buildDriftReason(existing, input);
      if (drift) {
        throw new ConflictError(
          `TrainingTranscriptBuild identity exists with different ${drift}; refusing to overwrite immutable evidence`,
        );
      }
      return { build: existing, created: false };
    }

    const build = await tx.trainingTranscriptBuild.create({
      data: {
        clubId,
        sourceVideoSha256: input.sourceVideoSha256,
        resolvedTranscriptBuildId: input.resolvedTranscriptBuildId,
        transcriberName: input.transcriberName,
        transcriberVersion: input.transcriberVersion,
        transcriberModelName: input.transcriberModelName,
        transcriberModelVersion: input.transcriberModelVersion,
        transcriberConfigSha256: input.transcriberConfigSha256,
        producedAt: input.producedAt,
      },
    });
    return { build, created: true };
  }));

  // Post-commit audit. Non-blocking by design (`audit()` never throws).
  if (tx.created) {
    await audit(principal, {
      action: "training.transcript.build.ingested",
      entityType: "TrainingTranscriptBuild",
      entityId: tx.build.id,
      clubId,
      meta: buildIdentityForAudit(tx.build),
    });
  }

  return tx;
}

function buildDriftReason(stored: TrainingTranscriptBuild, input: PersistTranscriptBuildInput): string | null {
  if (stored.transcriberName !== input.transcriberName) return "transcriberName";
  if (stored.transcriberVersion !== input.transcriberVersion) return "transcriberVersion";
  if (stored.transcriberModelName !== input.transcriberModelName) return "transcriberModelName";
  if (stored.transcriberModelVersion !== input.transcriberModelVersion) return "transcriberModelVersion";
  if (stored.transcriberConfigSha256 !== input.transcriberConfigSha256) return "transcriberConfigSha256";
  // producedAt is also immutable identity material — but the Modal
  // deterministic pipeline would produce an identical ISO value here,
  // so drift on this field is also tamper.
  if (stored.producedAt.toISOString() !== input.producedAt.toISOString()) return "producedAt";
  return null;
}

// ---------------------------------------------------------------------
// Service #2 — persistTranscriptSegments
// ---------------------------------------------------------------------

/**
 * Persist a batch of transcript segments for a build. Immutable; the
 * service NEVER rewrites an existing segment.
 *
 * Idempotency: a segment whose (clubId, transcriptBuildId,
 * segmentIndex) already exists with IDENTICAL content is skipped
 * (counted in `idempotentSkipped`). A segment whose key matches but
 * whose content differs is a TAMPER condition and throws
 * ConflictError.
 *
 * Validation rules enforced pre-write:
 *   - segmentIndex is a non-negative integer.
 *   - startSec and endSec are finite non-negative decimals.
 *   - endSec >= startSec.
 *   - No duplicate segmentIndex within the input batch.
 *   - buildId resolves to a build in the target club with the
 *     caller-supplied `expectedResolvedTranscriptBuildId`.
 */
export async function persistTranscriptSegments(
  principal: Principal | null,
  clubId: string,
  buildId: string,
  input: PersistTranscriptSegmentsInput,
  opts: { prisma?: PrismaClient } = {},
): Promise<PersistTranscriptSegmentsResult> {
  const db = opts.prisma ?? defaultPrisma;

  requireIngestPermission(principal, clubId);
  assertIdShape(buildId, "buildId");
  assertHexSha256(input.expectedResolvedTranscriptBuildId, "expectedResolvedTranscriptBuildId");

  if (!Array.isArray(input.segments) || input.segments.length === 0) {
    throw new ValidationError([{ path: "segments", message: "segments must be a non-empty array" }]);
  }
  if (input.segments.length > 10_000) {
    throw new ValidationError([{ path: "segments", message: "segments batch exceeds 10,000-row ceiling" }]);
  }

  // Validate every segment + check for intra-batch duplicates.
  const normalised: Array<{
    segmentIndex: number;
    text: string;
    startSec: Prisma.Decimal;
    endSec: Prisma.Decimal;
    pendingReview: string[];
    sourceOrgMismatch: string[];
    uncertaintyWarning: string | null;
  }> = [];
  const seenIndices = new Set<number>();
  for (let i = 0; i < input.segments.length; i++) {
    const s = input.segments[i];
    const p = (k: string) => `segments[${i}].${k}`;
    if (!Number.isInteger(s.segmentIndex) || s.segmentIndex < 0) {
      throw new ValidationError([{ path: p("segmentIndex"), message: "segmentIndex must be a non-negative integer" }]);
    }
    if (seenIndices.has(s.segmentIndex)) {
      throw new ValidationError([{ path: p("segmentIndex"), message: `duplicate segmentIndex ${s.segmentIndex} in batch` }]);
    }
    seenIndices.add(s.segmentIndex);
    if (typeof s.text !== "string" || s.text.length === 0) {
      throw new ValidationError([{ path: p("text"), message: "text must be a non-empty string" }]);
    }
    const startSec = toDecimal(s.startSec, p("startSec"));
    const endSec = toDecimal(s.endSec, p("endSec"));
    if (startSec.isNegative()) {
      throw new ValidationError([{ path: p("startSec"), message: "startSec must be >= 0" }]);
    }
    if (endSec.lessThan(startSec)) {
      throw new ValidationError([{ path: p("endSec"), message: "endSec must be >= startSec" }]);
    }
    normalised.push({
      segmentIndex: s.segmentIndex,
      text: s.text,
      startSec,
      endSec,
      pendingReview: [...(s.pendingReview ?? [])],
      sourceOrgMismatch: [...(s.sourceOrgMismatch ?? [])],
      uncertaintyWarning: s.uncertaintyWarning ?? null,
    });
  }

  const result = await runWithUniqueRetry(() => db.$transaction(async (tx) => {
    requireIngestPermission(principal, clubId);

    const build = await tx.trainingTranscriptBuild.findUnique({
      where: { id: buildId },
      select: {
        id: true,
        clubId: true,
        resolvedTranscriptBuildId: true,
      },
    });
    if (!build) throw new NotFoundError("TrainingTranscriptBuild", buildId);
    if (build.clubId !== clubId) {
      // Cross-tenant: return the same 404 shape as a non-existent row.
      throw new NotFoundError("TrainingTranscriptBuild", buildId);
    }
    if (build.resolvedTranscriptBuildId !== input.expectedResolvedTranscriptBuildId) {
      throw new ConflictError(
        "expectedResolvedTranscriptBuildId does not match the build's stored resolvedTranscriptBuildId",
      );
    }

    // Load any pre-existing segments for this build + the batch
    // indices in one query. Collision detection runs purely in
    // memory; no race window because the transaction holds a lock on
    // every target row we try to insert.
    const existing = await tx.trainingTranscriptSegment.findMany({
      where: {
        clubId,
        transcriptBuildId: build.id,
        segmentIndex: { in: normalised.map((n) => n.segmentIndex) },
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
    });
    const existingByIndex = new Map(existing.map((e) => [e.segmentIndex, e]));

    // Drift check for every pre-existing match.
    const toInsert: typeof normalised = [];
    let idempotentSkipped = 0;
    for (const n of normalised) {
      const prior = existingByIndex.get(n.segmentIndex);
      if (!prior) {
        toInsert.push(n);
        continue;
      }
      // Compare content.
      const priorPendingReview = safeJsonArray(prior.pendingReviewJson);
      const priorSourceOrgMismatch = safeJsonArray(prior.sourceOrgMismatchJson);
      if (
        prior.text !== n.text ||
        !prior.startSec.equals(n.startSec) ||
        !prior.endSec.equals(n.endSec) ||
        !arraysEqual(priorPendingReview, n.pendingReview) ||
        !arraysEqual(priorSourceOrgMismatch, n.sourceOrgMismatch) ||
        (prior.uncertaintyWarning ?? null) !== n.uncertaintyWarning
      ) {
        throw new ConflictError(
          `TrainingTranscriptSegment (build=${build.id}, index=${n.segmentIndex}) exists with different content; refusing to overwrite immutable evidence`,
        );
      }
      idempotentSkipped += 1;
    }

    if (toInsert.length > 0) {
      await tx.trainingTranscriptSegment.createMany({
        data: toInsert.map((n) => ({
          clubId,
          transcriptBuildId: build.id,
          segmentIndex: n.segmentIndex,
          text: n.text,
          startSec: n.startSec,
          endSec: n.endSec,
          pendingReviewJson: JSON.stringify(n.pendingReview),
          sourceOrgMismatchJson: JSON.stringify(n.sourceOrgMismatch),
          uncertaintyWarning: n.uncertaintyWarning,
        })),
      });
    }

    return {
      created: toInsert.length,
      idempotentSkipped,
      segmentIndices: normalised.map((n) => n.segmentIndex),
    };
  }));

  if (result.created > 0) {
    await audit(principal, {
      action: "training.transcript.segment.ingested",
      entityType: "TrainingTranscriptBuild",
      entityId: buildId,
      clubId,
      meta: {
        created: result.created,
        idempotentSkipped: result.idempotentSkipped,
        segmentIndexRange: {
          min: Math.min(...result.segmentIndices),
          max: Math.max(...result.segmentIndices),
        },
      },
    });
  }

  return result;
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

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// ---------------------------------------------------------------------
// Service #3 — persistGroundingProjection
// ---------------------------------------------------------------------

/**
 * Persist a grounding projection subset authorised for generation.
 *
 * Validates that every passage cites segment indices which:
 *   (a) exist on the target transcript build,
 *   (b) are NOT in EXCLUDED_SEGMENT_INDICES (segments 16 / 17).
 *
 * Computes the canonical server-side SHA-256 of the projection body;
 * if the caller supplied `clientSuppliedSha256`, asserts equality. The
 * server's recomputed value is the authoritative identity and is what
 * gets persisted in `TrainingGroundingProjection.sha256`.
 *
 * Idempotent on (clubId, courseVersionId, sha256). Drift on any other
 * field raises ConflictError.
 */
export async function persistGroundingProjection(
  principal: Principal | null,
  clubId: string,
  input: PersistGroundingProjectionInput,
  opts: { prisma?: PrismaClient } = {},
): Promise<PersistGroundingProjectionResult> {
  const db = opts.prisma ?? defaultPrisma;

  requireIngestPermission(principal, clubId);
  assertIdShape(input.courseVersionId, "courseVersionId");
  assertHexSha256(input.sourceVideoSha256, "sourceVideoSha256");
  assertHexSha256(input.resolvedTranscriptBuildId, "resolvedTranscriptBuildId");
  if (input.clientSuppliedSha256 !== undefined) {
    assertHexSha256(input.clientSuppliedSha256, "clientSuppliedSha256");
  }
  if (!(input.authoredAt instanceof Date) || Number.isNaN(input.authoredAt.getTime())) {
    throw new ValidationError([{ path: "authoredAt", message: "authoredAt must be a valid Date" }]);
  }
  if (!Array.isArray(input.passages) || input.passages.length === 0) {
    throw new ValidationError([{ path: "passages", message: "passages must be a non-empty array" }]);
  }
  if (input.passages.length > 1_000) {
    throw new ValidationError([{ path: "passages", message: "passages exceed 1,000-row ceiling" }]);
  }

  // Per-passage validation + segment-exclusion check (pre-DB).
  const seenPassageIds = new Set<number>();
  const allCitedSegmentIndices = new Set<number>();
  for (let i = 0; i < input.passages.length; i++) {
    const p = input.passages[i];
    const pp = (k: string) => `passages[${i}].${k}`;
    if (!Number.isInteger(p.passageId) || p.passageId < 0) {
      throw new ValidationError([{ path: pp("passageId"), message: "passageId must be a non-negative integer" }]);
    }
    if (seenPassageIds.has(p.passageId)) {
      throw new ValidationError([{ path: pp("passageId"), message: `duplicate passageId ${p.passageId}` }]);
    }
    seenPassageIds.add(p.passageId);
    if (!Array.isArray(p.sourceSegmentIds) || p.sourceSegmentIds.length === 0) {
      throw new ValidationError([{ path: pp("sourceSegmentIds"), message: "sourceSegmentIds must be a non-empty array" }]);
    }
    for (const sid of p.sourceSegmentIds) {
      if (!Number.isInteger(sid) || sid < 0) {
        throw new ValidationError([{ path: pp("sourceSegmentIds"), message: `sourceSegmentIds must contain non-negative integers; got ${sid}` }]);
      }
      if (EXCLUDED_SEGMENT_INDICES.has(sid)) {
        throw new ValidationError([{
          path: pp("sourceSegmentIds"),
          message: `segment ${sid} is excluded by pilot authorisation (segments 16 and 17 are unverified)`,
        }]);
      }
      allCitedSegmentIndices.add(sid);
    }
    if (!Number.isFinite(p.sourceStartSec) || !Number.isFinite(p.sourceEndSec) || p.sourceStartSec < 0 || p.sourceEndSec < p.sourceStartSec) {
      throw new ValidationError([{ path: pp("sourceStartSec/sourceEndSec"), message: "timestamps must be finite, non-negative, in order" }]);
    }
    if (typeof p.text !== "string" || p.text.length === 0) {
      throw new ValidationError([{ path: pp("text"), message: "text must be a non-empty string" }]);
    }
    if (typeof p.citationHandle !== "string" || p.citationHandle.length === 0) {
      throw new ValidationError([{ path: pp("citationHandle"), message: "citationHandle must be a non-empty string" }]);
    }
  }

  const excludedPassages = input.excludedPassages ?? [];

  // Canonical server-side projection body + hash.
  const canonicalBody = canonicalProjectionBody({
    tenantId: clubId,
    courseVersionId: input.courseVersionId,
    sourceVideoSha256: input.sourceVideoSha256,
    resolvedTranscriptBuildId: input.resolvedTranscriptBuildId,
    passages: input.passages,
    excludedPassages,
  });
  const serverSha256 = sha256Hex(canonicalBody);
  if (input.clientSuppliedSha256 && input.clientSuppliedSha256 !== serverSha256) {
    throw new ConflictError(
      "clientSuppliedSha256 does not match server-recomputed canonical sha256; evidence integrity failure",
    );
  }

  // Flag-presence summaries for the row.
  let sourceOrgMismatchFlagsPresent = false;
  let pendingReviewPresent = false;
  for (const p of input.passages) {
    if ((p.flags?.sourceOrgMismatch?.length ?? 0) > 0) sourceOrgMismatchFlagsPresent = true;
    if ((p.flags?.pendingReview?.length ?? 0) > 0) pendingReviewPresent = true;
  }

  const result = await runWithUniqueRetry(() => db.$transaction(async (tx) => {
    requireIngestPermission(principal, clubId);

    // Ownership chain: course-version must belong to club.
    const version = await tx.trainingCourseVersion.findUnique({
      where: { id: input.courseVersionId },
      select: {
        id: true,
        videoSha256: true,
        course: { select: { clubId: true } },
      },
    });
    if (!version) throw new NotFoundError("TrainingCourseVersion", input.courseVersionId);
    if (version.course.clubId !== clubId) {
      throw new NotFoundError("TrainingCourseVersion", input.courseVersionId);
    }
    if (version.videoSha256 !== input.sourceVideoSha256) {
      throw new ValidationError([{
        path: "sourceVideoSha256",
        message: "sourceVideoSha256 does not match the course version's uploaded video SHA-256",
      }]);
    }

    // Build must exist for (clubId, sourceVideoSha256, resolvedTranscriptBuildId).
    const build = await tx.trainingTranscriptBuild.findUnique({
      where: {
        clubId_sourceVideoSha256_resolvedTranscriptBuildId: {
          clubId,
          sourceVideoSha256: input.sourceVideoSha256,
          resolvedTranscriptBuildId: input.resolvedTranscriptBuildId,
        },
      },
      select: { id: true },
    });
    if (!build) {
      throw new ValidationError([{
        path: "resolvedTranscriptBuildId",
        message: "no TrainingTranscriptBuild exists for (clubId, sourceVideoSha256, resolvedTranscriptBuildId); ingest the build first",
      }]);
    }

    // Every cited segment must exist on this build. A projection that
    // cites a segment outside the build is a provenance failure and
    // must be refused.
    const citedIndices = Array.from(allCitedSegmentIndices);
    const foundSegments = await tx.trainingTranscriptSegment.count({
      where: {
        clubId,
        transcriptBuildId: build.id,
        segmentIndex: { in: citedIndices },
      },
    });
    if (foundSegments !== citedIndices.length) {
      throw new ValidationError([{
        path: "passages",
        message: `grounding projection cites ${citedIndices.length} segments but only ${foundSegments} exist on the authorised transcript build`,
      }]);
    }

    // Idempotency + drift check.
    const existing = await tx.trainingGroundingProjection.findUnique({
      where: {
        clubId_courseVersionId_sha256: {
          clubId,
          courseVersionId: input.courseVersionId,
          sha256: serverSha256,
        },
      },
    });
    if (existing) {
      if (
        existing.sourceVideoSha256 !== input.sourceVideoSha256 ||
        existing.resolvedTranscriptBuildId !== input.resolvedTranscriptBuildId
      ) {
        // Different bindings under the same (club, cv, sha256) — this
        // is impossible by construction because sha256 includes both,
        // but guard anyway.
        throw new ConflictError(
          "stored TrainingGroundingProjection has different source-material bindings; integrity failure",
        );
      }
      return { projection: existing, created: false, sha256: serverSha256 };
    }

    const projection = await tx.trainingGroundingProjection.create({
      data: {
        clubId,
        courseVersionId: input.courseVersionId,
        sha256: serverSha256,
        sourceVideoSha256: input.sourceVideoSha256,
        resolvedTranscriptBuildId: input.resolvedTranscriptBuildId,
        passagesJson: JSON.stringify(input.passages),
        excludedPassagesJson: JSON.stringify(excludedPassages),
        sourceOrgMismatchFlagsPresent,
        pendingReviewPresent,
        authoredAt: input.authoredAt,
      },
    });
    return { projection, created: true, sha256: serverSha256 };
  }));

  if (result.created) {
    await audit(principal, {
      action: "training.grounding.projection.ingested",
      entityType: "TrainingGroundingProjection",
      entityId: result.projection.id,
      clubId,
      meta: {
        courseVersionId: result.projection.courseVersionId,
        sha256: result.sha256,
        sourceVideoSha256: result.projection.sourceVideoSha256,
        resolvedTranscriptBuildId: result.projection.resolvedTranscriptBuildId,
        passageCount: input.passages.length,
        excludedPassageCount: excludedPassages.length,
        sourceOrgMismatchFlagsPresent,
        pendingReviewPresent,
      },
    });
  }

  return result;
}

// ---------------------------------------------------------------------
// Barrel re-exports (for callers that import from the module root)
// ---------------------------------------------------------------------

export type {
  TrainingTranscriptBuild,
  TrainingTranscriptSegment,
  TrainingGroundingProjection,
} from "@prisma/client";
