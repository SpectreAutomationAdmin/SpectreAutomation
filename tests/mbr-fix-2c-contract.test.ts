// MBR-FIX-2C (2026-10-10) — unify NOI Before Depreciation across
// every reporting consumer that reads it from
// `IncomeStatementProjection`.
//
// Account-level root cause (reconciled on Coulee Feb 2026):
//   NOI (B · fsGroup-aware, ratio-registry style) = $2,537,302.82
//   NOI (A · account-number ranges, pre-fix projection) = $2,445,166.63
//   Δ = $92,136.19 = exactly two accounts:
//     • 6115 "Depreciation"      $77,815.35 — fsGroup=IS_DEPRECIATION,
//                                             but 6115 falls in the
//                                             6000-6499 operating-
//                                             expense range (not the
//                                             hardcoded 6500-6599
//                                             depreciation range).
//     • 6083 "Interest Expense" $14,320.84 — fsGroup=IS_INTEREST_EXPENSE,
//                                             no financing bucket
//                                             existed, so it landed
//                                             in operating-expense.
//
// Contract pins:
//   §A  Prisma lookup fetches `fsGroup.key` per TB account
//   §B  `IS_DEPRECIATION`-tagged accounts promoted to the
//       `depreciation` bucket regardless of account number
//   §C  `IS_INTEREST_EXPENSE`-tagged accounts tally the new
//       `financing` sidecar on `IncomeStatementBucketTotals`
//   §D  NOI formula carves financing + depreciation out:
//         noiBeforeDepreciation = totalOpRev − payroll − opex + financing
//         noi                   = noiBeforeDepreciation − depreciation
//   §E  `financing` field present in bucket totals shape (back-compat
//       for consumers)
//   §F  Lookup failure degrades gracefully (try/catch around Prisma)

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO       = path.resolve(__dirname, "..");
const PROJECTION = path.join(REPO, "src/lib/reporting/ledger/projections/income-statement-projection.ts");

describe("MBR-FIX-2C §A — Prisma lookup for fsGroupKey", () => {
  const src = readFileSync(PROJECTION, "utf8");

  it("imports prisma from @/lib/prisma", () => {
    expect(src).toMatch(/import \{ prisma \} from "@\/lib\/prisma";/);
  });

  it("batched lookup over currentLinesByCode keys", () => {
    expect(src).toMatch(/const accountCodes = Array\.from\(currentLinesByCode\.keys\(\)\);/);
    expect(src).toMatch(/prisma\.account\.findMany\(\{/);
    expect(src).toMatch(/accountNumber: \{ in: accountCodes \}/);
    expect(src).toMatch(/fsGroup: \{ select: \{ key: true \} \}/);
    // MBR-FIX-2C — fundApplicability must also come through so
    // capital-fund promotion fires on Jonas-imported snapshots.
    expect(src).toMatch(/fundApplicability: true/);
  });

  it("results projected into per-account Maps for fsGroupKey + fundApplicability", () => {
    expect(src).toMatch(/const fsGroupKeyByCode = new Map<string, string \| null>\(\);/);
    expect(src).toMatch(/const fundApplicabilityByCode = new Map<string, string \| null>\(\);/);
    expect(src).toMatch(/fsGroupKeyByCode\.set\(r\.accountNumber, r\.fsGroup\?\.key \?\? null\);/);
    expect(src).toMatch(/fundApplicabilityByCode\.set\(r\.accountNumber, r\.fundApplicability \?\? null\);/);
  });

  it("mapper call uses the enriched fundApplicability when available", () => {
    expect(src).toMatch(/const enrichedFundApplicability =\s*fundApplicabilityByCode\.get\(account\.accountCode\) \?\? payloadFundApplicability;/);
    expect(src).toMatch(/accountFundApplicability: enrichedFundApplicability,/);
  });
});

describe("MBR-FIX-2C §B — IS_DEPRECIATION promotion", () => {
  const src = readFileSync(PROJECTION, "utf8");

  it("fsGroupKey IS_DEPRECIATION override forces bucket = depreciation", () => {
    expect(src).toMatch(
      /if \(fsKey === "IS_DEPRECIATION" && effectiveBucket !== "depreciation"[\s\S]+?effectiveBucket = "depreciation";/,
    );
  });

  it("promotion skips capital-income + capital-expense buckets (fund takes precedence)", () => {
    expect(src).toMatch(/effectiveBucket !== "capital-income" && effectiveBucket !== "capital-expense"/);
  });
});

describe("MBR-FIX-2C §C — IS_INTEREST_EXPENSE financing sidecar", () => {
  const src = readFileSync(PROJECTION, "utf8");

  it("buckets.financing increments when fsKey matches IS_INTEREST_EXPENSE", () => {
    expect(src).toMatch(
      /if \(fsKey === "IS_INTEREST_EXPENSE"\s*&& \(effectiveBucket === "operating-expense" \|\| effectiveBucket === "payroll"\)\) \{\s*buckets\.financing \+= amount;\s*\}/,
    );
  });
});

describe("MBR-FIX-2C §D — NOI formula carves out depreciation + financing", () => {
  const src = readFileSync(PROJECTION, "utf8");

  it("noiBeforeDepreciation = totalOpRev − payroll − opex + financing", () => {
    expect(src).toMatch(
      /buckets\.noiBeforeDepreciation =\s*buckets\.totalOperatingRevenue\s*-\s*buckets\.payroll\s*-\s*buckets\.operatingExpense\s*\+\s*buckets\.financing;/,
    );
  });

  it("noi = noiBeforeDepreciation − depreciation (preserves identity)", () => {
    expect(src).toMatch(/buckets\.noi = buckets\.noiBeforeDepreciation - buckets\.depreciation;/);
  });

  it("the pre-fix formula is gone", () => {
    // Pre-fix: `totalOperatingRevenue - (payroll + operatingExpense)`
    // Must not come back.
    expect(src).not.toMatch(
      /buckets\.noiBeforeDepreciation =\s*buckets\.totalOperatingRevenue - \(buckets\.payroll \+ buckets\.operatingExpense\);/,
    );
  });
});

describe("MBR-FIX-2C §E — financing field present on bucket shape", () => {
  const src = readFileSync(PROJECTION, "utf8");

  it("IncomeStatementBucketTotals carries `financing: number`", () => {
    expect(src).toMatch(/financing: number;/);
  });

  it("buckets init sets financing: 0", () => {
    expect(src).toMatch(/financing: 0,/);
  });
});

describe("MBR-FIX-2C §F — graceful degradation when Prisma unavailable", () => {
  const src = readFileSync(PROJECTION, "utf8");

  it("Prisma lookup is wrapped in try / catch", () => {
    const idx = src.indexOf("const accountCodes = Array.from(currentLinesByCode.keys());");
    expect(idx).toBeGreaterThan(0);
    const block = src.slice(idx, idx + 1500);
    expect(block).toMatch(/try \{[\s\S]+?prisma\.account\.findMany\(/);
    expect(block).toMatch(/\} catch \{[\s\S]+?Enrichment unavailable/);
  });
});
