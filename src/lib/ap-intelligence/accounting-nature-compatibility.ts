// Sprint 3 · Phase 4 Slice 5.5 (2026-08-08) — Accounting-Nature
// Compatibility gate + Capital-Aware full-COA ranker.
//
// Founder §3–§7:
//   • When CapitalEvidenceDecision commits to CAPITAL_CANDIDATE with
//     defensible confidence, the eligible tenant COA must be scoped
//     to ACCOUNTING-NATURE-COMPATIBLE accounts BEFORE ranking.
//   • Capital nature does not directly select an account. It
//     narrows the search space; per-account ranking still happens
//     via independent evidence dimensions.
//   • Truthful abstention is preserved: when the compatible pool
//     has ≥2 candidates without a defensible discriminator, no GL
//     is fabricated.
//   • Applies equally to any durable-asset transaction (grounds
//     machinery, kitchen equipment, vehicles, IT hardware, F&F,
//     irrigation, building equipment, clubhouse). NO supplier /
//     product / SKU literals.
//
// §5: department inference remains SEPARATE from accounting nature.
// The ranker can favour a department-compatible capital account
// when department is independently defensible; when not, it prefers
// a broader compatible capital account or abstains — never invents
// a department.
//
// §6: per-dimension scoring so inspect-wi shows WHY each account
// won or lost.
//
// §9: PRICE is not a capitalization input to this module. All
// scoring is derived from tenant COA metadata, purchased-object
// evidence, and department evidence.

import type { CapitalDecision, CapitalEvidenceDecisionResult } from "./capital-evidence";
import type { ProductIdentityResolution } from "./product-identity-resolution";
import type { PurchasedObjectIdentity } from "./purchased-object-identity";
import type { DepartmentInferenceResult } from "./department-inference";
import {
  resolveAccountSemantics,
  type AccountSemantics,
  type CapitalAccountRole,
  type AccountFunctionalRole,
  type SemanticsProvenance,
} from "./account-semantics";
import {
  detectCipEvidence,
  type CipEvidenceResult,
} from "./account-semantics/cip-evidence";
import {
  detectFinancingEvidence,
  type FinancingEvidenceResult,
} from "./account-semantics/financing-evidence";
import {
  evaluateCompatibilityGate,
  type CompatibilityGateResult,
  type CompatibilityVerdict,
} from "./account-semantics/compatibility-gate";

// -----------------------------------------------------------------------------
// Public types
// -----------------------------------------------------------------------------

export interface EligibleAccountView {
  accountNumber: string;
  name: string;
  type: string;
  normalBalance: string;
  isActive: boolean;
  isHeader: boolean;
  allowManualPosting: boolean;
  isControlAccount: boolean;
  isBankAccount: boolean;
  isCashAccount: boolean;
  categoryKey: string | null;
  fsGroupKey: string | null;
  accountRole: string | null;
}

export type NatureCompatibility =
  | "COMPATIBLE"
  | "PREFERRED"
  | "NEUTRAL"
  | "CONTRADICTED"
  | "INCOMPATIBLE";

export interface CapitalAwareRankingInput {
  capitalDecision: CapitalEvidenceDecisionResult;
  productIdentity: ProductIdentityResolution;
  purchasedObjects: PurchasedObjectIdentity[];
  departmentResult: DepartmentInferenceResult;
  eligibleAccounts: EligibleAccountView[];
  /** Vendor-history coding — SUPPORTING only, capped weight. */
  vendorHistoryPreferredAccountNumbers?: string[];
  /** Committed capital-decision confidence threshold. Default 40. */
  commitFloor?: number;
  /** Slice 5.6 live-acceptance §14: additional text surface (e.g.
   *  external product-family names) that the functional-department
   *  inferrer will scan for department-vocabulary hits alongside
   *  purchased-object descriptions. Pass empty string to opt out. */
  additionalDeptSurface?: string;
  /** Slice 5.7A: transactional functional signals fed to the
   *  compatibility gate (§Amendment 2). Typically composed from
   *  purchased-object descriptions + external product-family text
   *  + supplier context — the same surface functional-department
   *  inference uses. */
  transactionFunctionalSignals?: string[];
  /** Optional additional text for CIP + financing evidence
   *  detection (e.g. supplier notes, PO metadata). Purchased
   *  object descriptions are always included by the detector. */
  additionalEvidenceTexts?: string[];
}

export interface CapitalAwareCandidate {
  accountNumber: string;
  accountName: string;
  accountType: string;
  postable: boolean;
  natureCompat: NatureCompatibility;
  dimensions: {
    accountingNature: number;
    department: number;
    purpose: number;
    objectIdentity: number;
    accountNameSimilarity: number;
    category: number;
    fsGroup: number;
    history: number;
    postingEligibility: number;
  };
  totalScore: number;
  supportingEvidence: string[];
  contradictions: string[];
  // Slice 5.7A §16 diagnostics — every capital candidate exposes
  // its account semantics, per-dimension compatibility verdict, and
  // final verdict for founder auditability.
  semantics?: AccountSemantics;
  compatibility?: CompatibilityGateResult;
  finalVerdict?: CompatibilityVerdict;
  rejectionReasons?: string[];
}

export interface CapitalAwareRankingResult {
  /** True when the caller should consult this authority (capital
   *  decision committed AND absolute confidence >= floor). */
  active: boolean;
  compatiblePool: CapitalAwareCandidate[];
  contradictedPool: CapitalAwareCandidate[];
  winner: CapitalAwareCandidate | null;
  abstained: boolean;
  abstentionReason: string | null;
  diagnostic: string;
}

// -----------------------------------------------------------------------------
// Nature-compat weights & functional-department vocab
// -----------------------------------------------------------------------------

const W_NATURE_PREFERRED = 30;
const W_NATURE_COMPATIBLE = 18;
const W_NATURE_CONTRADICTED = -35;
const W_NATURE_INCOMPATIBLE = -100;   // effectively excludes

const W_DEPT_COMPATIBLE = 22;
const W_DEPT_STRONG_COMPATIBLE = 30;
const W_DEPT_NEUTRAL = 0;
const W_DEPT_CONTRADICTED = -12;

const W_OBJECT_IDENTITY_MATCH = 18;   // brand/model/product-family match
const W_ACCOUNT_NAME_SIM_MAX = 12;    // token overlap with object description
const W_CATEGORY_STRONG_MATCH = 10;   // categoryKey aligns with nature
const W_FSGROUP_STRONG_MATCH = 6;
const W_HISTORY_BOOST = 6;
const W_POSTING_ELIGIBLE_BONUS = 0;   // eligibility is a gate, not a bonus
const W_NON_POSTABLE = -100;

const W_PURPOSE_HINT = 8;             // small — purpose no longer dominates when nature is committed

const ABSTAIN_GAP_MIN = 10;

// Function-driven department vocabulary — GENERIC. Purchased-object
// descriptions and product-family tokens (from OEM identity when
// available; internal now) hit these to support a department.
// NO supplier / product / SKU literals.
const FUNCTIONAL_DEPT_VOCAB: Record<string, RegExp[]> = {
  grounds: [
    /\b(?:mower|greensmower|walking\s*mower|fairway\s*mower|rough\s*mower|reel\s*mower|rotary\s*mower)\b/i,
    /\b(?:tractor|utility\s*vehicle|aerator|topdresser|sprayer|blower|verticutter)\b/i,
    // §14 completion — prefix patterns so grounds-adjacent product
    // families ("Groundsmaster", "Groundskeeper", etc.) match.
    /\bgrounds[a-z]*\b/i,
    /\bturf[a-z]*\b/i,
    /\b(?:fairway|greens?|rough|tee\s*box(?:es)?|irrigation|fertili(?:z|s)er|topdressing|pesticide|herbicide|fungicide|insecticide|golf\s*course)\b/i,
    /\b(?:golf\s*cart|cart\s*fleet)\b/i,
  ],
  kitchen: [
    /\b(?:dishwasher|oven|range|refrigerator|freezer|ice\s*machine|deep\s*fryer|combi\s*oven|walk[-\s]?in)\b/i,
    /\b(?:culinary|pastry|chef|food\s*prep|kitchen)\b/i,
  ],
  food_beverage: [
    /\b(?:food|beverage|catering|restaurant|dining|banquet|bar|lounge|draft|wine|spirits?|bartender)\b/i,
  ],
  golf_shop: [
    /\b(?:pro\s*shop|golf\s*shop|merchandise|apparel|balls|gloves|clubs?)\b/i,
  ],
  golf_operations: [
    /\b(?:tee\s*sheet|range\s*ball|starter|marshal|handicap)\b/i,
  ],
  events: [
    /\b(?:event|wedding|function|hospitality|conference|reception|banquet)\b/i,
  ],
  housekeeping: [
    /\b(?:housekeeping|cleaning|janitorial|linen|laundry)\b/i,
  ],
  maintenance: [
    /\b(?:hvac|plumbing|electrician|handyman|building\s*maintenance)\b/i,
  ],
  administration: [
    /\b(?:office|administration|accounting|payroll|human\s*resources|management)\b/i,
  ],
  it: [
    /\b(?:server|desktop|laptop|workstation|printer|photocopier|network|router|switch|firewall|software|saas|licen[cs]e)\b/i,
  ],
  utilities: [
    /\b(?:hydro|water\s*service|gas\s*service|electricity|natural\s*gas)\b/i,
  ],
  clubhouse: [
    /\b(?:clubhouse|main\s*building|front\s*of\s*house)\b/i,
  ],
};

// Account-name patterns that identify which department a CAPITAL_ASSETS
// account belongs to. Consumed by the department-compatibility scorer.
// Closed generic list; no tenant-specific hardcoding.
const ACCOUNT_NAME_DEPT_PATTERNS: Record<string, RegExp[]> = {
  grounds: [/\bgrounds?\b/i, /\bcourse\b/i, /\bturf\b/i, /\bfairway\b/i, /\bgreens?\b/i, /\birrigat/i],
  kitchen: [/\bkitchen\b/i, /\bculinary\b/i, /\bfood\s*service\b/i],
  food_beverage: [/\bf\s*&\s*b\b/i, /\bfood\b/i, /\bbeverage\b/i, /\bdining\b/i, /\brestaurant\b/i],
  golf_shop: [/\bpro\s*shop\b/i, /\bgolf\s*shop\b/i, /\bmerchandise\b/i, /\bbackshop\b/i],
  golf_operations: [/\btee\s*sheet\b/i, /\brange\b/i, /\bcart\s*fleet\b/i, /\bstarter\b/i],
  events: [/\bevent\b/i, /\bwedding\b/i, /\bbanquet\b/i, /\breception\b/i],
  housekeeping: [/\bhousekeep/i, /\bjanitorial\b/i, /\blinen\b/i],
  maintenance: [/\bmaintenance\b/i, /\brepair\b/i, /\bhvac\b/i, /\bfacilit/i],
  administration: [/\badmin/i, /\boffice\b/i, /\bmanagement\b/i],
  it: [/\bit\b/i, /\btechnolog/i, /\bcomputer/i, /\bnetwork/i, /\bsoftware/i],
  utilities: [/\butilit/i, /\bhydro\b/i, /\bwater\b/i, /\belectricity\b/i],
  clubhouse: [/\bclubhouse\b/i, /\bbuilding\b/i],
};

// -----------------------------------------------------------------------------
// Public entry point
// -----------------------------------------------------------------------------

export function rankCapitalAwareAccounts(
  input: CapitalAwareRankingInput,
): CapitalAwareRankingResult {
  const commitFloor = input.commitFloor ?? 40;
  const decision = input.capitalDecision.decision;
  const decisionConfidence = input.capitalDecision.confidence;

  // §7 gate: only run when the capital decision is committed at a
  // defensible confidence AND the decision is one of the compat-
  // supported categories. UNRESOLVED never triggers this ranker.
  const active = decision !== "UNRESOLVED" && decisionConfidence >= commitFloor;
  if (!active) {
    return {
      active: false,
      compatiblePool: [], contradictedPool: [], winner: null,
      abstained: true,
      abstentionReason: `capital-aware ranker inactive (decision=${decision}, confidence=${decisionConfidence} < ${commitFloor})`,
      diagnostic: "inactive",
    };
  }

  // §5 derive functional department from purchased-object descriptions
  // (which include brand + model + object nouns). This runs even when
  // the inbound department-inference authority did not commit — a
  // function-driven signal can be strong enough on its own for a
  // department-compatible capital account.
  const functionalDept = inferFunctionalDepartment(input.purchasedObjects, input.additionalDeptSurface);

  // Slice 5.7A: compute CIP + financing evidence ONCE per document,
  // then apply the compatibility gate per account BEFORE scoring.
  const cipEvidence = detectCipEvidence(input.purchasedObjects, input.additionalEvidenceTexts ?? []);
  const financingEvidence = detectFinancingEvidence(input.purchasedObjects, input.additionalEvidenceTexts ?? []);

  // Transaction-side functional signals: purchased-object descriptions
  // + external product-family text + supplier context. Used by the
  // gate to distinguish organizational department from transactional
  // function (§Amendment 2).
  const transactionSignals = input.transactionFunctionalSignals
    ?? [
      ...input.purchasedObjects.map((o) => o.description),
      input.additionalDeptSurface ?? "",
    ].filter(Boolean);

  const transactionDepartment = input.departmentResult.leader?.key
    ?? functionalDept
    ?? null;

  const primaryObjectType = input.productIdentity.selected?.objectType ?? null;

  // Score every eligible account.
  const compatible: CapitalAwareCandidate[] = [];
  const contradicted: CapitalAwareCandidate[] = [];

  for (const acct of input.eligibleAccounts) {
    // 1. Resolve account semantics from configured / structural /
    //    name-inference sources per §Amendment 3.
    const semantics = resolveAccountSemantics(acct);

    // 2. Run the compatibility gate BEFORE scoring per §COMPATIBILITY
    //    GATE. This produces a per-dimension verdict + final verdict.
    const gate = evaluateCompatibilityGate({
      semantics,
      capitalDecision: decision,
      productObjectType: primaryObjectType,
      transactionDepartment,
      transactionFunctionalSignals: transactionSignals,
      cipEvidence,
      financingEvidence,
    });

    // 3. Legacy per-dimension score is retained for diagnostic
    //    continuity + tie-breaking within the compatible pool.
    const legacyCompat = evaluateAccountingNatureCompatibility(acct, decision);
    const cand = scoreCandidate({
      account: acct,
      natureCompat: legacyCompat,
      decision,
      productIdentity: input.productIdentity,
      purchasedObjects: input.purchasedObjects,
      departmentResult: input.departmentResult,
      functionalDept,
      vendorHistory: new Set(input.vendorHistoryPreferredAccountNumbers ?? []),
    });
    cand.semantics = semantics;
    cand.compatibility = gate;
    cand.finalVerdict = gate.finalVerdict;
    cand.rejectionReasons = gate.rejectionReasons;

    // Slice 5.7A: gate-verdict adjustment. A PREFERRED-overall
    // candidate collects a bonus so it can separate from merely
    // COMPATIBLE alternatives — but only when the underlying
    // dimensions positively support it (§Amendment 1 explicit:
    // "equipment alone" does not make an account preferred).
    if (gate.finalVerdict === "PREFERRED") {
      cand.dimensions.purpose += 12;
      cand.supportingEvidence.push(`gateVerdict=PREFERRED (semantic authority)`);
    } else if (gate.finalVerdict === "CONDITIONALLY_COMPATIBLE") {
      // Conditional accounts (e.g. financing without evidence, CIP
      // with only weak evidence) should not outrank an unconditional
      // COMPATIBLE candidate. Apply a small negative to break ties.
      cand.dimensions.purpose -= 4;
      cand.supportingEvidence.push(`gateVerdict=CONDITIONALLY_COMPATIBLE (special condition not fully met)`);
    }
    // Recompute total after gate adjustment.
    cand.totalScore = Object.values(cand.dimensions).reduce((s, v) => s + v, 0);

    // §COMPATIBILITY GATE: pool assignment now derives from the gate
    // verdict, not from a single-dimension legacy nature compat.
    if (gate.finalVerdict === "INCOMPATIBLE" || gate.finalVerdict === "CONTRADICTED") {
      contradicted.push(cand);
    } else {
      compatible.push(cand);
    }
  }

  compatible.sort((a, b) => b.totalScore - a.totalScore || a.accountNumber.localeCompare(b.accountNumber));

  // §7 truthful abstention: pick a winner only when there's a
  // sufficient gap between the top-two compatible candidates AND
  // the winner is posting-eligible.
  const top = compatible[0] ?? null;
  const second = compatible[1] ?? null;
  const gap = top && second ? top.totalScore - second.totalScore : Infinity;

  let winner: CapitalAwareCandidate | null = null;
  let abstained = false;
  let abstentionReason: string | null = null;

  if (top == null) {
    abstained = true;
    abstentionReason = `no nature-compatible posting-eligible accounts found in tenant COA for decision=${decision}`;
  } else if (!top.postable) {
    abstained = true;
    abstentionReason = `top candidate ${top.accountNumber} (${top.accountName}) is not posting-eligible`;
  } else if (gap < ABSTAIN_GAP_MIN) {
    abstained = true;
    abstentionReason = `insufficient discriminator between ${top.accountNumber} (${top.accountName}, ${top.totalScore}) and ${second!.accountNumber} (${second!.accountName}, ${second!.totalScore}) — gap ${gap} < ${ABSTAIN_GAP_MIN}`;
  } else {
    winner = top;
  }

  const diagnostic = `active=true decision=${decision}(${decisionConfidence}) compatiblePool=${compatible.length} contradictedPool=${contradicted.length} top=${top?.accountNumber ?? "-"}(${top?.totalScore ?? 0}) 2nd=${second?.accountNumber ?? "-"}(${second?.totalScore ?? 0}) gap=${gap} winner=${winner?.accountNumber ?? "abstain"} functionalDept=${functionalDept ?? "-"}`;

  return {
    active: true,
    compatiblePool: compatible,
    contradictedPool: contradicted,
    winner,
    abstained,
    abstentionReason,
    diagnostic,
  };
}

// -----------------------------------------------------------------------------
// Nature compatibility (§3)
// -----------------------------------------------------------------------------

function evaluateAccountingNatureCompatibility(
  acct: EligibleAccountView,
  decision: CapitalDecision,
): NatureCompatibility {
  const typeUpper = (acct.type ?? "").toUpperCase();
  const categoryKey = (acct.categoryKey ?? "").toUpperCase();
  const fsGroupKey = (acct.fsGroupKey ?? "").toUpperCase();
  const nameLower = (acct.name ?? "").toLowerCase();

  const isRmName = /\b(?:repair|maintenance|r&m|r\/m)\b/.test(nameLower);
  const isCapitalCategory = categoryKey.includes("CAPITAL") || categoryKey.includes("FIXED") || fsGroupKey.includes("CAPITAL");
  const isDepreciationRole = (acct.accountRole ?? "").toUpperCase().includes("CONTRA");
  const isCashRole = acct.isCashAccount || acct.isBankAccount || (acct.accountRole ?? "").toUpperCase().includes("BANK");
  const isControl = acct.isControlAccount;

  if (isDepreciationRole || isControl || isCashRole) {
    return "INCOMPATIBLE";
  }

  if (decision === "CAPITAL_CANDIDATE") {
    if (typeUpper === "ASSET" && isCapitalCategory) return "PREFERRED";
    if (typeUpper === "ASSET") return "COMPATIBLE";
    if (typeUpper === "EXPENSE" && isRmName) return "CONTRADICTED";
    if (typeUpper === "EXPENSE") return "INCOMPATIBLE";
    return "NEUTRAL";
  }
  if (decision === "REPAIR_MAINTENANCE") {
    if (typeUpper === "EXPENSE" && isRmName) return "PREFERRED";
    if (typeUpper === "EXPENSE") return "COMPATIBLE";
    if (typeUpper === "ASSET" && isCapitalCategory) return "CONTRADICTED";
    if (typeUpper === "ASSET") return "INCOMPATIBLE";
    return "NEUTRAL";
  }
  if (decision === "OPERATING") {
    if (typeUpper === "EXPENSE") return "COMPATIBLE";
    if (typeUpper === "ASSET" && isCapitalCategory) return "INCOMPATIBLE";
    return "NEUTRAL";
  }
  // UNRESOLVED — the ranker is not active.
  return "NEUTRAL";
}

// -----------------------------------------------------------------------------
// Per-candidate scoring with independent dimensions (§6)
// -----------------------------------------------------------------------------

function scoreCandidate(args: {
  account: EligibleAccountView;
  natureCompat: NatureCompatibility;
  decision: CapitalDecision;
  productIdentity: ProductIdentityResolution;
  purchasedObjects: PurchasedObjectIdentity[];
  departmentResult: DepartmentInferenceResult;
  functionalDept: string | null;
  vendorHistory: Set<string>;
}): CapitalAwareCandidate {
  const supportingEvidence: string[] = [];
  const contradictions: string[] = [];
  const dims = {
    accountingNature: 0,
    department: 0,
    purpose: 0,
    objectIdentity: 0,
    accountNameSimilarity: 0,
    category: 0,
    fsGroup: 0,
    history: 0,
    postingEligibility: 0,
  };

  const acct = args.account;
  const nameLower = (acct.name ?? "").toLowerCase();

  // 1. Nature compatibility
  switch (args.natureCompat) {
    case "PREFERRED":
      dims.accountingNature = W_NATURE_PREFERRED;
      supportingEvidence.push(`nature=PREFERRED for decision=${args.decision}`);
      break;
    case "COMPATIBLE":
      dims.accountingNature = W_NATURE_COMPATIBLE;
      supportingEvidence.push(`nature=COMPATIBLE for decision=${args.decision}`);
      break;
    case "NEUTRAL":
      dims.accountingNature = 0;
      break;
    case "CONTRADICTED":
      dims.accountingNature = W_NATURE_CONTRADICTED;
      contradictions.push(`nature=CONTRADICTED for decision=${args.decision}`);
      break;
    case "INCOMPATIBLE":
      dims.accountingNature = W_NATURE_INCOMPATIBLE;
      contradictions.push(`nature=INCOMPATIBLE for decision=${args.decision}`);
      break;
  }

  // 2. Department compatibility (independent of nature)
  const acctDept = detectAccountDepartment(nameLower);
  const inferredDeptKey = args.departmentResult.leader?.key ?? null;
  const inferredDeptDefensible = args.departmentResult.isDefensible;
  const funcDeptKey = args.functionalDept;
  if (acctDept) {
    if (inferredDeptDefensible && acctDept === inferredDeptKey) {
      dims.department = W_DEPT_STRONG_COMPATIBLE;
      supportingEvidence.push(`department=${acctDept} matches inferred (defensible)`);
    } else if (funcDeptKey && acctDept === funcDeptKey) {
      dims.department = W_DEPT_COMPATIBLE;
      supportingEvidence.push(`department=${acctDept} matches functional inference from object`);
    } else if (inferredDeptDefensible && acctDept !== inferredDeptKey) {
      dims.department = W_DEPT_CONTRADICTED;
      contradictions.push(`account department=${acctDept} contradicts inferred=${inferredDeptKey}`);
    } else if (funcDeptKey && acctDept !== funcDeptKey) {
      dims.department = W_DEPT_CONTRADICTED;
      contradictions.push(`account department=${acctDept} contradicts functional=${funcDeptKey}`);
    } else {
      dims.department = W_DEPT_NEUTRAL;
    }
  }

  // 3. Purpose (kept small — no longer dominant when capital nature
  // is committed). Purpose only adds a small bonus for
  // capitalization-relevant purposes.
  if (args.productIdentity.selected?.objectType === "COMPLETE_MACHINE" && args.natureCompat === "PREFERRED") {
    dims.purpose = W_PURPOSE_HINT;
    supportingEvidence.push("purpose=COMPLETE_MACHINE + capital-preferred");
  }

  // 4. Object identity — brand / model / product-family token match
  // on account name.
  const primaryObj = args.purchasedObjects.length > 0
    ? [...args.purchasedObjects].sort((a, b) => (b.extension ?? 0) - (a.extension ?? 0))[0]
    : null;
  if (primaryObj) {
    const objTokens = tokenizeObjectDescription(primaryObj);
    const nameTokens = new Set(nameLower.split(/[\s\-_&/()]+/).filter((t) => t.length >= 3));
    let overlapCount = 0;
    for (const t of objTokens) if (nameTokens.has(t)) overlapCount++;
    if (overlapCount > 0) {
      dims.objectIdentity = Math.min(W_OBJECT_IDENTITY_MATCH, overlapCount * 6);
      supportingEvidence.push(`object token overlap=${overlapCount}`);
    }
  }

  // 5. Account-name Jaccard similarity with primary object
  // description tokens.
  if (primaryObj) {
    const objTokens = new Set(primaryObj.description.toLowerCase().split(/[\s,;:.\-_/()]+/).filter((t) => t.length >= 4));
    const nameTokens = new Set(nameLower.split(/[\s\-_&/()]+/).filter((t) => t.length >= 3));
    let hits = 0;
    for (const t of nameTokens) if (objTokens.has(t)) hits++;
    if (nameTokens.size > 0) {
      const jaccard = hits / Math.max(nameTokens.size, 1);
      dims.accountNameSimilarity = Math.round(jaccard * W_ACCOUNT_NAME_SIM_MAX);
    }
  }

  // 6. Category alignment with the committed nature.
  const catUpper = (acct.categoryKey ?? "").toUpperCase();
  if (args.decision === "CAPITAL_CANDIDATE" && (catUpper === "CAPITAL_ASSETS" || catUpper === "FIXED_ASSETS")) {
    dims.category = W_CATEGORY_STRONG_MATCH;
  }

  // 7. FS group alignment.
  const fsUpper = (acct.fsGroupKey ?? "").toUpperCase();
  if (args.decision === "CAPITAL_CANDIDATE" && fsUpper.includes("CAPITAL")) {
    dims.fsGroup = W_FSGROUP_STRONG_MATCH;
  }

  // 8. Vendor history — supporting only, capped.
  if (args.vendorHistory.has(acct.accountNumber)) {
    dims.history = W_HISTORY_BOOST;
    supportingEvidence.push("vendor-history preference");
  }

  // 9. Posting eligibility — GATE not bonus. Non-postable candidates
  // are DQ'd via a large negative on the total.
  const postable = acct.isActive && !acct.isHeader && !acct.isControlAccount && acct.allowManualPosting !== false;
  if (!postable) {
    dims.postingEligibility = W_NON_POSTABLE;
    contradictions.push("non-postable");
  }

  const totalScore = Object.values(dims).reduce((s, v) => s + v, 0);

  return {
    accountNumber: acct.accountNumber,
    accountName: acct.name,
    accountType: acct.type,
    postable,
    natureCompat: args.natureCompat,
    dimensions: dims,
    totalScore,
    supportingEvidence,
    contradictions,
  };
}

// -----------------------------------------------------------------------------
// Functional department inference from purchased-object evidence (§5)
// -----------------------------------------------------------------------------

function inferFunctionalDepartment(
  objects: PurchasedObjectIdentity[],
  additionalSurface?: string,
): string | null {
  const surface = [
    objects.map((o) => o.description).join(" "),
    additionalSurface ?? "",
  ].join(" ");
  if (surface.trim().length === 0) return null;
  const scores: Record<string, number> = {};
  for (const [deptKey, patterns] of Object.entries(FUNCTIONAL_DEPT_VOCAB)) {
    let hits = 0;
    for (const p of patterns) if (p.test(surface)) hits++;
    if (hits > 0) scores[deptKey] = hits;
  }
  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  return ranked[0]?.[0] ?? null;
}

function detectAccountDepartment(nameLower: string): string | null {
  for (const [deptKey, patterns] of Object.entries(ACCOUNT_NAME_DEPT_PATTERNS)) {
    for (const p of patterns) {
      if (p.test(nameLower)) return deptKey;
    }
  }
  return null;
}

function tokenizeObjectDescription(obj: PurchasedObjectIdentity): Set<string> {
  const toks = new Set<string>();
  for (const b of obj.brandCandidates) toks.add(b.value.toLowerCase());
  for (const m of obj.modelCandidates) toks.add(m.value.toLowerCase());
  for (const s of obj.skuCandidates) toks.add(s.value.toLowerCase());
  return toks;
}
