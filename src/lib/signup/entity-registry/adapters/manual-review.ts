// SIGNUP-2 Phase 2C (2026-10-25) -- Manual-review stub adapter.
//
// Used for every jurisdiction where Phase 2C does NOT ship a live
// adapter.  Returns MANUAL_REVIEW_REQUIRED without any outbound
// HTTP call -- Phase 2H operators pick these up from the inbox.
//
// This is not scaffolding; it is a product decision backed by the
// 2026 registry-access investigation (see
// docs/signup-2-phase-2c-registry-investigation.md): AB has no
// legitimate programmatic path, ON requires a licensed service
// provider, BC requires paid account procurement before any live
// call.  Phase 2C ships safely by routing every registration to
// operator review.

import type {
  EntityRegistryAdapter,
  EntityRegistryFetchArgs,
  EntityStandingResult,
} from "../types";

export function createManualReviewAdapter(jurisdiction: string): EntityRegistryAdapter {
  return {
    jurisdiction,
    isLive: false,
    async fetch(args: EntityRegistryFetchArgs): Promise<EntityStandingResult> {
      return {
        jurisdiction,
        businessNumber: null,
        standing: "MANUAL_REVIEW_REQUIRED",
        officerMatch: null,
        evidenceSource: `stub:manual-review:${jurisdiction}`,
        operatorHint:
          "Automated registry verification not configured for this jurisdiction. " +
          "Operator must obtain the Certificate of Status (or equivalent) and classify.",
        fetchedAt: new Date(),
      };
    },
  };
}
