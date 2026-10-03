// AR-HIST-1 §17 / §23 (2026-10-03) — AR aging resolver.
//
// Date-aware: reads the committed ArAgingImportBatch snapshot whose
// sourceEffectiveDate exactly matches the requested asOf date. No
// carry-forward, no interpolation, no operational Charge/Payment
// reads (per §17: "do not calculate these from operational tables").
//
// Returns AVAILABLE when a committed snapshot covers the asOf, else
// SOURCE_NOT_LOADED (per TB-HIST-12A/12B availability patterns).

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { toMoney, ZERO } from "@/lib/accounting/decimal";

export type ArAgingResolverProvenance = {
  availability: "AVAILABLE" | "SOURCE_NOT_LOADED";
  reason: string;
};

export type ArAgingSnapshot = {
  batchId: string;
  sourceEffectiveDate: Date;
  totalAR: Prisma.Decimal;
  current: Prisma.Decimal;
  oneMonth: Prisma.Decimal;
  twoMonths: Prisma.Decimal;
  threeMonths: Prisma.Decimal;
  overFourMonths: Prisma.Decimal;
  nonCurrent: Prisma.Decimal;
  currentPct: number | null;
  nonCurrentPct: number | null;
  accountCount: number;
  nonCurrentAccountCount: number;
  reconciliationStatus: string | null;
  glControlBalance: Prisma.Decimal | null;
  glControlAccountNumber: string | null;
};

/** Resolve the committed AR aging snapshot for the given club at the
 *  given asOf date. Returns provenance.availability === "AVAILABLE"
 *  only when a COMMITTED batch exists for the EXACT calendar day. */
export async function resolveArAgingAsOf(opts: {
  clubId: string;
  asOf: Date;
}): Promise<{ snapshot: ArAgingSnapshot | null; provenance: ArAgingResolverProvenance }> {
  // Same-calendar-day window — a batch with sourceEffectiveDate = Jan 31
  // 23:59:59.999 should match an asOf = Jan 31 00:00:00 and vice versa.
  const dayStart = new Date(Date.UTC(opts.asOf.getUTCFullYear(), opts.asOf.getUTCMonth(), opts.asOf.getUTCDate(), 0, 0, 0, 0));
  const dayEnd = new Date(Date.UTC(opts.asOf.getUTCFullYear(), opts.asOf.getUTCMonth(), opts.asOf.getUTCDate(), 23, 59, 59, 999));
  const batch = await prisma.arAgingImportBatch.findFirst({
    where: {
      clubId: opts.clubId,
      status: "COMMITTED",
      sourceEffectiveDate: { gte: dayStart, lte: dayEnd },
    },
    orderBy: { committedAt: "desc" },
  });
  if (!batch) {
    return {
      snapshot: null,
      provenance: {
        availability: "SOURCE_NOT_LOADED",
        reason: `No committed AR aging snapshot for ${opts.asOf.toISOString().slice(0, 10)}`,
      },
    };
  }

  // Totals from the ARIB header (snapshot is non-additive — these
  // are the committed authoritative totals).
  const totalAR = batch.totalNet as Prisma.Decimal;
  const current = batch.totalCurrent as Prisma.Decimal;
  const oneMonth = batch.totalOneMonth as Prisma.Decimal;
  const twoMonths = batch.totalTwoMonths as Prisma.Decimal;
  const threeMonths = batch.totalThreeMonths as Prisma.Decimal;
  const overFourMonths = batch.totalOverFourMonths as Prisma.Decimal;
  const nonCurrent = oneMonth.plus(twoMonths).plus(threeMonths).plus(overFourMonths);
  const totalNum = Number(totalAR.toString());
  const currentPct = totalNum > 0 ? (Number(current.toString()) / totalNum) * 100 : null;
  const nonCurrentPct = currentPct != null ? 100 - currentPct : null;

  // Non-current account count derived from the snapshot rows (one
  // query, no row serialization to the caller).
  const nonCurrentRows = await prisma.arAgingSnapshotRow.findMany({
    where: { importBatchId: batch.id },
    select: { oneMonth: true, twoMonths: true, threeMonths: true, overFourMonths: true },
  });
  let nonCurrentAccountCount = 0;
  for (const r of nonCurrentRows) {
    const sum = (r.oneMonth as Prisma.Decimal)
      .plus(r.twoMonths as Prisma.Decimal)
      .plus(r.threeMonths as Prisma.Decimal)
      .plus(r.overFourMonths as Prisma.Decimal);
    if (sum.abs().gt(toMoney("0.001"))) nonCurrentAccountCount++;
  }

  return {
    snapshot: {
      batchId: batch.id,
      sourceEffectiveDate: batch.sourceEffectiveDate,
      totalAR,
      current,
      oneMonth,
      twoMonths,
      threeMonths,
      overFourMonths,
      nonCurrent,
      currentPct,
      nonCurrentPct,
      accountCount: batch.rowCount,
      nonCurrentAccountCount,
      reconciliationStatus: batch.reconciliationStatus,
      glControlBalance: batch.glControlBalance,
      glControlAccountNumber: batch.glControlAccountNumber,
    },
    provenance: {
      availability: "AVAILABLE",
      reason: `Committed AR snapshot batch=${batch.id} effective=${batch.sourceEffectiveDate.toISOString().slice(0, 10)} status=${batch.reconciliationStatus}`,
    },
  };
}

// Keep an unused export surface for ZERO imports — module compiles.
export const _MARKER = ZERO;
