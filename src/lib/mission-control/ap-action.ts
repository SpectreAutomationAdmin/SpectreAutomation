// Sprint 3 · Checkpoint 15P-5 (2026-07-28) — the ONE canonical
// function that derives an AP work-intake card's primary action
// AND the modal shape it opens.
//
// Founder rule (§Modal routing must use the same source of truth):
//   "The action button and the modal must never disagree. Those
//    decisions must come from the same function."
//
// Callers:
//   • EmailIntakeCard  — renders the primary-action label + icon,
//                        and on click uses the same result to open
//                        the correct modal shape.
//   • Test suite       — asserts specific ApAction shapes for the
//                        founder-observed scenarios.
//
// The result is a discriminated union so the caller can never mix
// up "which modal to open" with "what to show on the button".
//
// EVERYTHING derives from canonical business state on the projection:
//   - ap.workflowState        (READY_FOR_APPROVAL, VENDOR_MATCH_REQUIRED, …)
//   - ap.vendorMatch          (state, matchedVendorId, matchedName)
//   - ap.category             (recommended GL if present)
//
// No client-side state, no button-label persistence, no manual
// override. Delete or recreate a vendor → the projection changes →
// deriveApAction changes → button label + modal shape change together.

import type { ApInvoiceCardIntelligence } from "@/lib/mission-control";

// (icon list widened in Phase 3.1 to include pending / review — see below)
export type ApActionIcon =
  | "check" | "vendor-plus" | "envelope" | "duplicate" | "coa" | "document-check"
  | "pending" | "review";

export type ApAction =
  // Vendor already exists + exact/strong match + coding ready →
  // open the SHARED modal directly on AP Coding as SINGLE-STEP
  // (no two-step progress header; vendor pre-selected).
  | {
      kind: "APPROVE_AND_POST";
      label: "Approve & post";
      icon: "check";
      modal: {
        open: true;
        initialStep: "AP_CODING";
        vendorId: string;
        vendorName: string;
        autoResolved: true;
      };
    }
  // Vendor already exists + coding needs review → open the shared
  // modal directly on AP Coding, but with the two-step header
  // available so the user can go back to Vendor Profile.
  | {
      kind: "REVIEW_CODING";
      label: "Review coding";
      icon: "document-check";
      modal: {
        open: true;
        initialStep: "AP_CODING";
        vendorId: string;
        vendorName: string;
        autoResolved: false;
      };
    }
  // No vendor row yet → open the shared modal on Vendor Profile
  // (Step 1). Post advances to AP Coding.
  | {
      kind: "CREATE_VENDOR_AND_POST";
      label: "Create vendor & post";
      icon: "vendor-plus";
      modal: {
        open: true;
        initialStep: "PROFILE";
      };
    }
  // Duplicate / MISSING_INFO / COA_REQUIRED → do NOT open the
  // shared modal (those flows live on the Invoice Review tab of
  // the expanded card). The card's onClick just expands.
  | {
      kind: "REVIEW_DUPLICATE";
      label: "Review duplicate";
      icon: "duplicate";
      modal: { open: false; expand: true };
    }
  | {
      kind: "REQUEST_INFORMATION";
      label: "Request information";
      icon: "envelope";
      modal: { open: false; expand: true };
    }
  | {
      kind: "COA_REQUIRED";
      label: "Import chart of accounts";
      icon: "coa";
      modal: { open: false; expand: true };
    }
  // Sprint 3 · Post-16H Phase 3.1 (2026-08-06) — Phase 3 canonical
  // action targets. `EXPAND_ONLY` never posts; `REVIEW_DOCUMENT`
  // opens the document viewer so the reviewer can code manually.
  | {
      kind: "EXPAND_ONLY";
      label: string;
      icon: ApActionIcon;
      modal: { open: false; expand: true };
    }
  | {
      kind: "REVIEW_DOCUMENT";
      label: string;
      icon: ApActionIcon;
      modal: { open: false; expand: true };
    };

/**
 * Given the AP intelligence projection for a card, return the
 * ApAction the UI should display + wire.
 *
 * IMPORTANT: this function reads only `ap` — never any client
 * state, never any local cache. That's what makes the derivation
 * consistent between the button label + the modal shape.
 */
export function deriveApAction(ap: ApInvoiceCardIntelligence): ApAction {
  // Sanity: does the projection think a vendor is bound?
  const v = ap.vendorMatch;
  const vendorMatched = v?.state === "MATCHED" && !!v.matchedVendorId;

  switch (ap.workflowState) {
    case "READY_FOR_APPROVAL":
      // The projection says the vendor is matched + no reconcile
      // blockers. Guard: only fire APPROVE_AND_POST when the
      // matched vendor id is actually present. If somehow the
      // workflow-state says READY_FOR_APPROVAL but matchedVendorId
      // is null (a state we should never see, but we've been bitten
      // before), fall back to the two-step create flow instead of
      // trying to open Step 2 with a null vendor.
      if (vendorMatched) {
        return {
          kind: "APPROVE_AND_POST",
          label: "Approve & post",
          icon: "check",
          modal: {
            open: true,
            initialStep: "AP_CODING",
            vendorId: v!.matchedVendorId!,
            vendorName: v!.matchedName ?? "Selected vendor",
            autoResolved: true,
          },
        };
      }
      // Guard fallthrough — treat as VENDOR_MATCH_REQUIRED so the
      // modal can create the vendor from the extracted profile
      // rather than opening on a null vendor.
      return {
        kind: "CREATE_VENDOR_AND_POST",
        label: "Create vendor & post",
        icon: "vendor-plus",
        modal: { open: true, initialStep: "PROFILE" },
      };

    case "NEEDS_JUDGMENT":
      // Matched vendor but coding warrants operator review. Two-
      // step modal opened at Step 2 with the back button visible.
      // Same guard: fall back to Step 1 if matchedVendorId is null.
      if (vendorMatched) {
        return {
          kind: "REVIEW_CODING",
          label: "Review coding",
          icon: "document-check",
          modal: {
            open: true,
            initialStep: "AP_CODING",
            vendorId: v!.matchedVendorId!,
            vendorName: v!.matchedName ?? "Selected vendor",
            autoResolved: false,
          },
        };
      }
      return {
        kind: "CREATE_VENDOR_AND_POST",
        label: "Create vendor & post",
        icon: "vendor-plus",
        modal: { open: true, initialStep: "PROFILE" },
      };

    case "VENDOR_MATCH_REQUIRED":
      return {
        kind: "CREATE_VENDOR_AND_POST",
        label: "Create vendor & post",
        icon: "vendor-plus",
        modal: { open: true, initialStep: "PROFILE" },
      };

    case "MISSING_INFORMATION":
      return {
        kind: "REQUEST_INFORMATION",
        label: "Request information",
        icon: "envelope",
        modal: { open: false, expand: true },
      };

    case "POSSIBLE_DUPLICATE":
      return {
        kind: "REVIEW_DUPLICATE",
        label: "Review duplicate",
        icon: "duplicate",
        modal: { open: false, expand: true },
      };

    case "CHART_OF_ACCOUNTS_REQUIRED":
      return {
        kind: "COA_REQUIRED",
        label: "Import chart of accounts",
        icon: "coa",
        modal: { open: false, expand: true },
      };

    // Sprint 3 · Post-16H Phase 3.1 (2026-08-06) — new canonical
    // states mapped to primary actions per founder §3.
    case "ANALYSIS_PENDING":
      // No posting action; the card shows "Analysis in progress"
      // until the terminal ApAnalyseResult arrives via refresh.
      return {
        kind: "EXPAND_ONLY",
        label: "Analysis pending",
        icon: "pending",
        modal: { open: false, expand: true },
      } as ApAction;

    case "UNSUPPORTED":
      // Reviewer must open the document and provide coding manually.
      // NEVER "Request information" merely because internal
      // extraction failed (founder §3).
      return {
        kind: "REVIEW_DOCUMENT",
        label: "Review document",
        icon: "review",
        modal: { open: false, expand: true },
      } as ApAction;
  }
}
