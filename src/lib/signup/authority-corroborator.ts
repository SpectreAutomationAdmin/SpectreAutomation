// SIGNUP-2 Phase 2C (2026-10-25) -- Authority corroborator.
//
// Pure function.  Takes three verified inputs and produces one
// discriminated verdict.  No DB access, no logging, no side effects.
//
// Founder-amended routing rules (§2 of the Phase 2C authorisation):
//
//   "Do not treat job title, Microsoft authentication, or active
//    corporate standing as sufficient proof of signing authority.
//    A PASS_AUTOMATED outcome must require sufficient independently
//    verifiable evidence for both organization standing and signing
//    authority.  If such evidence is unavailable, use manual review."
//
// This is a stricter model than the earlier draft.  Four verification
// concepts are kept SEPARATE and PASS_AUTOMATED requires BOTH:
//
//   (1) Organisation identity + legal standing (standing == ACTIVE
//       from an authoritative registry adapter -- not a stub).
//   (2) Independently corroborated signing authority
//       (officerMatch == MATCHED is the ONLY Phase 2C evidence
//       class; see Phase 2H for future-authorised alternatives
//       like a written delegation letter review).
//
// Everything else routes to HOLD_FOR_REVIEW with a specific hold
// category operators triage from the Phase 2H inbox.
//
// Hard REJECT branches do not depend on signing-authority state:
//   - standing == NOT_ACTIVE / NOT_FOUND  → REJECT (entity cannot
//     authorise regardless of signatory).
//   - impersonation / abuse flag           → REJECT.

import type { EntityStanding, OfficerMatch } from "./entity-registry/types";

export type ClassifierDecision =
  | "AUTOMATED_PASSED"
  | "NEEDS_MANUAL_REVIEW"
  | "ESCALATED"
  | "OVERRIDDEN"
  | "NOT_STARTED";

export type Verdict = "PASS_AUTOMATED" | "HOLD_FOR_REVIEW" | "REJECT";

export type HoldCategory =
  | "ENTITY_VERIFICATION"
  | "SIGNING_AUTHORITY_VERIFICATION"
  | "CONFLICTING_EVIDENCE"
  | "INSUFFICIENT_EVIDENCE"
  | "SUSPECTED_IMPERSONATION";

export type SigningAuthoritySignal =
  | "OFFICER_MATCH"      // registry returned directors list AND signatory matched
  | "NONE"               // no independent corroboration (default)
  | "PRIOR_CLUB_RECORD"; // reserved for future phases

export interface CorroboratorInputs {
  classifier: ClassifierDecision;
  standing: EntityStanding;
  officerMatch: OfficerMatch;
  /** True when an adapter outcome came from a live, authoritative
   *  registry call.  False for stub + fixture + manual-review.  Phase
   *  2C baseline is always false (no live adapter ships) -- so every
   *  real registration routes to HOLD_FOR_REVIEW via entity branch. */
  standingFromLiveAdapter: boolean;
  /** Abuse signal detected on the Microsoft oid upstream.  Phase 2C
   *  reads this from a dedicated abuse store if present; otherwise
   *  false. */
  impersonationFlag: boolean;
}

export interface CorroboratorVerdict {
  verdict: Verdict;
  holdCategory: HoldCategory | null;
  signingAuthoritySignal: SigningAuthoritySignal;
  /** Short machine-readable rationale -- for logs + audit, never
   *  user-visible.  No PII. */
  rationale: string;
}

export function corroborateAuthority(inputs: CorroboratorInputs): CorroboratorVerdict {
  // Rule 0: impersonation short-circuits everything.
  if (inputs.impersonationFlag) {
    return {
      verdict: "REJECT",
      holdCategory: "SUSPECTED_IMPERSONATION",
      signingAuthoritySignal: "NONE",
      rationale: "abuse-flag-on-microsoft-oid",
    };
  }

  // Rule 1: dissolved / not-found entity cannot authorise.
  if (inputs.standing === "NOT_ACTIVE") {
    return {
      verdict: "REJECT",
      holdCategory: null,
      signingAuthoritySignal: "NONE",
      rationale: "entity-not-active",
    };
  }
  if (inputs.standing === "NOT_FOUND") {
    return {
      verdict: "REJECT",
      holdCategory: null,
      signingAuthoritySignal: "NONE",
      rationale: "entity-not-found",
    };
  }

  // Rule 2: ESCALATED classifier always routes to manual review.
  if (inputs.classifier === "ESCALATED") {
    return {
      verdict: "HOLD_FOR_REVIEW",
      holdCategory: "ENTITY_VERIFICATION",
      signingAuthoritySignal: "NONE",
      rationale: "classifier-escalated",
    };
  }

  // Rule 3: Compute the signing-authority signal independently of
  // the classifier + standing dimensions.  OFFICER_MATCH is the ONLY
  // Phase 2C evidence class for independent authority corroboration.
  const signingAuthoritySignal: SigningAuthoritySignal =
    inputs.officerMatch === "MATCHED" ? "OFFICER_MATCH" : "NONE";

  // Rule 4: Standing from a stub / fixture / manual-review source
  // is NOT authoritative evidence of standing per founder §1 + §3.
  // Even if the stub says ACTIVE (fixtures do), route to
  // ENTITY_VERIFICATION hold -- a human must corroborate from a
  // Certificate of Status.
  if (!inputs.standingFromLiveAdapter) {
    return {
      verdict: "HOLD_FOR_REVIEW",
      holdCategory: "ENTITY_VERIFICATION",
      signingAuthoritySignal,
      rationale: "standing-not-from-live-adapter",
    };
  }

  // Rule 5: standing == MANUAL_REVIEW_REQUIRED signals the adapter
  // explicitly asked for a human; mirror.
  if (inputs.standing === "MANUAL_REVIEW_REQUIRED") {
    return {
      verdict: "HOLD_FOR_REVIEW",
      holdCategory: "ENTITY_VERIFICATION",
      signingAuthoritySignal,
      rationale: "adapter-returned-manual-review-required",
    };
  }

  // From here, standing == ACTIVE AND evidence is from a live
  // adapter.  Phase 2C's unique architectural rule now kicks in:
  // PASS_AUTOMATED requires BOTH entity standing AND signing
  // authority to be independently corroborated.

  // Rule 6: conflicting-evidence branch.  Classifier failed but
  // standing passed with a live adapter.
  if (
    inputs.classifier === "NEEDS_MANUAL_REVIEW" &&
    inputs.standing === "ACTIVE"
  ) {
    return {
      verdict: "HOLD_FOR_REVIEW",
      holdCategory: "CONFLICTING_EVIDENCE",
      signingAuthoritySignal,
      rationale: "classifier-flagged-standing-active",
    };
  }

  // Rule 7: insufficient-authority-evidence branch.  Classifier +
  // standing both passed, but authority is not corroborated.  This
  // is the ROUTINE Phase 2C path -- most Controllers / GMs are not
  // on the directors list, so OFFICER_MATCH is rare.
  if (
    (inputs.classifier === "AUTOMATED_PASSED" || inputs.classifier === "OVERRIDDEN") &&
    inputs.standing === "ACTIVE" &&
    signingAuthoritySignal === "NONE"
  ) {
    return {
      verdict: "HOLD_FOR_REVIEW",
      holdCategory: "SIGNING_AUTHORITY_VERIFICATION",
      signingAuthoritySignal: "NONE",
      rationale: "signing-authority-not-independently-corroborated",
    };
  }

  // Rule 8: THE ONLY PASS_AUTOMATED PATH.  All four preconditions:
  //   (a) classifier AUTOMATED_PASSED or OVERRIDDEN,
  //   (b) standing ACTIVE,
  //   (c) adapter is a live authoritative source,
  //   (d) signing-authority signal is OFFICER_MATCH.
  if (
    (inputs.classifier === "AUTOMATED_PASSED" || inputs.classifier === "OVERRIDDEN") &&
    inputs.standing === "ACTIVE" &&
    signingAuthoritySignal === "OFFICER_MATCH"
  ) {
    return {
      verdict: "PASS_AUTOMATED",
      holdCategory: null,
      signingAuthoritySignal: "OFFICER_MATCH",
      rationale: "classifier-passed-standing-active-officer-matched",
    };
  }

  // Rule 9: catch-all.  Any input combination that reaches here is
  // either an unmodelled classifier state (NOT_STARTED, future
  // enum values) or an unexpected combination; fail safe to
  // INSUFFICIENT_EVIDENCE hold.
  return {
    verdict: "HOLD_FOR_REVIEW",
    holdCategory: "INSUFFICIENT_EVIDENCE",
    signingAuthoritySignal,
    rationale: `catch-all:classifier=${inputs.classifier},standing=${inputs.standing}`,
  };
}
