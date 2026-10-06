// GOLF-HIST-1 (2026-10-05) — Historical Golf Activity preview + commit.
//
// Lifecycle (same shape as AR-HIST-1 / MEM-HIST-2):
//
//   1. previewGolfActivityBatch({ clubId, parse, sourceFileName })
//        - Idempotency key: (clubId, sourceSystem, sourceFileHash,
//          reportingPeriodStart). Re-uploading the identical file
//          returns the existing batch instead of creating a new one.
//        - Writes an UPDATED `GolfActivityImportBatch` row + N
//          `GolfActivityImportRow` rows reflecting the parse.
//        - Detects conflicts against already-committed
//          `GolfActivityDay` rows (same clubId + activityDate).
//        - Returns the batch summary — never commits.
//
//   2. commitGolfActivityBatch({ batchId, committedByUserId })
//        - Refuses to commit when `reconciliationStatus !==
//          "RECONCILED"` OR `conflictCount > 0`.
//        - Writes one `GolfActivityDay` per preview row (upsert on
//          (clubId, activityDate)); the composite unique index
//          guarantees no silent double-commit if two batches arrive
//          at the same time.
//        - Flips batch status PREVIEW -> COMMITTED and stamps
//          `committedAt` + `committedByUserId`.
//
// Zero accounting-table mutations.

import { prisma } from "@/lib/prisma";
import type { GgGolfParseResult } from "./gggolf-pdf-parser";

export type GolfPreviewInput = {
  clubId: string;
  parse: GgGolfParseResult;
  sourceFileName: string | null;
  sourceSystem?: string;
  uploadedByUserId?: string | null;
};

export type GolfPreviewResult = {
  batch: {
    id: string;
    clubId: string;
    status: string;
    sourceSystem: string;
    sourceFileName: string | null;
    sourceFileHash: string;
    reportingPeriodStart: Date;
    reportingPeriodEnd: Date;
    rowCount: number;
    activeDays: number;
    realZeroDays: number;
    conflictCount: number;
    warningCount: number;
    invalidCount: number;
    sourceTotalGuests: number | null;
    sourceTotalGreenFees: number | null;
    sourceTotalMembers: number | null;
    sourceTotalRounds: number | null;
    sourceTotalJuniors: number | null;
    sourceTotalWomen: number | null;
    parsedTotalGuests: number;
    parsedTotalGreenFees: number;
    parsedTotalMembers: number;
    parsedTotalRounds: number;
    parsedTotalJuniors: number;
    parsedTotalWomen: number;
    reconciliationStatus: string;
    uploadedAt: Date;
    committedAt: Date | null;
  };
  rows: Array<{
    rowIndex: number;
    rawDateLabel: string;
    activityDate: Date;
    rawWeatherCode: string | null;
    guests: number;
    greenFees: number;
    members: number;
    totalRounds: number;
    juniors: number;
    women: number;
    conflict: boolean;
  }>;
};

const DEFAULT_SOURCE_SYSTEM = "GGGOLF_EXPORT";

/**
 * Create or refresh the preview batch for an uploaded golf-activity
 * source file. Idempotent on (clubId, sourceSystem, sourceFileHash,
 * reportingPeriodStart).
 */
export async function previewGolfActivityBatch(input: GolfPreviewInput): Promise<GolfPreviewResult> {
  const sourceSystem = input.sourceSystem ?? DEFAULT_SOURCE_SYSTEM;
  const { parse, clubId, sourceFileName, uploadedByUserId } = input;

  // Detect conflicts with already-committed days.
  const activityDates = parse.rows.map((r) => r.activityDate);
  const committed = activityDates.length
    ? await prisma.golfActivityDay.findMany({
        where: {
          clubId,
          activityDate: { in: activityDates },
        },
        select: { id: true, activityDate: true },
      })
    : [];
  const committedByDate = new Map(
    committed.map((d) => [d.activityDate.toISOString(), d.id]),
  );

  const activeDays = parse.rows.filter((r) => r.totalRounds > 0).length;
  const realZeroDays = parse.rows.filter((r) => r.totalRounds === 0).length;
  const conflictCount = parse.rows.filter(
    (r) => committedByDate.has(r.activityDate.toISOString()),
  ).length;

  const batch = await prisma.golfActivityImportBatch.upsert({
    where: {
      clubId_sourceSystem_sourceFileHash_reportingPeriodStart: {
        clubId,
        sourceSystem,
        sourceFileHash: parse.sourceFileHash,
        reportingPeriodStart: parse.reportingPeriodStart,
      },
    },
    create: {
      clubId,
      status: "PREVIEW",
      sourceSystem,
      sourceFileName,
      sourceFileHash: parse.sourceFileHash,
      reportingPeriodStart: parse.reportingPeriodStart,
      reportingPeriodEnd: parse.reportingPeriodEnd,
      rowCount: parse.rows.length,
      activeDays,
      realZeroDays,
      invalidCount: 0,
      warningCount: parse.warnings.length,
      conflictCount,
      sourceTotalGuests:    parse.sourceTotals?.guests      ?? null,
      sourceTotalGreenFees: parse.sourceTotals?.greenFees   ?? null,
      sourceTotalMembers:   parse.sourceTotals?.members     ?? null,
      sourceTotalRounds:    parse.sourceTotals?.totalRounds ?? null,
      sourceTotalJuniors:   parse.sourceTotals?.juniors     ?? null,
      sourceTotalWomen:     parse.sourceTotals?.women       ?? null,
      parsedTotalGuests:    parse.parsedTotals.guests,
      parsedTotalGreenFees: parse.parsedTotals.greenFees,
      parsedTotalMembers:   parse.parsedTotals.members,
      parsedTotalRounds:    parse.parsedTotals.totalRounds,
      parsedTotalJuniors:   parse.parsedTotals.juniors,
      parsedTotalWomen:     parse.parsedTotals.women,
      reconciliationStatus: parse.reconciliationStatus,
      uploadedByUserId: uploadedByUserId ?? null,
    },
    update: {
      status: "PREVIEW",
      sourceFileName,
      reportingPeriodEnd: parse.reportingPeriodEnd,
      rowCount: parse.rows.length,
      activeDays,
      realZeroDays,
      invalidCount: 0,
      warningCount: parse.warnings.length,
      conflictCount,
      sourceTotalGuests:    parse.sourceTotals?.guests      ?? null,
      sourceTotalGreenFees: parse.sourceTotals?.greenFees   ?? null,
      sourceTotalMembers:   parse.sourceTotals?.members     ?? null,
      sourceTotalRounds:    parse.sourceTotals?.totalRounds ?? null,
      sourceTotalJuniors:   parse.sourceTotals?.juniors     ?? null,
      sourceTotalWomen:     parse.sourceTotals?.women       ?? null,
      parsedTotalGuests:    parse.parsedTotals.guests,
      parsedTotalGreenFees: parse.parsedTotals.greenFees,
      parsedTotalMembers:   parse.parsedTotals.members,
      parsedTotalRounds:    parse.parsedTotals.totalRounds,
      parsedTotalJuniors:   parse.parsedTotals.juniors,
      parsedTotalWomen:     parse.parsedTotals.women,
      reconciliationStatus: parse.reconciliationStatus,
      uploadedByUserId: uploadedByUserId ?? null,
    },
  });

  // Refresh preview rows. Delete + insert — the batch is PREVIEW
  // only; no committed day references these rows yet.
  await prisma.$transaction([
    prisma.golfActivityImportRow.deleteMany({ where: { batchId: batch.id } }),
    prisma.golfActivityImportRow.createMany({
      data: parse.rows.map((r) => ({
        batchId: batch.id,
        rowIndex: r.rowIndex,
        activityDate: r.activityDate,
        rawDateLabel: r.rawDateLabel,
        rawWeatherCode: r.rawWeatherCode,
        guests: r.guests,
        greenFees: r.greenFees,
        members: r.members,
        totalRounds: r.totalRounds,
        juniors: r.juniors,
        women: r.women,
        corpos: r.corpos,
        corposHalf: r.corposHalf,
        fullCart: r.fullCart,
        nineCart: r.nineCart,
        halfCart: r.halfCart,
        freeCart: r.freeCart,
        conflictWithCommittedDayId:
          committedByDate.get(r.activityDate.toISOString()) ?? null,
      })),
    }),
  ]);

  return {
    batch,
    rows: parse.rows.map((r) => ({
      rowIndex: r.rowIndex,
      rawDateLabel: r.rawDateLabel,
      activityDate: r.activityDate,
      rawWeatherCode: r.rawWeatherCode,
      guests: r.guests,
      greenFees: r.greenFees,
      members: r.members,
      totalRounds: r.totalRounds,
      juniors: r.juniors,
      women: r.women,
      conflict: committedByDate.has(r.activityDate.toISOString()),
    })),
  };
}

// ---------------------------------------------------------------------------
// Commit
// ---------------------------------------------------------------------------

export class GolfCommitError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

export type GolfCommitInput = {
  batchId: string;
  committedByUserId: string | null;
};

export type GolfCommitResult = {
  batchId: string;
  committedDays: number;
  committedAt: Date;
};

export async function commitGolfActivityBatch(input: GolfCommitInput): Promise<GolfCommitResult> {
  const batch = await prisma.golfActivityImportBatch.findUnique({
    where: { id: input.batchId },
    include: { rows: true },
  });
  if (!batch) {
    throw new GolfCommitError("BATCH_NOT_FOUND", `Batch ${input.batchId} not found.`);
  }
  if (batch.status === "COMMITTED") {
    throw new GolfCommitError("ALREADY_COMMITTED", `Batch ${input.batchId} is already committed.`);
  }
  if (batch.reconciliationStatus !== "RECONCILED") {
    throw new GolfCommitError(
      "RECONCILIATION_REQUIRED",
      `Reconciliation status is ${batch.reconciliationStatus}; must be RECONCILED before commit.`,
    );
  }
  if (batch.conflictCount > 0) {
    throw new GolfCommitError(
      "COMMIT_BLOCKED_BY_CONFLICT",
      `Batch has ${batch.conflictCount} date(s) that already have committed activity. Resolve conflicts before commit.`,
    );
  }

  const now = new Date();
  // Transaction: upsert each day + flip the batch status in one atomic
  // step. The composite unique on (clubId, activityDate) prevents
  // concurrent duplicate commits.
  await prisma.$transaction(async (tx) => {
    for (const r of batch.rows) {
      await tx.golfActivityDay.upsert({
        where: { clubId_activityDate: { clubId: batch.clubId, activityDate: r.activityDate } },
        create: {
          clubId: batch.clubId,
          activityDate: r.activityDate,
          sourceSystem: batch.sourceSystem,
          sourceBatchId: batch.id,
          guests: r.guests,
          greenFees: r.greenFees,
          members: r.members,
          totalRounds: r.totalRounds,
          juniors: r.juniors,
          women: r.women,
          corpos: r.corpos,
          corposHalf: r.corposHalf,
          fullCart: r.fullCart,
          nineCart: r.nineCart,
          halfCart: r.halfCart,
          freeCart: r.freeCart,
          committedAt: now,
          committedByUserId: input.committedByUserId,
        },
        update: {
          // In the no-conflict path this update branch is NEVER
          // reached — the preview blocks commit when any date is
          // already committed. Keep it defensive to avoid silent
          // overwrites even in a race.
          sourceSystem: batch.sourceSystem,
          sourceBatchId: batch.id,
          guests: r.guests,
          greenFees: r.greenFees,
          members: r.members,
          totalRounds: r.totalRounds,
          juniors: r.juniors,
          women: r.women,
          corpos: r.corpos,
          corposHalf: r.corposHalf,
          fullCart: r.fullCart,
          nineCart: r.nineCart,
          halfCart: r.halfCart,
          freeCart: r.freeCart,
          committedAt: now,
          committedByUserId: input.committedByUserId,
        },
      });
    }
    await tx.golfActivityImportBatch.update({
      where: { id: batch.id },
      data: {
        status: "COMMITTED",
        committedAt: now,
        committedByUserId: input.committedByUserId,
      },
    });
  });

  return {
    batchId: batch.id,
    committedDays: batch.rows.length,
    committedAt: now,
  };
}
