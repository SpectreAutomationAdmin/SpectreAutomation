// Founder rule 2026-07-13 v15.15 — Chart-of-Accounts classification
// enrichment for the Balance Sheet projection.
//
// Root cause the v15.14 slice left open: the Statement of
// Financial Position aggregates by `fsGroupKey`, but the
// projection never populated it — so every live BS line rendered
// as unmapped even when the Chart of Accounts held a valid
// `Account.fsGroupId`.
//
// v15.15 closes the gap:
//   1. `LedgerAccount` optionally carries the ChartAccount
//      classification (accountId, accountType, categoryKey,
//      fsGroupKey, fsGroupName, fsGroupSortOrder).
//   2. `BalanceSheetProjection.getBalanceSheetSnapshot()` runs
//      the shared classification resolver over its projected lines
//      via one bounded Prisma query — no N+1 access.
//   3. `getStatementOfFinancialPositionForClub()` also enriches
//      legacy snapshots at read time so unpublished previews
//      always reflect the current CoA.
//
// Point-in-time integrity — published packages freeze the built
// Statement of Financial Position into
// `MonthlyPackage.packagePayloadJson`, so a later CoA edit CANNOT
// change historical archives. That contract is exercised in
// `monthly-package-archive.test.ts` / `monthly-package-lifecycle.test.ts`
// and reaffirmed by the source-contract assertions below.

import { describe, it, expect } from "vitest";

import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// 1) Source-contract: LedgerAccount now carries the CoA classification.
// ---------------------------------------------------------------------------
describe("v15.15 LedgerAccount contract carries CoA classification fields", () => {
  const contracts = fs.readFileSync(
    path.resolve(process.cwd(), "src/lib/reporting/ledger/contracts.ts"),
    "utf8",
  );
  it("adds optional accountId + accountType + categoryKey + fsGroupKey to LedgerAccount", () => {
    const block = contracts.match(/export type LedgerAccount = \{[\s\S]+?\n\};/);
    expect(block).toBeTruthy();
    const body = block![0];
    expect(body).toMatch(/accountId\?:\s*string/);
    expect(body).toMatch(/accountType\?:\s*string/);
    expect(body).toMatch(/categoryKey\?:\s*string/);
    expect(body).toMatch(/fsGroupKey\?:\s*string/);
    expect(body).toMatch(/fsGroupName\?:\s*string/);
    expect(body).toMatch(/fsGroupSortOrder\?:\s*number/);
  });
  it("all classification fields remain OPTIONAL for backward compat with pre-v15.15 snapshots", () => {
    const block = contracts.match(/export type LedgerAccount = \{[\s\S]+?\n\};/);
    const body = block![0];
    // Every new classification field carries the `?:` optional marker.
    for (const name of [
      "accountId",
      "accountType",
      "categoryKey",
      "categoryName",
      "categorySortOrder",
      "fsGroupKey",
      "fsGroupName",
      "fsGroupSortOrder",
    ]) {
      expect(body).toMatch(new RegExp(`${name}\\?:`));
    }
  });
});

// ---------------------------------------------------------------------------
// 2) Source-contract: the shared resolver runs ONE bounded Prisma query.
// ---------------------------------------------------------------------------
describe("v15.15 classification-resolver uses one bounded Prisma query — no N+1", () => {
  const resolver = fs.readFileSync(
    path.resolve(
      process.cwd(),
      "src/lib/reporting/ledger/classification-resolver.ts",
    ),
    "utf8",
  );
  it("uses a single prisma.account.findMany with accountNumber IN clause", () => {
    // Exactly one findMany, not one per account.
    const findManyCalls = resolver.match(/prisma\.account\.findMany\(/g) ?? [];
    expect(findManyCalls.length).toBe(1);
    expect(resolver).toMatch(/accountNumber:\s*\{\s*in:/);
  });
  it("joins Account -> AccountCategory + FinancialStatementGroup in the same query", () => {
    expect(resolver).toMatch(/category:\s*\{\s*select:/);
    expect(resolver).toMatch(/fsGroup:\s*\{\s*select:/);
    // Category select must carry key + name + sortOrder for
    // point-in-time snapshot fidelity.
    expect(resolver).toMatch(/key:\s*true[\s\S]+?name:\s*true[\s\S]+?sortOrder:\s*true/);
  });
  it("returns null (not empty) fsGroupKey / categoryKey when the account has no assignment — genuinely unmapped accounts must be surfaced separately", () => {
    expect(resolver).toMatch(/fsGroupKey:\s*account\.fsGroup\?\.key \?\? null/);
    expect(resolver).toMatch(/categoryKey:\s*account\.category\?\.key \?\? null/);
  });
  it("documents the blank-fundApplicability rule for balance-sheet accounts", () => {
    // Founder rule: blank fund on a balance-sheet account is
    // EXPECTED and MUST NOT flag it as unmapped. This is a
    // structural contract, not a code guard — asserting the
    // comment survives so a future reader understands the rule.
    expect(resolver).toMatch(/Blank[\s\S]{0,80}balance-sheet[\s\S]{0,80}NOT[\s\S]{0,80}unmapped/i);
  });
});

// ---------------------------------------------------------------------------
// 3) Source-contract: BalanceSheetProjection enriches lines after building.
// ---------------------------------------------------------------------------
describe("v15.15 BalanceSheetProjection populates fsGroupKey / fsGroupName / fsGroupSortOrder", () => {
  const projection = fs.readFileSync(
    path.resolve(
      process.cwd(),
      "src/lib/reporting/ledger/projections/balance-sheet-projection.ts",
    ),
    "utf8",
  );
  it("imports the shared resolver + section derivation helper + enrichment type", () => {
    expect(projection).toMatch(
      /import \{[\s\S]+?resolveBalanceSheetLineClassifications[\s\S]+?type BalanceSheetLineClassification[\s\S]+?\} from "@\/lib\/reporting\/ledger\/classification-resolver"/,
    );
    // v15.16 — projection now also imports the CoA-driven section
    // classifier so it can override BalanceSheetCategory from CoA
    // fields rather than account-number ranges.
    expect(projection).toMatch(/deriveBalanceSheetCategoryFromCoa/);
  });
  it("calls the resolver ONCE with the TB accountCodes (v15.16 — resolver runs before line construction)", () => {
    // Exactly one resolver call in the projection body — not per line.
    const calls = projection.match(/resolveBalanceSheetLineClassifications\(/g) ?? [];
    expect(calls.length).toBe(1);
    // v15.16 — the resolver's input is now `tb.lines.map(...)`
    // (every TB line, not just the balance-sheet ones), because
    // the section derivation happens inside the classification loop.
    expect(projection).toMatch(
      /accountCodes:\s*tb\.lines\.map\(\(l\) => l\.accountCode\)/,
    );
    // Enrichment loop populates each line via `enrichBalanceSheetLine`.
    expect(projection).toMatch(/bsLines\[i\] = enrichBalanceSheetLine\(line, c\)/);
  });
  it("`enrichBalanceSheetLine` is idempotent — snapshot-carried classification takes precedence over resolver `null` values", () => {
    expect(projection).toMatch(/fsGroupKey:\s*c\.fsGroupKey \?\? line\.fsGroupKey/);
    expect(projection).toMatch(/fsGroupName:\s*c\.fsGroupName \?\? line\.fsGroupName/);
    expect(projection).toMatch(/fsGroupSortOrder:\s*c\.fsGroupSortOrder \?\? line\.fsGroupSortOrder/);
  });
  it("synthetic YTD-net-income line ships with the canonical BS_CURRENT_YEAR_EARNINGS FS group (v15.17 label)", () => {
    // A live-imported TB that carries revenue + expense accounts
    // produces a synthetic YTD net income line. That line has no
    // ChartAccount record, so the projection must supply its FS
    // Group inline. v15.17 renamed the display label to the
    // founder-approved "Current-Year Earnings to Date" (or
    // "Current-Year Deficit to Date" for negative amounts).
    expect(projection).toMatch(/fsGroupKey:\s*"BS_CURRENT_YEAR_EARNINGS"/);
    expect(projection).toMatch(/"Current-Year Earnings to Date"/);
    expect(projection).toMatch(/"Current-Year Deficit to Date"/);
  });
  it("`buildBalanceSheetLine` copies importer-enriched classification forward when the LedgerAccount carries it", () => {
    // If a future Jonas importer populates LedgerAccount.fsGroupKey
    // at capture time, the projection MUST forward those values to
    // BalanceSheetLine so the snapshot is self-describing without
    // requiring a resolver lookup at read time.
    expect(projection).toMatch(/fsGroupKey:\s*account\.fsGroupKey/);
    expect(projection).toMatch(/fsGroupName:\s*account\.fsGroupName/);
    expect(projection).toMatch(/fsGroupSortOrder:\s*account\.fsGroupSortOrder/);
  });
});

// ---------------------------------------------------------------------------
// 4) Source-contract: SOFP entry enriches at read time so legacy snapshots
//    render correctly under v15.14's FS-Group aggregation.
// ---------------------------------------------------------------------------
describe("v15.15 SOFP entry enriches legacy snapshots at read time", () => {
  const sofp = fs.readFileSync(
    path.resolve(
      process.cwd(),
      "src/lib/reporting/statement-of-financial-position.ts",
    ),
    "utf8",
  );
  it("imports the shared resolver + CoA section derivation helper", () => {
    expect(sofp).toMatch(
      /import \{[\s\S]+?deriveBalanceSheetCategoryFromCoa[\s\S]+?resolveBalanceSheetLineClassifications[\s\S]+?\} from "@\/lib\/reporting\/ledger\/classification-resolver"/,
    );
  });
  it("v15.16 — always re-derives `line.category` from CoA so legacy snapshots' range-based misclassification is corrected at read time", () => {
    // The founder's $26.6M defect: pre-v15.16 legacy snapshots have
    // `line.category` set via account-number range mapping, which
    // misclassifies live PP&E as `current-asset`. The read-time
    // enrichment must ALWAYS re-derive category from CoA — no
    // "fast-path skip" — otherwise the mis-sectioned lines survive.
    expect(sofp).toMatch(/derivedCategory = deriveBalanceSheetCategoryFromCoa/);
    expect(sofp).toMatch(/category:\s*derivedCategory\s*\?\?\s*line\.category/);
  });
  it("existing fsGroupKey on the line takes precedence over CoA fsGroupKey (idempotent read-time merge for already-classified lines)", () => {
    // v15.17 — the read-time merge uses safe-navigation (`c?.fsGroupKey`)
    // so lines with no CoA match still preserve their existing
    // classification. Existing fsGroupKey still wins.
    expect(sofp).toMatch(/fsGroupKey:\s*line\.fsGroupKey\s*\?\?\s*c\?\.fsGroupKey/);
  });
  it("resolves classification for BOTH current + prior-year snapshots so comparative aggregation aligns via fsGroupKey", () => {
    // Founder rule: comparative-period balances must align to the
    // same FS Group as the current period. That requires BOTH
    // snapshots to be enriched from the same CoA state.
    expect(sofp).toMatch(/enrichedCurrent = await enrichSnapshotWithLiveCoa/);
    expect(sofp).toMatch(/enrichedPrior = priorYear[\s\S]{0,120}enrichSnapshotWithLiveCoa/);
  });
  it("documents the point-in-time contract inline so future readers understand why archives are safe", () => {
    expect(sofp).toMatch(/point-in-time contract/i);
    expect(sofp).toMatch(/enrichment never runs against an\s*\/\/ archived payload/i);
  });
});

// ---------------------------------------------------------------------------
// 5) Source-contract: point-in-time integrity via packagePayloadJson freeze.
//    The publish path continues to pass viewerCanDrillDown: false so no
//    frozen archive carries account-level data. Read-time enrichment
//    NEVER runs against a stored packagePayloadJson.
// ---------------------------------------------------------------------------
describe("v15.15 point-in-time integrity — published packages freeze the summarised SOFP", () => {
  const lifecycle = fs.readFileSync(
    path.resolve(
      process.cwd(),
      "src/lib/reporting/monthly-package-lifecycle.ts",
    ),
    "utf8",
  );
  it("publish path serialises the built package into packagePayloadJson (freeze happens BEFORE any future CoA edit)", () => {
    expect(lifecycle).toMatch(/packagePayloadJson:\s*JSON\.stringify\(packagePayload\)/);
  });
  it("publish path uses viewerCanDrillDown: false so archives never carry account arrays", () => {
    expect(lifecycle).toMatch(/viewerCanDrillDown:\s*false/);
  });
  it("archived Board view reads directly from the frozen packagePayloadJson — the SOFP builder is NOT re-invoked", () => {
    // Guard: `getBoardPackageView` must not call
    // `getStatementOfFinancialPositionForClub` (which would
    // re-derive classifications from the CURRENT CoA). Instead
    // it should parse the frozen payload out of packagePayloadJson.
    expect(lifecycle).toMatch(/packagePayloadJson: true/);
    expect(lifecycle).toMatch(/safeParse\(row\.packagePayloadJson\)/);
    // The board view function body must NOT contain
    // `getStatementOfFinancialPositionForClub`.
    const boardBlock = lifecycle.match(
      /export async function getBoardPackageView\([\s\S]+?\n\}/,
    );
    expect(boardBlock).toBeTruthy();
    expect(boardBlock![0]).not.toMatch(/getStatementOfFinancialPositionForClub/);
  });
});

// ---------------------------------------------------------------------------
// 6) Behavioural test: unmapped detection is FS-Group-based, NOT
//    fund-applicability-based. A balance-sheet account whose
//    Account.fundApplicability is blank MUST NOT be treated as unmapped.
// ---------------------------------------------------------------------------
describe("v15.15 unmapped condition is FS-Group-based, not fund-based", () => {
  const sofp = fs.readFileSync(
    path.resolve(
      process.cwd(),
      "src/lib/reporting/statement-of-financial-position.ts",
    ),
    "utf8",
  );
  it("aggregateByFsGroup routes lines to the unmapped sink ONLY when fsGroupKey or fsGroupName is missing", () => {
    expect(sofp).toMatch(
      /if \(!line\.fsGroupKey \|\| !line\.fsGroupName\) \{\s*[\s\S]{0,200}unmappedSink\.push\(line\)/,
    );
  });
  it("aggregation logic does NOT branch on fundApplicability / fund fields when deciding unmapped", () => {
    // Guard: the unmapped condition must not accidentally include
    // `fund` or `fundApplicability`. Extract the aggregation
    // function body and check.
    const fn = sofp.match(
      /function aggregateByFsGroup\([\s\S]+?\n\}\n/,
    );
    expect(fn).toBeTruthy();
    const body = fn![0];
    expect(body).not.toMatch(/\bfund:\s*[^)]*==?/); // no equality on `fund` inside unmapped check
    expect(body).not.toMatch(/fundApplicability/);
  });
});
