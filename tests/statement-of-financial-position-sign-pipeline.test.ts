// Founder rule 2026-07-13 v15.21 â€” one canonical sign pipeline for
// every balance-sheet section.
//
// Root cause of the founder-observed account-2017 defect: the
// aggregation modes `signMode: "absolute"` and `"negative-absolute"`
// used `Math.abs(line.amount)` â€” stripping the raw Trial Balance
// sign and forcing every liability line positive regardless of its
// actual debit/credit direction. A contra-payable account with a
// debit balance was therefore ADDED to Accounts Payable instead of
// deducted.
//
// v15.21 rewrites `normaliseSign` so it (a) accepts the full
// `BalanceSheetLine`, (b) prefers `line.rawSignedAmount` when
// present (the Jonas debit-positive / credit-negative convention),
// and (c) applies section-side normalisation via three new canonical
// modes: `debit-normal`, `credit-normal`, `contra-asset-signed`.
// Abnormal balances are preserved: a debit balance in a liability
// account REDUCES the liability; a credit balance in an asset
// account REDUCES the asset; contra-assets are never double-negated.
//
// This suite locks the pipeline systemically â€” the invariants must
// hold for every category, every FS Group, every drill-down.

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

import {
  buildStatementOfFinancialPositionFromBalanceSheet,
  validateSofPSignInvariants,
} from "@/lib/reporting/statement-of-financial-position";
import type {
  BalanceSheetLine,
  BalanceSheetSnapshot,
} from "@/lib/reporting/ledger/contracts";
import { buildReportingPeriod } from "@/lib/reporting/reporting-period";

const MAY_2026 = buildReportingPeriod(new Date(Date.UTC(2026, 4, 31)));
const AUX_INPUTS = {
  arCurrentRate: 0.999,
  duesToRevenueRatio: 0.659,
  reserveCoverageRatio: 0.61,
  debtServiceCoverage: 2.1,
  netToGrossPpeOverride: 0.44,
} as const;

function makeSnapshot(
  lines: ReadonlyArray<Omit<BalanceSheetLine, "priorYearSameDateAmount">>,
): BalanceSheetSnapshot {
  return {
    snapshotId: "bs_test",
    clubId: "club_test",
    capturedAt: new Date(0),
    sourceSystem: "demo-seed",
    importBatchId: null,
    dataSource: "demo",
    notes: "test snapshot",
    entityKind: "balance-sheet",
    asOf: MAY_2026.periodEnd,
    fiscalYearLabel: `FY${MAY_2026.year}`,
    lines: lines.map((l) => ({
      ...l,
      // v15.22 â€” auto-derive rawSignedAmount so the strict live-mode guard
      // in `normaliseSign` does not throw. Convention matches the demo seed.
      // v15.22 — for tax-family accounts (fsGroupKey ~ BS_*_TAX_*) we
      // intentionally LEAVE rawSignedAmount undefined so `netTaxFamily`s
      // legacy name-based `getTaxAccountDirection` inference fires — the
      // sign of a tax control account is NOT determined by category
      // alone (GST Collected is credit-normal, GST Paid is debit-normal,
      // both live inside the same `current-liability` bucket).
      rawSignedAmount:
        l.rawSignedAmount ??
        (l.fsGroupKey && /TAX/i.test(l.fsGroupKey)
          ? undefined
          : l.category === "current-asset" ||
              l.category === "capital-fund-asset" ||
              l.category === "long-term-asset" ||
              l.category === "ppe-gross"
            ? l.amount
            : -l.amount),
      priorYearSameDateAmount: null,
    })),
    totalAssets: 0,
    totalLiabilities: 0,
    totalEquity: 0,
    isReconciled: true,
  };
}

// ---------------------------------------------------------------------------
// 1) Founder's exact account 2017 scenario â€” reduces AP correctly.
// ---------------------------------------------------------------------------
describe("v15.21 account 2017 systemic fix â€” abnormal debit in a liability FS Group REDUCES the liability", () => {
  it("Accounts Payable drill-down: credit-balance payables ADD, debit-balance contra-payable SUBTRACTS, drill-down sums to parent", () => {
    // Founder's exact source values (magnitudes + raw signed).
    // 2000..2016 are credit-balance payables; 2017 is the founder-
    // flagged debit-balance contra-payable.
    const snapshot = makeSnapshot([
      // 8 payables â€” 7 credit-normal + 1 debit-abnormal.
      { accountCode: "2000", accountName: "Accounts Payable",              category: "current-liability", fund: "operating", amount: 498_346, rawSignedAmount: -498_346, fsGroupKey: "BS_AP", fsGroupName: "Accounts Payable", fsGroupSortOrder: 500 },
      { accountCode: "2001", accountName: "Accts Payable - Accrued Expenses", category: "current-liability", fund: "operating", amount: 55_469, rawSignedAmount: -55_469, fsGroupKey: "BS_AP", fsGroupName: "Accounts Payable", fsGroupSortOrder: 500 },
      { accountCode: "2002", accountName: "Bank - Visa 8103",              category: "current-liability", fund: "operating", amount: 3_294,  rawSignedAmount: -3_294,   fsGroupKey: "BS_AP", fsGroupName: "Accounts Payable", fsGroupSortOrder: 500 },
      { accountCode: "2003", accountName: "Bank - Visa 6528",              category: "current-liability", fund: "operating", amount: 685,    rawSignedAmount: -685,     fsGroupKey: "BS_AP", fsGroupName: "Accounts Payable", fsGroupSortOrder: 500 },
      { accountCode: "2015", accountName: "Accts Payable - Group Plan Premium", category: "current-liability", fund: "operating", amount: 0, rawSignedAmount: 0,       fsGroupKey: "BS_AP", fsGroupName: "Accounts Payable", fsGroupSortOrder: 500 },
      { accountCode: "2016", accountName: "Accts Payable - Staff Gratuity", category: "current-liability", fund: "operating", amount: 88_959, rawSignedAmount: -88_959, fsGroupKey: "BS_AP", fsGroupName: "Accounts Payable", fsGroupSortOrder: 500 },
      // â† The founder's flagged account: DEBIT balance (rawSignedAmount > 0).
      { accountCode: "2017", accountName: "Accts Payable Contra - Grat Payout", category: "current-liability", fund: "operating", amount: 65_486, rawSignedAmount: 65_486, fsGroupKey: "BS_AP", fsGroupName: "Accounts Payable", fsGroupSortOrder: 500 },
      { accountCode: "2018", accountName: "Acct Payable - Bee Club",       category: "current-liability", fund: "operating", amount: 473,    rawSignedAmount: -473,     fsGroupKey: "BS_AP", fsGroupName: "Accounts Payable", fsGroupSortOrder: 500 },
      // Balance the sheet: 498346+55469+3294+685+0+88959+473 = 647226 credit âˆ’ 65486 debit = 581740 net AP.
      { accountCode: "1010", accountName: "Cash", category: "current-asset", fund: "operating", amount: 581_740, rawSignedAmount: 581_740, fsGroupKey: "BS_CASH_EQUIVALENTS", fsGroupName: "Cash & Cash Equivalents", fsGroupSortOrder: 10 },
    ]);
    const sofp = buildStatementOfFinancialPositionFromBalanceSheet({
      clubName: "Test Club",
      period: MAY_2026,
      currentSnapshot: snapshot,
      auxiliaryRatioInputs: AUX_INPUTS,
      grossReplacementCostLabel: "$0",
      viewerCanDrillDown: true, // â† authorised drill-down
    });
    const apRow = sofp.liabilitiesEquityRows.find(
      (r) => r.fsGroupKey === "BS_AP",
    );
    expect(apRow).toBeDefined();
    // Parent = credit-balance payables sum âˆ’ contra debit.
    // = (498346+55469+3294+685+0+88959+473) âˆ’ 65486 = 647226 âˆ’ 65486 = 581740
    expect(apRow?.current).toBe(581_740);
    // Drill-down: account 2017 shows as NEGATIVE contribution.
    const acct2017 = apRow?.accounts?.find((a) => a.accountCode === "2017");
    expect(acct2017?.current).toBe(-65_486);
    // Every credit-balance payable shows as POSITIVE (increases AP).
    const acct2000 = apRow?.accounts?.find((a) => a.accountCode === "2000");
    expect(acct2000?.current).toBe(498_346);
    const acct2016 = apRow?.accounts?.find((a) => a.accountCode === "2016");
    expect(acct2016?.current).toBe(88_959);
    // Detail rows sum to parent â€” locked by the invariant validator.
    const failures = validateSofPSignInvariants(sofp);
    expect(failures).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2) Abnormal credit balance in an ASSET account reduces assets.
// ---------------------------------------------------------------------------
describe("v15.21 abnormal credit balance in an asset account reduces assets", () => {
  it("A credit-balance AR account (customer over-payment) reduces Total AR", () => {
    const snapshot = makeSnapshot([
      // Two AR accounts under BS_AR â€” one normal debit, one abnormal credit.
      { accountCode: "1100", accountName: "AR - Members",             category: "current-asset", fund: "operating", amount: 100_000, rawSignedAmount: 100_000, fsGroupKey: "BS_AR", fsGroupName: "Accounts Receivable", fsGroupSortOrder: 400 },
      { accountCode: "1101", accountName: "AR - Customer Overpay",    category: "current-asset", fund: "operating", amount:  15_000, rawSignedAmount: -15_000, fsGroupKey: "BS_AR", fsGroupName: "Accounts Receivable", fsGroupSortOrder: 400 },
      { accountCode: "3010", accountName: "Retained Earnings", category: "operating-fund-balance", fund: "operating", amount: 85_000, rawSignedAmount: -85_000, fsGroupKey: "BS_RETAINED_EARNINGS", fsGroupName: "Retained Earnings", fsGroupSortOrder: 800 },
    ]);
    const sofp = buildStatementOfFinancialPositionFromBalanceSheet({
      clubName: "Test",
      period: MAY_2026,
      currentSnapshot: snapshot,
      auxiliaryRatioInputs: AUX_INPUTS,
      grossReplacementCostLabel: "$0",
      viewerCanDrillDown: true,
    });
    const arRow = sofp.assetsRows.find((r) => r.fsGroupKey === "BS_AR");
    expect(arRow?.current).toBe(85_000); // 100k debit âˆ’ 15k credit
    expect(sofp.reconciliation.balances).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3) Accumulated depreciation is not double-negated.
// ---------------------------------------------------------------------------
describe("v15.21 accumulated depreciation preserves natural credit sign â€” no double negation", () => {
  it("A normal credit-balance accum. depreciation contributes negatively to Net PP&E (not double-negated to positive)", () => {
    const snapshot = makeSnapshot([
      { accountCode: "1500", accountName: "Land",       category: "ppe-gross",  fund: "capital", amount: 10_000_000, rawSignedAmount: 10_000_000, fsGroupKey: "BS_LAND", fsGroupName: "Land", fsGroupSortOrder: 200 },
      // credit balance stored as -3M raw
      { accountCode: "1590", accountName: "Accum Deprec", category: "ppe-accumulated-depreciation", fund: "capital", amount: 3_000_000, rawSignedAmount: -3_000_000, fsGroupKey: "BS_ACCUMULATED_DEPRECIATION", fsGroupName: "Accumulated Depreciation", fsGroupSortOrder: 300 },
      { accountCode: "3010", accountName: "Retained Earnings", category: "operating-fund-balance", fund: "operating", amount: 7_000_000, rawSignedAmount: -7_000_000, fsGroupKey: "BS_RETAINED_EARNINGS", fsGroupName: "Retained Earnings", fsGroupSortOrder: 800 },
    ]);
    const sofp = buildStatementOfFinancialPositionFromBalanceSheet({
      clubName: "Test",
      period: MAY_2026,
      currentSnapshot: snapshot,
      auxiliaryRatioInputs: AUX_INPUTS,
      grossReplacementCostLabel: "$0",
    });
    // Net PP&E = 10M gross - 3M accum = 7M
    const netPpeRow = sofp.assetsRows.find((r) => r.key === "net-ppe");
    expect(netPpeRow?.current).toBe(7_000_000);
    expect(sofp.reconciliation.balances).toBe(true);
  });

  it("An ABNORMAL debit balance in accum. depreciation INCREASES gross PP&E (rare but must be preserved)", () => {
    // Extremely rare scenario: an abnormal debit reversal in an
    // accumulated depreciation account. Under the old `Math.abs`
    // path this would still deduct; the correct treatment is to
    // let it increase the gross PP&E because the debit sign says
    // "no accumulated depreciation applied â€” this is reversed."
    const snapshot = makeSnapshot([
      { accountCode: "1500", accountName: "Land",       category: "ppe-gross",  fund: "capital", amount: 10_000_000, rawSignedAmount: 10_000_000, fsGroupKey: "BS_LAND", fsGroupName: "Land", fsGroupSortOrder: 200 },
      // Abnormal debit balance (rare correction entry).
      { accountCode: "1590", accountName: "Accum Deprec", category: "ppe-accumulated-depreciation", fund: "capital", amount: 100_000, rawSignedAmount: 100_000, fsGroupKey: "BS_ACCUMULATED_DEPRECIATION", fsGroupName: "Accumulated Depreciation", fsGroupSortOrder: 300 },
      { accountCode: "3010", accountName: "Retained Earnings", category: "operating-fund-balance", fund: "operating", amount: 10_100_000, rawSignedAmount: -10_100_000, fsGroupKey: "BS_RETAINED_EARNINGS", fsGroupName: "Retained Earnings", fsGroupSortOrder: 800 },
    ]);
    const sofp = buildStatementOfFinancialPositionFromBalanceSheet({
      clubName: "Test",
      period: MAY_2026,
      currentSnapshot: snapshot,
      auxiliaryRatioInputs: AUX_INPUTS,
      grossReplacementCostLabel: "$0",
    });
    // Net PP&E = 10M gross + 100k abnormal debit = 10.1M
    // (The debit is not treated as a deduction â€” that's the founder's
    // "avoid double-negation" rule.)
    const netPpeRow = sofp.assetsRows.find((r) => r.key === "net-ppe");
    expect(netPpeRow?.current).toBe(10_100_000);
    expect(sofp.reconciliation.balances).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4) The invariant validator catches drift.
// ---------------------------------------------------------------------------
describe("v15.21 validateSofPSignInvariants â€” catches drill-down / parent drift", () => {
  it("emits FS_GROUP_DETAIL_MISMATCH when a drill-down row is manually tampered with (defence-in-depth guard)", () => {
    const snapshot = makeSnapshot([
      { accountCode: "2000", accountName: "AP", category: "current-liability", fund: "operating", amount: 100_000, rawSignedAmount: -100_000, fsGroupKey: "BS_AP", fsGroupName: "Accounts Payable", fsGroupSortOrder: 500 },
      { accountCode: "1010", accountName: "Cash", category: "current-asset", fund: "operating", amount: 100_000, rawSignedAmount: 100_000, fsGroupKey: "BS_CASH_EQUIVALENTS", fsGroupName: "Cash & Cash Equivalents", fsGroupSortOrder: 10 },
      { accountCode: "3010", accountName: "Retained Earnings", category: "operating-fund-balance", fund: "operating", amount: 0, rawSignedAmount: 0, fsGroupKey: "BS_RETAINED_EARNINGS", fsGroupName: "Retained Earnings", fsGroupSortOrder: 800 },
    ]);
    const sofp = buildStatementOfFinancialPositionFromBalanceSheet({
      clubName: "Test",
      period: MAY_2026,
      currentSnapshot: snapshot,
      auxiliaryRatioInputs: AUX_INPUTS,
      grossReplacementCostLabel: "$0",
      viewerCanDrillDown: true,
    });
    // Untampered â€” no failures.
    expect(validateSofPSignInvariants(sofp)).toEqual([]);

    // Simulate a tampered payload â€” parent stays at 100k but the
    // drill-down accounts are mutated to sum to 200k.
    const tampered = {
      ...sofp,
      liabilitiesEquityRows: sofp.liabilitiesEquityRows.map((r) => {
        if (r.fsGroupKey === "BS_AP" && r.accounts) {
          return {
            ...r,
            accounts: r.accounts.map((a) => ({ ...a, current: 200_000 })),
          };
        }
        return r;
      }),
    };
    const failures = validateSofPSignInvariants(tampered);
    expect(failures.length).toBeGreaterThan(0);
    expect(failures[0]).toMatch(/FS_GROUP_DETAIL_MISMATCH/);
    expect(failures[0]).toMatch(/Accounts Payable/);
  });
});

// ---------------------------------------------------------------------------
// 5) Source-contract â€” no Math.abs in section-normalisation code paths.
// ---------------------------------------------------------------------------
describe("v15.21 source contract â€” canonical modes replace Math.abs in section normalisation", () => {
  const sofpSource = fs.readFileSync(
    path.resolve(
      process.cwd(),
      "src/lib/reporting/statement-of-financial-position.ts",
    ),
    "utf8",
  );
  it("normaliseSign accepts a line object (not a bare amount) so rawSignedAmount can be preferred", () => {
    // v15.22 — the signature grew accountCode + accountName so the
    // strict-mode failure carries the offending account through the
    // thrown MissingRawSignedAmountError.
    expect(sofpSource).toMatch(
      /function normaliseSign\(\s*line: \{ amount: number; rawSignedAmount\?:\s*number; accountCode\?:\s*string; accountName\?:\s*string \}/,
    );
  });
  it("three new canonical modes exist: debit-normal, credit-normal, contra-asset-signed", () => {
    expect(sofpSource).toMatch(/"debit-normal"/);
    expect(sofpSource).toMatch(/"credit-normal"/);
    expect(sofpSource).toMatch(/"contra-asset-signed"/);
  });
  it("credit-normal INVERTS the raw sign so credit-negative balances become positive contributions AND debit-positive balances become negative (reduce the liability)", () => {
    // The founder's key semantic: credit-normal must return -raw.
    // Any code that returns +raw for credit-normal reintroduces the
    // account-2017 defect. v15.22 — the fallback to line.amount was
    // removed in favour of a MissingRawSignedAmountError throw.
    expect(sofpSource).toMatch(/case "credit-normal":[\s\S]{0,300}return -raw!/);
  });
  it("contra-asset-signed does NOT double-negate — returns raw as-is when present", () => {
    // v15.22 — no fallback to -Math.abs; the strict guard throws
    // MissingRawSignedAmountError instead. The RETURN path just
    // returns raw!.
    expect(sofpSource).toMatch(/case "contra-asset-signed":[\s\S]{0,300}return raw!/);
  });
  it("v15.22 — the three live modes THROW MissingRawSignedAmountError when raw is missing", () => {
    // The founder's mandated strict guard: no silent fallback to
    // magnitude. Any live mode without rawSignedAmount is a projection
    // bug and must be surfaced loudly.
    expect(sofpSource).toMatch(/throw new MissingRawSignedAmountError/);
    expect(sofpSource).toMatch(/MISSING_RAW_SIGNED_AMOUNT/);
  });
  it("liability sections wire credit-normal (not absolute)", () => {
    // Every current-liability / long-term-liability / operating-fund /
    // capital-fund aggregation must pass `signMode: "credit-normal"`.
    // If any regressed to `"absolute"` the account-2017 bug returns.
    // signMode appears BEFORE keyPrefix in the aggregateByFsGroup call
    // so we search a window preceding each keyPrefix marker.
    const currentLiabBlock = sofpSource.match(
      /[\s\S]{0,400}keyPrefix: "current-liability"/,
    );
    expect(currentLiabBlock?.[0]).toMatch(/signMode: "credit-normal"/);
    const longTermLiabBlock = sofpSource.match(
      /[\s\S]{0,400}keyPrefix: "long-term-liability"/,
    );
    expect(longTermLiabBlock?.[0]).toMatch(/signMode: "credit-normal"/);
    const equityBlock = sofpSource.match(
      /[\s\S]{0,400}keyPrefix: "operating-fund"/,
    );
    expect(equityBlock?.[0]).toMatch(/signMode: "credit-normal"/);
  });
  it("PP&E gross wires debit-normal; accum-depr wires contra-asset-signed (not negative-absolute)", () => {
    const ppeGrossBlock = sofpSource.match(/[\s\S]{0,400}keyPrefix: "ppe-gross"/);
    expect(ppeGrossBlock?.[0]).toMatch(/signMode: "debit-normal"/);
    const accumDeprBlock = sofpSource.match(/[\s\S]{0,400}keyPrefix: "accum-depr"/);
    expect(accumDeprBlock?.[0]).toMatch(/signMode: "contra-asset-signed"/);
  });
  it("Net PP&E math uses ADDITION (+) not subtraction of |accumDepr| â€” accum sign is preserved", () => {
    // Old code: `netPpeCurrent = ppeGrossCurrent - Math.abs(accumDeprCurrent);`
    // New code: `netPpeCurrent = ppeGrossCurrent + accumDeprCurrent;`
    // A normal credit accumDepr is negative â†’ gross + (-accum) = gross - accum.
    // An abnormal debit accumDepr is positive â†’ gross + (+accum) = gross + accum.
    expect(sofpSource).toMatch(
      /netPpeCurrent = ppeGrossCurrent \+ accumDeprCurrent/,
    );
    // The pre-v15.21 pattern is gone.
    expect(sofpSource).not.toMatch(
      /accumDeprCurrent = Math\.abs\(sumRowsCurrent\(accumDeprRows\)\)/,
    );
  });
});

// ---------------------------------------------------------------------------
// 6) Publication guard fires on invariant failure.
// ---------------------------------------------------------------------------
describe("v15.21 publication guard â€” refuses to freeze a package whose drill-down doesn't sum to parent", () => {
  const lifecycle = fs.readFileSync(
    path.resolve(
      process.cwd(),
      "src/lib/reporting/monthly-package-lifecycle.ts",
    ),
    "utf8",
  );
  it("publish path calls validateSofPSignInvariants and blocks on any failure", () => {
    // v15.23 — the import statement was folded together with
    // validateCurrentYearEarnings, so match the multi-line named
    // import shape rather than the pre-v15.23 single-line form.
    expect(lifecycle).toMatch(/validateSofPSignInvariants,?\s*(?:validateCurrentYearEarnings,?\s*)?\}?\s*(?:,\s*validateCurrentYearEarnings,?\s*)?\}?\s*from ["']\.\/statement-of-financial-position["']/);
    expect(lifecycle).toMatch(/FS_GROUP_DETAIL_MISMATCH: sign-pipeline invariants failed/);
  });
});
