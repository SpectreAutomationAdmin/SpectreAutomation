// Sprint 3 · Phase 4 Slice 5.7A (2026-08-09) — Compatibility gate.
//
// Founder COMPATIBILITY GATE (approved):
//   Final candidate eligibility must evaluate INDEPENDENTLY:
//     NatureCompatibility
//     CapitalRoleCompatibility
//     FunctionalRoleCompatibility
//     DepartmentCompatibility
//     SpecialConditionCompatibility  (CIP evidence, financing evidence)
//     PostingEligibility
//
//   A hard CONTRADICTED / INCOMPATIBLE verdict on ANY material
//   semantic dimension prevents the candidate from winning.
//   Scoring happens AFTER compatibility.
//
// Founder Amendment 1 (approved):
//   COMPLETE_MACHINE does NOT make every EQUIPMENT_ASSET PREFERRED.
//   Function-specific accounts contradict when the object's function
//   is different (Grounds mower vs Computers equipment).

import type { CapitalDecision } from "../capital-evidence";
import type { ProductObjectType } from "../product-identity-resolution";
import type {
  AccountSemantics,
  CapitalAccountRole,
  AccountFunctionalRole,
} from "./index";
import type { CipEvidenceResult } from "./cip-evidence";
import type { FinancingEvidenceResult } from "./financing-evidence";

// -----------------------------------------------------------------------------
// Public types
// -----------------------------------------------------------------------------

export type CompatibilityVerdict =
  | "PREFERRED"
  | "COMPATIBLE"
  | "CONDITIONALLY_COMPATIBLE"
  | "NEUTRAL"
  | "CONTRADICTED"
  | "INCOMPATIBLE";

export interface DimensionVerdict {
  verdict: CompatibilityVerdict;
  reason: string;
}

export interface CompatibilityGateInput {
  semantics: AccountSemantics;
  capitalDecision: CapitalDecision;
  productObjectType: ProductObjectType | null;
  /** Functional department derived from the transaction (grounds /
   *  kitchen / it / etc.) — the org-level department of the
   *  transaction. */
  transactionDepartment: string | null;
  /** Object-derived functional signals from the transaction (e.g.
   *  purchased object descriptions include "irrigation pump" or
   *  "grounds mower"). Used to distinguish organizational department
   *  (Grounds) from transactional function (Grounds Equipment vs
   *  Irrigation) — §Amendment 2. */
  transactionFunctionalSignals: string[];
  cipEvidence: CipEvidenceResult;
  financingEvidence: FinancingEvidenceResult;
}

export interface CompatibilityGateResult {
  natureCompatibility: DimensionVerdict;
  capitalRoleCompatibility: DimensionVerdict;
  functionalRoleCompatibility: DimensionVerdict;
  departmentCompatibility: DimensionVerdict;
  specialConditionCompatibility: DimensionVerdict;
  /** Overall verdict: the WORST outcome across the dimensions
   *  wins for exclusion purposes; PREFERRED wins over COMPATIBLE
   *  when there's no contradiction. */
  finalVerdict: CompatibilityVerdict;
  /** Human-readable rejection reasons — one per dimension that
   *  produced CONTRADICTED / INCOMPATIBLE. */
  rejectionReasons: string[];
  supportingEvidence: string[];
}

// -----------------------------------------------------------------------------
// Gate function
// -----------------------------------------------------------------------------

export function evaluateCompatibilityGate(input: CompatibilityGateInput): CompatibilityGateResult {
  const {
    semantics,
    capitalDecision,
    productObjectType,
    transactionDepartment,
    transactionFunctionalSignals,
    cipEvidence,
    financingEvidence,
  } = input;

  const rejectionReasons: string[] = [];
  const supportingEvidence: string[] = [];

  // -------------------------------------------------------------------------
  // 1. Nature compatibility (capital-decision × capital-role family)
  // -------------------------------------------------------------------------
  const natureCompatibility = deriveNatureCompatibility(capitalDecision, semantics.capitalRole);

  // -------------------------------------------------------------------------
  // 2. Capital-role compatibility (object type × capital role)
  //    §Amendment 1 — Complete machine does NOT auto-prefer every
  //    equipment account.
  // -------------------------------------------------------------------------
  const capitalRoleCompatibility = deriveCapitalRoleCompatibility(
    productObjectType,
    semantics.capitalRole,
  );

  // -------------------------------------------------------------------------
  // 3. Functional-role compatibility — §Amendment 2 SEPARATE from dept
  // -------------------------------------------------------------------------
  const functionalRoleCompatibility = deriveFunctionalRoleCompatibility(
    productObjectType,
    semantics.functionalRole,
    transactionFunctionalSignals,
    transactionDepartment,
  );

  // -------------------------------------------------------------------------
  // 4. Organizational department compatibility
  // -------------------------------------------------------------------------
  const departmentCompatibility = deriveDepartmentCompatibility(
    transactionDepartment,
    semantics.organizationalDepartment,
  );

  // -------------------------------------------------------------------------
  // 5. Special-condition compatibility — CIP + financing
  // -------------------------------------------------------------------------
  const specialConditionCompatibility = deriveSpecialConditionCompatibility(
    semantics.capitalRole,
    semantics.functionalRole,
    cipEvidence,
    financingEvidence,
  );

  // Collect rejections + supports
  for (const [dim, v] of [
    ["nature", natureCompatibility],
    ["capitalRole", capitalRoleCompatibility],
    ["functionalRole", functionalRoleCompatibility],
    ["department", departmentCompatibility],
    ["specialCondition", specialConditionCompatibility],
  ] as const) {
    if (v.verdict === "CONTRADICTED" || v.verdict === "INCOMPATIBLE") {
      rejectionReasons.push(`${dim}=${v.verdict}: ${v.reason}`);
    } else if (v.verdict === "PREFERRED" || v.verdict === "COMPATIBLE") {
      supportingEvidence.push(`${dim}=${v.verdict}: ${v.reason}`);
    }
  }

  // -------------------------------------------------------------------------
  // Final verdict — hard-contradiction dominates; PREFERRED wins when
  // all dimensions are at least COMPATIBLE/CONDITIONALLY_COMPATIBLE.
  // -------------------------------------------------------------------------
  const verdicts = [
    natureCompatibility.verdict,
    capitalRoleCompatibility.verdict,
    functionalRoleCompatibility.verdict,
    departmentCompatibility.verdict,
    specialConditionCompatibility.verdict,
  ];
  const finalVerdict = combineVerdicts(verdicts);

  return {
    natureCompatibility,
    capitalRoleCompatibility,
    functionalRoleCompatibility,
    departmentCompatibility,
    specialConditionCompatibility,
    finalVerdict,
    rejectionReasons,
    supportingEvidence,
  };
}

// -----------------------------------------------------------------------------
// Dimension derivations
// -----------------------------------------------------------------------------

function deriveNatureCompatibility(
  decision: CapitalDecision,
  capitalRole: CapitalAccountRole,
): DimensionVerdict {
  if (capitalRole === "NOT_CAPITAL_ASSET") {
    if (decision === "CAPITAL_CANDIDATE") {
      return { verdict: "INCOMPATIBLE", reason: `account is not a capital asset; decision=${decision}` };
    }
    // Non-capital account with non-capital decision is fine — the
    // capital-aware ranker won't be active for that path anyway.
    return { verdict: "NEUTRAL", reason: `non-capital account; non-capital decision` };
  }
  if (capitalRole === "UNKNOWN") {
    return { verdict: "NEUTRAL", reason: "capital role unknown" };
  }
  // Any bonafide capital role is compatible with CAPITAL_CANDIDATE at
  // the nature level; the finer role gating happens in
  // capitalRoleCompatibility.
  if (decision === "CAPITAL_CANDIDATE") {
    return { verdict: "PREFERRED", reason: `capital-asset account for CAPITAL_CANDIDATE decision` };
  }
  if (decision === "REPAIR_MAINTENANCE") {
    return { verdict: "CONTRADICTED", reason: `capital-asset account contradicts REPAIR_MAINTENANCE decision` };
  }
  if (decision === "OPERATING") {
    return { verdict: "INCOMPATIBLE", reason: `capital-asset account is incompatible with OPERATING decision` };
  }
  return { verdict: "NEUTRAL", reason: "capital decision is UNRESOLVED" };
}

function deriveCapitalRoleCompatibility(
  objectType: ProductObjectType | null,
  capitalRole: CapitalAccountRole,
): DimensionVerdict {
  if (capitalRole === "NOT_CAPITAL_ASSET") {
    // §Amendment 3 nuance: non-capital accounts are only INCOMPATIBLE
    // when the decision is CAPITAL_CANDIDATE. For REPAIR_MAINTENANCE
    // / OPERATING decisions, non-capital (EXPENSE) accounts are the
    // expected class — capital-role scoring stays NEUTRAL and the
    // nature dimension does the work.
    return { verdict: "NEUTRAL", reason: "not a capital account; capital-role dimension not applicable" };
  }
  if (capitalRole === "CONSTRUCTION_IN_PROGRESS") {
    // Gate to special-condition check
    return { verdict: "CONDITIONALLY_COMPATIBLE", reason: "CIP requires project evidence — see specialCondition" };
  }
  if (objectType == null || objectType === "UNKNOWN") {
    return { verdict: "COMPATIBLE", reason: "object type unknown; role compatibility neutral-positive" };
  }
  // Object-type × capital-role mapping — §Amendment 1: no blanket
  // PREFERRED for equipment-anything.
  switch (objectType) {
    case "COMPLETE_MACHINE":
      if (capitalRole === "EQUIPMENT_ASSET") return { verdict: "PREFERRED", reason: "complete machine ↔ equipment asset" };
      if (capitalRole === "VEHICLE_ASSET") return { verdict: "COMPATIBLE", reason: "complete machine could be a vehicle" };
      if (capitalRole === "FURNITURE_FIXTURES_ASSET") return { verdict: "COMPATIBLE", reason: "complete machine could be a fixture" };
      if (capitalRole === "OTHER_CAPITAL_ASSET") return { verdict: "COMPATIBLE", reason: "complete machine could be a generic capital asset" };
      if (capitalRole === "CAPITAL_IMPROVEMENT") return { verdict: "COMPATIBLE", reason: "complete machine may sometimes capitalize as improvement" };
      if (capitalRole === "LAND_ASSET") return { verdict: "CONTRADICTED", reason: "complete machine is not land" };
      if (capitalRole === "BUILDING_ASSET") return { verdict: "CONTRADICTED", reason: "complete machine is not a building" };
      if (capitalRole === "LEASEHOLD_IMPROVEMENT") return { verdict: "CONTRADICTED", reason: "complete machine is not a leasehold improvement" };
      if (capitalRole === "SOFTWARE_INTANGIBLE") return { verdict: "CONTRADICTED", reason: "complete machine is not software / intangible" };
      break;
    case "REPLACEMENT_ENGINE":
    case "SERIALIZED_COMPONENT":
      if (capitalRole === "EQUIPMENT_ASSET") return { verdict: "CONDITIONALLY_COMPATIBLE", reason: "serialized component may capitalize as part of existing asset — needs context" };
      if (capitalRole === "OTHER_CAPITAL_ASSET") return { verdict: "COMPATIBLE", reason: "component may be capitalized generically" };
      break;
    case "REPLACEMENT_COMPONENT":
      // Components should typically be R&M, not capital.
      return { verdict: "CONTRADICTED", reason: "replacement component is typically R&M, not capital" };
    case "ACCESSORY":
      if (capitalRole === "EQUIPMENT_ASSET") return { verdict: "COMPATIBLE", reason: "accessory bundled with equipment may capitalize with parent unit" };
      return { verdict: "NEUTRAL", reason: "accessory nature ambiguous for capital" };
    case "CONSUMABLE":
    case "SERVICE":
      return { verdict: "INCOMPATIBLE", reason: `${objectType} is not a capital asset` };
  }
  return { verdict: "NEUTRAL", reason: `no specific rule for ${objectType} × ${capitalRole}` };
}

function deriveFunctionalRoleCompatibility(
  objectType: ProductObjectType | null,
  functionalRole: AccountFunctionalRole,
  transactionSignals: string[],
  transactionDepartment: string | null,
): DimensionVerdict {
  if (functionalRole === "UNKNOWN") {
    return { verdict: "NEUTRAL", reason: "account functional role unresolved" };
  }
  if (functionalRole === "GENERAL_EQUIPMENT") {
    // Function-neutral equipment is COMPATIBLE regardless of dept.
    return { verdict: "COMPATIBLE", reason: "general equipment account — function-neutral" };
  }
  if (functionalRole === "FINANCED_EQUIPMENT") {
    // Requires financing evidence — surfaced separately in
    // specialConditionCompatibility. At this dimension, mark
    // CONDITIONALLY_COMPATIBLE so it doesn't beat a general or
    // department-specific alternative without evidence.
    return { verdict: "CONDITIONALLY_COMPATIBLE", reason: "financing-specific role — see specialCondition" };
  }
  if (functionalRole === "CAPITAL_PROJECT" || functionalRole === "IRRIGATION_PROJECT" || functionalRole === "TEEBOX_PROJECT") {
    // CIP functional roles gate to specialCondition.
    return { verdict: "CONDITIONALLY_COMPATIBLE", reason: "project functional role — see specialCondition" };
  }
  // Function-specific equipment / building / land / vehicle roles.
  // §Amendment 2: distinguish organizational department from function.
  // A grounds transaction paired with a KITCHEN_EQUIPMENT account is
  // functionally CONTRADICTED even if both organizationally roll up
  // to different departments.
  const signalsLower = transactionSignals.map((s) => s.toLowerCase()).join(" ");
  const deptLower = (transactionDepartment ?? "").toLowerCase();

  const functionalMatches: Record<AccountFunctionalRole, {
    signalRe?: RegExp;
    matchingDept?: string;
  }> = {
    GROUNDS_EQUIPMENT: { signalRe: /\b(?:grounds?|turf|course|fairway|greens?|rough|tee\s*box(?:es)?|mower|tractor|utility\s+vehicle|aerator|topdresser|sprayer|blower|verticutter)\b/i, matchingDept: "grounds" },
    IRRIGATION: { signalRe: /\birrigat/i, matchingDept: "grounds" },
    CLUBHOUSE_EQUIPMENT: { signalRe: /\bclubhouse\b/i, matchingDept: "clubhouse" },
    COMPUTER_EQUIPMENT: { signalRe: /\b(?:computer|server|desktop|laptop|network|router|switch|firewall|printer|photocopier|software|saas|licen[cs]e|it\b)/i, matchingDept: "it" },
    KITCHEN_EQUIPMENT: { signalRe: /\b(?:kitchen|culinary|pastry|dishwasher|oven|range|refrigerator|freezer|combi\s*oven|walk[-\s]?in)\b/i, matchingDept: "kitchen" },
    FOOD_BEVERAGE_EQUIPMENT: { signalRe: /\b(?:food|beverage|bar|lounge|dining|restaurant|banquet|catering)\b/i, matchingDept: "food_beverage" },
    PROSHOP_EQUIPMENT: { signalRe: /\b(?:pro\s*shop|golf\s*shop|proshop|backshop|merchandise|apparel)\b/i, matchingDept: "golf_shop" },
    BUILDING: { signalRe: /\b(?:building|structure|premises)\b/i },
    LAND: { signalRe: /\bland\b(?!scap)/i },
    VEHICLE: { signalRe: /\b(?:vehicle|automobile|truck|van|golf\s+cart|cart\s+fleet)\b/i },
    GENERAL_EQUIPMENT: {},   // handled above
    FINANCED_EQUIPMENT: {},  // handled above
    CAPITAL_PROJECT: {},     // handled above
    IRRIGATION_PROJECT: {},  // handled above
    TEEBOX_PROJECT: {},      // handled above
    UNKNOWN: {},             // handled above
  };
  const rule = functionalMatches[functionalRole];
  if (!rule || !rule.signalRe) return { verdict: "NEUTRAL", reason: `no rule for functional role ${functionalRole}` };

  const signalHit = rule.signalRe.test(signalsLower);
  const deptHit = rule.matchingDept != null && deptLower === rule.matchingDept;

  if (signalHit && deptHit) {
    return { verdict: "PREFERRED", reason: `functional role ${functionalRole} matches both transaction signals and department` };
  }
  if (signalHit || deptHit) {
    return { verdict: "COMPATIBLE", reason: `functional role ${functionalRole} matches ${signalHit ? "transaction signal" : ""}${signalHit && deptHit ? " and " : ""}${deptHit ? "department" : ""}` };
  }
  // §Amendment 1 explicit: function-specific account WITHOUT
  // matching transaction signal is CONTRADICTED. Kitchen equipment
  // account for a grounds mower transaction should NOT compete.
  return { verdict: "CONTRADICTED", reason: `functional role ${functionalRole} does not match transaction signals or department` };
}

function deriveDepartmentCompatibility(
  transactionDept: string | null,
  accountDept: string | null,
): DimensionVerdict {
  if (transactionDept == null && accountDept == null) {
    return { verdict: "NEUTRAL", reason: "neither transaction nor account carry a department" };
  }
  if (transactionDept == null) {
    return { verdict: "NEUTRAL", reason: "transaction department unknown" };
  }
  if (accountDept == null) {
    return { verdict: "NEUTRAL", reason: "account department unknown" };
  }
  if (transactionDept === accountDept) {
    return { verdict: "PREFERRED", reason: `department ${accountDept} matches transaction ${transactionDept}` };
  }
  return { verdict: "CONTRADICTED", reason: `account department ${accountDept} contradicts transaction ${transactionDept}` };
}

function deriveSpecialConditionCompatibility(
  capitalRole: CapitalAccountRole,
  functionalRole: AccountFunctionalRole,
  cipEvidence: CipEvidenceResult,
  financingEvidence: FinancingEvidenceResult,
): DimensionVerdict {
  // CIP condition
  if (capitalRole === "CONSTRUCTION_IN_PROGRESS"
      || functionalRole === "CAPITAL_PROJECT"
      || functionalRole === "IRRIGATION_PROJECT"
      || functionalRole === "TEEBOX_PROJECT") {
    if (!cipEvidence.found) {
      return { verdict: "CONTRADICTED", reason: `CIP account requires project/incomplete-asset evidence; none found (contradictions: ${cipEvidence.contradictions.join(", ") || "none"})` };
    }
    return { verdict: "COMPATIBLE", reason: `CIP account with ${cipEvidence.strength} project evidence` };
  }
  // Financing condition
  if (functionalRole === "FINANCED_EQUIPMENT") {
    if (!financingEvidence.found) {
      return { verdict: "CONTRADICTED", reason: "financing account requires affirmative financing evidence; none found" };
    }
    return { verdict: "COMPATIBLE", reason: `financing account with ${financingEvidence.strength} financing evidence` };
  }
  // No special condition applies.
  return { verdict: "NEUTRAL", reason: "no special condition applies" };
}

// -----------------------------------------------------------------------------
// Verdict combination
// -----------------------------------------------------------------------------

function combineVerdicts(verdicts: CompatibilityVerdict[]): CompatibilityVerdict {
  // Hard contradiction dominates.
  if (verdicts.some((v) => v === "INCOMPATIBLE")) return "INCOMPATIBLE";
  if (verdicts.some((v) => v === "CONTRADICTED")) return "CONTRADICTED";
  // CONDITIONALLY_COMPATIBLE gates — surviving all conditions
  // means at least COMPATIBLE.
  if (verdicts.some((v) => v === "CONDITIONALLY_COMPATIBLE")) {
    // If SOME dimension is CONDITIONALLY_COMPATIBLE and no other
    // dimension elevated it to CONTRADICTED, then it's CONDITIONAL.
    // Note: a special-condition COMPATIBLE (evidence found) covers
    // the conditional, so it upgrades to COMPATIBLE.
    if (verdicts.some((v) => v === "PREFERRED")) return "COMPATIBLE";
    return "CONDITIONALLY_COMPATIBLE";
  }
  if (verdicts.some((v) => v === "PREFERRED")) return "PREFERRED";
  if (verdicts.every((v) => v === "COMPATIBLE" || v === "NEUTRAL")) {
    return verdicts.some((v) => v === "COMPATIBLE") ? "COMPATIBLE" : "NEUTRAL";
  }
  return "NEUTRAL";
}
