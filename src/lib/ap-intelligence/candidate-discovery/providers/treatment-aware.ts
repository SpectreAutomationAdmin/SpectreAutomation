// Phase 4R · Phase 7.2K (2026-08-13) — Treatment-aware discovery provider.
//
// Founder §8: "You may implement the safe portion of Model C:
//   treatment/class-aware candidate retrieval from structured:
//     - account semantics
//     - fs-group taxonomy
//     - account role/type
//     - concept ontology
//   This is candidate discovery only.
//   Do NOT add TREATMENT_ALIGNMENT_TAXONOMY_MATCH or another treatment
//   score in this slice.
//   The metadata produced by retrieval should feed tier assignment in
//   Model B."
//
// This provider:
//   1. Reads the composed `CanonicalAccountingTreatment` from the
//      discovery context (added Phase 7.2K).
//   2. Resolves `CanonicalAccountSemantics` for every eligible account
//      via the SINGLE typed derivation (`resolveAccountSemantics`).
//   3. Emits candidates whose `statementRole` / `accountingClass` /
//      `inventoryPrepaidRole` structurally match the composed
//      treatment's `statementRole`.
//   4. Attaches metadata `treatmentAlignment: "PRIMARY" | "PLAUSIBLE" |
//      "CONTRADICTED"` on each discovery source (via the
//      `treatment_aware` DiscoverySource kind).
//
// STRICT NON-INVARIANTS:
//   - Does NOT emit or influence canonical scoring.
//   - Does NOT hard-remove candidates from the pool (Founder §2/§4).
//   - Does NOT introduce any new numeric weight.
//   - Does NOT force a single primary tier when treatment is
//     UNRESOLVED (Founder §6 — hierarchy must not manufacture certainty).
//
// The provider's output is CANDIDATE VISIBILITY + METADATA. Consumption
// for tier assignment (Model B, Phase 7.2L) is a future step.

import type { CandidateDiscoveryInput, DiscoveryHit, DiscoveryProvider } from "..";
import type {
  CanonicalAccountSemantics,
  AccountStatementRole,
  AccountingClass,
} from "../../account-semantics";
import { resolveAccountSemantics } from "../../account-semantics";
import type { CanonicalAccountingTreatment } from "../../treatment-composition";
import type { EligibleAccountView } from "../../accounting-nature-compatibility";

/** Treatment-alignment metadata attached to each treatment-aware
 *  discovery hit. Consumed by Phase 7.2L tier assignment. */
export type TreatmentAlignment =
  | "PRIMARY"           // account semantics directly match composed treatment
  | "PLAUSIBLE"         // treatment UNRESOLVED / account is a related-family match
  | "CONTRADICTED";     // defensibly-composed treatment structurally rejects this account role

/** Account/treatment alignment classifier — PURE function, testable
 *  in isolation. Returns `null` when the account's semantics don't
 *  produce a treatment-aware discovery hit (e.g. account is
 *  structurally non-postable). */
export function classifyTreatmentAlignment(
  semantics: CanonicalAccountSemantics,
  treatment: CanonicalAccountingTreatment,
): TreatmentAlignment | null {
  // Structural non-postable accounts are not treatment-alignment
  // candidates (they are already handled by hard eligibility).
  if (semantics.accountingClass === "NON_AP_POSTABLE") return null;
  if (semantics.structuralPostingRestrictions.length > 0) return null;

  // UNRESOLVED treatment — every legitimately postable account is
  // PLAUSIBLE. Founder §6: hierarchy must not manufacture certainty
  // when accounting treatment is unresolved.
  if (treatment.defensibility === "UNRESOLVED") {
    return "PLAUSIBLE";
  }

  // WEAK treatment — defensibility is not strong enough to CONTRADICT
  // an ordinary candidate. Emit PRIMARY when semantics match; else
  // PLAUSIBLE (never CONTRADICTED on weak treatment).
  const isDirectStatementMatch = matchesStatementRole(semantics.statementRole, treatment.statementRole);
  if (treatment.defensibility === "WEAK") {
    return isDirectStatementMatch ? "PRIMARY" : "PLAUSIBLE";
  }

  // STRONG treatment — full three-way classification.
  if (isDirectStatementMatch) return "PRIMARY";
  if (isRelatedStatementFamily(semantics.statementRole, treatment.statementRole)) return "PLAUSIBLE";
  return "CONTRADICTED";
}

/** Direct statement-role match. */
function matchesStatementRole(
  accountRole: AccountStatementRole,
  treatmentRole: CanonicalAccountingTreatment["statementRole"],
): boolean {
  if (treatmentRole === "UNKNOWN") return false;
  return accountRole === treatmentRole;
}

/** Related-family match — an account is PLAUSIBLE (not CONTRADICTED)
 *  when its statementRole is in the same broad family as the
 *  treatment's statementRole. Examples:
 *    - OPERATING_EXPENSE treatment + COST_OF_SALES account → PLAUSIBLE
 *      (both P&L expense-side)
 *    - BALANCE_SHEET_CURRENT_ASSET treatment + BALANCE_SHEET_CAPITAL_ASSET
 *      account → PLAUSIBLE (both balance-sheet asset-side; boundary is
 *      genuinely fuzzy for many transactions)
 *    - OPERATING_EXPENSE treatment + BALANCE_SHEET_CURRENT_ASSET account
 *      → NOT plausible (this is the food-service leak case — inventory
 *      ASSET wants to squat on operating COGS)
 */
function isRelatedStatementFamily(
  accountRole: AccountStatementRole,
  treatmentRole: CanonicalAccountingTreatment["statementRole"],
): boolean {
  if (treatmentRole === "UNKNOWN") return true; // fall back to visible
  // Expense family (both P&L).
  const expenseFamily = new Set<AccountStatementRole>(["OPERATING_EXPENSE", "COST_OF_SALES"]);
  if ((treatmentRole === "OPERATING_EXPENSE" || treatmentRole === "COST_OF_SALES")
    && expenseFamily.has(accountRole)) {
    return true;
  }
  // Balance-sheet asset family (capital vs current — genuinely fuzzy).
  const assetFamily = new Set<AccountStatementRole>([
    "BALANCE_SHEET_CAPITAL_ASSET",
    "BALANCE_SHEET_CURRENT_ASSET",
  ]);
  if ((treatmentRole === "BALANCE_SHEET_CAPITAL_ASSET"
       || treatmentRole === "BALANCE_SHEET_CURRENT_ASSET")
    && assetFamily.has(accountRole)) {
    return true;
  }
  return false;
}

/** Account-class → statement-role bridge for treatment retrieval.
 *  Discovery emits an account when its `accountingClass` is
 *  known-compatible with the treatment even when the coarse
 *  `statementRole` match already covered it (defensive redundancy for
 *  auditability, not for scoring). */
function coversAccountingClass(
  cls: AccountingClass,
  treatmentRole: CanonicalAccountingTreatment["statementRole"],
): boolean {
  if (treatmentRole === "BALANCE_SHEET_CAPITAL_ASSET") {
    return cls === "LAND" || cls === "BUILDING" || cls === "EQUIPMENT_ASSET"
      || cls === "VEHICLE_ASSET" || cls === "FURNITURE_FIXTURES_ASSET"
      || cls === "SOFTWARE_INTANGIBLE_ASSET" || cls === "LEASEHOLD_IMPROVEMENT_ASSET"
      || cls === "CIP_ASSET";
  }
  if (treatmentRole === "BALANCE_SHEET_CURRENT_ASSET") {
    return cls === "FOOD_INVENTORY" || cls === "BEVERAGE_INVENTORY"
      || cls === "MERCHANDISE_INVENTORY" || cls === "PARTS_INVENTORY"
      || cls === "PREPAID_INSURANCE" || cls === "PREPAID_OTHER";
  }
  if (treatmentRole === "OPERATING_EXPENSE") {
    return cls === "FUEL_EXPENSE" || cls === "IT_SERVICES"
      || cls === "PROFESSIONAL_SERVICES" || cls === "MEMBERSHIP_DUES"
      || cls === "REPAIRS_MAINTENANCE" || cls === "GROUNDS_MAINTENANCE"
      || cls === "UTILITIES_TELECOM" || cls === "INSURANCE_EXPENSE"
      || cls === "TAXES_LICENSES" || cls === "OFFICE_SUPPLIES"
      || cls === "OTHER_EXPENSE" || cls === "INTEREST_FINANCE_CHARGE";
  }
  if (treatmentRole === "COST_OF_SALES") {
    return cls === "FOOD_COST_OF_SALES" || cls === "BEVERAGE_COST_OF_SALES";
  }
  return false;
}

/** Convert an AccountView (from discovery input) to an
 *  EligibleAccountView shape suitable for `resolveAccountSemantics`.
 *  The AccountView already carries `type`, `accountRole`, and the
 *  boolean flags via the Phase 7.2 optional fields. */
function toEligibleAccountView(
  a: CandidateDiscoveryInput["eligibleAccounts"][number],
): EligibleAccountView {
  return {
    accountNumber: a.accountNumber,
    name: a.name,
    type: (a.type ?? "EXPENSE") as string,
    normalBalance: "DEBIT", // AccountView doesn't carry normalBalance; harmless default
    isActive: true,          // AccountView doesn't carry isActive; the pool is already filtered
    isHeader: false,          // ditto
    allowManualPosting: a.allowManualPosting ?? true,
    isControlAccount: a.isControlAccount ?? false,
    isBankAccount: a.isBankAccount ?? false,
    isCashAccount: a.isCashAccount ?? false,
    categoryKey: a.categoryKey ?? null,
    fsGroupKey: a.fsGroupKey ?? null,
    accountRole: a.accountRole ?? null,
  };
}

export const treatmentAwareDiscovery: DiscoveryProvider = {
  kind: "treatment_aware",
  *discover(input: CandidateDiscoveryInput): Iterable<DiscoveryHit> {
    const ctx = input.discoveryContext;
    // The composed treatment is threaded through the discovery
    // context. If it isn't present (test fixtures or legacy callers),
    // this provider is a no-op — safe.
    if (!ctx) return;
    const treatment = ctx.canonicalAccountingTreatment;
    if (!treatment) return;

    for (const acct of input.eligibleAccounts) {
      const eligibleView = toEligibleAccountView(acct);
      const semantics = resolveAccountSemantics(eligibleView);
      const alignment = classifyTreatmentAlignment(semantics, treatment);
      if (alignment === null) continue;

      // We emit for PRIMARY and PLAUSIBLE hits.
      //
      // For CONTRADICTED — we DO NOT emit. Founder §2 forbids removing
      // otherwise-postable accounts on inferred treatment; but if
      // canonical retrieval elsewhere already surfaces the account,
      // it remains visible. This provider only ADDS candidates; it
      // never subtracts.
      if (alignment === "CONTRADICTED") continue;

      // Also require accountingClass compatibility as a defensive
      // check — an account whose accountingClass doesn't match the
      // treatment's statementRole is retained as PLAUSIBLE only if
      // the family match still holds.
      const classCovers = coversAccountingClass(semantics.accountingClass, treatment.statementRole);
      const shouldEmit =
        alignment === "PRIMARY"
          ? true                                             // PRIMARY always emits
          : (treatment.defensibility === "UNRESOLVED" || classCovers); // PLAUSIBLE gate

      if (!shouldEmit) continue;

      yield {
        accountId: acct.id,
        accountNumber: acct.accountNumber,
        source: {
          kind: "treatment_aware",
          alignment,
          statementRole: treatment.statementRole,
          accountingClass: semantics.accountingClass,
          defensibility: treatment.defensibility,
        },
      };
    }
  },
};
