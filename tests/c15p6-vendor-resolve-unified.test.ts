// Sprint 3 · Checkpoint 15P-6 (2026-07-28) — source-contract locks
// for the unified vendor matcher.
//
// Root cause of 15P-5 founder rejection:
//   `resolveVendorForExtraction` (the projection's matcher) used a
//   different implementation (`matchVendorForClub`) from the
//   modal's `/api/vendors/search` endpoint (evidence-based
//   `retrieveCandidates` + `evaluateVendorMatch`). The projection
//   returned NOT_FOUND for the Microsoft record while the modal
//   found an EXACT match on 10 fields. Drift.
//
// 15P-6 unifies both surfaces on the SAME matcher. This suite
// locks the unification so a future refactor cannot silently
// reintroduce a second matcher.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

function read(p: string) { return readFileSync(join(process.cwd(), p), "utf8"); }

const RESOLVE = read("src/lib/ap-intelligence/vendor-resolve.ts");
const ANALYSE = read("src/lib/ap-intelligence/analyse.ts");

describe("15P-6 · vendor projection uses the same evidence-based matcher as the modal", () => {
  it("resolveVendorForExtraction imports retrieveCandidates + evaluateVendorMatch + resolveModalEntry", () => {
    expect(RESOLVE).toMatch(/import \{ retrieveCandidates \} from "@\/lib\/vendor-matching\/retrieve"/);
    expect(RESOLVE).toMatch(/import \{ evaluateVendorMatch \} from "@\/lib\/vendor-matching\/evaluate"/);
    expect(RESOLVE).toMatch(/import \{ resolveModalEntry/);
  });
  it("the retired matchVendorForClub is no longer imported by the projection", () => {
    expect(RESOLVE).not.toMatch(/import \{[\s\S]{0,120}matchVendorForClub/);
    expect(RESOLVE).not.toMatch(/matchVendorForClub\(/);
  });
  it("ruleVersion bumped to 2 (matcher swap)", () => {
    expect(RESOLVE).toMatch(/const RULE_VERSION = 2/);
  });
  it("resolver builds a MatchInputProfile that carries the richer extractedProfile fields", () => {
    // The founder rule: the projection should have the SAME evidence
    // the modal has. That means feeding it the 15P-1 vendor-profile
    // extractor output alongside the parse-invoice guesses.
    expect(RESOLVE).toMatch(/extractedProfile\?:/);
    expect(RESOLVE).toMatch(/const extractedFor: MatchInputProfile = \{/);
    for (const f of ["addressLine1", "city", "provinceState", "postalCode", "country", "phone", "website", "taxRegistrationNumber"]) {
      expect(RESOLVE).toMatch(new RegExp(`\\b${f}:`));
    }
  });
  it("resolver calls the shared resolveModalEntry to decide status", () => {
    expect(RESOLVE).toMatch(/const resolution = resolveModalEntry\(forResolution\)/);
  });
  it("MATCHED result surfaces exactly ONE canonical candidate (the resolved leader)", () => {
    // The card reads candidates[0].id as matchedVendorId. For the
    // auto-resolve case we must return a single-element array
    // matching the resolved candidate, NOT the full list — that
    // would confuse downstream consumers into thinking the leader
    // is ambiguous.
    expect(RESOLVE).toMatch(/state = "MATCHED";\s*outCandidates = \[\{\s*id: resolution\.candidate\.id/);
  });
  it("staging-only structured log (never logs sensitive data)", () => {
    expect(RESOLVE).toMatch(/process\.env\.SPECTRE_ENV !== "production"/);
    expect(RESOLVE).toMatch(/logger\.info\("ap-intelligence\.vendor-resolve"/);
    // The log lists field NAMES / counts / states — not raw values.
    // Guard against a regression that starts logging the extracted
    // tax number or email address.
    const logBlock = RESOLVE.slice(RESOLVE.indexOf('logger.info("ap-intelligence.vendor-resolve"'), RESOLVE.indexOf("logger.info(\"ap-intelligence.vendor-resolve\"") + 800);
    expect(logBlock).not.toMatch(/taxRegistrationNumber:.*value|extractedFor\.taxRegistrationNumber|extractedFor\.email/);
  });
});

describe("15P-6 · analyse.ts feeds the richer vendor-profile extraction into vendor resolution", () => {
  it("vendor-profile extractor runs BEFORE resolveVendorForExtraction", () => {
    // The two must be ordered so the resolver's `extractedProfile`
    // arg can be populated. Pre-15P-6 the profile was computed
    // AFTER the resolver, producing the founder-observed drift.
    const extractedIdx = ANALYSE.indexOf("const vendorProfileExtracted");
    const resolveIdx   = ANALYSE.indexOf("await resolveVendorForExtraction");
    expect(extractedIdx).toBeGreaterThan(-1);
    expect(resolveIdx).toBeGreaterThan(extractedIdx);
  });
  it("resolveVendorForExtraction receives extractedProfile", () => {
    expect(ANALYSE).toMatch(/resolveVendorForExtraction\(\{\s*clubId: args\.clubId,\s*extraction,\s*extractedProfile: vendorProfileExtracted,\s*\}\)/);
  });
  it("vendorProfile is aliased for return-shape backward compat", () => {
    // Downstream consumers depend on `vendorProfile` being on the
    // ApAnalyseResult. Refactor kept the field name.
    expect(ANALYSE).toMatch(/const vendorProfile = vendorProfileExtracted/);
    expect(ANALYSE).toMatch(/vendorProfile,/);
  });
});
