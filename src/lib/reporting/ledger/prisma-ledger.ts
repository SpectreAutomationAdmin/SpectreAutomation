// Reporting Ledger — Prisma-backed production implementation.
//
// Implements `ReportingLedger` + `ReportingLedgerWriter` +
// `ReportingLedgerPeriodHelpers` against the
// `ReportingLedgerSnapshot` + `ReportingLedgerBatch` Prisma models.
//
// External contract is IDENTICAL to `InMemoryReportingLedger` —
// the two are drop-in interchangeable. Existing tests that use the
// in-memory backend continue to work unchanged; production code
// uses this class with a real Prisma client.
//
// SEMANTICS (matches InMemoryReportingLedger):
//   • IMMUTABLE: rows are never updated in place. Replacements
//     insert a new physical row with a new `snapshotId` and a fresh
//     `capturedAt`. Old rows stay for audit.
//   • IDEMPOTENT: bit-identical re-imports (same `payloadHash` as
//     the most recent committed snapshot for the same logical
//     identity) no-op and return `replaced: false`.
//   • ATOMIC BATCHES: snapshots written under a `pending` batch
//     are NOT visible to reads. `commitImportBatch` flips them to
//     `committed`; `rollbackImportBatch` marks them
//     `rolled-back` (preserved for audit, never visible to reads).
//   • MULTI-TENANT: every read filters on `clubId`. There is no
//     code path that returns a snapshot from another club.
//   • LATEST-WINS: when multiple committed snapshots exist for the
//     same logical identity, the most recent `capturedAt` wins.
//     Ties broken by `createdAt` (DB insertion order).
//
// PERSISTENCE:
//   • Indexed columns drive every read API call (clubId, entityKind,
//     asOf, periodEnd, fiscalYearLabel, batchState, payloadHash,
//     importBatchId).
//   • `payloadJson` carries the full entity-specific snapshot
//     payload — Date fields are ISO strings in JSON, re-hydrated
//     on read via `rehydrateSnapshot`.
//   • Audit columns (createdAt, importedAt, sourceSystem, sourceFile,
//     reportingPeriod) are populated at write time for the admin
//     import-history UI.

import { randomUUID } from "node:crypto";

import { PrismaClient, type Prisma } from "@prisma/client";

import type {
  ArAgingSnapshot,
  BalanceSheetSnapshot,
  BudgetSnapshot,
  CapitalProjectSnapshot,
  IncomeStatementSnapshot,
  LedgerSnapshot,
  LedgerSourceSystem,
  PayrollSnapshot,
  PriorYearSnapshot,
  TrialBalanceSnapshot,
} from "@/lib/reporting/ledger/contracts";
import type {
  LedgerHistoryWindow,
  ReportingLedger,
  ReportingLedgerPeriodHelpers,
} from "@/lib/reporting/ledger/read-api";
import type {
  BeginImportBatchOptions,
  ImportBatchStatus,
  ReportingLedgerWriter,
  UpsertSnapshotResult,
} from "@/lib/reporting/ledger/write-api";

import { computePayloadHash } from "@/lib/reporting/ledger/payload-hash";
// Founder rule 2026-07-01 v14.11 — fall back to live-synthesized
// snapshots when no persisted snapshot exists but a real Opening
// Trial Balance import has been committed. Solves the Monthly
// Reporting Package's demo-fallback problem without a legacy
// Jonas import pipeline.
import {
  synthesizeBalanceSheetSnapshot,
  synthesizeIncomeStatementSnapshot,
  synthesizeTrialBalanceSnapshot,
} from "@/lib/reporting/ledger/live-synthesis";
import {
  dehydrateSnapshot,
  extractPeriodKeys,
  rehydrateSnapshot,
} from "@/lib/reporting/ledger/prisma-hydration";

// ---------------------------------------------------------------------------
// Logical identity — same shape as InMemoryReportingLedger so callers
// see the same dedup behaviour.
// ---------------------------------------------------------------------------

function logicalIdentity(snapshot: LedgerSnapshot): string {
  const base = `${snapshot.clubId}::${snapshot.entityKind}::`;
  switch (snapshot.entityKind) {
    case "trial-balance":
    case "balance-sheet":
    case "ar-aging":
    case "capital-project":
      return `${base}${snapshot.asOf.toISOString()}`;
    case "income-statement":
    case "payroll":
      return `${base}${snapshot.periodStart.toISOString()}..${snapshot.periodEnd.toISOString()}`;
    case "budget":
      return `${base}${snapshot.fiscalYearLabel}::v${snapshot.version}`;
    case "prior-year":
      return `${base}${snapshot.fiscalYearLabel}`;
  }
}

// ---------------------------------------------------------------------------
// PrismaReportingLedger
// ---------------------------------------------------------------------------

export class PrismaReportingLedger
  implements
    ReportingLedger,
    ReportingLedgerWriter,
    ReportingLedgerPeriodHelpers
{
  constructor(private readonly prisma: PrismaClient) {}

  // -----------------------------------------------------------------
  // Write API
  // -----------------------------------------------------------------

  async upsertSnapshot(
    incoming: LedgerSnapshot,
  ): Promise<UpsertSnapshotResult> {
    const incomingHash = computePayloadHash(incoming);

    // Find the most-recent COMMITTED snapshot for the same logical
    // identity. Bit-identical hash → no-op.
    const previous = await this.findLatestCommittedRow(
      incoming.clubId,
      incoming.entityKind,
      identityFilter(incoming),
    );
    if (previous && previous.payloadHash === incomingHash) {
      return { snapshotId: previous.snapshotId, replaced: false };
    }

    // Resolve batch state — if the snapshot carries an importBatchId,
    // the row's batchState follows the batch's current state.
    let batchState: "pending" | "committed" | "rolled-back" = "committed";
    let sourceFile: string | null = null;
    if (incoming.importBatchId) {
      const batch = await this.prisma.reportingLedgerBatch.findUnique({
        where: { batchId: incoming.importBatchId },
      });
      if (!batch) {
        throw new Error(
          `unknown import batch '${incoming.importBatchId}' — call beginImportBatch first`,
        );
      }
      if (batch.state === "rolled-back") {
        throw new Error(
          `cannot write to rolled-back batch '${incoming.importBatchId}'`,
        );
      }
      if (batch.state === "committed") {
        throw new Error(
          `batch '${incoming.importBatchId}' is already committed; open a new batch`,
        );
      }
      batchState = "pending";
      sourceFile = batch.sourceFile;
    }

    const keys = extractPeriodKeys(incoming);
    const now = new Date();

    await this.prisma.reportingLedgerSnapshot.create({
      data: {
        snapshotId: incoming.snapshotId,
        clubId: incoming.clubId,
        entityKind: incoming.entityKind,
        batchState,
        importBatchId: incoming.importBatchId,
        capturedAt: incoming.capturedAt,
        createdAt: now,
        importedAt: incoming.capturedAt,
        sourceSystem: incoming.sourceSystem,
        sourceFile,
        dataSource: incoming.dataSource,
        notes: incoming.notes,
        asOf: keys.asOf,
        periodStart: keys.periodStart,
        periodEnd: keys.periodEnd,
        fiscalYearLabel: keys.fiscalYearLabel,
        reportingPeriod: keys.reportingPeriod,
        payloadHash: incomingHash,
        payloadJson: dehydrateSnapshot(incoming),
      },
    });

    return {
      snapshotId: incoming.snapshotId,
      replaced: previous !== null,
    };
  }

  async beginImportBatch(opts: BeginImportBatchOptions): Promise<string> {
    const batchId = randomUUID();
    await this.prisma.reportingLedgerBatch.create({
      data: {
        batchId,
        clubId: opts.clubId,
        sourceSystem: opts.sourceSystem,
        state: "pending",
        notes: opts.notes ?? null,
        sourceFile: opts.sourceFile ?? null,
      },
    });
    return batchId;
  }

  async commitImportBatch(batchId: string): Promise<void> {
    const batch = await this.prisma.reportingLedgerBatch.findUnique({
      where: { batchId },
    });
    if (!batch) throw new Error(`unknown batch '${batchId}'`);
    if (batch.state === "rolled-back") {
      throw new Error(`batch '${batchId}' was rolled back; cannot commit`);
    }
    if (batch.state === "committed") return; // idempotent

    await this.prisma.$transaction([
      this.prisma.reportingLedgerBatch.update({
        where: { batchId },
        data: { state: "committed", closedAt: new Date() },
      }),
      this.prisma.reportingLedgerSnapshot.updateMany({
        where: { importBatchId: batchId, batchState: "pending" },
        data: { batchState: "committed" },
      }),
    ]);
  }

  async rollbackImportBatch(batchId: string): Promise<void> {
    const batch = await this.prisma.reportingLedgerBatch.findUnique({
      where: { batchId },
    });
    if (!batch) throw new Error(`unknown batch '${batchId}'`);
    if (batch.state === "committed") {
      throw new Error(
        `batch '${batchId}' was already committed; cannot roll back`,
      );
    }
    if (batch.state === "rolled-back") return; // idempotent

    await this.prisma.$transaction([
      this.prisma.reportingLedgerBatch.update({
        where: { batchId },
        data: { state: "rolled-back", closedAt: new Date() },
      }),
      this.prisma.reportingLedgerSnapshot.updateMany({
        where: { importBatchId: batchId, batchState: "pending" },
        data: { batchState: "rolled-back" },
      }),
    ]);
  }

  async getImportBatchStatus(
    batchId: string,
  ): Promise<ImportBatchStatus | null> {
    const batch = await this.prisma.reportingLedgerBatch.findUnique({
      where: { batchId },
      include: { _count: { select: { snapshots: true } } },
    });
    if (!batch) return null;
    return {
      batchId: batch.batchId,
      clubId: batch.clubId,
      sourceSystem: batch.sourceSystem as LedgerSourceSystem,
      state: batch.state as ImportBatchStatus["state"],
      snapshotCount: batch._count.snapshots,
      openedAt: batch.openedAt,
      closedAt: batch.closedAt,
      notes: batch.notes,
      sourceFile: batch.sourceFile,
    };
  }

  // -----------------------------------------------------------------
  // Read API — point-in-time
  // -----------------------------------------------------------------

  async getTrialBalance(
    clubId: string,
    asOf: Date,
  ): Promise<TrialBalanceSnapshot | null> {
    const persisted = await this.findLatestAsOf<TrialBalanceSnapshot>(
      clubId,
      "trial-balance",
      asOf,
    );
    if (persisted) return persisted;
    // v14.11 — live synthesis fallback. Returns null if the club
    // has no committed real TB, preserving the demo-fallback
    // behaviour for pre-import clubs.
    return synthesizeTrialBalanceSnapshot(clubId, asOf);
  }

  async getBalanceSheet(
    clubId: string,
    asOf: Date,
  ): Promise<BalanceSheetSnapshot | null> {
    const persisted = await this.findLatestAsOf<BalanceSheetSnapshot>(
      clubId,
      "balance-sheet",
      asOf,
    );
    if (persisted) return persisted;
    return synthesizeBalanceSheetSnapshot(clubId, asOf);
  }

  async getArAging(clubId: string, asOf: Date): Promise<ArAgingSnapshot | null> {
    return this.findLatestAsOf<ArAgingSnapshot>(clubId, "ar-aging", asOf);
  }

  async getCapitalProjects(
    clubId: string,
    asOf: Date,
  ): Promise<CapitalProjectSnapshot | null> {
    return this.findLatestAsOf<CapitalProjectSnapshot>(
      clubId,
      "capital-project",
      asOf,
    );
  }

  // -----------------------------------------------------------------
  // Read API — period
  // -----------------------------------------------------------------

  async getIncomeStatement(
    clubId: string,
    periodStart: Date,
    periodEnd: Date,
  ): Promise<IncomeStatementSnapshot | null> {
    const persisted = await this.findExactPeriod<IncomeStatementSnapshot>(
      clubId,
      "income-statement",
      periodStart,
      periodEnd,
    );
    if (persisted) return persisted;
    return synthesizeIncomeStatementSnapshot(clubId, periodStart, periodEnd);
  }

  async getPayroll(
    clubId: string,
    periodStart: Date,
    periodEnd: Date,
  ): Promise<PayrollSnapshot | null> {
    return this.findExactPeriod<PayrollSnapshot>(
      clubId,
      "payroll",
      periodStart,
      periodEnd,
    );
  }

  // -----------------------------------------------------------------
  // Read API — fiscal year
  // -----------------------------------------------------------------

  async getBudget(
    clubId: string,
    fiscalYearLabel: string,
  ): Promise<BudgetSnapshot | null> {
    const rows = await this.prisma.reportingLedgerSnapshot.findMany({
      where: {
        clubId,
        entityKind: "budget",
        batchState: "committed",
        fiscalYearLabel,
      },
      orderBy: [{ capturedAt: "desc" }, { createdAt: "desc" }],
    });
    if (rows.length === 0) return null;
    // Latest version wins; among same version, latest capturedAt wins.
    const snapshots = rows.map((r) =>
      rehydrateSnapshot(r.payloadJson) as BudgetSnapshot,
    );
    snapshots.sort(
      (a, b) =>
        b.version - a.version ||
        b.capturedAt.getTime() - a.capturedAt.getTime(),
    );
    return snapshots[0];
  }

  async getBudgetVersion(
    clubId: string,
    fiscalYearLabel: string,
    version: number,
  ): Promise<BudgetSnapshot | null> {
    const rows = await this.prisma.reportingLedgerSnapshot.findMany({
      where: {
        clubId,
        entityKind: "budget",
        batchState: "committed",
        fiscalYearLabel,
      },
      orderBy: [{ capturedAt: "desc" }, { createdAt: "desc" }],
    });
    const snapshots = rows
      .map((r) => rehydrateSnapshot(r.payloadJson) as BudgetSnapshot)
      .filter((b) => b.version === version);
    return snapshots[0] ?? null;
  }

  async getPriorYear(
    clubId: string,
    fiscalYearLabel: string,
  ): Promise<PriorYearSnapshot | null> {
    const rows = await this.prisma.reportingLedgerSnapshot.findMany({
      where: {
        clubId,
        entityKind: "prior-year",
        batchState: "committed",
        fiscalYearLabel,
      },
      orderBy: [{ capturedAt: "desc" }, { createdAt: "desc" }],
      take: 1,
    });
    if (rows.length === 0) return null;
    return rehydrateSnapshot(rows[0].payloadJson) as PriorYearSnapshot;
  }

  // -----------------------------------------------------------------
  // Read API — trailing history
  // -----------------------------------------------------------------

  async listIncomeStatements(
    clubId: string,
    opts: LedgerHistoryWindow,
  ): Promise<ReadonlyArray<IncomeStatementSnapshot>> {
    return this.listInWindow<IncomeStatementSnapshot>(
      clubId,
      "income-statement",
      opts,
    );
  }

  async listBalanceSheets(
    clubId: string,
    opts: LedgerHistoryWindow,
  ): Promise<ReadonlyArray<BalanceSheetSnapshot>> {
    return this.listInWindow<BalanceSheetSnapshot>(
      clubId,
      "balance-sheet",
      opts,
    );
  }

  async listArAging(
    clubId: string,
    opts: LedgerHistoryWindow,
  ): Promise<ReadonlyArray<ArAgingSnapshot>> {
    return this.listInWindow<ArAgingSnapshot>(clubId, "ar-aging", opts);
  }

  async listPayroll(
    clubId: string,
    opts: LedgerHistoryWindow,
  ): Promise<ReadonlyArray<PayrollSnapshot>> {
    return this.listInWindow<PayrollSnapshot>(clubId, "payroll", opts);
  }

  async listTrailingIncomeStatements(
    clubId: string,
    asOf: Date,
    count: number,
  ): Promise<ReadonlyArray<IncomeStatementSnapshot>> {
    const start = new Date(asOf);
    start.setUTCFullYear(start.getUTCFullYear() - 2);
    const all = await this.listIncomeStatements(clubId, {
      startDate: start,
      endDate: asOf,
    });
    return all.slice(-count);
  }

  // -----------------------------------------------------------------
  // Internal — typed helpers
  // -----------------------------------------------------------------

  /** Find the most-recent COMMITTED snapshot for an entity at-or-before
   *  the requested asOf. Returns null if none exists. */
  private async findLatestAsOf<T extends LedgerSnapshot>(
    clubId: string,
    entityKind: T["entityKind"],
    asOf: Date,
  ): Promise<T | null> {
    // Identity dedup happens at write time (upsertSnapshot checks the
    // payload hash). For asOf-bearing entities, the "latest" is the
    // snapshot whose `asOf` is closest to (but not after) the
    // requested `asOf`, breaking ties on `capturedAt` desc then
    // `createdAt` desc.
    const row = await this.prisma.reportingLedgerSnapshot.findFirst({
      where: {
        clubId,
        entityKind,
        batchState: "committed",
        asOf: { lte: asOf },
      },
      orderBy: [
        { asOf: "desc" },
        { capturedAt: "desc" },
        { createdAt: "desc" },
      ],
    });
    if (!row) return null;
    return rehydrateSnapshot(row.payloadJson) as T;
  }

  /** Find a snapshot with exact periodStart + periodEnd match. */
  private async findExactPeriod<T extends LedgerSnapshot>(
    clubId: string,
    entityKind: T["entityKind"],
    periodStart: Date,
    periodEnd: Date,
  ): Promise<T | null> {
    const row = await this.prisma.reportingLedgerSnapshot.findFirst({
      where: {
        clubId,
        entityKind,
        batchState: "committed",
        periodStart,
        periodEnd,
      },
      orderBy: [{ capturedAt: "desc" }, { createdAt: "desc" }],
    });
    if (!row) return null;
    return rehydrateSnapshot(row.payloadJson) as T;
  }

  /** Find the most-recent COMMITTED snapshot matching the given
   *  logical identity. Used by the idempotency check. */
  private async findLatestCommittedRow(
    clubId: string,
    entityKind: LedgerSnapshot["entityKind"],
    where: Prisma.ReportingLedgerSnapshotWhereInput,
  ): Promise<{ snapshotId: string; payloadHash: string } | null> {
    const row = await this.prisma.reportingLedgerSnapshot.findFirst({
      where: { clubId, entityKind, batchState: "committed", ...where },
      orderBy: [{ capturedAt: "desc" }, { createdAt: "desc" }],
      select: { snapshotId: true, payloadHash: true },
    });
    return row;
  }

  /** History query: every committed snapshot of the given kind whose
   *  ordering-date falls inside the window. Returned chronologically. */
  private async listInWindow<T extends LedgerSnapshot>(
    clubId: string,
    entityKind: T["entityKind"],
    opts: LedgerHistoryWindow,
  ): Promise<ReadonlyArray<T>> {
    const dateCol = isAsOfEntity(entityKind) ? "asOf" : "periodEnd";
    const rows = await this.prisma.reportingLedgerSnapshot.findMany({
      where: {
        clubId,
        entityKind,
        batchState: "committed",
        [dateCol]: {
          gte: opts.startDate,
          lte: opts.endDate,
        },
      },
      orderBy: [{ [dateCol]: "asc" }, { capturedAt: "asc" }],
    });
    // Latest-wins per logical identity (collapse re-imports).
    const latestByIdentity = new Map<string, T>();
    for (const r of rows) {
      const snap = rehydrateSnapshot(r.payloadJson) as T;
      const id = logicalIdentity(snap);
      const existing = latestByIdentity.get(id);
      if (!existing || snap.capturedAt.getTime() >= existing.capturedAt.getTime()) {
        latestByIdentity.set(id, snap);
      }
    }
    const matches = Array.from(latestByIdentity.values());
    matches.sort((a, b) => {
      const ad = dateKeyFor(a).getTime();
      const bd = dateKeyFor(b).getTime();
      return ad - bd;
    });
    if (opts.limit !== undefined && matches.length > opts.limit) {
      return matches.slice(matches.length - opts.limit);
    }
    return matches;
  }
}

// ---------------------------------------------------------------------------
// Internal helpers — entity-shape helpers
// ---------------------------------------------------------------------------

function isAsOfEntity(kind: LedgerSnapshot["entityKind"]): boolean {
  return (
    kind === "trial-balance" ||
    kind === "balance-sheet" ||
    kind === "ar-aging" ||
    kind === "capital-project"
  );
}

function identityFilter(
  snapshot: LedgerSnapshot,
): Prisma.ReportingLedgerSnapshotWhereInput {
  switch (snapshot.entityKind) {
    case "trial-balance":
    case "balance-sheet":
    case "ar-aging":
    case "capital-project":
      return { asOf: snapshot.asOf };
    case "income-statement":
    case "payroll":
      return {
        periodStart: snapshot.periodStart,
        periodEnd: snapshot.periodEnd,
      };
    case "budget":
      // Logical identity also includes version, but it's stored only
      // inside the payload. For dedup we fetch by fiscalYearLabel and
      // version-filter in JS.
      return { fiscalYearLabel: snapshot.fiscalYearLabel };
    case "prior-year":
      return { fiscalYearLabel: snapshot.fiscalYearLabel };
  }
}

function dateKeyFor(snapshot: LedgerSnapshot): Date {
  switch (snapshot.entityKind) {
    case "trial-balance":
    case "balance-sheet":
    case "ar-aging":
    case "capital-project":
      return snapshot.asOf;
    case "income-statement":
    case "payroll":
      return snapshot.periodEnd;
    case "budget":
      return snapshot.endDate;
    case "prior-year":
      return snapshot.periodEnd;
  }
}
