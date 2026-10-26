// SIGNUP-2 Phase 2E §2 correction (2026-10-26) -- Authorization-
// model correction tests.
//
// Verifies the founder-amended rule: a manual three-operator release
// writes verificationVerdict = "MANUAL_RELEASE" (NOT PASS_AUTOMATED).
// PASS_AUTOMATED is reserved for a future automated-corroborator
// pass.  Phase 2E downstream code accepts BOTH as terminal
// AUTHORISED-equivalent outputs.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const PHASE_2D_SERVICE = readFileSync(join(ROOT, "src/lib/signup/operator-verification.ts"), "utf8");
const PHASE_2E_SERVICE = readFileSync(join(ROOT, "src/lib/billing/signup-2e-mandate-service.ts"), "utf8");
const APPLICANT_COMPLETE = readFileSync(join(ROOT, "src/app/signup/t/[token]/authority/complete/page.tsx"), "utf8");
const MANDATE_PAGE = readFileSync(join(ROOT, "src/app/signup/t/[token]/mandate/page.tsx"), "utf8");

describe("SIGNUP-2 Phase 2D release writer uses MANUAL_RELEASE verdict (§2 correction)", () => {
  it("releaseRegistration writes verificationVerdict = MANUAL_RELEASE", () => {
    expect(PHASE_2D_SERVICE).toMatch(/verificationVerdict:\s*"MANUAL_RELEASE"/);
  });

  it("the release path does NOT write PASS_AUTOMATED (preserved for the automated-corroborator path only)", () => {
    const releaseBlock = PHASE_2D_SERVICE.match(/export async function releaseRegistration[\s\S]+?^}/m)!;
    expect(releaseBlock[0]).not.toMatch(/verificationVerdict:\s*"PASS_AUTOMATED"/);
    // Return value is also MANUAL_RELEASE.
    expect(releaseBlock[0]).toMatch(/verdict:\s*"MANUAL_RELEASE"\s*as const/);
  });

  it("replay guard accepts BOTH MANUAL_RELEASE and PASS_AUTOMATED as terminal", () => {
    expect(PHASE_2D_SERVICE).toMatch(/reg\.verificationVerdict === "MANUAL_RELEASE" \|\| reg\.verificationVerdict === "PASS_AUTOMATED"/);
  });

  it("computeQueueState maps BOTH verdicts to the RELEASED label", () => {
    expect(PHASE_2D_SERVICE).toMatch(/args\.verdict === "PASS_AUTOMATED" \|\| args\.verdict === "MANUAL_RELEASE".*RELEASED/);
  });
});

describe("SIGNUP-2 Phase 2E downstream accepts both verdicts", () => {
  it("mandate-service assertAuthorised accepts MANUAL_RELEASE OR PASS_AUTOMATED", () => {
    const block = PHASE_2E_SERVICE.match(/function assertAuthorised[\s\S]+?^}/m)!;
    expect(block[0]).toMatch(/reg\.verificationVerdict !== "MANUAL_RELEASE" && reg\.verificationVerdict !== "PASS_AUTOMATED"/);
  });

  it("applicant /authority/complete page renders PASS state for BOTH verdicts", () => {
    expect(APPLICANT_COMPLETE).toMatch(/verification\.verificationVerdict === "PASS_AUTOMATED" \|\| verification\.verificationVerdict === "MANUAL_RELEASE"/);
  });

  it("mandate page gates entry on BOTH verdicts", () => {
    expect(MANDATE_PAGE).toMatch(/"MANUAL_RELEASE"/);
    expect(MANDATE_PAGE).toMatch(/"PASS_AUTOMATED"/);
  });
});
