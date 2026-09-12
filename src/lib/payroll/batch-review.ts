// Payroll Admin Slice 3C acceptance hotfix (2026-09-12) — governance
// review attestation service.
//
// Each row in `PayrollBatchReviewAttestation` records that a Payroll
// Admin attested to a specific dataset dimension of a specific
// payroll batch, at a specific dataset fingerprint. Two dimensions
// are supported in 3C:
//
//   ONE_TIME_ADJUSTMENTS  — reviewed dataset = the batch's one-time
//     PayrollBatchComponentSnapshot rows (provenance =
//     ONE_TIME_PAYROLL_ADJUSTMENT). Fingerprint invalidates the
//     moment `addOneTimeAdjustment` or `removeOneTimeAdjustment`
//     writes.
//
//   RECURRING_COMPONENTS  — reviewed dataset = the batch's frozen
//     recurring snapshots (provenance = RECURRING_EMPLOYEE_SETUP).
//     These snapshots are IMMUTABLE for a batch (see §19 of the 3C
//     directive), so the fingerprint remains stable across the
//     batch's lifecycle. A new batch (voided + re-prepared) starts
//     with zero attestations — the review state does NOT carry
//     across batches.
//
// A third dimension (EMPLOYEE_DATA) is reserved for a later slice
// and requires no schema changes.
//
// Fingerprint: deterministic hex sha256 of a stable serialization
// of the reviewed dataset. See `computeReviewFingerprint`. This
// gives us the strong invariant §4 of the directive requires:
// review attestation is valid ONLY for the exact dataset version
// reviewed.
//
// Historical trail: the CURRENT attestation for (batch, dimension)
// is the row with `invalidatedAt IS NULL`. Prior attestations
// remain in the table with `invalidatedAt` set to when they
// became stale.

import crypto from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "../prisma";
import { requirePermission, hasPermission, type Principal } from "../rbac";
import { assertPostingAllowed } from "../posting-guard";
import { audit } from "../audit";
import { ValidationError, NotFoundError } from "../errors";

const ENTITY = "PayrollBatchReviewAttestation";

export const REVIEW_DIMENSIONS = [
  "ONE_TIME_ADJUSTMENTS",
  "RECURRING_COMPONENTS",
  // EMPLOYEE_DATA reserved for a later slice.
] as const;
export type ReviewDimension = (typeof REVIEW_DIMENSIONS)[number];

type PrismaTxOrClient = typeof prisma | Prisma.TransactionClient;

// ---------------------------------------------------------------------------
// Fingerprint computation
// ---------------------------------------------------------------------------

/** Deterministic sha256 hex of the reviewed dataset for the given
 *  batch × dimension pair. Empty-dataset case returns the sha256 of
 *  the string `"<dimension>:empty"` — a distinct fingerprint from
 *  any populated dataset. */
export async function computeReviewFingerprint(
  clubId: string,
  batchId: string,
  dimension: ReviewDimension,
  txOrClient: PrismaTxOrClient = prisma,
): Promise<string> {
  const rows = await txOrClient.payrollBatchComponentSnapshot.findMany({
    where: {
      clubId,
      batchId,
      provenance: dimension === "ONE_TIME_ADJUSTMENTS"
        ? "ONE_TIME_PAYROLL_ADJUSTMENT"
        : "RECURRING_EMPLOYEE_SETUP",
    },
    orderBy: [{ id: "asc" }],
    select: {
      id: true,
      batchEmployeeId: true,
      componentCode: true,
      resolvedAmount: true,
      sourcePercentBps: true,
      sourceAssignmentId: true,
    },
  });
  if (rows.length === 0) {
    return crypto.createHash("sha256").update(`${dimension}:empty`).digest("hex");
  }
  const stable = rows
    .map((r) => [
      r.id,
      r.batchEmployeeId,
      r.componentCode,
      r.resolvedAmount == null ? "" : r.resolvedAmount.toString(),
      r.sourcePercentBps == null ? "" : String(r.sourcePercentBps),
      r.sourceAssignmentId ?? "",
    ].join("|"))
    .join("\n");
  return crypto.createHash("sha256").update(`${dimension}:${stable}`).digest("hex");
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export interface AttestationStatus {
  dimension: ReviewDimension;
  currentFingerprint: string;
  attestation:
    | null
    | {
        id: string;
        attestedAt: Date;
        attestedByUserId: string;
        attestedByDisplayName: string | null;
        fingerprint: string;
        isCurrent: boolean;
      };
}

export async function getBatchReviewStatus(
  principal: Principal,
  clubId: string,
  batchId: string,
): Promise<AttestationStatus[]> {
  requirePermission(principal, clubId, "payroll:read");
  const [currentAttestations, dims] = await Promise.all([
    prisma.payrollBatchReviewAttestation.findMany({
      where: { clubId, batchId, invalidatedAt: null },
      orderBy: [{ dimension: "asc" }, { attestedAt: "desc" }],
    }),
    Promise.resolve(REVIEW_DIMENSIONS as unknown as ReviewDimension[]),
  ]);
  const byDim = new Map<string, (typeof currentAttestations)[number]>();
  for (const a of currentAttestations) {
    // Take the most recent non-invalidated row per dimension.
    if (!byDim.has(a.dimension)) byDim.set(a.dimension, a);
  }
  const userIds = Array.from(new Set(Array.from(byDim.values()).map((a) => a.attestedByUserId)));
  const users = userIds.length
    ? await prisma.user.findMany({
        where: { id: { in: userIds } },
        select: { id: true, name: true, email: true },
      })
    : [];
  const nameById = new Map(users.map((u) => [u.id, u.name || u.email || null]));

  const result: AttestationStatus[] = [];
  for (const d of dims) {
    const current = await computeReviewFingerprint(clubId, batchId, d);
    const row = byDim.get(d) ?? null;
    result.push({
      dimension: d,
      currentFingerprint: current,
      attestation: row
        ? {
            id: row.id,
            attestedAt: row.attestedAt,
            attestedByUserId: row.attestedByUserId,
            attestedByDisplayName: nameById.get(row.attestedByUserId) ?? null,
            fingerprint: row.fingerprint,
            isCurrent: row.fingerprint === current,
          }
        : null,
    });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

export async function attestBatchReview(
  principal: Principal,
  clubId: string,
  batchId: string,
  dimension: ReviewDimension,
): Promise<{ id: string; fingerprint: string }> {
  requirePermission(principal, clubId, "payroll:edit");
  await assertPostingAllowed(principal, clubId, "payroll.batch-review.attest", ENTITY, batchId);

  const batch = await prisma.payrollBatch.findFirst({ where: { id: batchId, clubId } });
  if (!batch) throw new NotFoundError("PayrollBatch", batchId);
  if (!REVIEW_DIMENSIONS.includes(dimension)) {
    throw new ValidationError([{ path: "dimension", message: `Unknown dimension: ${dimension}` }]);
  }

  const fingerprint = await computeReviewFingerprint(clubId, batchId, dimension);

  const created = await prisma.$transaction(async (tx) => {
    // Invalidate any prior current attestation for this pair.
    await tx.payrollBatchReviewAttestation.updateMany({
      where: { clubId, batchId, dimension, invalidatedAt: null },
      data: { invalidatedAt: new Date(), invalidatedByReason: "payroll.batch-review.superseded" },
    });
    return tx.payrollBatchReviewAttestation.create({
      data: { clubId, batchId, dimension, fingerprint, attestedByUserId: principal.id },
    });
  });

  await audit(principal, {
    action: "payroll.batch-review.attest",
    entityType: ENTITY,
    entityId: created.id,
    clubId,
    after: { batchId, dimension, fingerprint },
  });
  return { id: created.id, fingerprint };
}

/** Invalidate every CURRENT attestation for (batch, dimension) in
 *  the same transaction as a dataset-changing mutation. Callers pass
 *  their tx handle so the invalidation is atomic with the mutation
 *  that caused it. */
export async function invalidateAttestationForBatchDimension(
  tx: PrismaTxOrClient,
  clubId: string,
  batchId: string,
  dimension: ReviewDimension,
  reason: string,
): Promise<number> {
  const r = await tx.payrollBatchReviewAttestation.updateMany({
    where: { clubId, batchId, dimension, invalidatedAt: null },
    data: { invalidatedAt: new Date(), invalidatedByReason: reason },
  });
  return r.count;
}

// ---------------------------------------------------------------------------
// Permission read (surface guards)
// ---------------------------------------------------------------------------

export function canAttestReview(principal: Principal, clubId: string): boolean {
  return hasPermission(principal, clubId, "payroll:edit");
}
