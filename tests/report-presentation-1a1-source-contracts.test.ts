// REPORT-PRESENTATION-1A.1 (2026-10-05) — Interest Expense / NOI
// semantic change pins + canonical NOI reconciliation.
//
// Invariants:
//   1. FINANCING_AND_OTHER category + FINANCING section exist in the
//      presentation registry; IS_INTEREST_EXPENSE maps to it.
//   2. FS Group projection carves IS_INTEREST_EXPENSE into a dedicated
//      `financing` partition; operatingExpense (NOI denominator)
//      excludes it; totals.financing surfaces separately.
//   3. ratio-registry's NOI calculation also excludes financing — one
//      canonical definition across Section II / III / IV.
//   4. budget-resolver's monthlyOpex + opex both exclude financing;
//      new monthlyFinancing / financing fields surface it separately.
//   5. operating-results' trend chart NOI excludes financing.
//   6. Statement builder emits a Financing & Other section + a
//      "Net Result Before Capital Fund" row between NOI-after-dep and
//      the Capital Fund divider.
//   7. monthly-package overrides Section III stewardship summary
//      cards' NOI + Revenue with the canonical FS-Group projection
//      totals so Section III matches Section IV to the penny.

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  PRESENTATION_CATEGORIES,
  classifyFsGroupPresentation,
  presentationCategoryFor,
  AMBIGUITIES_DOCUMENTED,
} from "../src/lib/reporting/fs-group-presentation-categories";

const REPO = path.resolve(__dirname, "..");
const CATEGORIES = path.join(REPO, "src/lib/reporting/fs-group-presentation-categories.ts");
const PROJECTION = path.join(REPO, "src/lib/reporting/fs-group-projection.ts");
const STATEMENT = path.join(REPO, "src/lib/reporting/statement-of-activities.ts");
const RATIO = path.join(REPO, "src/lib/reporting/ratio-registry.ts");
const BUDGET = path.join(REPO, "src/lib/reporting/budget-resolver.ts");
const OPRES = path.join(REPO, "src/lib/reporting/operating-results.ts");
const MONTHLY = path.join(REPO, "src/lib/reporting/monthly-package.ts");

describe("REPORT-PRESENTATION-1A.1 §1 — presentation registry carries Financing & Other", () => {
  it("FINANCING_AND_OTHER category exists with section=FINANCING", () => {
    const fin = PRESENTATION_CATEGORIES.find((c) => c.key === "FINANCING_AND_OTHER");
    expect(fin).toBeDefined();
    expect(fin!.section).toBe("FINANCING");
    expect(fin!.displayName).toBe("Financing & Other");
  });

  it("IS_INTEREST_EXPENSE classifies to FINANCING_AND_OTHER (not OPERATING_AND_ADMIN)", () => {
    expect(classifyFsGroupPresentation({ fsGroupKey: "IS_INTEREST_EXPENSE", section: "OPERATING_EXPENSE" }))
      .toBe("FINANCING_AND_OTHER");
  });

  it("documented ambiguity for IS_INTEREST_EXPENSE now points to FINANCING_AND_OTHER", () => {
    const amb = AMBIGUITIES_DOCUMENTED.find((a) => a.fsGroupKey === "IS_INTEREST_EXPENSE");
    expect(amb).toBeDefined();
    expect(amb!.assignedTo).toBe("FINANCING_AND_OTHER");
  });

  it("presentationCategoryFor(FINANCING_AND_OTHER) returns the FINANCING section", () => {
    const c = presentationCategoryFor("FINANCING_AND_OTHER");
    expect(c.section).toBe("FINANCING");
  });
});

describe("REPORT-PRESENTATION-1A.1 §2 — FS Group projection carves IS_INTEREST_EXPENSE out of opex", () => {
  it("projection declares a financing partition + totals.financing", () => {
    const src = readFileSync(PROJECTION, "utf8");
    expect(src).toMatch(/financing: FsGroupProjectionRow\[\]/);
    expect(src).toMatch(/financing: FsGroupProjectionSectionTotals/);
  });

  it("partitioning loop sends IS_INTEREST_EXPENSE accounts to financingAccts", () => {
    const src = readFileSync(PROJECTION, "utf8");
    expect(src).toMatch(/else if \(a\.fsGroupKey === "IS_INTEREST_EXPENSE"\) financingAccts\.push\(a\)/);
    // And operatingExpenseAccts no longer receives IS_INTEREST_EXPENSE.
  });

  it("findFsGroupRow helper walks the financing partition too", () => {
    const src = readFileSync(PROJECTION, "utf8");
    expect(src).toMatch(/\.\.\.projection\.financing/);
  });
});

describe("REPORT-PRESENTATION-1A.1 §3 — ratio-registry NOI excludes financing", () => {
  it("ratio-registry declares a financing accumulator", () => {
    const src = readFileSync(RATIO, "utf8");
    expect(src).toMatch(/let financing = ZERO/);
    expect(src).toMatch(/const isFinancing = b\.fsGroupKey === "IS_INTEREST_EXPENSE"/);
    expect(src).toMatch(/else if \(isFinancing\) financing = financing\.plus\(b\.naturalBalance\)/);
  });

  it("NOI formula remains Revenue − COGS − OpEx (opex now excludes financing)", () => {
    const src = readFileSync(RATIO, "utf8");
    expect(src).toMatch(/const noi = revenue\.minus\(cogs\)\.minus\(opex\)/);
  });
});

describe("REPORT-PRESENTATION-1A.1 §4 — budget-resolver carves financing out", () => {
  it("resolveBudgetMonthlyIncomeStatement returns monthlyFinancing + monthlyOpex excludes it", () => {
    const src = readFileSync(BUDGET, "utf8");
    expect(src).toMatch(/monthlyFinancing: number\[\]/);
    expect(src).toMatch(/else if \(key === "IS_INTEREST_EXPENSE"\) financing\[m\] \+= v/);
  });

  it("resolveBudgetIncomeStatement returns `financing` + `opex` excludes it", () => {
    const src = readFileSync(BUDGET, "utf8");
    expect(src).toMatch(/financing: number;/);
    expect(src).toMatch(/else if \(key === "IS_INTEREST_EXPENSE"\) financing \+= ytd/);
    // Budget NOI formula unchanged — opex sum now naturally excludes financing.
    expect(src).toMatch(/const displayNoi = displayRevenue - cogs - opex;/);
  });
});

describe("REPORT-PRESENTATION-1A.1 §5 — operating-results trend chart excludes financing", () => {
  it("operating-results carves IS_INTEREST_EXPENSE out of the trend NOI calc", () => {
    const src = readFileSync(OPRES, "utf8");
    expect(src).toMatch(/const isFinancing = b\.fsGroupKey === "IS_INTEREST_EXPENSE"/);
    expect(src).toMatch(/if \(isFinancing\) continue/);
  });
});

describe("REPORT-PRESENTATION-1A.1 §6 — Statement builder emits Financing & Other + Net Result Before Capital Fund", () => {
  it("builder emits a Financing section band when projection.financing has rows", () => {
    const src = readFileSync(STATEMENT, "utf8");
    const body = src.match(/export function buildStatementOfActivitiesFromFsGroupProjection[\s\S]*?function buildFsGroupRow/)?.[0] ?? "";
    expect(body).toMatch(/if \(projection\.financing\.length > 0\)/);
    expect(body).toMatch(/label: "Financing & Other"/);
    expect(body).toMatch(/emitByCategory\(\{[\s\S]*?groups: projection\.financing/);
  });

  it("Net Result Before Capital Fund row emitted after Financing section", () => {
    const src = readFileSync(STATEMENT, "utf8");
    const body = src.match(/export function buildStatementOfActivitiesFromFsGroupProjection[\s\S]*?function buildFsGroupRow/)?.[0] ?? "";
    expect(body).toMatch(/key: "net-before-capital"/);
    expect(body).toMatch(/label: "Net Result Before Capital Fund"/);
    // Formula: NOI After Dep − Financing.
    expect(body).toMatch(/noiAfterYtdActual - finTotal\.ytdActual/);
  });

  it("Net Combined row factors Net Result Before Capital Fund + Capital Net (not NOI After Dep + Capital Net)", () => {
    const src = readFileSync(STATEMENT, "utf8");
    const body = src.match(/export function buildStatementOfActivitiesFromFsGroupProjection[\s\S]*?function buildFsGroupRow/)?.[0] ?? "";
    expect(body).toMatch(/netBeforeCapitalYtdActual = noiAfterYtdActual - finTotal\.ytdActual/);
  });
});

describe("REPORT-PRESENTATION-1A.1 §7 — Section III stewardship override reads the canonical projection", () => {
  it("monthly-package resolves the FS-Group projection ONCE and reuses it for Section III override", () => {
    const src = readFileSync(MONTHLY, "utf8");
    // Projection resolved before Section III object is built.
    expect(src).toMatch(/const fsGroupProjection = hasRealData\s*\?\s*await resolveFsGroupProjection/);
    // Section III NOI + Revenue summary cards override from fsGroupProjection.
    expect(src).toMatch(/noiBeforeDep:\s*\{[\s\S]*?fsGroupProjection\.totals\.noiBeforeDep\.ytdActual/);
    expect(src).toMatch(/revenue:\s*\{[\s\S]*?fsGroupProjection\.totals\.operatingRevenue\.ytdActual/);
  });

  it("override gated on fsGroupProjection truthy (demo tenants keep seed values)", () => {
    const src = readFileSync(MONTHLY, "utf8");
    expect(src).toMatch(/summaryCards: fsGroupProjection\s*\?\s*\{/);
    expect(src).toMatch(/: stewardshipBundle\.summaryCards,/);
  });
});

describe("REPORT-PRESENTATION-1A.1 — no accounting mutation", () => {
  it("no changed file writes to prisma", () => {
    for (const f of [CATEGORIES, PROJECTION, STATEMENT, RATIO, BUDGET, OPRES]) {
      const src = readFileSync(f, "utf8");
      expect(src, `${path.basename(f)} must not call prisma writes`)
        .not.toMatch(/prisma\.\w+\.(create|update|upsert|delete|createMany|updateMany|deleteMany)/);
    }
  });
});
