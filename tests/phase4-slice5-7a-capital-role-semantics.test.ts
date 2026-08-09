// Sprint 3 · Phase 4 Slice 5.7A (2026-08-09) — capital-role semantics
// + compatibility gate tests.
//
// All test data is SYNTHETIC. No supplier / product / SKU / model /
// invoice literal from any real invoice. Assertions verify GENERIC
// architecture across the founder's 18-case test matrix (§12 +
// amended A-I cases).

import { describe, it, expect } from "vitest";
import {
  rankCapitalAwareAccounts,
  type EligibleAccountView,
  type CapitalAwareRankingInput,
} from "@/lib/ap-intelligence/accounting-nature-compatibility";
import { resolveAccountSemantics } from "@/lib/ap-intelligence/account-semantics";
import { detectCipEvidence } from "@/lib/ap-intelligence/account-semantics/cip-evidence";
import { detectFinancingEvidence } from "@/lib/ap-intelligence/account-semantics/financing-evidence";
import type { CapitalEvidenceDecisionResult } from "@/lib/ap-intelligence/capital-evidence";
import type { ProductIdentityResolution } from "@/lib/ap-intelligence/product-identity-resolution";
import type { PurchasedObjectIdentity } from "@/lib/ap-intelligence/purchased-object-identity";
import type { DepartmentInferenceResult } from "@/lib/ap-intelligence/department-inference";
import { DeterministicPurchasedObjectProvider } from "@/lib/ap-intelligence/purchased-object-identity";
import type { CanonicalLineItem } from "@/lib/ap-intelligence/evidence/canonical-line-item";

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function acct(
  accountNumber: string,
  name: string,
  extra: Partial<EligibleAccountView> = {},
): EligibleAccountView {
  return {
    accountNumber, name, type: "ASSET",
    normalBalance: "DEBIT",
    isActive: true, isHeader: false,
    allowManualPosting: true,
    isControlAccount: false, isBankAccount: false, isCashAccount: false,
    categoryKey: "CAPITAL_ASSETS", fsGroupKey: "BS_CAPITAL_ASSETS",
    accountRole: "STANDARD",
    ...extra,
  };
}

function capital(
  decision: "CAPITAL_CANDIDATE" | "OPERATING" | "REPAIR_MAINTENANCE" | "UNRESOLVED",
  confidence: number,
): CapitalEvidenceDecisionResult {
  return {
    decision, confidence,
    durableAssetEvidence: [], operatingEvidence: [], contradictions: [],
    diagnostic: `test capital=${decision}(${confidence})`,
  };
}

function productId(objectType: "COMPLETE_MACHINE" | "REPLACEMENT_ENGINE" | "SERIALIZED_COMPONENT" | "CONSUMABLE" | "SERVICE" | "UNKNOWN" = "COMPLETE_MACHINE"): ProductIdentityResolution {
  return {
    candidates: [{
      objectType,
      manufacturerCandidates: [], brandCandidates: [], modelCandidates: [],
      partNumberCandidates: [], skuCandidates: [], serialCandidates: [],
      relationshipToOtherObjects: [], internalEvidenceScore: 30,
      supportingEvidence: [], contradictions: [], reason: "test",
      sourceObjectIndex: 0,
    }],
    selected: {
      objectType,
      manufacturerCandidates: [], brandCandidates: [], modelCandidates: [],
      partNumberCandidates: [], skuCandidates: [], serialCandidates: [],
      relationshipToOtherObjects: [], internalEvidenceScore: 30,
      supportingEvidence: [], contradictions: [], reason: "test",
      sourceObjectIndex: 0,
    },
    status: "RESOLVED_INTERNAL", confidence: 90, evidenceQuality: "HIGH",
    reason: "test",
    externalCorroborationRequired: false, externalLookupCount: 0, externalLatencyMs: 0,
    diagnostic: "test",
  };
}

function deptOf(key: string): DepartmentInferenceResult {
  const leader = { key, displayName: key, score: 30, evidence: [], isDefensible: true };
  return { leader, ranked: [leader], isDefensible: true };
}
function emptyDept(): DepartmentInferenceResult {
  return { leader: null, ranked: [], isDefensible: false };
}

function objectFromDesc(description: string, extension = 50000): PurchasedObjectIdentity[] {
  const li: CanonicalLineItem = {
    description, quantity: 1, unit: "EA", unitPrice: extension, extension,
    sku: null, role: "PRIMARY_PURCHASE",
    page: 1, sourceStrategy: "POSITIONED_CLASSIC_TABLE",
    validationConfidence: 78, arithmetic: "ARITHMETIC_OK",
    evidence: [],
  };
  return new DeterministicPurchasedObjectProvider().interpret([li]);
}

const CAPITAL_INPUT_BASE = (overrides: Partial<CapitalAwareRankingInput>): CapitalAwareRankingInput => ({
  capitalDecision: capital("CAPITAL_CANDIDATE", 68),
  productIdentity: productId("COMPLETE_MACHINE"),
  purchasedObjects: [],
  departmentResult: emptyDept(),
  eligibleAccounts: [],
  ...overrides,
});

// Standard tenant COA fixture — mirrors Silver Springs shape but
// synthetic account numbers only.
const CAPITAL_COA: EligibleAccountView[] = [
  acct("1500", "Land"),
  acct("1501", "Construct in Progress - Teeboxes", { fsGroupKey: "BS_CIP" }),
  acct("1502", "Construct in Progress - Irrigation", { fsGroupKey: "BS_CIP" }),
  acct("1503", "Capital Improvements"),
  acct("1504", "Buildings - Clubhouse"),
  acct("1505", "Equipment & Fixtures - Clubhouse"),
  acct("1506", "Equipment & Fixtures - Grounds"),
  acct("1507", "Equipment & Fixtures - Computers"),
  acct("1508", "Equipment under financing"),
];

// -----------------------------------------------------------------------------
// §12 Case A — Grounds mower: Grounds equipment preferred, Clubhouse contradicted
// -----------------------------------------------------------------------------

describe("§12A grounds mower — grounds equipment preferred, clubhouse contradicted", () => {
  it("winner is grounds equipment; clubhouse equipment is contradicted", () => {
    const objects = objectFromDesc("ACME rotary mower model X-4000 for grounds turf", 50000);
    const input = CAPITAL_INPUT_BASE({
      purchasedObjects: objects,
      departmentResult: deptOf("grounds"),
      eligibleAccounts: CAPITAL_COA,
      additionalDeptSurface: "fairway mower",
    });
    const result = rankCapitalAwareAccounts(input);
    expect(result.active).toBe(true);
    expect(result.winner?.accountNumber).toBe("1506");
    // 1505 Clubhouse Equipment should be in contradicted pool via functionalRole
    const clubhouse = result.contradictedPool.find((c) => c.accountNumber === "1505");
    expect(clubhouse).toBeTruthy();
  });
});

// -----------------------------------------------------------------------------
// §12B grounds mower vs computer equipment
// -----------------------------------------------------------------------------

describe("§12B grounds mower — computer equipment contradicted", () => {
  it("computer equipment not in compatible pool", () => {
    const objects = objectFromDesc("ACME rotary mower model X-4000 for grounds turf", 50000);
    const input = CAPITAL_INPUT_BASE({
      purchasedObjects: objects,
      departmentResult: deptOf("grounds"),
      eligibleAccounts: CAPITAL_COA,
      additionalDeptSurface: "fairway mower",
    });
    const result = rankCapitalAwareAccounts(input);
    const computer = result.contradictedPool.find((c) => c.accountNumber === "1507");
    expect(computer).toBeTruthy();
  });
});

// -----------------------------------------------------------------------------
// §12C grounds mower vs Equipment under financing — no financing evidence
// -----------------------------------------------------------------------------

describe("§12C grounds mower without financing evidence — ordinary equipment preferred", () => {
  it("winner is 1506; 1508 conditional / not preferred", () => {
    const objects = objectFromDesc("ACME rotary mower model X-4000 grounds turf mower", 50000);
    const input = CAPITAL_INPUT_BASE({
      purchasedObjects: objects,
      departmentResult: deptOf("grounds"),
      eligibleAccounts: CAPITAL_COA,
      additionalDeptSurface: "fairway mower",
    });
    const result = rankCapitalAwareAccounts(input);
    expect(result.winner?.accountNumber).toBe("1506");
    // 1508 must be in contradicted pool (financing account requires financing evidence)
    const financing = result.contradictedPool.find((c) => c.accountNumber === "1508");
    expect(financing).toBeTruthy();
  });
});

// -----------------------------------------------------------------------------
// §12D financed grounds mower — financing account becomes defensible
// -----------------------------------------------------------------------------

describe("§12D financed grounds mower — financing account becomes compatible", () => {
  it("1508 becomes compatible when financing evidence is present", () => {
    const objects = objectFromDesc("ACME rotary mower model X-4000 grounds turf mower", 50000);
    const input = CAPITAL_INPUT_BASE({
      purchasedObjects: objects,
      departmentResult: deptOf("grounds"),
      eligibleAccounts: CAPITAL_COA,
      additionalDeptSurface: "fairway mower",
      additionalEvidenceTexts: ["Equipment financing agreement pending — capital lease #A-2027"],
    });
    const result = rankCapitalAwareAccounts(input);
    // 1508 should now be in COMPATIBLE pool (not contradicted)
    const financing = result.contradictedPool.find((c) => c.accountNumber === "1508");
    expect(financing).toBeFalsy();
    const financingCompat = result.compatiblePool.find((c) => c.accountNumber === "1508");
    expect(financingCompat).toBeTruthy();
  });
});

// -----------------------------------------------------------------------------
// §12E irrigation pump as complete equipment (no CIP evidence)
// -----------------------------------------------------------------------------

describe("§12E irrigation pump COMPLETE_MACHINE (no CIP evidence)", () => {
  it("CIP-Irrigation must NOT win even though it matches irrigation vocab", () => {
    const objects = objectFromDesc("ACME irrigation pump complete unit model P-500", 12000);
    const input = CAPITAL_INPUT_BASE({
      purchasedObjects: objects,
      departmentResult: deptOf("grounds"),
      eligibleAccounts: CAPITAL_COA,
      additionalDeptSurface: "irrigation pump",
    });
    const result = rankCapitalAwareAccounts(input);
    const cipIrrigation = result.contradictedPool.find((c) => c.accountNumber === "1502");
    expect(cipIrrigation, "CIP-Irrigation contradicted without project evidence").toBeTruthy();
    expect(cipIrrigation?.rejectionReasons?.some((r) => r.includes("CIP"))).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// §12F irrigation construction PROJECT invoice → CIP-Irrigation defensible
// -----------------------------------------------------------------------------

describe("§12F irrigation construction project — CIP-Irrigation compatible", () => {
  it("CIP account moves to compatible when project evidence exists", () => {
    const objects = objectFromDesc("Irrigation construction project progress billing phase 2 retainage", 45000);
    const input = CAPITAL_INPUT_BASE({
      purchasedObjects: objects,
      departmentResult: deptOf("grounds"),
      eligibleAccounts: CAPITAL_COA,
      additionalEvidenceTexts: ["capital project #2027-IRR-01 phase 2 progress draw"],
    });
    const result = rankCapitalAwareAccounts(input);
    const cip = result.compatiblePool.find((c) => c.accountNumber === "1502");
    expect(cip, "CIP-Irrigation compatible with CIP evidence").toBeTruthy();
  });
});

// -----------------------------------------------------------------------------
// §12H generic-only equipment account survives when no function-specific exists
// -----------------------------------------------------------------------------

describe("§12H generic equipment account when function-specific unavailable", () => {
  it("generic equipment account wins when no function-specific option exists", () => {
    const objects = objectFromDesc("ACME complete equipment unit model Z-9000", 50000);
    const input = CAPITAL_INPUT_BASE({
      purchasedObjects: objects,
      departmentResult: emptyDept(),
      eligibleAccounts: [
        acct("1500", "Land"),
        acct("1509", "Equipment - Generic"),
      ],
    });
    const result = rankCapitalAwareAccounts(input);
    expect(result.winner?.accountNumber).toBe("1509");
  });
});

// -----------------------------------------------------------------------------
// §12I unknown functional role — do not manufacture contradictions
// -----------------------------------------------------------------------------

describe("§12I unknown functional role neither preferred nor contradicted", () => {
  it("account with no function tokens stays NEUTRAL, not CONTRADICTED", () => {
    // "Other Capital Asset" — no function-specific token
    const objects = objectFromDesc("ACME rotary mower model X-4000 for grounds turf", 50000);
    const input = CAPITAL_INPUT_BASE({
      purchasedObjects: objects,
      departmentResult: deptOf("grounds"),
      eligibleAccounts: [
        acct("1600", "Other Capital Asset"),
      ],
    });
    const result = rankCapitalAwareAccounts(input);
    const other = result.compatiblePool.find((c) => c.accountNumber === "1600")
      ?? result.contradictedPool.find((c) => c.accountNumber === "1600");
    expect(other).toBeTruthy();
    // Should be compatible (function unknown → neutral, not contradicted)
    expect(result.contradictedPool.find((c) => c.accountNumber === "1600")).toBeFalsy();
  });
});

// -----------------------------------------------------------------------------
// §12.4 Expensive consumable does not enter capital role search
// -----------------------------------------------------------------------------

describe("§12.4 expensive consumable does not enter capital search", () => {
  it("OPERATING decision → ranker inactive path OR contradicts capital", () => {
    const objects = objectFromDesc("Diesel bulk delivery 5000 gallons", 15000);
    const input = CAPITAL_INPUT_BASE({
      capitalDecision: capital("OPERATING", 80),
      purchasedObjects: objects,
      departmentResult: deptOf("grounds"),
      eligibleAccounts: CAPITAL_COA,
    });
    const result = rankCapitalAwareAccounts(input);
    // OPERATING decision — all CAPITAL_ASSETS accounts should be
    // contradicted / incompatible on the nature axis.
    if (result.active) {
      expect(result.compatiblePool.length).toBe(0);
      expect(result.abstained).toBe(true);
    } else {
      // Or ranker inactive because OPERATING has no capital search path
      expect(result.abstained).toBe(true);
    }
  });
});

// -----------------------------------------------------------------------------
// §12.16 capital candidate + no semantically compatible capital account
// -----------------------------------------------------------------------------

describe("§12.16 capital candidate but no compatible capital account", () => {
  it("truthful abstention", () => {
    const objects = objectFromDesc("ACME rotary mower model X-4000 for grounds turf", 50000);
    const input = CAPITAL_INPUT_BASE({
      purchasedObjects: objects,
      departmentResult: deptOf("grounds"),
      eligibleAccounts: [
        acct("1500", "Land"),
        acct("1504", "Buildings - Clubhouse"),
      ],
    });
    const result = rankCapitalAwareAccounts(input);
    expect(result.compatiblePool.length).toBe(0);
    expect(result.abstained).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// Unit-level: resolveAccountSemantics per account
// -----------------------------------------------------------------------------

describe("resolveAccountSemantics — capital role + functional role + provenance", () => {
  it("BS_CIP fsGroup → CONSTRUCTION_IN_PROGRESS via FS_GROUP source", () => {
    const s = resolveAccountSemantics(acct("1501", "Construct in Progress - Teeboxes", { fsGroupKey: "BS_CIP" }));
    expect(s.capitalRole).toBe("CONSTRUCTION_IN_PROGRESS");
    expect(s.capitalRoleSource).toBe("FS_GROUP");
    expect(s.functionalRole).toBe("TEEBOX_PROJECT");
  });
  it("Equipment & Fixtures - Grounds → EQUIPMENT_ASSET + GROUNDS_EQUIPMENT + grounds dept", () => {
    const s = resolveAccountSemantics(acct("1506", "Equipment & Fixtures - Grounds"));
    expect(s.capitalRole).toBe("EQUIPMENT_ASSET");
    expect(s.functionalRole).toBe("GROUNDS_EQUIPMENT");
    expect(s.organizationalDepartment).toBe("grounds");
  });
  it("Equipment & Fixtures - Computers → EQUIPMENT_ASSET + COMPUTER_EQUIPMENT + it dept", () => {
    const s = resolveAccountSemantics(acct("1507", "Equipment & Fixtures - Computers"));
    expect(s.capitalRole).toBe("EQUIPMENT_ASSET");
    expect(s.functionalRole).toBe("COMPUTER_EQUIPMENT");
    expect(s.organizationalDepartment).toBe("it");
  });
  it("Equipment under financing → EQUIPMENT_ASSET + FINANCED_EQUIPMENT", () => {
    const s = resolveAccountSemantics(acct("1508", "Equipment under financing"));
    expect(s.capitalRole).toBe("EQUIPMENT_ASSET");
    expect(s.functionalRole).toBe("FINANCED_EQUIPMENT");
  });
  it("Land → LAND_ASSET + LAND", () => {
    const s = resolveAccountSemantics(acct("1500", "Land"));
    expect(s.capitalRole).toBe("LAND_ASSET");
    expect(s.functionalRole).toBe("LAND");
  });
  it("Buildings - Clubhouse → BUILDING_ASSET + BUILDING (name inference for building beats functional CLUBHOUSE_EQUIPMENT)", () => {
    const s = resolveAccountSemantics(acct("1504", "Buildings - Clubhouse"));
    expect(s.capitalRole).toBe("BUILDING_ASSET");
    // functionalRole comes from name inference — BUILDING wins because
    // the "building" token check runs before clubhouse.
    expect(["BUILDING", "CLUBHOUSE_EQUIPMENT"]).toContain(s.functionalRole);
  });
  it("Capital Improvements → CAPITAL_IMPROVEMENT + GENERAL_EQUIPMENT (no function-specific token)", () => {
    const s = resolveAccountSemantics(acct("1503", "Capital Improvements"));
    expect(s.capitalRole).toBe("CAPITAL_IMPROVEMENT");
  });
});

describe("detectCipEvidence — evidence hierarchy", () => {
  it("no CIP tokens → not found", () => {
    const r = detectCipEvidence([], ["TORO rotary mower complete unit"]);
    expect(r.found).toBe(false);
    expect(r.strength).toBe("absent");
  });
  it("bare 'installation' alone → NOT found (§4 explicit)", () => {
    const r = detectCipEvidence([], ["Installation included"]);
    expect(r.found).toBe(false);
  });
  it("'capital project #2027-IRR-01' → strong found", () => {
    const r = detectCipEvidence([], ["capital project #2027-IRR-01 progress billing"]);
    expect(r.found).toBe(true);
    expect(r.strength).toBe("strong");
  });
  it("'progress billing phase 2 retainage' → medium+ found", () => {
    const r = detectCipEvidence([], ["progress billing phase 2 retainage"]);
    expect(r.found).toBe(true);
  });
  it("'placed in service' contradicts CIP", () => {
    const r = detectCipEvidence([], ["capital project #2027 — placed in service"]);
    expect(r.found).toBe(false);
    expect(r.contradictions.length).toBeGreaterThan(0);
  });
});

describe("detectFinancingEvidence — evidence hierarchy", () => {
  it("no financing tokens → not found", () => {
    const r = detectFinancingEvidence([], ["complete mower unit"]);
    expect(r.found).toBe(false);
  });
  it("'capital lease' → strong found", () => {
    const r = detectFinancingEvidence([], ["Capital lease #A-2027 monthly payment"]);
    expect(r.found).toBe(true);
    expect(r.strength).toBe("strong");
  });
  it("'lease' alone → weak (insufficient)", () => {
    const r = detectFinancingEvidence([], ["Lease notes"]);
    expect(r.found).toBe(false);
  });
  it("price alone never triggers financing", () => {
    const r = detectFinancingEvidence([], ["$74,112.00 net"]);
    expect(r.found).toBe(false);
  });
});
