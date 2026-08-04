// Sprint 3 · Checkpoint 16C (2026-08-04) — nature-scoped COA
// branch search.
//
// Founder rule §5: when accounting nature is defensible, do NOT
// rely on the broad ranker's top-5 shortlist to surface a
// nature-compatible account. Load the FULL tenant COA branch that
// matches the nature and rank within it.
//
// Rule §8: exclude accumulated-depreciation, contra-asset,
// header, inactive, and control accounts. CIP eligible only when
// project / incomplete-construction evidence supports.
//
// GENERAL logic — no tenant / supplier / invoice specificity.

import type { AccountingNature } from "./accounting-nature";

// -----------------------------------------------------------------------------
// Public types
// -----------------------------------------------------------------------------

export interface CoaAccount {
  id: string;
  accountNumber: string;
  name: string;
  type: string;                        // "ASSET" | "LIABILITY" | "EQUITY" | "EXPENSE" | "REVENUE"
  isActive?: boolean;
  isHeader?: boolean;
  isControlAccount?: boolean;
  allowManualPosting?: boolean;
  categoryKey?: string | null;
  categoryName?: string | null;
  fsGroupKey?: string | null;
  fsGroupName?: string | null;
  fundApplicability?: string | null;
}

export interface NatureScopedRankingArgs {
  nature: AccountingNature;
  natureConfidence: number;
  allAccounts: CoaAccount[];
  // Evidence signals passed through for account-name similarity
  // scoring. Lines are used as-is; matching is case-insensitive.
  lineItemDescriptions: string[];
  fullDocumentText: string | null;
  supplierName: string | null;
  // Optional: department signal to boost department-compatible
  // account names. When departmentKey is set, account names whose
  // tokens overlap the department-lexicon receive a small boost.
  departmentKey?: string | null;
  departmentAccountNamePatterns?: RegExp[];
}

export interface NatureScopedCandidate {
  account: CoaAccount;
  score: number;
  reasons: string[];
  isPostable: boolean;
  postingBlockers: string[];
}

export interface NatureScopedRankingResult {
  compatibleAccountCount: number;
  excludedAccountCount: number;
  excludedReasons: Record<string, number>;
  ranked: NatureScopedCandidate[];
  leader: NatureScopedCandidate | null;
}

// -----------------------------------------------------------------------------
// Compatibility layer (§6)
// -----------------------------------------------------------------------------

// Categories/FS-groups a nature considers COMPATIBLE. Matching is
// case-insensitive substring on both categoryKey and categoryName +
// fsGroupKey/name. Tenant COAs use inconsistent conventions
// (ADMIN_EXPENSES / repairs_maintenance / …), so this uses loose
// substring matching. Any account whose type + category/fsGroup
// substring matches is a candidate.
const NATURE_COMPATIBILITY: Record<AccountingNature, {
  types: string[];
  categorySubstrings: string[];
  fsGroupSubstrings: string[];
  nameSubstrings: string[];      // used ALSO as ranking-boost signal
  excludeNameSubstrings: string[];
}> = {
  CAPITAL_ASSET: {
    types: ["ASSET"],
    categorySubstrings: ["fixed", "capital", "equipment", "vehicle", "building", "leasehold", "improvement", "asset"],
    fsGroupSubstrings: ["fixed_assets", "capital_assets", "property_plant"],
    nameSubstrings: [
      "equipment", "machinery", "vehicle", "computer", "building", "furniture",
      "fixtures", "leasehold", "improvement", "land", "construction", "hardware",
    ],
    excludeNameSubstrings: [
      "accumulated depreciation", "accum depreciation", "accum. depreciation",
      "amortization", "depreciation - ",
    ],
  },
  REPAIR_AND_MAINTENANCE: {
    types: ["EXPENSE"],
    categorySubstrings: ["repair", "maintenance", "supplies", "grounds", "building"],
    fsGroupSubstrings: ["operating_expenses"],
    nameSubstrings: ["repair", "maintenance", "parts", "grounds", "supplies", "service"],
    excludeNameSubstrings: [],
  },
  UTILITY_OR_RECURRING_SERVICE: {
    types: ["EXPENSE"],
    categorySubstrings: ["utility", "utilities", "admin", "office", "communication", "telephone", "internet", "subscription"],
    fsGroupSubstrings: ["operating_expenses"],
    nameSubstrings: ["telephone", "internet", "cable", "utility", "hydro", "gas", "water", "electricity", "subscription", "communication", "waste"],
    excludeNameSubstrings: [],
  },
  PROFESSIONAL_SERVICE: {
    types: ["EXPENSE"],
    categorySubstrings: ["professional", "admin", "office", "membership"],
    fsGroupSubstrings: ["operating_expenses"],
    nameSubstrings: ["accounting", "audit", "legal", "consult", "professional", "membership", "dues", "cpa", "advisor"],
    excludeNameSubstrings: [],
  },
  OPERATING_EXPENSE: {
    types: ["EXPENSE"],
    categorySubstrings: ["admin", "office", "operating", "supplies", "other"],
    fsGroupSubstrings: ["operating_expenses"],
    nameSubstrings: ["office", "supplies", "postage", "printing", "stationery", "operating"],
    excludeNameSubstrings: [],
  },
  COST_OF_SALES: {
    types: ["EXPENSE"],
    categorySubstrings: ["cost_of_sales", "cogs", "food_cost", "beverage_cost", "food", "beverage"],
    fsGroupSubstrings: ["cost_of_sales", "cogs"],
    nameSubstrings: ["food", "beverage", "cost of", "cogs", "produce", "meat", "dairy", "seafood"],
    excludeNameSubstrings: [],
  },
  INVENTORY: {
    types: ["ASSET"],
    categorySubstrings: ["inventory", "current_assets", "stock"],
    fsGroupSubstrings: ["inventory"],
    nameSubstrings: ["inventory", "stock", "merchandise", "for resale"],
    excludeNameSubstrings: [],
  },
  PREPAID_EXPENSE: {
    types: ["ASSET"],
    categorySubstrings: ["prepaid", "current_assets"],
    fsGroupSubstrings: ["current_assets"],
    nameSubstrings: ["prepaid", "insurance premium"],
    excludeNameSubstrings: [],
  },
  TAX_OR_REGULATORY: {
    types: ["EXPENSE"],
    categorySubstrings: ["tax", "licenses", "permit", "regulatory"],
    fsGroupSubstrings: ["operating_expenses"],
    nameSubstrings: ["property tax", "license", "permit", "franchise tax", "regulatory"],
    excludeNameSubstrings: [],
  },
  INTEREST_OR_PENALTY: {
    types: ["EXPENSE"],
    categorySubstrings: ["interest", "finance", "penalty", "bank"],
    fsGroupSubstrings: ["operating_expenses", "financing"],
    nameSubstrings: ["interest", "finance charge", "penalty", "late fee", "bank charges"],
    excludeNameSubstrings: [],
  },
  UNKNOWN: {
    types: [],
    categorySubstrings: [],
    fsGroupSubstrings: [],
    nameSubstrings: [],
    excludeNameSubstrings: [],
  },
};

// -----------------------------------------------------------------------------
// Public entrypoint
// -----------------------------------------------------------------------------

/**
 * Rank every nature-compatible account in the tenant COA.
 * Excludes contra/depreciation/header/inactive/control accounts.
 * Uses account-name similarity to line-item descriptions +
 * document text as the primary ranking signal.
 */
export function rankNatureScopedAccounts(args: NatureScopedRankingArgs): NatureScopedRankingResult {
  const spec = NATURE_COMPATIBILITY[args.nature];
  if (!spec || spec.types.length === 0) {
    return { compatibleAccountCount: 0, excludedAccountCount: 0, excludedReasons: {}, ranked: [], leader: null };
  }

  const excludedReasons: Record<string, number> = {};
  const eligible: CoaAccount[] = [];
  for (const a of args.allAccounts) {
    const bumpExcluded = (reason: string) => {
      excludedReasons[reason] = (excludedReasons[reason] ?? 0) + 1;
    };
    // Type match required.
    if (!spec.types.includes(a.type)) { bumpExcluded("type_mismatch"); continue; }
    // Never rank header or inactive or control accounts.
    if (a.isHeader) { bumpExcluded("header"); continue; }
    if (a.isActive === false) { bumpExcluded("inactive"); continue; }
    if (a.isControlAccount) { bumpExcluded("control"); continue; }
    // Exclude accumulated depreciation / contra by name pattern.
    const nameLower = a.name.toLowerCase();
    if (spec.excludeNameSubstrings.some((s) => nameLower.includes(s))) {
      bumpExcluded("contra_or_depreciation");
      continue;
    }
    // Compatibility gate — accept if EITHER category/fsGroup substring matches
    // OR the account NAME itself contains a nature-related substring.
    // (Tenant COAs vary widely in how they organise category keys;
    // name-based fallback ensures we don't miss real matches.)
    const categoryLower = (a.categoryKey ?? "").toLowerCase() + " " + (a.categoryName ?? "").toLowerCase();
    const fsGroupLower = (a.fsGroupKey ?? "").toLowerCase() + " " + (a.fsGroupName ?? "").toLowerCase();
    const categoryMatch = spec.categorySubstrings.some((s) => categoryLower.includes(s));
    const fsGroupMatch = spec.fsGroupSubstrings.some((s) => fsGroupLower.includes(s));
    const nameMatch = spec.nameSubstrings.some((s) => nameLower.includes(s));
    if (!categoryMatch && !fsGroupMatch && !nameMatch) {
      bumpExcluded("no_compatibility_signal");
      continue;
    }
    eligible.push(a);
  }

  // Score each eligible account by evidence similarity.
  const surface = [
    ...args.lineItemDescriptions,
    args.fullDocumentText ?? "",
  ].join("\n").toLowerCase();

  const ranked: NatureScopedCandidate[] = eligible.map((a) => {
    const reasons: string[] = [];
    let score = 0;
    const nameLower = a.name.toLowerCase();

    // Category / fsGroup category alignment — a stable but modest
    // base score so the ranker prefers well-categorised accounts.
    const categoryLower = (a.categoryKey ?? "").toLowerCase() + " " + (a.categoryName ?? "").toLowerCase();
    const fsGroupLower = (a.fsGroupKey ?? "").toLowerCase() + " " + (a.fsGroupName ?? "").toLowerCase();
    if (spec.categorySubstrings.some((s) => categoryLower.includes(s))) { score += 10; reasons.push("category_match"); }
    if (spec.fsGroupSubstrings.some((s) => fsGroupLower.includes(s))) { score += 6; reasons.push("fsgroup_match"); }

    // Name-hint match — account name contains a nature-substantive
    // token (e.g. "equipment", "telephone", "repair"). Specificity
    // matters: an account with more distinct nature hints beats one
    // with fewer.
    let nameHits = 0;
    for (const hint of spec.nameSubstrings) {
      if (nameLower.includes(hint)) { nameHits++; }
    }
    if (nameHits > 0) {
      // Raise cap so 3+-hint accounts continue to accumulate score.
      score += Math.min(60, nameHits * 15);
      reasons.push(`name_hint_hits:${nameHits}`);
    }

    // Evidence similarity — bidirectional token overlap between
    // account name and extraction. Weighted LOW so a generic
    // "repair"/"parts" overlap can't beat a name-specific match
    // like "grounds"/"equipment".
    const nameTokens = tokenize(a.name);
    // Filter out generic ranker-hint tokens (which already
    // contributed via nameHits) to avoid double-counting.
    const specHintsLower = new Set(spec.nameSubstrings.map((h) => h.toLowerCase()));
    let matchedNameTokens = 0;
    for (const t of nameTokens) {
      if (t.length < 4) continue;
      if (specHintsLower.has(t)) continue;
      if (surface.includes(t)) { matchedNameTokens++; }
    }
    if (matchedNameTokens > 0) {
      score += matchedNameTokens * 4;
      reasons.push(`extraction_evidence_matches_name:${matchedNameTokens}`);
    }

    // Department affinity (§9 + 16D §12 — MATERIAL boost). When
    // invoice evidence supports a department, an account whose
    // name contains department-qualifying tokens receives a strong
    // preference over a generic same-nature account. Sized to
    // dominate the two-name-hint bonus (30) so a
    // department-specific "R & M - Ground Equip" or "Equipment &
    // Fixtures - Grounds" wins over a generic "Supplies -
    // Backshop & Cart Parts" for a grounds-context invoice.
    if (args.departmentAccountNamePatterns && args.departmentKey) {
      const deptHit = args.departmentAccountNamePatterns.some((p) => p.test(nameLower));
      if (deptHit) {
        score += 35;
        reasons.push(`department_affinity:${args.departmentKey}`);
      } else if (args.departmentAccountNamePatterns.length > 0) {
        // §12 rule: department-mismatch is a signal — reduce the
        // account's score when a defensible/hint department exists
        // but this account belongs to a different department.
        // Cross-department accounts should not win by default.
        //
        // Applied ONLY when the account name contains SOME
        // department-qualifying token that clearly isn't ours —
        // e.g. "Backshop" (golf_shop) when we want grounds. If the
        // account name contains no departmental token at all
        // (e.g. plain "Equipment"), no penalty.
        const ANY_DEPT_TOKEN = /\b(?:kitchen|bar|lounge|grounds?|course|turf|fairway|greens?|irrigation|pro\s*shop|golf\s*shop|backshop|clubhouse|kitchen|admin|office|technology|computer|network|telephone|internet|housekeeping|banquet|event)\b/i;
        if (ANY_DEPT_TOKEN.test(nameLower)) {
          score -= 20;
          reasons.push(`department_mismatch_penalty:${args.departmentKey}`);
        }
      }
    }

    // Specificity — shorter, more focused account names are
    // preferred over generic ones (e.g. "Repair Parts - Grounds"
    // beats "Other Expenses").
    if (nameLower.includes("other")) { score -= 8; reasons.push("penalty_generic_other"); }
    if (nameLower.includes("misc")) { score -= 4; reasons.push("penalty_misc"); }

    // Posting eligibility — kept separate; do NOT deduct from
    // semantic score for a posting blocker per §10.
    const postingBlockers: string[] = [];
    if (a.allowManualPosting === false) postingBlockers.push("MANUAL_POSTING_DISALLOWED");
    if (!a.fundApplicability || a.fundApplicability.trim() === "") {
      // Only mark as blocker for EXPENSE accounts (per existing
      // 15V allocation gate).
      if (a.type === "EXPENSE") postingBlockers.push("FUND_APPLICABILITY_UNMAPPED");
    }

    return {
      account: a,
      score,
      reasons,
      isPostable: postingBlockers.length === 0,
      postingBlockers,
    };
  });

  ranked.sort((a, b) => b.score - a.score || a.account.accountNumber.localeCompare(b.account.accountNumber));
  const leaderCandidate = ranked[0];
  // Only surface a leader when score clears a floor. Otherwise we
  // return the ranked list for diagnostics but no leader.
  const leader = leaderCandidate && leaderCandidate.score >= 10 ? leaderCandidate : null;

  return {
    compatibleAccountCount: eligible.length,
    excludedAccountCount: args.allAccounts.length - eligible.length,
    excludedReasons,
    ranked,
    leader,
  };
}

function tokenize(s: string): string[] {
  return s.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 3);
}
