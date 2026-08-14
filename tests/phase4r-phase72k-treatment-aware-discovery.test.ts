// Phase 4R · Phase 7.2K (2026-08-13) — treatmentAwareDiscovery tests.
//
// Founder §8: candidate discovery only. NO score. NO hard filtering.
// Emits PRIMARY / PLAUSIBLE alignment metadata for future Model B
// tier assignment (Phase 7.2L).
//
// Structural invariants tested (Founder §17):
//   - Provider does NOT set accountNumber
//   - Provider does NOT emit CONTRADICTED hits (subtraction is
//     handled at tier assignment, not at retrieval)
//   - Provider is a no-op when composed treatment is absent
//   - Provider treats UNRESOLVED treatment as PLAUSIBLE for every
//     legitimately postable account (Founder §6)
//   - PRIMARY hits fire when statementRole matches exactly
//   - PLAUSIBLE hits fire on related-family matches (asset-family,
//     expense-family)

import { describe, expect, it } from "vitest";
import { classifyTreatmentAlignment, treatmentAwareDiscovery } from "@/lib/ap-intelligence/candidate-discovery/providers/treatment-aware";
import { resolveAccountSemantics } from "@/lib/ap-intelligence/account-semantics";
import type { CanonicalAccountingTreatment } from "@/lib/ap-intelligence/treatment-composition";
import type { EligibleAccountView } from "@/lib/ap-intelligence/accounting-nature-compatibility";
import type { CandidateDiscoveryInput } from "@/lib/ap-intelligence/candidate-discovery";

function mkAccount(o: Partial<EligibleAccountView>): EligibleAccountView {
  return {
    accountNumber: "0000",
    name: "Test",
    type: "EXPENSE",
    normalBalance: "DEBIT",
    isActive: true,
    isHeader: false,
    allowManualPosting: true,
    isControlAccount: false,
    isBankAccount: false,
    isCashAccount: false,
    categoryKey: null,
    fsGroupKey: null,
    accountRole: null,
    ...o,
  };
}

function mkTreatment(o: Partial<CanonicalAccountingTreatment>): CanonicalAccountingTreatment {
  return {
    expectedDebitRole: "OPERATING_EXPENSE",
    statementRole: "OPERATING_EXPENSE",
    defensibility: "STRONG",
    composedNatureLeader: "OPERATING_EXPENSE",
    composedNatureIsDefensible: true,
    provenance: {
      capitalVerdict: "OPERATING",
      natureLeader: "OPERATING_EXPENSE",
      natureIsDefensible: true,
      winningSource: "capital_classifier_strong",
    },
    contradictions: [],
    ...o,
  };
}

describe("Phase 7.2K · classifyTreatmentAlignment", () => {
  it("STRONG operating treatment + operating-expense account → PRIMARY", () => {
    const semantics = resolveAccountSemantics(mkAccount({
      type: "EXPENSE", name: "Grounds Maintenance", categoryKey: "REPAIRS_MAINTENANCE",
    }));
    const treatment = mkTreatment({});
    expect(classifyTreatmentAlignment(semantics, treatment)).toBe("PRIMARY");
  });

  it("STRONG operating treatment + inventory ASSET account → CONTRADICTED (food-service leak case)", () => {
    const semantics = resolveAccountSemantics(mkAccount({
      type: "ASSET", name: "Inventory — F&B", fsGroupKey: "BS_INVENTORY",
    }));
    const treatment = mkTreatment({
      statementRole: "OPERATING_EXPENSE",
      defensibility: "STRONG",
    });
    expect(classifyTreatmentAlignment(semantics, treatment)).toBe("CONTRADICTED");
  });

  it("STRONG operating treatment + COGS expense account → PLAUSIBLE (P&L expense family)", () => {
    const semantics = resolveAccountSemantics(mkAccount({
      type: "EXPENSE", name: "F&B Cost of Sales", categoryKey: "COST_OF_SALES",
    }));
    const treatment = mkTreatment({ statementRole: "OPERATING_EXPENSE" });
    expect(classifyTreatmentAlignment(semantics, treatment)).toBe("PLAUSIBLE");
  });

  it("STRONG capital treatment + Land ASSET → PRIMARY", () => {
    const semantics = resolveAccountSemantics(mkAccount({
      type: "ASSET", name: "Land", categoryKey: "CAPITAL_ASSETS", fsGroupKey: "BS_CAPITAL_ASSETS",
    }));
    const treatment = mkTreatment({
      statementRole: "BALANCE_SHEET_CAPITAL_ASSET",
      defensibility: "STRONG",
    });
    expect(classifyTreatmentAlignment(semantics, treatment)).toBe("PRIMARY");
  });

  it("STRONG capital treatment + Professional Services EXPENSE → CONTRADICTED (land-acquisition case)", () => {
    const semantics = resolveAccountSemantics(mkAccount({
      type: "EXPENSE", name: "Professional Services",
    }));
    const treatment = mkTreatment({
      statementRole: "BALANCE_SHEET_CAPITAL_ASSET",
      defensibility: "STRONG",
    });
    expect(classifyTreatmentAlignment(semantics, treatment)).toBe("CONTRADICTED");
  });

  it("STRONG capital treatment + current-asset (prepaid) → PLAUSIBLE (BS asset family)", () => {
    const semantics = resolveAccountSemantics(mkAccount({
      type: "ASSET", name: "Prepaid Insurance", fsGroupKey: "BS_PREPAID",
    }));
    const treatment = mkTreatment({
      statementRole: "BALANCE_SHEET_CAPITAL_ASSET",
      defensibility: "STRONG",
    });
    expect(classifyTreatmentAlignment(semantics, treatment)).toBe("PLAUSIBLE");
  });

  it("UNRESOLVED treatment → PLAUSIBLE for every postable account (Founder §6 — hierarchy must not manufacture certainty)", () => {
    const treatment = mkTreatment({
      statementRole: "UNKNOWN",
      defensibility: "UNRESOLVED",
    });
    for (const acct of [
      mkAccount({ type: "EXPENSE", name: "Grounds Maintenance" }),
      mkAccount({ type: "ASSET", name: "Equipment & Fixtures", categoryKey: "CAPITAL_ASSETS", fsGroupKey: "BS_CAPITAL_ASSETS" }),
      mkAccount({ type: "ASSET", name: "Inventory — F&B", fsGroupKey: "BS_INVENTORY" }),
    ]) {
      const semantics = resolveAccountSemantics(acct);
      expect(classifyTreatmentAlignment(semantics, treatment)).toBe("PLAUSIBLE");
    }
  });

  it("WEAK treatment + non-matching semantics → PLAUSIBLE (not CONTRADICTED — defensibility too weak)", () => {
    const semantics = resolveAccountSemantics(mkAccount({
      type: "ASSET", name: "Inventory — F&B", fsGroupKey: "BS_INVENTORY",
    }));
    const treatment = mkTreatment({
      statementRole: "OPERATING_EXPENSE",
      defensibility: "WEAK",
    });
    // Founder §5: capital=OPERATING (weak base state) must not impose
    // the same penalty as strong operating treatment.
    expect(classifyTreatmentAlignment(semantics, treatment)).toBe("PLAUSIBLE");
  });

  it("Non-postable account (REVENUE) → null (no discovery hit)", () => {
    const semantics = resolveAccountSemantics(mkAccount({
      type: "REVENUE", name: "Dues Revenue",
    }));
    const treatment = mkTreatment({});
    expect(classifyTreatmentAlignment(semantics, treatment)).toBeNull();
  });

  it("Structurally restricted account (bank) → null (no discovery hit)", () => {
    const semantics = resolveAccountSemantics(mkAccount({
      type: "ASSET", name: "Chequing", isBankAccount: true, accountRole: "BANK",
    }));
    const treatment = mkTreatment({});
    expect(classifyTreatmentAlignment(semantics, treatment)).toBeNull();
  });
});

describe("Phase 7.2K · treatmentAwareDiscovery.discover — invariants", () => {
  it("emits nothing when discoveryContext is absent", () => {
    const input: CandidateDiscoveryInput = {
      eligibleAccounts: [{
        id: "a1", accountNumber: "6020", name: "Grounds Maintenance",
        categoryKey: "REPAIRS_MAINTENANCE", categoryName: null,
        fsGroupKey: null, fsGroupName: null, type: "EXPENSE",
      }],
      clusterLineDescriptions: [],
      clusterConceptId: null,
      clusterFsGroupHints: [],
      globalSignals: {
        supplierName: null, natureLeader: null, natureIsDefensible: false,
        natureConfidence: 0, capitalDecision: null, capitalConfidence: 0,
        hasHighQualityDurableAssetContext: false, hasFinancingEvidence: false,
        departmentKey: null, priorCodingAccountNumbers: [],
        preferredAccountNumbers: [], contradictedAccountNumbers: [],
      },
    };
    const hits = Array.from(treatmentAwareDiscovery.discover(input));
    expect(hits).toEqual([]);
  });

  it("emits nothing when composed treatment is absent from discoveryContext", () => {
    const input: CandidateDiscoveryInput = {
      eligibleAccounts: [{
        id: "a1", accountNumber: "6020", name: "Grounds Maintenance",
        categoryKey: "REPAIRS_MAINTENANCE", categoryName: null,
        fsGroupKey: null, fsGroupName: null, type: "EXPENSE",
      }],
      clusterLineDescriptions: [],
      clusterConceptId: null,
      clusterFsGroupHints: [],
      globalSignals: {
        supplierName: null, natureLeader: null, natureIsDefensible: false,
        natureConfidence: 0, capitalDecision: null, capitalConfidence: 0,
        hasHighQualityDurableAssetContext: false, hasFinancingEvidence: false,
        departmentKey: null, priorCodingAccountNumbers: [],
        preferredAccountNumbers: [], contradictedAccountNumbers: [],
      },
      discoveryContext: {
        richAccounts: [],
        purposeDecision: null,
        capitalDecision: null,
        productIdentity: null,
        purchasedObjects: [],
        departmentInference: null,
        vendorHistoryPreferredAccountNumbers: [],
        natureClassification: null,
        supplierName: null,
        // no canonicalAccountingTreatment
      },
    };
    const hits = Array.from(treatmentAwareDiscovery.discover(input));
    expect(hits).toEqual([]);
  });

  it("does NOT emit CONTRADICTED hits (subtraction is Model B's job)", () => {
    const input: CandidateDiscoveryInput = {
      eligibleAccounts: [{
        // Inventory ASSET (would be CONTRADICTED on operating treatment).
        id: "a1", accountNumber: "1710", name: "Inventory — F&B",
        categoryKey: null, categoryName: null,
        fsGroupKey: "BS_INVENTORY", fsGroupName: null,
        type: "ASSET",
      }],
      clusterLineDescriptions: [],
      clusterConceptId: null,
      clusterFsGroupHints: [],
      globalSignals: {
        supplierName: null, natureLeader: null, natureIsDefensible: false,
        natureConfidence: 0, capitalDecision: null, capitalConfidence: 0,
        hasHighQualityDurableAssetContext: false, hasFinancingEvidence: false,
        departmentKey: null, priorCodingAccountNumbers: [],
        preferredAccountNumbers: [], contradictedAccountNumbers: [],
      },
      discoveryContext: {
        richAccounts: [],
        purposeDecision: null,
        capitalDecision: null,
        productIdentity: null,
        purchasedObjects: [],
        departmentInference: null,
        vendorHistoryPreferredAccountNumbers: [],
        natureClassification: null,
        supplierName: null,
        canonicalAccountingTreatment: mkTreatment({
          statementRole: "OPERATING_EXPENSE",
          defensibility: "STRONG",
        }),
      },
    };
    const hits = Array.from(treatmentAwareDiscovery.discover(input));
    // Inventory ASSET is CONTRADICTED — not emitted by discovery.
    expect(hits).toEqual([]);
  });

  it("does NOT set accountNumber via any side channel (Founder §17)", () => {
    const input: CandidateDiscoveryInput = {
      eligibleAccounts: [
        { id: "a1", accountNumber: "6020", name: "Grounds Maintenance",
          categoryKey: "REPAIRS_MAINTENANCE", categoryName: null,
          fsGroupKey: null, fsGroupName: null, type: "EXPENSE" },
        { id: "a2", accountNumber: "5320", name: "Fuel & Lubricants",
          categoryKey: null, categoryName: null,
          fsGroupKey: "IS_FUEL_LUBRICANTS", fsGroupName: null, type: "EXPENSE" },
      ],
      clusterLineDescriptions: [],
      clusterConceptId: null,
      clusterFsGroupHints: [],
      globalSignals: {
        supplierName: null, natureLeader: null, natureIsDefensible: false,
        natureConfidence: 0, capitalDecision: null, capitalConfidence: 0,
        hasHighQualityDurableAssetContext: false, hasFinancingEvidence: false,
        departmentKey: null, priorCodingAccountNumbers: [],
        preferredAccountNumbers: [], contradictedAccountNumbers: [],
      },
      discoveryContext: {
        richAccounts: [],
        purposeDecision: null,
        capitalDecision: null,
        productIdentity: null,
        purchasedObjects: [],
        departmentInference: null,
        vendorHistoryPreferredAccountNumbers: [],
        natureClassification: null,
        supplierName: null,
        canonicalAccountingTreatment: mkTreatment({
          statementRole: "OPERATING_EXPENSE",
          defensibility: "STRONG",
        }),
      },
    };
    const hits = Array.from(treatmentAwareDiscovery.discover(input));
    // Every hit carries an accountId+accountNumber (metadata) — but this
    // provider does not RETURN A WINNER. Emission is metadata only.
    for (const h of hits) {
      expect(h.source.kind).toBe("treatment_aware");
      expect(typeof h.accountId).toBe("string");
      expect(typeof h.accountNumber).toBe("string");
    }
    // Provider emits at least one PRIMARY (6020 matches operating-expense).
    expect(hits.some((h) => (h.source as { alignment?: string }).alignment === "PRIMARY")).toBe(true);
  });

  it("UNRESOLVED treatment emits PLAUSIBLE for every eligible account (Founder §6)", () => {
    const input: CandidateDiscoveryInput = {
      eligibleAccounts: [
        { id: "a1", accountNumber: "6020", name: "Grounds Maintenance",
          categoryKey: "REPAIRS_MAINTENANCE", categoryName: null,
          fsGroupKey: null, fsGroupName: null, type: "EXPENSE" },
        { id: "a2", accountNumber: "1506", name: "Equipment & Fixtures",
          categoryKey: "CAPITAL_ASSETS", categoryName: null,
          fsGroupKey: "BS_CAPITAL_ASSETS", fsGroupName: null, type: "ASSET" },
      ],
      clusterLineDescriptions: [],
      clusterConceptId: null,
      clusterFsGroupHints: [],
      globalSignals: {
        supplierName: null, natureLeader: null, natureIsDefensible: false,
        natureConfidence: 0, capitalDecision: null, capitalConfidence: 0,
        hasHighQualityDurableAssetContext: false, hasFinancingEvidence: false,
        departmentKey: null, priorCodingAccountNumbers: [],
        preferredAccountNumbers: [], contradictedAccountNumbers: [],
      },
      discoveryContext: {
        richAccounts: [],
        purposeDecision: null,
        capitalDecision: null,
        productIdentity: null,
        purchasedObjects: [],
        departmentInference: null,
        vendorHistoryPreferredAccountNumbers: [],
        natureClassification: null,
        supplierName: null,
        canonicalAccountingTreatment: mkTreatment({
          statementRole: "UNKNOWN",
          defensibility: "UNRESOLVED",
        }),
      },
    };
    const hits = Array.from(treatmentAwareDiscovery.discover(input));
    expect(hits.length).toBe(2);
    for (const h of hits) {
      expect((h.source as { alignment?: string }).alignment).toBe("PLAUSIBLE");
    }
  });
});
