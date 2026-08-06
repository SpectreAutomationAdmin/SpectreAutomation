// Sprint 3 · Post-16H Phase 3 (2026-08-06) — canonical AP workflow
// decision unit tests. Covers §B8 scenarios at the decision-engine
// level. Full-pipeline validation runs via the benchmark harness.

import { describe, it, expect } from "vitest";
import {
  computeApWorkflowDecision,
  GL_MIN_RELEVANCE_THRESHOLD,
  type ApWorkflowDecisionInputs,
} from "@/lib/ap-intelligence/workflow/decision";
import type { ApAnalyseResult } from "@/lib/ap-intelligence/analyse";

function goodAnalysis(over: Partial<ApAnalyseResult> = {}): ApAnalyseResult {
  return {
    documentId: "doc1",
    ruleVersion: "test",
    extraction: {
      state: "STRUCTURED",
      vendor: { guessedName: "Northside Course Maintenance Inc." },
      invoiceNumber: "INV-2026-9010",
      invoiceDate: "2026-07-01",
      subtotal: "10700.00",
      taxTotal: "535.00",
      total: "11235.00",
      currency: "CAD",
      lineItems: [{ description: "irrigation pump", amount: "9500.00" }],
    } as any,
    extractionHints: [],
    vendor: { state: "MATCHED", candidates: [{ id: "v1" }] } as any,
    reconcile: { state: "MATCH" } as any,
    capital: { state: "OPERATING", capitalClass: null } as any,
    gl: {
      accountNumber: "6020",
      accountName: "Grounds Maintenance",
      confidence: 85,
      source: "VENDOR_DEFAULT",
      reason: "vendor default",
      candidates: [],
      requiresReview: false,
      autoApprovalEligible: false,
      leaderIsPostable: true,
      leaderPostingBlockers: [],
      ruleVersion: 3,
      categoryKey: null, fsGroupKey: null,
      rationale: {} as any,
      totalAccountsEvaluated: 20,
      splitRecommendations: [],
    } as any,
    findings: [],
    extractionTextLength: 500,
    vendorProfile: {} as any,
    supplier: {} as any,
    lineItemsExtracted: [{ description: "irrigation pump", amount: 9500 }] as any,
    taxReconciliation: {} as any,
    identifiers: [],
    economicPurpose: [],
    confidenceDimensions: {
      supplier: { confidence: 90, source: "invoice_document", reason: "" },
      invoiceNumber: { confidence: 88, source: "invoice_document", reason: "" },
      dates: { confidence: 90, source: "invoice_document", reason: "" },
      lineItemCompleteness: { confidence: 85, source: "invoice_document", reason: "" },
      taxReconciliation: { confidence: 92, source: "computed", reason: "" },
      totalReconciliation: { confidence: 92, source: "computed", reason: "" },
      vendorMatch: { confidence: 90, source: "vendor_history", reason: "" },
      glClassification: { confidence: 85, source: "computed", reason: "" },
    } as any,
    amountHierarchy: {} as any,
    taxGroupsResult: {} as any,
    splitGlRecommendations: [],
    allocations: {
      allocations: [{ amount: 11235.00, recommendedAccount: { accountNumber: "6020", requiresReview: false } } as any],
      totals: { allocationsSubtotal: 10700, taxTotal: 535, creditTotal: 0, grossTotal: 11235, allocationVariance: 0 } as any,
      cardCategory: "Grounds Maintenance",
      requiresReview: false,
      allocationEligibilityMode: "DOCUMENT_FALLBACK",
    },
    documentAssessment: null,
    accountingIntelligence: {
      natureLeader: "OPERATING_EXPENSE" as any,
      natureConfidence: 80,
      natureIsDefensible: true,
      natureRankedTop3: [],
      tableReconstruction: null,
    },
    ...over,
  } as unknown as ApAnalyseResult;
}

function base(over: Partial<ApWorkflowDecisionInputs> = {}): ApWorkflowDecisionInputs {
  return {
    analysis: goodAnalysis(),
    documentAnalysisPending: false,
    duplicateRisk: false,
    tenantAutoApprovalPolicy: undefined,
    vendorIsNew: false,
    ...over,
  };
}

describe("Phase 3 · workflow decision — hard states", () => {
  it("EXTRACTION_PENDING when documentAnalysisPending=true", () => {
    const d = computeApWorkflowDecision(base({ documentAnalysisPending: true }));
    expect(d.state).toBe("EXTRACTION_PENDING");
  });

  it("UNSUPPORTED when document is unreadable", () => {
    const d = computeApWorkflowDecision(base({
      analysis: goodAnalysis({
        extraction: { ...goodAnalysis().extraction, state: "DOCUMENT_UNREADABLE" } as any,
      }),
    }));
    expect(d.state).toBe("UNSUPPORTED");
    expect(d.blockers.some((b) => b.code === "DOCUMENT_UNREADABLE")).toBe(true);
  });

  it("NEEDS_JUDGMENT when supplier is unresolved", () => {
    const d = computeApWorkflowDecision(base({
      analysis: goodAnalysis({
        extraction: { ...goodAnalysis().extraction, vendor: { guessedName: null } } as any,
      }),
    }));
    expect(d.state).toBe("NEEDS_JUDGMENT");
    expect(d.blockers.some((b) => b.code === "SUPPLIER_UNRESOLVED")).toBe(true);
  });

  it("NEEDS_JUDGMENT when GL leader is absent (below threshold)", () => {
    const d = computeApWorkflowDecision(base({
      analysis: goodAnalysis({
        gl: { ...goodAnalysis().gl, accountNumber: null, accountName: null, confidence: null } as any,
      }),
    }));
    expect(d.state).toBe("NEEDS_JUDGMENT");
    expect(d.blockers.some((b) => b.code === "GL_BELOW_THRESHOLD")).toBe(true);
  });

  it("NEEDS_JUDGMENT when accounting-eligibility rejected the leader", () => {
    const d = computeApWorkflowDecision(base({
      analysis: goodAnalysis({
        gl: {
          ...goodAnalysis().gl,
          accountNumber: null, accountName: null, confidence: null,
          reason: "Phase 2 accounting eligibility rejected the promoted leader X.",
          source: "NONE",
        } as any,
      }),
    }));
    expect(d.state).toBe("NEEDS_JUDGMENT");
    expect(d.blockers.some((b) => b.code === "GL_INELIGIBLE")).toBe(true);
  });

  it("NEEDS_JUDGMENT when duplicate risk exists", () => {
    const d = computeApWorkflowDecision(base({ duplicateRisk: true }));
    expect(d.state).toBe("NEEDS_JUDGMENT");
    expect(d.blockers.some((b) => b.code === "DUPLICATE_INVOICE_RISK")).toBe(true);
  });

  it("NEEDS_JUDGMENT when multi-allocation is under DOCUMENT_FALLBACK", () => {
    const d = computeApWorkflowDecision(base({
      analysis: goodAnalysis({
        allocations: {
          ...goodAnalysis().allocations,
          allocations: [
            { amount: 5000, recommendedAccount: { accountNumber: "5100", requiresReview: false } },
            { amount: 6235, recommendedAccount: { accountNumber: "6020", requiresReview: false } },
          ] as any,
          allocationEligibilityMode: "DOCUMENT_FALLBACK",
        },
      }),
    }));
    expect(d.state).toBe("NEEDS_JUDGMENT");
    expect(d.blockers.some((b) => b.code === "MULTI_ALLOCATION_NOT_PER_ALLOCATION")).toBe(true);
  });
});

describe("Phase 3 · workflow decision — READY / AUTO gates", () => {
  it("healthy invoice reaches READY_FOR_APPROVAL when no policy is configured", () => {
    const d = computeApWorkflowDecision(base());
    expect(d.state).toBe("READY_FOR_APPROVAL");
    expect(d.autoApprovalExclusions).toContain("TENANT_POLICY_NOT_CONFIGURED");
  });

  it("healthy invoice reaches AUTO_APPROVAL_ELIGIBLE when tenant policy permits + no exclusions", () => {
    const d = computeApWorkflowDecision(base({
      tenantAutoApprovalPolicy: { allowedTransactionClasses: ["OPERATING_EXPENSE"] },
    }));
    expect(d.state).toBe("AUTO_APPROVAL_ELIGIBLE");
    expect(d.autoApprovalExclusions).toEqual([]);
  });

  it("READY_FOR_APPROVAL (not AUTO) when tenant policy permits BUT vendor is new", () => {
    const d = computeApWorkflowDecision(base({
      tenantAutoApprovalPolicy: { allowedTransactionClasses: ["OPERATING_EXPENSE"] },
      vendorIsNew: true,
    }));
    expect(d.state).toBe("READY_FOR_APPROVAL");
    expect(d.autoApprovalExclusions).toContain("NEW_VENDOR");
  });

  it("READY_FOR_APPROVAL (not AUTO) when nature is CAPITAL_ASSET", () => {
    const d = computeApWorkflowDecision(base({
      analysis: goodAnalysis({
        accountingIntelligence: {
          ...goodAnalysis().accountingIntelligence,
          natureLeader: "CAPITAL_ASSET" as any,
        },
      }),
      tenantAutoApprovalPolicy: { allowedTransactionClasses: ["CAPITAL_ASSET"] },
    }));
    expect(d.state).toBe("READY_FOR_APPROVAL");
    expect(d.autoApprovalExclusions).toContain("CAPITAL_TRANSACTION");
  });

  it("READY_FOR_APPROVAL (not AUTO) when posting blocker exists (e.g. fund unmapped)", () => {
    const d = computeApWorkflowDecision(base({
      analysis: goodAnalysis({
        gl: { ...goodAnalysis().gl, leaderPostingBlockers: ["FUND_APPLICABILITY_UNMAPPED"] } as any,
      }),
      tenantAutoApprovalPolicy: { allowedTransactionClasses: ["OPERATING_EXPENSE"] },
    }));
    expect(d.state).toBe("READY_FOR_APPROVAL");
    expect(d.autoApprovalExclusions).toContain("POSTING_BLOCKER_UNRESOLVED");
  });
});

describe("Phase 3 · dimensions surface", () => {
  it("returns all 12 dimensions with structured fields", () => {
    const d = computeApWorkflowDecision(base());
    expect(d.dimensions).toHaveLength(12);
    const keys = d.dimensions.map((x) => x.key).sort();
    expect(keys).toEqual([
      "accountingEligibility", "accountingNature", "allocationCompleteness",
      "documentReadability", "glSemanticSupport", "grossTotal",
      "lineItemCompleteness", "payableReference", "postingReadiness",
      "supplierIdentity", "taxReconciliation", "vendorResolution",
    ]);
    for (const dim of d.dimensions) {
      expect(dim.validationStatus).toMatch(/^(PASS|WARN|FAIL|PENDING|NOT_APPLICABLE)$/);
      expect(typeof dim.blocks).toBe("boolean");
      expect(dim.reason.length).toBeGreaterThan(0);
    }
  });

  it("GL_MIN_RELEVANCE_THRESHOLD aligns with the ranker's constant", async () => {
    // Same value on both sides — if the ranker's threshold ever
    // changes, this test must be updated in lock-step so the
    // workflow's "gl below threshold" decision stays consistent.
    expect(GL_MIN_RELEVANCE_THRESHOLD).toBe(40);
  });
});
