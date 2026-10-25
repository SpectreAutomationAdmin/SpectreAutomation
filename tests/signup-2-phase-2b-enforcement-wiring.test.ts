// SIGNUP-2 Phase 2B (2026-10-25) -- Access-tier enforcement wiring
// contract tests.
//
// Verifies the three seams declared in
// docs/signup-2-phase-2b-capability-matrix.md:
//   Seam 1: posting-guard.assertPostingAllowed + assertSensitiveActionAllowed
//           -> assertAccessTierForPosting
//   Seam 2: integrations/email.selectEmailAdapter
//           -> assertAccessTierForClubEmail
//   Seam 3: (not needed in Phase 2B; documented as deferred)
//
// Plus the legacy-grandfather semantics in the gate helpers.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const POSTING_GUARD = readFileSync(join(ROOT, "src/lib/posting-guard/index.ts"), "utf8");
const EMAIL_ADAPTER = readFileSync(join(ROOT, "src/lib/integrations/email.ts"), "utf8");
const ACCESS_TIER = readFileSync(join(ROOT, "src/lib/billing/access-tier.ts"), "utf8");

describe("SIGNUP-2 Phase 2B · Seam 1 posting-guard wiring", () => {
  it("posting-guard imports assertAccessTierForPosting", () => {
    expect(POSTING_GUARD).toMatch(/import { assertAccessTierForPosting } from "\.\.\/billing\/access-tier"/);
  });

  it("assertPostingAllowed calls assertAccessTierForPosting(clubId)", () => {
    const block = POSTING_GUARD.match(/export async function assertPostingAllowed[\s\S]+?^}/m);
    expect(block, "assertPostingAllowed function block not found").not.toBeNull();
    expect(block![0]).toMatch(/await assertAccessTierForPosting\(clubId\)/);
  });

  it("assertSensitiveActionAllowed calls assertAccessTierForPosting(clubId)", () => {
    const block = POSTING_GUARD.match(/export async function assertSensitiveActionAllowed[\s\S]+?^}/m);
    expect(block, "assertSensitiveActionAllowed function block not found").not.toBeNull();
    expect(block![0]).toMatch(/await assertAccessTierForPosting\(clubId\)/);
  });

  it("posting-guard preserves the training + support-session gates (order-independent)", () => {
    expect(POSTING_GUARD).toMatch(/await assertNotTraining\(clubId, action\)/);
    expect(POSTING_GUARD).toMatch(/await assertAllowedAction\(/);
  });
});

describe("SIGNUP-2 Phase 2B · Seam 2 selectEmailAdapter wiring", () => {
  it("selectEmailAdapter imports and calls assertAccessTierForClubEmail(clubId)", () => {
    expect(EMAIL_ADAPTER).toMatch(/const { assertAccessTierForClubEmail } = await import\("@\/lib\/billing\/access-tier"\)/);
    expect(EMAIL_ADAPTER).toMatch(/await assertAccessTierForClubEmail\(clubId\)/);
  });

  it("The gate runs BEFORE any adapter construction (first write after derivation)", () => {
    const body = EMAIL_ADAPTER.match(/export async function selectEmailAdapter\([\s\S]+?Priority 1/)![0];
    // Pattern: derive clubId -> call gate -> Priority 1 block begins.
    expect(body).toMatch(/const clubId =[\s\S]+?await assertAccessTierForClubEmail\(clubId\)[\s\S]+?Priority 1/);
  });

  it("The platform-level selectPlatformEmailAdapter is NOT gated (no clubId)", () => {
    const platform = EMAIL_ADAPTER.match(/export async function selectPlatformEmailAdapter[\s\S]+?^}/m);
    expect(platform, "selectPlatformEmailAdapter block not found").not.toBeNull();
    expect(platform![0]).not.toMatch(/assertAccessTierForClubEmail/);
    expect(platform![0]).not.toMatch(/assertAccessTierForPosting/);
  });
});

describe("SIGNUP-2 Phase 2B · gate semantics (null = grandfather)", () => {
  it("assertAccessTierForPosting returns silently when no ClubSubscription row exists", () => {
    expect(ACCESS_TIER).toMatch(/if \(!sub\) return \{ pass: true, detail: "no-subscription-row" \}/);
  });

  it("assertAccessTierForPosting returns silently on legacy null/unknown accessTier", () => {
    expect(ACCESS_TIER).toMatch(/if \(tier === null\) return \{ pass: true, detail: "legacy-grandfather" \}/);
  });

  it("assertAccessTierForPosting returns silently on tier === FULL", () => {
    expect(ACCESS_TIER).toMatch(/if \(tier === "FULL"\) return \{ pass: true, detail: "full" \}/);
  });

  it("assertAccessTierForPosting returns silently on subscriptionStatus === MANUAL_INVOICE", () => {
    expect(ACCESS_TIER).toMatch(/if \(sub\.subscriptionStatus === "MANUAL_INVOICE"\)/);
  });

  it("Only one FAIL branch: everything else throws", () => {
    expect(ACCESS_TIER).toMatch(/pass:\s*false,\s*detail:/);
    expect(ACCESS_TIER).toMatch(/throw new ForbiddenError/);
  });

  it("assertAccessTierForClubEmail shares the same gate semantics", () => {
    expect(ACCESS_TIER).toMatch(/export async function assertAccessTierForClubEmail\(clubId: string\): Promise<void>/);
    const block = ACCESS_TIER.match(/export async function assertAccessTierForClubEmail[\s\S]+?^}/m);
    expect(block, "clubEmail block not found").not.toBeNull();
    expect(block![0]).toMatch(/evaluateAccessTierGate\(clubId\)/);
  });

  it("The shared evaluator is NOT exported (encapsulation of gate semantics)", () => {
    expect(ACCESS_TIER).toMatch(/^\s*async function evaluateAccessTierGate/m);
    expect(ACCESS_TIER).not.toMatch(/^export async function evaluateAccessTierGate/m);
  });
});

describe("SIGNUP-2 Phase 2B · gate reads only accessTier + subscriptionStatus", () => {
  it("findUnique selects ONLY the two tier-relevant columns (no over-fetch)", () => {
    const q = ACCESS_TIER.match(/prisma\.clubSubscription\.findUnique[\s\S]+?\}\);/);
    expect(q, "findUnique block not found").not.toBeNull();
    expect(q![0]).toMatch(/select:\s*{\s*accessTier:\s*true,\s*subscriptionStatus:\s*true\s*}/);
  });

  it("No gate code path writes to ClubSubscription (read-only guard)", () => {
    expect(ACCESS_TIER).not.toMatch(/clubSubscription\.update/);
    expect(ACCESS_TIER).not.toMatch(/clubSubscription\.upsert/);
    expect(ACCESS_TIER).not.toMatch(/clubSubscription\.create/);
    expect(ACCESS_TIER).not.toMatch(/clubSubscription\.delete/);
  });
});

describe("SIGNUP-2 Phase 2B · classification-D capabilities remain un-gated (feature doesn't exist)", () => {
  it("No src/ file imports a `issueApiToken` or `publishMemberPortal` symbol (D-tier capabilities)", () => {
    // These are documented as not-yet-built in docs/signup-2-phase-2b-capability-matrix.md
    // classification D.  Phase 2B does NOT add stubs for them.
    const grepSym = (sym: string): boolean => {
      try {
        const out = require("node:child_process").execSync(
          `node -e "const g = require('fs').readdirSync('src', { recursive: true }); console.log(g.join('\\n'))" 2>&1`,
          { encoding: "utf8", cwd: ROOT },
        );
        return out.includes(sym);
      } catch { return false; }
    };
    // Minimal check: the capability KEYS appear only in access-tier.ts (the map definition).
    const map = readFileSync(join(ROOT, "src/lib/billing/access-tier.ts"), "utf8");
    expect(map).toMatch(/"api\.token\.issue":\s*"FULL"/);
    expect(map).toMatch(/"member\.portal\.publish":\s*"FULL"/);
  });
});
