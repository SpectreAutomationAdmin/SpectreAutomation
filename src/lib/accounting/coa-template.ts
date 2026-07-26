// Spectre canonical accounting taxonomy (founder rule 2026-07-19).
//
// This file is Spectre's PERMANENT accounting framework. Every
// club — regardless of how its native Chart of Accounts is
// numbered or labeled — maps into the Categories + FS Groups +
// Departments defined here. All reporting, dashboards, KPIs,
// benchmarking, AI insights, budgets, forecasting, and board
// packages derive from this taxonomy, NOT from club-specific
// account names.
//
// Three orthogonal axes:
//
//   • CATEGORY  — high-level presentation bucket on the
//                 financial statements (e.g. "Current Assets",
//                 "Payroll & Benefits"). 24 canonical entries.
//
//   • FS GROUP  — the specific line-item the account rolls up
//                 to on the BS / IS / CF (e.g. "Cash & Cash
//                 Equivalents", "Income Tax Expense"). ~74
//                 canonical entries + 3 cash-flow buckets.
//
//   • DEPARTMENT — the operational unit responsible for the
//                  account (Admin / Pro Shop / Grounds /
//                  Clubhouse / F&B / Events today; Fitness /
//                  Racquets / Curling / Aquatics / Marina /
//                  Ski Hill / Hotel / Spa future-reserved).
//                  Independent from Category + FS Group.
//
// Founder rule 2026-07-08: every account is a posting account;
// the legacy `isHeader` flag remains on the type for future
// flexibility but is never set true automatically.

import type { AccountType } from "./types";

export type COAAccountDef = {
  accountNumber: string;
  name: string;
  type: AccountType;
  categoryKey?: string;
  parentAccountNumber?: string;
  fsGroupKey?: string;
  isHeader?: boolean;
  allowManualPosting?: boolean;
  isBankAccount?: boolean;
  isCashAccount?: boolean;
  isControlAccount?: boolean;
  isTaxRelevant?: boolean;
  defaultDepartmentCode?: string;
};

export type COACategoryDef = { key: string; name: string; type: AccountType; sortOrder?: number };
export type COAFSGroupDef = { key: string; name: string; statement: "BALANCE_SHEET" | "INCOME_STATEMENT" | "CASH_FLOW"; cashFlowSection?: "OPERATING" | "INVESTING" | "FINANCING" | null; parentKey?: string | null; sortOrder?: number };

// ---------------------------------------------------------------------
// CANONICAL CATEGORIES (24)
// ---------------------------------------------------------------------
// Sort orders are global across types so the dropdown / report
// reads in the natural BS → IS sequence.
export const DEFAULT_CATEGORIES: COACategoryDef[] = [
  // Assets (4)
  { key: "CURRENT_ASSETS",            name: "Current Assets",             type: "ASSET",     sortOrder: 1 },
  { key: "INVESTMENTS",               name: "Investments",                type: "ASSET",     sortOrder: 2 },
  { key: "CAPITAL_ASSETS",            name: "Capital Assets",             type: "ASSET",     sortOrder: 3 },
  { key: "OTHER_ASSETS",              name: "Other Assets",               type: "ASSET",     sortOrder: 4 },
  // Liabilities (2)
  { key: "CURRENT_LIABILITIES",       name: "Current Liabilities",        type: "LIABILITY", sortOrder: 10 },
  { key: "LONG_TERM_LIABILITIES",     name: "Long-Term Liabilities",      type: "LIABILITY", sortOrder: 11 },
  // Equity (1)
  { key: "EQUITY",                    name: "Equity",                     type: "EQUITY",    sortOrder: 20 },
  // Revenue (6)
  { key: "MEMBERSHIP_REVENUE",        name: "Membership Revenue",         type: "REVENUE",   sortOrder: 30 },
  { key: "GOLF_OPS_REVENUE",          name: "Golf Operations Revenue",    type: "REVENUE",   sortOrder: 31 },
  { key: "FB_REVENUE",                name: "Food & Beverage Revenue",    type: "REVENUE",   sortOrder: 32 },
  { key: "EVENT_REVENUE",             name: "Event Revenue",              type: "REVENUE",   sortOrder: 33 },
  { key: "RENTAL_REVENUE",            name: "Rental Revenue",             type: "REVENUE",   sortOrder: 34 },
  { key: "OTHER_REVENUE",             name: "Other Revenue",              type: "REVENUE",   sortOrder: 35 },
  // Expenses (11)
  { key: "PAYROLL_BENEFITS",          name: "Payroll & Benefits",         type: "EXPENSE",   sortOrder: 40 },
  { key: "COST_OF_SALES",             name: "Cost of Sales",              type: "EXPENSE",   sortOrder: 41 },
  { key: "COURSE_GROUNDS",            name: "Course & Grounds",           type: "EXPENSE",   sortOrder: 42 },
  { key: "CLUBHOUSE_OPERATIONS",      name: "Clubhouse Operations",       type: "EXPENSE",   sortOrder: 43 },
  { key: "UTILITIES",                 name: "Utilities",                  type: "EXPENSE",   sortOrder: 44 },
  { key: "REPAIRS_MAINTENANCE",       name: "Repairs & Maintenance",      type: "EXPENSE",   sortOrder: 45 },
  { key: "ADMIN_EXPENSES",            name: "Administrative Expenses",    type: "EXPENSE",   sortOrder: 46 },
  { key: "PROFESSIONAL_SERVICES",     name: "Professional Services",      type: "EXPENSE",   sortOrder: 47 },
  { key: "MARKETING_MEMBER_RELATIONS",name: "Marketing & Member Relations",type:"EXPENSE",   sortOrder: 48 },
  { key: "INSURANCE",                 name: "Insurance",                  type: "EXPENSE",   sortOrder: 49 },
  { key: "OTHER_EXPENSES",            name: "Other Expenses",             type: "EXPENSE",   sortOrder: 50 },
];

// ---------------------------------------------------------------------
// CANONICAL FS GROUPS (~74)
// ---------------------------------------------------------------------
// Keys are stable + namespaced (BS_ / IS_ / CF_) so reporting
// code, AI/benchmarking pipelines, and the import templates can
// pin to them without ambiguity. Names are the operator-facing
// display labels.
export const DEFAULT_FS_GROUPS: COAFSGroupDef[] = [
  // ---- Balance Sheet → Assets (11) ----
  { key: "BS_CASH_EQUIVALENTS",   name: "Cash & Cash Equivalents",      statement: "BALANCE_SHEET", sortOrder: 1 },
  { key: "BS_AR",                 name: "Accounts Receivable",          statement: "BALANCE_SHEET", sortOrder: 2 },
  { key: "BS_MEMBER_AR",          name: "Member Receivables",           statement: "BALANCE_SHEET", sortOrder: 3 },
  { key: "BS_INVENTORY",          name: "Inventory",                    statement: "BALANCE_SHEET", sortOrder: 4 },
  { key: "BS_PREPAID_EXPENSES",   name: "Prepaid Expenses",             statement: "BALANCE_SHEET", sortOrder: 5 },
  { key: "BS_INVESTMENTS",        name: "Investments",                  statement: "BALANCE_SHEET", sortOrder: 6 },
  { key: "BS_CAPITAL_ASSETS",     name: "Capital Assets",               statement: "BALANCE_SHEET", sortOrder: 7 },
  { key: "BS_CIP",                name: "Construction in Progress",     statement: "BALANCE_SHEET", sortOrder: 8 },
  { key: "BS_ROU_ASSETS",         name: "Right-of-Use Assets",          statement: "BALANCE_SHEET", sortOrder: 9 },
  { key: "BS_INTANGIBLES",        name: "Intangible Assets",            statement: "BALANCE_SHEET", sortOrder: 10 },
  // Founder rule 2026-06-29 v3: dedicated bucket for receivables
  // that are non-current (1400-range in the standard numbering
  // convention) — share financing receivables, supplier rebates,
  // long-term loans receivable. Routes via the engine's 1400
  // sub-bracket; otherwise grouped under OTHER_ASSETS.
  { key: "BS_LONG_TERM_RECEIVABLES", name: "Long-term Receivables",     statement: "BALANCE_SHEET", sortOrder: 11 },
  { key: "BS_OTHER_ASSETS",       name: "Other Assets",                 statement: "BALANCE_SHEET", sortOrder: 12 },
  // ---- Balance Sheet → Liabilities (10) ----
  { key: "BS_AP",                 name: "Accounts Payable",             statement: "BALANCE_SHEET", sortOrder: 20 },
  { key: "BS_ACCRUED_LIABILITIES",name: "Accrued Liabilities",          statement: "BALANCE_SHEET", sortOrder: 21 },
  { key: "BS_PAYROLL_LIABILITIES",name: "Payroll Liabilities",          statement: "BALANCE_SHEET", sortOrder: 22 },
  { key: "BS_SALES_TAX_PAYABLE",  name: "Sales Tax Payable",            statement: "BALANCE_SHEET", sortOrder: 23 },
  { key: "BS_DEFERRED_REVENUE",   name: "Deferred Revenue",             statement: "BALANCE_SHEET", sortOrder: 24 },
  // Founder rule 2026-06-29 v7 — single Deposits Payable bucket
  // for share-purchase credits, waitlist deposits, member
  // deposits, external-group / event / tournament / rental /
  // banquet / damage / security deposits. Replaces the
  // separate BS_MEMBER_DEPOSITS + BS_SHARE_PURCHASE_DEPOSITS
  // buckets from v5/v6.
  { key: "BS_DEPOSITS_PAYABLE",   name: "Deposits Payable",             statement: "BALANCE_SHEET", sortOrder: 25 },
  // Founder rule 2026-06-29 v7 — generic non-debt long-term
  // liabilities bucket (gift cards, credit books, anything that
  // isn't an actual debt instrument). Replaces BS_GIFT_CARD_LIABILITY
  // from v5/v6.
  { key: "BS_LONG_TERM_LIABILITIES", name: "Long-Term Liabilities",    statement: "BALANCE_SHEET", sortOrder: 26 },
  // Founder rule 2026-06-29 v8 — custodial liabilities (funds
  // the Club holds on behalf of internal sections: Men's, Ladies,
  // Junior, Senior, Match Play, Member Guest, tournament + charity
  // funds). Carried forward year-to-year with no defined maturity.
  // Default category is LONG_TERM_LIABILITIES — clubs that spend
  // the balance within the fiscal year can reconfigure the parent
  // category without touching the auto-mapper.
  { key: "BS_SECTION_FUNDS",      name: "Section Funds",                statement: "BALANCE_SHEET", sortOrder: 27 },
  { key: "BS_DEFERRED_CAPITAL_CONTRIBUTIONS", name: "Deferred Capital Contributions", statement: "BALANCE_SHEET", sortOrder: 28 },
  { key: "BS_LEASE_LIABILITIES",  name: "Lease Liabilities",            statement: "BALANCE_SHEET", sortOrder: 29 },
  { key: "BS_LONG_TERM_DEBT",     name: "Long-Term Debt",               statement: "BALANCE_SHEET", sortOrder: 30 },
  { key: "BS_OTHER_LIABILITIES",  name: "Other Liabilities",            statement: "BALANCE_SHEET", sortOrder: 31 },
  // ---- Balance Sheet → Equity (6) ----
  { key: "BS_SHARE_CAPITAL",      name: "Share Capital",                statement: "BALANCE_SHEET", sortOrder: 40 },
  { key: "BS_RETAINED_EARNINGS",  name: "Retained Earnings",            statement: "BALANCE_SHEET", sortOrder: 41 },
  { key: "BS_CURRENT_YEAR_EARNINGS", name: "Current Year Earnings",     statement: "BALANCE_SHEET", sortOrder: 42 },
  { key: "BS_CAPITAL_RESERVE",    name: "Capital Reserve",              statement: "BALANCE_SHEET", sortOrder: 43 },
  // Reserved for future OCI accounting; surfaced now so the
  // taxonomy is stable when comprehensive-income adoption lands.
  { key: "BS_ACCUMULATED_OCI",    name: "Accumulated OCI",              statement: "BALANCE_SHEET", sortOrder: 44 },
  { key: "BS_OTHER_EQUITY",       name: "Other Equity",                 statement: "BALANCE_SHEET", sortOrder: 45 },

  // ---- Income Statement → Revenue (18) ----
  { key: "IS_MEMBERSHIP_DUES",    name: "Membership Dues",              statement: "INCOME_STATEMENT", sortOrder: 50 },
  { key: "IS_ANNUAL_FEES",        name: "Annual Fees",                  statement: "INCOME_STATEMENT", sortOrder: 51 },
  { key: "IS_ENTRANCE_FEES",      name: "Entrance Fees",                statement: "INCOME_STATEMENT", sortOrder: 52 },
  { key: "IS_CAPITAL_ASSESSMENTS",name: "Capital Assessments",          statement: "INCOME_STATEMENT", sortOrder: 53 },
  { key: "IS_GREEN_FEES",         name: "Green Fees",                   statement: "INCOME_STATEMENT", sortOrder: 54 },
  { key: "IS_CART_REVENUE",       name: "Cart Revenue",                 statement: "INCOME_STATEMENT", sortOrder: 55 },
  { key: "IS_DRIVING_RANGE",      name: "Driving Range Revenue",        statement: "INCOME_STATEMENT", sortOrder: 56 },
  { key: "IS_GOLF_LESSONS",       name: "Golf Lessons",                 statement: "INCOME_STATEMENT", sortOrder: 57 },
  { key: "IS_TOURNAMENT",         name: "Tournament Revenue",           statement: "INCOME_STATEMENT", sortOrder: 58 },
  { key: "IS_PRO_SHOP_MERCH",     name: "Pro Shop Merchandise",         statement: "INCOME_STATEMENT", sortOrder: 59 },
  { key: "IS_FOOD_SALES",         name: "Food Sales",                   statement: "INCOME_STATEMENT", sortOrder: 60 },
  { key: "IS_BEVERAGE_SALES",     name: "Beverage Sales",               statement: "INCOME_STATEMENT", sortOrder: 61 },
  { key: "IS_CATERING",           name: "Catering Revenue",             statement: "INCOME_STATEMENT", sortOrder: 62 },
  { key: "IS_EVENT_REVENUE",      name: "Event Revenue",                statement: "INCOME_STATEMENT", sortOrder: 63 },
  { key: "IS_FACILITY_RENTALS",   name: "Facility Rentals",             statement: "INCOME_STATEMENT", sortOrder: 64 },
  { key: "IS_INTEREST_INCOME",    name: "Interest Income",              statement: "INCOME_STATEMENT", sortOrder: 65 },
  { key: "IS_ASSET_GAIN_LOSS",    name: "Gain/Loss on Asset Disposal",  statement: "INCOME_STATEMENT", sortOrder: 66 },
  { key: "IS_OTHER_REVENUE",      name: "Other Revenue",                statement: "INCOME_STATEMENT", sortOrder: 67 },

  // ---- Income Statement → Expenses (29) ----
  // Founder rule 2026-06-29 v11 — financial-statement presentation
  // is "Salaries and Benefits" (single bucket combining salaries,
  // wages, vacation/stat pay, employer taxes, group benefits,
  // pension, WCB/WSIB). The OPERATIONAL Payroll module (payroll
  // runs / timesheets / remittances) keeps the name "Payroll" —
  // that's the PROCESS, not the expense category.
  { key: "IS_PAYROLL",            name: "Salaries and Benefits",        statement: "INCOME_STATEMENT", sortOrder: 70 },
  { key: "IS_COGS_MERCHANDISE",   name: "Cost of Merchandise Sold",     statement: "INCOME_STATEMENT", sortOrder: 72 },
  { key: "IS_COGS_FOOD",          name: "Cost of Food Sold",            statement: "INCOME_STATEMENT", sortOrder: 73 },
  { key: "IS_COGS_BEVERAGE",      name: "Cost of Beverage Sold",        statement: "INCOME_STATEMENT", sortOrder: 74 },
  { key: "IS_UTILITIES",          name: "Utilities",                    statement: "INCOME_STATEMENT", sortOrder: 75 },
  { key: "IS_REPAIRS_MAINTENANCE",name: "Repairs & Maintenance",        statement: "INCOME_STATEMENT", sortOrder: 76 },
  { key: "IS_PROPERTY_TAX",       name: "Property Tax Expense",         statement: "INCOME_STATEMENT", sortOrder: 77 },
  { key: "IS_INCOME_TAX",         name: "Income Tax Expense",           statement: "INCOME_STATEMENT", sortOrder: 78 },
  { key: "IS_INSURANCE",          name: "Insurance",                    statement: "INCOME_STATEMENT", sortOrder: 79 },
  { key: "IS_OFFICE_SUPPLIES",    name: "Office Supplies",              statement: "INCOME_STATEMENT", sortOrder: 80 },
  { key: "IS_PROFESSIONAL_FEES",  name: "Professional Fees",            statement: "INCOME_STATEMENT", sortOrder: 81 },
  { key: "IS_IT_SOFTWARE",        name: "IT & Software",                statement: "INCOME_STATEMENT", sortOrder: 82 },
  { key: "IS_TELEPHONE_INTERNET", name: "Telephone & Internet",         statement: "INCOME_STATEMENT", sortOrder: 83 },
  { key: "IS_BANK_CHARGES",       name: "Bank Charges",                 statement: "INCOME_STATEMENT", sortOrder: 84 },
  { key: "IS_MERCHANT_FEES",      name: "Merchant Fees",                statement: "INCOME_STATEMENT", sortOrder: 85 },
  { key: "IS_VEHICLE_EQUIPMENT",  name: "Vehicle & Equipment",          statement: "INCOME_STATEMENT", sortOrder: 86 },
  { key: "IS_SMALL_TOOLS",        name: "Small Tools",                  statement: "INCOME_STATEMENT", sortOrder: 87 },
  { key: "IS_JANITORIAL_SUPPLIES",name: "Janitorial Supplies",          statement: "INCOME_STATEMENT", sortOrder: 88 },
  { key: "IS_CLEANING_SERVICES",  name: "Cleaning Services",            statement: "INCOME_STATEMENT", sortOrder: 89 },
  { key: "IS_SECURITY",           name: "Security",                     statement: "INCOME_STATEMENT", sortOrder: 90 },
  { key: "IS_STAFF_TRAINING",     name: "Staff Training",               statement: "INCOME_STATEMENT", sortOrder: 91 },
  { key: "IS_MARKETING_ADVERTISING", name: "Marketing & Advertising",   statement: "INCOME_STATEMENT", sortOrder: 92 },
  { key: "IS_TRAVEL_MEALS",       name: "Travel & Meals",               statement: "INCOME_STATEMENT", sortOrder: 93 },
  { key: "IS_MEMBERSHIPS_SUBS",   name: "Memberships & Subscriptions",  statement: "INCOME_STATEMENT", sortOrder: 94 },
  { key: "IS_LICENCES_PERMITS",   name: "Licences & Permits",           statement: "INCOME_STATEMENT", sortOrder: 95 },
  { key: "IS_DEPRECIATION",       name: "Depreciation & Amortization",  statement: "INCOME_STATEMENT", sortOrder: 96 },
  { key: "IS_INTEREST_EXPENSE",   name: "Interest Expense",             statement: "INCOME_STATEMENT", sortOrder: 97 },
  { key: "IS_OTHER_EXPENSES",     name: "Other Expenses",               statement: "INCOME_STATEMENT", sortOrder: 98 },

  // ---- Cash Flow (3) — orthogonal to BS / IS classification ----
  { key: "CF_OPERATING", name: "Operating Activities", statement: "CASH_FLOW", cashFlowSection: "OPERATING", sortOrder: 100 },
  { key: "CF_INVESTING", name: "Investing Activities", statement: "CASH_FLOW", cashFlowSection: "INVESTING", sortOrder: 101 },
  { key: "CF_FINANCING", name: "Financing Activities", statement: "CASH_FLOW", cashFlowSection: "FINANCING", sortOrder: 102 },
];

// Keys retired during the founder's various taxonomy passes —
// asserted absent from DEFAULT_FS_GROUPS by tests so we don't
// re-introduce them by accident.
export const RETIRED_FS_GROUP_KEYS = [
  // 2026-07-02 retirement — department labels that had leaked
  // into the FS Group taxonomy.
  "IS_OPEX_GOLF",
  "IS_OPEX_COURSE",
  "IS_OPEX_PROSHOP",
  "IS_OPEX_FB",
  "IS_OPEX_CLUBHOUSE",
  "IS_OPEX_ADMIN",
  // 2026-07-19 retirement — the legacy operational/reporting
  // FS Groups replaced by the canonical taxonomy.
  "BS_CURRENT_ASSETS",
  "BS_FIXED_ASSETS",
  "BS_CURRENT_LIABILITIES",
  "BS_DEFERRED_CONTRIBUTIONS",
  // NOTE: BS_LONG_TERM_LIABILITIES was retired in 2026-07-19
  // but RE-INTRODUCED as a current canonical key in 2026-06-29 v7
  // (the "Long-Term Liabilities" non-debt bucket — gift cards,
  // credit books, incentive balances). Do NOT list it here again
  // — the soft-GC loop would delete the newly-upserted FS Group
  // and validation would reject any account that lands on it.
  "BS_EQUITY",
  "IS_REVENUE_MEMBERSHIP",
  "IS_REVENUE_GUEST_FEE",
  "IS_REVENUE_CART",
  "IS_REVENUE_FB",
  "IS_REVENUE_PROSHOP",
  "IS_REVENUE_OTHER",
  "IS_COGS",
  "IS_OPEX_WAGES",
  "IS_OPEX_RM",
  "IS_OPEX_OFFICE",
  "IS_OPEX_UTILITIES",
  "IS_OPEX_INSURANCE",
  "IS_OPEX_PROFESSIONAL",
  "IS_OPEX_MARKETING",
  "IS_OPEX_MEMBER_EVENTS",
  "IS_OPEX_TOURNAMENT",
  "IS_OPEX_COURSE_SUPPLIES",
  "IS_OPEX_EQUIPMENT_RENTAL",
  "IS_OPEX_EQUIPMENT_REPAIRS",
  "IS_OPEX_CLEANING",
  "IS_OPEX_BANK_FEES",
  "IS_OPEX_LICENSES",
  "IS_OPEX_BAD_DEBT",
  "IS_OPEX_SHRINKAGE",
  "IS_OPEX_DEPRECIATION",
  "IS_OPEX_INTEREST",
  "IS_OPEX_INCOME_TAX",
  "IS_OPEX_PROPERTY_TAX",
  "IS_OPEX_OTHER",
  // 2026-06-29 v7 retirement — founder's correction to v5/v6.
  // Credit cards go to AP; gift cards / credit books go to a
  // generic Long-Term Liabilities bucket; every deposit kind
  // consolidates into Deposits Payable.
  "BS_CREDIT_CARDS_PAYABLE",
  "BS_GIFT_CARD_LIABILITY",
  "BS_SHARE_PURCHASE_DEPOSITS",
  "BS_MEMBER_DEPOSITS",
  // 2026-06-29 v11 retirement — IS_EMPLOYEE_BENEFITS consolidated
  // into the renamed IS_PAYROLL ("Salaries and Benefits"). The
  // financial-statement presentation puts salaries + employer
  // taxes + group benefits in a single line.
  "IS_EMPLOYEE_BENEFITS",
] as const;

// ---------------------------------------------------------------------
// LEGACY MIGRATION MAP
// ---------------------------------------------------------------------
// For each retired FS Group key, the new canonical key + the
// new Category key its referencing accounts should re-anchor to.
// Used by syncCanonicalAccountingTaxonomy() to migrate existing
// account rows without a per-row decision.
export const LEGACY_FS_GROUP_MIGRATION: Record<string, { newFsGroupKey: string; newCategoryKey: string }> = {
  // Balance Sheet — Assets.
  BS_CURRENT_ASSETS:    { newFsGroupKey: "BS_OTHER_ASSETS",       newCategoryKey: "CURRENT_ASSETS" },
  BS_FIXED_ASSETS:      { newFsGroupKey: "BS_CAPITAL_ASSETS",     newCategoryKey: "CAPITAL_ASSETS" },
  BS_OTHER_ASSETS:      { newFsGroupKey: "BS_OTHER_ASSETS",       newCategoryKey: "OTHER_ASSETS" },
  // Balance Sheet — Liabilities.
  BS_CURRENT_LIABILITIES:    { newFsGroupKey: "BS_OTHER_LIABILITIES", newCategoryKey: "CURRENT_LIABILITIES" },
  BS_DEFERRED_CONTRIBUTIONS: { newFsGroupKey: "BS_DEFERRED_REVENUE",  newCategoryKey: "CURRENT_LIABILITIES" },
  // BS_LONG_TERM_LIABILITIES migration removed in 2026-06-29 v10
  // — the key was re-introduced as a current canonical FS Group
  // in v7 with new semantics (non-debt long-term: gift cards,
  // credit books). A legacy migration here would silently
  // re-target every v7+ Gift Card account back to BS_LONG_TERM_DEBT
  // on the next sync.
  // Balance Sheet — Equity.
  BS_EQUITY:            { newFsGroupKey: "BS_RETAINED_EARNINGS",  newCategoryKey: "EQUITY" },
  // Revenue.
  IS_REVENUE_MEMBERSHIP:{ newFsGroupKey: "IS_MEMBERSHIP_DUES",    newCategoryKey: "MEMBERSHIP_REVENUE" },
  IS_REVENUE_GUEST_FEE: { newFsGroupKey: "IS_GREEN_FEES",         newCategoryKey: "GOLF_OPS_REVENUE" },
  IS_REVENUE_CART:      { newFsGroupKey: "IS_CART_REVENUE",       newCategoryKey: "GOLF_OPS_REVENUE" },
  IS_REVENUE_FB:        { newFsGroupKey: "IS_FOOD_SALES",         newCategoryKey: "FB_REVENUE" },
  IS_REVENUE_PROSHOP:   { newFsGroupKey: "IS_PRO_SHOP_MERCH",     newCategoryKey: "GOLF_OPS_REVENUE" },
  IS_REVENUE_OTHER:     { newFsGroupKey: "IS_OTHER_REVENUE",      newCategoryKey: "OTHER_REVENUE" },
  // COGS.
  IS_COGS:              { newFsGroupKey: "IS_COGS_MERCHANDISE",   newCategoryKey: "COST_OF_SALES" },
  // Operating expenses.
  IS_OPEX_WAGES:        { newFsGroupKey: "IS_PAYROLL",            newCategoryKey: "PAYROLL_BENEFITS" },
  IS_OPEX_RM:           { newFsGroupKey: "IS_REPAIRS_MAINTENANCE",newCategoryKey: "REPAIRS_MAINTENANCE" },
  IS_OPEX_OFFICE:       { newFsGroupKey: "IS_OFFICE_SUPPLIES",    newCategoryKey: "ADMIN_EXPENSES" },
  IS_OPEX_UTILITIES:    { newFsGroupKey: "IS_UTILITIES",          newCategoryKey: "UTILITIES" },
  IS_OPEX_INSURANCE:    { newFsGroupKey: "IS_INSURANCE",          newCategoryKey: "INSURANCE" },
  IS_OPEX_PROFESSIONAL: { newFsGroupKey: "IS_PROFESSIONAL_FEES",  newCategoryKey: "PROFESSIONAL_SERVICES" },
  IS_OPEX_MARKETING:    { newFsGroupKey: "IS_MARKETING_ADVERTISING", newCategoryKey: "MARKETING_MEMBER_RELATIONS" },
  IS_OPEX_MEMBER_EVENTS:{ newFsGroupKey: "IS_MARKETING_ADVERTISING", newCategoryKey: "MARKETING_MEMBER_RELATIONS" },
  IS_OPEX_TOURNAMENT:   { newFsGroupKey: "IS_OTHER_EXPENSES",     newCategoryKey: "OTHER_EXPENSES" },
  IS_OPEX_COURSE_SUPPLIES: { newFsGroupKey: "IS_SMALL_TOOLS",     newCategoryKey: "COURSE_GROUNDS" },
  IS_OPEX_EQUIPMENT_RENTAL: { newFsGroupKey: "IS_VEHICLE_EQUIPMENT", newCategoryKey: "REPAIRS_MAINTENANCE" },
  IS_OPEX_EQUIPMENT_REPAIRS: { newFsGroupKey: "IS_VEHICLE_EQUIPMENT", newCategoryKey: "REPAIRS_MAINTENANCE" },
  IS_OPEX_CLEANING:     { newFsGroupKey: "IS_CLEANING_SERVICES",  newCategoryKey: "CLUBHOUSE_OPERATIONS" },
  IS_OPEX_BANK_FEES:    { newFsGroupKey: "IS_BANK_CHARGES",       newCategoryKey: "ADMIN_EXPENSES" },
  IS_OPEX_LICENSES:     { newFsGroupKey: "IS_LICENCES_PERMITS",   newCategoryKey: "ADMIN_EXPENSES" },
  IS_OPEX_BAD_DEBT:     { newFsGroupKey: "IS_OTHER_EXPENSES",     newCategoryKey: "OTHER_EXPENSES" },
  IS_OPEX_SHRINKAGE:    { newFsGroupKey: "IS_OTHER_EXPENSES",     newCategoryKey: "OTHER_EXPENSES" },
  IS_OPEX_DEPRECIATION: { newFsGroupKey: "IS_DEPRECIATION",       newCategoryKey: "OTHER_EXPENSES" },
  IS_OPEX_INTEREST:     { newFsGroupKey: "IS_INTEREST_EXPENSE",   newCategoryKey: "OTHER_EXPENSES" },
  IS_OPEX_INCOME_TAX:   { newFsGroupKey: "IS_INCOME_TAX",         newCategoryKey: "OTHER_EXPENSES" },
  IS_OPEX_PROPERTY_TAX: { newFsGroupKey: "IS_PROPERTY_TAX",       newCategoryKey: "OTHER_EXPENSES" },
  IS_OPEX_OTHER:        { newFsGroupKey: "IS_OTHER_EXPENSES",     newCategoryKey: "OTHER_EXPENSES" },
  // 2026-06-29 v7 — credit cards / gift cards / deposits.
  BS_CREDIT_CARDS_PAYABLE: { newFsGroupKey: "BS_AP",                  newCategoryKey: "CURRENT_LIABILITIES" },
  BS_GIFT_CARD_LIABILITY:  { newFsGroupKey: "BS_LONG_TERM_LIABILITIES", newCategoryKey: "LONG_TERM_LIABILITIES" },
  BS_SHARE_PURCHASE_DEPOSITS: { newFsGroupKey: "BS_DEPOSITS_PAYABLE", newCategoryKey: "LONG_TERM_LIABILITIES" },
  BS_MEMBER_DEPOSITS:      { newFsGroupKey: "BS_DEPOSITS_PAYABLE",   newCategoryKey: "LONG_TERM_LIABILITIES" },
  // 2026-06-29 v11 — Employee Benefits consolidated into Salaries
  // and Benefits (renamed IS_PAYROLL). Existing accounts on
  // IS_EMPLOYEE_BENEFITS roll up into IS_PAYROLL on next sync.
  IS_EMPLOYEE_BENEFITS:    { newFsGroupKey: "IS_PAYROLL",            newCategoryKey: "PAYROLL_BENEFITS" },
};

// Legacy Category keys → new canonical Category keys (for the
// rare account that has a stale category WITHOUT a stale FS
// group). Tables above are the primary path; this is fallback.
export const LEGACY_CATEGORY_MIGRATION: Record<string, string> = {
  LONG_TERM_ASSETS:   "CAPITAL_ASSETS",
  OPERATING_REVENUE:  "OTHER_REVENUE",
  OPERATING_EXPENSES: "OTHER_EXPENSES",
};

// ---------------------------------------------------------------------
// DEPARTMENTS (founder spec 2026-07-02 + 2026-07-19 future-reserve)
// ---------------------------------------------------------------------
export type COADepartmentDef = { code: string; name: string; sortOrder?: number };
export const DEFAULT_DEPARTMENTS: COADepartmentDef[] = [
  { code: "ADMIN",     name: "Administration", sortOrder: 1 },
  { code: "PROSHOP",   name: "Pro Shop",       sortOrder: 2 },
  { code: "GROUNDS",   name: "Grounds",        sortOrder: 3 },
  { code: "CLUBHOUSE", name: "Clubhouse",      sortOrder: 4 },
  { code: "F&B",       name: "Food & Beverage",sortOrder: 5 },
  { code: "EVENTS",    name: "Events",         sortOrder: 6 },
];

// Reserved for future expansion — kept here as a forward-looking
// reference. NOT seeded automatically; clubs that need them add
// via the admin Departments page.
export const FUTURE_DEPARTMENT_CODES = [
  "FITNESS",
  "RACQUETS",
  "CURLING",
  "AQUATICS",
  "MARINA",
  "SKI_HILL",
  "HOTEL",
  "SPA",
] as const;

export const RETIRED_DEPARTMENT_CODES = ["GOLF", "COURSE", "FB"] as const;
export const DEPARTMENT_CODE_ALIASES: Record<string, string> = {
  GOLF: "PROSHOP",
  COURSE: "GROUNDS",
  FB: "F&B",
};

// ---------------------------------------------------------------------
// SEED ACCOUNTS
// ---------------------------------------------------------------------
// A starter Chart of Accounts wired to the canonical taxonomy.
// Every entry is a posting account (founder rule 2026-07-08).
export const DEFAULT_ACCOUNTS: COAAccountDef[] = [
  // ----- Assets -----
  { accountNumber: "1000", name: "Cash & Bank",                  type: "ASSET", categoryKey: "CURRENT_ASSETS", fsGroupKey: "BS_CASH_EQUIVALENTS" },
  { accountNumber: "1010", name: "Operating Bank Account",       type: "ASSET", categoryKey: "CURRENT_ASSETS", parentAccountNumber: "1000", fsGroupKey: "BS_CASH_EQUIVALENTS", isBankAccount: true, isCashAccount: true },
  { accountNumber: "1020", name: "Reserve Account",              type: "ASSET", categoryKey: "CURRENT_ASSETS", parentAccountNumber: "1000", fsGroupKey: "BS_CASH_EQUIVALENTS", isBankAccount: true, isCashAccount: true },
  { accountNumber: "1050", name: "Petty Cash",                   type: "ASSET", categoryKey: "CURRENT_ASSETS", parentAccountNumber: "1000", fsGroupKey: "BS_CASH_EQUIVALENTS", isCashAccount: true },

  { accountNumber: "1100", name: "Accounts Receivable",          type: "ASSET", categoryKey: "CURRENT_ASSETS", fsGroupKey: "BS_AR" },
  { accountNumber: "1110", name: "Member AR (Control)",          type: "ASSET", categoryKey: "CURRENT_ASSETS", parentAccountNumber: "1100", fsGroupKey: "BS_MEMBER_AR", isControlAccount: true, allowManualPosting: false },
  { accountNumber: "1120", name: "Other AR",                     type: "ASSET", categoryKey: "CURRENT_ASSETS", parentAccountNumber: "1100", fsGroupKey: "BS_AR" },

  { accountNumber: "1200", name: "Inventory",                    type: "ASSET", categoryKey: "CURRENT_ASSETS", fsGroupKey: "BS_INVENTORY" },
  { accountNumber: "1210", name: "Pro Shop Inventory",           type: "ASSET", categoryKey: "CURRENT_ASSETS", parentAccountNumber: "1200", fsGroupKey: "BS_INVENTORY" },
  { accountNumber: "1220", name: "F&B Inventory",                type: "ASSET", categoryKey: "CURRENT_ASSETS", parentAccountNumber: "1200", fsGroupKey: "BS_INVENTORY" },

  { accountNumber: "1300", name: "Prepaid Expenses",             type: "ASSET", categoryKey: "CURRENT_ASSETS", fsGroupKey: "BS_PREPAID_EXPENSES" },
  { accountNumber: "1310", name: "GST Input Tax Credit",         type: "ASSET", categoryKey: "CURRENT_ASSETS", fsGroupKey: "BS_PREPAID_EXPENSES", isTaxRelevant: true },

  { accountNumber: "1400", name: "Member Share Financing Receivable", type: "ASSET", categoryKey: "OTHER_ASSETS",   fsGroupKey: "BS_OTHER_ASSETS" },
  { accountNumber: "1410", name: "Financing Receivable — Current",    type: "ASSET", categoryKey: "CURRENT_ASSETS", parentAccountNumber: "1400", fsGroupKey: "BS_AR" },
  { accountNumber: "1420", name: "Financing Receivable — Long-term",  type: "ASSET", categoryKey: "OTHER_ASSETS",   parentAccountNumber: "1400", fsGroupKey: "BS_OTHER_ASSETS" },

  { accountNumber: "1500", name: "Property & Equipment",         type: "ASSET", categoryKey: "CAPITAL_ASSETS", fsGroupKey: "BS_CAPITAL_ASSETS" },
  { accountNumber: "1510", name: "Land",                         type: "ASSET", categoryKey: "CAPITAL_ASSETS", parentAccountNumber: "1500", fsGroupKey: "BS_CAPITAL_ASSETS" },
  { accountNumber: "1520", name: "Buildings",                    type: "ASSET", categoryKey: "CAPITAL_ASSETS", parentAccountNumber: "1500", fsGroupKey: "BS_CAPITAL_ASSETS" },
  { accountNumber: "1525", name: "Accumulated Depreciation — Buildings", type: "ASSET", categoryKey: "CAPITAL_ASSETS", parentAccountNumber: "1500", fsGroupKey: "BS_CAPITAL_ASSETS" },
  { accountNumber: "1530", name: "Course Improvements",          type: "ASSET", categoryKey: "CAPITAL_ASSETS", parentAccountNumber: "1500", fsGroupKey: "BS_CAPITAL_ASSETS" },
  { accountNumber: "1540", name: "Equipment & Vehicles",         type: "ASSET", categoryKey: "CAPITAL_ASSETS", parentAccountNumber: "1500", fsGroupKey: "BS_CAPITAL_ASSETS" },
  { accountNumber: "1545", name: "Accumulated Depreciation — Equipment", type: "ASSET", categoryKey: "CAPITAL_ASSETS", parentAccountNumber: "1500", fsGroupKey: "BS_CAPITAL_ASSETS" },

  // ----- Liabilities -----
  { accountNumber: "2000", name: "Accounts Payable",             type: "LIABILITY", categoryKey: "CURRENT_LIABILITIES", fsGroupKey: "BS_AP" },
  { accountNumber: "2010", name: "Trade AP (Control)",           type: "LIABILITY", categoryKey: "CURRENT_LIABILITIES", parentAccountNumber: "2000", fsGroupKey: "BS_AP", isControlAccount: true, allowManualPosting: false },
  { accountNumber: "2020", name: "Accrued Liabilities",          type: "LIABILITY", categoryKey: "CURRENT_LIABILITIES", parentAccountNumber: "2000", fsGroupKey: "BS_ACCRUED_LIABILITIES" },
  { accountNumber: "2030", name: "Accrued Payroll",              type: "LIABILITY", categoryKey: "CURRENT_LIABILITIES", parentAccountNumber: "2000", fsGroupKey: "BS_PAYROLL_LIABILITIES" },
  { accountNumber: "2035", name: "Accrued Vacation",             type: "LIABILITY", categoryKey: "CURRENT_LIABILITIES", parentAccountNumber: "2000", fsGroupKey: "BS_PAYROLL_LIABILITIES" },
  { accountNumber: "2040", name: "Accrued Source Deductions",    type: "LIABILITY", categoryKey: "CURRENT_LIABILITIES", parentAccountNumber: "2000", fsGroupKey: "BS_PAYROLL_LIABILITIES" },
  { accountNumber: "2050", name: "Goods Received Not Invoiced",  type: "LIABILITY", categoryKey: "CURRENT_LIABILITIES", parentAccountNumber: "2000", fsGroupKey: "BS_ACCRUED_LIABILITIES", isControlAccount: true, allowManualPosting: false },
  { accountNumber: "2060", name: "Accrued Lesson Payable",       type: "LIABILITY", categoryKey: "CURRENT_LIABILITIES", parentAccountNumber: "2000", fsGroupKey: "BS_ACCRUED_LIABILITIES" },

  { accountNumber: "2100", name: "Sales Taxes Payable",          type: "LIABILITY", categoryKey: "CURRENT_LIABILITIES", fsGroupKey: "BS_SALES_TAX_PAYABLE" },
  { accountNumber: "2110", name: "GST Collected",                type: "LIABILITY", categoryKey: "CURRENT_LIABILITIES", parentAccountNumber: "2100", fsGroupKey: "BS_SALES_TAX_PAYABLE", isTaxRelevant: true },

  { accountNumber: "2200", name: "Deferred Revenue",             type: "LIABILITY", categoryKey: "CURRENT_LIABILITIES", fsGroupKey: "BS_DEFERRED_REVENUE" },
  { accountNumber: "2210", name: "Dues — Deferred",              type: "LIABILITY", categoryKey: "CURRENT_LIABILITIES", parentAccountNumber: "2200", fsGroupKey: "BS_DEFERRED_REVENUE" },
  { accountNumber: "2220", name: "Event Deposits",               type: "LIABILITY", categoryKey: "CURRENT_LIABILITIES", parentAccountNumber: "2200", fsGroupKey: "BS_DEPOSITS_PAYABLE" },
  { accountNumber: "2230", name: "Private Event Deposits",       type: "LIABILITY", categoryKey: "CURRENT_LIABILITIES", parentAccountNumber: "2200", fsGroupKey: "BS_DEPOSITS_PAYABLE" },

  { accountNumber: "2400", name: "Deferred Capital Contributions", type: "LIABILITY", categoryKey: "LONG_TERM_LIABILITIES", fsGroupKey: "BS_OTHER_LIABILITIES" },
  { accountNumber: "2500", name: "Long-term Debt",                 type: "LIABILITY", categoryKey: "LONG_TERM_LIABILITIES", fsGroupKey: "BS_LONG_TERM_DEBT" },

  // ----- Equity -----
  { accountNumber: "3000", name: "Member Shares",                type: "EQUITY", categoryKey: "EQUITY", fsGroupKey: "BS_SHARE_CAPITAL" },
  { accountNumber: "3100", name: "Retained Earnings",            type: "EQUITY", categoryKey: "EQUITY", fsGroupKey: "BS_RETAINED_EARNINGS", allowManualPosting: false },
  { accountNumber: "3200", name: "Current-Year Earnings",        type: "EQUITY", categoryKey: "EQUITY", fsGroupKey: "BS_CURRENT_YEAR_EARNINGS", allowManualPosting: false },

  // ----- Revenue -----
  { accountNumber: "4000", name: "Membership Dues",              type: "REVENUE", categoryKey: "MEMBERSHIP_REVENUE", fsGroupKey: "IS_MEMBERSHIP_DUES",       defaultDepartmentCode: "ADMIN" },
  { accountNumber: "4010", name: "Initiation Fees",              type: "REVENUE", categoryKey: "MEMBERSHIP_REVENUE", fsGroupKey: "IS_ENTRANCE_FEES",         defaultDepartmentCode: "ADMIN" },
  { accountNumber: "4020", name: "Capital Assessments",          type: "REVENUE", categoryKey: "MEMBERSHIP_REVENUE", fsGroupKey: "IS_CAPITAL_ASSESSMENTS",   defaultDepartmentCode: "ADMIN" },
  { accountNumber: "4100", name: "Greens & Guest Fees",          type: "REVENUE", categoryKey: "GOLF_OPS_REVENUE",   fsGroupKey: "IS_GREEN_FEES",            defaultDepartmentCode: "PROSHOP" },
  { accountNumber: "4110", name: "Cart & Range Fees",            type: "REVENUE", categoryKey: "GOLF_OPS_REVENUE",   fsGroupKey: "IS_CART_REVENUE",          defaultDepartmentCode: "PROSHOP" },
  { accountNumber: "4200", name: "F&B — Dining",                 type: "REVENUE", categoryKey: "FB_REVENUE",         fsGroupKey: "IS_FOOD_SALES",            defaultDepartmentCode: "F&B" },
  { accountNumber: "4210", name: "F&B — Banquets/Events",        type: "REVENUE", categoryKey: "EVENT_REVENUE",      fsGroupKey: "IS_EVENT_REVENUE",         defaultDepartmentCode: "EVENTS" },
  { accountNumber: "4300", name: "Pro Shop Revenue",             type: "REVENUE", categoryKey: "GOLF_OPS_REVENUE",   fsGroupKey: "IS_PRO_SHOP_MERCH",        defaultDepartmentCode: "PROSHOP" },
  { accountNumber: "4400", name: "Lesson Revenue",               type: "REVENUE", categoryKey: "GOLF_OPS_REVENUE",   fsGroupKey: "IS_GOLF_LESSONS",          defaultDepartmentCode: "PROSHOP" },
  { accountNumber: "4500", name: "Event Revenue",                type: "REVENUE", categoryKey: "EVENT_REVENUE",      fsGroupKey: "IS_EVENT_REVENUE",         defaultDepartmentCode: "EVENTS" },
  { accountNumber: "4900", name: "Other Revenue",                type: "REVENUE", categoryKey: "OTHER_REVENUE",      fsGroupKey: "IS_OTHER_REVENUE" },
  { accountNumber: "4950", name: "Interest Income — Financing",  type: "REVENUE", categoryKey: "OTHER_REVENUE",      fsGroupKey: "IS_INTEREST_INCOME" },

  // ----- COGS -----
  { accountNumber: "5000", name: "Cost of Sales — F&B",          type: "EXPENSE", categoryKey: "COST_OF_SALES", fsGroupKey: "IS_COGS_FOOD",        defaultDepartmentCode: "F&B" },
  { accountNumber: "5100", name: "Cost of Sales — Pro Shop",     type: "EXPENSE", categoryKey: "COST_OF_SALES", fsGroupKey: "IS_COGS_MERCHANDISE", defaultDepartmentCode: "PROSHOP" },

  // ----- Operating expenses -----
  { accountNumber: "6000", name: "Course Salaries & Wages",      type: "EXPENSE", categoryKey: "PAYROLL_BENEFITS",      fsGroupKey: "IS_PAYROLL",              defaultDepartmentCode: "GROUNDS" },
  { accountNumber: "6010", name: "Course Supplies & Materials",  type: "EXPENSE", categoryKey: "COURSE_GROUNDS",        fsGroupKey: "IS_SMALL_TOOLS",          defaultDepartmentCode: "GROUNDS" },
  { accountNumber: "6020", name: "Course Equipment R&M",         type: "EXPENSE", categoryKey: "REPAIRS_MAINTENANCE",   fsGroupKey: "IS_VEHICLE_EQUIPMENT",    defaultDepartmentCode: "GROUNDS" },

  { accountNumber: "6100", name: "Pro Shop Salaries & Wages",    type: "EXPENSE", categoryKey: "PAYROLL_BENEFITS",      fsGroupKey: "IS_PAYROLL",              defaultDepartmentCode: "PROSHOP" },

  { accountNumber: "6200", name: "F&B Salaries & Wages",         type: "EXPENSE", categoryKey: "PAYROLL_BENEFITS",      fsGroupKey: "IS_PAYROLL",              defaultDepartmentCode: "F&B" },
  { accountNumber: "6210", name: "F&B Supplies",                 type: "EXPENSE", categoryKey: "OTHER_EXPENSES",        fsGroupKey: "IS_OTHER_EXPENSES",       defaultDepartmentCode: "F&B" },

  { accountNumber: "6300", name: "Clubhouse Salaries & Wages",   type: "EXPENSE", categoryKey: "PAYROLL_BENEFITS",      fsGroupKey: "IS_PAYROLL",              defaultDepartmentCode: "CLUBHOUSE" },
  { accountNumber: "6310", name: "Clubhouse Utilities",          type: "EXPENSE", categoryKey: "UTILITIES",             fsGroupKey: "IS_UTILITIES",            defaultDepartmentCode: "CLUBHOUSE" },
  { accountNumber: "6320", name: "Clubhouse R&M",                type: "EXPENSE", categoryKey: "REPAIRS_MAINTENANCE",   fsGroupKey: "IS_REPAIRS_MAINTENANCE",  defaultDepartmentCode: "CLUBHOUSE" },

  { accountNumber: "6400", name: "Admin Salaries & Wages",       type: "EXPENSE", categoryKey: "PAYROLL_BENEFITS",      fsGroupKey: "IS_PAYROLL",              defaultDepartmentCode: "ADMIN" },
  { accountNumber: "6410", name: "Office & Administration",      type: "EXPENSE", categoryKey: "ADMIN_EXPENSES",        fsGroupKey: "IS_OFFICE_SUPPLIES",      defaultDepartmentCode: "ADMIN" },
  { accountNumber: "6420", name: "Professional Fees",            type: "EXPENSE", categoryKey: "PROFESSIONAL_SERVICES", fsGroupKey: "IS_PROFESSIONAL_FEES",    defaultDepartmentCode: "ADMIN" },
  { accountNumber: "6430", name: "Insurance",                    type: "EXPENSE", categoryKey: "INSURANCE",             fsGroupKey: "IS_INSURANCE",            defaultDepartmentCode: "ADMIN" },
  { accountNumber: "6440", name: "Marketing & Communications",   type: "EXPENSE", categoryKey: "MARKETING_MEMBER_RELATIONS", fsGroupKey: "IS_MARKETING_ADVERTISING", defaultDepartmentCode: "ADMIN" },
  { accountNumber: "6500", name: "Bad Debt Expense",             type: "EXPENSE", categoryKey: "OTHER_EXPENSES",        fsGroupKey: "IS_OTHER_EXPENSES",       defaultDepartmentCode: "ADMIN" },
  { accountNumber: "6900", name: "Depreciation Expense",         type: "EXPENSE", categoryKey: "OTHER_EXPENSES",        fsGroupKey: "IS_DEPRECIATION",         defaultDepartmentCode: "ADMIN" },
  { accountNumber: "6910", name: "Interest Expense",             type: "EXPENSE", categoryKey: "OTHER_EXPENSES",        fsGroupKey: "IS_INTEREST_EXPENSE",     defaultDepartmentCode: "ADMIN" },
];

// ---------------------------------------------------------------------
// AR adapter mapping
// ---------------------------------------------------------------------
export const AR_CATEGORY_TO_REVENUE: Record<string, string> = {
  DUES: "4000",
  INITIATION_FEE: "4010",
  CAPITAL_ASSESSMENT: "4020",
  PRO_SHOP: "4300",
  FOOD_BEVERAGE: "4200",
  EVENT: "4500",
  FINANCING: "4950",
  ADJUSTMENT: "4900",
  OTHER: "4900",
};
