// SIGNUP-2 Phase 2H (2026-10-26) -- Posting-guard + access-tier
// coverage contract.  Verifies the integration points Phase 2H
// relies on at the posting-guard seam, without requiring a DB.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const POSTING_GUARD = readFileSync(
  join(process.cwd(), "src/lib/posting-guard/index.ts"),
  "utf8",
);
const ACCESS_TIER = readFileSync(
  join(process.cwd(), "src/lib/billing/access-tier.ts"),
  "utf8",
);

describe("SIGNUP-2 Phase 2H · posting-guard still calls assertAccessTierForPosting", () => {
  it("assertPostingAllowed calls the access-tier gate", () => {
    expect(POSTING_GUARD).toMatch(/assertAccessTierForPosting/);
  });
  it("assertSensitiveActionAllowed calls the access-tier gate", () => {
    const block = POSTING_GUARD.match(/export async function assertSensitiveActionAllowed[\s\S]+?^}/m)![0];
    expect(block).toMatch(/assertAccessTierForPosting/);
  });
});

describe("SIGNUP-2 Phase 2H · access-tier existing-tenant protection", () => {
  it("evaluateAccessTierGate returns pass:true for subscriptionStatus=null (legacy)", () => {
    const body = ACCESS_TIER.match(/async function evaluateAccessTierGate[\s\S]+?^}/m)![0];
    // Null subscription-row OR null tier → legacy pass.
    expect(body).toMatch(/if \(!sub\)/);
    expect(body).toMatch(/tier === null/);
    expect(body).toMatch(/legacy-grandfather/);
  });
  it("tier=SUSPENDED_READ_ONLY (what Phase 2H sets) fails the gate", () => {
    // Not an "ok" branch; falls through to the final `return { pass: false }`.
    const body = ACCESS_TIER.match(/async function evaluateAccessTierGate[\s\S]+?^}/m)![0];
    expect(body).toMatch(/pass:\s*false/);
    // Confirm neither tier=FULL nor status=MANUAL_INVOICE match a
    // SUSPENDED_READ_ONLY / SUSPENDED subscription.
    expect(body).not.toMatch(/tier === "SUSPENDED_READ_ONLY".+pass:\s*true/s);
  });
});

describe("SIGNUP-2 Phase 2H · SUSPENDED_READ_ONLY tier is enforced", () => {
  it("ACCESS_TIERS enum lists SUSPENDED_READ_ONLY", () => {
    expect(ACCESS_TIER).toMatch(/"SUSPENDED_READ_ONLY"/);
  });
  it("isTierSufficient refuses FULL under SUSPENDED_READ_ONLY", () => {
    expect(ACCESS_TIER).toMatch(/current === "SUSPENDED_READ_ONLY" && required === "FULL".+return false/s);
  });
});
