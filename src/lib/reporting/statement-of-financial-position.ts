// Statement of Financial Position (Balance Sheet) — chapter VII.
//
// FULLY REPORTING-LEDGER-DRIVEN. Every displayed value, ratio, and
// commentary line derives from a `BalanceSheetSnapshot` (current
// period) plus an optional prior-year same-date snapshot. The React
// surface renders only; this service owns numerics, tones, and
// reactive narrative.
//
// Architecture:
//
//   BalanceSheetSnapshot (current)
//   + BalanceSheetSnapshot (prior year, optional)
//   + auxiliary ratio inputs (from IS / AR aging projections —
//     future ledger-driven services; passed in for now)
//        ↓
//   buildStatementOfFinancialPositionFromBalanceSheet(...)
//        ↓
//   StatementOfFinancialPosition { rows, ratios, commentary }
//        ↓
//   React renders only (no React-side literals).
//
// The 4 ratios that need data outside the Balance Sheet (AR Current
// Rate from AR Aging, Dues-to-Revenue from Income Statement, Reserve
// Coverage from Capital Tracker, Debt Service Coverage from IS) are
// accepted as `auxiliaryRatioInputs` — these will move to their own
// projection services as those land.

import type {
  BalanceSheetCategory,
  BalanceSheetLine,
  BalanceSheetSnapshot,
} from "@/lib/reporting/ledger/contracts";
import type { ReportingLedger } from "@/lib/reporting/ledger/read-api";
import type { ReportingLedgerWriter } from "@/lib/reporting/ledger/write-api";
import { BalanceSheetProjection } from "@/lib/reporting/ledger/projections/balance-sheet-projection";
import {
  deriveBalanceSheetCategoryFromCoa,
  resolveBalanceSheetLineClassifications,
  getTaxFamily,
  getTaxAccountDirection,
  type TaxFamily,
} from "@/lib/reporting/ledger/classification-resolver";
import {
  comparePresentationOrder,
  type BalanceSheetSection,
} from "@/lib/reporting/ledger/presentation-order";
import type { ReportingDataSource } from "@/lib/reporting/monthly-package";
import type { ReportingPeriod } from "@/lib/reporting/reporting-period";
import {
  buildSilverSpringsBalanceSheetSnapshot,
  buildSilverSpringsPriorYearBalanceSheetSnapshot,
} from "@/lib/reporting/seeds/silver-springs-balance-sheet-seed";

// =============================================================================
// Public types — RENDERING CONTRACT (consumed by React)
// =============================================================================

export type SoFPRowKind =
  | "section-band-operating" // beige band (current / operating sections)
  | "section-band-capital"   // pale-blue band (capital / reserve sections)
  | "detail"                 // legacy per-account row (pre-v15.14 snapshots)
  | "fs-group"               // v15.14 FS-Group summary row (with optional expandable account detail)
  | "subtotal"               // bold-italic beige
  | "total"                  // strong heaviest beige (Total Assets, Total L&E)
  | "total-mid"              // medium-strong beige (Total Liabilities, Total Members' Equity)
  | "unmapped-band";         // v15.14 "requires attention" band for accounts with no FS Group

/** v15.14 — underlying-account detail carried on an expandable
 *  FS-Group summary row. Only populated when the reporting service
 *  was authorized (`showAccountDetail: true`). Board / member / PDF
 *  payloads carry no `accounts` array. */
export type SoFPAccountRow = {
  accountCode: string;
  accountName: string;
  current: number | null;
  comparative: number | null;
};

export type SoFPRow = {
  key: string;
  kind: SoFPRowKind;
  label?: string;
  /** Current-period value (e.g. May 2026 close). Null renders as em-dash. */
  current?: number | null;
  /** Comparative-period value (e.g. May 2025 close). */
  comparative?: number | null;
  // ---------------------------------------------------------------
  // v15.14 FS-Group summary metadata (present when kind === "fs-group"
  // or "unmapped-band" — omitted for section bands / subtotals / totals
  // / legacy per-account detail rows).
  // ---------------------------------------------------------------
  /** Stable FS-Group key — the cross-period identity used to align
   *  current + comparative summary rows. */
  fsGroupKey?: string;
  /** Underlying accounts that roll up into this FS-Group summary.
   *  Present ONLY when the reporting service was authorized to
   *  include detail (see `StatementOfFinancialPosition.showAccountDetail`).
   *  Never leaks into Board / member / PDF payloads. */
  accounts?: ReadonlyArray<SoFPAccountRow>;
};

/** Stewardship-ratio tone classes the panel maps to colour. */
export type SoFPRatioTone = "favorable" | "risk" | "capital";

export type SoFPRatioRow = {
  key: string;
  label: string;
  /** Raw ratio value (used by future trend computation; today the
   *  display is driven by `actualLabel`). */
  actualValue: number;
  /** Pre-formatted actual ("1.95x", "99.9%"). */
  actualLabel: string;
  /** Pre-formatted target ("≥1.5x", "≥90%"). */
  targetLabel: string;
  /** Bar fill width as a decimal 0..1. */
  barFillPct: number;
  /** Target threshold tick position on the bar as a decimal 0..1. */
  barTargetPct: number;
  tone: SoFPRatioTone;
  /** Whether the actual meets or beats the target — drives the ✓ glyph. */
  passesTarget: boolean;
};

export type SoFPBalanceSheetNote = {
  /** Numeric tag rendered to the left of the body (1, 2, 3…). */
  number: number;
  body: string;
};

export type StatementOfFinancialPosition = {
  dataSource: ReportingDataSource;
  // Header chrome.
  eyebrow: string;
  title: string;
  periodLabel: string;
  introNote: string;
  statementNumber: string;
  documentChip: string;
  preparedFor: string;
  // Column labels (3-column tables — Assets/Liabilities row label +
  // current + comparative period). All three flow from
  // ReportingPeriod via service-level derivation.
  assetsColumnHeaders: {
    category: string;
    current: string;
    comparative: string;
  };
  liabilitiesColumnHeaders: {
    category: string;
    current: string;
    comparative: string;
  };
  // Rows.
  assetsRows: ReadonlyArray<SoFPRow>;
  liabilitiesEquityRows: ReadonlyArray<SoFPRow>;
  // Reconciliation: Total Assets must equal Total Liabilities & Members' Equity.
  reconciliation: {
    totalAssetsCurrent: number;
    totalLiabilitiesAndEquityCurrent: number;
    balances: boolean;
    // v15.16 — reconciliation diagnostics surfaced to admins when
    // the built statement does not balance. Present regardless of
    // `balances`; renderers hide the diagnostic banner when
    // `balances === true`. Board / member / PDF payloads carry the
    // same fields so the banner behaves identically across surfaces.
    difference: number;
    totalLiabilitiesCurrent: number;
    totalEquityCurrent: number;
  };
  // Stewardship ratios card.
  stewardshipRatios: {
    eyebrow: string;
    rows: ReadonlyArray<SoFPRatioRow>;
  };
  // Notes block.
  balanceSheetNotes: {
    eyebrow: string;
    notes: ReadonlyArray<SoFPBalanceSheetNote>;
  };
  // ---------------------------------------------------------------
  // v15.14 FS-Group summarization + drill-down contract.
  // ---------------------------------------------------------------
  /** Payload shape version. `2` = FS-Group summary rows (v15.14+).
   *  Missing / `1` = legacy per-account rows (pre-v15.14 archived
   *  packages). Renderers branch on this to preserve backward
   *  compatibility with archived snapshots. */
  sofpVersion: 1 | 2;
  /** When `true`, `SoFPRow.accounts` MAY be populated on `fs-group`
   *  rows and the renderer surfaces a disclosure control. Set on
   *  admin surfaces only when the requester holds the `coa:read`
   *  permission. ALWAYS `false` for Board / member / PDF payloads
   *  so account-level data can never leak from a serialized
   *  archive or a print capture. */
  showAccountDetail: boolean;
  /** v15.14 — accounts on the ChartAccount that carry a balance but
   *  have no FS-Group classification. Renderers surface these
   *  explicitly:
   *    - Admin (with `showAccountDetail: true`): dedicated
   *      "Unmapped Balance Sheet Accounts" band with per-account
   *      lines + a fix-mapping affordance.
   *    - Board / member / PDF: rolled into a neutral
   *      "Other / Unclassified" summary line so the balance sheet
   *      still reconciles without exposing raw mapping diagnostics.
   *  Always populated (empty array when nothing is unmapped) so the
   *  renderer never has to null-check. */
  unmappedAccounts: ReadonlyArray<{
    accountCode: string;
    accountName: string;
    /** Current-period balance in dollars (already sign-normalised
     *  to the presentation convention for the inferred side). */
    current: number;
    comparative: number | null;
    /** Which side of the balance sheet the account probably belongs
     *  on, inferred from `BalanceSheetCategory` when available. Used
     *  by the renderer to pick the correct column for the unmapped
     *  band. */
    inferredSide: "assets" | "liabilities-equity" | "unknown";
  }>;
};

// =============================================================================
// Auxiliary inputs — values that come from OTHER ledger projections
// =============================================================================

/**
 * The 4 ratios on the Stewardship Ratios card that need data outside
 * the Balance Sheet snapshot. As the matching ledger services land,
 * these inputs will be replaced by direct ledger reads:
 *
 *   - arCurrentRate          ← AR Aging projection (current ÷ total AR)
 *   - duesToRevenueRatio     ← Income Statement projection
 *   - reserveCoverageRatio   ← Capital Tracker / Reserve Study projection
 *   - debtServiceCoverage    ← Income Statement projection (NOI ÷ debt service)
 *
 * For now, callers (the package builder) provide them so the section
 * keeps its full visual layout. When all four projection services
 * exist, the orchestrator function `getStatementOfFinancialPosition`
 * will compose them automatically.
 */
export type SoFPAuxiliaryRatioInputs = {
  arCurrentRate: number;
  duesToRevenueRatio: number;
  reserveCoverageRatio: number;
  debtServiceCoverage: number;
  /** Optional override for Net-to-Gross PP&E. When set, the section
   *  uses this value instead of computing from snapshot lines. Use
   *  this when the club's Reserve Study (replacement-cost basis)
   *  diverges from book-value PP&E from the BS (e.g. land-included
   *  vs land-excluded, soft-cost / trade-pack overheads). Will move
   *  to a dedicated Reserve Study projection when that ledger
   *  service lands. */
  netToGrossPpeOverride?: number;
};

// =============================================================================
// Reactive balance sheet notes generator
// =============================================================================

export type BalanceSheetNotesInputs = {
  netToGrossPpePctLabel: string;
  depreciatedPctLabel: string;
  grossReplacementCostLabel: string;
  deferredInitiationFeeLabel: string;
  workingCapitalRatio: number;
  netToGrossPpe: number;
  hasDeferredInitFees: boolean;
};

/**
 * Build the balance sheet notes block. Branches on snapshot-derived
 * values so the rendered narrative reacts to the underlying numbers:
 * a club with strong working capital + young PP&E gets a different
 * paragraph than one with strained liquidity + heavily-depreciated
 * assets.
 */
export function buildBalanceSheetNotes(
  inputs: BalanceSheetNotesInputs,
): ReadonlyArray<SoFPBalanceSheetNote> {
  const notes: SoFPBalanceSheetNote[] = [
    {
      number: 1,
      body:
        `The two-fund structure separates operating assets and liabilities from ` +
        `capital reserves at the account level. No reserve funds appear in operating ` +
        `cash. This separation is the foundation of reliable financial reporting and ` +
        `the first test of institutional stewardship.`,
    },
    {
      number: 2,
      body: buildPpEAgingNote(inputs),
    },
  ];

  if (inputs.hasDeferredInitFees) {
    notes.push({
      number: notes.length + 1,
      body:
        `Deferred initiation fees of ${inputs.deferredInitiationFeeLabel} represent ` +
        `the estimated present value of initiation fees subject to refund provisions ` +
        `under club bylaws. This is a long-term obligation that should be factored ` +
        `into any analysis of available capital.`,
    });
  }

  notes.push({
    number: notes.length + 1,
    body: buildWorkingCapitalNote(inputs),
  });

  return notes;
}

function buildPpEAgingNote(inputs: BalanceSheetNotesInputs): string {
  const headline =
    `The Net-to-Gross PP&E ratio of ${inputs.netToGrossPpePctLabel} indicates ` +
    `that the club's fixed assets are approximately ${inputs.depreciatedPctLabel} ` +
    `depreciated on a book value basis.`;
  // Branch on PP&E age: < 40% net = heavily depreciated, 40–60% =
  // mid-life, ≥ 60% = young.
  if (inputs.netToGrossPpe < 0.40) {
    return (
      `${headline} Against a total replacement cost of approximately ` +
      `${inputs.grossReplacementCostLabel} (excluding land), the asset base is ` +
      `materially aged and the Board should prioritise replenishing reserve ` +
      `contributions at or above study-recommended levels to fund the ` +
      `upcoming replacement cycle.`
    );
  }
  if (inputs.netToGrossPpe < 0.60) {
    return (
      `${headline} Against a total replacement cost of approximately ` +
      `${inputs.grossReplacementCostLabel} (excluding land), this reinforces the ` +
      `importance of maintaining reserve contributions at or above ` +
      `study-recommended levels.`
    );
  }
  return (
    `${headline} Against a total replacement cost of approximately ` +
    `${inputs.grossReplacementCostLabel} (excluding land), the asset base remains ` +
    `relatively young and current reserve contributions appear adequate to ` +
    `the projected replacement cycle.`
  );
}

function buildWorkingCapitalNote(inputs: BalanceSheetNotesInputs): string {
  const ratioLabel = `${inputs.workingCapitalRatio.toFixed(2)}x`;
  if (inputs.workingCapitalRatio < 1.0) {
    return (
      `Working capital ratio of ${ratioLabel} is below the 1.0x liquidity ` +
      `floor — current liabilities exceed current assets. This is a stewardship ` +
      `signal that requires immediate Board attention and may indicate a need ` +
      `to draw on the line of credit or accelerate dues collection.`
    );
  }
  if (inputs.workingCapitalRatio < 1.5) {
    return (
      `Working capital ratio of ${ratioLabel} sits below the 1.5x policy ` +
      `target. Liquidity is adequate to meet near-term obligations but ` +
      `leaves limited cushion for unplanned operating events; Finance ` +
      `Committee should monitor receivables aging closely this cycle.`
    );
  }
  if (inputs.workingCapitalRatio < 2.5) {
    return (
      `Working capital ratio of ${ratioLabel} comfortably exceeds the 1.5x ` +
      `policy target, indicating sound short-term liquidity to meet ` +
      `current obligations as they come due.`
    );
  }
  return (
    `Working capital ratio of ${ratioLabel} is well above the 1.5x policy ` +
    `target, indicating strong short-term liquidity. The Board may wish to ` +
    `consider whether excess working capital is being optimally deployed ` +
    `(e.g. accelerated reserve contributions or principal pay-down).`
  );
}

// =============================================================================
// Pure builder — snapshot → rendering contract
// =============================================================================

/**
 * Build the Statement of Financial Position section from a Balance
 * Sheet snapshot. Pure function — same inputs produce the same
 * output. Every rendered number traces to a line in the snapshot or
 * a derivation from the snapshot.
 *
 * Founder rule 2026-07-13 v15.14 — FS-Group summarization.
 *   Every posting account is aggregated up to its
 *   `FinancialStatementGroup` on the Chart of Accounts. The default
 *   presentation therefore renders one line PER FS Group (e.g.
 *   "Inventory  $381,724"), NOT one line per account. Under-the-hood
 *   account rows are optionally attached to each summary row when
 *   the caller signals `viewerCanDrillDown: true` — a serialisable
 *   flag driven by the `coa:read` permission at the entry point.
 */
export function buildStatementOfFinancialPositionFromBalanceSheet(args: {
  clubName: string;
  period: ReportingPeriod;
  currentSnapshot: BalanceSheetSnapshot;
  /** Optional prior-year same-date snapshot for the Comparative
   *  column. When omitted, comparatives render as em-dash. */
  priorYearSnapshot?: BalanceSheetSnapshot | null;
  /** Ratios that need data from OTHER ledger projections. See
   *  `SoFPAuxiliaryRatioInputs` for the future home of each. */
  auxiliaryRatioInputs: SoFPAuxiliaryRatioInputs;
  /** Reserve-study gross replacement cost label (e.g. "$7.9M") — comes
   *  from the Capital Tracker / Reserve Position projection. */
  grossReplacementCostLabel: string;
  /** v15.14 — when `true`, the built statement's `fs-group` rows
   *  carry `accounts[]` arrays with underlying account detail, and
   *  the unmapped-accounts band lists per-account lines. When
   *  `false` (default), the payload is summary-only and
   *  Board/member/PDF-safe. Callers set this via the `coa:read`
   *  permission check. */
  viewerCanDrillDown?: boolean;
}): StatementOfFinancialPosition {
  const { currentSnapshot, priorYearSnapshot } = args;
  const showAccountDetail = args.viewerCanDrillDown === true;

  // -------------------------------------------------------------
  // 1. Build SoFP rows from snapshot lines (current + prior year)
  // -------------------------------------------------------------
  // v15.21 — prior lookups carry BOTH the abs magnitude and the raw
  // signed TB amount so `normaliseSign` can apply the same canonical
  // section-side normalisation to the comparative column as it does
  // to the current column. Legacy pre-v15.19 snapshots don't have
  // `rawSignedAmount`; the fallback path in `normaliseSign` uses
  // `amount` and preserves the pre-v15.21 behaviour for them.
  const priorByCode = new Map<string, number>();
  const priorSignedByCode = new Map<string, number | undefined>();
  if (priorYearSnapshot) {
    for (const l of priorYearSnapshot.lines) {
      priorByCode.set(l.accountCode, l.amount);
      priorSignedByCode.set(l.accountCode, l.rawSignedAmount);
    }
  }

  // v15.18 — Tax-family net settlement. Extract every tax control
  // account (GST / HST / PST / sales tax / corporate income tax)
  // from the input lines BEFORE the standard section aggregation
  // runs. Their algebraic net decides whether the family appears
  // as a receivable (asset side) or payable (liability side), and
  // ONE dynamic row per family is emitted on the correct side. The
  // underlying accounts are guaranteed consumed exactly once (they
  // never re-enter the standard aggregation buckets).
  const { taxRows: currentTaxRows, remainingLines: currentTaxFilteredLines } =
    buildTaxNettingRows({
      lines: currentSnapshot.lines,
      priorLines: priorYearSnapshot?.lines ?? [],
      showAccountDetail,
    });
  const priorTaxFilteredLines = priorYearSnapshot
    ? priorYearSnapshot.lines.filter(
        (l) =>
          getTaxFamily({
            accountName: l.accountName,
            fsGroupKey: l.fsGroupKey ?? null,
            fsGroupName: l.fsGroupName ?? null,
          }) === null,
      )
    : [];

  const currentByCategory = bucketByCategory(currentTaxFilteredLines);
  const priorByCategory = priorYearSnapshot
    ? bucketByCategory(priorTaxFilteredLines)
    : null;

  // v15.14 — every category is now aggregated up to its FS Group
  // (from the ChartAccount classification carried on each line via
  // `fsGroupKey` / `fsGroupName`). Lines with no FS-Group
  // classification collect into `unmappedLines` and surface through
  // the dedicated unmapped-accounts band (never silently dropped).
  const unmappedLines: BalanceSheetLine[] = [];

  // v15.21 — every section aggregation uses the new
  // canonical section modes. `debit-normal` preserves an asset's
  // natural side; `credit-normal` inverts to positive presentation
  // for liabilities + equity and (crucially) negates abnormal debit
  // balances so they REDUCE liabilities; `contra-asset-signed`
  // preserves accumulated depreciation's natural credit sign
  // without double-negation.
  const currentAssetsRows = aggregateByFsGroup({
    lines: currentByCategory.get("current-asset") ?? [],
    priorByCode,
    priorSignedByCode,
    signMode: "debit-normal",
    unmappedSink: unmappedLines,
    keyPrefix: "current-asset",
    showAccountDetail,
  });
  const capitalFundAssetsRows = aggregateByFsGroup({
    lines: currentByCategory.get("capital-fund-asset") ?? [],
    priorByCode,
    priorSignedByCode,
    signMode: "debit-normal",
    unmappedSink: unmappedLines,
    keyPrefix: "capital-fund-asset",
    showAccountDetail,
  });
  const longTermAssetsRows = aggregateByFsGroup({
    lines: currentByCategory.get("long-term-asset") ?? [],
    priorByCode,
    priorSignedByCode,
    signMode: "debit-normal",
    unmappedSink: unmappedLines,
    keyPrefix: "long-term-asset",
    showAccountDetail,
  });
  const ppeGrossRows = aggregateByFsGroup({
    lines: currentByCategory.get("ppe-gross") ?? [],
    priorByCode,
    priorSignedByCode,
    signMode: "debit-normal",
    unmappedSink: unmappedLines,
    keyPrefix: "ppe-gross",
    showAccountDetail,
  });
  const accumDeprRows = aggregateByFsGroup({
    lines: currentByCategory.get("ppe-accumulated-depreciation") ?? [],
    priorByCode,
    priorSignedByCode,
    signMode: "contra-asset-signed",
    unmappedSink: unmappedLines,
    keyPrefix: "accum-depr",
    showAccountDetail,
  });
  const currentLiabRows = aggregateByFsGroup({
    lines: currentByCategory.get("current-liability") ?? [],
    priorByCode,
    priorSignedByCode,
    signMode: "credit-normal",
    unmappedSink: unmappedLines,
    keyPrefix: "current-liability",
    showAccountDetail,
  });
  const longTermLiabRows = aggregateByFsGroup({
    lines: currentByCategory.get("long-term-liability") ?? [],
    priorByCode,
    priorSignedByCode,
    signMode: "credit-normal",
    unmappedSink: unmappedLines,
    keyPrefix: "long-term-liability",
    showAccountDetail,
  });

  const operatingFundRows = aggregateByFsGroup({
    lines: currentByCategory.get("operating-fund-balance") ?? [],
    priorByCode,
    priorSignedByCode,
    signMode: "credit-normal",
    unmappedSink: unmappedLines,
    keyPrefix: "operating-fund",
    showAccountDetail,
  });
  const capitalFundRows = aggregateByFsGroup({
    lines: currentByCategory.get("capital-fund-balance") ?? [],
    priorByCode,
    priorSignedByCode,
    signMode: "credit-normal",
    unmappedSink: unmappedLines,
    keyPrefix: "capital-fund",
    showAccountDetail,
  });
  const ytdNetIncomeRows = aggregateByFsGroup({
    lines: currentByCategory.get("ytd-net-income") ?? [],
    priorByCode,
    signMode: "signed",
    unmappedSink: unmappedLines,
    keyPrefix: "ytd-net-income",
    showAccountDetail,
  });
  const membersEquityRows = [
    ...operatingFundRows,
    ...capitalFundRows,
    ...ytdNetIncomeRows,
  ];

  // v15.18 — merge the tax-family dynamic rows into their correct
  // section. Sales Tax Receivable / Corporate Income Tax Receivable
  // append to Current Assets; Sales Tax Payable / Corporate Income
  // Tax Payable append to Current Liabilities. Each family is
  // guaranteed to produce AT MOST one row per side (the
  // `buildTaxNettingRows` helper enforces the invariant).
  //
  // v15.20 — the merged rows are then sorted by the canonical
  // liquidity / presentation order (Cash → Sales-Tax Receivable →
  // AR → Member AR → Inventory → Prepaid for current assets;
  // deterministic order for every other section). This is what
  // guarantees dynamic tax rows slot into the right liquidity
  // position rather than appending to the end of the section.
  const currentAssetsRowsWithTax = sortRowsByPresentation(
    [
      ...currentAssetsRows,
      ...currentTaxRows.filter((r) => r.dynamicSide === "ASSET").map(({ row }) => row),
    ],
    "current-asset",
  );
  const currentLiabRowsWithTax = sortRowsByPresentation(
    [
      ...currentLiabRows,
      ...currentTaxRows.filter((r) => r.dynamicSide === "LIABILITY").map(({ row }) => row),
    ],
    "current-liability",
  );
  const longTermAssetsRowsSorted = sortRowsByPresentation(
    longTermAssetsRows,
    "long-term-asset",
  );

  // -------------------------------------------------------------
  // 2. Subtotals + totals
  // -------------------------------------------------------------
  const totalCurrentAssetsCurrent = sumRowsCurrent(currentAssetsRowsWithTax);
  const totalCurrentAssetsComparative = sumRowsComparative(currentAssetsRowsWithTax);
  const totalCapitalFundAssetsCurrent = sumRowsCurrent(capitalFundAssetsRows);
  const totalCapitalFundAssetsComparative = sumRowsComparative(capitalFundAssetsRows);
  const totalLongTermAssetsCurrent = sumRowsCurrent(longTermAssetsRowsSorted);
  const totalLongTermAssetsComparative = sumRowsComparative(longTermAssetsRowsSorted);

  const ppeGrossCurrent = sumRowsCurrent(ppeGrossRows);
  const ppeGrossComparative = sumRowsComparative(ppeGrossRows);
  // v15.21 — accumDeprRows now carry SIGNED contributions (negative
  // under normal credit-balance conditions, positive for the rare
  // abnormal debit-balance case). Net PP&E = gross + accum, since
  // accum is already negative when appropriate. This removes the
  // pre-v15.21 `Math.abs` that was silently stripping abnormal
  // sign information.
  const accumDeprCurrent = sumRowsCurrent(accumDeprRows);
  const accumDeprComparative = sumRowsComparative(accumDeprRows);
  const netPpeCurrent = ppeGrossCurrent + accumDeprCurrent;
  const netPpeComparative = ppeGrossComparative + accumDeprComparative;

  const totalAssetsCurrent =
    totalCurrentAssetsCurrent +
    totalCapitalFundAssetsCurrent +
    totalLongTermAssetsCurrent +
    netPpeCurrent;
  const totalAssetsComparative =
    totalCurrentAssetsComparative +
    totalCapitalFundAssetsComparative +
    totalLongTermAssetsComparative +
    netPpeComparative;

  const totalCurrentLiabilitiesCurrent = sumRowsCurrent(currentLiabRowsWithTax);
  const totalCurrentLiabilitiesComparative = sumRowsComparative(currentLiabRowsWithTax);
  const totalLongTermLiabilitiesCurrent = sumRowsCurrent(longTermLiabRows);
  const totalLongTermLiabilitiesComparative = sumRowsComparative(longTermLiabRows);
  const totalLiabilitiesCurrent =
    totalCurrentLiabilitiesCurrent + totalLongTermLiabilitiesCurrent;
  const totalLiabilitiesComparative =
    totalCurrentLiabilitiesComparative + totalLongTermLiabilitiesComparative;

  const totalMembersEquityCurrent = sumRowsCurrent(membersEquityRows);
  const totalMembersEquityComparative = sumRowsComparative(membersEquityRows);
  const totalLiabilitiesAndEquityCurrent =
    totalLiabilitiesCurrent + totalMembersEquityCurrent;
  const totalLiabilitiesAndEquityComparative =
    totalLiabilitiesComparative + totalMembersEquityComparative;

  // -------------------------------------------------------------
  // 3. Assemble row groups for the React renderer
  // -------------------------------------------------------------
  const assetsRows: SoFPRow[] = [
    { key: "band-current-assets",  kind: "section-band-operating", label: "Current Assets — Operating Fund" },
    ...currentAssetsRowsWithTax,
    { key: "total-current-assets", kind: "subtotal", label: "Total Current Assets",
      current: totalCurrentAssetsCurrent, comparative: totalCurrentAssetsComparative },

    { key: "band-capital-fund-assets", kind: "section-band-capital", label: "Capital & Reserve Assets — Capital Fund" },
    ...capitalFundAssetsRows,
    { key: "total-capital-fund-assets", kind: "subtotal", label: "Total Capital Fund Assets",
      current: totalCapitalFundAssetsCurrent, comparative: totalCapitalFundAssetsComparative },

    // v15.20 — Long-Term Assets. Rendered only when there is at
    // least one row so an empty section doesn't clutter clubs whose
    // COAs don't yet expose long-term receivables / investments /
    // right-of-use assets / intangibles.
    ...(longTermAssetsRowsSorted.length > 0
      ? [
          {
            key: "band-long-term-assets",
            kind: "section-band-operating",
            label: "Long-Term Assets",
          } satisfies SoFPRow,
          ...longTermAssetsRowsSorted,
          {
            key: "total-long-term-assets",
            kind: "subtotal",
            label: "Total Long-Term Assets",
            current: totalLongTermAssetsCurrent,
            comparative: totalLongTermAssetsComparative,
          } satisfies SoFPRow,
        ]
      : []),

    { key: "band-ppe", kind: "section-band-operating", label: "Property, Plant & Equipment" },
    ...ppeGrossRows,
    ...accumDeprRows,
    { key: "net-ppe", kind: "subtotal", label: "Net PP&E",
      current: netPpeCurrent, comparative: netPpeComparative },

    { key: "total-assets", kind: "total", label: "Total Assets",
      current: totalAssetsCurrent, comparative: totalAssetsComparative },
  ];

  const liabilitiesEquityRows: SoFPRow[] = [
    { key: "band-current-liabilities", kind: "section-band-operating", label: "Current Liabilities" },
    ...currentLiabRowsWithTax,
    { key: "total-current-liabilities", kind: "subtotal", label: "Total Current Liabilities",
      current: totalCurrentLiabilitiesCurrent, comparative: totalCurrentLiabilitiesComparative },

    { key: "band-long-term-liabilities", kind: "section-band-capital", label: "Long-Term Liabilities" },
    ...longTermLiabRows,
    { key: "total-long-term-liabilities", kind: "subtotal", label: "Total Long-Term Liabilities",
      current: totalLongTermLiabilitiesCurrent, comparative: totalLongTermLiabilitiesComparative },

    { key: "total-liabilities", kind: "total-mid", label: "Total Liabilities",
      current: totalLiabilitiesCurrent, comparative: totalLiabilitiesComparative },

    { key: "band-members-equity", kind: "section-band-operating", label: "Members' Equity" },
    ...membersEquityRows,
    { key: "total-members-equity", kind: "total-mid", label: "Total Members' Equity",
      current: totalMembersEquityCurrent, comparative: totalMembersEquityComparative },

    { key: "total-liabilities-and-equity", kind: "total", label: "Total Liabilities & Members' Equity",
      current: totalLiabilitiesAndEquityCurrent, comparative: totalLiabilitiesAndEquityComparative },
  ];

  // -------------------------------------------------------------
  // 4. Reconciliation check (v15.16 — extended diagnostics)
  //
  // Every displayed subtotal + grand total is derived from the same
  // classified line population. When these don't reconcile the
  // renderer surfaces a prominent out-of-balance banner and the
  // publish path refuses to freeze the payload.
  // -------------------------------------------------------------
  const reconciliationDifference =
    totalAssetsCurrent - totalLiabilitiesAndEquityCurrent;
  const balances = Math.abs(reconciliationDifference) < 1;

  // -------------------------------------------------------------
  // 5. Stewardship ratios — derived from snapshot + auxiliary inputs
  // -------------------------------------------------------------
  const workingCapitalRatio =
    totalCurrentLiabilitiesCurrent > 0
      ? totalCurrentAssetsCurrent / totalCurrentLiabilitiesCurrent
      : 0;
  const netToGrossPpeFromSnapshot =
    ppeGrossCurrent > 0 ? netPpeCurrent / ppeGrossCurrent : 0;
  const netToGrossPpe =
    args.auxiliaryRatioInputs.netToGrossPpeOverride ?? netToGrossPpeFromSnapshot;

  const stewardshipRatios = buildStewardshipRatios({
    workingCapitalRatio,
    netToGrossPpe,
    aux: args.auxiliaryRatioInputs,
  });

  // -------------------------------------------------------------
  // 6. Reactive notes — branches on snapshot values
  // -------------------------------------------------------------
  const deferredInitFeesAmount = sumByPredicate(currentSnapshot.lines, (l) =>
    l.accountName.toLowerCase().includes("deferred initiation fee"),
  );
  const balanceSheetNotes = {
    eyebrow: "Balance Sheet Notes",
    notes: buildBalanceSheetNotes({
      netToGrossPpePctLabel: `${(netToGrossPpe * 100).toFixed(0)}%`,
      depreciatedPctLabel: `${(100 - netToGrossPpe * 100).toFixed(0)}%`,
      grossReplacementCostLabel: args.grossReplacementCostLabel,
      deferredInitiationFeeLabel: `$${Math.round(deferredInitFeesAmount).toLocaleString("en-US")}`,
      workingCapitalRatio,
      netToGrossPpe,
      hasDeferredInitFees: deferredInitFeesAmount > 0,
    }),
  };

  return {
    dataSource: currentSnapshot.dataSource === "demo" ? "demo" : "live",
    eyebrow: `${args.clubName} · Balance Sheet`,
    title: "Statement of Financial Position",
    periodLabel: args.period.statementHeaderLabel,
    introNote:
      "The club's complete financial position — assets, liabilities, and members' equity.",
    statementNumber: "Statement 09 of 14",
    documentChip: "Balance Sheet",
    preparedFor: "Finance Committee",
    assetsColumnHeaders: {
      category: "Assets",
      current: buildPeriodColumnLabel(args.period, 0),
      comparative: buildPeriodColumnLabel(args.period, -1),
    },
    liabilitiesColumnHeaders: {
      category: "Liabilities & Members' Equity",
      current: buildPeriodColumnLabel(args.period, 0),
      comparative: buildPeriodColumnLabel(args.period, -1),
    },
    assetsRows,
    liabilitiesEquityRows,
    reconciliation: {
      totalAssetsCurrent,
      totalLiabilitiesAndEquityCurrent,
      balances,
      difference: reconciliationDifference,
      totalLiabilitiesCurrent,
      totalEquityCurrent: totalMembersEquityCurrent,
    },
    stewardshipRatios,
    balanceSheetNotes,
    // v15.14 — FS-Group summarization contract.
    sofpVersion: 2,
    showAccountDetail,
    unmappedAccounts: buildUnmappedBand({
      unmappedLines,
      priorByCode,
    }),
  };
}

// =============================================================================
// Silver Springs wrapper — calls the seed module then the pure builder
// =============================================================================

/**
 * Backwards-compatible Silver Springs entry point. Builds the
 * seeded snapshots (one current period, one prior-year same-date)
 * via the seed module and threads them through the ledger-driven
 * builder. Same external contract as before; internally now fully
 * snapshot-driven so no React-side or service-side balance-sheet
 * literals remain.
 */
export function buildSilverSpringsStatementOfFinancialPosition(opts: {
  clubName: string;
  period: ReportingPeriod;
  /** v15.14 — pass-through for the `coa:read`-derived permission
   *  flag. Defaults to `false` so any caller that forgets to pass
   *  a principal (Board pages, PDF exports) gets a
   *  Board-safe payload with no account detail. */
  viewerCanDrillDown?: boolean;
}): StatementOfFinancialPosition {
  const currentSnapshot = buildSilverSpringsBalanceSheetSnapshot(opts.period);
  const priorYearSnapshot = buildSilverSpringsPriorYearBalanceSheetSnapshot(opts.period);

  // The four auxiliary ratios that need data outside the BS — held
  // here as the SAME values previously hardcoded in this function
  // until their respective ledger projections (AR Aging, Income
  // Statement, Capital Tracker / Reserve Study) land. When those
  // exist this block will be replaced by direct ledger reads.
  const auxiliaryRatioInputs: SoFPAuxiliaryRatioInputs = {
    arCurrentRate: 0.999,
    duesToRevenueRatio: 0.659,
    reserveCoverageRatio: 0.61,
    debtServiceCoverage: 2.1,
    // Reserve-study-derived figure; differs from BS book-value PP&E
    // by design. Preserves the previously-rendered 44% value.
    netToGrossPpeOverride: 0.44,
  };

  return buildStatementOfFinancialPositionFromBalanceSheet({
    clubName: opts.clubName,
    period: opts.period,
    currentSnapshot,
    priorYearSnapshot,
    auxiliaryRatioInputs,
    grossReplacementCostLabel: "$7.9M",
    viewerCanDrillDown: opts.viewerCanDrillDown === true,
  });
}

// =============================================================================
// Production entry point — DUAL-READ pattern
// =============================================================================

/**
 * Production entry point for the Statement of Financial Position
 * section. Dual-read pattern:
 *
 *   1. If a committed `BalanceSheetSnapshot` exists in the ledger
 *      for `(clubId, asOf)` → use it directly. This is the steady-
 *      state production path once the BS projection runs.
 *
 *   2. Else, if a committed `TrialBalanceSnapshot` exists for
 *      `(clubId, asOf)` → run the `BalanceSheetProjection` to
 *      derive a BS, persist it back to the ledger, and use the
 *      result. This is the self-healing path after a fresh Jonas
 *      import: the operator sees the new SoFP without having to
 *      run a separate projection step.
 *
 *   3. Else → fall back to the Silver Springs demo seed. Keeps
 *      development environments rendering correctly when the ledger
 *      is empty.
 *
 * `dataSource` on the returned section reflects which branch fired:
 *   • `"live"`  — branch 1 or 2 (ledger-derived)
 *   • `"demo"`  — branch 3 (seed)
 *
 * `clubName`, `period`, and `auxiliaryRatioInputs` are caller-supplied
 * because they're not in the BS contract. Auxiliary inputs will move
 * to their own ledger projections (AR Aging / IS / Reserve Study) as
 * those land.
 */
export async function getStatementOfFinancialPositionForClub(args: {
  clubId: string;
  clubName: string;
  period: ReportingPeriod;
  ledger: ReportingLedger & ReportingLedgerWriter;
  auxiliaryRatioInputs: SoFPAuxiliaryRatioInputs;
  grossReplacementCostLabel: string;
  /** Optional fall-through builder. Used by Silver Springs to surface
   *  the seed snapshot when the ledger is empty. Callers that want a
   *  pure "ledger or empty" behaviour can omit this. */
  demoFallback?: () => StatementOfFinancialPosition;
  /** v15.14 — permission-derived flag. When `true`, the built
   *  statement includes underlying account arrays on FS-Group
   *  summary rows AND a per-account unmapped band. Callers set this
   *  from `hasPermission(principal, clubId, "coa:read")`. Defaults
   *  to `false` so any code path that forgets to pass it produces a
   *  Board-safe payload. */
  viewerCanDrillDown?: boolean;
}): Promise<StatementOfFinancialPosition> {
  const viewerCanDrillDown = args.viewerCanDrillDown === true;
  // Normalize asOf to the END of period.periodEnd's day. The
  // monthly-package default carries `May 31 00:00:00` (start-of-day)
  // but Jonas TBs are conventionally captured at end-of-day
  // (`May 31 23:59:59`). Without this normalization the `lte`
  // comparison in `ledger.getBalanceSheet` excludes the matching
  // TB and the dual-read falls through to the demo branch.
  const snapshot = await resolveBalanceSheetSnapshot({
    ledger: args.ledger,
    clubId: args.clubId,
    asOf: endOfDayUtc(args.period.periodEnd),
  });

  if (snapshot) {
    // Founder rule 2026-07-13 v15.15 — enrich legacy snapshots at
    // read time. Snapshots written before v15.15 do not carry
    // `fsGroupKey` / `fsGroupName` / `fsGroupSortOrder` on their
    // lines. A fresh (unpublished) preview always reflects the
    // CURRENT Chart of Accounts classification; published /
    // archived packages read from the frozen `packagePayloadJson`
    // and are not touched by this enrichment.
    //
    // The v15.14 Statement-of-Financial-Position builder aggregates
    // by `fsGroupKey`; without this enrichment, legacy snapshots
    // would render as 100 % unmapped (the exact defect the founder
    // observed after v15.14 shipped).
    const enrichedCurrent = await enrichSnapshotWithLiveCoa({
      clubId: args.clubId,
      snapshot,
    });
    const priorYear = await loadPriorYearSnapshot({
      ledger: args.ledger,
      clubId: args.clubId,
      currentAsOf: args.period.periodEnd,
    });
    const enrichedPrior = priorYear
      ? await enrichSnapshotWithLiveCoa({
          clubId: args.clubId,
          snapshot: priorYear,
        })
      : null;
    return buildStatementOfFinancialPositionFromBalanceSheet({
      clubName: args.clubName,
      period: args.period,
      currentSnapshot: enrichedCurrent,
      priorYearSnapshot: enrichedPrior,
      auxiliaryRatioInputs: args.auxiliaryRatioInputs,
      grossReplacementCostLabel: args.grossReplacementCostLabel,
      viewerCanDrillDown,
    });
  }

  // No ledger data — fall back to the demo builder when provided.
  if (args.demoFallback) return args.demoFallback();

  // Pure-ledger callers with nothing to fall back to: surface the
  // empty state via a degenerate seed (zeros) so the React contract
  // is satisfied. This branch is reachable only when a new club has
  // no imports yet AND no demo fallback was provided.
  return buildStatementOfFinancialPositionFromBalanceSheet({
    clubName: args.clubName,
    period: args.period,
    currentSnapshot: emptyBalanceSheetSnapshot(args.clubId, args.period),
    priorYearSnapshot: null,
    auxiliaryRatioInputs: args.auxiliaryRatioInputs,
    grossReplacementCostLabel: args.grossReplacementCostLabel,
    viewerCanDrillDown,
  });
}

/**
 * Resolve the most-relevant BalanceSheetSnapshot for a club at the
 * requested asOf. Tries a direct BS read first; falls back to
 * projecting from a TB. Returns null when neither exists.
 *
 * The projection step PERSISTS its result back to the ledger so
 * subsequent reads hit the direct-BS branch (no repeated projection).
 */
async function resolveBalanceSheetSnapshot(args: {
  ledger: ReportingLedger & ReportingLedgerWriter;
  clubId: string;
  asOf: Date;
}): Promise<BalanceSheetSnapshot | null> {
  // Founder rule 2026-07-01 v14.12 — direct BS snapshot preference.
  // The ledger's live-synthesis (v14.11) returns an authoritative
  // BalanceSheetSnapshot for clubs with a committed real Opening
  // Trial Balance. The range-based BalanceSheetProjection below
  // misclassifies non-standard Silver Springs accounts (e.g.
  // accumulated depreciation in the 15xx range), causing
  // reconciliation to fail and the whole page to fall back to demo.
  // Try the direct read first; only run the projection when the
  // ledger has no direct BS.
  const direct = await args.ledger.getBalanceSheet(args.clubId, args.asOf);
  if (direct) return direct;

  // Branch 1 — derive from the latest TB. Always re-project when a
  // TB exists, because a previously-cached BS could be stale relative
  // to a newer TB (re-imports). The projection's upsertSnapshot is
  // idempotent via payload hash, so projecting a TB whose contents
  // haven't changed is a no-op write (no row churn). The result is
  // always the BS that reflects the LATEST TB the ledger holds for
  // this period.
  const tb = await args.ledger.getTrialBalance(args.clubId, args.asOf);
  if (tb) {
    const projection = new BalanceSheetProjection({
      ledger: args.ledger,
      writer: args.ledger,
    });
    const result = await projection.getBalanceSheetSnapshot({
      clubId: args.clubId,
      asOf: args.asOf,
    });
    if (result.status === "succeeded") return result.snapshot;
  }
  return null;
}

async function loadPriorYearSnapshot(args: {
  ledger: ReportingLedger;
  clubId: string;
  currentAsOf: Date;
}): Promise<BalanceSheetSnapshot | null> {
  const priorAsOf = new Date(args.currentAsOf);
  priorAsOf.setUTCFullYear(priorAsOf.getUTCFullYear() - 1);
  return args.ledger.getBalanceSheet(args.clubId, endOfDayUtc(priorAsOf));
}

// ---------------------------------------------------------------------------
// v15.15 — read-time enrichment for legacy Balance Sheet snapshots.
//
// Snapshots written before v15.15 don't carry `fsGroupKey` /
// `fsGroupName` / `fsGroupSortOrder` on their lines. The SoFP
// builder (v15.14) aggregates by `fsGroupKey`, so without this
// enrichment every line would render as "unmapped" — the exact
// defect the founder observed after v15.14 shipped.
//
// Enrichment strategy: consult the CURRENT ChartAccount table via
// the shared classification resolver, then merge the resolved
// classification onto any snapshot line that lacks it. Idempotent
// — lines that already carry a classification (e.g. from a v15.15+
// projection) are left alone.
//
// Point-in-time contract: this enrichment applies only to the
// LIVE / preview build path. Published packages read their SoFP
// straight out of the frozen `MonthlyPackage.packagePayloadJson`
// via `getBoardPackageView()` — enrichment never runs against an
// archived payload, so a later CoA edit CANNOT drift historical
// statements. See docs/reporting-ledger-architecture.md.
// ---------------------------------------------------------------------------
async function enrichSnapshotWithLiveCoa(args: {
  clubId: string;
  snapshot: BalanceSheetSnapshot;
}): Promise<BalanceSheetSnapshot> {
  const { snapshot } = args;
  const classifications = await resolveBalanceSheetLineClassifications({
    clubId: args.clubId,
    accountCodes: snapshot.lines.map((l) => l.accountCode),
  });
  // v15.16 — enrichment now overrides BOTH fsGroupKey AND
  // `line.category` when the CoA provides a derivation. Legacy
  // snapshots persisted before v15.16 have `line.category` set by
  // account-number range mapping, which misclassifies live PP&E and
  // equity balances outside the standard ranges. Re-deriving here
  // ensures a fresh preview built from a legacy snapshot renders
  // through the correct sections + reconciles.
  const enrichedLines = snapshot.lines.map((line) => {
    const c = classifications.get(line.accountCode);
    // v15.17 — contra-asset detection runs even when the CoA has
    // no classification for this account. `isAccumulatedDepreciationLine`
    // is a name-pattern fallback the founder authorised so accum.
    // depreciation accounts assigned to a generic Capital Assets
    // FS Group still route to `ppe-accumulated-depreciation` and
    // reduce Net PP&E instead of inflating it.
    const derivedCategory = deriveBalanceSheetCategoryFromCoa({
      accountType: c?.accountType ?? null,
      categoryKey: c?.categoryKey ?? null,
      fsGroupKey: c?.fsGroupKey ?? line.fsGroupKey ?? null,
      accountName: line.accountName,
      fsGroupName: line.fsGroupName ?? c?.fsGroupName ?? null,
    });
    if (!c && derivedCategory === null) return line;
    return {
      ...line,
      category: derivedCategory ?? line.category,
      fsGroupKey: line.fsGroupKey ?? c?.fsGroupKey ?? undefined,
      fsGroupName: line.fsGroupName ?? c?.fsGroupName ?? undefined,
      fsGroupSortOrder: line.fsGroupSortOrder ?? c?.fsGroupSortOrder ?? undefined,
    };
  });
  return { ...snapshot, lines: enrichedLines };
}

function endOfDayUtc(d: Date): Date {
  return new Date(
    Date.UTC(
      d.getUTCFullYear(),
      d.getUTCMonth(),
      d.getUTCDate(),
      23, 59, 59, 999,
    ),
  );
}

/**
 * Empty-state degenerate snapshot. Used when a club has no ledger
 * data AND no demo fallback — the React contract still gets a valid
 * `StatementOfFinancialPosition` shape with zeros instead of a hard
 * error. Real clubs will never see this branch; it's a safety net.
 */
function emptyBalanceSheetSnapshot(
  clubId: string,
  period: ReportingPeriod,
): BalanceSheetSnapshot {
  return {
    snapshotId: `bs_empty_${clubId}`,
    clubId,
    capturedAt: new Date(0),
    sourceSystem: "manual-entry",
    importBatchId: null,
    dataSource: "demo",
    notes: "Empty snapshot — no ledger data for this club / period.",
    entityKind: "balance-sheet",
    asOf: period.periodEnd,
    fiscalYearLabel: `FY${period.year}`,
    lines: [],
    totalAssets: 0,
    totalLiabilities: 0,
    totalEquity: 0,
    isReconciled: true,
  };
}

// =============================================================================
// Internal helpers
// =============================================================================

/**
 * Founder rule 2026-07-13 v15.20 — sort SoFP rows by the canonical
 * liquidity / statement-presentation order for the given section.
 *
 * The comparator is defined in `presentation-order.ts`. Every
 * ambiguous case falls through to a deterministic tie-break on the
 * FS-Group key so the order is stable across builds, PDF captures,
 * and archived-package deserialisation.
 *
 * Non-`fs-group` rows (section bands, subtotals, totals) pass
 * through unchanged in their input order — only the `fs-group`
 * rows are reordered against each other.
 */
function sortRowsByPresentation(
  rows: ReadonlyArray<SoFPRow>,
  section: BalanceSheetSection,
): SoFPRow[] {
  return [...rows].sort((a, b) => {
    if (a.kind !== "fs-group" || b.kind !== "fs-group") return 0;
    return comparePresentationOrder(
      { fsGroupKey: a.fsGroupKey ?? null, fsGroupSortOrder: undefined },
      { fsGroupKey: b.fsGroupKey ?? null, fsGroupSortOrder: undefined },
      section,
    );
  });
}

/**
 * Founder rule 2026-07-13 v15.21 — invariant validator for the
 * signed sign pipeline.
 *
 * Every `fs-group` row's `accounts[]` drill-down must sum to the
 * parent row's `current` (and `comparative`) within a $1 tolerance.
 * When this diverges, the account-level sign convention has drifted
 * from the parent-level convention — the exact failure the founder
 * observed with account 2017 pre-v15.21. Publication is blocked on
 * any mismatch.
 *
 * Returns a list of human-readable failure messages naming the
 * offending FS Groups + differences. Empty array means every
 * invariant holds.
 */
export function validateSofPSignInvariants(sofp: {
  assetsRows: ReadonlyArray<SoFPRow>;
  liabilitiesEquityRows: ReadonlyArray<SoFPRow>;
}): string[] {
  const failures: string[] = [];
  const tolerance = 1;
  const walk = (rows: ReadonlyArray<SoFPRow>): void => {
    for (const row of rows) {
      if (row.kind !== "fs-group" || !row.accounts || row.accounts.length === 0) {
        continue;
      }
      const summedCurrent = row.accounts.reduce(
        (s, a) => s + (a.current ?? 0),
        0,
      );
      if (Math.abs(summedCurrent - (row.current ?? 0)) > tolerance) {
        failures.push(
          `FS_GROUP_DETAIL_MISMATCH: ${row.label} (fsGroupKey=${row.fsGroupKey}) — ` +
            `drill-down accounts sum to $${summedCurrent.toFixed(2)} but parent row shows $${(row.current ?? 0).toFixed(2)}. ` +
            `Delta $${(summedCurrent - (row.current ?? 0)).toFixed(2)}.`,
        );
      }
      // Comparative check when the row carries it.
      const hasComparative = row.comparative !== null && row.comparative !== undefined;
      const anyDetailHasComparative = row.accounts.some(
        (a) => a.comparative !== null && a.comparative !== undefined,
      );
      if (hasComparative && anyDetailHasComparative) {
        const summedComparative = row.accounts.reduce(
          (s, a) => s + (a.comparative ?? 0),
          0,
        );
        if (Math.abs(summedComparative - (row.comparative ?? 0)) > tolerance) {
          failures.push(
            `FS_GROUP_DETAIL_MISMATCH (comparative): ${row.label} — ` +
              `drill-down accounts sum to $${summedComparative.toFixed(2)} but parent row shows $${(row.comparative ?? 0).toFixed(2)}.`,
          );
        }
      }
    }
  };
  walk(sofp.assetsRows);
  walk(sofp.liabilitiesEquityRows);
  return failures;
}

/**
 * Founder rule 2026-07-14 v15.23 — Current-Year Earnings must appear
 * exactly once in Members' Equity.
 *
 * Assets = Liabilities + (Retained Earnings + Current-Year Earnings +
 *   other equity FS Groups). Missing the Current-Year Earnings row
 * imbalances the sheet by exactly the FYTD surplus / deficit — the
 * defect the founder observed after v15.22 (Silver Springs May 2026
 * off by $2,358,610.98). Duplicating it (real closing entry + synthetic
 * line) doubles equity and imbalances the sheet in the other direction.
 *
 * The `synthesizeBalanceSheetSnapshot` writer already guards against
 * duplication by inspecting the flattened lines for
 * `BS_CURRENT_YEAR_EARNINGS`; this validator is defence-in-depth at
 * the publication boundary so a hand-crafted or archived payload can't
 * bypass the writer.
 *
 * Returns a list of failure messages. Empty means the SoFP either (a)
 * has exactly one YTD row, or (b) has zero YTD rows AND is reconciled
 * (no FYTD activity yet).
 */
export function validateCurrentYearEarnings(sofp: {
  liabilitiesEquityRows: ReadonlyArray<SoFPRow>;
  reconciliation?: {
    balances: boolean;
    totalAssetsCurrent?: number;
    totalLiabilitiesAndEquityCurrent?: number;
    difference?: number | null;
  };
}): string[] {
  const failures: string[] = [];
  const ytdRows = sofp.liabilitiesEquityRows.filter(
    (r) =>
      r.kind === "fs-group" &&
      (r.fsGroupKey ?? "").toUpperCase() === "BS_CURRENT_YEAR_EARNINGS",
  );
  if (ytdRows.length > 1) {
    const total = ytdRows.reduce((s, r) => s + (r.current ?? 0), 0);
    failures.push(
      `CURRENT_YEAR_EARNINGS_DUPLICATED: ${ytdRows.length} rows carrying ` +
        `fsGroupKey=BS_CURRENT_YEAR_EARNINGS found in Members' Equity ` +
        `(combined $${total.toFixed(2)}). Exactly one row is allowed. ` +
        `Cause is usually a closing-entry equity account AND the ` +
        `synthetic BalanceSheetProjection / live-synthesis line rolling ` +
        `in together — verify the CoA does not already route an account ` +
        `to BS_CURRENT_YEAR_EARNINGS if the synthesizer is also emitting one.`,
    );
  }
  const reconciliation = sofp.reconciliation;
  const balances = reconciliation?.balances ?? true;
  const difference = reconciliation?.difference ?? null;
  const materialImbalance =
    difference !== null && Math.abs(difference) > 1;
  if (
    ytdRows.length === 0 &&
    !balances &&
    materialImbalance
  ) {
    const totalAssets = reconciliation?.totalAssetsCurrent ?? 0;
    const totalLE = reconciliation?.totalLiabilitiesAndEquityCurrent ?? 0;
    failures.push(
      `CURRENT_YEAR_EARNINGS_MISSING: Statement of Financial Position is ` +
        `out of balance by $${Math.round(difference ?? 0).toLocaleString("en-US")} ` +
        `and no Current-Year Earnings row is present in Members' Equity. ` +
        `Total Assets $${Math.round(totalAssets).toLocaleString("en-US")}, ` +
        `Total Liabilities + Members' Equity $${Math.round(totalLE).toLocaleString("en-US")}. ` +
        `The Statement of Activities YTD result must be added to Members' Equity ` +
        `as an fsGroupKey=BS_CURRENT_YEAR_EARNINGS row. Verify that ` +
        `balanceSheet().currentYearEarnings is non-zero for the period and ` +
        `that the synthetic YTD line was emitted by ` +
        `synthesizeBalanceSheetSnapshot (or BalanceSheetProjection).`,
    );
  }
  return failures;
}

function bucketByCategory(
  lines: ReadonlyArray<BalanceSheetLine>,
): Map<BalanceSheetCategory, BalanceSheetLine[]> {
  const m = new Map<BalanceSheetCategory, BalanceSheetLine[]>();
  for (const l of lines) {
    const arr = m.get(l.category);
    if (arr) arr.push(l);
    else m.set(l.category, [l]);
  }
  return m;
}

// ---------------------------------------------------------------------------
// v15.14 — FS-Group aggregation. Replaces the pre-v15.14 `toDetailRows`
// (which emitted one row per account and made the SOFP read like a
// trial balance).
//
// Contract:
//   • Group lines by their `FinancialStatementGroup` key (from the
//     Chart of Accounts classification carried on each line).
//   • Sum current + comparative amounts within each group.
//   • Emit ONE `fs-group` SoFPRow per group, ordered by the group's
//     `fsGroupSortOrder` (falling back to a deterministic
//     lexicographic sort on the group key when no sort order is
//     supplied — never database insertion order).
//   • When `showAccountDetail: true`, attach the underlying accounts
//     to each summary row. Board / member / PDF payloads always pass
//     `false` so accounts are NEVER included in serialised archives.
//   • Lines with no `fsGroupKey` are collected into `unmappedSink` and
//     surfaced by the caller via `buildUnmappedBand()` — never
//     silently dropped from the statement.
// ---------------------------------------------------------------------------

/** How to normalise a line's amount into presentation sign.
 *
 *  Founder rule 2026-07-13 v15.21 — every mode PREFERS
 *  `line.rawSignedAmount` when available (Jonas debit-positive /
 *  credit-negative convention). The absolute-value modes remain
 *  as a legacy fallback for pre-v15.19 snapshots that lost the raw
 *  sign at projection time — but for any modern build they no
 *  longer strip abnormal balances.
 */
type FsGroupSignMode =
  // v15.21 — canonical section modes. These preserve abnormal balances
  // (a debit balance in a liability account correctly reduces the
  // liability; a credit balance in an asset account correctly reduces
  // the asset). Consumed by every aggregation except tax-family
  // netting (which does its own algebraic sum from `rawSignedAmount`).
  | "debit-normal"          // asset sections (current/capital-fund/long-term/ppe-gross): raw > 0 = debit adds to asset
  | "credit-normal"         // liability + equity sections: -raw so credit-negative → positive contribution
  | "contra-asset-signed"   // accum depreciation: raw < 0 (credit) natural reduction; abnormal raw > 0 (debit) increases gross
  // Legacy modes — retained for backward-compatibility only. Pre-v15.19
  // snapshots don't carry rawSignedAmount, so the fallback branches
  // treat `line.amount` (absolute magnitude) as the section's normal
  // side contribution.
  | "absolute"              // pre-v15.19 fallback for asset/liability/equity
  | "negative-absolute"     // pre-v15.19 fallback for accum. depreciation
  | "signed";               // synthetic lines (YTD net income) with signed `amount` and no rawSignedAmount

// ---------------------------------------------------------------------------
// v15.18 — Tax-family net settlement.
//
// Extract every tax-family line from the input snapshot before the
// standard section aggregation runs. Compute algebraic net per
// family (SALES_TAX / CORPORATE_TAX), determine debit-or-credit side,
// emit ONE dynamic SoFPRow per family on the correct side of the
// Statement of Financial Position.
//
// Guarantees:
//   • Underlying tax accounts are consumed EXACTLY ONCE (they never
//     re-enter the standard aggregation buckets — the caller
//     receives the tax-filtered line list as `remainingLines`).
//   • Signed drill-down is preserved: when `showAccountDetail`, the
//     emitted row's `accounts[]` array carries each underlying
//     account with its signed contribution — Credit balances render
//     as negative amounts, Debit balances as positive.
//   • Both current and comparative periods are computed
//     independently. Each side is decided by its own algebraic net,
//     so a May 2026 receivable + May 2025 payable emerge as
//     separate rows on different sides.
// ---------------------------------------------------------------------------

type DynamicTaxSide = "ASSET" | "LIABILITY";

type DynamicTaxRow = {
  family: TaxFamily;
  dynamicSide: DynamicTaxSide;
  row: SoFPRow;
};

function buildTaxNettingRows(args: {
  lines: ReadonlyArray<BalanceSheetLine>;
  priorLines: ReadonlyArray<BalanceSheetLine>;
  showAccountDetail: boolean;
}): { taxRows: DynamicTaxRow[]; remainingLines: BalanceSheetLine[] } {
  // Bucket every input line by family. Anything not tax-family
  // returns through `remainingLines` for the caller's standard
  // aggregation.
  const familyLinesCurrent = new Map<TaxFamily, BalanceSheetLine[]>();
  const familyLinesPrior = new Map<TaxFamily, BalanceSheetLine[]>();
  const remainingLines: BalanceSheetLine[] = [];
  for (const l of args.lines) {
    const family = getTaxFamily({
      accountName: l.accountName,
      fsGroupKey: l.fsGroupKey ?? null,
      fsGroupName: l.fsGroupName ?? null,
    });
    if (family === null) {
      remainingLines.push(l);
      continue;
    }
    const arr = familyLinesCurrent.get(family) ?? [];
    arr.push(l);
    familyLinesCurrent.set(family, arr);
  }
  for (const l of args.priorLines) {
    const family = getTaxFamily({
      accountName: l.accountName,
      fsGroupKey: l.fsGroupKey ?? null,
      fsGroupName: l.fsGroupName ?? null,
    });
    if (family === null) continue;
    const arr = familyLinesPrior.get(family) ?? [];
    arr.push(l);
    familyLinesPrior.set(family, arr);
  }

  const taxRows: DynamicTaxRow[] = [];
  const families: TaxFamily[] = ["SALES_TAX", "CORPORATE_TAX"];
  const labels: Record<TaxFamily, { asset: string; liability: string; keyBase: string }> = {
    SALES_TAX: {
      asset: "Sales Tax Receivable",
      liability: "Sales Tax Payable",
      keyBase: "sales-tax",
    },
    CORPORATE_TAX: {
      asset: "Corporate Income Tax Receivable",
      liability: "Corporate Income Tax Payable",
      keyBase: "corporate-tax",
    },
  };

  for (const family of families) {
    const current = familyLinesCurrent.get(family) ?? [];
    const prior = familyLinesPrior.get(family) ?? [];
    if (current.length === 0 && prior.length === 0) continue;

    const currentNet = current.length > 0 ? netTaxFamily(current) : null;
    const priorNet = prior.length > 0 ? netTaxFamily(prior) : null;

    const currentIsZero = currentNet === null || Math.abs(currentNet.signedTotal) < 1;
    const priorIsZero = priorNet === null || Math.abs(priorNet.signedTotal) < 1;
    if (currentIsZero && priorIsZero) continue;

    const currentSide: DynamicTaxSide | null = currentIsZero
      ? null
      : currentNet!.signedTotal > 0
        ? "ASSET"
        : "LIABILITY";
    const priorSide: DynamicTaxSide | null = priorIsZero
      ? null
      : priorNet!.signedTotal > 0
        ? "ASSET"
        : "LIABILITY";

    // Founder rule 2026-07-13 v15.18 — when current + comparative
    // land on OPPOSITE sides, emit one row per side. Each row's
    // "own-side" column carries its period's net; the opposite
    // period reads null (em-dash) so the reader never sees a
    // mismatched value inside the wrong section.
    const sidesToEmit: DynamicTaxSide[] = [];
    if (currentSide !== null) sidesToEmit.push(currentSide);
    if (priorSide !== null && !sidesToEmit.includes(priorSide)) {
      sidesToEmit.push(priorSide);
    }

    const accounts = args.showAccountDetail
      ? buildTaxRowAccounts({ currentLines: current, priorLines: prior })
      : undefined;

    for (const side of sidesToEmit) {
      const label = side === "ASSET" ? labels[family].asset : labels[family].liability;
      const currentPresentation =
        currentNet && currentSide === side ? Math.abs(currentNet.signedTotal) : null;
      const comparativePresentation =
        priorNet && priorSide === side ? Math.abs(priorNet.signedTotal) : null;
      const row: SoFPRow = {
        key: `${labels[family].keyBase}-net-${side.toLowerCase()}`,
        kind: "fs-group",
        label,
        current: currentPresentation,
        comparative: comparativePresentation,
        fsGroupKey:
          family === "SALES_TAX"
            ? side === "ASSET" ? "BS_SALES_TAX_RECEIVABLE" : "BS_SALES_TAX_PAYABLE"
            : side === "ASSET" ? "BS_INCOME_TAX_RECEIVABLE" : "BS_INCOME_TAX_PAYABLE",
        ...(accounts && accounts.length > 0 ? { accounts } : {}),
      };
      taxRows.push({ family, dynamicSide: side, row });
    }
  }
  return { taxRows, remainingLines };
}

/** Compute algebraic net across a family.
 *
 *  Founder rule 2026-07-13 v15.19 — PREFERRED path uses each line's
 *  `rawSignedAmount` (the untouched Trial Balance sign — debit
 *  positive, credit negative). This guarantees the imported balance
 *  direction is preserved regardless of the account's Chart of
 *  Accounts Type, its FS Group's normal side, or any account-name
 *  interpretation. An abnormal-side balance (e.g. a debit balance
 *  in an account otherwise typed as a liability) contributes exactly
 *  as it was imported.
 *
 *  FALLBACK path (only when `rawSignedAmount` is absent — legacy
 *  pre-v15.19 snapshots) infers direction from the account name
 *  via `getTaxAccountDirection`. Missing name hints default to
 *  CREDIT so a truly unclassified tax control account still
 *  contributes on the liability side.
 */
function netTaxFamily(
  lines: ReadonlyArray<BalanceSheetLine>,
): { signedTotal: number } {
  let signed = 0;
  for (const line of lines) {
    if (typeof line.rawSignedAmount === "number") {
      // Preferred path — raw TB sign wins over every other signal.
      signed += line.rawSignedAmount;
      continue;
    }
    // Legacy fallback — name-based inference.
    const dir = getTaxAccountDirection(line.accountName) ?? "CREDIT";
    const contribution = line.amount * (dir === "DEBIT" ? 1 : -1);
    signed += contribution;
  }
  return { signedTotal: signed };
}

/** Only surface the amount on the row's side. When the period's net
 *  landed on the OPPOSITE side to the row, return null so the reader
 *  isn't shown a mismatched value. Callers may want to emit a
 *  separate opposite-side row for the comparative period — that's
 *  handled by the caller pairing rows via fsGroupKey. */
function renderTaxSideMatch(args: {
  net: number;
  side: DynamicTaxSide;
}): number | null {
  if (Math.abs(args.net) < 1) return null;
  const netIsAsset = args.net > 0;
  const rowIsAsset = args.side === "ASSET";
  if (netIsAsset !== rowIsAsset) return null;
  return Math.abs(args.net);
}

/** Signed per-account drill-down. Each account renders with its
 *  ACTUAL Trial Balance sign — debit balances as positive, credit
 *  balances as negative — regardless of the parent row's side or
 *  the account's Chart of Accounts Type.
 *
 *  Founder rule 2026-07-13 v15.19 — the drill-down uses
 *  `rawSignedAmount` when available (preferred; guaranteed
 *  correct) and falls back to name inference for legacy snapshots
 *  only. This mirrors `netTaxFamily`'s pipeline so the detail rows
 *  always sum algebraically to the parent net. */
function buildTaxRowAccounts(args: {
  currentLines: ReadonlyArray<BalanceSheetLine>;
  priorLines: ReadonlyArray<BalanceSheetLine>;
}): SoFPAccountRow[] {
  const signedContribution = (line: BalanceSheetLine): number => {
    if (typeof line.rawSignedAmount === "number") return line.rawSignedAmount;
    const dir = getTaxAccountDirection(line.accountName) ?? "CREDIT";
    return line.amount * (dir === "DEBIT" ? 1 : -1);
  };
  const priorMap = new Map<string, BalanceSheetLine>();
  for (const l of args.priorLines) priorMap.set(l.accountCode, l);
  const out: SoFPAccountRow[] = [];
  for (const l of args.currentLines) {
    const signedCurrent = signedContribution(l);
    const priorLine = priorMap.get(l.accountCode);
    const signedComparative = priorLine ? signedContribution(priorLine) : null;
    out.push({
      accountCode: l.accountCode,
      accountName: l.accountName,
      current: signedCurrent,
      comparative: signedComparative,
    });
  }
  out.sort((a, b) => a.accountCode.localeCompare(b.accountCode));
  return out;
}

function aggregateByFsGroup(args: {
  lines: ReadonlyArray<BalanceSheetLine>;
  priorByCode: Map<string, number>;
  /** v15.21 — comparative-period raw signed amounts, keyed by
   *  accountCode. Populated when the prior snapshot carries
   *  `rawSignedAmount` (v15.19+); undefined per key for legacy
   *  snapshots so `normaliseSign` uses its fallback path. */
  priorSignedByCode?: Map<string, number | undefined>;
  signMode: FsGroupSignMode;
  unmappedSink: BalanceSheetLine[];
  keyPrefix: string;
  showAccountDetail: boolean;
}): SoFPRow[] {
  const { lines, priorByCode, priorSignedByCode, signMode, unmappedSink, keyPrefix, showAccountDetail } = args;
  // Aggregation buckets keyed by FS-Group key.
  const groups = new Map<string, {
    fsGroupKey: string;
    fsGroupName: string;
    fsGroupSortOrder: number;
    current: number;
    comparative: number;
    hasComparative: boolean;
    accounts: SoFPAccountRow[];
  }>();

  for (const line of lines) {
    // Line has no FS-Group classification → route to the unmapped
    // sink so the caller can render it explicitly. Never drop the
    // balance; it must still contribute to totals via the unmapped
    // band.
    if (!line.fsGroupKey || !line.fsGroupName) {
      unmappedSink.push(line);
      continue;
    }
    // v15.21 — the aggregation now consults `line.rawSignedAmount`
    // (Jonas debit-positive / credit-negative TB sign) via
    // `normaliseSign`. Abnormal balances (a debit balance in a
    // liability account, a credit balance in an asset account) are
    // preserved and contribute NEGATIVELY to their side — closing
    // the account-2017 systemic defect where a debit-balance
    // contra-payable was being added to Accounts Payable.
    const signedCurrent = normaliseSign(line, signMode);
    const priorRaw = priorByCode.get(line.accountCode);
    const priorRawSigned = priorSignedByCode?.get(line.accountCode);
    const signedComparative =
      priorRaw === undefined
        ? null
        : normaliseSign(
            {
              amount: priorRaw,
              rawSignedAmount: priorRawSigned,
              accountCode: line.accountCode,
              accountName: `${line.accountName} (prior year)`,
            },
            signMode,
          );

    let bucket = groups.get(line.fsGroupKey);
    if (!bucket) {
      bucket = {
        fsGroupKey: line.fsGroupKey,
        fsGroupName: line.fsGroupName,
        fsGroupSortOrder: line.fsGroupSortOrder ?? Number.MAX_SAFE_INTEGER,
        current: 0,
        comparative: 0,
        hasComparative: false,
        accounts: [],
      };
      groups.set(line.fsGroupKey, bucket);
    }
    bucket.current += signedCurrent;
    if (signedComparative !== null) {
      bucket.comparative += signedComparative;
      bucket.hasComparative = true;
    }
    bucket.accounts.push({
      accountCode: line.accountCode,
      accountName: line.accountName,
      current: signedCurrent,
      comparative: signedComparative,
    });
  }

  // Order deterministically by FS-Group sortOrder, then by group key
  // for stable output when sortOrder is missing / equal. Never rely
  // on Map insertion order.
  const ordered = Array.from(groups.values()).sort((a, b) => {
    if (a.fsGroupSortOrder !== b.fsGroupSortOrder) {
      return a.fsGroupSortOrder - b.fsGroupSortOrder;
    }
    return a.fsGroupKey.localeCompare(b.fsGroupKey);
  });

  // Sort each summary row's account list by accountCode so a hovered
  // reader sees the accounts in the order they appear on the COA.
  for (const bucket of ordered) {
    bucket.accounts.sort((a, b) => a.accountCode.localeCompare(b.accountCode));
  }

  return ordered.map((bucket): SoFPRow => ({
    key: `${keyPrefix}-fsg-${bucket.fsGroupKey}`,
    kind: "fs-group",
    label: bucket.fsGroupName,
    current: bucket.current,
    comparative: bucket.hasComparative ? bucket.comparative : null,
    fsGroupKey: bucket.fsGroupKey,
    // Underlying account detail crosses into the payload ONLY when
    // the reporting service was authorized. Omitting the field
    // entirely (rather than passing an empty array) prevents any
    // downstream serialiser from leaking `accounts: []` into
    // Board / PDF / archive payloads.
    ...(showAccountDetail ? { accounts: bucket.accounts } : {}),
  }));
}

/** Founder rule 2026-07-13 v15.21 — canonical section-side
 *  normalisation.
 *
 *  Preferred path uses the line's `rawSignedAmount` (the untouched
 *  Trial Balance sign — debit positive, credit negative) so
 *  abnormal balances (a debit balance in a liability account, a
 *  credit balance in an asset account) are preserved and correctly
 *  reduce their side of the statement.
 *
 *  Legacy fallback (`amount` only, no rawSignedAmount) reproduces
 *  the pre-v15.21 behaviour so demo seeds and pre-v15.19 archived
 *  snapshots still render identically.
 *
 *  The three canonical modes:
 *    • debit-normal        → contribution = raw signed amount as-is.
 *      Under Jonas debit-positive convention, an asset's normal
 *      debit balance stays positive (adds to asset total); an
 *      abnormal credit balance (negative raw) reduces the asset.
 *    • credit-normal       → contribution = -raw signed. A
 *      liability/equity credit balance (negative raw) becomes
 *      positive; an abnormal debit balance (positive raw) becomes
 *      NEGATIVE, correctly reducing the liability/equity.
 *    • contra-asset-signed → contribution = raw signed. Accum.
 *      depreciation stored as a credit (negative raw) naturally
 *      reduces PP&E; an abnormal debit balance in accum. depreciation
 *      correctly INCREASES PP&E (rare but must be preserved). This
 *      is the founder rule "avoid double-negating accumulated
 *      depreciation."
 */
/**
 * Founder rule 2026-07-13 v15.22 — the `MISSING_RAW_SIGNED_AMOUNT`
 * error the founder mandated as the response to any live projection
 * line that reaches the SoFP builder without a preserved raw
 * debit/credit sign. Live builds (Silver Springs seed, Jonas OTB
 * synthesis, projection persistence) MUST populate `rawSignedAmount`;
 * a missing value is a projection bug, not a rendering choice. Silent
 * fallback to `line.amount` (an unsigned magnitude) is what produced
 * the account-2017 defect. Publish paths must surface this error
 * loudly rather than render an incorrect statement.
 */
export class MissingRawSignedAmountError extends Error {
  readonly code = "MISSING_RAW_SIGNED_AMOUNT" as const;
  readonly accountCode: string;
  readonly accountName: string;
  readonly mode: FsGroupSignMode;
  constructor(args: {
    accountCode: string;
    accountName: string;
    mode: FsGroupSignMode;
  }) {
    super(
      `MISSING_RAW_SIGNED_AMOUNT: account ${args.accountCode} (${args.accountName}) ` +
        `reached the SoFP builder under signMode "${args.mode}" without a raw signed balance. ` +
        `Live projections and demo seeds MUST populate BalanceSheetLine.rawSignedAmount ` +
        `so the account's debit/credit direction is preserved from Trial Balance through render. ` +
        `Investigate: (1) balance-sheet synthesizer, (2) balance-sheet projection, (3) demo seed writer.`,
    );
    this.name = "MissingRawSignedAmountError";
    this.accountCode = args.accountCode;
    this.accountName = args.accountName;
    this.mode = args.mode;
  }
}

function normaliseSign(
  line: { amount: number; rawSignedAmount?: number; accountCode?: string; accountName?: string },
  mode: FsGroupSignMode,
): number {
  const raw = line.rawSignedAmount;
  const hasRaw = typeof raw === "number";
  switch (mode) {
    // Founder rule 2026-07-13 v15.22 — the three canonical live modes
    // REFUSE to fall back to `line.amount`. Missing rawSignedAmount on
    // a live projection is a defect upstream; silently converting the
    // magnitude here reintroduces the account-2017 sign loss.
    case "debit-normal":
      if (!hasRaw) {
        throw new MissingRawSignedAmountError({
          accountCode: line.accountCode ?? "<unknown>",
          accountName: line.accountName ?? "<unknown>",
          mode,
        });
      }
      return raw!;
    case "credit-normal":
      if (!hasRaw) {
        throw new MissingRawSignedAmountError({
          accountCode: line.accountCode ?? "<unknown>",
          accountName: line.accountName ?? "<unknown>",
          mode,
        });
      }
      return -raw!;
    case "contra-asset-signed":
      if (!hasRaw) {
        throw new MissingRawSignedAmountError({
          accountCode: line.accountCode ?? "<unknown>",
          accountName: line.accountName ?? "<unknown>",
          mode,
        });
      }
      return raw!;
    // Legacy modes — retained ONLY for reading pre-v15.22 archived
    // payloads whose lines never carried a raw sign. Never used for a
    // live build under this codepath (the live modes above are wired
    // in `aggregateByFsGroup`).
    case "absolute":
      return Math.abs(line.amount);
    case "negative-absolute":
      return -Math.abs(line.amount);
    case "signed":
      return line.amount;
  }
}

/** Build the unmapped-accounts band from every line collected while
 *  aggregating. Distinct list per statement — a line only lands here
 *  when the ChartAccount record has no FinancialStatementGroup
 *  assigned (a data-quality problem, not silent misclassification). */
function buildUnmappedBand(args: {
  unmappedLines: ReadonlyArray<BalanceSheetLine>;
  priorByCode: Map<string, number>;
}): StatementOfFinancialPosition["unmappedAccounts"] {
  if (args.unmappedLines.length === 0) return [];
  return args.unmappedLines
    .map((line) => {
      const priorRaw = args.priorByCode.get(line.accountCode);
      const inferredSide: "assets" | "liabilities-equity" | "unknown" =
        line.category === "current-asset" ||
        line.category === "capital-fund-asset" ||
        line.category === "ppe-gross" ||
        line.category === "ppe-accumulated-depreciation"
          ? "assets"
          : line.category === "current-liability" ||
              line.category === "long-term-liability" ||
              line.category === "operating-fund-balance" ||
              line.category === "capital-fund-balance" ||
              line.category === "ytd-net-income"
            ? "liabilities-equity"
            : "unknown";
      return {
        accountCode: line.accountCode,
        accountName: line.accountName,
        current: Math.abs(line.amount),
        comparative: priorRaw === undefined ? null : Math.abs(priorRaw),
        inferredSide,
      };
    })
    // Deterministic order by accountCode so the admin band renders
    // in the same sequence across periods.
    .sort((a, b) => a.accountCode.localeCompare(b.accountCode));
}

function sumRowsCurrent(rows: ReadonlyArray<SoFPRow>): number {
  return rows.reduce((s, r) => s + (r.current ?? 0), 0);
}
function sumRowsComparative(rows: ReadonlyArray<SoFPRow>): number {
  return rows.reduce((s, r) => s + (r.comparative ?? 0), 0);
}

function sumByPredicate(
  lines: ReadonlyArray<BalanceSheetLine>,
  pred: (l: BalanceSheetLine) => boolean,
): number {
  return lines.filter(pred).reduce((s, l) => s + l.amount, 0);
}

function buildPeriodColumnLabel(period: ReportingPeriod, yearOffset: number): string {
  return `${period.monthShort} ${period.year + yearOffset}`;
}

function buildStewardshipRatios(args: {
  workingCapitalRatio: number;
  netToGrossPpe: number;
  aux: SoFPAuxiliaryRatioInputs;
}): StatementOfFinancialPosition["stewardshipRatios"] {
  const { workingCapitalRatio, netToGrossPpe, aux } = args;
  return {
    eyebrow: "Stewardship Ratios",
    rows: [
      {
        key: "working-capital-ratio",
        label: "Working Capital Ratio",
        actualValue: workingCapitalRatio,
        actualLabel: `${workingCapitalRatio.toFixed(2)}x`,
        targetLabel: "≥1.5x",
        barFillPct: Math.min(1, workingCapitalRatio / 3),
        barTargetPct: 1.5 / 3,
        tone: "favorable",
        passesTarget: workingCapitalRatio >= 1.5,
      },
      {
        key: "ar-current-rate",
        label: "AR Current Rate",
        actualValue: aux.arCurrentRate,
        actualLabel: `${(aux.arCurrentRate * 100).toFixed(1)}%`,
        targetLabel: "≥90%",
        barFillPct: Math.min(1, aux.arCurrentRate),
        barTargetPct: 0.90,
        tone: "favorable",
        passesTarget: aux.arCurrentRate >= 0.90,
      },
      {
        key: "dues-to-revenue-ratio",
        label: "Dues to Revenue Ratio",
        actualValue: aux.duesToRevenueRatio,
        actualLabel: `${(aux.duesToRevenueRatio * 100).toFixed(1)}%`,
        targetLabel: "≥60%",
        barFillPct: Math.min(1, aux.duesToRevenueRatio),
        barTargetPct: 0.60,
        tone: "risk",
        passesTarget: aux.duesToRevenueRatio >= 0.60,
      },
      {
        key: "reserve-coverage-ratio",
        label: "Reserve Coverage Ratio",
        actualValue: aux.reserveCoverageRatio,
        actualLabel: `${(aux.reserveCoverageRatio * 100).toFixed(0)}%`,
        targetLabel: "≥60%",
        barFillPct: Math.min(1, aux.reserveCoverageRatio),
        barTargetPct: 0.60,
        tone: "capital",
        passesTarget: aux.reserveCoverageRatio >= 0.60,
      },
      {
        key: "net-to-gross-ppe-ratio",
        label: "Net-to-Gross PP&E Ratio",
        actualValue: netToGrossPpe,
        actualLabel: `${(netToGrossPpe * 100).toFixed(0)}%`,
        targetLabel: "≥50%",
        barFillPct: Math.min(1, netToGrossPpe),
        barTargetPct: 0.50,
        tone: "risk",
        passesTarget: netToGrossPpe >= 0.50,
      },
      {
        key: "debt-service-coverage",
        label: "Debt Service Coverage",
        actualValue: aux.debtServiceCoverage,
        actualLabel: `${aux.debtServiceCoverage.toFixed(1)}x`,
        targetLabel: "≥1.5x",
        barFillPct: Math.min(1, aux.debtServiceCoverage / 4),
        barTargetPct: 1.5 / 4,
        tone: "favorable",
        passesTarget: aux.debtServiceCoverage >= 1.5,
      },
    ],
  };
}
