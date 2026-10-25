// SIGNUP-2 Phase 2C (2026-10-25) -- EntityRegistryAdapter port.
//
// A provider-independent interface for Canadian corporate-registry
// lookups.  Per founder §3:
//   • Distinguish public lookup data from authoritative standing
//     evidence.
//   • Do not scrape restricted services or bypass access controls.
//   • Do not fabricate entity status, officer matches, or authority
//     verification.
//   • Return MANUAL_REVIEW_REQUIRED when reliable automated
//     verification is unavailable.
//
// Phase 2C baseline ships NO live adapter for any Canadian
// jurisdiction.  All jurisdictions use the manual-review stub.
// See docs/signup-2-phase-2c-registry-investigation.md for the
// 2026 registry-access reality -- AB has no legitimate programmatic
// path, ON requires a licensed service provider, BC requires
// account procurement + onboarding before any live calls.
// A future, separately-authorised slice can replace specific
// manual-review stubs with live adapters.

/** Standing classifications. */
export type EntityStanding =
  | "ACTIVE"
  | "NOT_ACTIVE"
  | "NOT_FOUND"
  | "MANUAL_REVIEW_REQUIRED";

/** Officer-match soft signal.  Null when the adapter did not return
 *  a directors / officers list (most adapters). */
export type OfficerMatch = "MATCHED" | "PARTIAL" | "NOT_MATCHED" | null;

/** The redacted summary the adapter persists.  Raw payload MUST be
 *  dropped by the adapter after classification -- never surfaced to
 *  the service layer and never written to the DB. */
export interface EntityStandingResult {
  jurisdiction: string; // "CA-AB" | "CA-ON" | "CA-BC" | ...
  businessNumber: string | null;
  standing: EntityStanding;
  officerMatch: OfficerMatch;
  /** Short machine-readable classifier of the outcome's source.
   *  Examples: "stub:manual-review", "fixture:ACTIVE+MATCHED",
   *  "live:bcregistry:cert-of-status".  Never contains PII. */
  evidenceSource: string;
  /** Non-authoritative free-text hint for operators -- never
   *  user-visible.  Never contains raw registry payload or PII. */
  operatorHint: string | null;
  fetchedAt: Date;
}

/** The adapter port.  Pure in-memory contract; implementations hide
 *  the HTTP / scrape / stub / fixture details.
 *
 *  Phase 2C invariants on EVERY adapter:
 *    1. Must NOT retain or persist the raw registry payload.
 *    2. Must NOT log PII (director names, personal addresses).
 *    3. Must NOT swallow unexpected errors as ACTIVE -- any
 *       exception path classifies the outcome as
 *       MANUAL_REVIEW_REQUIRED.
 *    4. Officer-match is a SOFT signal -- adapters MAY return it
 *       when the registry provides it, MUST return null otherwise.
 *    5. The signatory name is passed in only for officer-match
 *       comparison; adapters MUST NOT re-emit it.
 */
export interface EntityRegistryAdapter {
  readonly jurisdiction: string;
  readonly isLive: boolean; // true for live adapters, false for stub + fixture
  fetch(args: EntityRegistryFetchArgs): Promise<EntityStandingResult>;
}

export interface EntityRegistryFetchArgs {
  legalName: string;
  signatoryFullName: string | null;
  /** The jurisdiction code of the Club's addressed province.  The
   *  factory uses this to pick an adapter. */
  jurisdiction: string;
  /** Correlation id for log traceability -- short, non-PII. */
  correlationId: string;
}
