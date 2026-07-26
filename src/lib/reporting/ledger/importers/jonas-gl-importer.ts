// JonasGlImporter — the first Reporting Ledger importer.
//
// Workflow per docs/reporting-ledger-architecture.md §2:
//
//   Jonas GL CSV
//       ↓ (parse + validate)
//   parsed rows
//       ↓ (account mapping)
//   mapped accounts + balanced trial-balance lines
//       ↓ (batch lifecycle on the ledger writer)
//   TrialBalanceSnapshot in the Reporting Ledger
//
// Diagnostics:
//   • CSV file errors (missing header / missing columns / empty)
//   • Per-row parse errors (with line numbers + offending cells)
//   • Per-row mapping errors (account code with no rule)
//   • Trial-balance reconciliation (totalDebits vs totalCredits)
//   • Duplicate-import detection (per-club content-hash history)
//
// Tenant isolation:
//   Every import is bound to a `clubId`. The importer never crosses
//   club boundaries — the ledger writer enforces the same via its
//   per-snapshot `clubId` field. The in-memory import history is
//   indexed by clubId.

import { createHash, randomUUID } from "node:crypto";

import type {
  LedgerAccount,
  TrialBalanceLine,
  TrialBalanceSnapshot,
} from "@/lib/reporting/ledger/contracts";
import type {
  ImporterInput,
  ImporterResult,
  LedgerImporter,
  ReportingLedgerWriter,
} from "@/lib/reporting/ledger/write-api";

import {
  parseJonasGlCsv,
  type JonasGlCsvFileError,
  type JonasGlCsvParseResult,
  type JonasGlCsvRow,
  type JonasGlCsvRowError,
} from "@/lib/reporting/ledger/importers/jonas-gl-csv";
import {
  DEFAULT_JONAS_ACCOUNT_MAPPING,
  mapJonasAccount,
  toLedgerAccount,
  type JonasAccountMapping,
  type MappedAccount,
} from "@/lib/reporting/ledger/importers/jonas-gl-mapping";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Source-system input passed to `JonasGlImporter.importExtract`. */
export type JonasGlImporterInput = ImporterInput & {
  extract: {
    /** Raw CSV content. */
    csv: string;
    /** Filename / extract identifier — appears in audit notes. */
    filename: string;
    /** Reporting period end date — overrides any per-row period
     *  field when set. The Trial Balance snapshot's `asOf` derives
     *  from this. */
    periodEnd: Date;
    /** Period start (inclusive). Typically the first day of the
     *  fiscal month. */
    periodStart: Date;
    /** Fiscal year + sequence — used when the CSV rows don't carry
     *  them or when the source value should be overridden. When
     *  omitted, the importer uses the first-row values. */
    fiscalYearLabel?: string;
    fiscalPeriodSequence?: number;
  };
};

/** Per-row mapping error. */
export type MappingError = {
  lineNumber: number;
  accountNumber: string;
  accountDescription: string;
  message: string;
};

/** Trial-balance reconciliation check. */
export type ReconciliationResult = {
  totalDebits: number;
  totalCredits: number;
  delta: number;
  /** True when |delta| < $1 — the same tolerance the storage layer
   *  uses for the balance-sheet check. */
  isBalanced: boolean;
};

/** What the importer learned about a single import attempt — the
 *  human-and-machine-readable diagnostic block. */
export type JonasImportDiagnostics = {
  /** How many CSV rows the parser produced (excluding the header). */
  rowCount: number;
  /** Trial-balance reconciliation. */
  reconciliation: ReconciliationResult;
  /** Per-row mapping coverage. */
  mappingCoverage: {
    mapped: number;
    unmapped: number;
    fromOverride: number;
    fromRangeRule: number;
    fromJonasTypeHint: number;
  };
  /** Parse / mapping errors. Non-empty means the import was
   *  aborted; reads will return null until corrected. */
  fileErrors: JonasGlCsvFileError[];
  rowErrors: JonasGlCsvRowError[];
  mappingErrors: MappingError[];
  /** Non-fatal warnings (e.g. ignored optional columns). */
  warnings: JonasGlCsvRowError[];
};

/** Per-attempt history row. Mirrors what the eventual Prisma table
 *  will persist; for now the in-memory store on the importer owns
 *  the records. */
export type JonasImportHistoryEntry = {
  importId: string;
  clubId: string;
  filename: string;
  attemptedAt: Date;
  /** SHA-256 of the canonical (clubId + content + period) — drives
   *  duplicate detection. */
  contentHash: string;
  status: JonasImportStatus;
  diagnostics: JonasImportDiagnostics;
  /** Resulting batchId in the Reporting Ledger (when committed). */
  batchId: string | null;
  /** Snapshot id (when committed). */
  snapshotId: string | null;
};

export type JonasImportStatus =
  | "succeeded"
  | "failed-validation"
  | "failed-mapping"
  | "failed-reconciliation"
  | "duplicate-no-op";

/** Return value from `importExtract`. Mirrors `ImporterResult`
 *  shape with Jonas-specific extras. */
export type JonasImporterResult = ImporterResult & {
  importId: string;
  status: JonasImportStatus;
  diagnostics: JonasImportDiagnostics;
  /** The committed trial-balance snapshot id (when status is
   *  "succeeded"). */
  snapshotId: string | null;
};

// ---------------------------------------------------------------------------
// In-memory import history
// ---------------------------------------------------------------------------

/**
 * Per-importer in-memory log of every import attempt. Used for:
 *   • Duplicate detection — re-importing the same CSV for the same
 *     period is a no-op.
 *   • Audit history — admins can list past attempts + see why a
 *     failed import failed.
 *
 * Prisma backend (Phase 1 deployment) will swap this for a real
 * table. The interface stays the same.
 */
export class InMemoryJonasImportHistory {
  private readonly entries = new Map<string, JonasImportHistoryEntry>();
  // Monotonic insertion order — drives "newest first" ordering even
  // when multiple imports land in the same wall-clock millisecond.
  private readonly insertionSeq = new Map<string, number>();
  private nextSeq = 0;

  /** Record a new attempt — called BEFORE the import is committed
   *  so failed imports show up in history too. */
  record(entry: JonasImportHistoryEntry): void {
    this.entries.set(entry.importId, entry);
    if (!this.insertionSeq.has(entry.importId)) {
      this.insertionSeq.set(entry.importId, this.nextSeq++);
    }
  }

  /** Update an existing attempt — used to bind a successful
   *  import to its resulting batchId / snapshotId after commit. */
  update(
    importId: string,
    patch: Partial<
      Pick<JonasImportHistoryEntry, "status" | "batchId" | "snapshotId">
    >,
  ): void {
    const existing = this.entries.get(importId);
    if (!existing) return;
    this.entries.set(importId, { ...existing, ...patch });
  }

  /** Find a previously-committed import for the same logical
   *  identity (clubId + content + period). Used by duplicate
   *  detection. */
  findMatchingCommitted(
    clubId: string,
    contentHash: string,
  ): JonasImportHistoryEntry | null {
    for (const entry of this.entries.values()) {
      if (entry.clubId !== clubId) continue;
      if (entry.contentHash !== contentHash) continue;
      if (entry.status !== "succeeded") continue;
      return entry;
    }
    return null;
  }

  /** List every entry for a club, newest first. Used by the admin
   *  UI (when wired) and by tests. Tiebreaker on equal `attemptedAt`
   *  is insertion order — most-recently-recorded entry wins. */
  listForClub(clubId: string): JonasImportHistoryEntry[] {
    return Array.from(this.entries.values())
      .filter((e) => e.clubId === clubId)
      .sort((a, b) => {
        const dt = b.attemptedAt.getTime() - a.attemptedAt.getTime();
        if (dt !== 0) return dt;
        return (
          (this.insertionSeq.get(b.importId) ?? 0) -
          (this.insertionSeq.get(a.importId) ?? 0)
        );
      });
  }
}

// ---------------------------------------------------------------------------
// The importer
// ---------------------------------------------------------------------------

/**
 * Jonas GL → Reporting Ledger Trial Balance importer.
 *
 * Implements the `LedgerImporter` interface from
 * `src/lib/reporting/ledger/write-api.ts`. Constructed with the
 * ledger writer + an optional per-club mapping; carries its own
 * in-memory import history.
 */
export class JonasGlImporter implements LedgerImporter {
  readonly sourceSystem = "jonas-gl" as const;

  private readonly writer: ReportingLedgerWriter;
  private readonly mapping: JonasAccountMapping;
  readonly history: InMemoryJonasImportHistory;

  constructor(args: {
    writer: ReportingLedgerWriter;
    mapping?: JonasAccountMapping;
    history?: InMemoryJonasImportHistory;
  }) {
    this.writer = args.writer;
    this.mapping = args.mapping ?? DEFAULT_JONAS_ACCOUNT_MAPPING;
    this.history = args.history ?? new InMemoryJonasImportHistory();
  }

  async importExtract(input: ImporterInput): Promise<ImporterResult> {
    const jonasInput = input as JonasGlImporterInput;
    return this.importJonasExtract(jonasInput);
  }

  /**
   * Type-narrowed variant of `importExtract` for callers that have
   * the `JonasGlImporterInput` shape — returns the Jonas-specific
   * result with diagnostics + status + snapshotId.
   */
  async importJonasExtract(
    input: JonasGlImporterInput,
  ): Promise<JonasImporterResult> {
    const importId = randomUUID();
    const attemptedAt = new Date();
    const { csv, filename, periodEnd, periodStart } = input.extract;

    // -------------------------------------------------------------
    // 0. Compute content hash for duplicate detection.
    // -------------------------------------------------------------
    const contentHash = computeContentHash(
      input.clubId,
      csv,
      periodEnd.toISOString(),
    );

    // -------------------------------------------------------------
    // 1. Duplicate check — re-import of the SAME csv for the SAME
    //    period for the SAME club → no-op.
    // -------------------------------------------------------------
    const existing = this.history.findMatchingCommitted(input.clubId, contentHash);
    if (existing) {
      const diagnostics: JonasImportDiagnostics = {
        rowCount: existing.diagnostics.rowCount,
        reconciliation: existing.diagnostics.reconciliation,
        mappingCoverage: existing.diagnostics.mappingCoverage,
        fileErrors: [],
        rowErrors: [],
        mappingErrors: [],
        warnings: [],
      };
      this.history.record({
        importId,
        clubId: input.clubId,
        filename,
        attemptedAt,
        contentHash,
        status: "duplicate-no-op",
        diagnostics,
        batchId: existing.batchId,
        snapshotId: existing.snapshotId,
      });
      return {
        importId,
        status: "duplicate-no-op",
        diagnostics,
        batchId: existing.batchId ?? "",
        snapshotId: existing.snapshotId,
        snapshotCount: existing.snapshotId ? 1 : 0,
        replacedCount: 0,
        notes:
          `Duplicate import: this CSV has already been imported for ${input.clubId}` +
          ` at period ${periodEnd.toISOString()}; no new snapshot written.`,
      };
    }

    // -------------------------------------------------------------
    // 2. Parse + validate the CSV.
    // -------------------------------------------------------------
    const parseResult = parseJonasGlCsv(csv);
    if (!parseResult.ok) {
      const diagnostics = blankDiagnostics({
        fileErrors: parseResult.fileErrors,
        rowErrors: parseResult.rowErrors,
      });
      this.history.record({
        importId,
        clubId: input.clubId,
        filename,
        attemptedAt,
        contentHash,
        status: "failed-validation",
        diagnostics,
        batchId: null,
        snapshotId: null,
      });
      return {
        importId,
        status: "failed-validation",
        diagnostics,
        batchId: "",
        snapshotId: null,
        snapshotCount: 0,
        replacedCount: 0,
        notes: input.notes ?? null,
      };
    }

    const csvRows = parseResult.rows;

    // -------------------------------------------------------------
    // 3. Account mapping.
    // -------------------------------------------------------------
    const mappingErrors: MappingError[] = [];
    const mappedAccounts: Array<{ row: JonasGlCsvRow; mapped: MappedAccount }> =
      [];
    const mappingSourceTally = {
      fromOverride: 0,
      fromRangeRule: 0,
      fromJonasTypeHint: 0,
    };

    for (const row of csvRows) {
      const mapped = mapJonasAccount(
        {
          accountNumber: row.accountNumber,
          accountDescription: row.accountDescription,
          jonasAccountType: row.jonasAccountType,
        },
        this.mapping,
      );
      if (!mapped) {
        mappingErrors.push({
          lineNumber: row.lineNumber,
          accountNumber: row.accountNumber,
          accountDescription: row.accountDescription,
          message:
            `No mapping rule for account '${row.accountNumber}' ` +
            `('${row.accountDescription}'). Add an override to the club's account mapping.`,
        });
        continue;
      }
      switch (mapped.source) {
        case "explicit-override":
          mappingSourceTally.fromOverride++;
          break;
        case "range-rule":
          mappingSourceTally.fromRangeRule++;
          break;
        case "jonas-type-hint":
          mappingSourceTally.fromJonasTypeHint++;
          break;
      }
      mappedAccounts.push({ row, mapped });
    }

    if (mappingErrors.length > 0) {
      const diagnostics: JonasImportDiagnostics = {
        rowCount: csvRows.length,
        reconciliation: { totalDebits: 0, totalCredits: 0, delta: 0, isBalanced: false },
        mappingCoverage: {
          mapped: mappedAccounts.length,
          unmapped: mappingErrors.length,
          ...mappingSourceTally,
        },
        fileErrors: [],
        rowErrors: [],
        mappingErrors,
        warnings: parseResult.warnings,
      };
      this.history.record({
        importId,
        clubId: input.clubId,
        filename,
        attemptedAt,
        contentHash,
        status: "failed-mapping",
        diagnostics,
        batchId: null,
        snapshotId: null,
      });
      return {
        importId,
        status: "failed-mapping",
        diagnostics,
        batchId: "",
        snapshotId: null,
        snapshotCount: 0,
        replacedCount: 0,
        notes: input.notes ?? null,
      };
    }

    // -------------------------------------------------------------
    // 4. Build the TrialBalanceLine[] + reconciliation check.
    // -------------------------------------------------------------
    const lines: TrialBalanceLine[] = mappedAccounts.map(({ row, mapped }) =>
      buildTrialBalanceLine(row, mapped),
    );
    const reconciliation = reconcile(lines);

    if (!reconciliation.isBalanced) {
      const diagnostics: JonasImportDiagnostics = {
        rowCount: csvRows.length,
        reconciliation,
        mappingCoverage: {
          mapped: mappedAccounts.length,
          unmapped: 0,
          ...mappingSourceTally,
        },
        fileErrors: [],
        rowErrors: [],
        mappingErrors: [],
        warnings: parseResult.warnings,
      };
      this.history.record({
        importId,
        clubId: input.clubId,
        filename,
        attemptedAt,
        contentHash,
        status: "failed-reconciliation",
        diagnostics,
        batchId: null,
        snapshotId: null,
      });
      return {
        importId,
        status: "failed-reconciliation",
        diagnostics,
        batchId: "",
        snapshotId: null,
        snapshotCount: 0,
        replacedCount: 0,
        notes:
          `Trial balance does NOT reconcile: debits ${reconciliation.totalDebits.toFixed(2)} ` +
          `vs credits ${reconciliation.totalCredits.toFixed(2)} ` +
          `(delta ${reconciliation.delta.toFixed(2)}). Snapshot was NOT written.`,
      };
    }

    // -------------------------------------------------------------
    // 5. Resolve fiscal-year / period-sequence values.
    // -------------------------------------------------------------
    const fiscalYearLabel =
      input.extract.fiscalYearLabel ?? csvRows[0]?.fiscalYear ?? "FY-UNKNOWN";
    const fiscalPeriodSequence =
      input.extract.fiscalPeriodSequence ?? csvRows[0]?.fiscalPeriod ?? 0;

    // -------------------------------------------------------------
    // 6. Open a batch, write the snapshot, commit.
    // -------------------------------------------------------------
    const ledgerAccounts: LedgerAccount[] = mappedAccounts.map(({ mapped }) =>
      toLedgerAccount(mapped),
    );

    const batchId = await this.writer.beginImportBatch({
      clubId: input.clubId,
      sourceSystem: "jonas-gl",
      notes:
        input.notes ??
        `Jonas GL extract — ${filename} (period ending ${periodEnd.toISOString().slice(0, 10)})`,
    });

    const snapshotId = `tb_${input.clubId}_${fiscalYearLabel}_p${fiscalPeriodSequence}_${randomUUID().slice(0, 8)}`;

    const snapshot: TrialBalanceSnapshot = {
      snapshotId,
      clubId: input.clubId,
      capturedAt: attemptedAt,
      sourceSystem: "jonas-gl",
      importBatchId: batchId,
      dataSource: "accounting",
      notes:
        input.notes ??
        `Jonas GL extract — ${filename}`,
      entityKind: "trial-balance",
      asOf: periodEnd,
      periodStart,
      periodEnd,
      fiscalYearLabel,
      fiscalPeriodSequence,
      accounts: ledgerAccounts,
      lines,
      totalDebits: reconciliation.totalDebits,
      totalCredits: reconciliation.totalCredits,
      isBalanced: reconciliation.isBalanced,
    };

    const upsert = await this.writer.upsertSnapshot(snapshot);
    await this.writer.commitImportBatch(batchId);

    const diagnostics: JonasImportDiagnostics = {
      rowCount: csvRows.length,
      reconciliation,
      mappingCoverage: {
        mapped: mappedAccounts.length,
        unmapped: 0,
        ...mappingSourceTally,
      },
      fileErrors: [],
      rowErrors: [],
      mappingErrors: [],
      warnings: parseResult.warnings,
    };

    this.history.record({
      importId,
      clubId: input.clubId,
      filename,
      attemptedAt,
      contentHash,
      status: "succeeded",
      diagnostics,
      batchId,
      snapshotId: upsert.snapshotId,
    });

    return {
      importId,
      status: "succeeded",
      diagnostics,
      batchId,
      snapshotId: upsert.snapshotId,
      snapshotCount: 1,
      replacedCount: upsert.replaced ? 1 : 0,
      notes:
        input.notes ??
        `Imported ${csvRows.length} accounts from ${filename}; trial balance reconciled.`,
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Convert a parsed CSV row + mapped account into a
 * `TrialBalanceLine`. Sign convention: positive YTD balance
 * becomes a debit for asset/expense accounts and a credit for
 * liability/equity/revenue accounts. When explicit debit/credit
 * columns exist, those win.
 */
function buildTrialBalanceLine(
  row: JonasGlCsvRow,
  mapped: MappedAccount,
): TrialBalanceLine {
  if (row.debit !== null || row.credit !== null) {
    const debit = row.debit ?? 0;
    const credit = row.credit ?? 0;
    return {
      accountCode: mapped.accountCode,
      debit,
      credit,
      endingBalance: debit - credit,
    };
  }
  // Derive from YTD balance + account natural side.
  const naturalDebit =
    mapped.category === "asset" || mapped.category === "expense";
  if (naturalDebit) {
    if (row.ytdBalance >= 0) {
      return {
        accountCode: mapped.accountCode,
        debit: row.ytdBalance,
        credit: 0,
        endingBalance: row.ytdBalance,
      };
    }
    // Negative — a contra balance (e.g. accumulated depreciation
    // stored as a positive number in a contra-asset, or a refund
    // posted to an expense). Flip side.
    return {
      accountCode: mapped.accountCode,
      debit: 0,
      credit: -row.ytdBalance,
      endingBalance: row.ytdBalance,
    };
  } else {
    // Natural credit side.
    if (row.ytdBalance >= 0) {
      return {
        accountCode: mapped.accountCode,
        debit: 0,
        credit: row.ytdBalance,
        endingBalance: row.ytdBalance,
      };
    }
    return {
      accountCode: mapped.accountCode,
      debit: -row.ytdBalance,
      credit: 0,
      endingBalance: row.ytdBalance,
    };
  }
}

function reconcile(lines: TrialBalanceLine[]): ReconciliationResult {
  let totalDebits = 0;
  let totalCredits = 0;
  for (const l of lines) {
    totalDebits += l.debit;
    totalCredits += l.credit;
  }
  const delta = totalDebits - totalCredits;
  return {
    totalDebits,
    totalCredits,
    delta,
    isBalanced: Math.abs(delta) < 1,
  };
}

function blankDiagnostics(args: {
  fileErrors?: JonasGlCsvFileError[];
  rowErrors?: JonasGlCsvRowError[];
  mappingErrors?: MappingError[];
  warnings?: JonasGlCsvRowError[];
  rowCount?: number;
}): JonasImportDiagnostics {
  return {
    rowCount: args.rowCount ?? 0,
    reconciliation: {
      totalDebits: 0,
      totalCredits: 0,
      delta: 0,
      isBalanced: false,
    },
    mappingCoverage: {
      mapped: 0,
      unmapped: 0,
      fromOverride: 0,
      fromRangeRule: 0,
      fromJonasTypeHint: 0,
    },
    fileErrors: args.fileErrors ?? [],
    rowErrors: args.rowErrors ?? [],
    mappingErrors: args.mappingErrors ?? [],
    warnings: args.warnings ?? [],
  };
}

function computeContentHash(
  clubId: string,
  csv: string,
  periodEndIso: string,
): string {
  // SHA-256 of the canonical key. Same csv + period for the same
  // club hashes identically across runs — drives the duplicate
  // detection in the import history.
  return createHash("sha256")
    .update(clubId)
    .update("\0")
    .update(periodEndIso)
    .update("\0")
    .update(csv)
    .digest("hex");
}

// Re-export for callers that don't want to dig through subpaths.
export { type JonasGlCsvParseResult };
