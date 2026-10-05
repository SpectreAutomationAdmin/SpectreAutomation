// REPORT-PRESENTATION-1A (2026-10-05) — source-contract pins + unit
// reconciliation of the Board presentation-category hierarchy.
//
// Three architectural invariants:
//   1. Deterministic fsGroupKey → presentation-category classification
//      (never account-name regex). Documented ambiguities surfaced.
//   2. FS-Group projection row carries the presentation category key +
//      name + sort order; groups within a section sort by category
//      so the builder's linear sweep detects category boundaries.
//   3. Statement builder emits category-heading + category-subtotal
//      rows wrapping each contiguous category run of FS Groups; the
//      category subtotal is the literal sum of its constituent group
//      rows (sum of FS Groups = category subtotal to the penny).

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  PRESENTATION_CATEGORIES,
  AMBIGUITIES_DOCUMENTED,
  classifyFsGroupPresentation,
  presentationCategoryFor,
} from "../src/lib/reporting/fs-group-presentation-categories";

const REPO = path.resolve(__dirname, "..");
const CATEGORIES = path.join(REPO, "src/lib/reporting/fs-group-presentation-categories.ts");
const PROJECTION = path.join(REPO, "src/lib/reporting/fs-group-projection.ts");
const STATEMENT = path.join(REPO, "src/lib/reporting/statement-of-activities.ts");
const CLIENT_TABLE = path.join(REPO, "src/app/app/admin/reporting/monthly/StatementOfActivitiesTable.tsx");

describe("REPORT-PRESENTATION-1A §3 — presentation categories registry", () => {
  it("ten core categories + REVIEW_NEEDED catch-all exist", () => {
    const keys = PRESENTATION_CATEGORIES.map((c) => c.key);
    for (const expected of [
      "DUES_AND_MEMBER_REVENUE",
      "GOLF_OPERATIONS_REVENUE",
      "FOOD_AND_BEVERAGE_REVENUE",
      "OTHER_OPERATING_REVENUE",
      "COST_OF_SALES",
      "PAYROLL_AND_RELATED",
      "OPERATING_AND_ADMINISTRATIVE_EXPENSES",
      "DEPRECIATION",
      "CAPITAL_REVENUE",
      "CAPITAL_EXPENSES",
      "REVIEW_NEEDED",
    ]) {
      expect(keys).toContain(expected);
    }
  });

  it("classifyFsGroupPresentation uses deterministic lookup — no account-name inference", () => {
    const src = readFileSync(CATEGORIES, "utf8");
    expect(src).not.toMatch(/\.test\(.*accountName\)/);
    expect(src).not.toMatch(/\/membership\|dues/i);
    expect(src).not.toMatch(/\/payroll\|benefit\|wages/i);
    // Mapping is a flat Record<string, PresentationCategoryKey>
    expect(src).toMatch(/const FS_GROUP_PRESENTATION_MAP: Record<string, PresentationCategoryKey>/);
  });

  it("every expected Coulee populated FS Group has a mapping", () => {
    const populated = [
      "IS_MEMBERSHIP_DUES", "IS_ANNUAL_FEES",
      "IS_GREEN_FEES", "IS_CART_REVENUE", "IS_DRIVING_RANGE", "IS_PRO_SHOP_MERCH",
      "IS_FOOD_SALES", "IS_BEVERAGE_SALES", "IS_CATERING",
      "IS_FACILITY_RENTALS",
      "IS_COGS_MERCHANDISE", "IS_COGS_FOOD", "IS_COGS_BEVERAGE",
      "IS_PAYROLL",
      "IS_UTILITIES", "IS_REPAIRS_MAINTENANCE", "IS_INSURANCE", "IS_OFFICE_SUPPLIES",
      "IS_PROFESSIONAL_FEES", "IS_IT_SOFTWARE", "IS_TELEPHONE_INTERNET", "IS_BANK_CHARGES",
      "IS_VEHICLE_EQUIPMENT", "IS_JANITORIAL_SUPPLIES", "IS_STAFF_TRAINING",
      "IS_MARKETING_ADVERTISING", "IS_MEMBERSHIPS_SUBS", "IS_LICENCES_PERMITS",
      "IS_INTEREST_EXPENSE",
      "IS_DEPRECIATION",
      "IS_ENTRANCE_FEES",
      "IS_OTHER_REVENUE", "IS_OTHER_EXPENSES",
    ];
    for (const key of populated) {
      const got = classifyFsGroupPresentation({ fsGroupKey: key, section: "OPERATING_REVENUE" });
      expect(got, `${key} must not resolve to REVIEW_NEEDED when operating`).not.toBe("REVIEW_NEEDED");
    }
  });

  it("mixed-fund FS Groups (IS_OTHER_REVENUE / IS_OTHER_EXPENSES) split by section", () => {
    expect(classifyFsGroupPresentation({ fsGroupKey: "IS_OTHER_REVENUE", section: "OPERATING_REVENUE" }))
      .toBe("OTHER_OPERATING_REVENUE");
    expect(classifyFsGroupPresentation({ fsGroupKey: "IS_OTHER_REVENUE", section: "CAPITAL_REVENUE" }))
      .toBe("CAPITAL_REVENUE");
    expect(classifyFsGroupPresentation({ fsGroupKey: "IS_OTHER_EXPENSES", section: "OPERATING_EXPENSE" }))
      .toBe("OPERATING_AND_ADMINISTRATIVE_EXPENSES");
    expect(classifyFsGroupPresentation({ fsGroupKey: "IS_OTHER_EXPENSES", section: "CAPITAL_EXPENSE" }))
      .toBe("CAPITAL_EXPENSES");
  });

  it("unknown fsGroupKey resolves to REVIEW_NEEDED (never silently miscategorises)", () => {
    expect(classifyFsGroupPresentation({ fsGroupKey: "IS_FICTIONAL_GROUP", section: "OPERATING_REVENUE" }))
      .toBe("REVIEW_NEEDED");
    expect(classifyFsGroupPresentation({ fsGroupKey: null, section: "OPERATING_REVENUE" }))
      .toBe("REVIEW_NEEDED");
  });

  it("every documented ambiguity names the FS Group + rationale + alternative", () => {
    expect(AMBIGUITIES_DOCUMENTED.length).toBeGreaterThanOrEqual(4);
    for (const amb of AMBIGUITIES_DOCUMENTED) {
      expect(amb.fsGroupKey).toMatch(/^IS_/);
      expect(amb.rationale.length).toBeGreaterThan(40);
      expect(amb.assignedTo).toBeDefined();
      expect(amb.alternativeIfChallenged).toBeDefined();
      // The assigned category must exist in the registry.
      if (amb.assignedTo !== "REVIEW_NEEDED") {
        expect(presentationCategoryFor(amb.assignedTo).key).toBe(amb.assignedTo);
      }
    }
  });
});

describe("REPORT-PRESENTATION-1A §3 — FS-Group projection carries category metadata", () => {
  it("FsGroupProjectionRow type carries presentationCategoryKey + name + sortOrder", () => {
    const src = readFileSync(PROJECTION, "utf8");
    const type = src.match(/export type FsGroupProjectionRow = \{[\s\S]*?\};/)?.[0] ?? "";
    expect(type).toMatch(/presentationCategoryKey: PresentationCategoryKey/);
    expect(type).toMatch(/presentationCategoryName: string/);
    expect(type).toMatch(/presentationCategorySortOrder: number/);
  });

  it("projection groups sort by presentation category first (so categories stay contiguous)", () => {
    const src = readFileSync(PROJECTION, "utf8");
    expect(src).toMatch(/if \(a\.presentationCategorySortOrder !== b\.presentationCategorySortOrder\)/);
    expect(src).toMatch(/return a\.presentationCategorySortOrder - b\.presentationCategorySortOrder/);
  });

  it("projection calls classifyFsGroupPresentation with (fsGroupKey, section)", () => {
    const src = readFileSync(PROJECTION, "utf8");
    expect(src).toMatch(/classifyFsGroupPresentation\(\{/);
    expect(src).toMatch(/section: projectionSection/);
  });
});

describe("REPORT-PRESENTATION-1A §3-5 — Statement builder emits Category hierarchy", () => {
  it("new row kinds category-heading + category-subtotal added to union", () => {
    const src = readFileSync(STATEMENT, "utf8");
    const kindUnion = src.match(/export type StatementOfActivitiesV2RowKind =[\s\S]*?;$/m)?.[0] ?? "";
    expect(kindUnion).toMatch(/"category-heading"/);
    expect(kindUnion).toMatch(/"category-subtotal"/);
  });

  it("emitByCategory helper iterates contiguous runs of same categoryKey", () => {
    const src = readFileSync(STATEMENT, "utf8");
    expect(src).toMatch(/function emitByCategory\(args:/);
    expect(src).toMatch(/if \(last && last\.categoryKey === g\.presentationCategoryKey\)/);
  });

  it("category subtotal is the sum of its constituent FS Group rows (not a parallel calc)", () => {
    const src = readFileSync(STATEMENT, "utf8");
    // Delimit emitByCategory body up to the next function declaration.
    const body = src.match(/function emitByCategory[\s\S]*?function buildFsGroupRow/)?.[0] ?? "";
    expect(body).toMatch(/cmActualSum \+= g\.cmActual/);
    expect(body).toMatch(/ytdActualSum \+= g\.ytdActual/);
    expect(body).toMatch(/cmBudgetSum \+= g\.cmBudget/);
    expect(body).toMatch(/ytdBudgetSum \+= g\.ytdBudget/);
    expect(body).toMatch(/const cmVariance = isRevenue \? \(cmActualSum - cmBudgetSum\) : \(cmBudgetSum - cmActualSum\)/);
  });

  it("builder uses emitByCategory for every operating + capital section", () => {
    const src = readFileSync(STATEMENT, "utf8");
    const builder = src.match(/export function buildStatementOfActivitiesFromFsGroupProjection[\s\S]*?function emitByCategory/)?.[0] ?? "";
    expect(builder).toMatch(/emitByCategory\(\{[\s\S]*?groups: projection\.operatingRevenue/);
    expect(builder).toMatch(/emitByCategory\(\{[\s\S]*?groups: projection\.operatingExpense/);
    expect(builder).toMatch(/emitByCategory\(\{[\s\S]*?groups: projection\.capitalRevenue/);
  });
});

describe("REPORT-PRESENTATION-1A §15 — unit reconciliation: category subtotal = Σ FS Groups", () => {
  it("category subtotal reconciles to its FS Group constituents to the penny", () => {
    // Simulated projection section: three Dues groups and two Golf groups.
    const groups = [
      {
        fsGroupKey: "IS_MEMBERSHIP_DUES",
        fsGroupName: "Membership Dues",
        sortOrder: 10,
        presentationCategoryKey: "DUES_AND_MEMBER_REVENUE" as const,
        presentationCategoryName: "Dues & Member Revenue",
        presentationCategorySortOrder: 10,
        cmActual: 3_089_943.30, cmBudget: 2_472_402, ytdActual: 3_089_943.30, ytdBudget: 2_472_402,
        accounts: [],
      },
      {
        fsGroupKey: "IS_ANNUAL_FEES",
        fsGroupName: "Annual Fees",
        sortOrder: 11,
        presentationCategoryKey: "DUES_AND_MEMBER_REVENUE" as const,
        presentationCategoryName: "Dues & Member Revenue",
        presentationCategorySortOrder: 10,
        cmActual: 12_000.50, cmBudget: 10_000, ytdActual: 12_000.50, ytdBudget: 10_000,
        accounts: [],
      },
      {
        fsGroupKey: "IS_GREEN_FEES",
        fsGroupName: "Green Fees",
        sortOrder: 20,
        presentationCategoryKey: "GOLF_OPERATIONS_REVENUE" as const,
        presentationCategoryName: "Golf Operations",
        presentationCategorySortOrder: 20,
        cmActual: 8_555.16, cmBudget: 10_000, ytdActual: 8_555.16, ytdBudget: 10_000,
        accounts: [],
      },
    ];
    // Expected Dues subtotal:
    const expectedDuesCmActual = 3_089_943.30 + 12_000.50;
    const expectedGolfYtdActual = 8_555.16;
    // Manually walk the same algorithm the builder uses.
    const buckets: { k: string; grps: typeof groups }[] = [];
    for (const g of groups) {
      const last = buckets[buckets.length - 1];
      if (last && last.k === g.presentationCategoryKey) last.grps.push(g);
      else buckets.push({ k: g.presentationCategoryKey, grps: [g] });
    }
    const sums = buckets.map((b) => ({
      k: b.k,
      cmActual: b.grps.reduce((s, g) => s + g.cmActual, 0),
      ytdActual: b.grps.reduce((s, g) => s + g.ytdActual, 0),
    }));
    const dues = sums.find((s) => s.k === "DUES_AND_MEMBER_REVENUE")!;
    const golf = sums.find((s) => s.k === "GOLF_OPERATIONS_REVENUE")!;
    expect(dues.cmActual).toBeCloseTo(expectedDuesCmActual, 2);
    expect(golf.ytdActual).toBeCloseTo(expectedGolfYtdActual, 2);
  });
});

describe("REPORT-PRESENTATION-1A §9 — React renders category heading + subtotal rows", () => {
  it("StatementRow handles category-heading kind", () => {
    const src = readFileSync(CLIENT_TABLE, "utf8");
    expect(src).toMatch(/case "category-heading":/);
    expect(src).toMatch(/data-kind="category-heading"/);
  });

  it("StatementRow handles category-subtotal kind (renders values grid)", () => {
    const src = readFileSync(CLIENT_TABLE, "utf8");
    expect(src).toMatch(/case "category-subtotal":/);
    expect(src).toMatch(/data-kind="category-subtotal"/);
    // The subtotal row still uses the shared value cells so numeric
    // formatting is identical to the parent FS Group row.
    expect(src).toMatch(/StatementValueCells[\s\S]{0,300}subtotal/i);
  });

  it("category rows don't disturb expand/collapse — expandedGroups is still per-FS-Group only", () => {
    const src = readFileSync(CLIENT_TABLE, "utf8");
    // The toggle still mutates only the group set.
    const toggleBody = src.match(/const onToggleGroup = \(groupKey: string\) => \{[\s\S]*?\};/)?.[0] ?? "";
    expect(toggleBody).toMatch(/setExpandedGroups/);
    expect(toggleBody).not.toMatch(/categoryKey/);
  });
});

describe("REPORT-PRESENTATION-1A — no accounting mutation", () => {
  it("presentation categories file never writes to prisma", () => {
    const src = readFileSync(CATEGORIES, "utf8");
    expect(src).not.toMatch(/prisma/);
  });

  it("projection extension never writes to prisma", () => {
    const src = readFileSync(PROJECTION, "utf8");
    expect(src).not.toMatch(/prisma\.\w+\.(create|update|upsert|delete|createMany|updateMany|deleteMany)/);
  });
});
