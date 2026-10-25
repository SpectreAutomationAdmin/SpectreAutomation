// SIGNUP-2 Phase 2C (2026-10-25) -- Fixture adapter (test-only).
//
// Returns deterministic EntityStandingResult values driven by the
// legalName the test seeds.  Enables Playwright + contract tests to
// exercise all four classification outcomes without a real registry
// call.
//
// Hard safety: this adapter is ONLY resolved when the environment
// variable SPECTRE_SIGNUP_2C_ADAPTER_MODE === "fixture".  Default
// resolution (unset env) returns the manual-review stub for every
// jurisdiction.  A contract test asserts this.

import type {
  EntityRegistryAdapter,
  EntityRegistryFetchArgs,
  EntityStandingResult,
  EntityStanding,
  OfficerMatch,
} from "../types";

/** Fixture directive encoded in the Club legal name.  Tests seed a
 *  legalName like "FIXTURE:ACTIVE+MATCHED Example Club" to pin the
 *  outcome.  Any name without a recognised prefix falls through to
 *  MANUAL_REVIEW_REQUIRED (defensive default). */
interface Directive {
  standing: EntityStanding;
  officerMatch: OfficerMatch;
}

function parseDirective(legalName: string): Directive {
  const match = legalName.match(/^FIXTURE:([A-Z_]+)(?:\+([A-Z_]+))?/);
  if (!match) {
    return { standing: "MANUAL_REVIEW_REQUIRED", officerMatch: null };
  }
  const stand = match[1] as EntityStanding;
  const officer = (match[2] ?? null) as OfficerMatch;
  if (
    stand !== "ACTIVE" &&
    stand !== "NOT_ACTIVE" &&
    stand !== "NOT_FOUND" &&
    stand !== "MANUAL_REVIEW_REQUIRED"
  ) {
    return { standing: "MANUAL_REVIEW_REQUIRED", officerMatch: null };
  }
  if (
    officer !== null &&
    officer !== "MATCHED" &&
    officer !== "PARTIAL" &&
    officer !== "NOT_MATCHED"
  ) {
    return { standing: stand, officerMatch: null };
  }
  return { standing: stand, officerMatch: officer };
}

export function createFixtureAdapter(jurisdiction: string): EntityRegistryAdapter {
  return {
    jurisdiction,
    isLive: false,
    async fetch(args: EntityRegistryFetchArgs): Promise<EntityStandingResult> {
      const d = parseDirective(args.legalName);
      return {
        jurisdiction,
        businessNumber: d.standing === "ACTIVE" ? "FIXTURE-BN-000001" : null,
        standing: d.standing,
        officerMatch: d.officerMatch,
        evidenceSource: `fixture:${d.standing}${d.officerMatch ? `+${d.officerMatch}` : ""}`,
        operatorHint: null,
        fetchedAt: new Date(),
      };
    },
  };
}
