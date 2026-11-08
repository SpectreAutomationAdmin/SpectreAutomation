// EP-TRAIN-4Y-Q §5 (2026-11-08) — Transcript-segment attestation service.
//
// The 6C-10B converter correctly refuses to ground questions on
// TrainingTranscriptSegment rows carrying `pendingReview` flags.
// This service lets an authorised reviewer scope an attestation to
// a SPECIFIC segment + the current transcript revision (the segment
// row itself is immutable — the attestation is additive annotation).
//
// Permission model: `hr:training:ai:approve` is required to attest a
// segment. The attester is the same role that would approve drafts
// citing it — but the service DOES NOT approve any draft; it only
// records the segment-level attestation. A separate explicit
// approval remains required for each individual draft, and the
// approve-service's own authorisation check re-runs end to end.
//
// Attestation is per-segment, not per-transcript. `attest(s)` can be
// called many times; the row simply reflects the most recent
// reviewer. `unattest(s)` sets the fields back to null, re-raising
// the pendingReview flags via the projection materialiser.
//
// Any downstream draft citing an attested segment should be
// revalidated (POST /api/admin/ai-training/drafts/<id>/revalidate)
// to refresh its TrainingQuestionAiValidation verdict against the
// new projection.

import type { PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "@/lib/prisma";
import type { Principal } from "@/lib/rbac";
import { hasPermission } from "@/lib/rbac";
import { audit } from "@/lib/audit";

export class AttestationError extends Error {
  readonly httpStatus: number;
  readonly code: "forbidden" | "not_found" | "invalid_input" | "already_matches";
  constructor(code: AttestationError["code"], message: string, httpStatus: number) {
    super(message);
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

export interface AttestSegmentInput {
  readonly segmentId: string;
  readonly note?: string;
}

export interface AttestSegmentResult {
  readonly segmentId: string;
  readonly reviewerAttestedAt: Date;
  readonly reviewerAttestedByUserId: string;
}

/** Attest a single transcript segment. Idempotent on repeated calls
 *  (the attestedAt is updated to the latest timestamp; the attester
 *  may change if a different reviewer re-attests). */
export async function attestTranscriptSegment(
  principal: Principal,
  clubId: string,
  input: AttestSegmentInput,
  opts: { prisma?: PrismaClient; now?: Date } = {},
): Promise<AttestSegmentResult> {
  const db = opts.prisma ?? defaultPrisma;
  if (!input.segmentId || typeof input.segmentId !== "string") {
    throw new AttestationError("invalid_input", "segmentId required", 400);
  }
  if (!hasPermission(principal, clubId, "hr:training:ai:approve")) {
    throw new AttestationError("forbidden", "Reviewer approval permission required", 403);
  }

  const row = await db.trainingTranscriptSegment.findUnique({
    where: { id: input.segmentId },
    select: {
      id: true,
      clubId: true,
      reviewerAttestedAt: true,
      reviewerAttestedByUserId: true,
    },
  });
  if (!row) throw new AttestationError("not_found", "segment not found", 404);
  if (row.clubId !== clubId) throw new AttestationError("not_found", "segment not in active club", 404);

  const now = opts.now ?? new Date();
  const updated = await db.trainingTranscriptSegment.update({
    where: { id: input.segmentId },
    data: {
      reviewerAttestedAt: now,
      reviewerAttestedByUserId: principal.id,
      reviewerAttestationNote: (input.note ?? "").slice(0, 500),
    },
    select: {
      id: true,
      reviewerAttestedAt: true,
      reviewerAttestedByUserId: true,
    },
  });

  void audit(principal, {
    action: "hr.training.ai.transcript_segment.attest",
    entityType: "TrainingTranscriptSegment",
    entityId: updated.id,
    clubId,
    before: {
      reviewerAttestedAt: row.reviewerAttestedAt?.toISOString() ?? null,
      reviewerAttestedByUserId: row.reviewerAttestedByUserId ?? null,
    },
    after: {
      reviewerAttestedAt: updated.reviewerAttestedAt?.toISOString() ?? null,
      reviewerAttestedByUserId: updated.reviewerAttestedByUserId ?? null,
    },
  });

  return {
    segmentId: updated.id,
    reviewerAttestedAt: updated.reviewerAttestedAt!,
    reviewerAttestedByUserId: updated.reviewerAttestedByUserId!,
  };
}

export async function unattestTranscriptSegment(
  principal: Principal,
  clubId: string,
  segmentId: string,
  opts: { prisma?: PrismaClient; now?: Date } = {},
): Promise<{ segmentId: string }> {
  const db = opts.prisma ?? defaultPrisma;
  if (!hasPermission(principal, clubId, "hr:training:ai:approve")) {
    throw new AttestationError("forbidden", "Reviewer approval permission required", 403);
  }
  const row = await db.trainingTranscriptSegment.findUnique({
    where: { id: segmentId },
    select: {
      id: true,
      clubId: true,
      reviewerAttestedAt: true,
      reviewerAttestedByUserId: true,
    },
  });
  if (!row) throw new AttestationError("not_found", "segment not found", 404);
  if (row.clubId !== clubId) throw new AttestationError("not_found", "segment not in active club", 404);

  await db.trainingTranscriptSegment.update({
    where: { id: segmentId },
    data: {
      reviewerAttestedAt: null,
      reviewerAttestedByUserId: null,
      reviewerAttestationNote: null,
    },
  });

  void audit(principal, {
    action: "hr.training.ai.transcript_segment.unattest",
    entityType: "TrainingTranscriptSegment",
    entityId: segmentId,
    clubId,
    before: {
      reviewerAttestedAt: row.reviewerAttestedAt?.toISOString() ?? null,
      reviewerAttestedByUserId: row.reviewerAttestedByUserId ?? null,
    },
    after: {
      reviewerAttestedAt: null,
      reviewerAttestedByUserId: null,
    },
  });

  return { segmentId };
}

/** Attest a batch of segments identified by their segmentIndex on a
 *  given build. Convenience for the reviewer UI that renders segment
 *  chips and offers "attest all currently-visible". Returns per-id
 *  outcome counts. */
export async function attestTranscriptSegmentsByIndex(
  principal: Principal,
  clubId: string,
  input: {
    readonly transcriptBuildId: string;
    readonly segmentIndices: readonly number[];
    readonly note?: string;
  },
  opts: { prisma?: PrismaClient; now?: Date } = {},
): Promise<{ attested: number; skipped: number; errors: string[] }> {
  const db = opts.prisma ?? defaultPrisma;
  if (!hasPermission(principal, clubId, "hr:training:ai:approve")) {
    throw new AttestationError("forbidden", "Reviewer approval permission required", 403);
  }
  const rows = await db.trainingTranscriptSegment.findMany({
    where: {
      clubId,
      transcriptBuildId: input.transcriptBuildId,
      segmentIndex: { in: [...input.segmentIndices] },
    },
    select: { id: true, segmentIndex: true, reviewerAttestedAt: true },
  });
  const errors: string[] = [];
  let attested = 0;
  let skipped = 0;
  for (const r of rows) {
    try {
      await attestTranscriptSegment(
        principal,
        clubId,
        { segmentId: r.id, note: input.note },
        { prisma: db, now: opts.now },
      );
      attested++;
    } catch (err) {
      errors.push(`segment ${r.segmentIndex}: ${(err as Error).message}`);
      skipped++;
    }
  }
  return { attested, skipped, errors };
}
