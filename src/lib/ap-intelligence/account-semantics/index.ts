// Sprint 3 · Phase 4 Slice 5.7A (2026-08-09) — Account Semantics
// resolver.
//
// Founder Amendment 3 (approved): runtime derivation is the BRIDGE,
// not the permanent authority. Architected as:
//
//   configured semantics (durable schema field, when available)
//         ↓
//   structural COA evidence (fsGroup.key, category.key, accountRole)
//         ↓
//   account-name inference (fallback)
//
// When Spectre adds a durable Account.capitalRole / accountSemanticRole
// / functionalRole field in a later slice, `resolveAccountSemantics`
// will consume it as `CONFIGURED` provenance without any ranker
// changes. Until then, runtime derivation from fsGroup+name+category
// is used and every conclusion carries its provenance tag.

import type { EligibleAccountView } from "../accounting-nature-compatibility";

// -----------------------------------------------------------------------------
// Public types (§7 + Amendment 2 — capital role and functional role are
// SEPARATE dimensions of the same account).
// -----------------------------------------------------------------------------

export type CapitalAccountRole =
  | "EQUIPMENT_ASSET"
  | "BUILDING_ASSET"
  | "LAND_ASSET"
  | "VEHICLE_ASSET"
  | "FURNITURE_FIXTURES_ASSET"
  | "LEASEHOLD_IMPROVEMENT"
  | "CAPITAL_IMPROVEMENT"
  | "CONSTRUCTION_IN_PROGRESS"
  | "SOFTWARE_INTANGIBLE"
  | "OTHER_CAPITAL_ASSET"
  | "NOT_CAPITAL_ASSET"
  | "UNKNOWN";

export type AccountFunctionalRole =
  | "GROUNDS_EQUIPMENT"
  | "IRRIGATION"
  | "CLUBHOUSE_EQUIPMENT"
  | "COMPUTER_EQUIPMENT"
  | "KITCHEN_EQUIPMENT"
  | "FOOD_BEVERAGE_EQUIPMENT"
  | "PROSHOP_EQUIPMENT"
  | "BUILDING"
  | "LAND"
  | "VEHICLE"
  | "GENERAL_EQUIPMENT"
  | "FINANCED_EQUIPMENT"
  | "CAPITAL_PROJECT"
  | "TEEBOX_PROJECT"
  | "IRRIGATION_PROJECT"
  | "UNKNOWN";

export type SemanticsProvenance =
  | "CONFIGURED"
  | "FS_GROUP"
  | "CATEGORY"
  | "ACCOUNT_ROLE"
  | "DEPARTMENT_METADATA"
  | "NAME_INFERENCE"
  | "UNKNOWN";

// Phase 4R · Phase 7.2K (2026-08-13) — extended AP-relevant account
// semantics per founder §2. AccountSemantics becomes the SINGLE typed
// AP interpretation of an account. Downstream AP reasoning must not
// repeatedly re-interpret raw account.type / fsGroupKey / account
// name / capital-role fields — every treatment-sensitive read consults
// this artefact.

/** Structural posting role — derived from Account.accountRole +
 *  boolean flags. Represents STRUCTURAL restrictions on posting
 *  (bank/cash/control/contra), NOT accounting-treatment inference. */
export type PostingRole =
  | "STANDARD"
  | "CONTRA_ASSET"
  | "CONTRA_REVENUE"
  | "CONTRA_LIABILITY"
  | "CONTROL"
  | "CLEARING"
  | "BANK"
  | "CASH";

/** Coarse financial-statement role. Aligns with the composed
 *  treatment's `statementRole` for tier assignment (Phase 7.2L). */
export type AccountStatementRole =
  | "BALANCE_SHEET_CAPITAL_ASSET"
  | "BALANCE_SHEET_CURRENT_ASSET"
  | "BALANCE_SHEET_LIABILITY"
  | "BALANCE_SHEET_EQUITY"
  | "REVENUE"
  | "OPERATING_EXPENSE"
  | "COST_OF_SALES"
  | "OTHER"
  | "UNKNOWN";

/** Distinguishes inventory-asset and prepaid-asset roles at the
 *  current-asset level. Complements `AccountStatementRole`. */
export type InventoryPrepaidRole =
  | "INVENTORY"
  | "PREPAID_ASSET"
  | "NONE";

/** Accounting-class taxonomy — the "what economic thing does this
 *  account represent?" layer. Broader than functional/capital role.
 *  Used for tier assignment inside a statementRole cohort. */
export type AccountingClass =
  | "FUEL_EXPENSE"
  | "IT_SERVICES"
  | "SOFTWARE_INTANGIBLE"
  | "PROFESSIONAL_SERVICES"
  | "MEMBERSHIP_DUES"
  | "REPAIRS_MAINTENANCE"
  | "GROUNDS_MAINTENANCE"
  | "UTILITIES_TELECOM"
  | "INSURANCE_EXPENSE"
  | "INTEREST_FINANCE_CHARGE"
  | "TAXES_LICENSES"
  | "OFFICE_SUPPLIES"
  | "FOOD_INVENTORY"
  | "FOOD_COST_OF_SALES"
  | "BEVERAGE_INVENTORY"
  | "BEVERAGE_COST_OF_SALES"
  | "MERCHANDISE_INVENTORY"
  | "PARTS_INVENTORY"
  | "PREPAID_INSURANCE"
  | "PREPAID_OTHER"
  | "LAND"
  | "BUILDING"
  | "EQUIPMENT_ASSET"
  | "VEHICLE_ASSET"
  | "FURNITURE_FIXTURES_ASSET"
  | "SOFTWARE_INTANGIBLE_ASSET"
  | "LEASEHOLD_IMPROVEMENT_ASSET"
  | "CIP_ASSET"
  | "PAYROLL_EXPENSE"
  | "OTHER_EXPENSE"
  | "OTHER_ASSET"
  | "NON_AP_POSTABLE"
  | "UNKNOWN";

/** Enumerated structural posting restrictions surfaced from the
 *  underlying COA row. Consumers can inspect this instead of the
 *  raw boolean flags. */
export type StructuralPostingRestriction =
  | "INACTIVE"
  | "ARCHIVED"
  | "HEADER_ACCOUNT"
  | "MANUAL_POSTING_PROHIBITED"
  | "BANK_ACCOUNT"
  | "CASH_ACCOUNT"
  | "CONTROL_ACCOUNT"
  | "CONTRA_ASSET"
  | "REVENUE_TYPE"
  | "EQUITY_TYPE"
  | "LIABILITY_TYPE"
  | "PAYROLL_RESTRICTED";

export interface AccountSemantics {
  accountNumber: string;
  accountName: string;

  // -------- Phase 4R · Phase 7.2K (2026-08-13) extensions --------
  // These fields form the AP-intelligence layer's SINGLE typed view.
  // Downstream consumers MUST consult these instead of re-interpreting
  // raw account.type / fsGroupKey / accountRole / name.

  /** Structural posting role. Mirrors Account.accountRole with a
   *  boolean-flag overlay for legacy accounts pre-backfill. */
  postingRole: PostingRole;
  postingRoleSource: SemanticsProvenance;

  /** Coarse financial-statement role. Aligns with composed treatment. */
  statementRole: AccountStatementRole;
  statementRoleSource: SemanticsProvenance;

  /** Distinguishes inventory vs prepaid vs other current asset. */
  inventoryPrepaidRole: InventoryPrepaidRole;
  inventoryPrepaidRoleSource: SemanticsProvenance;

  /** Accounting-class taxonomy — used for tier assignment inside a
   *  statementRole cohort in Model B (Phase 7.2L). */
  accountingClass: AccountingClass;
  accountingClassSource: SemanticsProvenance;

  /** Structural restrictions on posting. Enumeration is exhaustive
   *  and stable so eligibility rules can consume without ad-hoc
   *  boolean lookups. */
  structuralPostingRestrictions: ReadonlyArray<StructuralPostingRestriction>;

  // -------- Pre-Phase-7.2K fields (preserved) --------
  capitalRole: CapitalAccountRole;
  capitalRoleSource: SemanticsProvenance;
  functionalRole: AccountFunctionalRole;
  functionalRoleSource: SemanticsProvenance;
  /** Organizational department the account belongs to (Grounds,
   *  Kitchen, etc.) — DIFFERENT from functional role. §Amendment 2:
   *  organizational department != transactional account purpose. */
  organizationalDepartment: string | null;
  organizationalDepartmentSource: SemanticsProvenance;
  /** Diagnostic ambiguities so tenant configuration can be
   *  requested later. */
  ambiguities: string[];
}

/** Alias — the founder's directive language uses
 *  "CanonicalAccountSemantics"; the existing implementation name is
 *  `AccountSemantics`. Same shape; alias avoids a rename churn. */
export type CanonicalAccountSemantics = AccountSemantics;

// -----------------------------------------------------------------------------
// Vocabularies — closed, generic. NO supplier / product / SKU literal.
// NO invoice-specific / tenant-specific hardcoded rules.
// -----------------------------------------------------------------------------

// Capital-role name-inference patterns. Only used when structural
// evidence (fsGroup / category) is insufficient.
const CIP_NAME_RE = /\b(?:construct(?:ion)?\s+in\s+progress|cip)\b/i;
const LAND_NAME_RE = /\bland\b(?!scap)/i;   // "Land" but not "Landscaping"
const BUILDING_NAME_RE = /\b(?:buildings?|clubhouse\s+build|structure|premises)\b/i;
const LEASEHOLD_NAME_RE = /\bleasehold\b/i;
const VEHICLE_NAME_RE = /\b(?:vehicle|automobile|truck|van|fleet(?:\s+vehicle)?)\b/i;
const SOFTWARE_INTANGIBLE_NAME_RE = /\b(?:software|intangible)\b/i;
const EQUIPMENT_NAME_RE = /\b(?:equipment|fixture|fixtures|machinery|apparatus)\b/i;
const FURNITURE_FIXTURES_RE = /\bfurniture\b/i;
const IMPROVEMENT_NAME_RE = /\bimprovements?\b/i;
const FINANCING_NAME_RE = /\b(?:financing|financed|lease(?:d)?|under\s+financing|under\s+lease)\b/i;

// Functional-role name patterns.
const GROUNDS_FUNC_RE = /\b(?:grounds?|turf|course|fairway|greens?|rough|tee\s*box(?:es)?)\b/i;
const IRRIGATION_FUNC_RE = /\birrigat(?:ion|e|ed)?\b/i;
const CLUBHOUSE_FUNC_RE = /\bclubhouse\b/i;
const COMPUTER_FUNC_RE = /\b(?:computer|network|server|desktop|laptop|it\s+equipment)s?\b/i;
const KITCHEN_FUNC_RE = /\b(?:kitchen|culinary|pastry)\b/i;
const FOOD_BEV_FUNC_RE = /\b(?:food|beverage|f\s*&\s*b|dining|bar|lounge)\b/i;
const PROSHOP_FUNC_RE = /\b(?:pro\s*shop|golf\s*shop|proshop|backshop)\b/i;
const TEEBOX_FUNC_RE = /\btee\s*box(?:es)?\b/i;

// -----------------------------------------------------------------------------
// Public entrypoint
// -----------------------------------------------------------------------------

export function resolveAccountSemantics(account: EligibleAccountView): AccountSemantics {
  const ambiguities: string[] = [];
  const {
    capitalRole,
    source: capitalRoleSource,
  } = deriveCapitalRole(account, ambiguities);
  const {
    functionalRole,
    source: functionalRoleSource,
  } = deriveFunctionalRole(account, ambiguities);
  const {
    department: organizationalDepartment,
    source: organizationalDepartmentSource,
  } = deriveOrganizationalDepartment(account, ambiguities);

  // Phase 4R · Phase 7.2K (2026-08-13) — new AP-relevant semantic
  // dimensions derived ONCE from underlying COA metadata.
  const {
    postingRole,
    source: postingRoleSource,
  } = derivePostingRole(account);
  const {
    statementRole,
    source: statementRoleSource,
  } = deriveStatementRole(account, capitalRole);
  const {
    inventoryPrepaidRole,
    source: inventoryPrepaidRoleSource,
  } = deriveInventoryPrepaidRole(account, statementRole);
  const {
    accountingClass,
    source: accountingClassSource,
  } = deriveAccountingClass(account, statementRole, capitalRole, inventoryPrepaidRole);
  const structuralPostingRestrictions = deriveStructuralPostingRestrictions(account, postingRole);

  return {
    accountNumber: account.accountNumber,
    accountName: account.name,
    postingRole,
    postingRoleSource,
    statementRole,
    statementRoleSource,
    inventoryPrepaidRole,
    inventoryPrepaidRoleSource,
    accountingClass,
    accountingClassSource,
    structuralPostingRestrictions,
    capitalRole,
    capitalRoleSource,
    functionalRole,
    functionalRoleSource,
    organizationalDepartment,
    organizationalDepartmentSource,
    ambiguities,
  };
}

// -----------------------------------------------------------------------------
// Phase 7.2K derivations — POSTING ROLE
// -----------------------------------------------------------------------------

function derivePostingRole(
  account: EligibleAccountView,
): { postingRole: PostingRole; source: SemanticsProvenance } {
  const configured = (account.accountRole ?? "").toUpperCase();
  if (configured === "CONTRA_ASSET") return { postingRole: "CONTRA_ASSET", source: "CONFIGURED" };
  if (configured === "CONTRA_REVENUE") return { postingRole: "CONTRA_REVENUE", source: "CONFIGURED" };
  if (configured === "CONTRA_LIABILITY") return { postingRole: "CONTRA_LIABILITY", source: "CONFIGURED" };
  if (configured === "CONTROL") return { postingRole: "CONTROL", source: "CONFIGURED" };
  if (configured === "CLEARING") return { postingRole: "CLEARING", source: "CONFIGURED" };
  if (configured === "BANK") return { postingRole: "BANK", source: "CONFIGURED" };
  if (configured === "CASH") return { postingRole: "CASH", source: "CONFIGURED" };
  // Boolean-flag fallback for accounts pre-accountRole backfill.
  if (account.isBankAccount) return { postingRole: "BANK", source: "ACCOUNT_ROLE" };
  if (account.isCashAccount) return { postingRole: "CASH", source: "ACCOUNT_ROLE" };
  if (account.isControlAccount) return { postingRole: "CONTROL", source: "ACCOUNT_ROLE" };
  return { postingRole: "STANDARD", source: "ACCOUNT_ROLE" };
}

// -----------------------------------------------------------------------------
// Phase 7.2K derivations — STATEMENT ROLE
// -----------------------------------------------------------------------------

function deriveStatementRole(
  account: EligibleAccountView,
  capitalRole: CapitalAccountRole,
): { statementRole: AccountStatementRole; source: SemanticsProvenance } {
  const type = (account.type ?? "").toUpperCase();
  const categoryKey = (account.categoryKey ?? "").toUpperCase();
  const fsGroupKey = (account.fsGroupKey ?? "").toUpperCase();
  const nameLower = (account.name ?? "").toLowerCase();

  if (type === "REVENUE") return { statementRole: "REVENUE", source: "CONFIGURED" };
  if (type === "EQUITY") return { statementRole: "BALANCE_SHEET_EQUITY", source: "CONFIGURED" };
  if (type === "LIABILITY") return { statementRole: "BALANCE_SHEET_LIABILITY", source: "CONFIGURED" };

  if (type === "ASSET") {
    // Capital vs current asset distinction.
    if (capitalRole !== "NOT_CAPITAL_ASSET" && capitalRole !== "UNKNOWN") {
      return { statementRole: "BALANCE_SHEET_CAPITAL_ASSET", source: "CATEGORY" };
    }
    if (categoryKey === "CAPITAL_ASSETS" || fsGroupKey.startsWith("BS_CAPITAL") || fsGroupKey === "BS_CIP") {
      return { statementRole: "BALANCE_SHEET_CAPITAL_ASSET", source: "FS_GROUP" };
    }
    if (fsGroupKey === "BS_INVENTORY" || categoryKey === "INVENTORY" || /\binventor(y|ies)\b/.test(nameLower)) {
      return { statementRole: "BALANCE_SHEET_CURRENT_ASSET", source: "FS_GROUP" };
    }
    if (fsGroupKey === "BS_PREPAID" || categoryKey === "PREPAID_EXPENSES" || /\bprepaid\b/.test(nameLower)) {
      return { statementRole: "BALANCE_SHEET_CURRENT_ASSET", source: "FS_GROUP" };
    }
    return { statementRole: "BALANCE_SHEET_CURRENT_ASSET", source: "CATEGORY" };
  }

  if (type === "EXPENSE") {
    // COGS distinction — accounts explicitly categorised as cost-of-sales
    // OR fsGroupKey signalling COGS OR name signalling.
    if (categoryKey.includes("COST_OF_SALES") || categoryKey.includes("COGS")
      || fsGroupKey.includes("COGS") || fsGroupKey.includes("COST_OF_SALES")
      || /\bcost\s+of\s+(?:sales|goods)\b/.test(nameLower)) {
      return { statementRole: "COST_OF_SALES", source: "FS_GROUP" };
    }
    return { statementRole: "OPERATING_EXPENSE", source: "CATEGORY" };
  }

  return { statementRole: "UNKNOWN", source: "UNKNOWN" };
}

// -----------------------------------------------------------------------------
// Phase 7.2K derivations — INVENTORY / PREPAID ROLE
// -----------------------------------------------------------------------------

function deriveInventoryPrepaidRole(
  account: EligibleAccountView,
  statementRole: AccountStatementRole,
): { inventoryPrepaidRole: InventoryPrepaidRole; source: SemanticsProvenance } {
  if (statementRole !== "BALANCE_SHEET_CURRENT_ASSET") {
    return { inventoryPrepaidRole: "NONE", source: "CATEGORY" };
  }
  const categoryKey = (account.categoryKey ?? "").toUpperCase();
  const fsGroupKey = (account.fsGroupKey ?? "").toUpperCase();
  const nameLower = (account.name ?? "").toLowerCase();
  if (fsGroupKey === "BS_INVENTORY" || categoryKey === "INVENTORY"
    || /\binventor(y|ies)\b/.test(nameLower) || /\bstock\b/.test(nameLower)) {
    return { inventoryPrepaidRole: "INVENTORY", source: "FS_GROUP" };
  }
  if (fsGroupKey === "BS_PREPAID" || categoryKey === "PREPAID_EXPENSES"
    || /\bprepaid\b/.test(nameLower)) {
    return { inventoryPrepaidRole: "PREPAID_ASSET", source: "FS_GROUP" };
  }
  return { inventoryPrepaidRole: "NONE", source: "UNKNOWN" };
}

// -----------------------------------------------------------------------------
// Phase 7.2K derivations — ACCOUNTING CLASS
// -----------------------------------------------------------------------------

function deriveAccountingClass(
  account: EligibleAccountView,
  statementRole: AccountStatementRole,
  capitalRole: CapitalAccountRole,
  inventoryPrepaidRole: InventoryPrepaidRole,
): { accountingClass: AccountingClass; source: SemanticsProvenance } {
  const nameLower = (account.name ?? "").toLowerCase();
  const categoryKey = (account.categoryKey ?? "").toUpperCase();
  const fsGroupKey = (account.fsGroupKey ?? "").toUpperCase();

  // Structural non-postable classes short-circuit.
  if (statementRole === "REVENUE"
    || statementRole === "BALANCE_SHEET_EQUITY"
    || statementRole === "BALANCE_SHEET_LIABILITY") {
    return { accountingClass: "NON_AP_POSTABLE", source: "CONFIGURED" };
  }

  // Capital asset classes.
  if (statementRole === "BALANCE_SHEET_CAPITAL_ASSET") {
    if (capitalRole === "LAND_ASSET") return { accountingClass: "LAND", source: "NAME_INFERENCE" };
    if (capitalRole === "BUILDING_ASSET") return { accountingClass: "BUILDING", source: "NAME_INFERENCE" };
    if (capitalRole === "VEHICLE_ASSET") return { accountingClass: "VEHICLE_ASSET", source: "NAME_INFERENCE" };
    if (capitalRole === "FURNITURE_FIXTURES_ASSET") return { accountingClass: "FURNITURE_FIXTURES_ASSET", source: "NAME_INFERENCE" };
    if (capitalRole === "SOFTWARE_INTANGIBLE") return { accountingClass: "SOFTWARE_INTANGIBLE_ASSET", source: "NAME_INFERENCE" };
    if (capitalRole === "LEASEHOLD_IMPROVEMENT") return { accountingClass: "LEASEHOLD_IMPROVEMENT_ASSET", source: "NAME_INFERENCE" };
    if (capitalRole === "CONSTRUCTION_IN_PROGRESS") return { accountingClass: "CIP_ASSET", source: "FS_GROUP" };
    // EQUIPMENT_ASSET, CAPITAL_IMPROVEMENT, OTHER_CAPITAL_ASSET → equipment
    return { accountingClass: "EQUIPMENT_ASSET", source: "CATEGORY" };
  }

  // Current asset — inventory vs prepaid distinction.
  if (statementRole === "BALANCE_SHEET_CURRENT_ASSET") {
    if (inventoryPrepaidRole === "INVENTORY") {
      if (/\bf\s*&\s*b\b|\bfood\b/.test(nameLower)) return { accountingClass: "FOOD_INVENTORY", source: "NAME_INFERENCE" };
      if (/\bbeverage\b|\bbar\b|\bliquor\b|\bwine\b/.test(nameLower)) return { accountingClass: "BEVERAGE_INVENTORY", source: "NAME_INFERENCE" };
      if (/\bmerchandise\b|\bpro\s*shop\b/.test(nameLower)) return { accountingClass: "MERCHANDISE_INVENTORY", source: "NAME_INFERENCE" };
      if (/\bpart(s)?\b/.test(nameLower)) return { accountingClass: "PARTS_INVENTORY", source: "NAME_INFERENCE" };
      return { accountingClass: "MERCHANDISE_INVENTORY", source: "UNKNOWN" };
    }
    if (inventoryPrepaidRole === "PREPAID_ASSET") {
      if (/\binsurance\b/.test(nameLower)) return { accountingClass: "PREPAID_INSURANCE", source: "NAME_INFERENCE" };
      return { accountingClass: "PREPAID_OTHER", source: "NAME_INFERENCE" };
    }
    return { accountingClass: "OTHER_ASSET", source: "UNKNOWN" };
  }

  // COST_OF_SALES branch.
  if (statementRole === "COST_OF_SALES") {
    if (/\bf\s*&\s*b\b|\bfood\b/.test(nameLower)) return { accountingClass: "FOOD_COST_OF_SALES", source: "NAME_INFERENCE" };
    if (/\bbeverage\b|\bbar\b|\bliquor\b|\bwine\b/.test(nameLower)) return { accountingClass: "BEVERAGE_COST_OF_SALES", source: "NAME_INFERENCE" };
    return { accountingClass: "FOOD_COST_OF_SALES", source: "UNKNOWN" };
  }

  // OPERATING_EXPENSE branch — sub-class by name / fsGroup taxonomy.
  if (statementRole === "OPERATING_EXPENSE") {
    if (fsGroupKey === "IS_PAYROLL" || categoryKey === "PAYROLL_BENEFITS") {
      return { accountingClass: "PAYROLL_EXPENSE", source: "FS_GROUP" };
    }
    if (fsGroupKey === "IS_IT_SOFTWARE" || /\b(?:computer|it\s+services|software|saas)\b/.test(nameLower)) {
      // Distinguish intangible-asset (BS) vs IT-service expense (P&L).
      if (/\bintangible\b/.test(nameLower)) return { accountingClass: "SOFTWARE_INTANGIBLE", source: "NAME_INFERENCE" };
      return { accountingClass: "IT_SERVICES", source: "FS_GROUP" };
    }
    if (fsGroupKey === "IS_FUEL_LUBRICANTS" || /\bfuel\b|\blubric/.test(nameLower)) {
      return { accountingClass: "FUEL_EXPENSE", source: "FS_GROUP" };
    }
    if (fsGroupKey === "IS_UTILITIES" || fsGroupKey === "IS_TELEPHONE_INTERNET" || fsGroupKey === "IS_COMMUNICATIONS"
      || /\b(?:utilit(?:y|ies)|hydro|electric|water|gas|telephone|internet|telecom)\b/.test(nameLower)) {
      return { accountingClass: "UTILITIES_TELECOM", source: "FS_GROUP" };
    }
    if (fsGroupKey === "IS_REPAIRS_MAINTENANCE" || categoryKey === "REPAIRS_MAINTENANCE"
      || /\b(?:repair|maintenance|r&m|r\/m)\b/.test(nameLower)) {
      // Grounds maintenance more specific.
      if (/\bgrounds?\b/.test(nameLower)) return { accountingClass: "GROUNDS_MAINTENANCE", source: "NAME_INFERENCE" };
      return { accountingClass: "REPAIRS_MAINTENANCE", source: "FS_GROUP" };
    }
    if (/\bgrounds?\s+maintenance\b/.test(nameLower)) {
      return { accountingClass: "GROUNDS_MAINTENANCE", source: "NAME_INFERENCE" };
    }
    if (/\bprofessional\s+service|\blegal\b|\baudit|\bconsult|\baccounting\b/.test(nameLower)) {
      return { accountingClass: "PROFESSIONAL_SERVICES", source: "NAME_INFERENCE" };
    }
    if (/\bmembership|\bdues\b/.test(nameLower)) return { accountingClass: "MEMBERSHIP_DUES", source: "NAME_INFERENCE" };
    if (/\binsurance\b/.test(nameLower)) return { accountingClass: "INSURANCE_EXPENSE", source: "NAME_INFERENCE" };
    if (fsGroupKey === "IS_INTEREST_EXPENSE" || fsGroupKey === "IS_BANK_CHARGES"
      || /\binterest|\bfinance\s+charge|\bpenalt|\blate\s+fee|\bbank\s+charge/.test(nameLower)) {
      return { accountingClass: "INTEREST_FINANCE_CHARGE", source: "FS_GROUP" };
    }
    if (fsGroupKey === "IS_TAXES_LICENSES" || /\btax|\blicense|\bpermit\b/.test(nameLower)) {
      return { accountingClass: "TAXES_LICENSES", source: "FS_GROUP" };
    }
    if (/\boffice\s+supplies|\bsupplies\b|\bpostage\b/.test(nameLower)) {
      return { accountingClass: "OFFICE_SUPPLIES", source: "NAME_INFERENCE" };
    }
    return { accountingClass: "OTHER_EXPENSE", source: "UNKNOWN" };
  }

  return { accountingClass: "UNKNOWN", source: "UNKNOWN" };
}

// -----------------------------------------------------------------------------
// Phase 7.2K derivations — STRUCTURAL POSTING RESTRICTIONS
// -----------------------------------------------------------------------------

function deriveStructuralPostingRestrictions(
  account: EligibleAccountView,
  postingRole: PostingRole,
): ReadonlyArray<StructuralPostingRestriction> {
  const out: StructuralPostingRestriction[] = [];
  if (account.isActive === false) out.push("INACTIVE");
  if (account.isHeader) out.push("HEADER_ACCOUNT");
  if (account.allowManualPosting === false) out.push("MANUAL_POSTING_PROHIBITED");
  if (postingRole === "BANK") out.push("BANK_ACCOUNT");
  if (postingRole === "CASH") out.push("CASH_ACCOUNT");
  if (postingRole === "CONTROL") out.push("CONTROL_ACCOUNT");
  if (postingRole === "CONTRA_ASSET") out.push("CONTRA_ASSET");
  const type = (account.type ?? "").toUpperCase();
  if (type === "REVENUE") out.push("REVENUE_TYPE");
  if (type === "EQUITY") out.push("EQUITY_TYPE");
  if (type === "LIABILITY") out.push("LIABILITY_TYPE");
  const fsGroupKey = (account.fsGroupKey ?? "").toUpperCase();
  const categoryKey = (account.categoryKey ?? "").toUpperCase();
  if (fsGroupKey === "IS_PAYROLL" || categoryKey === "PAYROLL_BENEFITS") out.push("PAYROLL_RESTRICTED");
  return out;
}

// -----------------------------------------------------------------------------
// Capital role derivation (§Amendment 3 provenance chain)
// -----------------------------------------------------------------------------

function deriveCapitalRole(
  account: EligibleAccountView,
  ambiguities: string[],
): { capitalRole: CapitalAccountRole; source: SemanticsProvenance } {
  const type = (account.type ?? "").toUpperCase();
  const categoryKey = (account.categoryKey ?? "").toUpperCase();
  const fsGroupKey = (account.fsGroupKey ?? "").toUpperCase();
  const accountRole = (account.accountRole ?? "").toUpperCase();
  const nameLower = (account.name ?? "").toLowerCase();

  // 1. Hard exclusions first — anything that isn't a candidate for
  // capital-role at all.
  if (accountRole === "CONTRA_ASSET" || accountRole.includes("CONTRA")) {
    return { capitalRole: "NOT_CAPITAL_ASSET", source: "ACCOUNT_ROLE" };
  }
  if (accountRole === "BANK" || accountRole === "CASH" || account.isBankAccount || account.isCashAccount) {
    return { capitalRole: "NOT_CAPITAL_ASSET", source: "ACCOUNT_ROLE" };
  }
  if (account.isControlAccount) {
    return { capitalRole: "NOT_CAPITAL_ASSET", source: "ACCOUNT_ROLE" };
  }
  if (type !== "ASSET") {
    return { capitalRole: "NOT_CAPITAL_ASSET", source: "CATEGORY" };
  }
  if (categoryKey !== "CAPITAL_ASSETS" && !fsGroupKey.startsWith("BS_CAPITAL") && fsGroupKey !== "BS_CIP") {
    return { capitalRole: "NOT_CAPITAL_ASSET", source: "CATEGORY" };
  }

  // 2. Structural CIP signal — BS_CIP fsGroup or explicit name.
  if (fsGroupKey === "BS_CIP") {
    return { capitalRole: "CONSTRUCTION_IN_PROGRESS", source: "FS_GROUP" };
  }
  if (CIP_NAME_RE.test(nameLower)) {
    return { capitalRole: "CONSTRUCTION_IN_PROGRESS", source: "NAME_INFERENCE" };
  }

  // 3. Name-inference for the remaining capital families.
  if (LAND_NAME_RE.test(nameLower)) {
    return { capitalRole: "LAND_ASSET", source: "NAME_INFERENCE" };
  }
  if (BUILDING_NAME_RE.test(nameLower)) {
    return { capitalRole: "BUILDING_ASSET", source: "NAME_INFERENCE" };
  }
  if (LEASEHOLD_NAME_RE.test(nameLower)) {
    return { capitalRole: "LEASEHOLD_IMPROVEMENT", source: "NAME_INFERENCE" };
  }
  if (SOFTWARE_INTANGIBLE_NAME_RE.test(nameLower)) {
    return { capitalRole: "SOFTWARE_INTANGIBLE", source: "NAME_INFERENCE" };
  }
  if (VEHICLE_NAME_RE.test(nameLower)) {
    return { capitalRole: "VEHICLE_ASSET", source: "NAME_INFERENCE" };
  }
  if (FURNITURE_FIXTURES_RE.test(nameLower)) {
    return { capitalRole: "FURNITURE_FIXTURES_ASSET", source: "NAME_INFERENCE" };
  }
  if (EQUIPMENT_NAME_RE.test(nameLower)) {
    return { capitalRole: "EQUIPMENT_ASSET", source: "NAME_INFERENCE" };
  }
  if (IMPROVEMENT_NAME_RE.test(nameLower)) {
    return { capitalRole: "CAPITAL_IMPROVEMENT", source: "NAME_INFERENCE" };
  }

  // 4. Fallback — capital-asset category confirmed but role unclear.
  ambiguities.push(`capitalRole unresolved from name/fsGroup — falling back to OTHER_CAPITAL_ASSET`);
  return { capitalRole: "OTHER_CAPITAL_ASSET", source: "UNKNOWN" };
}

// -----------------------------------------------------------------------------
// Functional role derivation (§Amendment 2 — separate from department)
// -----------------------------------------------------------------------------

function deriveFunctionalRole(
  account: EligibleAccountView,
  ambiguities: string[],
): { functionalRole: AccountFunctionalRole; source: SemanticsProvenance } {
  const nameLower = (account.name ?? "").toLowerCase();
  const fsGroupKey = (account.fsGroupKey ?? "").toUpperCase();

  // CIP accounts carry a project functional role BEFORE any equipment
  // role — CIP-Irrigation is IRRIGATION_PROJECT, not IRRIGATION.
  if (fsGroupKey === "BS_CIP" || CIP_NAME_RE.test(nameLower)) {
    if (IRRIGATION_FUNC_RE.test(nameLower)) {
      return { functionalRole: "IRRIGATION_PROJECT", source: "FS_GROUP" };
    }
    if (TEEBOX_FUNC_RE.test(nameLower)) {
      return { functionalRole: "TEEBOX_PROJECT", source: "FS_GROUP" };
    }
    return { functionalRole: "CAPITAL_PROJECT", source: "FS_GROUP" };
  }

  // Land / buildings — functional role equals the physical role.
  if (LAND_NAME_RE.test(nameLower)) return { functionalRole: "LAND", source: "NAME_INFERENCE" };
  if (BUILDING_NAME_RE.test(nameLower)) return { functionalRole: "BUILDING", source: "NAME_INFERENCE" };
  if (VEHICLE_NAME_RE.test(nameLower)) return { functionalRole: "VEHICLE", source: "NAME_INFERENCE" };

  // Financing-scoped equipment has its own functional role — it's an
  // equipment account but with a special-condition requirement.
  if (FINANCING_NAME_RE.test(nameLower) && EQUIPMENT_NAME_RE.test(nameLower)) {
    return { functionalRole: "FINANCED_EQUIPMENT", source: "NAME_INFERENCE" };
  }
  if (FINANCING_NAME_RE.test(nameLower) && !EQUIPMENT_NAME_RE.test(nameLower)) {
    // "under financing" without any equipment noun — still financing scope
    return { functionalRole: "FINANCED_EQUIPMENT", source: "NAME_INFERENCE" };
  }

  // Function-specific equipment / fixture families.
  if (COMPUTER_FUNC_RE.test(nameLower)) return { functionalRole: "COMPUTER_EQUIPMENT", source: "NAME_INFERENCE" };
  if (KITCHEN_FUNC_RE.test(nameLower)) return { functionalRole: "KITCHEN_EQUIPMENT", source: "NAME_INFERENCE" };
  if (FOOD_BEV_FUNC_RE.test(nameLower)) return { functionalRole: "FOOD_BEVERAGE_EQUIPMENT", source: "NAME_INFERENCE" };
  if (PROSHOP_FUNC_RE.test(nameLower)) return { functionalRole: "PROSHOP_EQUIPMENT", source: "NAME_INFERENCE" };
  if (GROUNDS_FUNC_RE.test(nameLower) || IRRIGATION_FUNC_RE.test(nameLower)) {
    return { functionalRole: "GROUNDS_EQUIPMENT", source: "NAME_INFERENCE" };
  }
  if (CLUBHOUSE_FUNC_RE.test(nameLower)) return { functionalRole: "CLUBHOUSE_EQUIPMENT", source: "NAME_INFERENCE" };

  // Generic equipment fallback — no function-specific token.
  if (EQUIPMENT_NAME_RE.test(nameLower) || FURNITURE_FIXTURES_RE.test(nameLower)) {
    return { functionalRole: "GENERAL_EQUIPMENT", source: "NAME_INFERENCE" };
  }

  ambiguities.push("functionalRole unresolved — no function-specific token in account name");
  return { functionalRole: "UNKNOWN", source: "UNKNOWN" };
}

// -----------------------------------------------------------------------------
// Organizational department derivation
// -----------------------------------------------------------------------------

function deriveOrganizationalDepartment(
  account: EligibleAccountView,
  _ambiguities: string[],
): { department: string | null; source: SemanticsProvenance } {
  const nameLower = (account.name ?? "").toLowerCase();

  // §Amendment 2: Irrigation legitimately belongs organizationally
  // to Grounds — this preserves that. But it is expressed at the
  // ORGANIZATIONAL layer only. Functional-role compatibility runs
  // separately.
  if (GROUNDS_FUNC_RE.test(nameLower) || IRRIGATION_FUNC_RE.test(nameLower)) {
    return { department: "grounds", source: "NAME_INFERENCE" };
  }
  if (KITCHEN_FUNC_RE.test(nameLower) || FOOD_BEV_FUNC_RE.test(nameLower)) {
    return { department: "food_beverage", source: "NAME_INFERENCE" };
  }
  if (PROSHOP_FUNC_RE.test(nameLower)) {
    return { department: "golf_shop", source: "NAME_INFERENCE" };
  }
  if (COMPUTER_FUNC_RE.test(nameLower)) {
    return { department: "it", source: "NAME_INFERENCE" };
  }
  if (CLUBHOUSE_FUNC_RE.test(nameLower)) {
    return { department: "clubhouse", source: "NAME_INFERENCE" };
  }
  return { department: null, source: "UNKNOWN" };
}
