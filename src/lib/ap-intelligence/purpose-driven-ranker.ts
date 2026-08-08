// Sprint 3 · Phase 4 Slice 5.2 completion (2026-08-08) — full-
// eligible-COA purpose-driven ranker.
//
// Founder amendment #1 + #2 (approved):
//   When canonical economic purpose is COMMITTED and commit-eligible
//   (per purpose-evidence-quality.ts), rank the ENTIRE Phase-2-
//   eligible tenant COA — not the legacy top-N.
//
//   Ontology name-substring matches are a STRONG boost, NOT a
//   pre-filter. An account with no ontology match but strong
//   department + nature + line-item Jaccard can still win.
//
// This module is an ADDITIVE pass in analyse.ts. It never replaces
// the base ranker; it runs when the base winner is null / non-
// postable / incompatible with the committed purpose.

import type { EconomicPurposeDecision } from "./economic-purpose-authority";
import type { AccountingNature } from "./accounting-nature";
import type { CanonicalLineItem } from "./evidence/canonical-line-item";
import type { AccountEligibilityView } from "@/lib/accounting/eligibility/types";
import { evaluatePurposeAccountAffinity } from "./purpose-to-gl-ontology";

// -----------------------------------------------------------------------------
// Public types
// -----------------------------------------------------------------------------

export interface PurposeDrivenRankerInput {
  purposeDecision: EconomicPurposeDecision;
  natureLeader: AccountingNature;
  natureConfidence: number;
  natureIsDefensible: boolean;
  canonicalLineItems: CanonicalLineItem[];
  /** Full Phase-2-eligible + posting-eligible tenant COA. Caller
   *  applies the eligibility filter BEFORE calling this ranker so we
   *  never rank ineligible accounts. */
  eligibleAccounts: ReadonlyArray<AccountEligibilityView>;
  /** Optional department hint from existing inferDepartment path. */
  departmentKey?: string | null;
  /** Optional department name-pattern list (from
   *  departmentAccountNamePatterns). Boosts accounts whose names
   *  match a department-qualifying token. */
  departmentAccountNamePatterns?: RegExp[];
  /** Vendor-history hint — supporting only, capped. */
  vendorHistoryPreferredAccountNumbers?: string[];
  /** Sprint 3 · Phase 4 Slice 5.3 (2026-08-08, amendment #12) —
   *  purchased-item substance signals. When CAPITAL_CANDIDATE is
   *  well-supported, ASSET-type accounts (category CAPITAL_ASSETS)
   *  receive strong support. When REPAIR_MAINTENANCE is supported,
   *  EXPENSE R&M accounts receive support and capital accounts are
   *  contradicted. */
  capitalDecision?: "CAPITAL_CANDIDATE" | "OPERATING" | "REPAIR_MAINTENANCE" | "UNRESOLVED";
  capitalDecisionConfidence?: number;
}

export interface PurposeDrivenScoredAccount {
  accountNumber: string;
  accountName: string;
  accountType: string;
  postable: boolean;
  components: {
    purposeCompat: number;
    ontologyMatch: number;
    natureCompat: number;
    accountRoleMatch: number;
    departmentAffinity: number;
    lineItemJaccard: number;
    vendorHistoryBoost: number;
    /** Sprint 3 · Phase 4 Slice 5.3 (2026-08-08, amendment #12) —
     *  contribution from CapitalEvidenceDecision. Positive when the
     *  account matches the decided nature (asset vs R&M expense);
     *  negative when contradicted. */
    capitalNatureBoost: number;
  };
  total: number;
  contradictions: string[];
}

export interface PurposeDrivenRankerResult {
  candidates: PurposeDrivenScoredAccount[];
  winner: PurposeDrivenScoredAccount | null;
  totalConsidered: number;
  diagnostic: string;
}

// -----------------------------------------------------------------------------
// Compatibility matrices — small, closed, reused
// -----------------------------------------------------------------------------

const PURPOSE_ACCOUNT_TYPE: Record<string, ReadonlyArray<string>> = {
  FUEL: ["EXPENSE"],
  LUBRICANTS: ["EXPENSE"],
  EQUIPMENT: ["ASSET", "EXPENSE"],
  EQUIPMENT_PARTS: ["EXPENSE"],
  REPAIR_MAINTENANCE: ["EXPENSE"],
  CAPITAL_EQUIPMENT: ["ASSET"],
  TELECOMMUNICATIONS: ["EXPENSE"],
  INTERNET_CONNECTIVITY: ["EXPENSE"],
  SOFTWARE_SUBSCRIPTION: ["EXPENSE", "ASSET"],
  PROFESSIONAL_MEMBERSHIP: ["EXPENSE"],
  PROFESSIONAL_SERVICES: ["EXPENSE"],
  FOOD: ["EXPENSE", "COST_OF_SALES", "COGS"],
  BEVERAGE: ["EXPENSE", "COST_OF_SALES", "COGS"],
  FREIGHT_DELIVERY: ["EXPENSE"],
  BUILDING_MAINTENANCE: ["EXPENSE"],
  COURSE_MAINTENANCE: ["EXPENSE"],
  OFFICE_SUPPLIES: ["EXPENSE"],
  INTEREST: ["EXPENSE"],
  PENALTY: ["EXPENSE"],
  OTHER: ["EXPENSE", "ASSET", "COST_OF_SALES", "COGS"],
};

const PURPOSE_CATEGORY_HINTS: Record<string, ReadonlyArray<string>> = {
  FUEL: ["REPAIRS_MAINTENANCE", "COST_OF_SALES"],
  LUBRICANTS: ["REPAIRS_MAINTENANCE"],
  EQUIPMENT_PARTS: ["REPAIRS_MAINTENANCE", "OTHER_EXPENSES"],
  REPAIR_MAINTENANCE: ["REPAIRS_MAINTENANCE"],
  CAPITAL_EQUIPMENT: ["CAPITAL_ASSETS"],
  TELECOMMUNICATIONS: ["ADMIN_EXPENSES", "UTILITIES"],
  INTERNET_CONNECTIVITY: ["ADMIN_EXPENSES", "UTILITIES"],
  SOFTWARE_SUBSCRIPTION: ["ADMIN_EXPENSES"],
  PROFESSIONAL_MEMBERSHIP: ["ADMIN_EXPENSES"],
  PROFESSIONAL_SERVICES: ["PROFESSIONAL_SERVICES", "ADMIN_EXPENSES"],
  BUILDING_MAINTENANCE: ["REPAIRS_MAINTENANCE", "UTILITIES"],
  COURSE_MAINTENANCE: ["OTHER_EXPENSES"],
  OFFICE_SUPPLIES: ["ADMIN_EXPENSES"],
  INTEREST: ["OTHER_EXPENSES"],
  PENALTY: ["OTHER_EXPENSES"],
};

// -----------------------------------------------------------------------------
// Score weights
// -----------------------------------------------------------------------------

const W_PURPOSE_TYPE_MATCH = 20;
const W_PURPOSE_CATEGORY_HINT = 15;
const W_ONTOLOGY_MATCH_BOOST = 25;          // §2: boost, not filter
const W_NATURE_COMPAT = 15;
const W_NATURE_INCOMPATIBLE_PENALTY = -20;
const W_ACCOUNT_ROLE_MATCH = 10;
const W_DEPT_AFFINITY = 12;
const W_LINE_ITEM_JACCARD_MAX = 20;
const W_VENDOR_HISTORY_BOOST = 6;            // supporting only, capped
const W_NON_POSTABLE_PENALTY = -100;         // effectively removes
const W_INACTIVE_PENALTY = -100;
// Sprint 3 · Phase 4 Slice 5.3 (2026-08-08, amendment #12) —
// capital-decision boosts. Applied only when
// capitalDecisionConfidence >= 40 (COMMIT_MIN_CONFIDENCE mirror).
const W_CAPITAL_ASSET_MATCH = 22;            // asset acct when CAPITAL_CANDIDATE
const W_CAPITAL_ASSET_CATEGORY = 8;          // categoryKey capitalAssets
const W_RM_EXPENSE_MATCH = 22;               // R&M expense when REPAIR_MAINTENANCE
const W_RM_EXPENSE_NAME_HIT = 8;             // account name contains repair/maintenance
const W_CAPITAL_ACCOUNT_CONTRADICTION = -30; // asset acct when REPAIR_MAINTENANCE
const W_RM_EXPENSE_CONTRADICTION = -14;      // R&M expense when CAPITAL_CANDIDATE

/** A defensible winner needs at least this to promote. Set moderately
 *  so a strong ontology + type + line-item Jaccard combination can
 *  clear it, but a bare category-hint match cannot. */
const COMMIT_MIN_SCORE = 45;

// -----------------------------------------------------------------------------
// Public entrypoint
// -----------------------------------------------------------------------------

export function rankPurposeDrivenAccounts(input: PurposeDrivenRankerInput): PurposeDrivenRankerResult {
  const concept = input.purposeDecision.concept;
  if (!concept) {
    return {
      candidates: [], winner: null, totalConsidered: 0,
      diagnostic: "no committed concept",
    };
  }
  const typeAcceptable = new Set(PURPOSE_ACCOUNT_TYPE[concept] ?? PURPOSE_ACCOUNT_TYPE.OTHER);
  const categoryHints = new Set(PURPOSE_CATEGORY_HINTS[concept] ?? []);
  const vendorHistorySet = new Set(input.vendorHistoryPreferredAccountNumbers ?? []);

  // Aggregate primary-purchase item descriptions once for Jaccard.
  const itemTokens = tokenize(input.canonicalLineItems
    .filter((li) => li.role === "PRIMARY_PURCHASE" || li.role === "SURCHARGE" || li.role === "FREIGHT")
    .map((li) => li.description)
    .join(" "));

  const scored: PurposeDrivenScoredAccount[] = [];

  for (const a of input.eligibleAccounts) {
    const components = {
      purposeCompat: 0,
      ontologyMatch: 0,
      natureCompat: 0,
      accountRoleMatch: 0,
      departmentAffinity: 0,
      lineItemJaccard: 0,
      vendorHistoryBoost: 0,
      capitalNatureBoost: 0,
    };
    const contradictions: string[] = [];

    // (a) purpose→type compatibility
    if (typeAcceptable.has(a.type.toUpperCase())) {
      components.purposeCompat += W_PURPOSE_TYPE_MATCH;
    } else {
      // Amendment #2: lack of match must not auto-exclude. Instead
      // it becomes a moderate contradiction.
      components.purposeCompat -= 5;
      contradictions.push(`account_type_${a.type}_not_in_purpose_types(${[...typeAcceptable].join(",")})`);
    }
    if (a.categoryKey && categoryHints.has(a.categoryKey)) {
      components.purposeCompat += W_PURPOSE_CATEGORY_HINT;
    }

    // (b) ontology name-substring boost
    const ontology = evaluatePurposeAccountAffinity(concept, a.name);
    if (ontology) {
      components.ontologyMatch += W_ONTOLOGY_MATCH_BOOST;
    }

    // (c) nature-compat
    const acceptableTypesForNature = ACCEPTABLE_TYPES_BY_NATURE[input.natureLeader];
    if (acceptableTypesForNature && acceptableTypesForNature.has(a.type.toUpperCase())) {
      components.natureCompat += W_NATURE_COMPAT;
    } else if (input.natureIsDefensible && acceptableTypesForNature) {
      components.natureCompat += W_NATURE_INCOMPATIBLE_PENALTY;
      contradictions.push(`nature_${input.natureLeader}_rejects_type_${a.type}`);
    }

    // (d) account-role alignment (e.g. accountRole == "OPERATING_EXPENSE"
    // for FUEL / EQUIPMENT_PARTS / R&M)
    if (a.accountRole && purposeExpectedRoles(concept).includes(String(a.accountRole))) {
      components.accountRoleMatch += W_ACCOUNT_ROLE_MATCH;
    }

    // (e) department affinity
    if (input.departmentAccountNamePatterns && input.departmentAccountNamePatterns.length > 0) {
      if (input.departmentAccountNamePatterns.some((p) => p.test(a.name))) {
        components.departmentAffinity += W_DEPT_AFFINITY;
      }
    }

    // (f) line-item Jaccard vs account name
    if (itemTokens.size > 0) {
      const nameTokens = tokenize(a.name);
      let hits = 0;
      for (const t of nameTokens) if (itemTokens.has(t)) hits++;
      const jaccard = nameTokens.size === 0 ? 0 : hits / Math.max(nameTokens.size, itemTokens.size);
      components.lineItemJaccard += Math.round(jaccard * W_LINE_ITEM_JACCARD_MAX);
    }

    // (g) vendor-history boost (supporting only)
    if (vendorHistorySet.has(a.accountNumber)) {
      components.vendorHistoryBoost += W_VENDOR_HISTORY_BOOST;
    }

    // (h) Sprint 3 · Phase 4 Slice 5.3 (2026-08-08, amendment #12) —
    // capital-decision boosts. Applied only when the decision was
    // committed (confidence >= 40 in evaluateCapitalEvidence). The
    // capital-decision authority is separate from taxonomy purpose;
    // it may reinforce or contradict a given account regardless of
    // purpose.
    const capitalDecision = input.capitalDecision;
    const capitalConfidence = input.capitalDecisionConfidence ?? 0;
    if (capitalDecision && capitalConfidence >= 40) {
      const typeUpper = a.type.toUpperCase();
      const nameLower = a.name.toLowerCase();
      const rmNameHit = /\b(?:repair|maintenance|r&m|r\/m)\b/.test(nameLower);
      const catUpper = (a.categoryKey ?? "").toUpperCase();
      if (capitalDecision === "CAPITAL_CANDIDATE") {
        if (typeUpper === "ASSET") {
          components.capitalNatureBoost += W_CAPITAL_ASSET_MATCH;
          if (catUpper.includes("CAPITAL") || catUpper.includes("FIXED")) {
            components.capitalNatureBoost += W_CAPITAL_ASSET_CATEGORY;
          }
        } else if (rmNameHit) {
          components.capitalNatureBoost += W_RM_EXPENSE_CONTRADICTION;
          contradictions.push("capital_candidate_but_account_is_rm_expense");
        }
      } else if (capitalDecision === "REPAIR_MAINTENANCE") {
        if (typeUpper === "EXPENSE" && rmNameHit) {
          components.capitalNatureBoost += W_RM_EXPENSE_MATCH + W_RM_EXPENSE_NAME_HIT;
        } else if (typeUpper === "EXPENSE" && purposeExpectedRoles(concept).some((r) => String(r).includes("R&M") || String(r).includes("REPAIR"))) {
          components.capitalNatureBoost += W_RM_EXPENSE_MATCH;
        } else if (typeUpper === "ASSET") {
          components.capitalNatureBoost += W_CAPITAL_ACCOUNT_CONTRADICTION;
          contradictions.push("repair_maintenance_but_account_is_asset");
        }
      } else if (capitalDecision === "OPERATING") {
        if (typeUpper === "ASSET") {
          components.capitalNatureBoost += W_CAPITAL_ACCOUNT_CONTRADICTION;
          contradictions.push("operating_purchase_but_account_is_asset");
        }
      }
    }

    // Posting readiness: eligibility filter should have removed
    // non-postable, but belt-and-braces.
    let postable = a.isActive && !a.isHeader && !a.isControlAccount && a.allowManualPosting !== false;
    let total = Object.values(components).reduce((s, v) => s + v, 0);
    if (!postable) {
      total += W_NON_POSTABLE_PENALTY;
    }
    if (!a.isActive) {
      total += W_INACTIVE_PENALTY;
      contradictions.push("account_inactive");
    }

    scored.push({
      accountNumber: a.accountNumber,
      accountName: a.name,
      accountType: a.type,
      postable,
      components,
      total: Math.max(0, total),
      contradictions,
    });
  }

  scored.sort((a, b) => b.total - a.total || a.accountNumber.localeCompare(b.accountNumber));

  // Winner: highest score IF postable AND meets commit floor.
  const winner = scored.find((s) => s.postable && s.total >= COMMIT_MIN_SCORE) ?? null;

  return {
    candidates: scored,
    winner,
    totalConsidered: input.eligibleAccounts.length,
    diagnostic: `purpose=${concept} totalCoA=${input.eligibleAccounts.length} capital=${input.capitalDecision ?? "n/a"}(${input.capitalDecisionConfidence ?? 0}) winner=${winner?.accountNumber ?? "none"}(${winner?.total ?? 0}) 2nd=${scored[1]?.accountNumber ?? "-"}(${scored[1]?.total ?? 0})`,
  };
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

const ACCEPTABLE_TYPES_BY_NATURE: Partial<Record<AccountingNature, Set<string>>> = {
  CAPITAL_ASSET: new Set(["ASSET"]),
  INVENTORY: new Set(["ASSET"]),
  COST_OF_SALES: new Set(["EXPENSE", "COST_OF_SALES", "COGS"]),
  PREPAID_EXPENSE: new Set(["ASSET"]),
  OPERATING_EXPENSE: new Set(["EXPENSE", "COST_OF_SALES", "COGS"]),
  REPAIR_AND_MAINTENANCE: new Set(["EXPENSE"]),
  UTILITY_OR_RECURRING_SERVICE: new Set(["EXPENSE"]),
  PROFESSIONAL_SERVICE: new Set(["EXPENSE"]),
  TAX_OR_REGULATORY: new Set(["EXPENSE", "ASSET", "LIABILITY"]),
  INTEREST_OR_PENALTY: new Set(["EXPENSE"]),
  UNKNOWN: new Set(["EXPENSE", "ASSET", "COST_OF_SALES", "COGS"]),
};

const PURPOSE_ROLE_HINTS: Record<string, ReadonlyArray<string>> = {
  FUEL: ["OPERATING_EXPENSE", "CONSUMABLE"],
  LUBRICANTS: ["OPERATING_EXPENSE", "CONSUMABLE"],
  EQUIPMENT_PARTS: ["OPERATING_EXPENSE", "REPAIR_PART"],
  REPAIR_MAINTENANCE: ["OPERATING_EXPENSE", "R_AND_M"],
  CAPITAL_EQUIPMENT: ["CAPITAL_ASSET"],
  TELECOMMUNICATIONS: ["OPERATING_EXPENSE"],
  INTERNET_CONNECTIVITY: ["OPERATING_EXPENSE"],
  SOFTWARE_SUBSCRIPTION: ["OPERATING_EXPENSE"],
  PROFESSIONAL_MEMBERSHIP: ["OPERATING_EXPENSE"],
  PROFESSIONAL_SERVICES: ["OPERATING_EXPENSE"],
  BUILDING_MAINTENANCE: ["OPERATING_EXPENSE", "R_AND_M"],
  COURSE_MAINTENANCE: ["OPERATING_EXPENSE"],
  OFFICE_SUPPLIES: ["OPERATING_EXPENSE"],
  INTEREST: ["OPERATING_EXPENSE"],
  PENALTY: ["OPERATING_EXPENSE"],
};

function purposeExpectedRoles(concept: string): string[] {
  return [...(PURPOSE_ROLE_HINTS[concept] ?? [])];
}

function tokenize(text: string): Set<string> {
  return new Set(
    text.toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 3),
  );
}
