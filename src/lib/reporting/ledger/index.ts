// Reporting Ledger — public module surface.
//
// See docs/reporting-ledger-architecture.md for the full architecture.
// This module is CONTRACTS ONLY today; no implementation, no
// importers, no storage backend. Subsequent PRs add adapters that
// produce these shapes and a backend that persists them.

export type {
  // Shared metadata + enums
  LedgerSnapshotMetadata,
  LedgerSourceSystem,
  LedgerAccount,
  LedgerAccountCategory,
  LedgerFund,
  // 8 entities
  TrialBalanceSnapshot,
  TrialBalanceLine,
  IncomeStatementSnapshot,
  IncomeStatementLine,
  BalanceSheetSnapshot,
  BalanceSheetLine,
  BalanceSheetCategory,
  BudgetSnapshot,
  BudgetLine,
  BudgetApprovalStatus,
  PriorYearSnapshot,
  ArAgingSnapshot,
  ArAgingLine,
  ArAgingBucketKey,
  ArAccountStatus,
  PayrollSnapshot,
  PayrollLine,
  PayrollCategory,
  CapitalProjectSnapshot,
  CapitalProjectLine,
  CapitalProjectStatus,
  CapitalProjectCategory,
  // Union + discriminator
  LedgerSnapshot,
  LedgerEntityKind,
} from "@/lib/reporting/ledger/contracts";

export type {
  ReportingLedger,
  ReportingLedgerPeriodHelpers,
  LedgerHistoryWindow,
} from "@/lib/reporting/ledger/read-api";

export type {
  ReportingLedgerWriter,
  UpsertSnapshotResult,
  BeginImportBatchOptions,
  ImportBatchStatus,
  LedgerImporter,
  ImporterInput,
  ImporterResult,
} from "@/lib/reporting/ledger/write-api";

// Reference storage implementation — in-memory, fully working,
// used by tests + local dev. The Prisma adapter (PrismaReportingLedger)
// is the production backend with the same external contract.
export { InMemoryReportingLedger } from "@/lib/reporting/ledger/in-memory-ledger";
export { PrismaReportingLedger } from "@/lib/reporting/ledger/prisma-ledger";
export {
  dehydrateSnapshot,
  rehydrateSnapshot,
  extractPeriodKeys,
} from "@/lib/reporting/ledger/prisma-hydration";
export {
  computePayloadHash,
  snapshotsHaveSameValue,
} from "@/lib/reporting/ledger/payload-hash";

// Jonas GL importer — the first production onboarding path.
export {
  JonasGlImporter,
  InMemoryJonasImportHistory,
} from "@/lib/reporting/ledger/importers/jonas-gl-importer";
export type {
  JonasGlImporterInput,
  JonasImporterResult,
  JonasImportDiagnostics,
  JonasImportHistoryEntry,
  JonasImportStatus,
  MappingError,
  ReconciliationResult,
} from "@/lib/reporting/ledger/importers/jonas-gl-importer";
export {
  parseJonasGlCsv,
} from "@/lib/reporting/ledger/importers/jonas-gl-csv";
export type {
  JonasGlCsvRow,
  JonasGlCsvRowError,
  JonasGlCsvFileError,
  JonasGlCsvParseResult,
} from "@/lib/reporting/ledger/importers/jonas-gl-csv";
export {
  DEFAULT_JONAS_ACCOUNT_MAPPING,
  STANDARD_PRIVATE_CLUB_RANGES,
  mapJonasAccount,
  mapJonasAccountsBatch,
  toLedgerAccount,
} from "@/lib/reporting/ledger/importers/jonas-gl-mapping";
export type {
  JonasAccountMapping,
  JonasAccountOverride,
  JonasAccountRangeRule,
  MappedAccount,
} from "@/lib/reporting/ledger/importers/jonas-gl-mapping";
export { formatJonasImportReport } from "@/lib/reporting/ledger/importers/jonas-gl-report";

// -------- Projections (derived ledger entities) ---------------------------
//
// Balance Sheet projection — first projection service. Reads a
// Trial Balance Snapshot, maps accounts via a configuration-driven
// rule set, writes a Balance Sheet Snapshot back to the ledger.
export {
  BalanceSheetProjection,
} from "@/lib/reporting/ledger/projections/balance-sheet-projection";
export type {
  BalanceSheetProjectionInput,
  BalanceSheetProjectionResult,
  BalanceSheetProjectionDiagnostics,
  BalanceSheetMappingError,
} from "@/lib/reporting/ledger/projections/balance-sheet-projection";
export {
  DEFAULT_BALANCE_SHEET_MAPPING,
  STANDARD_PRIVATE_CLUB_BALANCE_SHEET_RANGES,
  mapBalanceSheetAccount,
} from "@/lib/reporting/ledger/projections/balance-sheet-mapping";
export type {
  BalanceSheetMapping,
  BalanceSheetAccountOverride,
  BalanceSheetAccountRangeRule,
  MappedBalanceSheetAccount,
} from "@/lib/reporting/ledger/projections/balance-sheet-mapping";

// Financial Position Reporting Service — 6-bucket board-ready view
// derived from the Balance Sheet Snapshot.
export {
  FinancialPositionService,
  buildFinancialPositionView,
} from "@/lib/reporting/ledger/projections/financial-position-service";
export type {
  FinancialPositionView,
  FinancialPositionSection,
} from "@/lib/reporting/ledger/projections/financial-position-service";

// Income Statement projection — second projection service. Reads
// one or two Trial Balance Snapshots, maps revenue/expense accounts
// via a configuration-driven rule set, writes an Income Statement
// Snapshot back to the ledger.
export {
  IncomeStatementProjection,
} from "@/lib/reporting/ledger/projections/income-statement-projection";
export type {
  IncomeStatementProjectionInput,
  IncomeStatementProjectionResult,
  IncomeStatementProjectionDiagnostics,
  IncomeStatementMappingError,
  IncomeStatementBucketTotals,
} from "@/lib/reporting/ledger/projections/income-statement-projection";
export {
  DEFAULT_INCOME_STATEMENT_MAPPING,
  STANDARD_PRIVATE_CLUB_IS_RANGES,
  mapIncomeStatementAccount,
  bucketToCategory,
  bucketToFund,
} from "@/lib/reporting/ledger/projections/income-statement-mapping";
export type {
  IncomeStatementMapping,
  IncomeStatementAccountOverride,
  IncomeStatementAccountRangeRule,
  IncomeStatementBucket,
  MappedIncomeStatementAccount,
} from "@/lib/reporting/ledger/projections/income-statement-mapping";

// Income Statement view — joined comparator (actual + budget +
// prior year + variance + variance %). Pure read-side helpers.
export {
  buildIncomeStatementView,
  buildVariance,
} from "@/lib/reporting/ledger/projections/income-statement-view";
export type {
  IncomeStatementView,
  IncomeStatementLineComparator,
  IncomeStatementCategoryRollup,
  IncomeStatementVariance,
} from "@/lib/reporting/ledger/projections/income-statement-view";
