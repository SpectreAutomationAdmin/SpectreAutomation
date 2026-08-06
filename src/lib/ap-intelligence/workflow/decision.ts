// Sprint 3 · Post-16H Phase 3 (2026-08-06) — canonical AP workflow
// decision.
//
// One object, one truth. Replaces the two divergent legacy paths
// (deriveApCardConfidence + deriveApWorkflowState) with a single
// evidence-calibrated decision function that returns the state,
// per-dimension diagnostics, blockers, warnings, and a rationale.
//
// This module NEVER runs extraction / OCR / vendor matching. It
// composes decisions from the analyser's existing outputs +
// tenant policy. Founder §B9 scope.

import type { ApAnalyseResult } from "../analyse";

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

/** The founder-facing workflow state. Only one may be true at a time. */
export type ApWorkflowState =
  | "EXTRACTION_PENDING"
  | "NEEDS_JUDGMENT"
  | "READY_FOR_APPROVAL"
  | "UNSUPPORTED"
  | "AUTO_APPROVAL_ELIGIBLE";

/** A per-dimension diagnostic. Each dimension is a discrete
 *  question the workflow needs to answer. `blocks=true` means a
 *  FAIL / WARN verdict pushes the workflow away from READY. */
export interface ApWorkflowDimension {
  key: ApWorkflowDimensionKey;
  displayName: string;
  required: boolean;
  measuredValue: string | number | null;
  confidence: number | null;                       // 0..100 or null when N/A
  evidenceSource: string | null;
  validationStatus: "PASS" | "WARN" | "FAIL" | "PENDING" | "NOT_APPLICABLE";
  blocks: boolean;
  reason: string;
}

export type ApWorkflowDimensionKey =
  | "documentReadability"
  | "supplierIdentity"
  | "payableReference"
  | "grossTotal"
  | "taxReconciliation"
  | "lineItemCompleteness"
  | "accountingNature"
  | "glSemanticSupport"
  | "accountingEligibility"
  | "postingReadiness"
  | "allocationCompleteness"
  | "vendorResolution";

export interface ApWorkflowBlocker {
  code: ApWorkflowBlockerCode;
  message: string;
  dimensionKey: ApWorkflowDimensionKey;
}

export type ApWorkflowBlockerCode =
  | "SUPPLIER_UNRESOLVED"
  | "PAYABLE_REFERENCE_MISSING"
  | "GROSS_TOTAL_UNRESOLVED"
  | "TAX_UNRECONCILED"
  | "LINE_ITEMS_MISSING"
  | "ACCOUNTING_NATURE_UNSUPPORTED"
  | "GL_BELOW_THRESHOLD"
  | "GL_INELIGIBLE"
  | "POSTING_BLOCKER_UNRESOLVED"
  | "MULTI_ALLOCATION_NOT_PER_ALLOCATION"
  | "ALLOCATION_VARIANCE"
  | "VENDOR_UNRESOLVED"
  | "DUPLICATE_INVOICE_RISK"
  | "CAPITAL_TREATMENT_REVIEW_REQUIRED"
  | "CONTRADICTORY_EVIDENCE"
  | "DOCUMENT_UNREADABLE";

export interface ApWorkflowWarning {
  code: string;
  message: string;
}

export interface ApWorkflowDecision {
  state: ApWorkflowState;
  dimensions: ApWorkflowDimension[];
  blockers: ApWorkflowBlocker[];
  warnings: ApWorkflowWarning[];
  rationale: string[];
  /** Explicit exclusion codes when state is NOT AUTO_APPROVAL_ELIGIBLE.
   *  Empty when eligible. Founder §B3 auto-approval gate is
   *  intentionally strict; every "no" answer is recorded here. */
  autoApprovalExclusions: string[];
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export interface ApWorkflowDecisionInputs {
  analysis: ApAnalyseResult;
  /** True when attachment analysis (OCR / document extraction) has
   *  not yet reached a terminal state. When true, state is forced
   *  to EXTRACTION_PENDING regardless of downstream evidence.
   *  Callers who have already awaited terminal extraction pass
   *  false. */
  documentAnalysisPending: boolean;
  /** True when this document's hash matches an already-posted or
   *  in-flight AP invoice at this tenant. Forces
   *  NEEDS_JUDGMENT / DUPLICATE_INVOICE_RISK. */
  duplicateRisk: boolean;
  /** Tenant auto-approval policy. Coulee Ridge currently has none
   *  configured — pass an empty allowedTransactionClasses list to
   *  keep AUTO_APPROVAL_ELIGIBLE at zero. */
  tenantAutoApprovalPolicy?: {
    allowedTransactionClasses: string[];
  };
  /** True when the resolved / candidate vendor is not yet
   *  onboarded — used to exclude AUTO_APPROVAL_ELIGIBLE per §B3. */
  vendorIsNew?: boolean;
}

// ---------------------------------------------------------------------------
// Constants — thresholds
// ---------------------------------------------------------------------------

/** Below this, GL semantic support is insufficient to auto-approve
 *  OR appear as a supported category. Matches gl-recommend.ts
 *  MIN_RELEVANCE_THRESHOLD so the workflow and ranker agree. */
export const GL_MIN_RELEVANCE_THRESHOLD = 40;

/** Below this, per-dimension confidence is treated as blocking. */
export const DIMENSION_MIN_CONFIDENCE = 55;

/** Allocation variance tolerance in currency units. */
export const ALLOCATION_VARIANCE_TOLERANCE = 0.02;

// ---------------------------------------------------------------------------
// Decision engine
// ---------------------------------------------------------------------------

export function computeApWorkflowDecision(
  inputs: ApWorkflowDecisionInputs,
): ApWorkflowDecision {
  const { analysis } = inputs;
  const dimensions: ApWorkflowDimension[] = [];
  const blockers: ApWorkflowBlocker[] = [];
  const warnings: ApWorkflowWarning[] = [];
  const rationale: string[] = [];

  // -------- Dimension 1: documentReadability --------
  const extractionState = analysis.extraction.state;
  const documentReadable =
    !inputs.documentAnalysisPending &&
    (extractionState === "STRUCTURED" || extractionState === "PARTIAL");
  const documentUnreadable = extractionState === "DOCUMENT_UNREADABLE";
  dimensions.push({
    key: "documentReadability",
    displayName: "Document readability",
    required: true,
    measuredValue: extractionState,
    confidence: documentReadable ? (extractionState === "STRUCTURED" ? 95 : 60) : 0,
    evidenceSource: "invoice_document",
    validationStatus: inputs.documentAnalysisPending ? "PENDING"
      : documentUnreadable ? "FAIL"
      : documentReadable ? "PASS" : "WARN",
    blocks: !documentReadable && !inputs.documentAnalysisPending,
    reason: inputs.documentAnalysisPending
      ? "Attachment analysis is still in progress."
      : documentUnreadable
        ? "The document could not be parsed after every strategy."
        : "The document was parsed successfully.",
  });

  // Early exit — EXTRACTION_PENDING is a hard state.
  if (inputs.documentAnalysisPending) {
    rationale.push("Document analysis has not reached a terminal state — the workflow cannot advance.");
    return finalize({
      state: "EXTRACTION_PENDING",
      dimensions, blockers, warnings, rationale,
      autoApprovalExclusions: ["DOCUMENT_ANALYSIS_PENDING"],
    });
  }

  // Early exit — UNSUPPORTED when the document is unreadable AND
  // no other evidence exists to make a decision.
  if (documentUnreadable) {
    blockers.push({
      code: "DOCUMENT_UNREADABLE",
      message: "The document could not be parsed after every available strategy.",
      dimensionKey: "documentReadability",
    });
    rationale.push("Document unreadable after all strategies — Spectre cannot support any coding recommendation.");
    return finalize({
      state: "UNSUPPORTED",
      dimensions, blockers, warnings, rationale,
      autoApprovalExclusions: ["DOCUMENT_UNREADABLE"],
    });
  }

  // -------- Dimension 2: supplierIdentity --------
  const supplierName = analysis.extraction.vendor?.guessedName ?? null;
  const supplierConfidence = analysis.confidenceDimensions?.supplier?.confidence ?? null;
  const supplierResolved = !!supplierName && (supplierConfidence == null || supplierConfidence >= DIMENSION_MIN_CONFIDENCE);
  dimensions.push({
    key: "supplierIdentity",
    displayName: "Supplier identity",
    required: true,
    measuredValue: supplierName,
    confidence: supplierConfidence,
    evidenceSource: analysis.confidenceDimensions?.supplier?.source ?? null,
    validationStatus: supplierResolved ? "PASS" : (supplierName ? "WARN" : "FAIL"),
    blocks: !supplierResolved,
    reason: supplierName ? `Extracted supplier: "${supplierName}"` : "No supplier extracted.",
  });
  if (!supplierResolved) {
    blockers.push({
      code: "SUPPLIER_UNRESOLVED",
      message: "Supplier identity is not resolved to sufficient confidence.",
      dimensionKey: "supplierIdentity",
    });
  }

  // -------- Dimension 3: payableReference --------
  const invoiceNumber = analysis.extraction.invoiceNumber ?? null;
  const payableConf = analysis.confidenceDimensions?.invoiceNumber?.confidence ?? null;
  const payableOk = !!invoiceNumber && (payableConf == null || payableConf >= DIMENSION_MIN_CONFIDENCE);
  dimensions.push({
    key: "payableReference",
    displayName: "Payable reference",
    required: true,
    measuredValue: invoiceNumber,
    confidence: payableConf,
    evidenceSource: analysis.confidenceDimensions?.invoiceNumber?.source ?? null,
    validationStatus: payableOk ? "PASS" : (invoiceNumber ? "WARN" : "FAIL"),
    blocks: !payableOk,
    reason: invoiceNumber ? `Payable reference: "${invoiceNumber}"` : "No payable reference extracted.",
  });
  if (!payableOk) {
    blockers.push({
      code: "PAYABLE_REFERENCE_MISSING",
      message: "Payable reference is missing or unreliable.",
      dimensionKey: "payableReference",
    });
  }

  // -------- Dimension 4: grossTotal --------
  const grossTotal = analysis.extraction.total ?? null;
  const totalConf = analysis.confidenceDimensions?.totalReconciliation?.confidence ?? null;
  const grossOk = !!grossTotal && (totalConf == null || totalConf >= DIMENSION_MIN_CONFIDENCE);
  dimensions.push({
    key: "grossTotal",
    displayName: "Gross total",
    required: true,
    measuredValue: grossTotal,
    confidence: totalConf,
    evidenceSource: analysis.confidenceDimensions?.totalReconciliation?.source ?? null,
    validationStatus: grossOk ? "PASS" : (grossTotal ? "WARN" : "FAIL"),
    blocks: !grossOk,
    reason: grossTotal ? `Gross total ${grossTotal}` : "No gross total extracted.",
  });
  if (!grossOk) {
    blockers.push({
      code: "GROSS_TOTAL_UNRESOLVED",
      message: "Gross total is missing or does not reconcile.",
      dimensionKey: "grossTotal",
    });
  }

  // -------- Dimension 5: taxReconciliation --------
  const taxConf = analysis.confidenceDimensions?.taxReconciliation?.confidence ?? null;
  const taxOk = taxConf != null && taxConf >= DIMENSION_MIN_CONFIDENCE;
  dimensions.push({
    key: "taxReconciliation",
    displayName: "Tax reconciliation",
    required: false,
    measuredValue: analysis.extraction.taxTotal ?? null,
    confidence: taxConf,
    evidenceSource: analysis.confidenceDimensions?.taxReconciliation?.source ?? null,
    validationStatus: taxOk ? "PASS" : "WARN",
    blocks: !taxOk,
    reason: taxOk ? "Tax reconciles within tolerance." : "Tax does not reconcile to subtotal + tax = total.",
  });
  if (!taxOk) {
    blockers.push({
      code: "TAX_UNRECONCILED",
      message: "Tax total does not reconcile within tolerance.",
      dimensionKey: "taxReconciliation",
    });
  }

  // -------- Dimension 6: lineItemCompleteness --------
  const lineConf = analysis.confidenceDimensions?.lineItemCompleteness?.confidence ?? null;
  const linesOk = lineConf != null && lineConf >= DIMENSION_MIN_CONFIDENCE;
  const lineCount = analysis.lineItemsExtracted?.length ?? 0;
  dimensions.push({
    key: "lineItemCompleteness",
    displayName: "Line-item completeness",
    required: false,
    measuredValue: lineCount,
    confidence: lineConf,
    evidenceSource: analysis.confidenceDimensions?.lineItemCompleteness?.source ?? null,
    validationStatus: linesOk ? "PASS" : "WARN",
    blocks: false,     // advisory only in Phase 3 V1
    reason: linesOk ? `${lineCount} line item(s) recovered.` : "Line items may be incomplete.",
  });

  // -------- Dimension 7: accountingNature --------
  const nature = analysis.accountingIntelligence?.natureLeader ?? "UNKNOWN";
  const natureConf = analysis.accountingIntelligence?.natureConfidence ?? 0;
  const natureDefensible = analysis.accountingIntelligence?.natureIsDefensible === true;
  dimensions.push({
    key: "accountingNature",
    displayName: "Accounting nature",
    required: false,
    measuredValue: nature,
    confidence: natureConf,
    evidenceSource: "computed",
    validationStatus: natureDefensible ? "PASS" : (nature === "UNKNOWN" ? "WARN" : "WARN"),
    blocks: false,     // nature alone is not blocking; feeds nature-conditioned rules
    reason: natureDefensible ? `Nature: ${nature} (defensible).` : `Nature: ${nature} (not defensible — treated conservatively).`,
  });

  // -------- Dimension 8: glSemanticSupport --------
  const gl = analysis.gl;
  const glConf = gl.confidence ?? null;
  const glAboveThreshold = glConf != null && glConf >= GL_MIN_RELEVANCE_THRESHOLD;
  const glHasLeader = gl.accountNumber != null;
  dimensions.push({
    key: "glSemanticSupport",
    displayName: "GL semantic support",
    required: true,
    measuredValue: gl.accountNumber ?? null,
    confidence: glConf,
    evidenceSource: gl.source ?? null,
    validationStatus: !glHasLeader ? "FAIL"
      : glAboveThreshold ? "PASS" : "WARN",
    blocks: !glHasLeader || !glAboveThreshold,
    reason: glHasLeader
      ? `Leader: ${gl.accountNumber} confidence ${glConf}`
      : "No GL leader (ranker abstained).",
  });
  if (!glHasLeader) {
    blockers.push({
      code: "GL_BELOW_THRESHOLD",
      message: "No GL account cleared the semantic relevance threshold.",
      dimensionKey: "glSemanticSupport",
    });
  } else if (!glAboveThreshold) {
    blockers.push({
      code: "GL_BELOW_THRESHOLD",
      message: `GL confidence ${glConf} below relevance threshold ${GL_MIN_RELEVANCE_THRESHOLD}.`,
      dimensionKey: "glSemanticSupport",
    });
  }

  // -------- Dimension 9: accountingEligibility --------
  // gl.reason contains the Phase 2 abstention/rejection sentence
  // when applicable. When gl.source === "NONE" AND gl.reason
  // mentions eligibility, the leader was rejected by Phase 2.
  const glIneligible = !glHasLeader && (gl.reason ?? "").toLowerCase().includes("eligibility");
  dimensions.push({
    key: "accountingEligibility",
    displayName: "Accounting eligibility",
    required: true,
    measuredValue: glHasLeader ? "ELIGIBLE" : (glIneligible ? "INELIGIBLE" : "N/A"),
    confidence: null,
    evidenceSource: "computed",
    validationStatus: glHasLeader ? "PASS" : (glIneligible ? "FAIL" : "NOT_APPLICABLE"),
    blocks: glIneligible,
    reason: glIneligible
      ? "Phase 2 eligibility rejected the raw leader."
      : glHasLeader ? "Leader is accounting-eligible." : "No leader to evaluate.",
  });
  if (glIneligible) {
    blockers.push({
      code: "GL_INELIGIBLE",
      message: "Raw leader was accounting-invalid; no eligible alternative cleared threshold.",
      dimensionKey: "accountingEligibility",
    });
  }

  // -------- Dimension 10: postingReadiness --------
  const postingBlockersOnGl = gl.leaderPostingBlockers ?? [];
  const hasPostingBlocker = postingBlockersOnGl.length > 0;
  dimensions.push({
    key: "postingReadiness",
    displayName: "Posting readiness",
    required: false,
    measuredValue: postingBlockersOnGl.join(", ") || "READY",
    confidence: null,
    evidenceSource: "computed",
    validationStatus: !glHasLeader ? "NOT_APPLICABLE"
      : hasPostingBlocker ? "WARN" : "PASS",
    // Posting blockers do NOT block READY_FOR_APPROVAL (per §B4:
    // the leader stays visible + human sign-off addresses config).
    // They DO exclude AUTO_APPROVAL_ELIGIBLE.
    blocks: false,
    reason: hasPostingBlocker
      ? `Posting blockers: ${postingBlockersOnGl.join(", ")}`
      : "No posting blockers.",
  });
  if (hasPostingBlocker) {
    warnings.push({
      code: "POSTING_BLOCKER",
      message: `Semantically supported but not posting-ready: ${postingBlockersOnGl.join(", ")}.`,
    });
  }

  // -------- Dimension 11: allocationCompleteness --------
  const allocs = analysis.allocations;
  const allocMode = allocs.allocationEligibilityMode;
  const allocVariance = Math.abs(allocs.totals.allocationVariance);
  const allocReconciled = allocVariance <= ALLOCATION_VARIANCE_TOLERANCE;
  const perAllocation = allocMode === "PER_ALLOCATION";
  const multipleMaterial = allocs.allocations.filter((a) => Math.abs(a.amount) >= 0.01).length >= 2;
  dimensions.push({
    key: "allocationCompleteness",
    displayName: "Allocation completeness",
    required: false,
    measuredValue: `${allocs.allocations.length} allocations, mode=${allocMode}, variance=${allocVariance.toFixed(2)}`,
    confidence: null,
    evidenceSource: "computed",
    validationStatus: !allocReconciled ? "FAIL"
      : (multipleMaterial && !perAllocation) ? "WARN"
      : "PASS",
    blocks: !allocReconciled || (multipleMaterial && !perAllocation),
    reason: !allocReconciled
      ? `Allocations do not reconcile to gross (variance ${allocVariance.toFixed(2)}).`
      : (multipleMaterial && !perAllocation)
        ? `Multi-allocation invoice under ${allocMode} mode — per-allocation eligibility not evaluated.`
        : "Allocations reconcile.",
  });
  if (!allocReconciled) {
    blockers.push({
      code: "ALLOCATION_VARIANCE",
      message: `Allocation variance ${allocVariance.toFixed(2)} exceeds tolerance.`,
      dimensionKey: "allocationCompleteness",
    });
  }
  if (multipleMaterial && !perAllocation) {
    blockers.push({
      code: "MULTI_ALLOCATION_NOT_PER_ALLOCATION",
      message: `Multi-allocation invoice evaluated with ${allocMode} — per-allocation eligibility required.`,
      dimensionKey: "allocationCompleteness",
    });
  }

  // -------- Dimension 12: vendorResolution --------
  const vendorState = analysis.vendor.state;
  const vendorConfidence = analysis.confidenceDimensions?.vendorMatch?.confidence ?? null;
  const vendorResolved = vendorState === "MATCHED";
  dimensions.push({
    key: "vendorResolution",
    displayName: "Vendor resolution",
    required: true,
    measuredValue: vendorState,
    confidence: vendorConfidence,
    evidenceSource: analysis.confidenceDimensions?.vendorMatch?.source ?? null,
    validationStatus: vendorResolved ? "PASS" : "WARN",
    blocks: !vendorResolved,
    reason: vendorResolved ? "Vendor is matched." : `Vendor state: ${vendorState}.`,
  });
  if (!vendorResolved) {
    blockers.push({
      code: "VENDOR_UNRESOLVED",
      message: `Vendor state ${vendorState} requires review or onboarding.`,
      dimensionKey: "vendorResolution",
    });
  }

  // -------- Duplicate risk --------
  if (inputs.duplicateRisk) {
    blockers.push({
      code: "DUPLICATE_INVOICE_RISK",
      message: "Document matches an existing invoice hash — possible duplicate.",
      dimensionKey: "payableReference",
    });
  }

  // -------- Compose final state --------
  return finalize(computeFinalState({
    inputs, dimensions, blockers, warnings, rationale,
    glHasLeader, glAboveThreshold, hasPostingBlocker,
    perAllocation, multipleMaterial,
    natureLeader: nature,
  }));
}

// ---------------------------------------------------------------------------
// State selector — deterministic, ordered
// ---------------------------------------------------------------------------

interface StateComputeArgs {
  inputs: ApWorkflowDecisionInputs;
  dimensions: ApWorkflowDimension[];
  blockers: ApWorkflowBlocker[];
  warnings: ApWorkflowWarning[];
  rationale: string[];
  glHasLeader: boolean;
  glAboveThreshold: boolean;
  hasPostingBlocker: boolean;
  perAllocation: boolean;
  multipleMaterial: boolean;
  natureLeader: string;
}

function computeFinalState(a: StateComputeArgs): {
  state: ApWorkflowState;
  dimensions: ApWorkflowDimension[];
  blockers: ApWorkflowBlocker[];
  warnings: ApWorkflowWarning[];
  rationale: string[];
  autoApprovalExclusions: string[];
} {
  const { inputs, dimensions, blockers, warnings, rationale } = a;

  // NEEDS_JUDGMENT when any blocker exists.
  if (blockers.length > 0) {
    rationale.push(`${blockers.length} blocker(s) prevent readiness — human judgment required.`);
    return {
      state: "NEEDS_JUDGMENT",
      dimensions, blockers, warnings, rationale,
      autoApprovalExclusions: blockers.map((b) => b.code),
    };
  }

  // READY_FOR_APPROVAL: all required dimensions passed, no blockers.
  rationale.push("All required dimensions cleared. Human sign-off remaining.");
  const readyState: ApWorkflowState = "READY_FOR_APPROVAL";

  // AUTO_APPROVAL_ELIGIBLE requires additional conditions.
  const exclusions: string[] = [];
  const policy = inputs.tenantAutoApprovalPolicy;
  if (!policy || policy.allowedTransactionClasses.length === 0) {
    exclusions.push("TENANT_POLICY_NOT_CONFIGURED");
  }
  if (a.hasPostingBlocker) exclusions.push("POSTING_BLOCKER_UNRESOLVED");
  if (!a.perAllocation && a.multipleMaterial) exclusions.push("MULTI_ALLOCATION_NOT_PER_ALLOCATION");
  if (a.natureLeader === "CAPITAL_ASSET") exclusions.push("CAPITAL_TRANSACTION");
  if (a.natureLeader === "INTEREST_OR_PENALTY") exclusions.push("INTEREST_TRANSACTION");
  if (inputs.vendorIsNew) exclusions.push("NEW_VENDOR");
  if (inputs.duplicateRisk) exclusions.push("DUPLICATE_RISK");

  if (exclusions.length === 0 && policy) {
    // Nature must be in the explicitly-allowed set.
    const naturePasses = policy.allowedTransactionClasses.includes(a.natureLeader);
    if (!naturePasses) exclusions.push("NATURE_NOT_IN_POLICY_ALLOWLIST");
  }

  if (exclusions.length === 0) {
    return {
      state: "AUTO_APPROVAL_ELIGIBLE",
      dimensions, blockers, warnings,
      rationale: [...rationale, "All auto-approval gates cleared."],
      autoApprovalExclusions: [],
    };
  }

  return {
    state: readyState,
    dimensions, blockers, warnings, rationale,
    autoApprovalExclusions: exclusions,
  };
}

function finalize(d: {
  state: ApWorkflowState;
  dimensions: ApWorkflowDimension[];
  blockers: ApWorkflowBlocker[];
  warnings: ApWorkflowWarning[];
  rationale: string[];
  autoApprovalExclusions: string[];
}): ApWorkflowDecision {
  return d;
}
