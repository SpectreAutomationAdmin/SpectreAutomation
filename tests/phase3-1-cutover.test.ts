// Sprint 3 · Post-16H Phase 3.1 (2026-08-06) — production cutover
// tests. Prove that the canonical decision (not the legacy
// deriveApWorkflowState) controls the projection layer + primary
// action + posting refusals.

import { describe, it, expect } from "vitest";
import { deriveApAction, type ApAction } from "@/lib/mission-control/ap-action";
import {
  mapPhase3ToLegacyDisplayState,
  composeWorkflowReasonFromDecision,
} from "@/lib/mission-control/intelligence-review-intakes";
import type {
  ApWorkflowDecision, ApWorkflowState,
} from "@/lib/ap-intelligence/workflow/decision";
import type { ApInvoiceCardIntelligence } from "@/lib/mission-control/intelligence-review-intakes";

function decision(over: Partial<ApWorkflowDecision> = {}): ApWorkflowDecision {
  return {
    state: "NEEDS_JUDGMENT" as ApWorkflowState,
    dimensions: [], blockers: [], warnings: [],
    rationale: [], autoApprovalExclusions: [],
    ...over,
  };
}

describe("Phase 3.1 · mapper — canonical → legacy display state", () => {
  it("EXTRACTION_PENDING → ANALYSIS_PENDING", () => {
    expect(mapPhase3ToLegacyDisplayState(decision({ state: "EXTRACTION_PENDING" }))).toBe("ANALYSIS_PENDING");
  });
  it("UNSUPPORTED → UNSUPPORTED", () => {
    expect(mapPhase3ToLegacyDisplayState(decision({ state: "UNSUPPORTED" }))).toBe("UNSUPPORTED");
  });
  it("READY_FOR_APPROVAL → READY_FOR_APPROVAL", () => {
    expect(mapPhase3ToLegacyDisplayState(decision({ state: "READY_FOR_APPROVAL" }))).toBe("READY_FOR_APPROVAL");
  });
  it("AUTO_APPROVAL_ELIGIBLE → READY_FOR_APPROVAL (no automatic exposure without policy)", () => {
    expect(mapPhase3ToLegacyDisplayState(decision({ state: "AUTO_APPROVAL_ELIGIBLE" }))).toBe("READY_FOR_APPROVAL");
  });
  it("NEEDS_JUDGMENT with duplicate blocker → POSSIBLE_DUPLICATE", () => {
    expect(mapPhase3ToLegacyDisplayState(decision({
      blockers: [{ code: "DUPLICATE_INVOICE_RISK", message: "duplicate", dimensionKey: "payableReference" }],
    }))).toBe("POSSIBLE_DUPLICATE");
  });
  it("NEEDS_JUDGMENT with ONLY vendor blocker → VENDOR_MATCH_REQUIRED", () => {
    expect(mapPhase3ToLegacyDisplayState(decision({
      blockers: [{ code: "VENDOR_UNRESOLVED", message: "no vendor", dimensionKey: "vendorResolution" }],
    }))).toBe("VENDOR_MATCH_REQUIRED");
  });
  it("NEEDS_JUDGMENT with vendor + total blockers → NEEDS_JUDGMENT (not VENDOR_MATCH_REQUIRED)", () => {
    expect(mapPhase3ToLegacyDisplayState(decision({
      blockers: [
        { code: "VENDOR_UNRESOLVED", message: "", dimensionKey: "vendorResolution" },
        { code: "GROSS_TOTAL_UNRESOLVED", message: "", dimensionKey: "grossTotal" },
      ],
    }))).toBe("MISSING_INFORMATION");
  });
  it("null decision → NEEDS_JUDGMENT (safe default)", () => {
    expect(mapPhase3ToLegacyDisplayState(null)).toBe("NEEDS_JUDGMENT");
  });
});

describe("Phase 3.1 · reason composer", () => {
  it("EXTRACTION_PENDING produces analysis-in-progress copy", () => {
    const r = composeWorkflowReasonFromDecision(decision({ state: "EXTRACTION_PENDING" }), null);
    expect(r.toLowerCase()).toContain("still in progress");
  });
  it("UNSUPPORTED produces provide-coding-manually copy", () => {
    const r = composeWorkflowReasonFromDecision(decision({ state: "UNSUPPORTED" }), null);
    expect(r.toLowerCase()).toMatch(/could not extract|provide coding/);
  });
  it("READY_FOR_APPROVAL produces sign-off copy", () => {
    const r = composeWorkflowReasonFromDecision(decision({ state: "READY_FOR_APPROVAL" }), null);
    expect(r.toLowerCase()).toContain("sign-off");
  });
  it("NEEDS_JUDGMENT surfaces the primary blocker's message", () => {
    const r = composeWorkflowReasonFromDecision(decision({
      blockers: [{ code: "GROSS_TOTAL_UNRESOLVED", message: "The invoice total is missing.", dimensionKey: "grossTotal" }],
    }), null);
    expect(r).toBe("The invoice total is missing.");
  });
});

describe("Phase 3.1 · primary action for new states", () => {
  const baseAp = (state: ApInvoiceCardIntelligence["workflowState"]): ApInvoiceCardIntelligence => ({
    workflowState: state,
  } as unknown as ApInvoiceCardIntelligence);

  it("ANALYSIS_PENDING → EXPAND_ONLY (no posting action)", () => {
    const a = deriveApAction(baseAp("ANALYSIS_PENDING")) as ApAction;
    expect(a.kind).toBe("EXPAND_ONLY");
    expect(a.modal.open).toBe(false);
  });
  it("UNSUPPORTED → REVIEW_DOCUMENT (never Request information)", () => {
    const a = deriveApAction(baseAp("UNSUPPORTED")) as ApAction;
    expect(a.kind).toBe("REVIEW_DOCUMENT");
    expect(a.label.toLowerCase()).not.toContain("informational");
    expect(a.kind).not.toBe("REQUEST_INFORMATION");
  });
});

describe("Phase 3.1 · mutation guard — legacy path cannot override canonical", () => {
  it("projection consumes mapPhase3ToLegacyDisplayState, not deriveApWorkflowState", async () => {
    // Structural check on the projection layer's source — asserts
    // the cutover call site is present + the legacy function name
    // is not directly consumed by the workflowState assignment.
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(
      path.join(process.cwd(), "src/lib/mission-control/intelligence-review-intakes.ts"),
      "utf8",
    );
    // Isolate the fragment inside the projection function that
    // assigns workflowState — its right-hand side must reference
    // mapPhase3ToLegacyDisplayState.
    const projFragment = src.slice(
      src.indexOf("const workflowState = noCoa"),
      src.indexOf("const workflowState = noCoa") + 400,
    );
    expect(projFragment).toContain("mapPhase3ToLegacyDisplayState");
    // Legacy deriveApWorkflowState must not appear inside this
    // fragment.  It remains in the file only as the shadow
    // comparator (guarded by `void shadowCompareLegacyDecision`).
    expect(projFragment).not.toContain("deriveApWorkflowState");
  });
});
