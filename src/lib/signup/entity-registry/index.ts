// SIGNUP-2 Phase 2C (2026-10-25) -- EntityRegistryAdapter factory.
//
// Resolves the correct adapter for a given jurisdiction.
//
// Two modes, governed by `SPECTRE_SIGNUP_2C_ADAPTER_MODE`:
//   "fixture"  -- deterministic test adapter; ONLY used by vitest +
//                 Playwright staging acceptance.
//   anything   -- manual-review stub for every jurisdiction (Phase
//   else /       2C baseline per the registry-access investigation;
//   unset        AB/ON/BC all require procurement before a live
//                adapter can replace the stub).
//
// Fail-closed: an unknown jurisdiction falls through to the
// manual-review stub.  No adapter can be selected that fabricates
// an ACTIVE verdict.

import type { EntityRegistryAdapter } from "./types";
import { createManualReviewAdapter } from "./adapters/manual-review";
import { createFixtureAdapter } from "./adapters/fixture";

/** The three priority Canadian jurisdictions per founder §1.  Phase
 *  2C baseline ships them as manual-review stubs; a future
 *  procurement-driven slice may replace specific entries. */
export const SUPPORTED_JURISDICTIONS = [
  "CA-AB",
  "CA-ON",
  "CA-BC",
  // Other CA provinces fall through to manual-review-anonymous.
] as const;

export function isFixtureAdapterMode(): boolean {
  return process.env.SPECTRE_SIGNUP_2C_ADAPTER_MODE === "fixture";
}

export function resolveAdapter(jurisdiction: string): EntityRegistryAdapter {
  const jur = jurisdiction || "CA-UNKNOWN";
  if (isFixtureAdapterMode()) {
    return createFixtureAdapter(jur);
  }
  // Phase 2C baseline: every jurisdiction routes to manual review.
  // Replacement with a live adapter requires a separately-authorised
  // slice (procurement + legal review + rotation of this factory).
  return createManualReviewAdapter(jur);
}

export type { EntityRegistryAdapter, EntityStandingResult, EntityStanding, OfficerMatch } from "./types";
