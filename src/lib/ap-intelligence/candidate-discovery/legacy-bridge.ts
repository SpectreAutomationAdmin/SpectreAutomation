// Phase 4R · Phase 7.2B (2026-08-13) — Legacy discovery bridge.
//
// Type-bridge shims that adapt the current pipeline's data shapes to
// the input contracts of v206's discovery functions
// (rankPurposeDrivenAccounts, rankNatureScopedAccounts,
// rankCapitalAwareAccounts). These functions are reused UNMODIFIED
// from the current tree (they were preserved during Phase 4R per the
// founder's "do not delete old code" directive).
//
// The bridge:
//   - Widens AccountView with the extra fields v206 rankers need
//     (type, isActive, etc.) into `AccountWithLegacyFields`. These
//     fields DO NOT leak into `AccountView` used by canonical
//     ranking (canonical's `account.type` cast is preserved intact,
//     defaulting to "EXPENSE" so no dormant scoring branch fires).
//   - Adapts LineItem[] → CanonicalLineItem[] on a per-cluster basis
//     (cluster-scoped; no cross-cluster contamination per §5).
//   - Carries the analyse.ts-computed context (purposeDecision,
//     capitalDecision, productIdentity, purchasedObjects,
//     departmentInference) via `AllocationInput.discoveryContext`.
//
// Every discovery provider that consumes this bridge MUST extract
// ONLY `.candidates[].accountNumber` from the legacy result — never
// `.winner`, `.total`, `.components`, `.contradictions`, `.leader`,
// `.compatiblePool`, or any other winner/rank/confidence field.

import type { AccountView } from "../gl-account-concepts";
import type { LineItem } from "../line-items-extract";
import type { EconomicPurposeDecision } from "../economic-purpose-authority";
import type { AccountingNature, AccountingNatureAssessment } from "../accounting-nature";
import type { CanonicalLineItem, CanonicalLineItemRole } from "../evidence/canonical-line-item";
import type { CapitalEvidenceDecisionResult } from "../capital-evidence";
import type { ProductIdentityResolution } from "../product-identity-resolution";
import type { PurchasedObjectIdentity } from "../purchased-object-identity";
import type { DepartmentInferenceResult } from "../department-inference";
import type { AccountEligibilityView } from "@/lib/accounting/eligibility/types";
import type { CoaAccount } from "../nature-scoped-ranker";
import type { EligibleAccountView } from "../accounting-nature-compatibility";

// ---------------------------------------------------------------------------
// Rich account view (all fields the v206 rankers may need)
// ---------------------------------------------------------------------------

/** Superset of AccountView carrying every field the v206 discovery
 *  functions require. Kept SEPARATE from AccountView so its extra
 *  fields cannot leak into canonical ranking (canonical only sees
 *  AccountView; adding `type` to AccountView activated dormant
 *  scoring branches in Phase 7.2A — see phase-4r-phase72a-checkpoint
 *  §14). */
export interface AccountWithLegacyFields {
  id: string;
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
  archivedAt: Date | null;
  fundApplicability: string | null;
  categoryKey: string | null;
  categoryName: string | null;
  fsGroupKey: string | null;
  fsGroupName: string | null;
  accountRole: string | null;
}

// ---------------------------------------------------------------------------
// DiscoveryContext — carries analyse.ts-computed evidence into
// candidate-discovery. Attached to AllocationInput.discoveryContext.
// ---------------------------------------------------------------------------

export interface DiscoveryContext {
  /** Full v206-compatible account records for the tenant COA. Used
   *  by legacy-direct providers only; NEVER read by canonical. */
  richAccounts: AccountWithLegacyFields[];
  /** Canonical purpose decision (resolveEconomicPurpose output). */
  purposeDecision: EconomicPurposeDecision | null;
  /** Committed capital classifier decision, if available. */
  capitalDecision: CapitalEvidenceDecisionResult | null;
  /** Product identity resolution result, if available. */
  productIdentity: ProductIdentityResolution | null;
  /** Purchased object identities extracted from the invoice. */
  purchasedObjects: PurchasedObjectIdentity[];
  /** Department inference result. */
  departmentInference: DepartmentInferenceResult | null;
  /** Vendor prior-coding preferred accounts (SUPPORTING-only for
   *  legacy rankers; not a scoring source in canonical). */
  vendorHistoryPreferredAccountNumbers: readonly string[];
  /** Nature classification (used by nature-scoped-ranker). */
  natureClassification: AccountingNatureAssessment | null;
  /** Optional supplier name for legacy signal composition. */
  supplierName: string | null;
}

// ---------------------------------------------------------------------------
// Type-bridge helpers
// ---------------------------------------------------------------------------

/** Adapt AccountWithLegacyFields to AccountEligibilityView (input to
 *  rankPurposeDrivenAccounts). */
export function toAccountEligibilityView(a: AccountWithLegacyFields): AccountEligibilityView {
  return {
    id: a.id,
    accountNumber: a.accountNumber,
    name: a.name,
    type: a.type,
    normalBalance: a.normalBalance,
    isActive: a.isActive,
    isHeader: a.isHeader,
    allowManualPosting: a.allowManualPosting,
    isControlAccount: a.isControlAccount,
    isBankAccount: a.isBankAccount,
    isCashAccount: a.isCashAccount,
    archivedAt: a.archivedAt,
    fundApplicability: a.fundApplicability,
    categoryKey: a.categoryKey,
    fsGroupKey: a.fsGroupKey,
    accountRole: a.accountRole ?? "STANDARD",
  };
}

/** Adapt AccountWithLegacyFields to CoaAccount (input to
 *  rankNatureScopedAccounts). */
export function toCoaAccount(a: AccountWithLegacyFields): CoaAccount {
  return {
    id: a.id,
    accountNumber: a.accountNumber,
    name: a.name,
    type: a.type,
    isActive: a.isActive,
    isHeader: a.isHeader,
    isControlAccount: a.isControlAccount,
    allowManualPosting: a.allowManualPosting,
    categoryKey: a.categoryKey,
    categoryName: a.categoryName,
    fsGroupKey: a.fsGroupKey,
    fsGroupName: a.fsGroupName,
    fundApplicability: a.fundApplicability,
  };
}

/** Adapt AccountWithLegacyFields to EligibleAccountView (input to
 *  rankCapitalAwareAccounts). Note different-name interface than
 *  AccountEligibilityView; capital-aware has its own contract. */
export function toEligibleAccountView(a: AccountWithLegacyFields): EligibleAccountView {
  return {
    accountNumber: a.accountNumber,
    name: a.name,
    type: a.type,
    normalBalance: a.normalBalance,
    isActive: a.isActive,
    isHeader: a.isHeader,
    allowManualPosting: a.allowManualPosting,
    isControlAccount: a.isControlAccount,
    isBankAccount: a.isBankAccount,
    isCashAccount: a.isCashAccount,
    categoryKey: a.categoryKey,
    fsGroupKey: a.fsGroupKey,
    accountRole: a.accountRole,
  };
}

/** Adapt cluster's LineItem[] to CanonicalLineItem[] with sensible
 *  defaults so v206's rankers can Jaccard-score cluster text.
 *  Cluster-scoped by construction — NEVER pass all-document lines. */
export function clusterLinesToCanonical(lines: readonly LineItem[]): CanonicalLineItem[] {
  return lines.map((l, i): CanonicalLineItem => {
    // Role defaults to PRIMARY_PURCHASE so the rankers include the
    // line in their Jaccard token set. If the line has clear tax or
    // freight semantics we could refine, but for discovery-only use
    // the default is safe.
    const role: CanonicalLineItemRole = "PRIMARY_PURCHASE";
    return {
      description: l.description,
      quantity: l.quantity ?? null,
      unit: null,
      unitPrice: l.unitPrice ?? null,
      extension: l.amount,
      taxTreatment: {
        taxable: l.taxTreatment === "taxable",
        rate: l.taxRate ?? undefined,
      },
      role,
      page: 1,
      sourceStrategy: "FLATTENED_TEXT_FALLBACK",
      validationConfidence: l.confidence ?? 70,
      arithmetic: "UNVALIDATED",
      evidence: [],
      warnings: [],
    };
  });
}
