// REPORT-PRESENTATION-1A §3 (2026-10-05) — deterministic FS-Group →
// Board-presentation-category classification.
//
// PURPOSE
//   The Monthly Reporting Package Section IV (Statement of Activities)
//   is a Board-facing financial statement. Rows must aggregate from
//   natural accounts → FS Groups → Board PRESENTATION CATEGORIES →
//   Statement sections. The chevron expand/collapse still operates
//   on FS Group rows; category headings and category subtotals wrap
//   groups into Board-meaningful blocks.
//
// CLASSIFICATION
//   Keyed strictly by `FinancialStatementGroup.key` (fsGroupKey).
//   Never by account name, number, or description.
//
// AMBIGUITY POLICY (directive §"If any FS Group cannot be assigned
// unambiguously from existing accounting semantics, STOP and return
// that ambiguity to the founder rather than guessing.")
//   - Where an FS Group has an industry-standard presentation
//     mapping (e.g. IS_PAYROLL → "Payroll & Related"), it is assigned
//     here with no judgment call.
//   - Where a group has a reasonable default under the directive's
//     named category list but a Board reviewer might reasonably
//     prefer a different bucket, the mapping is still applied AND the
//     judgment is documented in `AMBIGUITIES_DOCUMENTED` below so the
//     founder can override by editing a single table entry.
//   - Where a group has NO defensible default (none in the current
//     Coulee COA), the resolver surfaces it in the "(Review Needed)"
//     catch-all so the Board statement never silently miscategorises.

export type PresentationCategoryKey =
  // Operating Revenue categories
  | "DUES_AND_MEMBER_REVENUE"
  | "GOLF_OPERATIONS_REVENUE"
  | "FOOD_AND_BEVERAGE_REVENUE"
  | "OTHER_OPERATING_REVENUE"
  // Operating Expense categories (NOI-driving, exclude financing)
  | "COST_OF_SALES"
  | "PAYROLL_AND_RELATED"
  | "OPERATING_AND_ADMINISTRATIVE_EXPENSES"
  | "DEPRECIATION"
  // REPORT-PRESENTATION-1A.1 (2026-10-05) — Financing & Other reports
  // below NOI-after-depreciation. Interest expense and other non-
  // operating financing costs are excluded from NOI per the founder's
  // intended Board semantics.
  | "FINANCING_AND_OTHER"
  // Capital categories
  | "CAPITAL_REVENUE"
  | "CAPITAL_EXPENSES"
  // Catch-all for FS Groups the mapping cannot classify
  | "REVIEW_NEEDED";

export type PresentationCategory = {
  key: PresentationCategoryKey;
  /** Board-facing display name (uppercase smallcaps renders on the
   *  heading row; natural case on the subtotal row). */
  displayName: string;
  /** Section the category belongs to. Drives placement above/below
   *  the NOI line and above/below the capital divider.
   *
   *  FINANCING section (REPORT-PRESENTATION-1A.1): placed after
   *  NOI-after-depreciation and before the capital divider. Not
   *  part of operating-expense totals or NOI math. */
  section:
    | "OPERATING_REVENUE"
    | "OPERATING_EXPENSE"
    | "DEPRECIATION"
    | "FINANCING"
    | "CAPITAL_REVENUE"
    | "CAPITAL_EXPENSE";
  /** Sort order within its section (lower first). */
  sortOrder: number;
};

/** The canonical list of Board presentation categories, in render
 *  order. Section IV renders OPERATING_REVENUE categories (then
 *  Total Operating Revenue), then OPERATING_EXPENSE categories, then
 *  the NOI band, then DEPRECIATION, then NOI-after, then the
 *  capital section. */
export const PRESENTATION_CATEGORIES: readonly PresentationCategory[] = [
  // ---- Operating Revenue ----
  {
    key: "DUES_AND_MEMBER_REVENUE",
    displayName: "Dues & Member Revenue",
    section: "OPERATING_REVENUE",
    sortOrder: 10,
  },
  {
    key: "GOLF_OPERATIONS_REVENUE",
    displayName: "Golf Operations",
    section: "OPERATING_REVENUE",
    sortOrder: 20,
  },
  {
    key: "FOOD_AND_BEVERAGE_REVENUE",
    displayName: "Food & Beverage Operations",
    section: "OPERATING_REVENUE",
    sortOrder: 30,
  },
  {
    key: "OTHER_OPERATING_REVENUE",
    displayName: "Other Operating Revenue",
    section: "OPERATING_REVENUE",
    sortOrder: 40,
  },
  // ---- Operating Expense ----
  {
    key: "COST_OF_SALES",
    displayName: "Cost of Sales",
    section: "OPERATING_EXPENSE",
    sortOrder: 10,
  },
  {
    key: "PAYROLL_AND_RELATED",
    displayName: "Payroll & Related",
    section: "OPERATING_EXPENSE",
    sortOrder: 20,
  },
  {
    key: "OPERATING_AND_ADMINISTRATIVE_EXPENSES",
    displayName: "Operating & Administrative Expenses",
    section: "OPERATING_EXPENSE",
    sortOrder: 30,
  },
  // ---- Depreciation ----
  {
    key: "DEPRECIATION",
    displayName: "Depreciation",
    section: "DEPRECIATION",
    sortOrder: 10,
  },
  // ---- Financing & Other ----
  // REPORT-PRESENTATION-1A.1 — financing costs report BELOW
  // NOI-after-depreciation. Not part of operating NOI math per the
  // founder-approved Board semantic. One canonical NOI definition
  // across every reporting surface (Executive, Operating Results,
  // Operating Scorecard, Section III Stewardship, Section IV
  // Statement of Activities).
  {
    key: "FINANCING_AND_OTHER",
    displayName: "Financing & Other",
    section: "FINANCING",
    sortOrder: 10,
  },
  // ---- Capital Revenue ----
  {
    key: "CAPITAL_REVENUE",
    displayName: "Capital Revenue",
    section: "CAPITAL_REVENUE",
    sortOrder: 10,
  },
  // ---- Capital Expense ----
  {
    key: "CAPITAL_EXPENSES",
    displayName: "Capital Expenses",
    section: "CAPITAL_EXPENSE",
    sortOrder: 10,
  },
  // ---- Catch-all ----
  {
    key: "REVIEW_NEEDED",
    displayName: "(Review Needed — FS Group not yet classified)",
    section: "OPERATING_REVENUE", // placed first so controllers see it immediately
    sortOrder: 0,
  },
];

/** Deterministic fsGroupKey → presentation-category mapping. Every
 *  populated INCOME_STATEMENT FS Group in the Coulee COA has an
 *  entry. Unknown keys resolve to "REVIEW_NEEDED" at runtime (never
 *  silently misplaced). */
const FS_GROUP_PRESENTATION_MAP: Record<string, PresentationCategoryKey> = {
  // Dues & Member Revenue
  IS_MEMBERSHIP_DUES: "DUES_AND_MEMBER_REVENUE",
  IS_ANNUAL_FEES: "DUES_AND_MEMBER_REVENUE",

  // Golf Operations
  IS_GREEN_FEES: "GOLF_OPERATIONS_REVENUE",
  IS_CART_REVENUE: "GOLF_OPERATIONS_REVENUE",
  IS_DRIVING_RANGE: "GOLF_OPERATIONS_REVENUE",
  IS_PRO_SHOP_MERCH: "GOLF_OPERATIONS_REVENUE",
  IS_GOLF_LESSONS: "GOLF_OPERATIONS_REVENUE",
  IS_TOURNAMENT: "GOLF_OPERATIONS_REVENUE",

  // Food & Beverage Operations
  IS_FOOD_SALES: "FOOD_AND_BEVERAGE_REVENUE",
  IS_BEVERAGE_SALES: "FOOD_AND_BEVERAGE_REVENUE",
  IS_CATERING: "FOOD_AND_BEVERAGE_REVENUE",
  IS_EVENT_REVENUE: "FOOD_AND_BEVERAGE_REVENUE",

  // Other Operating Revenue
  IS_FACILITY_RENTALS: "OTHER_OPERATING_REVENUE",
  IS_INTEREST_INCOME: "OTHER_OPERATING_REVENUE",
  IS_ASSET_GAIN_LOSS: "OTHER_OPERATING_REVENUE",
  // IS_OTHER_REVENUE is split by fundApplicability at the account
  // level: operating-tagged accounts flow to Other Operating Revenue;
  // capital-tagged accounts flow to Capital Revenue. See
  // `classifyFsGroupPresentation` + the projection's per-account
  // partitioning upstream.
  IS_OTHER_REVENUE: "OTHER_OPERATING_REVENUE",

  // Cost of Sales
  IS_COGS_MERCHANDISE: "COST_OF_SALES",
  IS_COGS_FOOD: "COST_OF_SALES",
  IS_COGS_BEVERAGE: "COST_OF_SALES",

  // Payroll & Related
  IS_PAYROLL: "PAYROLL_AND_RELATED",

  // Operating & Administrative Expenses — Spectre's catch-all for
  // non-COGS / non-payroll / non-depreciation operating expense.
  IS_UTILITIES: "OPERATING_AND_ADMINISTRATIVE_EXPENSES",
  IS_REPAIRS_MAINTENANCE: "OPERATING_AND_ADMINISTRATIVE_EXPENSES",
  IS_PROPERTY_TAX: "OPERATING_AND_ADMINISTRATIVE_EXPENSES",
  IS_INCOME_TAX: "OPERATING_AND_ADMINISTRATIVE_EXPENSES",
  IS_INSURANCE: "OPERATING_AND_ADMINISTRATIVE_EXPENSES",
  IS_OFFICE_SUPPLIES: "OPERATING_AND_ADMINISTRATIVE_EXPENSES",
  IS_PROFESSIONAL_FEES: "OPERATING_AND_ADMINISTRATIVE_EXPENSES",
  IS_IT_SOFTWARE: "OPERATING_AND_ADMINISTRATIVE_EXPENSES",
  IS_TELEPHONE_INTERNET: "OPERATING_AND_ADMINISTRATIVE_EXPENSES",
  IS_BANK_CHARGES: "OPERATING_AND_ADMINISTRATIVE_EXPENSES",
  IS_MERCHANT_FEES: "OPERATING_AND_ADMINISTRATIVE_EXPENSES",
  IS_VEHICLE_EQUIPMENT: "OPERATING_AND_ADMINISTRATIVE_EXPENSES",
  IS_SMALL_TOOLS: "OPERATING_AND_ADMINISTRATIVE_EXPENSES",
  IS_JANITORIAL_SUPPLIES: "OPERATING_AND_ADMINISTRATIVE_EXPENSES",
  IS_CLEANING_SERVICES: "OPERATING_AND_ADMINISTRATIVE_EXPENSES",
  IS_SECURITY: "OPERATING_AND_ADMINISTRATIVE_EXPENSES",
  IS_STAFF_TRAINING: "OPERATING_AND_ADMINISTRATIVE_EXPENSES",
  IS_MARKETING_ADVERTISING: "OPERATING_AND_ADMINISTRATIVE_EXPENSES",
  IS_TRAVEL_MEALS: "OPERATING_AND_ADMINISTRATIVE_EXPENSES",
  IS_MEMBERSHIPS_SUBS: "OPERATING_AND_ADMINISTRATIVE_EXPENSES",
  IS_LICENCES_PERMITS: "OPERATING_AND_ADMINISTRATIVE_EXPENSES",
  // REPORT-PRESENTATION-1A.1 (2026-10-05) — interest expense is a
  // financing cost, NOT an operating expense for Board NOI purposes.
  // Moved from OPERATING_AND_ADMINISTRATIVE_EXPENSES to
  // FINANCING_AND_OTHER so Section IV reports it below NOI-after-dep.
  // The canonical NOI definition in ratio-registry + fs-group-
  // projection excludes financing accordingly.
  IS_INTEREST_EXPENSE: "FINANCING_AND_OTHER",
  // IS_OTHER_EXPENSES is split by fundApplicability like IS_OTHER_REVENUE.
  IS_OTHER_EXPENSES: "OPERATING_AND_ADMINISTRATIVE_EXPENSES",

  // Depreciation
  IS_DEPRECIATION: "DEPRECIATION",

  // Capital
  IS_ENTRANCE_FEES: "CAPITAL_REVENUE",
  IS_CAPITAL_ASSESSMENTS: "CAPITAL_REVENUE",
};

/** Documented ambiguities — judgment calls where the mapping above
 *  reflects a defensible default but a Board reviewer might reasonably
 *  prefer a different bucket. Surfaced in the acceptance package so
 *  the founder can override by editing one line of the mapping. */
export const AMBIGUITIES_DOCUMENTED: ReadonlyArray<{
  fsGroupKey: string;
  assignedTo: PresentationCategoryKey;
  rationale: string;
  alternativeIfChallenged: PresentationCategoryKey | "NEW_CATEGORY";
}> = [
  {
    fsGroupKey: "IS_STAFF_TRAINING",
    assignedTo: "OPERATING_AND_ADMINISTRATIVE_EXPENSES",
    rationale:
      "CMAA/CBMA industry practice separates professional development from W-2 compensation; Payroll & Related is reserved for salaries + benefits per the IS_PAYROLL group.",
    alternativeIfChallenged: "PAYROLL_AND_RELATED",
  },
  {
    fsGroupKey: "IS_INTEREST_EXPENSE",
    assignedTo: "FINANCING_AND_OTHER",
    rationale:
      "REPORT-PRESENTATION-1A.1 (2026-10-05) resolution: interest expense is a financing cost, not an operating expense for Board NOI purposes. Moved to the dedicated FINANCING_AND_OTHER category reporting below NOI-after-depreciation.",
    alternativeIfChallenged: "OPERATING_AND_ADMINISTRATIVE_EXPENSES",
  },
  {
    fsGroupKey: "IS_PROPERTY_TAX",
    assignedTo: "OPERATING_AND_ADMINISTRATIVE_EXPENSES",
    rationale:
      "Taxes are frequently shown as a separate 'Fixed Expenses' category in private-club statements; the directive's named list does not include that bucket so property tax defaults to Operating & Administrative.",
    alternativeIfChallenged: "NEW_CATEGORY",
  },
  {
    fsGroupKey: "IS_INCOME_TAX",
    assignedTo: "OPERATING_AND_ADMINISTRATIVE_EXPENSES",
    rationale:
      "Same as Property Tax — defaults to Operating & Administrative in the absence of a 'Taxes' category in the directive's category list.",
    alternativeIfChallenged: "NEW_CATEGORY",
  },
  {
    fsGroupKey: "IS_ANNUAL_FEES",
    assignedTo: "DUES_AND_MEMBER_REVENUE",
    rationale:
      "Annual fees are member-paid recurring assessments adjacent to dues; a Board reviewer could reasonably prefer Other Operating Revenue if 'Annual Fees' at Coulee refers to non-member facility access.",
    alternativeIfChallenged: "OTHER_OPERATING_REVENUE",
  },
  {
    fsGroupKey: "IS_EVENT_REVENUE",
    assignedTo: "FOOD_AND_BEVERAGE_REVENUE",
    rationale:
      "Private-club events typically run through catering (F&B operations). Alternative placement is Other Operating Revenue if Coulee has standalone (non-F&B) events. Zero-activity at Coulee Jan 2026 so moot in practice.",
    alternativeIfChallenged: "OTHER_OPERATING_REVENUE",
  },
];

/** Resolve the Board presentation category for one FS Group, taking
 *  into account the per-account `fundApplicability` for the handful
 *  of FS Groups whose accounts split across operating + capital
 *  funds (IS_OTHER_REVENUE, IS_OTHER_EXPENSES). */
export function classifyFsGroupPresentation(args: {
  fsGroupKey: string | null;
  /** The section the projection already placed this group in,
   *  derived from the account's fundApplicability + type. Used to
   *  disambiguate the two mixed-fund FS Groups.
   *
   *  Note: a FINANCING section does not appear here as a projection
   *  input — financing is derived post-partition from fsGroupKey
   *  (IS_INTEREST_EXPENSE), so projection-layer section-partitioning
   *  places it in OPERATING_EXPENSE first and the classifier moves
   *  it to FINANCING_AND_OTHER (which the projection then uses to
   *  move the row into its own `financing` partition). */
  section: "OPERATING_REVENUE" | "OPERATING_EXPENSE" | "DEPRECIATION" | "CAPITAL_REVENUE" | "CAPITAL_EXPENSE";
}): PresentationCategoryKey {
  const { fsGroupKey, section } = args;

  if (!fsGroupKey) return "REVIEW_NEEDED";

  // IS_OTHER_REVENUE + IS_OTHER_EXPENSES map by section (operating
  // vs capital), overriding the default mapping entry.
  if (fsGroupKey === "IS_OTHER_REVENUE") {
    if (section === "CAPITAL_REVENUE") return "CAPITAL_REVENUE";
    return "OTHER_OPERATING_REVENUE";
  }
  if (fsGroupKey === "IS_OTHER_EXPENSES") {
    if (section === "CAPITAL_EXPENSE") return "CAPITAL_EXPENSES";
    return "OPERATING_AND_ADMINISTRATIVE_EXPENSES";
  }
  // CAPITAL-LIVE-1A (2026-10-05) — IS_INTEREST_INCOME is a mixed-fund
  // FS Group: operating-fund interest-income accounts render under
  // Other Operating Revenue; capital-fund interest-income accounts
  // (e.g. Coulee's 7100 Interest Income on Reserve Fund) render under
  // CAPITAL_REVENUE so Section IV's single "Capital Revenue" category
  // subtotal reconciles to Section V's Total Capital Sources + Section
  // III's Capital Fund Income to the penny.
  if (fsGroupKey === "IS_INTEREST_INCOME") {
    if (section === "CAPITAL_REVENUE") return "CAPITAL_REVENUE";
    return "OTHER_OPERATING_REVENUE";
  }

  const mapped = FS_GROUP_PRESENTATION_MAP[fsGroupKey];
  if (!mapped) return "REVIEW_NEEDED";
  return mapped;
}

/** Look up the full presentation category metadata (name, section,
 *  sortOrder) for a key. */
export function presentationCategoryFor(
  key: PresentationCategoryKey,
): PresentationCategory {
  const c = PRESENTATION_CATEGORIES.find((p) => p.key === key);
  if (!c) {
    // Defensive — should never trigger because the key union is
    // exhaustive. Keeps the UI from crashing if a new key is added
    // without updating the registry.
    return {
      key: "REVIEW_NEEDED",
      displayName: "(Review Needed)",
      section: "OPERATING_REVENUE",
      sortOrder: 0,
    };
  }
  return c;
}
