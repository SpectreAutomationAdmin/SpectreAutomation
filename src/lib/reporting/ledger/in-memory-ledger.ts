// In-memory Reporting Ledger — reference implementation.
//
// Implements both `ReportingLedger` (read) and
// `ReportingLedgerWriter` (write) using in-process data structures.
// Used today by tests and local development; the Prisma-backed
// adapter (Phase 1) is a thin translation layer over the same
// interfaces.
//
// Semantics match the hybrid storage decision in
// `docs/reporting-ledger-storage-decision.md`:
//
//   • IMMUTABLE: rows are never updated in place. Replacements
//     insert a new physical row with a new `snapshotId` and a
//     fresh `capturedAt`. Old rows stay in history.
//
//   • IDEMPOTENT: bit-identical re-imports (same `payloadHash` as
//     the most recent committed snapshot for the same logical
//     identity) no-op and return `replaced: false`.
//
//   • ATOMIC BATCHES: snapshots written under a `pending` batch
//     are NOT visible to reads. `commitImportBatch` flips them to
//     `committed`; `rollbackImportBatch` marks them
//     `rolled-back` (preserved for audit, never visible to reads).
//
//   • MULTI-TENANT: every read filters on `clubId`. There is no
//     code path that returns a snapshot from another club.
//
//   • LATEST-WINS: when multiple committed snapshots exist for the
//     same logical identity, the most recent `capturedAt` wins.
//
// Storage representation:
//   - `snapshots: Map<snapshotId, StoredSnapshot>` — all rows
//     ever written, including pending and rolled-back.
//   - `batches:   Map<batchId, StoredBatch>` — batch lifecycle
//     records.
//   - Indices are recomputed on every read (acceptable for the
//     in-memory size envelope); the Prisma adapter uses real
//     indexes for the same query shapes.

import { randomUUID } from "node:crypto";

import type {
  LedgerSnapshot,
  LedgerSourceSystem,
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

import type {
  ArAgingSnapshot,
  BalanceSheetSnapshot,
  BudgetSnapshot,
  CapitalProjectSnapshot,
  IncomeStatementSnapshot,
  PayrollSnapshot,
  PriorYearSnapshot,
  TrialBalanceSnapshot,
} from "@/lib/reporting/ledger/contracts";

// ---------------------------------------------------------------------------
// Storage row shapes (internal)
// ---------------------------------------------------------------------------

type BatchState = "pending" | "committed" | "rolled-back";

type StoredSnapshot = {
  /** The snapshot as it was written (carries its own metadata). */
  snapshot: LedgerSnapshot;
  /** Hash of value-bearing payload — drives idempotency check. */
  payloadHash: string;
  /** Lifecycle state. Only `"committed"` rows are visible to reads. */
  batchState: BatchState;
};

type StoredBatch = {
  batchId: string;
  clubId: string;
  sourceSystem: LedgerSourceSystem;
  state: BatchState;
  notes: string | null;
  sourceFile: string | null;
  openedAt: Date;
  closedAt: Date | null;
  snapshotIds: Set<string>;
  snapshotCount: number;
};

// ---------------------------------------------------------------------------
// Logical identity — drives idempotency check
// ---------------------------------------------------------------------------

/**
 * Compute the logical-identity key for a snapshot. Two snapshots
 * with the same logical identity are interchangeable (one
 * replaces the other on re-import). Used to find the previous
 * snapshot for the idempotency check.
 */
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
// In-memory backend
// ---------------------------------------------------------------------------

/**
 * Concrete in-memory implementation of both read + write
 * interfaces. Safe to instantiate fresh per test; not safe for
 * cross-process reuse (no persistence).
 */
export class InMemoryReportingLedger
  implements
    ReportingLedger,
    ReportingLedgerWriter,
    ReportingLedgerPeriodHelpers
{
  private readonly snapshots = new Map<string, StoredSnapshot>();
  private readonly batches = new Map<string, StoredBatch>();

  // -----------------------------------------------------------------
  // Write API
  // -----------------------------------------------------------------

  async upsertSnapshot(
    incoming: LedgerSnapshot,
  ): Promise<UpsertSnapshotResult> {
    const incomingHash = computePayloadHash(incoming);

    // Find the most-recent COMMITTED snapshot for the same logical
    // identity. Bit-identical hash → no-op.
    const previous = this.findLatestCommitted(
      incoming.clubId,
      logicalIdentity(incoming),
    );
    if (previous && previous.payloadHash === incomingHash) {
      // No-op — bit-identical re-import.
      return { snapshotId: previous.snapshot.snapshotId, replaced: false };
    }

    // Otherwise insert a new physical row. If the snapshot is part
    // of a batch, batchState follows the batch's current lifecycle.
    let batchState: BatchState = "committed";
    if (incoming.importBatchId) {
      const batch = this.batches.get(incoming.importBatchId);
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
      // Pending batches accept writes; committed batches don't.
      if (batch.state === "committed") {
        throw new Error(
          `batch '${incoming.importBatchId}' is already committed; open a new batch`,
        );
      }
      batchState = "pending";
      batch.snapshotIds.add(incoming.snapshotId);
      batch.snapshotCount = batch.snapshotIds.size;
    }

    this.snapshots.set(incoming.snapshotId, {
      snapshot: incoming,
      payloadHash: incomingHash,
      batchState,
    });

    return {
      snapshotId: incoming.snapshotId,
      replaced: previous !== null,
    };
  }

  async beginImportBatch(opts: BeginImportBatchOptions): Promise<string> {
    const batchId = randomUUID();
    this.batches.set(batchId, {
      batchId,
      clubId: opts.clubId,
      sourceSystem: opts.sourceSystem,
      state: "pending",
      notes: opts.notes ?? null,
      sourceFile: opts.sourceFile ?? null,
      openedAt: new Date(),
      closedAt: null,
      snapshotIds: new Set(),
      snapshotCount: 0,
    });
    return batchId;
  }

  async commitImportBatch(batchId: string): Promise<void> {
    const batch = this.batches.get(batchId);
    if (!batch) throw new Error(`unknown batch '${batchId}'`);
    if (batch.state === "rolled-back") {
      throw new Error(
        `batch '${batchId}' was rolled back; cannot commit`,
      );
    }
    if (batch.state === "committed") return; // idempotent
    batch.state = "committed";
    batch.closedAt = new Date();
    for (const id of batch.snapshotIds) {
      const row = this.snapshots.get(id);
      if (row) row.batchState = "committed";
    }
  }

  async rollbackImportBatch(batchId: string): Promise<void> {
    const batch = this.batches.get(batchId);
    if (!batch) throw new Error(`unknown batch '${batchId}'`);
    if (batch.state === "committed") {
      throw new Error(
        `batch '${batchId}' was already committed; cannot roll back`,
      );
    }
    if (batch.state === "rolled-back") return; // idempotent
    batch.state = "rolled-back";
    batch.closedAt = new Date();
    for (const id of batch.snapshotIds) {
      const row = this.snapshots.get(id);
      if (row) row.batchState = "rolled-back";
    }
  }

  async getImportBatchStatus(
    batchId: string,
  ): Promise<ImportBatchStatus | null> {
    const batch = this.batches.get(batchId);
    if (!batch) return null;
    return {
      batchId: batch.batchId,
      clubId: batch.clubId,
      sourceSystem: batch.sourceSystem,
      state: batch.state,
      snapshotCount: batch.snapshotCount,
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
    return this.findLatestAsOfTrialBalance(clubId, asOf);
  }

  async getBalanceSheet(
    clubId: string,
    asOf: Date,
  ): Promise<BalanceSheetSnapshot | null> {
    return this.findLatestAsOfBalanceSheet(clubId, asOf);
  }

  async getArAging(
    clubId: string,
    asOf: Date,
  ): Promise<ArAgingSnapshot | null> {
    return this.findLatestAsOfArAging(clubId, asOf);
  }

  async getCapitalProjects(
    clubId: string,
    asOf: Date,
  ): Promise<CapitalProjectSnapshot | null> {
    return this.findLatestAsOfCapitalProjects(clubId, asOf);
  }

  // -----------------------------------------------------------------
  // Read API — period
  // -----------------------------------------------------------------

  async getIncomeStatement(
    clubId: string,
    periodStart: Date,
    periodEnd: Date,
  ): Promise<IncomeStatementSnapshot | null> {
    let best: IncomeStatementSnapshot | null = null;
    for (const s of this.committedSnapshotsForClub(clubId)) {
      if (s.entityKind !== "income-statement") continue;
      if (s.periodStart.getTime() !== periodStart.getTime()) continue;
      if (s.periodEnd.getTime() !== periodEnd.getTime()) continue;
      if (!best || s.capturedAt.getTime() > best.capturedAt.getTime()) best = s;
    }
    return best;
  }

  async getPayroll(
    clubId: string,
    periodStart: Date,
    periodEnd: Date,
  ): Promise<PayrollSnapshot | null> {
    let best: PayrollSnapshot | null = null;
    for (const s of this.committedSnapshotsForClub(clubId)) {
      if (s.entityKind !== "payroll") continue;
      if (s.periodStart.getTime() !== periodStart.getTime()) continue;
      if (s.periodEnd.getTime() !== periodEnd.getTime()) continue;
      if (!best || s.capturedAt.getTime() > best.capturedAt.getTime()) best = s;
    }
    return best;
  }

  // -----------------------------------------------------------------
  // Read API — fiscal year
  // -----------------------------------------------------------------

  async getBudget(
    clubId: string,
    fiscalYearLabel: string,
  ): Promise<BudgetSnapshot | null> {
    const candidates = this.committedSnapshotsForClub(clubId).filter(
      (s) => s.entityKind === "budget" && s.fiscalYearLabel === fiscalYearLabel,
    ) as BudgetSnapshot[];
    if (candidates.length === 0) return null;
    // Most recent version by `version` desc, then capturedAt desc.
    candidates.sort(
      (a, b) =>
        b.version - a.version ||
        b.capturedAt.getTime() - a.capturedAt.getTime(),
    );
    return candidates[0];
  }

  async getBudgetVersion(
    clubId: string,
    fiscalYearLabel: string,
    version: number,
  ): Promise<BudgetSnapshot | null> {
    const candidates = this.committedSnapshotsForClub(clubId).filter(
      (s): s is BudgetSnapshot =>
        s.entityKind === "budget" &&
        s.fiscalYearLabel === fiscalYearLabel &&
        s.version === version,
    );
    if (candidates.length === 0) return null;
    candidates.sort(
      (a, b) => b.capturedAt.getTime() - a.capturedAt.getTime(),
    );
    return candidates[0];
  }

  async getPriorYear(
    clubId: string,
    fiscalYearLabel: string,
  ): Promise<PriorYearSnapshot | null> {
    const candidates = this.committedSnapshotsForClub(clubId).filter(
      (s): s is PriorYearSnapshot =>
        s.entityKind === "prior-year" &&
        s.fiscalYearLabel === fiscalYearLabel,
    );
    if (candidates.length === 0) return null;
    candidates.sort(
      (a, b) => b.capturedAt.getTime() - a.capturedAt.getTime(),
    );
    return candidates[0];
  }

  // -----------------------------------------------------------------
  // Read API — trailing history
  // -----------------------------------------------------------------

  async listIncomeStatements(
    clubId: string,
    opts: LedgerHistoryWindow,
  ): Promise<ReadonlyArray<IncomeStatementSnapshot>> {
    return this.listInWindow(clubId, "income-statement", opts);
  }

  async listBalanceSheets(
    clubId: string,
    opts: LedgerHistoryWindow,
  ): Promise<ReadonlyArray<BalanceSheetSnapshot>> {
    return this.listInWindow(clubId, "balance-sheet", opts);
  }

  async listArAging(
    clubId: string,
    opts: LedgerHistoryWindow,
  ): Promise<ReadonlyArray<ArAgingSnapshot>> {
    return this.listInWindow(clubId, "ar-aging", opts);
  }

  async listPayroll(
    clubId: string,
    opts: LedgerHistoryWindow,
  ): Promise<ReadonlyArray<PayrollSnapshot>> {
    return this.listInWindow(clubId, "payroll", opts);
  }

  async listTrailingIncomeStatements(
    clubId: string,
    asOf: Date,
    count: number,
  ): Promise<ReadonlyArray<IncomeStatementSnapshot>> {
    // Use a 24-month window ending at `asOf` then slice to `count`.
    const start = new Date(asOf);
    start.setUTCFullYear(start.getUTCFullYear() - 2);
    const all = await this.listIncomeStatements(clubId, {
      startDate: start,
      endDate: asOf,
    });
    return all.slice(-count);
  }

  // -----------------------------------------------------------------
  // Internal query helpers
  // -----------------------------------------------------------------

  /** Return every committed snapshot for the club, latest-wins per
   *  logical identity. Tiebreaker on equal `capturedAt`: insertion
   *  order (Map iterates in insertion order), so the later-written
   *  row wins — semantically "last write wins" even at sub-ms clock
   *  resolution. */
  private committedSnapshotsForClub(clubId: string): LedgerSnapshot[] {
    const latestByIdentity = new Map<string, StoredSnapshot>();
    for (const row of this.snapshots.values()) {
      if (row.batchState !== "committed") continue;
      if (row.snapshot.clubId !== clubId) continue;
      const identity = logicalIdentity(row.snapshot);
      const existing = latestByIdentity.get(identity);
      if (
        !existing ||
        row.snapshot.capturedAt.getTime() >=
          existing.snapshot.capturedAt.getTime()
      ) {
        latestByIdentity.set(identity, row);
      }
    }
    return Array.from(latestByIdentity.values()).map((r) => r.snapshot);
  }

  /** Most recent committed snapshot matching the given logical
   *  identity. Used by the idempotency check. Tiebreaker matches
   *  `committedSnapshotsForClub`: last write wins. */
  private findLatestCommitted(
    clubId: string,
    identity: string,
  ): StoredSnapshot | null {
    let latest: StoredSnapshot | null = null;
    for (const row of this.snapshots.values()) {
      if (row.batchState !== "committed") continue;
      if (row.snapshot.clubId !== clubId) continue;
      if (logicalIdentity(row.snapshot) !== identity) continue;
      if (
        !latest ||
        row.snapshot.capturedAt.getTime() >=
          latest.snapshot.capturedAt.getTime()
      ) {
        latest = row;
      }
    }
    return latest;
  }

  /** Point-in-time helpers — one per asOf-bearing entity so the
   *  return type narrows cleanly per kind. */
  private findLatestAsOfTrialBalance(
    clubId: string,
    asOf: Date,
  ): TrialBalanceSnapshot | null {
    let best: TrialBalanceSnapshot | null = null;
    for (const s of this.committedSnapshotsForClub(clubId)) {
      if (s.entityKind !== "trial-balance") continue;
      if (s.asOf.getTime() > asOf.getTime()) continue;
      if (!best || s.asOf.getTime() > best.asOf.getTime()) best = s;
    }
    return best;
  }

  private findLatestAsOfBalanceSheet(
    clubId: string,
    asOf: Date,
  ): BalanceSheetSnapshot | null {
    let best: BalanceSheetSnapshot | null = null;
    for (const s of this.committedSnapshotsForClub(clubId)) {
      if (s.entityKind !== "balance-sheet") continue;
      if (s.asOf.getTime() > asOf.getTime()) continue;
      if (!best || s.asOf.getTime() > best.asOf.getTime()) best = s;
    }
    return best;
  }

  private findLatestAsOfArAging(
    clubId: string,
    asOf: Date,
  ): ArAgingSnapshot | null {
    let best: ArAgingSnapshot | null = null;
    for (const s of this.committedSnapshotsForClub(clubId)) {
      if (s.entityKind !== "ar-aging") continue;
      if (s.asOf.getTime() > asOf.getTime()) continue;
      if (!best || s.asOf.getTime() > best.asOf.getTime()) best = s;
    }
    return best;
  }

  private findLatestAsOfCapitalProjects(
    clubId: string,
    asOf: Date,
  ): CapitalProjectSnapshot | null {
    let best: CapitalProjectSnapshot | null = null;
    for (const s of this.committedSnapshotsForClub(clubId)) {
      if (s.entityKind !== "capital-project") continue;
      if (s.asOf.getTime() > asOf.getTime()) continue;
      if (!best || s.asOf.getTime() > best.asOf.getTime()) best = s;
    }
    return best;
  }

  /** History query: every committed snapshot of the given kind
   *  whose period (or `asOf` for point-in-time entities) falls
   *  inside the window. Returned chronologically. */
  private listInWindow<K extends LedgerSnapshot["entityKind"]>(
    clubId: string,
    entityKind: K,
    opts: LedgerHistoryWindow,
  ): ReadonlyArray<Extract<LedgerSnapshot, { entityKind: K }>> {
    const startMs = opts.startDate.getTime();
    const endMs = opts.endDate.getTime();
    const matches: Array<Extract<LedgerSnapshot, { entityKind: K }>> = [];
    for (const snapshot of this.committedSnapshotsForClub(clubId)) {
      if (snapshot.entityKind !== entityKind) continue;
      const t = dateKeyFor(snapshot).getTime();
      if (t < startMs || t > endMs) continue;
      matches.push(snapshot as Extract<LedgerSnapshot, { entityKind: K }>);
    }
    matches.sort(
      (a, b) => dateKeyFor(a).getTime() - dateKeyFor(b).getTime(),
    );
    if (opts.limit !== undefined && matches.length > opts.limit) {
      return matches.slice(matches.length - opts.limit);
    }
    return matches;
  }
}

/** Pick the canonical date for ordering / windowing a snapshot. */
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
