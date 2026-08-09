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

export interface AccountSemantics {
  accountNumber: string;
  accountName: string;
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

  return {
    accountNumber: account.accountNumber,
    accountName: account.name,
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
