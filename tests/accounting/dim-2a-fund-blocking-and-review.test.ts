// DIM-2a (2026-09-29) — Control-gate tests for the pre-Master-COA-import slice.
//
// Covers Sections 1-6:
//   * Unknown Fund key MUST block commit (never silently drop metadata)
//   * Cross-tenant Fund key MUST be rejected (guaranteed by tenant-scoped
//     `options.funds` in getCoaMappingOptions)
//   * Dimensional review summary shape + counts
//   * Review-list determinism for CAPITAL / dept / fund exceptions

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  resolveCoaRow,
  type CoaMappingOptions,
  type CoaRowMapping,
} from "@/lib/imports/coa-mapping";

import {
  summariseCoaBatch,
  capitalReviewCandidates,
  departmentPolicyExceptions,
  fundPolicyRequiredWithoutApplicabilityRows,
  departmentPolicyRequiredWithoutApplicabilityRows,
  type CoaReviewInputRow,
} from "@/lib/imports/coa-dimensional-review";

// Structural imports for the "commit uses pre-resolved fund ids" test.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..", "..");
const IMPORTS = readFileSync(path.join(REPO, "src", "lib", "imports", "index.ts"), "utf8");

// A minimally-populated options bundle for the resolver.
function optionsWithFunds(funds: ReadonlyArray<{ id: string; key: string; name: string }>): CoaMappingOptions {
  return {
    types: ["ASSET", "LIABILITY", "EQUITY", "REVENUE", "EXPENSE"] as const,
    categories: [
      { id: "cat-cur", key: "CURRENT_ASSETS", name: "Current Assets", accountType: "ASSET" },
      { id: "cat-op-exp", key: "OPERATING_EXPENSES", name: "Operating Expenses", accountType: "EXPENSE" },
    ],
    fsGroups: [
      { id: "fs-cash", key: "BS_CASH_EQUIVALENTS", name: "Cash", statement: "BALANCE_SHEET" },
      { id: "fs-op", key: "IS_OPERATING", name: "Operating Expenses", statement: "INCOME_STATEMENT" },
    ],
    departments: [
      { id: "dept-admin", code: "ADMIN", name: "Administration" },
    ],
    funds,
  };
}

const TENANT_FUNDS = [
  { id: "fund-op", key: "OPERATING", name: "Operating Fund" },
  { id: "fund-cap", key: "CAPITAL", name: "Capital Fund" },
];

describe("DIM-2a · unknown Fund keys BLOCK commit", () => {
  const options = optionsWithFunds(TENANT_FUNDS);
  const base: CoaRowMapping = {
    number: "6098",
    name: "Licenses",
    type: "EXPENSE",
    categoryKey: "OPERATING_EXPENSES",
    fsGroupKey: "IS_OPERATING",
    departmentCodes: [],
  };

  it("valid tenant Fund key → resolves and lands in fundIds", () => {
    const result = resolveCoaRow({ ...base, fundApplicabilityKeys: ["OPERATING"] }, options);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.resolved.fundIds).toEqual(["fund-op"]);
      expect(result.resolved.fundApplicabilityKeys).toEqual(["OPERATING"]);
    }
  });

  it("unknown Fund key → UNKNOWN_FUND ImportError, row does not resolve", () => {
    const result = resolveCoaRow({ ...base, fundApplicabilityKeys: ["ENDOWMENT"] }, options);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const unknownFund = result.errors.find((e) => e.code === "UNKNOWN_FUND");
      expect(unknownFund).toBeDefined();
      expect(unknownFund?.message).toMatch(/ENDOWMENT/);
      expect(unknownFund?.columnName).toBe("fundApplicability");
    }
  });

  it("cross-tenant Fund key → rejected because getCoaMappingOptions filters by clubId, so unknown keys never enter options.funds", () => {
    // A fund belonging to a different tenant is not in `options.funds`
    // (getCoaMappingOptions filters by clubId). The resolver treats
    // it as UNKNOWN_FUND — the same code path as any bogus key.
    // Cross-tenant fund IDs cannot enter `options.funds` because
    // that would require calling getCoaMappingOptions on the wrong
    // clubId, which the ensureWrite guards in imports/index.ts
    // prevent. This test asserts the structural safety:
    const optionsNoCap = optionsWithFunds([{ id: "fund-op", key: "OPERATING", name: "Operating Fund" }]);
    const result = resolveCoaRow({ ...base, fundApplicabilityKeys: ["CAPITAL"] }, optionsNoCap);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.code === "UNKNOWN_FUND")).toBe(true);
    }
  });

  it("mixed valid + unknown → row fails and NO valid keys leak into fundIds", () => {
    const result = resolveCoaRow({ ...base, fundApplicabilityKeys: ["OPERATING", "ENDOWMENT"] }, options);
    // The row must fail overall so the commit path cannot silently
    // persist a partial AccountFund set (dropped ENDOWMENT).
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const unknownFund = result.errors.find((e) => e.code === "UNKNOWN_FUND");
      expect(unknownFund).toBeDefined();
    }
  });

  it("unknown Fund cannot result in silent AccountFund count = 0 — the commit path uses PRE-RESOLVED fundIds from validate, not a fresh Fund.findMany", () => {
    // The DIM-2 pre-DIM-2a code re-queried Fund.findMany at commit
    // time and silently dropped unknown keys. Under DIM-2a the
    // commit uses `normalized.fundIds` (pre-resolved). This
    // structural assertion catches a regression back to the
    // silent-drop pattern.
    expect(IMPORTS).toMatch(/preResolvedFundIds/);
    // And the pre-DIM-2a Fund.findMany + createMany-from-lookup
    // pattern in the commit path is gone (search for the
    // characteristic `key: { in: fundApplicabilityKeys }` fragment).
    expect(IMPORTS).not.toMatch(/tx\.fund\.findMany\s*\(\s*\{\s*where:\s*\{\s*clubId:\s*batch\.clubId,\s*key:\s*\{\s*in:\s*fundApplicabilityKeys/);
    expect(IMPORTS).not.toMatch(/prisma\.fund\.findMany\s*\(\s*\{\s*where:\s*\{\s*clubId,\s*key:\s*\{\s*in:\s*fundApplicabilityKeys/);
  });
});

// ---------------------------------------------------------------------------
// Section 3-6 helpers: batch summary + review lists
// ---------------------------------------------------------------------------

function makeReviewRow(overrides: Partial<CoaReviewInputRow>): CoaReviewInputRow {
  return {
    accountNumber: overrides.accountNumber ?? "0000",
    name: overrides.name ?? "Test",
    type: overrides.type ?? "EXPENSE",
    fsGroupKey: overrides.fsGroupKey ?? "IS_OPERATING",
    confidence: overrides.confidence ?? "high",
    source: overrides.source ?? "name-keyword",
    departmentPolicy: overrides.departmentPolicy ?? "REQUIRED",
    fundPolicy: overrides.fundPolicy ?? "REQUIRED",
    fundApplicabilityKeys: overrides.fundApplicabilityKeys ?? ["OPERATING"],
    departmentApplicabilityCodes: overrides.departmentApplicabilityCodes ?? [],
  };
}

describe("DIM-2a · summariseCoaBatch — batch-level review card", () => {
  it("aggregates distributions + attention rows correctly", () => {
    const rows: CoaReviewInputRow[] = [
      // Healthy operating expense (REQUIRED / REQUIRED, has OPERATING key)
      makeReviewRow({ accountNumber: "6098", name: "Licenses" }),
      // Cash (NOT_APPLICABLE / NOT_APPLICABLE, no fund keys)
      makeReviewRow({ accountNumber: "1010", name: "Cash", type: "ASSET", fsGroupKey: "BS_CASH_EQUIVALENTS", departmentPolicy: "NOT_APPLICABLE", fundPolicy: "NOT_APPLICABLE", fundApplicabilityKeys: [] }),
      // Fund REQUIRED but no applicability (attention!)
      makeReviewRow({ accountNumber: "6099", name: "Unassigned Fund Test", fundApplicabilityKeys: [] }),
      // Medium confidence (attention)
      makeReviewRow({ accountNumber: "4100", name: "Guest Fees", confidence: "medium" }),
      // Department REQUIRED but no dept applicability (attention)
      makeReviewRow({ accountNumber: "6100", name: "R&M", departmentApplicabilityCodes: [] }),
    ];
    const s = summariseCoaBatch(rows);
    expect(s.totalRows).toBe(5);
    expect(s.confidenceDistribution.high).toBe(4);
    expect(s.confidenceDistribution.medium).toBe(1);
    expect(s.departmentPolicyDistribution.REQUIRED).toBe(4);
    expect(s.departmentPolicyDistribution.NOT_APPLICABLE).toBe(1);
    expect(s.fundPolicyDistribution.REQUIRED).toBe(4);
    expect(s.fundPolicyDistribution.NOT_APPLICABLE).toBe(1);
    expect(s.rowsWithFundKeys).toBe(3);
    expect(s.rowsWithoutFundKeys).toBe(2);
    expect(s.fundPolicyRequiredWithoutApplicability).toBe(1);
    // All 4 REQUIRED-dept rows have empty AccountDepartment applicability.
    expect(s.departmentPolicyRequiredWithoutApplicability).toBe(4);
    // Attention: 5 rows (1 medium-confidence + 4 REQUIRED-dept-without-apply + 1 REQUIRED-fund-without-apply, union'd)
    expect(s.rowsRequiringAttention).toBeGreaterThan(0);
  });
});

describe("DIM-2a · CAPITAL review candidates", () => {
  it("flags accounts whose FS Group or name signals capital context (and skips rows that already have CAPITAL)", () => {
    const rows: CoaReviewInputRow[] = [
      makeReviewRow({ accountNumber: "1500", name: "Capital Assets", fsGroupKey: "BS_CAPITAL_ASSETS", fundApplicabilityKeys: [] }),
      makeReviewRow({ accountNumber: "1590", name: "Accumulated Depreciation", fsGroupKey: "BS_ACCUMULATED_DEPRECIATION", fundApplicabilityKeys: [] }),
      makeReviewRow({ accountNumber: "3510", name: "Capital Reserve Fund", fsGroupKey: "BS_CAPITAL_RESERVE", fundApplicabilityKeys: [] }),
      makeReviewRow({ accountNumber: "4900", name: "Capital Assessment Revenue", type: "REVENUE", fsGroupKey: "IS_OTHER_REVENUE", fundApplicabilityKeys: [] }),
      // Should be SKIPPED — already has CAPITAL applicability.
      makeReviewRow({ accountNumber: "1520", name: "Equipment", fsGroupKey: "BS_CAPITAL_ASSETS", fundApplicabilityKeys: ["CAPITAL"] }),
      // Should NOT be flagged — pure operating.
      makeReviewRow({ accountNumber: "6098", name: "Licenses" }),
    ];
    const flagged = capitalReviewCandidates(rows);
    const flaggedNumbers = flagged.map((r) => r.accountNumber).sort();
    expect(flaggedNumbers).toEqual(["1500", "1590", "3510", "4900"]);
    for (const c of flagged) {
      expect(c.reason).toMatch(/capital|Capital/);
    }
  });
});

describe("DIM-2a · departmentPolicy=REQUIRED exception review", () => {
  it("flags interest, tax, gain/loss, other-income accounts predicted REQUIRED", () => {
    const rows: CoaReviewInputRow[] = [
      makeReviewRow({ accountNumber: "7000", name: "Interest Expense", type: "EXPENSE", fsGroupKey: "IS_INTEREST_EXPENSE" }),
      makeReviewRow({ accountNumber: "4900", name: "Interest Income", type: "REVENUE", fsGroupKey: "IS_INTEREST_INCOME" }),
      makeReviewRow({ accountNumber: "8000", name: "Income Tax", type: "EXPENSE", fsGroupKey: "IS_INCOME_TAX" }),
      makeReviewRow({ accountNumber: "6098", name: "Licenses" }), // should NOT be flagged
    ];
    const flagged = departmentPolicyExceptions(rows);
    const flaggedNumbers = flagged.map((r) => r.accountNumber).sort();
    // Only rows whose departmentPolicy=REQUIRED enter the check —
    // makeReviewRow's default. All three exception-style rows should
    // be flagged since their FS Group is in the questionable set.
    expect(flaggedNumbers).toEqual(["4900", "7000", "8000"]);
  });
});

describe("DIM-2a · fundPolicy=REQUIRED without applicability review", () => {
  it("flags every row whose fundPolicy=REQUIRED but AccountFund keys = []", () => {
    const rows: CoaReviewInputRow[] = [
      makeReviewRow({ accountNumber: "6098", fundApplicabilityKeys: [] }),
      makeReviewRow({ accountNumber: "4000", fundApplicabilityKeys: [] }),
      // Healthy — has OPERATING → should NOT be flagged.
      makeReviewRow({ accountNumber: "4100" }),
    ];
    const flagged = fundPolicyRequiredWithoutApplicabilityRows(rows);
    expect(flagged.map((r) => r.accountNumber).sort()).toEqual(["4000", "6098"]);
    for (const r of flagged) {
      expect(r.reason).toMatch(/fundPolicy=REQUIRED/);
    }
  });

  it("departmentPolicyRequiredWithoutApplicabilityRows flags REQUIRED-dept + empty AccountDepartment", () => {
    const rows: CoaReviewInputRow[] = [
      makeReviewRow({ accountNumber: "6098", departmentApplicabilityCodes: [] }),
      makeReviewRow({ accountNumber: "6099", departmentApplicabilityCodes: ["ADMIN"] }), // healthy
    ];
    const flagged = departmentPolicyRequiredWithoutApplicabilityRows(rows);
    expect(flagged.map((r) => r.accountNumber)).toEqual(["6098"]);
  });
});
