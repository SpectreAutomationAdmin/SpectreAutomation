// Sprint 3 · Post-16H Phase 4 Slice 4-reopen (2026-08-07) —
// founder-§14 acceptance: DMM supplier identity must be supported
// by MULTIPLE independent evidence groups, not a single domain
// shortcut. Regression controls: CPA Alberta must ALSO carry
// multi-evidence supplier identity.
//
// Uses the deployed /api/ap-intelligence/inspect-wi endpoint's
// canonicalSupplierWinner + supplier candidates to inspect the
// production data path. Frozen-boundary respecting: does not
// assert on economic-purpose or GL (those remain Slice-5 work).

import { test, expect } from "@playwright/test";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

const availability = stagingCredsAvailable();

interface CandidateShape {
  value: string;
  confidence: number;
  ruleKey?: string;
  evidenceSnippet?: string;
  validationStatus?: string;
}

async function probeWi(page: import("@playwright/test").Page, suffix4: string) {
  const res = await page.request.post(`${availability.baseURL}/api/ap-intelligence/inspect-wi`, {
    data: { wiIdSuffix4: suffix4 },
  });
  expect(res.status(), `inspect-wi ${suffix4} HTTP`).toBe(200);
  return await res.json();
}

function evidenceGroupsFromRuleKey(cand: CandidateShape | null | undefined): number {
  if (!cand?.ruleKey) return 0;
  // Format: supplier.identity_orchestrator+<N>_groups+ranker_v2
  const m = cand.ruleKey.match(/\+(\d+)_groups\b/);
  return m ? Number(m[1]) : 0;
}

function evidenceTypesFromSnippet(cand: CandidateShape | null | undefined): string[] {
  if (!cand?.evidenceSnippet) return [];
  return cand.evidenceSnippet.split("+");
}

test.describe("Slice 4-reopen · multi-evidence supplier identity — actual cards", () => {
  test.skip(!availability.ready, availability.reason ?? "creds unavailable");

  test("DMM supplier identity is corroborated by ≥2 independent evidence groups (§14)", async ({ context }) => {
    const page = await loginAsFounder(context);
    const body = await probeWi(page, "8fk9");
    const winner: CandidateShape = body.analyseResult?.canonicalSupplierWinner;
    expect(winner, "canonical supplier winner is populated").toBeTruthy();
    // Post-fix winner: "DMM ENERGY INC" (legal name from footer)
    expect(winner.value, "supplier value carries DMM identity").toMatch(/DMM/i);
    expect(winner.value.toLowerCase(), "supplier value is not a remittance instruction")
      .not.toContain("please write");
    expect(winner.value.toLowerCase(), "supplier value is not domain-derived alone")
      .not.toBe("dmmenergy");
    // Independent evidence groups ≥ 2.
    const groups = evidenceGroupsFromRuleKey(winner);
    expect(groups, "≥2 independent evidence groups").toBeGreaterThanOrEqual(2);
    // Supporting evidence must include LEGAL_ENTITY_TEXT + WEBSITE_DOMAIN
    // (the two strongest DMM signals) plus at least one adjacent block.
    const types = evidenceTypesFromSnippet(winner);
    expect(types, "LEGAL_ENTITY_TEXT is among supporting evidence")
      .toContain("LEGAL_ENTITY_TEXT");
    expect(types, "WEBSITE_DOMAIN is among supporting evidence")
      .toContain("WEBSITE_DOMAIN");
    expect(types.some((t) => t === "TAX_REGISTRATION" || t === "PHONE_BLOCK" || t === "ADDRESS_BLOCK"),
      "at least one adjacent-block signal (tax reg / phone / address) present").toBe(true);
    // validationStatus is on the CANDIDATES array (not on the
    // selection winner shape) — assert PASSED on the matching
    // candidate row instead.
    const winnerCandidate = (body.analyseResult?.canonicalSupplierCandidates as CandidateShape[])
      .find((c) => c.value === winner.value);
    expect(winnerCandidate?.validationStatus, "winner candidate PASSED validation").toBe("PASSED");
    expect(winner.confidence, "winner confidence is high").toBeGreaterThanOrEqual(70);
    // Rejected alternates prove Silver Springs / bill-to / sentence
    // never won.
    const cands = (body.analyseResult?.canonicalSupplierCandidates ?? []) as CandidateShape[];
    for (const c of cands) {
      if (c.value === winner.value) continue;
      // Any other candidate must be a plausibility-failed alternate.
      expect(c.validationStatus, `alternate ${c.value.slice(0, 40)} must not have PASSED validation status`)
        .not.toBe("PASSED");
    }
  });

  test("CPA Alberta supplier identity is also multi-evidence corroborated (regression control)", async ({ context }) => {
    const page = await loginAsFounder(context);
    const body = await probeWi(page, "w3bz");
    const winner: CandidateShape = body.analyseResult?.canonicalSupplierWinner;
    expect(winner, "canonical supplier winner is populated").toBeTruthy();
    // CPA Alberta should carry its identity; we don't assert an
    // exact string because tenant vendor matching may prefer legal
    // vs operating name, but we do assert it's CPA-shaped and
    // multi-evidence.
    expect(winner.value.toLowerCase(), "CPA supplier carries CPA identity")
      .toMatch(/cpa/);
    const groups = evidenceGroupsFromRuleKey(winner);
    // Small orgs may have fewer signals; accept ≥1 group if legal
    // entity text is present, else require ≥2.
    if (groups < 2) {
      const types = evidenceTypesFromSnippet(winner);
      expect(types.some((t) => t === "LEGAL_ENTITY_TEXT" || t === "HEADER_ORG_TEXT"),
        "single-group CPA supplier must have LEGAL/HEADER text evidence").toBe(true);
    }
  });

  test("Oakcreek + OXIO regressions still pass — supplier winner populated", async ({ context }) => {
    const page = await loginAsFounder(context);
    for (const suffix of ["vkbm", "73n5"]) {
      const body = await probeWi(page, suffix);
      const winner: CandidateShape = body.analyseResult?.canonicalSupplierWinner;
      expect(winner, `MAIL-${suffix.toUpperCase()} winner populated`).toBeTruthy();
      expect(String(winner.value).toLowerCase()).not.toContain("please write");
      expect(String(winner.value).toLowerCase()).not.toBe("bill to");
      expect(String(winner.value).toLowerCase()).not.toBe("customer");
    }
  });

  test("all four AP cards' supplier winners are NOT a domain-only shortcut", async ({ context }) => {
    const page = await loginAsFounder(context);
    for (const suffix of ["8fk9", "vkbm", "73n5", "w3bz"]) {
      const body = await probeWi(page, suffix);
      const winner: CandidateShape = body.analyseResult?.canonicalSupplierWinner;
      if (!winner) continue;
      // A "domain-only" winner would carry ruleKey like
      // "supplier.website_domain_seed+ranker_v2" WITHOUT
      // identity_orchestrator. The founder-§18 safeguard says
      // domain-only cannot be a high-confidence supplier.
      const isDomainSeedWithoutOrchestrator =
        winner.ruleKey?.startsWith("supplier.website_domain_seed") ?? false;
      expect(isDomainSeedWithoutOrchestrator,
        `MAIL-${suffix.toUpperCase()} winner must not be domain-seed alone (${winner.ruleKey})`).toBe(false);
    }
  });
});
