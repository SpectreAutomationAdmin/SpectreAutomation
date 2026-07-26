// Spectre intelligent COA auto-mapping engine (founder rule
// 2026-06-29). Unit-tests the pure `predictCoaRow` /
// `predictCoaBatch` helpers — no DB, no React.
//
// The engine's contract:
//   1. Existing-account match → confidence "high", source
//      "existing-account". Inherits the prior decision.
//   2. Name keyword match → confidence "high", source
//      "name-keyword". Picks a specific FS Group.
//   3. Number-range fallback → confidence "medium", source
//      "number-range". Type + default category + "Other ..." FS.
//   4. Nothing matched → confidence "low", source "default".

import { describe, it, expect } from "vitest";
import {
  predictCoaRow,
  predictCoaBatch,
  normalizeAccountNameForPrediction,
  type ExistingAccountSnapshot,
} from "@/lib/imports/coa-predictor";

describe("Engine: existing-account match overrides everything else (the learning path)", () => {
  it("inherits the prior decision when the number matches an existing account on this club", () => {
    const existing = new Map<string, ExistingAccountSnapshot>([
      ["1010", {
        accountNumber: "1010",
        type: "ASSET",
        categoryKey: "CURRENT_ASSETS",
        fsGroupKey: "BS_CASH_EQUIVALENTS",
        defaultDepartmentCode: null,
      }],
    ]);
    const p = predictCoaRow({ number: "1010", name: "Whatever — different name now" }, existing);
    expect(p.confidence).toBe("high");
    expect(p.source).toBe("existing-account");
    expect(p.type).toBe("ASSET");
    expect(p.categoryKey).toBe("CURRENT_ASSETS");
    expect(p.fsGroupKey).toBe("BS_CASH_EQUIVALENTS");
  });

  it("falls back to keyword when the existing account row lacks a category or fs-group", () => {
    const existing = new Map<string, ExistingAccountSnapshot>([
      ["1010", {
        accountNumber: "1010",
        type: "ASSET",
        categoryKey: null,
        fsGroupKey: null,
        defaultDepartmentCode: null,
      }],
    ]);
    const p = predictCoaRow({ number: "1010", name: "Operating Bank Account" }, existing);
    expect(p.source).toBe("name-keyword");
    expect(p.fsGroupKey).toBe("BS_CASH_EQUIVALENTS");
  });
});

describe("Engine: name keyword classification", () => {
  type Case = { name: string; number?: string; fsGroup: string; type: string };
  const CASES: Case[] = [
    // Assets
    { name: "Petty Cash",                    fsGroup: "BS_CASH_EQUIVALENTS",   type: "ASSET" },
    { name: "Operating Bank Account",        fsGroup: "BS_CASH_EQUIVALENTS",   type: "ASSET" },
    { name: "Member Receivable",             fsGroup: "BS_MEMBER_AR",          type: "ASSET" },
    { name: "Accounts Receivable",           fsGroup: "BS_AR",                 type: "ASSET" },
    { name: "F&B Inventory",                 fsGroup: "BS_INVENTORY",          type: "ASSET" },
    { name: "Liquor Inventory",              fsGroup: "BS_INVENTORY",          type: "ASSET" },
    { name: "Prepaid Insurance",             fsGroup: "BS_PREPAID_EXPENSES",   type: "ASSET" },
    { name: "Land",                          fsGroup: "BS_CAPITAL_ASSETS",     type: "ASSET" },
    { name: "Course Improvements",           fsGroup: "BS_CAPITAL_ASSETS",     type: "ASSET" },
    { name: "Construction in Progress",      fsGroup: "BS_CIP",                type: "ASSET" },
    // Liabilities
    { name: "Accounts Payable",              fsGroup: "BS_AP",                 type: "LIABILITY" },
    { name: "Accrued Payroll",               fsGroup: "BS_PAYROLL_LIABILITIES",type: "LIABILITY" },
    { name: "GST Collected",                 fsGroup: "BS_SALES_TAX_PAYABLE",  type: "LIABILITY" },
    { name: "HST Payable",                   fsGroup: "BS_SALES_TAX_PAYABLE",  type: "LIABILITY" },
    { name: "Deferred Revenue",              fsGroup: "BS_DEFERRED_REVENUE",   type: "LIABILITY" },
    { name: "Long-term Debt",                fsGroup: "BS_LONG_TERM_DEBT",     type: "LIABILITY" },
    { name: "Gift Card Liability",           fsGroup: "BS_LONG_TERM_LIABILITIES",type: "LIABILITY" },
    // Equity
    { name: "Member Shares",                 fsGroup: "BS_SHARE_CAPITAL",      type: "EQUITY" },
    { name: "Retained Earnings",             fsGroup: "BS_RETAINED_EARNINGS",  type: "EQUITY" },
    { name: "Capital Reserve",               fsGroup: "BS_CAPITAL_RESERVE",    type: "EQUITY" },
    // Revenue
    { name: "Membership Dues",               fsGroup: "IS_MEMBERSHIP_DUES",    type: "REVENUE" },
    { name: "Initiation Fees",               fsGroup: "IS_ENTRANCE_FEES",      type: "REVENUE" },
    { name: "Capital Assessment",            fsGroup: "IS_CAPITAL_ASSESSMENTS",type: "REVENUE" },
    { name: "Green Fees",                    fsGroup: "IS_GREEN_FEES",         type: "REVENUE" },
    { name: "Cart Revenue",                  fsGroup: "IS_CART_REVENUE",       type: "REVENUE" },
    { name: "Driving Range Revenue",         fsGroup: "IS_DRIVING_RANGE",      type: "REVENUE" },
    { name: "Lesson Revenue",                fsGroup: "IS_GOLF_LESSONS",       type: "REVENUE" },
    { name: "Pro Shop Sales",                fsGroup: "IS_PRO_SHOP_MERCH",     type: "REVENUE" },
    { name: "Food Sales",                    fsGroup: "IS_FOOD_SALES",         type: "REVENUE" },
    { name: "Beverage Sales",                fsGroup: "IS_BEVERAGE_SALES",     type: "REVENUE" },
    { name: "Catering Revenue",              fsGroup: "IS_CATERING",           type: "REVENUE" },
    { name: "Banquet Revenue",               fsGroup: "IS_EVENT_REVENUE",      type: "REVENUE" },
    { name: "Hall Rentals",                  fsGroup: "IS_FACILITY_RENTALS",   type: "REVENUE" },
    { name: "Interest Income",               fsGroup: "IS_INTEREST_INCOME",    type: "REVENUE" },
    // Expenses
    { name: "Salaries & Wages",              fsGroup: "IS_PAYROLL",            type: "EXPENSE" },
    { name: "Employee Benefits",             fsGroup: "IS_PAYROLL",            type: "EXPENSE" },
    { name: "Cost of Food",                  fsGroup: "IS_COGS_FOOD",          type: "EXPENSE" },
    { name: "Cost of Beverage",              fsGroup: "IS_COGS_BEVERAGE",      type: "EXPENSE" },
    { name: "Cost of Merchandise",           fsGroup: "IS_COGS_MERCHANDISE",   type: "EXPENSE" },
    { name: "Hydro",                         fsGroup: "IS_UTILITIES",          type: "EXPENSE" },
    { name: "Natural Gas",                   fsGroup: "IS_UTILITIES",          type: "EXPENSE" },
    { name: "Building Repairs",              fsGroup: "IS_REPAIRS_MAINTENANCE",type: "EXPENSE" },
    { name: "Equipment Maintenance",         fsGroup: "IS_REPAIRS_MAINTENANCE",type: "EXPENSE" },
    { name: "Property Tax",                  fsGroup: "IS_PROPERTY_TAX",       type: "EXPENSE" },
    { name: "Corporate Income Tax",          fsGroup: "IS_INCOME_TAX",         type: "EXPENSE" },
    { name: "Liability Insurance",           fsGroup: "IS_INSURANCE",          type: "EXPENSE" },
    { name: "Office Supplies",               fsGroup: "IS_OFFICE_SUPPLIES",    type: "EXPENSE" },
    { name: "Audit Fees",                    fsGroup: "IS_PROFESSIONAL_FEES",  type: "EXPENSE" },
    { name: "Software Subscription",         fsGroup: "IS_IT_SOFTWARE",        type: "EXPENSE" },
    { name: "Phone & Internet",              fsGroup: "IS_TELEPHONE_INTERNET", type: "EXPENSE" },
    { name: "Bank Charges",                  fsGroup: "IS_BANK_CHARGES",       type: "EXPENSE" },
    { name: "Merchant Processing Fees",      fsGroup: "IS_MERCHANT_FEES",      type: "EXPENSE" },
    { name: "Vehicle Fuel",                  fsGroup: "IS_VEHICLE_EQUIPMENT",  type: "EXPENSE" },
    { name: "Course Supplies",               fsGroup: "IS_SMALL_TOOLS",        type: "EXPENSE" },
    { name: "Janitorial Supplies",           fsGroup: "IS_JANITORIAL_SUPPLIES",type: "EXPENSE" },
    { name: "Outsourced Cleaning Service",   fsGroup: "IS_CLEANING_SERVICES",  type: "EXPENSE" },
    { name: "Security Service",              fsGroup: "IS_SECURITY",           type: "EXPENSE" },
    { name: "Staff Training",                fsGroup: "IS_STAFF_TRAINING",     type: "EXPENSE" },
    { name: "Marketing & Advertising",       fsGroup: "IS_MARKETING_ADVERTISING", type: "EXPENSE" },
    { name: "Travel & Meals",                fsGroup: "IS_TRAVEL_MEALS",       type: "EXPENSE" },
    { name: "Liquor Licence",                fsGroup: "IS_LICENCES_PERMITS",   type: "EXPENSE" },
    { name: "Depreciation Expense",          fsGroup: "IS_DEPRECIATION",       type: "EXPENSE" },
    { name: "Interest Expense",              fsGroup: "IS_INTEREST_EXPENSE",   type: "EXPENSE" },
  ];

  for (const c of CASES) {
    it(`'${c.name}' → ${c.fsGroup} (${c.type}) with high confidence`, () => {
      const p = predictCoaRow({ number: c.number ?? "0", name: c.name });
      expect(p.fsGroupKey).toBe(c.fsGroup);
      expect(p.type).toBe(c.type);
      expect(p.confidence).toBe("high");
      expect(p.source).toBe("name-keyword");
    });
  }
});

describe("Engine: number-range fallback when no keyword matches", () => {
  // Use account names that intentionally don't match any keyword
  // so the predictor falls through to the range rule.
  const CASES = [
    { number: "1599", name: "ZZZ Unknown 1xxx",    type: "ASSET" },
    { number: "2899", name: "ZZZ Unknown 2xxx",    type: "LIABILITY" },
    { number: "3899", name: "ZZZ Unknown 3xxx",    type: "EQUITY" },
    { number: "4899", name: "ZZZ Unknown 4xxx",    type: "REVENUE" },
    { number: "5899", name: "ZZZ Unknown 5xxx",    type: "EXPENSE" },
    { number: "7899", name: "ZZZ Unknown 7xxx",    type: "EXPENSE" },
    { number: "9899", name: "ZZZ Unknown 9xxx",    type: "EXPENSE" },
  ] as const;
  for (const c of CASES) {
    it(`${c.number} '${c.name}' → ${c.type} via number-range (medium confidence)`, () => {
      const p = predictCoaRow({ number: c.number, name: c.name });
      expect(p.type).toBe(c.type);
      expect(p.confidence).toBe("medium");
      expect(p.source).toBe("number-range");
    });
  }
});

describe("Engine: low-confidence fallback when nothing matches", () => {
  it("returns the DEFAULT prediction for a completely unrecognised row", () => {
    const p = predictCoaRow({ number: "", name: "ZZZ Mystery Account" });
    expect(p.confidence).toBe("low");
    expect(p.source).toBe("default");
    expect(p.type).toBe("ASSET");
    expect(p.categoryKey).toBe("OTHER_ASSETS");
    expect(p.fsGroupKey).toBe("BS_OTHER_ASSETS");
  });
});

describe("Engine: every predicted FS Group is a canonical key with a known Category", () => {
  it("every name-keyword prediction yields a canonical FS group + canonical category", async () => {
    const { DEFAULT_FS_GROUPS, DEFAULT_CATEGORIES } = await import("@/lib/accounting/coa-template");
    const fsKeys = new Set(DEFAULT_FS_GROUPS.map((g) => g.key));
    const catKeys = new Set(DEFAULT_CATEGORIES.map((c) => c.key));
    // A representative sample — for every keyword case in the suite,
    // the canonical sets must contain both keys.
    const samples = [
      "Petty Cash", "Member Receivable", "Accounts Payable",
      "Membership Dues", "Salaries & Wages", "Depreciation",
      "Insurance", "Property Tax", "Software Subscription",
    ];
    for (const name of samples) {
      const p = predictCoaRow({ number: "0", name });
      expect(fsKeys.has(p.fsGroupKey)).toBe(true);
      expect(catKeys.has(p.categoryKey)).toBe(true);
    }
  });
});

describe("predictCoaBatch — batch entry point", () => {
  it("preserves input order + count", () => {
    const inputs = [
      { number: "1010", name: "Petty Cash" },
      { number: "2000", name: "Accounts Payable" },
      { number: "4000", name: "Membership Dues" },
    ];
    const out = predictCoaBatch(inputs);
    expect(out).toHaveLength(3);
    expect(out[0].fsGroupKey).toBe("BS_CASH_EQUIVALENTS");
    expect(out[1].fsGroupKey).toBe("BS_AP");
    expect(out[2].fsGroupKey).toBe("IS_MEMBERSHIP_DUES");
  });
});

// ---------------------------------------------------------------------------
// Founder refinement 2026-06-29 — Cash + COS precision
// ---------------------------------------------------------------------------
describe("Cash: every founder-listed cash variant lands on Cash & Cash Equivalents", () => {
  const cases: Array<{ number: string; name: string }> = [
    { number: "1000", name: "Petty Cash" },
    { number: "1001", name: "Bank - General" },
    { number: "1002", name: "General Bank" },
    { number: "1003", name: "Operating Bank Account" },
    { number: "1004", name: "Chequing Account" },
    { number: "1005", name: "Checking Account" },
    { number: "1006", name: "Savings Account" },
    { number: "1007", name: "Cash" },
  ];
  for (const c of cases) {
    it(`${c.number} '${c.name}' → ASSET / CURRENT_ASSETS / BS_CASH_EQUIVALENTS`, () => {
      const p = predictCoaRow(c);
      expect(p.type).toBe("ASSET");
      expect(p.categoryKey).toBe("CURRENT_ASSETS");
      expect(p.fsGroupKey).toBe("BS_CASH_EQUIVALENTS");
      expect(p.source).toBe("name-keyword");
    });
  }
});

describe("Food COS: every founder-listed Food cost-of-sales variant lands on IS_COGS_FOOD", () => {
  const cases = [
    "Cost of Food Sold",
    "Food COS",
    "Food Cost of Sales",
    "Cost of Sales — F&B",
    "Cost of Food",
  ];
  for (const name of cases) {
    it(`'${name}' → EXPENSE / COST_OF_SALES / IS_COGS_FOOD`, () => {
      const p = predictCoaRow({ number: "5000", name });
      expect(p.type).toBe("EXPENSE");
      expect(p.categoryKey).toBe("COST_OF_SALES");
      expect(p.fsGroupKey).toBe("IS_COGS_FOOD");
    });
  }
});

describe("Beverage COS: every founder-listed Beverage / Liquor / Beer / Wine cost-of-sales variant lands on IS_COGS_BEVERAGE", () => {
  const cases = [
    "Cost of Beverages Sold",
    "Cost of Beverage Sold",
    "Beverage COS",
    "Liquor COS",
    "Beer COS",
    "Wine COS",
    "Cost of Liquor",
    "Cost of Beer",
    "Cost of Wine",
    "Beverage Cost of Sales",
    "Liquor Cost",
  ];
  for (const name of cases) {
    it(`'${name}' → EXPENSE / COST_OF_SALES / IS_COGS_BEVERAGE`, () => {
      const p = predictCoaRow({ number: "5100", name });
      expect(p.type).toBe("EXPENSE");
      expect(p.categoryKey).toBe("COST_OF_SALES");
      expect(p.fsGroupKey).toBe("IS_COGS_BEVERAGE");
    });
  }
});

describe("Merchandise COS still works after Food/Beverage rules take precedence", () => {
  const cases = [
    "Pro Shop Cost of Goods Sold",
    "Merchandise COS",
    "Cost of Merchandise Sold",
    "Pro Shop COGS",
    "Merchandise Cost",
  ];
  for (const name of cases) {
    it(`'${name}' → EXPENSE / COST_OF_SALES / IS_COGS_MERCHANDISE`, () => {
      const p = predictCoaRow({ number: "5200", name });
      expect(p.type).toBe("EXPENSE");
      expect(p.categoryKey).toBe("COST_OF_SALES");
      expect(p.fsGroupKey).toBe("IS_COGS_MERCHANDISE");
    });
  }
});

// ---------------------------------------------------------------------------
// Founder refinement 2026-06-29 v2 — account number is the
// STRONGEST predictor. When a number falls in a conventional
// range, the bracket constrains which keyword rules can fire.
// ---------------------------------------------------------------------------
describe("Number bracket overrides off-type keyword (the founder's 1201 / 1200 bug)", () => {
  it("1201 Accts Receivable - Monthly Dues → Asset / Current Assets / Member Receivables (NOT Revenue/Dues)", () => {
    const p = predictCoaRow({ number: "1201", name: "Accts Receivable - Monthly Dues" });
    expect(p.type).toBe("ASSET");
    expect(p.categoryKey).toBe("CURRENT_ASSETS");
    expect(p.fsGroupKey).toBe("BS_MEMBER_AR");
    expect(p.confidence).toBe("high");
  });

  it("1200 Accts Receivable - Members & Assoc → Asset / Current Assets / Member Receivables (NOT Other Assets)", () => {
    const p = predictCoaRow({ number: "1200", name: "Accts Receivable - Members & Assoc" });
    expect(p.type).toBe("ASSET");
    expect(p.categoryKey).toBe("CURRENT_ASSETS");
    expect(p.fsGroupKey).toBe("BS_MEMBER_AR");
    expect(p.confidence).toBe("high");
  });

  it("1010 Operating Bank → Asset / Current Assets / Cash & Cash Equivalents", () => {
    const p = predictCoaRow({ number: "1010", name: "Operating Bank" });
    expect(p.type).toBe("ASSET");
    expect(p.categoryKey).toBe("CURRENT_ASSETS");
    expect(p.fsGroupKey).toBe("BS_CASH_EQUIVALENTS");
    expect(p.confidence).toBe("high");
  });

  it("2009 Accounts Payable → Liability / Current Liabilities / Accounts Payable", () => {
    const p = predictCoaRow({ number: "2009", name: "Accounts Payable" });
    expect(p.type).toBe("LIABILITY");
    expect(p.categoryKey).toBe("CURRENT_LIABILITIES");
    expect(p.fsGroupKey).toBe("BS_AP");
    expect(p.confidence).toBe("high");
  });

  it("4100 Membership Dues → Revenue / Membership Revenue / Membership Dues", () => {
    const p = predictCoaRow({ number: "4100", name: "Membership Dues" });
    expect(p.type).toBe("REVENUE");
    expect(p.categoryKey).toBe("MEMBERSHIP_REVENUE");
    expect(p.fsGroupKey).toBe("IS_MEMBERSHIP_DUES");
    expect(p.confidence).toBe("high");
  });

  it("5200 Cost of Food Sold → Expense / Cost of Sales / Cost of Food Sold", () => {
    const p = predictCoaRow({ number: "5200", name: "Cost of Food Sold" });
    expect(p.type).toBe("EXPENSE");
    expect(p.categoryKey).toBe("COST_OF_SALES");
    expect(p.fsGroupKey).toBe("IS_COGS_FOOD");
    expect(p.confidence).toBe("high");
  });

  it("6100 Payroll → Expense / Payroll & Benefits / Payroll", () => {
    const p = predictCoaRow({ number: "6100", name: "Payroll" });
    expect(p.type).toBe("EXPENSE");
    expect(p.categoryKey).toBe("PAYROLL_BENEFITS");
    expect(p.fsGroupKey).toBe("IS_PAYROLL");
    expect(p.confidence).toBe("high");
  });
});

describe("Abbreviated receivable language is recognized", () => {
  const cases = [
    { name: "Accounts Receivable",  expectFs: "BS_AR" },
    { name: "Accts Receivable",     expectFs: "BS_AR" },
    { name: "Acct Receivable",      expectFs: "BS_AR" },
    { name: "Acct Rec",             expectFs: "BS_AR" },
    { name: "Accts Rec",            expectFs: "BS_AR" },
    { name: "A/R",                  expectFs: "BS_AR" },
    { name: "AR - Trade",           expectFs: "BS_AR" },
    { name: "Trade Receivable",     expectFs: "BS_AR" },
    { name: "Trade Receivables",    expectFs: "BS_AR" },
    { name: "Other Receivable",     expectFs: "BS_AR" },
    { name: "Other Receivables",    expectFs: "BS_AR" },
  ];
  for (const c of cases) {
    it(`'${c.name}' → BS_AR (current-AR bracket)`, () => {
      const p = predictCoaRow({ number: "1100", name: c.name });
      expect(p.type).toBe("ASSET");
      expect(p.fsGroupKey).toBe(c.expectFs);
    });
  }
});

describe("1400-1499 sub-bracket routes AR-family keywords to Long-term Receivables", () => {
  const cases = [
    { number: "1400", name: "Acct Rec - BPG Buying Group Rebate" },
    { number: "1401", name: "Share Financing Receivables" },
    { number: "1410", name: "Long-term Note Receivable" },
    { number: "1420", name: "Accts Receivable - Long-term" },
    { number: "1450", name: "Receivable from Affiliated Club" },
  ];
  for (const c of cases) {
    it(`${c.number} '${c.name}' → Asset / Other Assets / BS_LONG_TERM_RECEIVABLES`, () => {
      const p = predictCoaRow({ number: c.number, name: c.name });
      expect(p.type).toBe("ASSET");
      expect(p.categoryKey).toBe("OTHER_ASSETS");
      expect(p.fsGroupKey).toBe("BS_LONG_TERM_RECEIVABLES");
      expect(p.confidence).toBe("high");
    });
  }

  it("1200-range AR is still BS_MEMBER_AR / BS_AR — not BS_LONG_TERM_RECEIVABLES", () => {
    const p = predictCoaRow({ number: "1200", name: "Accts Receivable - Members & Assoc" });
    expect(p.fsGroupKey).toBe("BS_MEMBER_AR");
  });

  it("1300-range AR stays in BS_AR — the long-term sub-bracket is 1400-1499 ONLY", () => {
    const p = predictCoaRow({ number: "1310", name: "Acct Rec - Refund Pending" });
    expect(p.fsGroupKey).toBe("BS_AR");
  });

  it("1500-range (capital assets) doesn't fire the long-term-receivable remap even if AR words appear", () => {
    // 1500 is in ASSET bracket but outside 1400-1499. AR keyword
    // would route to BS_AR (current-AR default). The point of
    // the test is the remap is bounded to 1400-1499.
    const p = predictCoaRow({ number: "1500", name: "Acct Rec - Stale" });
    expect(p.fsGroupKey).not.toBe("BS_LONG_TERM_RECEIVABLES");
  });
});

describe("Receivable names never fall through to Other Assets when an AR rule could fire", () => {
  it("'Receivables' (no other context) inside 1xxx bracket → BS_AR, not BS_OTHER_ASSETS", () => {
    const p = predictCoaRow({ number: "1180", name: "Receivables" });
    expect(p.fsGroupKey).toBe("BS_AR");
    expect(p.fsGroupKey).not.toBe("BS_OTHER_ASSETS");
  });

  it("'Receivable' singular → BS_AR", () => {
    const p = predictCoaRow({ number: "1180", name: "Receivable" });
    expect(p.fsGroupKey).toBe("BS_AR");
  });
});

describe("Number bracket restrictions — impossible mappings are blocked", () => {
  it("Account 1200 with a Revenue-flavored name STILL predicts Asset (number wins)", () => {
    // Name screams 'Membership Dues' (REVENUE keyword) but the
    // 1xxx bracket blocks that rule from firing. We get either
    // a matching ASSET keyword (Member Receivables — name has
    // 'membership') OR the ASSET bracket default (BS_OTHER_ASSETS).
    const p = predictCoaRow({ number: "1200", name: "Membership Dues Receivable" });
    expect(p.type).toBe("ASSET");
    expect(p.categoryKey).toBe("CURRENT_ASSETS");
  });

  it("Account 2500 with Revenue-flavored name STILL predicts Liability", () => {
    const p = predictCoaRow({ number: "2500", name: "Deferred Membership Revenue" });
    expect(p.type).toBe("LIABILITY");
  });

  it("Account 4000 with Asset-flavored name STILL predicts Revenue", () => {
    const p = predictCoaRow({ number: "4000", name: "Cash from Operations" });
    expect(p.type).toBe("REVENUE");
  });
});

describe("Number-bracket + specific existing-account → existing wins (operator's prior decision survives)", () => {
  it("1201 with specific BS_MEMBER_AR on existing → returns existing-account source", () => {
    const existing = new Map([
      ["1201", {
        accountNumber: "1201",
        type: "ASSET",
        categoryKey: "CURRENT_ASSETS",
        fsGroupKey: "BS_MEMBER_AR",
        defaultDepartmentCode: null,
      }],
    ]);
    const p = predictCoaRow({ number: "1201", name: "Accts Receivable - Monthly Dues" }, existing);
    expect(p.source).toBe("existing-account");
    expect(p.fsGroupKey).toBe("BS_MEMBER_AR");
  });

  it("1201 with WRONG-TYPE existing (REVENUE) → bracket+name wins, corrects the type", () => {
    const existing = new Map([
      ["1201", {
        accountNumber: "1201",
        type: "REVENUE",
        categoryKey: "MEMBERSHIP_REVENUE",
        fsGroupKey: "IS_MEMBERSHIP_DUES",
        defaultDepartmentCode: null,
      }],
    ]);
    const p = predictCoaRow({ number: "1201", name: "Accts Receivable - Monthly Dues" }, existing);
    expect(p.source).toBe("name-keyword");
    expect(p.type).toBe("ASSET");
    expect(p.fsGroupKey).toBe("BS_MEMBER_AR");
  });

  it("1000 with GENERIC existing (BS_OTHER_ASSETS) → bracket+keyword still wins", () => {
    const existing = new Map([
      ["1000", {
        accountNumber: "1000",
        type: "ASSET",
        categoryKey: "CURRENT_ASSETS",
        fsGroupKey: "BS_OTHER_ASSETS",
        defaultDepartmentCode: null,
      }],
    ]);
    const p = predictCoaRow({ number: "1000", name: "Petty Cash" }, existing);
    expect(p.source).toBe("name-keyword");
    expect(p.fsGroupKey).toBe("BS_CASH_EQUIVALENTS");
  });
});

describe("Generic-override: keyword beats existing-account when existing is a generic 'Other' bucket", () => {
  it("Petty Cash mapped to BS_OTHER_ASSETS on the existing account is upgraded to BS_CASH_EQUIVALENTS by the keyword rule", () => {
    const existing = new Map([
      ["1000", {
        accountNumber: "1000",
        type: "ASSET",
        categoryKey: "CURRENT_ASSETS",
        fsGroupKey: "BS_OTHER_ASSETS", // ← stale generic
        defaultDepartmentCode: null,
      }],
    ]);
    const p = predictCoaRow({ number: "1000", name: "Petty Cash" }, existing);
    expect(p.fsGroupKey).toBe("BS_CASH_EQUIVALENTS");
    expect(p.source).toBe("name-keyword");
  });

  it("Cost of Food Sold mapped to IS_OTHER_EXPENSES on the existing account is upgraded to IS_COGS_FOOD by the keyword rule", () => {
    const existing = new Map([
      ["5000", {
        accountNumber: "5000",
        type: "EXPENSE",
        categoryKey: "OTHER_EXPENSES",
        fsGroupKey: "IS_OTHER_EXPENSES", // ← stale generic
        defaultDepartmentCode: null,
      }],
    ]);
    const p = predictCoaRow({ number: "5000", name: "Cost of Food Sold" }, existing);
    expect(p.fsGroupKey).toBe("IS_COGS_FOOD");
    expect(p.source).toBe("name-keyword");
  });

  it("SPECIFIC existing mapping still wins over keyword (the override only applies when existing is generic)", () => {
    const existing = new Map([
      ["1000", {
        accountNumber: "1000",
        type: "ASSET",
        categoryKey: "CURRENT_ASSETS",
        fsGroupKey: "BS_CASH_EQUIVALENTS", // ← already specific
        defaultDepartmentCode: null,
      }],
    ]);
    // Even if the operator typed a weird name, the existing
    // specific mapping is preserved — operator picks always
    // win over keyword guessing.
    const p = predictCoaRow({ number: "1000", name: "Quirky Custom Name" }, existing);
    expect(p.fsGroupKey).toBe("BS_CASH_EQUIVALENTS");
    expect(p.source).toBe("existing-account");
  });

  it("keyword rule that ALSO produces a generic bucket lands on the same FS group (no churn)", () => {
    const existing = new Map([
      ["8999", {
        accountNumber: "8999",
        type: "EXPENSE",
        categoryKey: "OTHER_EXPENSES",
        fsGroupKey: "IS_OTHER_EXPENSES",
        defaultDepartmentCode: null,
      }],
    ]);
    // "Bad Debt Expense" → keyword rule yields IS_OTHER_EXPENSES
    // (also generic). End-state FS group is identical to the
    // existing mapping; source is name-keyword now (the bracket-
    // first engine treats generic existing as overridable).
    const p = predictCoaRow({ number: "8999", name: "Bad Debt Expense" }, existing);
    expect(p.fsGroupKey).toBe("IS_OTHER_EXPENSES");
    expect(p.type).toBe("EXPENSE");
    expect(p.categoryKey).toBe("OTHER_EXPENSES");
  });
});

// ---------------------------------------------------------------------------
// Founder refinement 2026-06-29 v4 — abbreviation normalization
// ---------------------------------------------------------------------------
describe("normalizeAccountNameForPrediction — expands shorthand to canonical forms", () => {
  const cases: Array<{ input: string; contains: string }> = [
    { input: "Accts Payable - Accrued Expenses", contains: "Accounts Payable" },
    { input: "Acct Pay - Trade Vendors",         contains: "Accounts Payable" },
    { input: "A/P - Group Premium",              contains: "Accounts Payable" },
    { input: "AP - Holding",                     contains: "Accounts Payable" },
    { input: "Acct Rec - Members",               contains: "Accounts Receivable" },
    { input: "A/R - Monthly Dues",               contains: "Accounts Receivable" },
    { input: "AR - Trade",                       contains: "Accounts Receivable" },
    { input: "COS - Food",                       contains: "Cost of Sales" },
    { input: "COGS - Beverage",                  contains: "Cost of Goods Sold" },
    { input: "F&B Sales",                        contains: "Food and Beverage" },
    { input: "FB Combined",                      contains: "Food and Beverage" },
    { input: "PR Wages",                         contains: "Payroll" },
    { input: "P/R Liability",                    contains: "Payroll" },
    { input: "R&M - Clubhouse",                  contains: "Repairs and Maintenance" },
    { input: "Maint Supplies",                   contains: "Maintenance" },
    { input: "Depn Expense",                     contains: "Depreciation" },
    { input: "Deprec - Equipment",               contains: "Depreciation" },
    { input: "Amort - Software",                 contains: "Amortization" },
    { input: "Int Exp - Loan",                   contains: "Interest Expense" },
    { input: "Int Inc - Bank",                   contains: "Interest Income" },
    { input: "Prof Fees - Audit",                contains: "Professional Fees" },
    { input: "Acctg Software",                   contains: "Accounting" },
    { input: "Ins Expense",                      contains: "Insurance" },
    { input: "Insur Premium",                    contains: "Insurance" },
    { input: "Util Bills",                       contains: "Utilities" },
    { input: "Elec - Clubhouse",                 contains: "Electricity" },
    { input: "Nat Gas - Course",                 contains: "Natural Gas" },
    { input: "Corp Tax Payable",                 contains: "Corporate Tax" },
    { input: "PP&E - Buildings",                 contains: "Property Plant and Equipment" },
    { input: "PPE Net",                          contains: "Property Plant and Equipment" },
    { input: "Capex Reserve",                    contains: "Capital Expenditure" },
    { input: "Mbr Statement",                    contains: "Member" },
    { input: "Mbrs Receivable",                  contains: "Member" },
    { input: "Golf Shop Sales",                  contains: "Pro Shop" },
    { input: "Proshop Inventory",                contains: "Pro Shop" },
    { input: "Sal & Wages",                      contains: "Salaries" },
  ];
  for (const c of cases) {
    it(`'${c.input}' → expanded contains '${c.contains}'`, () => {
      expect(normalizeAccountNameForPrediction(c.input)).toContain(c.contains);
    });
  }

  it("is idempotent — running twice produces the same output", () => {
    const inputs = [
      "Accts Payable - Accrued Expenses",
      "A/R - Monthly Dues",
      "COS - Food",
      "R&M - Clubhouse",
      "Depn Expense",
    ];
    for (const i of inputs) {
      const once = normalizeAccountNameForPrediction(i);
      const twice = normalizeAccountNameForPrediction(once);
      expect(twice).toBe(once);
    }
  });
});

describe("False-positive guards — abbreviations inside other words do NOT expand", () => {
  const cases: Array<{ input: string }> = [
    { input: "Pearl Necklace Asset" },   // 'ar' inside 'Pearl'
    { input: "Draw Materials" },         // 'ar' inside 'Draw' (none)
    { input: "Apple Supply" },           // 'ap' inside 'Apple'
    { input: "Paper Goods" },            // 'ap' inside 'Paper'
    { input: "April Payroll" },          // 'apr' contains 'apr', PR rule must not fire on 'pr' inside 'April'
    { input: "Print Service" },          // 'pr' inside 'Print'
    { input: "Fair Value Reserve" },     // 'FA' inside 'Fair' — case-sensitive on FA so lowercase 'fa' is safe
    { input: "Inspect Fee" },            // 'Ins' inside 'Inspect' — must NOT expand to 'Insurance Pect Fee'
  ];
  for (const c of cases) {
    it(`'${c.input}' does not gain an "Accounts/Payroll/Fixed/Insurance" word`, () => {
      const out = normalizeAccountNameForPrediction(c.input);
      // None of the bogus expansions should appear if the word is
      // legitimately something else. We assert against the most
      // dangerous expansion targets.
      if (!/^accounts? (receivable|payable)/i.test(c.input)) {
        expect(out).not.toMatch(/Accounts Receivable/i);
      }
      if (!/payable/i.test(c.input)) {
        expect(out).not.toMatch(/Accounts Payable/i);
      }
      // "April Payroll" already contains "Payroll" legitimately;
      // the test is that "April" doesn't expand to anything else.
      // Just check that 'April' / 'Print' / 'Pearl' / 'Apple' /
      // 'Inspect' / 'Fair' / 'Draw' / 'Paper' words survive.
      const word = c.input.split(/\s+/)[0];
      expect(out).toContain(word);
    });
  }
});

describe("Founder regression: abbreviated names predict correctly end-to-end", () => {
  const cases: Array<{ number: string; name: string; expectType: string; expectFs: string }> = [
    { number: "2001", name: "Accts Payable - Accrued Expenses", expectType: "LIABILITY", expectFs: "BS_AP" },
    { number: "2002", name: "Acct Pay - Trade Vendors",         expectType: "LIABILITY", expectFs: "BS_AP" },
    { number: "2003", name: "A/P - Group Premium",              expectType: "LIABILITY", expectFs: "BS_AP" },
    { number: "1102", name: "Acct Rec - Members",               expectType: "ASSET",     expectFs: "BS_MEMBER_AR" },
    { number: "1103", name: "A/R - Monthly Dues",               expectType: "ASSET",     expectFs: "BS_MEMBER_AR" },
    { number: "5050", name: "COS - Food",                       expectType: "EXPENSE",   expectFs: "IS_COGS_FOOD" },
    { number: "5051", name: "COGS - Beverage",                  expectType: "EXPENSE",   expectFs: "IS_COGS_BEVERAGE" },
    { number: "4250", name: "F&B Sales",                        expectType: "REVENUE",   expectFs: "IS_FOOD_SALES" },
    { number: "6010", name: "PR Wages",                         expectType: "EXPENSE",   expectFs: "IS_PAYROLL" },
    { number: "6320", name: "R&M - Clubhouse",                  expectType: "EXPENSE",   expectFs: "IS_REPAIRS_MAINTENANCE" },
    { number: "6900", name: "Depn Expense",                     expectType: "EXPENSE",   expectFs: "IS_DEPRECIATION" },
    { number: "6910", name: "Int Exp - Loan",                   expectType: "EXPENSE",   expectFs: "IS_INTEREST_EXPENSE" },
    { number: "6420", name: "Prof Fees - Audit",                expectType: "EXPENSE",   expectFs: "IS_PROFESSIONAL_FEES" },
    { number: "6430", name: "Ins Expense",                      expectType: "EXPENSE",   expectFs: "IS_INSURANCE" },
  ];
  for (const c of cases) {
    it(`${c.number} '${c.name}' → ${c.expectType} / ${c.expectFs}`, () => {
      const p = predictCoaRow({ number: c.number, name: c.name });
      expect(p.type).toBe(c.expectType);
      expect(p.fsGroupKey).toBe(c.expectFs);
      expect(p.confidence).toBe("high");
    });
  }
});

// ---------------------------------------------------------------------------
// Founder refinement 2026-06-29 v7 — credit cards → AP
// (CORRECTION to v5: no separate FS group for credit cards)
// ---------------------------------------------------------------------------
describe("Credit cards land on Current Liabilities / Accounts Payable", () => {
  const cases: Array<{ number: string; name: string }> = [
    { number: "2100", name: "Bank - Visa 8103" },
    { number: "2101", name: "Bank - Visa 6528" },
    { number: "2102", name: "Visa Payable" },
    { number: "2103", name: "Mastercard Payable" },
    { number: "2104", name: "Master Card Payable" },
    { number: "2105", name: "American Express Payable" },
    { number: "2106", name: "Amex Payable" },
    { number: "2107", name: "Credit Card - Corporate" },
    { number: "2108", name: "Corporate Card" },
    { number: "2109", name: "Purchasing Card" },
    { number: "2110", name: "P-Card Liability" },
  ];
  for (const c of cases) {
    it(`${c.number} '${c.name}' → Liability / Current Liabilities / BS_AP`, () => {
      const p = predictCoaRow({ number: c.number, name: c.name });
      expect(p.type).toBe("LIABILITY");
      expect(p.categoryKey).toBe("CURRENT_LIABILITIES");
      expect(p.fsGroupKey).toBe("BS_AP");
      expect(p.confidence).toBe("high");
    });
  }
});

describe("Sales tax accounts (collected, paid/ITC, filed) always land on Sales Tax Payable", () => {
  const cases: Array<{ number: string; name: string }> = [
    { number: "2120", name: "GST Collected" },
    { number: "2121", name: "GST Paid (ITCs)" },
    { number: "2122", name: "GST Filed" },
    { number: "2123", name: "HST Collected" },
    { number: "2124", name: "HST Payable" },
    { number: "2125", name: "PST Payable" },
    { number: "2126", name: "QST Collected" },
    { number: "2127", name: "Sales Tax - Liability" },
    { number: "2128", name: "Input Tax Credit Receivable" },
  ];
  for (const c of cases) {
    it(`${c.number} '${c.name}' → Liability / Current Liabilities / BS_SALES_TAX_PAYABLE`, () => {
      const p = predictCoaRow({ number: c.number, name: c.name });
      expect(p.type).toBe("LIABILITY");
      expect(p.categoryKey).toBe("CURRENT_LIABILITIES");
      expect(p.fsGroupKey).toBe("BS_SALES_TAX_PAYABLE");
      expect(p.confidence).toBe("high");
    });
  }
});

describe("HIGH_PRECEDENCE override: credit cards + sales tax beat even SPECIFIC existing-account mappings", () => {
  it("'Bank - Visa 8103' with stale BS_LONG_TERM_DEBT existing → predicts BS_AP (founder's bug fix)", () => {
    const existing = new Map([
      ["2100", {
        accountNumber: "2100",
        type: "LIABILITY",
        categoryKey: "LONG_TERM_LIABILITIES",
        fsGroupKey: "BS_LONG_TERM_DEBT", // ← stale specific from migration
        defaultDepartmentCode: null,
      }],
    ]);
    const p = predictCoaRow({ number: "2100", name: "Bank - Visa 8103" }, existing);
    expect(p.fsGroupKey).toBe("BS_AP");
    expect(p.source).toBe("name-keyword");
  });

  it("'GST Collected' with stale BS_LONG_TERM_DEBT existing → predicts BS_SALES_TAX_PAYABLE", () => {
    const existing = new Map([
      ["2120", {
        accountNumber: "2120",
        type: "LIABILITY",
        categoryKey: "LONG_TERM_LIABILITIES",
        fsGroupKey: "BS_LONG_TERM_DEBT",
        defaultDepartmentCode: null,
      }],
    ]);
    const p = predictCoaRow({ number: "2120", name: "GST Collected" }, existing);
    expect(p.fsGroupKey).toBe("BS_SALES_TAX_PAYABLE");
    expect(p.source).toBe("name-keyword");
  });

  it("A NON-credit-card / non-sales-tax SPECIFIC existing mapping still wins — override is bounded", () => {
    const existing = new Map([
      ["2500", {
        accountNumber: "2500",
        type: "LIABILITY",
        categoryKey: "LONG_TERM_LIABILITIES",
        fsGroupKey: "BS_LONG_TERM_DEBT",
        defaultDepartmentCode: null,
      }],
    ]);
    // No credit-card or sales-tax words in the name → no override.
    const p = predictCoaRow({ number: "2500", name: "Mortgage Payable" }, existing);
    expect(p.fsGroupKey).toBe("BS_LONG_TERM_DEBT");
    expect(p.source).toBe("existing-account");
  });
});

describe("Bank/Loan rules don't fire on credit cards or sales tax", () => {
  it("'Bank - Visa' does NOT match the BS_LONG_TERM_DEBT bank-loan pattern", () => {
    const p = predictCoaRow({ number: "2100", name: "Bank - Visa 8103" });
    expect(p.fsGroupKey).not.toBe("BS_LONG_TERM_DEBT");
  });

  it("'GST Paid (ITCs)' does NOT match the BS_LONG_TERM_DEBT pattern", () => {
    const p = predictCoaRow({ number: "2121", name: "GST Paid (ITCs)" });
    expect(p.fsGroupKey).not.toBe("BS_LONG_TERM_DEBT");
  });

  it("an explicit 'Bank Loan' DOES still land on BS_LONG_TERM_DEBT", () => {
    const p = predictCoaRow({ number: "2500", name: "Bank Loan - Equipment" });
    expect(p.fsGroupKey).toBe("BS_LONG_TERM_DEBT");
  });

  it("an explicit 'Long-term Debt' STILL lands on BS_LONG_TERM_DEBT", () => {
    const p = predictCoaRow({ number: "2550", name: "Long-term Debt" });
    expect(p.fsGroupKey).toBe("BS_LONG_TERM_DEBT");
  });
});

// ---------------------------------------------------------------------------
// Founder refinement 2026-06-29 v7 — non-debt long-term liabilities
// (CORRECTION to v6: single Long-Term Liabilities bucket for gift
// cards / credit books; single Deposits Payable bucket for every
// deposit kind).
// ---------------------------------------------------------------------------
describe("Gift cards + credit books → BS_LONG_TERM_LIABILITIES (generic non-debt bucket)", () => {
  const cases: Array<{ number: string; name: string }> = [
    { number: "2300", name: "Gift Card Liability" },
    { number: "2301", name: "Gift Cards Outstanding" },
    { number: "2302", name: "Gift Certificates" },
    { number: "2303", name: "Incentive Credit Book" },
    { number: "2304", name: "Credit Book - Cash Value" },
    { number: "2305", name: "Cash Value Credit Book" },
  ];
  for (const c of cases) {
    it(`${c.number} '${c.name}' → Liability / Long-Term Liabilities / BS_LONG_TERM_LIABILITIES`, () => {
      const p = predictCoaRow({ number: c.number, name: c.name });
      expect(p.type).toBe("LIABILITY");
      expect(p.categoryKey).toBe("LONG_TERM_LIABILITIES");
      expect(p.fsGroupKey).toBe("BS_LONG_TERM_LIABILITIES");
      expect(p.confidence).toBe("high");
    });
  }
});

describe("Every deposit kind → BS_DEPOSITS_PAYABLE", () => {
  const cases: Array<{ number: string; name: string }> = [
    { number: "2310", name: "Intermed Share Purch Credit" },
    { number: "2311", name: "Share Purchase Credit" },
    { number: "2312", name: "Share Purchase Deposit" },
    { number: "2313", name: "Waitlist - Share Purchase Deposit" },
    { number: "2314", name: "Designate - Share Purchase Deposit" },
    { number: "2315", name: "Designated Share Purchase Deposit" },
    { number: "2316", name: "Waitlist Deposit" },
    { number: "2317", name: "External Group Deposit" },
    { number: "2318", name: "Event Deposit" },
    { number: "2319", name: "Tournament Deposit" },
    { number: "2320", name: "Rental Deposit" },
    { number: "2321", name: "Banquet Deposit" },
    { number: "2322", name: "Damage Deposit" },
    { number: "2323", name: "Security Deposit" },
    { number: "2324", name: "Member Deposit" },
  ];
  for (const c of cases) {
    it(`${c.number} '${c.name}' → Liability / Long-Term Liabilities / BS_DEPOSITS_PAYABLE`, () => {
      const p = predictCoaRow({ number: c.number, name: c.name });
      expect(p.type).toBe("LIABILITY");
      expect(p.categoryKey).toBe("LONG_TERM_LIABILITIES");
      expect(p.fsGroupKey).toBe("BS_DEPOSITS_PAYABLE");
      expect(p.confidence).toBe("high");
    });
  }
});

describe("Deferred capital contributions → BS_DEFERRED_CAPITAL_CONTRIBUTIONS", () => {
  const cases = [
    "Deferred capital contributions",
    "Deferred Capital Contribution",
    "Capital Contributions Deferred",
    "Deferred Contribution - Course",
  ];
  for (const name of cases) {
    it(`'${name}' → Liability / Long-Term Liabilities / BS_DEFERRED_CAPITAL_CONTRIBUTIONS`, () => {
      const p = predictCoaRow({ number: "2400", name });
      expect(p.type).toBe("LIABILITY");
      expect(p.categoryKey).toBe("LONG_TERM_LIABILITIES");
      expect(p.fsGroupKey).toBe("BS_DEFERRED_CAPITAL_CONTRIBUTIONS");
      expect(p.confidence).toBe("high");
    });
  }
});

describe("Long-Term Debt is reserved for actual debt instruments only", () => {
  it("'Bank Loan' → BS_LONG_TERM_DEBT", () => {
    const p = predictCoaRow({ number: "2500", name: "Bank Loan" });
    expect(p.fsGroupKey).toBe("BS_LONG_TERM_DEBT");
  });
  it("'Mortgage Payable' → BS_LONG_TERM_DEBT", () => {
    const p = predictCoaRow({ number: "2550", name: "Mortgage Payable" });
    expect(p.fsGroupKey).toBe("BS_LONG_TERM_DEBT");
  });
  it("'Term Loan' → BS_LONG_TERM_DEBT", () => {
    const p = predictCoaRow({ number: "2560", name: "Term Loan - Equipment" });
    expect(p.fsGroupKey).toBe("BS_LONG_TERM_DEBT");
  });
  it("'Debenture' → BS_LONG_TERM_DEBT", () => {
    const p = predictCoaRow({ number: "2570", name: "Debenture Payable" });
    expect(p.fsGroupKey).toBe("BS_LONG_TERM_DEBT");
  });
  it("'Credit Facility' → BS_LONG_TERM_DEBT", () => {
    const p = predictCoaRow({ number: "2580", name: "Credit Facility - Operating" });
    expect(p.fsGroupKey).toBe("BS_LONG_TERM_DEBT");
  });
  it("'Loan Payable' → BS_LONG_TERM_DEBT", () => {
    const p = predictCoaRow({ number: "2590", name: "Loan Payable - Member" });
    expect(p.fsGroupKey).toBe("BS_LONG_TERM_DEBT");
  });

  it("'Gift Card Liability' does NOT land on BS_LONG_TERM_DEBT", () => {
    const p = predictCoaRow({ number: "2300", name: "Gift Card Liability" });
    expect(p.fsGroupKey).not.toBe("BS_LONG_TERM_DEBT");
  });
  it("'Share Purchase Deposit' does NOT land on BS_LONG_TERM_DEBT", () => {
    const p = predictCoaRow({ number: "2310", name: "Share Purchase Deposit" });
    expect(p.fsGroupKey).not.toBe("BS_LONG_TERM_DEBT");
  });
  it("'Deferred capital contributions' does NOT land on BS_LONG_TERM_DEBT", () => {
    const p = predictCoaRow({ number: "2400", name: "Deferred capital contributions" });
    expect(p.fsGroupKey).not.toBe("BS_LONG_TERM_DEBT");
  });
  it("'Visa Payable' does NOT land on BS_LONG_TERM_DEBT (v7: credit cards go to AP)", () => {
    const p = predictCoaRow({ number: "2102", name: "Visa Payable" });
    expect(p.fsGroupKey).not.toBe("BS_LONG_TERM_DEBT");
  });
  it("'Damage Deposit' does NOT land on BS_LONG_TERM_DEBT (v7: deposits go to Deposits Payable)", () => {
    const p = predictCoaRow({ number: "2322", name: "Damage Deposit" });
    expect(p.fsGroupKey).not.toBe("BS_LONG_TERM_DEBT");
  });
});

describe("HIGH_PRECEDENCE override: non-debt long-term buckets beat stale BS_LONG_TERM_DEBT existing", () => {
  it("'Gift Card Liability' with stale BS_LONG_TERM_DEBT existing → predicts BS_LONG_TERM_LIABILITIES", () => {
    const existing = new Map([
      ["2300", {
        accountNumber: "2300",
        type: "LIABILITY",
        categoryKey: "LONG_TERM_LIABILITIES",
        fsGroupKey: "BS_LONG_TERM_DEBT",
        defaultDepartmentCode: null,
      }],
    ]);
    const p = predictCoaRow({ number: "2300", name: "Gift Card Liability" }, existing);
    expect(p.fsGroupKey).toBe("BS_LONG_TERM_LIABILITIES");
    expect(p.source).toBe("name-keyword");
  });

  it("'Intermed Share Purch Credit' with stale BS_LONG_TERM_DEBT existing → predicts BS_DEPOSITS_PAYABLE", () => {
    const existing = new Map([
      ["2310", {
        accountNumber: "2310",
        type: "LIABILITY",
        categoryKey: "LONG_TERM_LIABILITIES",
        fsGroupKey: "BS_LONG_TERM_DEBT",
        defaultDepartmentCode: null,
      }],
    ]);
    const p = predictCoaRow({ number: "2310", name: "Intermed Share Purch Credit" }, existing);
    expect(p.fsGroupKey).toBe("BS_DEPOSITS_PAYABLE");
    expect(p.source).toBe("name-keyword");
  });

  it("'External Group Deposit' with stale BS_LONG_TERM_DEBT existing → predicts BS_DEPOSITS_PAYABLE", () => {
    const existing = new Map([
      ["2317", {
        accountNumber: "2317",
        type: "LIABILITY",
        categoryKey: "LONG_TERM_LIABILITIES",
        fsGroupKey: "BS_LONG_TERM_DEBT",
        defaultDepartmentCode: null,
      }],
    ]);
    const p = predictCoaRow({ number: "2317", name: "External Group Deposit" }, existing);
    expect(p.fsGroupKey).toBe("BS_DEPOSITS_PAYABLE");
    expect(p.source).toBe("name-keyword");
  });

  it("'Deferred capital contributions' with stale BS_LONG_TERM_DEBT existing → predicts BS_DEFERRED_CAPITAL_CONTRIBUTIONS", () => {
    const existing = new Map([
      ["2400", {
        accountNumber: "2400",
        type: "LIABILITY",
        categoryKey: "LONG_TERM_LIABILITIES",
        fsGroupKey: "BS_LONG_TERM_DEBT",
        defaultDepartmentCode: null,
      }],
    ]);
    const p = predictCoaRow({ number: "2400", name: "Deferred capital contributions" }, existing);
    expect(p.fsGroupKey).toBe("BS_DEFERRED_CAPITAL_CONTRIBUTIONS");
    expect(p.source).toBe("name-keyword");
  });
});

// ---------------------------------------------------------------------------
// Founder refinement 2026-06-29 v8 — custodial section funds
// ---------------------------------------------------------------------------
describe("Section accounts → BS_SECTION_FUNDS (default Long-Term Liabilities)", () => {
  const cases: Array<{ number: string; name: string }> = [
    { number: "2700", name: "Men's Section - Dues & General" },
    { number: "2701", name: "Men's Section - Other" },
    { number: "2702", name: "Mens Section" },
    { number: "2703", name: "Ladies Section - Dues & General" },
    { number: "2704", name: "Ladies Section" },
    { number: "2705", name: "Women's Section" },
    { number: "2706", name: "Junior Section" },
    { number: "2707", name: "Senior Section" },
    { number: "2708", name: "Seniors Match Play" },
    { number: "2709", name: "Match Play" },
    { number: "2710", name: "Men's Member Guest" },
    { number: "2711", name: "Ladies Member Guest" },
    { number: "2712", name: "Member Guest" },
    { number: "2713", name: "Tournament Fund" },
    { number: "2714", name: "Charity Fund" },
    { number: "2715", name: "Section Fund" },
    { number: "2716", name: "Section Account" },
    { number: "2717", name: "Club Section - Operating" },
  ];
  for (const c of cases) {
    it(`${c.number} '${c.name}' → Liability / Long-Term Liabilities / BS_SECTION_FUNDS`, () => {
      const p = predictCoaRow({ number: c.number, name: c.name });
      expect(p.type).toBe("LIABILITY");
      expect(p.categoryKey).toBe("LONG_TERM_LIABILITIES");
      expect(p.fsGroupKey).toBe("BS_SECTION_FUNDS");
      expect(p.confidence).toBe("high");
    });
  }
});

describe("Section funds do not displace other liability mappings", () => {
  it("'Accounts Payable' still lands on BS_AP", () => {
    const p = predictCoaRow({ number: "2000", name: "Accounts Payable" });
    expect(p.fsGroupKey).toBe("BS_AP");
  });
  it("'GST Collected' still lands on BS_SALES_TAX_PAYABLE", () => {
    const p = predictCoaRow({ number: "2010", name: "GST Collected" });
    expect(p.fsGroupKey).toBe("BS_SALES_TAX_PAYABLE");
  });
  it("'Bank - Visa 8103' still lands on BS_AP (credit cards)", () => {
    const p = predictCoaRow({ number: "2100", name: "Bank - Visa 8103" });
    expect(p.fsGroupKey).toBe("BS_AP");
  });
  it("'Event Deposit' still lands on BS_DEPOSITS_PAYABLE", () => {
    const p = predictCoaRow({ number: "2320", name: "Event Deposit" });
    expect(p.fsGroupKey).toBe("BS_DEPOSITS_PAYABLE");
  });
  it("'Gift Card Liability' still lands on BS_LONG_TERM_LIABILITIES", () => {
    const p = predictCoaRow({ number: "2300", name: "Gift Card Liability" });
    expect(p.fsGroupKey).toBe("BS_LONG_TERM_LIABILITIES");
  });
  it("'Deferred capital contributions' still lands on BS_DEFERRED_CAPITAL_CONTRIBUTIONS", () => {
    const p = predictCoaRow({ number: "2400", name: "Deferred capital contributions" });
    expect(p.fsGroupKey).toBe("BS_DEFERRED_CAPITAL_CONTRIBUTIONS");
  });
  it("'Mortgage Payable' still lands on BS_LONG_TERM_DEBT", () => {
    const p = predictCoaRow({ number: "2550", name: "Mortgage Payable" });
    expect(p.fsGroupKey).toBe("BS_LONG_TERM_DEBT");
  });
});

describe("Section funds: false-positive guards", () => {
  it("'Senior Manager Wages' (EXPENSE bracket) does NOT match section funds", () => {
    const p = predictCoaRow({ number: "6100", name: "Senior Manager Wages" });
    expect(p.fsGroupKey).not.toBe("BS_SECTION_FUNDS");
    expect(p.type).toBe("EXPENSE");
  });
  it("'Member Guests Course Fees' (REVENUE bracket) does NOT match section funds", () => {
    const p = predictCoaRow({ number: "4100", name: "Member Guests Course Fees" });
    expect(p.fsGroupKey).not.toBe("BS_SECTION_FUNDS");
    expect(p.type).toBe("REVENUE");
  });
  it("'Tournament Deposit' still routes to deposits, not section funds", () => {
    const p = predictCoaRow({ number: "2319", name: "Tournament Deposit" });
    expect(p.fsGroupKey).toBe("BS_DEPOSITS_PAYABLE");
  });
});

// ---------------------------------------------------------------------------
// Founder refinement 2026-06-29 v9 — hospitality revenue priority
// (business activity > isolated food/beverage keyword)
// ---------------------------------------------------------------------------
describe("Banquet / Event / Room Rental — never lands on Food Sales", () => {
  const cases: Array<{ number: string; name: string; expectFsGroup: string }> = [
    { number: "4061", name: "Banquet Room Rental",   expectFsGroup: "IS_FACILITY_RENTALS" },
    { number: "4062", name: "Room Rental - Lounge",  expectFsGroup: "IS_FACILITY_RENTALS" },
    { number: "4063", name: "Hall Rental",           expectFsGroup: "IS_FACILITY_RENTALS" },
    { number: "4064", name: "Ballroom Revenue",      expectFsGroup: "IS_FACILITY_RENTALS" },
    { number: "4065", name: "Facility Rental Income",expectFsGroup: "IS_FACILITY_RENTALS" },
    { number: "4066", name: "Banquet Revenue",       expectFsGroup: "IS_EVENT_REVENUE" },
    { number: "4067", name: "Wedding Revenue",       expectFsGroup: "IS_EVENT_REVENUE" },
    { number: "4068", name: "Conference Income",     expectFsGroup: "IS_EVENT_REVENUE" },
    { number: "4069", name: "Meeting Room Charges",  expectFsGroup: "IS_EVENT_REVENUE" },
    { number: "4070", name: "Function Revenue",      expectFsGroup: "IS_EVENT_REVENUE" },
    { number: "4071", name: "Reception Revenue",     expectFsGroup: "IS_EVENT_REVENUE" },
    { number: "4072", name: "Private Event Revenue", expectFsGroup: "IS_EVENT_REVENUE" },
    { number: "4073", name: "Events - Member",       expectFsGroup: "IS_EVENT_REVENUE" },
  ];
  for (const c of cases) {
    it(`${c.number} '${c.name}' → REVENUE / FB_REVENUE / ${c.expectFsGroup}`, () => {
      const p = predictCoaRow({ number: c.number, name: c.name });
      expect(p.type).toBe("REVENUE");
      expect(p.fsGroupKey).toBe(c.expectFsGroup);
      expect(p.fsGroupKey).not.toBe("IS_FOOD_SALES");
      expect(p.confidence).toBe("high");
    });
  }
});

describe("Catering — any cater* term wins over what's catered", () => {
  const cases: Array<{ number: string; name: string }> = [
    { number: "4055", name: "Catering - Food" },
    { number: "4056", name: "Catering - Liquor" },
    { number: "4057", name: "Catering - Pop" },
    { number: "4058", name: "Catering - Beer" },
    { number: "4059", name: "Catering - Wine" },
    { number: "4060", name: "Catering Pickup Order" },
    { number: "4074", name: "Catering Beverage Sales" },
  ];
  for (const c of cases) {
    it(`${c.number} '${c.name}' → REVENUE / IS_CATERING (the cater* keyword wins)`, () => {
      const p = predictCoaRow({ number: c.number, name: c.name });
      expect(p.type).toBe("REVENUE");
      expect(p.fsGroupKey).toBe("IS_CATERING");
      expect(p.fsGroupKey).not.toBe("IS_FOOD_SALES");
      expect(p.fsGroupKey).not.toBe("IS_BEVERAGE_SALES");
    });
  }
});

describe("Beverage Sales — Liquor / Beer / Wine / Pop / Draft / Soft Drink all land here", () => {
  const cases: Array<{ number: string; name: string }> = [
    { number: "4050", name: "Sales - Liquor" },
    { number: "4051", name: "Sales - Beer" },
    { number: "4052", name: "Sales - Wine" },
    { number: "4053", name: "Sales - Pop" },
    { number: "4054", name: "Sales - Draft Beer" },
    { number: "4075", name: "Beverage Revenue" },
    { number: "4076", name: "Bar Sales" },
    { number: "4077", name: "Soft Drink Sales" },
  ];
  for (const c of cases) {
    it(`${c.number} '${c.name}' → REVENUE / IS_BEVERAGE_SALES`, () => {
      const p = predictCoaRow({ number: c.number, name: c.name });
      expect(p.type).toBe("REVENUE");
      expect(p.fsGroupKey).toBe("IS_BEVERAGE_SALES");
      expect(p.fsGroupKey).not.toBe("IS_FOOD_SALES");
    });
  }
});

describe("Food Sales — only genuine prepared-food revenue", () => {
  const cases: Array<{ number: string; name: string }> = [
    { number: "4049", name: "Sales - Food" },
    { number: "4078", name: "Restaurant Food" },
    { number: "4079", name: "Kitchen Sales" },
    { number: "4080", name: "Food Revenue" },
    { number: "4081", name: "Dining Revenue" },
  ];
  for (const c of cases) {
    it(`${c.number} '${c.name}' → REVENUE / IS_FOOD_SALES`, () => {
      const p = predictCoaRow({ number: c.number, name: c.name });
      expect(p.type).toBe("REVENUE");
      expect(p.fsGroupKey).toBe("IS_FOOD_SALES");
    });
  }
});

describe("Hospitality priority: more specific business activity overrides bare food/beverage keywords", () => {
  it("'Banquet - Food Service' → IS_EVENT_REVENUE (banquet wins over food)", () => {
    const p = predictCoaRow({ number: "4090", name: "Banquet - Food Service" });
    expect(p.fsGroupKey).toBe("IS_EVENT_REVENUE");
  });
  it("'Wedding Bar Sales' → IS_EVENT_REVENUE (wedding wins over bar)", () => {
    const p = predictCoaRow({ number: "4091", name: "Wedding Bar Sales" });
    expect(p.fsGroupKey).toBe("IS_EVENT_REVENUE");
  });
  it("'Catering Food Revenue' → IS_CATERING (catering wins over food)", () => {
    const p = predictCoaRow({ number: "4092", name: "Catering Food Revenue" });
    expect(p.fsGroupKey).toBe("IS_CATERING");
  });
});

// ---------------------------------------------------------------------------
// Founder refinement 2026-06-29 v10 — every predictor fsGroupKey
// MUST be a current canonical FS Group key (not a legacy/retired key)
// ---------------------------------------------------------------------------
describe("Guard: every fsGroupKey the predictor can return is a CURRENT canonical key", () => {
  it("every keyword rule + bracket default targets a key in DEFAULT_FS_GROUPS (and NOT in RETIRED_FS_GROUP_KEYS)", async () => {
    const tpl = await import("@/lib/accounting/coa-template");
    const pred = await import("@/lib/imports/coa-predictor") as any;
    const canonicalKeys = new Set(tpl.DEFAULT_FS_GROUPS.map((g: { key: string }) => g.key));
    const retiredKeys = new Set<string>(tpl.RETIRED_FS_GROUP_KEYS as readonly string[]);
    // Every fsGroupKey the engine can name MUST be a current key
    // — covers keyword rules, bracket defaults, and the synthetic
    // FS_GROUP_TO_CATEGORY map (which is the predictor's vocabulary).
    const predictorKeys: string[] = Object.keys(pred.FS_GROUP_TO_CATEGORY ?? {});
    expect(predictorKeys.length).toBeGreaterThan(0);
    for (const key of predictorKeys) {
      expect(canonicalKeys.has(key), `predictor uses '${key}' but it's not in DEFAULT_FS_GROUPS`).toBe(true);
      expect(retiredKeys.has(key), `predictor uses '${key}' which is listed in RETIRED_FS_GROUP_KEYS — sync would delete it`).toBe(false);
    }
  });
});

describe("Founder regression v10: gift card + credit book FS Group key is the CONFIGURED key, not invented", () => {
  it("'Gift Card Liability' fsGroupKey = 'BS_LONG_TERM_LIABILITIES' AND that key is in DEFAULT_FS_GROUPS", async () => {
    const tpl = await import("@/lib/accounting/coa-template");
    const canonicalKeys = new Set(tpl.DEFAULT_FS_GROUPS.map((g: { key: string }) => g.key));
    const p = predictCoaRow({ number: "2300", name: "Gift Card Liability" });
    expect(p.fsGroupKey).toBe("BS_LONG_TERM_LIABILITIES");
    expect(canonicalKeys.has(p.fsGroupKey!)).toBe(true);
    expect(p.categoryKey).toBe("LONG_TERM_LIABILITIES");
  });

  it("'Incentive Credit Book' fsGroupKey is configured", async () => {
    const tpl = await import("@/lib/accounting/coa-template");
    const canonicalKeys = new Set(tpl.DEFAULT_FS_GROUPS.map((g: { key: string }) => g.key));
    const p = predictCoaRow({ number: "2303", name: "Incentive Credit Book" });
    expect(p.fsGroupKey).toBe("BS_LONG_TERM_LIABILITIES");
    expect(canonicalKeys.has(p.fsGroupKey!)).toBe(true);
  });

  it("'Credit Book - Cash Value' fsGroupKey is configured", async () => {
    const tpl = await import("@/lib/accounting/coa-template");
    const canonicalKeys = new Set(tpl.DEFAULT_FS_GROUPS.map((g: { key: string }) => g.key));
    const p = predictCoaRow({ number: "2304", name: "Credit Book - Cash Value" });
    expect(p.fsGroupKey).toBe("BS_LONG_TERM_LIABILITIES");
    expect(canonicalKeys.has(p.fsGroupKey!)).toBe(true);
  });

  it("BS_LONG_TERM_LIABILITIES is NOT listed in RETIRED_FS_GROUP_KEYS (regression: the v7→v10 dual-listing bug)", async () => {
    const tpl = await import("@/lib/accounting/coa-template");
    expect(tpl.RETIRED_FS_GROUP_KEYS).not.toContain("BS_LONG_TERM_LIABILITIES");
  });

  it("BS_LONG_TERM_LIABILITIES is NOT listed in LEGACY_FS_GROUP_MIGRATION (regression: same bug)", async () => {
    const tpl = await import("@/lib/accounting/coa-template");
    expect(Object.keys(tpl.LEGACY_FS_GROUP_MIGRATION)).not.toContain("BS_LONG_TERM_LIABILITIES");
  });
});

// ---------------------------------------------------------------------------
// Founder refinement 2026-06-29 v11 — Salaries and Benefits
// (FS Group rename + IS_EMPLOYEE_BENEFITS consolidated into IS_PAYROLL)
// ---------------------------------------------------------------------------
describe("Salaries + Benefits keyword coverage — every founder keyword routes to IS_PAYROLL", () => {
  const cases: Array<{ number: string; name: string }> = [
    { number: "6500", name: "Salary - Course Superintendent" },
    { number: "6501", name: "Salaries - Admin" },
    { number: "6502", name: "Wage Accrual" },
    { number: "6503", name: "Wages - Course" },
    { number: "6504", name: "Payroll - Pro Shop" },
    { number: "6505", name: "Vacation Pay" },
    { number: "6506", name: "Statutory Holiday Pay" },
    { number: "6507", name: "Stat Holiday Accrual" },
    { number: "6508", name: "Overtime - Kitchen" },
    { number: "6509", name: "EI Premiums" },
    { number: "6510", name: "CPP Contributions" },
    { number: "6511", name: "EHT Remittance" },
    { number: "6512", name: "Pension Contributions" },
    { number: "6513", name: "RRSP Match - Admin" },
    { number: "6514", name: "Group Health Benefits" },
    { number: "6515", name: "Dental Benefits" },
    { number: "6516", name: "Workers Compensation" },
    { number: "6517", name: "Workers Comp Premiums" },
    { number: "6518", name: "WCB Premiums" },
    { number: "6519", name: "WSIB Remittance" },
    { number: "6520", name: "Payroll Burden" },
    { number: "6521", name: "Employer Taxes" },
    { number: "6522", name: "Employee Benefits - F&B" },
  ];
  for (const c of cases) {
    it(`${c.number} '${c.name}' → EXPENSE / PAYROLL_BENEFITS / IS_PAYROLL`, () => {
      const p = predictCoaRow({ number: c.number, name: c.name });
      expect(p.type).toBe("EXPENSE");
      expect(p.categoryKey).toBe("PAYROLL_BENEFITS");
      expect(p.fsGroupKey).toBe("IS_PAYROLL");
    });
  }
});

describe("Salaries and Benefits — department preservation across the consolidated bucket", () => {
  // Department detection is via existing-account inheritance.
  // The v11 rename + consolidation must not break the path: a
  // re-imported payroll row whose existing account carries a
  // department keeps that department on the prediction.
  const cases: Array<{ number: string; name: string; expectDept: string; existingFsKey: string }> = [
    { number: "6200", name: "Salary - F&B Management",         expectDept: "F&B",      existingFsKey: "IS_PAYROLL" },
    { number: "6210", name: "Wages - Ground",                   expectDept: "GROUNDS",  existingFsKey: "IS_PAYROLL" },
    { number: "6220", name: "Salary - Golf Pro & Shop Manager", expectDept: "PROSHOP",  existingFsKey: "IS_PAYROLL" },
    { number: "6230", name: "Salary - Administration",          expectDept: "ADMIN",    existingFsKey: "IS_PAYROLL" },
    // A row whose existing account was on the RETIRED
    // IS_EMPLOYEE_BENEFITS bucket — after migration, the
    // sync moves it to IS_PAYROLL but department survives.
    { number: "6240", name: "Group Benefits - Pro Shop",        expectDept: "PROSHOP",  existingFsKey: "IS_PAYROLL" },
  ];
  for (const c of cases) {
    it(`${c.number} '${c.name}' (existing dept=${c.expectDept}) → IS_PAYROLL with department preserved`, () => {
      const existing = new Map([
        [c.number, {
          accountNumber: c.number,
          type: "EXPENSE",
          categoryKey: "PAYROLL_BENEFITS",
          fsGroupKey: c.existingFsKey,
          defaultDepartmentCode: c.expectDept,
        }],
      ]);
      const p = predictCoaRow({ number: c.number, name: c.name }, existing);
      expect(p.fsGroupKey).toBe("IS_PAYROLL");
      expect(p.defaultDepartmentCode).toBe(c.expectDept);
    });
  }
});

describe("v11 taxonomy invariants — IS_EMPLOYEE_BENEFITS is retired + IS_PAYROLL is renamed", () => {
  it("IS_EMPLOYEE_BENEFITS is in RETIRED_FS_GROUP_KEYS", async () => {
    const tpl = await import("@/lib/accounting/coa-template");
    expect(tpl.RETIRED_FS_GROUP_KEYS).toContain("IS_EMPLOYEE_BENEFITS");
  });
  it("IS_EMPLOYEE_BENEFITS migrates to IS_PAYROLL", async () => {
    const tpl = await import("@/lib/accounting/coa-template");
    expect(tpl.LEGACY_FS_GROUP_MIGRATION.IS_EMPLOYEE_BENEFITS?.newFsGroupKey).toBe("IS_PAYROLL");
  });
  it("IS_PAYROLL display name is 'Salaries and Benefits' (not 'Payroll')", async () => {
    const tpl = await import("@/lib/accounting/coa-template");
    const row = tpl.DEFAULT_FS_GROUPS.find((g) => g.key === "IS_PAYROLL");
    expect(row?.name).toBe("Salaries and Benefits");
  });
  it("IS_EMPLOYEE_BENEFITS is NOT in DEFAULT_FS_GROUPS", async () => {
    const tpl = await import("@/lib/accounting/coa-template");
    expect(tpl.DEFAULT_FS_GROUPS.find((g) => g.key === "IS_EMPLOYEE_BENEFITS")).toBeUndefined();
  });
});

describe("Original account name is unchanged — only the prediction-pass sees the expansion", () => {
  it("predictCoaRow does not mutate the input row.name (operator's text preserved for display)", () => {
    const input = { number: "2001", name: "Accts Payable - Accrued Expenses" };
    const captured = input.name;
    predictCoaRow(input);
    expect(input.name).toBe(captured);
  });
});

// ---------------------------------------------------------------------------
// Founder refinement 2026-07-01 v14.18 — Jonas TB unmatched-account fixes.
//
// Six real Trial Balance lines from the May 2026 Jonas export were
// mapped incorrectly on the Map/Add Accounts screen. Every one has
// a distinct root cause; this suite locks the fix and the reason.
// ---------------------------------------------------------------------------
describe("v14.18 Jonas TB unmatched-account regression fixes", () => {
  it("1515 'Accum Deprec - Irrigation' → ASSET / CAPITAL_ASSETS / BS_CAPITAL_ASSETS via abbreviation normalization", () => {
    // 'Accum Deprec' is the Jonas shorthand for a contra-asset
    // 'Accumulated Depreciation' line. Before v14.18 the predictor
    // only knew 'Deprec' → 'Depreciation'; the leading 'Accum' was
    // untouched, so the "accumulated deprec" keyword rule couldn't
    // fire and the row fell through to BS_OTHER_ASSETS.
    const p = predictCoaRow({ number: "1515", name: "Accum Deprec - Irrigation" });
    expect(p.type).toBe("ASSET");
    expect(p.categoryKey).toBe("CAPITAL_ASSETS");
    expect(p.fsGroupKey).toBe("BS_CAPITAL_ASSETS");
    expect(p.confidence).toBe("high");
    expect(p.source).toBe("abbreviation-normalized");
  });

  it("2311 'Capital Lease - Sonoma Smart Meter' → LIABILITY / LONG_TERM_LIABILITIES / BS_LEASE_LIABILITIES", () => {
    // 'Capital Lease' is a financing liability. Before v14.18 the
    // lease rule only matched 'Lease Liability' / 'Lease
    // Obligation', so this Jonas line dropped to BS_OTHER_LIABILITIES.
    const p = predictCoaRow({ number: "2311", name: "Capital Lease - Sonoma Smart Meter" });
    expect(p.type).toBe("LIABILITY");
    expect(p.categoryKey).toBe("LONG_TERM_LIABILITIES");
    expect(p.fsGroupKey).toBe("BS_LEASE_LIABILITIES");
    expect(p.confidence).toBe("high");
    expect(p.source).toBe("name-keyword");
  });

  const sctnCases: Array<{ number: string; name: string }> = [
    { number: "2367", name: "Ladies Sctn - 18 Hole Ladies Day" },
    { number: "2368", name: "Ladies Sctn - Rec League Prizes" },
    { number: "2369", name: "Ladies Sctn - Evening Lg Competition" },
    { number: "2370", name: "Ladies Sctn - Opening Reception" },
    { number: "2371", name: "Ladies Sctn - Interclub Kananaskis" },
  ];
  for (const c of sctnCases) {
    it(`${c.number} '${c.name}' → BS_SECTION_FUNDS via 'Sctn' → 'Section' expansion`, () => {
      const p = predictCoaRow({ number: c.number, name: c.name });
      expect(p.type).toBe("LIABILITY");
      expect(p.categoryKey).toBe("LONG_TERM_LIABILITIES");
      expect(p.fsGroupKey).toBe("BS_SECTION_FUNDS");
      expect(p.confidence).toBe("high");
      // The Sctn expansion is what enables the section-funds keyword;
      // the source has to reflect that the fix wasn't a bare keyword.
      expect(p.source).toBe("abbreviation-normalized");
    });
  }

  it("'Carts Rental 9 Hole' → IS_CART_REVENUE (plural + no dash, still cart revenue)", () => {
    // The v14.17 regex only matched singular 'Cart Rental'. Jonas
    // exports both 'Cart Rental - 18 Hole' and 'Carts Rental 9 Hole';
    // the second variant fell through to IS_OTHER_REVENUE.
    const p = predictCoaRow({ number: "4210", name: "Carts Rental 9 Hole" });
    expect(p.type).toBe("REVENUE");
    expect(p.categoryKey).toBe("GOLF_OPS_REVENUE");
    expect(p.fsGroupKey).toBe("IS_CART_REVENUE");
    expect(p.confidence).toBe("high");
    expect(p.source).toBe("name-keyword");
  });

  it("'Cart Rental - 18 Hole' still lands on IS_CART_REVENUE (no regression)", () => {
    const p = predictCoaRow({ number: "4200", name: "Cart Rental - 18 Hole" });
    expect(p.fsGroupKey).toBe("IS_CART_REVENUE");
  });

  it("'Rental Carts' (reversed order) also lands on IS_CART_REVENUE", () => {
    const p = predictCoaRow({ number: "4220", name: "Rental Carts" });
    expect(p.fsGroupKey).toBe("IS_CART_REVENUE");
  });

  it("'Cart Rentals' (plural rentals) also lands on IS_CART_REVENUE", () => {
    const p = predictCoaRow({ number: "4230", name: "Cart Rentals" });
    expect(p.fsGroupKey).toBe("IS_CART_REVENUE");
  });
});

// ---------------------------------------------------------------------------
// v14.18 — preserve every correct pre-fix prediction (no regression)
// ---------------------------------------------------------------------------
describe("v14.18 non-regression: correct predictions still stand", () => {
  it("'Mens Section - Dues' still lands on BS_SECTION_FUNDS (baseline)", () => {
    const p = predictCoaRow({ number: "2700", name: "Mens Section - Dues" });
    expect(p.fsGroupKey).toBe("BS_SECTION_FUNDS");
  });
  it("'Snack Bar Food' still lands on IS_FOOD_SALES (F&B revenue)", () => {
    const p = predictCoaRow({ number: "4400", name: "Snack Bar Food" });
    expect(p.type).toBe("REVENUE");
    expect(p.fsGroupKey).toBe("IS_FOOD_SALES");
  });
  it("'Snack Bar Beer' still lands on IS_BEVERAGE_SALES", () => {
    const p = predictCoaRow({ number: "4410", name: "Snack Bar Beer" });
    expect(p.fsGroupKey).toBe("IS_BEVERAGE_SALES");
  });
  it("'Snack Bar Liquor' still lands on IS_BEVERAGE_SALES", () => {
    const p = predictCoaRow({ number: "4420", name: "Snack Bar Liquor" });
    expect(p.fsGroupKey).toBe("IS_BEVERAGE_SALES");
  });
  it("'Snack Bar Pop' still lands on IS_BEVERAGE_SALES", () => {
    const p = predictCoaRow({ number: "4430", name: "Snack Bar Pop" });
    expect(p.fsGroupKey).toBe("IS_BEVERAGE_SALES");
  });
  it("'F&B Inventory' stays on 'name-keyword' (F&B is a recognised token pre-expansion)", () => {
    // The abbreviation-normalized source ONLY fires when the
    // keyword rule couldn't match the original. F&B → 'Food and
    // Beverage' is normalized, but the original 'F&B Inventory'
    // already matches `\binventor` in the BS_INVENTORY rule.
    const p = predictCoaRow({ number: "1200", name: "F&B Inventory" });
    expect(p.fsGroupKey).toBe("BS_INVENTORY");
    expect(p.source).toBe("name-keyword");
  });
  it("'Accts Payable' stays on 'name-keyword' (Accts is normalized but AP rule already recognises 'Accts Payable')", () => {
    const p = predictCoaRow({ number: "2001", name: "Accts Payable" });
    expect(p.fsGroupKey).toBe("BS_AP");
  });
  it("1450 'Employee Advances Receivable' → BS_LONG_TERM_RECEIVABLES with source 'nearby-account-range'", () => {
    // The 1400-1499 sub-bracket promotion. Locks the new
    // nearby-account-range source label.
    const p = predictCoaRow({ number: "1450", name: "Employee Advances Receivable" });
    expect(p.fsGroupKey).toBe("BS_LONG_TERM_RECEIVABLES");
    expect(p.source).toBe("nearby-account-range");
  });
});

// ---------------------------------------------------------------------------
// Founder refinement 2026-07-01 v14.22 — May 2026 review pass.
//
// Three new keyword rules + trial-balance sign as a tie-breaker for
// the 9xxx catch-all. Each of the four flagged Jonas accounts has
// its own root cause, so the suite locks each fix explicitly.
// ---------------------------------------------------------------------------
describe("v14.22 May 2026 review — new keyword + sign rules", () => {
  it("2365 'Senior Mens Interclub' → LIABILITY / LONG_TERM_LIABILITIES / BS_SECTION_FUNDS", () => {
    // 'Senior Mens' was previously unmatched; the section-funds
    // regex required 'seniors? section' explicitly. Extending the
    // pattern with `senior[\s-]*men'?s?\b` catches the Jonas
    // shorthand used for club senior mens' events + interclub
    // wagers. LIABILITY-typed, so payroll-side "Senior Mens Wages"
    // is unaffected (that would fire against the EXPENSE payroll
    // regex, not this one).
    const p = predictCoaRow({ number: "2365", name: "Senior Mens Interclub" });
    expect(p.type).toBe("LIABILITY");
    expect(p.categoryKey).toBe("LONG_TERM_LIABILITIES");
    expect(p.fsGroupKey).toBe("BS_SECTION_FUNDS");
    expect(p.confidence).toBe("high");
  });

  it("2366 'Senior Mens Day' → LIABILITY / LONG_TERM_LIABILITIES / BS_SECTION_FUNDS", () => {
    const p = predictCoaRow({ number: "2366", name: "Senior Mens Day" });
    expect(p.type).toBe("LIABILITY");
    expect(p.categoryKey).toBe("LONG_TERM_LIABILITIES");
    expect(p.fsGroupKey).toBe("BS_SECTION_FUNDS");
  });

  it("Senior Men's variants (apostrophe + hyphen + spacing) all land on BS_SECTION_FUNDS", () => {
    for (const name of ["Senior Men's Interclub", "Senior-Mens Day", "Senior Men Match Play"]) {
      const p = predictCoaRow({ number: "2367", name });
      expect(p.fsGroupKey, `for '${name}'`).toBe("BS_SECTION_FUNDS");
    }
  });

  it("6076 'Special Projects' → EXPENSE / PAYROLL_BENEFITS / IS_PAYROLL", () => {
    // Grounds-crew special-projects labour allocation. Sits
    // BEFORE the generic payroll regex so 'special\s*project'
    // wins; the type + category classify it as a wage expense
    // regardless of how the wider Jonas TB labelled it.
    const p = predictCoaRow({ number: "6076", name: "Special Projects" });
    expect(p.type).toBe("EXPENSE");
    expect(p.categoryKey).toBe("PAYROLL_BENEFITS");
    expect(p.fsGroupKey).toBe("IS_PAYROLL");
    expect(p.confidence).toBe("high");
  });

  it("9006 'Share Transfer Fee' → REVENUE / OTHER_REVENUE / IS_OTHER_REVENUE (keyword-driven)", () => {
    const p = predictCoaRow({ number: "9006", name: "Share Transfer Fee" });
    expect(p.type).toBe("REVENUE");
    expect(p.categoryKey).toBe("OTHER_REVENUE");
    expect(p.fsGroupKey).toBe("IS_OTHER_REVENUE");
    expect(p.confidence).toBe("high");
    // The explicit keyword rule fires — the source is
    // 'name-keyword', NOT 'balance-sign-supported'. Sign is
    // strictly a tie-breaker; a firing keyword wins.
    expect(p.source).toBe("name-keyword");
  });

  it("9007 unknown 9xxx with credit balance → promoted to OTHER_REVENUE via balance-sign-supported", () => {
    // Locks the sign tie-breaker: even with no keyword match,
    // a credit balance on a 9xxx account routes it to
    // OTHER_REVENUE (not the default OTHER_EXPENSES). This is
    // the founder's rule for using sign as a supporting
    // classification signal — active only in the range the
    // standard treats as ambiguous.
    const p = predictCoaRow({
      number: "9007",
      name: "Zzz Uncategorised Fee",
      debit: 0,
      credit: 1500,
    });
    expect(p.type).toBe("REVENUE");
    expect(p.categoryKey).toBe("OTHER_REVENUE");
    expect(p.fsGroupKey).toBe("IS_OTHER_REVENUE");
    expect(p.source).toBe("balance-sign-supported");
  });

  it("9008 unknown 9xxx with debit balance → default OTHER_EXPENSES (sign does not override the range)", () => {
    // Debit balance on a 9xxx catch-all keeps the standard
    // EXPENSE default. Sign only promotes to revenue; it never
    // demotes.
    const p = predictCoaRow({
      number: "9008",
      name: "Zzz Uncategorised Cost",
      debit: 1500,
      credit: 0,
    });
    expect(p.type).toBe("EXPENSE");
    expect(p.categoryKey).toBe("OTHER_EXPENSES");
    expect(p.fsGroupKey).toBe("IS_OTHER_EXPENSES");
    expect(p.source).toBe("number-range");
  });

  it("Sign does NOT override 6xxx-8xxx EXPENSE bracket (only 9xxx is ambiguous)", () => {
    // A credit balance on a 6xxx account is almost certainly a
    // data error, not a signal the predictor should silently
    // reinterpret. The default EXPENSE bracket wins.
    const p = predictCoaRow({
      number: "6099",
      name: "Zzz Uncategorised Expense",
      debit: 0,
      credit: 500,
    });
    expect(p.type).toBe("EXPENSE");
  });

  it("Sign does NOT override a keyword match (keyword wins even when sign says otherwise)", () => {
    // "Green Fees" (name keyword → IS_GREEN_FEES / REVENUE)
    // must stay revenue even if the balance somehow inverts.
    const p = predictCoaRow({
      number: "4100",
      name: "Green Fees",
      debit: 500,
      credit: 0,
    });
    expect(p.fsGroupKey).toBe("IS_GREEN_FEES");
    expect(p.source).toBe("name-keyword");
  });
});

describe("v14.22 non-regression: prior fixes still stand", () => {
  it("'Ladies Sctn - 18 Hole Ladies Day' → BS_SECTION_FUNDS (v14.18 fix preserved)", () => {
    const p = predictCoaRow({ number: "2367", name: "Ladies Sctn - 18 Hole Ladies Day" });
    expect(p.fsGroupKey).toBe("BS_SECTION_FUNDS");
    expect(p.source).toBe("abbreviation-normalized");
  });
  it("'Mens Section' → BS_SECTION_FUNDS (v8 baseline preserved)", () => {
    const p = predictCoaRow({ number: "2702", name: "Mens Section" });
    expect(p.fsGroupKey).toBe("BS_SECTION_FUNDS");
  });
  it("'Cart Rental - 18 Hole' → IS_CART_REVENUE (v14.18 fix preserved)", () => {
    const p = predictCoaRow({ number: "4200", name: "Cart Rental - 18 Hole" });
    expect(p.fsGroupKey).toBe("IS_CART_REVENUE");
  });
  it("'Carts Rental 9 Hole' → IS_CART_REVENUE (v14.18 plural fix preserved)", () => {
    const p = predictCoaRow({ number: "4210", name: "Carts Rental 9 Hole" });
    expect(p.fsGroupKey).toBe("IS_CART_REVENUE");
  });
  it("'Accum Deprec - Irrigation' → BS_CAPITAL_ASSETS (v14.18 fix preserved)", () => {
    const p = predictCoaRow({ number: "1515", name: "Accum Deprec - Irrigation" });
    expect(p.fsGroupKey).toBe("BS_CAPITAL_ASSETS");
    expect(p.source).toBe("abbreviation-normalized");
  });
  it("'Capital Lease - Sonoma Smart Meter' → BS_LEASE_LIABILITIES (v14.18 fix preserved)", () => {
    const p = predictCoaRow({ number: "2311", name: "Capital Lease - Sonoma Smart Meter" });
    expect(p.fsGroupKey).toBe("BS_LEASE_LIABILITIES");
  });
  it("false-positive guard: 'Senior Manager Wages' (EXPENSE bracket) does NOT match BS_SECTION_FUNDS", () => {
    // The `senior\s*men'?s?` extension is LIABILITY-typed, so an
    // expense-side wage row bypasses it. This confirms the guard.
    const p = predictCoaRow({ number: "6100", name: "Senior Manager Wages" });
    expect(p.type).toBe("EXPENSE");
    expect(p.fsGroupKey).not.toBe("BS_SECTION_FUNDS");
  });
});

describe("v14.18 abbreviation normalization: helper preserves originals + flags expansion", () => {
  it("expands 'Accum Deprec' to 'Accumulated Depreciation'", () => {
    expect(normalizeAccountNameForPrediction("Accum Deprec - Irrigation"))
      .toBe("Accumulated Depreciation - Irrigation");
  });
  it("expands 'Accum Depr' to 'Accumulated Depreciation'", () => {
    expect(normalizeAccountNameForPrediction("Accum Depr Buildings"))
      .toBe("Accumulated Depreciation Buildings");
  });
  it("expands bare 'Accum' to 'Accumulated'", () => {
    expect(normalizeAccountNameForPrediction("Accum Amortization"))
      .toBe("Accumulated Amortization");
  });
  it("expands 'Sctn' to 'Section' (case-insensitive)", () => {
    expect(normalizeAccountNameForPrediction("Ladies Sctn - 18 Hole"))
      .toBe("Ladies Section - 18 Hole");
    expect(normalizeAccountNameForPrediction("MENS SCTN"))
      .toBe("MENS Section");
  });
  it("is idempotent — running twice yields the same string", () => {
    const once = normalizeAccountNameForPrediction("Accum Deprec Ladies Sctn");
    expect(normalizeAccountNameForPrediction(once)).toBe(once);
  });
});
