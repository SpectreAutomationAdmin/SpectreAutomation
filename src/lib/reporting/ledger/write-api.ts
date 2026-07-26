// Reporting Ledger — write-side contract.
//
// See docs/reporting-ledger-architecture.md §4.2 + §6 for the full
// architecture. This file defines the typed interface the future
// Import Layer uses to publish snapshots into the ledger.
//
// IMPORTANT — this is a CONTRACT FILE. No implementation, no
// importer, no storage schema. Phase 1 work will introduce per-
// source adapters (`JonasGlImporter`, `JonasArImporter`, etc.) that
// produce `LedgerSnapshot` values and call `upsertSnapshot` /
// `beginImportBatch` to publish them.
//
// Write-API rules:
//
//   1. IMMUTABILITY. Snapshots are immutable once captured. A
//      re-import for the same logical identity
//      `(clubId, entityKind, period-or-date-key)` writes a NEW
//      physical row with a new `snapshotId` and a fresh
//      `capturedAt`. The previous row remains in history.
//
//   2. NO MUTATION. The writer never UPDATEs an existing row in
//      place — only INSERTs. This guarantees auditability.
//
//   3. REPLACEMENT SEMANTICS. When re-import values differ from the
//      prior snapshot, `upsertSnapshot` returns
//      `{ replaced: true }`. When re-import values are bit-
//      identical, the writer no-ops (no new physical row) and
//      returns `{ replaced: false }`. Either way the read API
//      returns the most recent committed snapshot.
//
//   4. BATCH ATOMICITY. Snapshots published inside a batch
//      (`beginImportBatch` → `commitImportBatch`) become readable
//      together or none of them do. Month-end close groups
//      4 entities (TB + IS + BS + AR aging) into one batch so
//      partial failures don't leave readers seeing inconsistent
//      derived totals.
//
//   5. IDEMPOTENT RE-RUNS. Running the same import a second time is
//      safe. Identical re-runs produce no new rows; revised re-runs
//      write replacements.

import type {
  LedgerSnapshot,
  LedgerSourceSystem,
} from "@/lib/reporting/ledger/contracts";

/**
 * Result of an `upsertSnapshot` call.
 *   - `snapshotId` — the id of the row the writer just persisted
 *     (when `replaced: false` AND values differed from the prior
 *     snapshot, OR when there was no prior snapshot). When the
 *     re-import is bit-identical to the prior snapshot, returns the
 *     existing snapshot's id.
 *   - `replaced` — `true` when a prior snapshot existed for the
 *     same logical identity and the new values differed. `false`
 *     for first-time writes AND for bit-identical re-runs.
 */
export type UpsertSnapshotResult = {
  snapshotId: string;
  replaced: boolean;
};

/**
 * Options passed when opening an import batch.
 */
export type BeginImportBatchOptions = {
  clubId: string;
  sourceSystem: LedgerSourceSystem;
  /** Optional free-form note describing the import (e.g.
   *  `"Jonas GL extract — fye_2026_m05.csv"`). Stored on every
   *  snapshot in the batch via `LedgerSnapshotMetadata.notes`. */
  notes?: string;
  /** Optional source file name (e.g. `"may_2026.csv"`) — preserved
   *  on the batch + propagated to the persistence layer so the
   *  admin import-history UI can show which file produced which
   *  snapshot. Backends that don't persist this (the in-memory
   *  ledger) MAY ignore the field. */
  sourceFile?: string;
};

/**
 * The Reporting Ledger write interface. Consumed by the future
 * Import Layer adapters. Phase 1 work supplies a concrete
 * implementation; this file ships the contract.
 *
 * NOT consumed by reporting services — they only read.
 *
 * NOT consumed by chart / KPI / commentary code — those live two
 * layers further up.
 */
export interface ReportingLedgerWriter {
  // -----------------------------------------------------------------
  // Single-snapshot writes
  // -----------------------------------------------------------------

  /**
   * Publish a single snapshot. Idempotent: bit-identical re-imports
   * no-op; revised re-imports write a new physical row that
   * supersedes the prior one. See class header for full immutability
   * + replacement rules.
   *
   * Callers typically pass `importBatchId: null` for stand-alone
   * writes. For atomic multi-entity month-end imports, use
   * `beginImportBatch` to obtain a batch id and pass it on every
   * snapshot in the batch.
   */
  upsertSnapshot(snapshot: LedgerSnapshot): Promise<UpsertSnapshotResult>;

  // -----------------------------------------------------------------
  // Batch lifecycle
  // -----------------------------------------------------------------

  /**
   * Begin a multi-snapshot atomic batch. Returns a batch id the
   * importer threads onto every `LedgerSnapshotMetadata.importBatchId`
   * field. Until the batch is committed, snapshots in it are NOT
   * readable through the read API.
   */
  beginImportBatch(opts: BeginImportBatchOptions): Promise<string>;

  /**
   * Commit a batch — every snapshot in it becomes readable at the
   * same instant. Idempotent; calling `commit` a second time is a
   * no-op. Throws if the batch was already rolled back.
   */
  commitImportBatch(batchId: string): Promise<void>;

  /**
   * Abort a batch — discards every snapshot written under that
   * batch id. Used when an import detects partial failure (e.g.
   * trial balance balanced but IS reconciliation failed). Idempotent;
   * calling `rollback` on an already-committed batch throws so the
   * importer is forced to handle the race explicitly.
   */
  rollbackImportBatch(batchId: string): Promise<void>;

  // -----------------------------------------------------------------
  // Diagnostics
  // -----------------------------------------------------------------

  /**
   * Inspect a batch's current state. Used by importers + admin
   * tooling for visibility into in-flight imports.
   */
  getImportBatchStatus(batchId: string): Promise<ImportBatchStatus | null>;
}

/**
 * Read-only view of an import batch's lifecycle.
 */
export type ImportBatchStatus = {
  batchId: string;
  clubId: string;
  sourceSystem: LedgerSourceSystem;
  /** `"pending"` — snapshots written but not yet committed;
   *  `"committed"` — readable through the read API;
   *  `"rolled-back"` — discarded; rows kept only for audit. */
  state: "pending" | "committed" | "rolled-back";
  /** Count of snapshots in the batch. */
  snapshotCount: number;
  openedAt: Date;
  closedAt: Date | null;
  notes: string | null;
  /** Optional source file name preserved from `BeginImportBatchOptions.sourceFile`. */
  sourceFile: string | null;
};

// ---------------------------------------------------------------------------
// Importer-side helpers (contracts only — no implementation)
// ---------------------------------------------------------------------------

/**
 * The shape a per-source Import Layer adapter implements. NOT part
 * of the core `ReportingLedgerWriter` interface — it's the
 * SOURCE-FACING side of the Import Layer, calling into the writer
 * with `LedgerSnapshot` values it derives from a source-system
 * extract.
 *
 * Each source (Jonas GL, Jonas AR, ADP Payroll, Spectre Accounting,
 * Lightspeed POS, ...) implements its own variant. The reporting
 * layer never sees these — they live entirely in the Import Layer.
 */
export interface LedgerImporter {
  /** Stable name of the source this importer adapts. */
  readonly sourceSystem: LedgerSourceSystem;

  /**
   * Import a source-system extract for a club. The importer is
   * responsible for:
   *   - parsing the source-system extract (CSV / API response / etc.)
   *   - mapping source-system account codes to the ledger's
   *     normalized chart of accounts
   *   - splitting the extract into one or more `LedgerSnapshot`
   *     entities (a Jonas GL extract typically produces 3:
   *     trial balance, income statement, balance sheet)
   *   - opening an `importBatch`, calling `upsertSnapshot` for each
   *     produced snapshot, then committing the batch
   *   - rolling back the batch on parse / mapping / reconciliation
   *     failure
   *
   * Returns the committed batch id on success. Throws on any
   * failure (the batch is already rolled back).
   */
  importExtract(input: ImporterInput): Promise<ImporterResult>;
}

/** Generic importer input. Adapters refine this shape. */
export type ImporterInput = {
  clubId: string;
  /** Source-system extract payload. Shape varies per adapter. */
  extract: unknown;
  /** Optional importer-level notes for audit (`importBatchId` is
   *  generated, but `notes` lets the importer record context like
   *  the upload filename). */
  notes?: string;
};

/** Generic importer result — committed batch + counts. */
export type ImporterResult = {
  batchId: string;
  snapshotCount: number;
  replacedCount: number;
  notes: string | null;
};
