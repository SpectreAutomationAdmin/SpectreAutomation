// COA-MAP-1 (2026-10-06) — reporting-role taxonomy.
//
// Presentation-only semantic role (Decision 2 Option A). This is
// what tenant-created groups opt into so they can participate in
// reporting without a hardcoded `fsGroupKey` string. Role is
// orthogonal to:
//   - `Account.type` (ASSET / LIABILITY / EQUITY / REVENUE / EXPENSE)
//     — accounting classification; unchanged by role.
//   - `Account.fundApplicability` / `AccountFund` — Operating vs
//     Capital partition; unchanged by role.
//   - `FinancialStatementGroup.statement` — which statement the
//     group participates in; role is a FINER classification within
//     that statement.
//
// Null role means the group has not yet been classified — new
// tenant-created groups default to null until the Controller
// selects on save. Reports that depend on a role treat null groups
// as "unmapped presentation" and surface them in the attention
// queue, never silently misclassify.

export const REPORTING_ROLES = [
  // Income Statement
  "OPERATING_REVENUE",
  "MEMBERSHIP_DUES",
  "COGS",
  "PAYROLL",
  "OPERATING_EXPENSE",
  "DEPRECIATION",
  "INTEREST_EXPENSE",
  "FINANCING_OTHER",
  "INTEREST_INCOME",
  "OTHER_INCOME",
  "OTHER_EXPENSE",
  "CAPITAL_ASSESSMENTS",
  "ENTRANCE_FEES",
  "CAPITAL_FUND_OTHER_REVENUE",
  // Balance Sheet
  "CASH",
  "ACCOUNTS_RECEIVABLE",
  "INVENTORY",
  "PREPAIDS",
  "CAPITAL_ASSETS",
  "ACCUMULATED_DEPRECIATION",
  "OTHER_ASSETS",
  "ACCOUNTS_PAYABLE",
  "ACCRUED_LIABILITIES",
  "DEFERRED_REVENUE",
  "DEBT",
  "CAPITAL_RESERVE",
  "DEFERRED_CAPITAL_CONTRIBUTIONS",
  "OTHER_LIABILITIES",
  "SHARE_CAPITAL",
  "CONTRIBUTED_SURPLUS",
  "RETAINED_EARNINGS",
  "OTHER_EQUITY",
  // Generic — tenant-created groups that do not fit a canonical role
  // may select OTHER. Reports surface OTHER groups as "unmapped
  // presentation" in the attention queue; they do NOT contribute to
  // any canonical consolidated metric until a role is selected.
  "OTHER",
] as const;

export type ReportingRole = (typeof REPORTING_ROLES)[number];

export function isReportingRole(v: string | null | undefined): v is ReportingRole {
  if (v == null) return false;
  return (REPORTING_ROLES as ReadonlyArray<string>).includes(v);
}

/**
 * Deterministic backfill — maps a seeded Spectre default fsGroupKey
 * to its canonical reporting role. Any key not in this map returns
 * null (role will be filled in by future audit when the group's
 * semantic becomes clear).
 *
 * The backfill script walks every FinancialStatementGroup row and
 * sets `reportingRole = defaultRoleForFsGroupKey(group.key)` where
 * non-null. This is purely metadata — no account mapping changes,
 * no accounting classification changes.
 */
export function defaultRoleForFsGroupKey(key: string): ReportingRole | null {
  // Income Statement
  if (key === "IS_OPERATING_REVENUE" || key === "OPERATING_REVENUE") return "OPERATING_REVENUE";
  if (key === "IS_MEMBERSHIP_DUES" || key === "MEMBERSHIP_DUES") return "MEMBERSHIP_DUES";
  if (key === "IS_PAYROLL" || key === "PAYROLL") return "PAYROLL";
  if (key === "IS_DEPRECIATION") return "DEPRECIATION";
  if (key === "IS_INTEREST_EXPENSE") return "INTEREST_EXPENSE";
  if (key === "IS_FINANCING_OTHER") return "FINANCING_OTHER";
  if (key === "IS_INTEREST_INCOME") return "INTEREST_INCOME";
  if (key === "IS_OTHER_REVENUE") return "OTHER_INCOME";
  if (key === "IS_OTHER_EXPENSES") return "OTHER_EXPENSE";
  if (key === "IS_CAPITAL_ASSESSMENTS") return "CAPITAL_ASSESSMENTS";
  if (key === "IS_ENTRANCE_FEES") return "ENTRANCE_FEES";
  if (key === "IS_CAPITAL_OTHER_REVENUE") return "CAPITAL_FUND_OTHER_REVENUE";
  // COGS family — all COGS variants collapse to the single COGS role.
  if (key === "IS_COGS" || key.startsWith("IS_COGS_")) return "COGS";
  // Operating expenses that aren't payroll/dep/interest default to
  // OPERATING_EXPENSE when the key doesn't match a more specific
  // bucket. Many Spectre tenants carry only `IS_OPERATING_EXPENSE`.
  if (key === "IS_OPERATING_EXPENSE") return "OPERATING_EXPENSE";

  // Balance Sheet
  if (key === "BS_CASH" || key === "CURRENT_ASSETS" && false) return "CASH";  // narrow BS_CASH only
  if (key === "BS_CASH") return "CASH";
  if (key === "BS_MEMBER_AR" || key === "BS_ACCOUNTS_RECEIVABLE") return "ACCOUNTS_RECEIVABLE";
  if (key === "BS_INVENTORY") return "INVENTORY";
  if (key === "BS_PREPAIDS" || key === "BS_PREPAID_EXPENSES") return "PREPAIDS";
  if (key === "BS_CAPITAL_ASSETS") return "CAPITAL_ASSETS";
  if (key.startsWith("BS_ACCUMULATED_DEPRECIATION")) return "ACCUMULATED_DEPRECIATION";
  if (key === "BS_OTHER_ASSETS") return "OTHER_ASSETS";
  if (key === "BS_ACCOUNTS_PAYABLE") return "ACCOUNTS_PAYABLE";
  if (key === "BS_ACCRUED_LIABILITIES") return "ACCRUED_LIABILITIES";
  if (key === "BS_DEFERRED_REVENUE") return "DEFERRED_REVENUE";
  if (key === "BS_LONG_TERM_DEBT" || key === "BS_DEBT") return "DEBT";
  if (key === "BS_CAPITAL_RESERVE") return "CAPITAL_RESERVE";
  if (key === "BS_DEFERRED_CAPITAL_CONTRIBUTIONS") return "DEFERRED_CAPITAL_CONTRIBUTIONS";
  if (key === "BS_OTHER_LIABILITIES") return "OTHER_LIABILITIES";
  if (key === "BS_SHARE_CAPITAL") return "SHARE_CAPITAL";
  if (key === "BS_CONTRIBUTED_SURPLUS") return "CONTRIBUTED_SURPLUS";
  if (key === "BS_RETAINED_EARNINGS") return "RETAINED_EARNINGS";
  if (key === "BS_OTHER_EQUITY") return "OTHER_EQUITY";

  // Unmapped — leave null so the attention queue surfaces it rather
  // than silently misclassifying.
  return null;
}

/**
 * Human-readable role label for the Mapping Studio UI (never surfaces
 * the raw enum value to the Controller).
 */
export function labelForReportingRole(role: ReportingRole): string {
  const labels: Record<ReportingRole, string> = {
    OPERATING_REVENUE:            "Operating Revenue",
    MEMBERSHIP_DUES:              "Membership Dues",
    COGS:                         "Cost of Sales",
    PAYROLL:                      "Payroll & Related",
    OPERATING_EXPENSE:            "Operating Expense",
    DEPRECIATION:                 "Depreciation",
    INTEREST_EXPENSE:             "Interest Expense",
    FINANCING_OTHER:              "Other Financing",
    INTEREST_INCOME:              "Interest Income",
    OTHER_INCOME:                 "Other Income",
    OTHER_EXPENSE:                "Other Expense",
    CAPITAL_ASSESSMENTS:          "Capital Assessments",
    ENTRANCE_FEES:                "Entrance Fees",
    CAPITAL_FUND_OTHER_REVENUE:   "Capital Fund — Other Revenue",
    CASH:                         "Cash",
    ACCOUNTS_RECEIVABLE:          "Accounts Receivable",
    INVENTORY:                    "Inventory",
    PREPAIDS:                     "Prepaid Expenses",
    CAPITAL_ASSETS:               "Capital Assets",
    ACCUMULATED_DEPRECIATION:     "Accumulated Depreciation",
    OTHER_ASSETS:                 "Other Assets",
    ACCOUNTS_PAYABLE:             "Accounts Payable",
    ACCRUED_LIABILITIES:          "Accrued Liabilities",
    DEFERRED_REVENUE:             "Deferred Revenue",
    DEBT:                         "Debt",
    CAPITAL_RESERVE:              "Capital Reserve",
    DEFERRED_CAPITAL_CONTRIBUTIONS: "Deferred Capital Contributions",
    OTHER_LIABILITIES:            "Other Liabilities",
    SHARE_CAPITAL:                "Share Capital",
    CONTRIBUTED_SURPLUS:          "Contributed Surplus",
    RETAINED_EARNINGS:            "Retained Earnings",
    OTHER_EQUITY:                 "Other Equity",
    OTHER:                        "Other (Unmapped)",
  };
  return labels[role];
}

/**
 * COA-MAP-2 (2026-10-06) — human-readable statement label.
 * Never surface the raw enum (`INCOME_STATEMENT`) to the Controller.
 */
export function labelForStatement(statement: string): string {
  if (statement === "INCOME_STATEMENT") return "Income Statement";
  if (statement === "BALANCE_SHEET")    return "Balance Sheet";
  if (statement === "CASH_FLOW")        return "Cash Flow";
  return statement.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * COA-MAP-2 (2026-10-06) — groups a flat list of FinancialStatementGroups
 * into named sections keyed by reportingRole family (OPERATING_REVENUE,
 * OPERATING_EXPENSE, OTHER_INCOME, etc.) so the Mapping Studio can
 * render a true Statement → Section → Group hierarchy.
 *
 * The section ORDER matches the canonical reading order of the
 * Income Statement / Balance Sheet. Groups whose reportingRole is
 * null fall into "Other" so Controllers still see them.
 */
const IS_SECTION_ORDER: ReadonlyArray<{ label: string; roles: ReadonlyArray<ReportingRole> }> = [
  { label: "Operating Revenue",       roles: ["OPERATING_REVENUE", "MEMBERSHIP_DUES"] },
  { label: "Cost of Sales",           roles: ["COGS"] },
  { label: "Payroll & Related",       roles: ["PAYROLL"] },
  { label: "Operating Expenses",      roles: ["OPERATING_EXPENSE"] },
  { label: "Depreciation",            roles: ["DEPRECIATION"] },
  { label: "Interest & Financing",    roles: ["INTEREST_EXPENSE", "FINANCING_OTHER"] },
  { label: "Interest Income",         roles: ["INTEREST_INCOME"] },
  { label: "Other Income",            roles: ["OTHER_INCOME"] },
  { label: "Other Expense",           roles: ["OTHER_EXPENSE"] },
  { label: "Capital Fund",            roles: ["CAPITAL_ASSESSMENTS", "ENTRANCE_FEES", "CAPITAL_FUND_OTHER_REVENUE"] },
];

const BS_SECTION_ORDER: ReadonlyArray<{ label: string; roles: ReadonlyArray<ReportingRole> }> = [
  { label: "Current Assets",          roles: ["CASH", "ACCOUNTS_RECEIVABLE", "INVENTORY", "PREPAIDS"] },
  { label: "Capital Assets",          roles: ["CAPITAL_ASSETS", "ACCUMULATED_DEPRECIATION"] },
  { label: "Other Assets",            roles: ["OTHER_ASSETS"] },
  { label: "Current Liabilities",     roles: ["ACCOUNTS_PAYABLE", "ACCRUED_LIABILITIES", "DEFERRED_REVENUE"] },
  { label: "Long-term Liabilities",   roles: ["DEBT"] },
  { label: "Capital Reserves",        roles: ["CAPITAL_RESERVE", "DEFERRED_CAPITAL_CONTRIBUTIONS"] },
  { label: "Other Liabilities",       roles: ["OTHER_LIABILITIES"] },
  { label: "Equity",                  roles: ["SHARE_CAPITAL", "CONTRIBUTED_SURPLUS", "RETAINED_EARNINGS", "OTHER_EQUITY"] },
];

export type SectionBucket<G> = { label: string; groups: ReadonlyArray<G> };

export function groupBySectionsForStatement<G extends { reportingRole: string | null }>(
  statement: string,
  groups: ReadonlyArray<G>,
): ReadonlyArray<SectionBucket<G>> {
  const order = statement === "INCOME_STATEMENT" ? IS_SECTION_ORDER
              : statement === "BALANCE_SHEET"    ? BS_SECTION_ORDER
              : [];
  if (order.length === 0) {
    return groups.length > 0 ? [{ label: labelForStatement(statement), groups }] : [];
  }
  const roleToSection = new Map<string, string>();
  for (const sec of order) {
    for (const r of sec.roles) roleToSection.set(r, sec.label);
  }
  const buckets = new Map<string, G[]>();
  for (const sec of order) buckets.set(sec.label, []);
  const otherBucket: G[] = [];
  for (const g of groups) {
    const label = g.reportingRole ? roleToSection.get(g.reportingRole) : null;
    if (label) {
      buckets.get(label)!.push(g);
    } else {
      otherBucket.push(g);
    }
  }
  const out: Array<SectionBucket<G>> = [];
  for (const sec of order) {
    const list = buckets.get(sec.label) ?? [];
    if (list.length > 0) out.push({ label: sec.label, groups: list });
  }
  if (otherBucket.length > 0) out.push({ label: "Other", groups: otherBucket });
  return out;
}

/**
 * Statement that owns a role — used by the Mapping Studio to
 * suggest the statement when a Controller creates a new group and
 * picks a role.
 */
export function statementForReportingRole(role: ReportingRole): "INCOME_STATEMENT" | "BALANCE_SHEET" | "ANY" {
  const income: ReadonlyArray<ReportingRole> = [
    "OPERATING_REVENUE", "MEMBERSHIP_DUES", "COGS", "PAYROLL",
    "OPERATING_EXPENSE", "DEPRECIATION", "INTEREST_EXPENSE",
    "FINANCING_OTHER", "INTEREST_INCOME", "OTHER_INCOME", "OTHER_EXPENSE",
    "CAPITAL_ASSESSMENTS", "ENTRANCE_FEES", "CAPITAL_FUND_OTHER_REVENUE",
  ];
  const balance: ReadonlyArray<ReportingRole> = [
    "CASH", "ACCOUNTS_RECEIVABLE", "INVENTORY", "PREPAIDS", "CAPITAL_ASSETS",
    "ACCUMULATED_DEPRECIATION", "OTHER_ASSETS", "ACCOUNTS_PAYABLE",
    "ACCRUED_LIABILITIES", "DEFERRED_REVENUE", "DEBT", "CAPITAL_RESERVE",
    "DEFERRED_CAPITAL_CONTRIBUTIONS", "OTHER_LIABILITIES",
    "SHARE_CAPITAL", "CONTRIBUTED_SURPLUS", "RETAINED_EARNINGS", "OTHER_EQUITY",
  ];
  if (income.includes(role)) return "INCOME_STATEMENT";
  if (balance.includes(role)) return "BALANCE_SHEET";
  return "ANY";
}
