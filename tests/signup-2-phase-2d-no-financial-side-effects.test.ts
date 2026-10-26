// SIGNUP-2 Phase 2D (2026-10-25) -- No financial side effects.
//
// Grep sweep across every Phase 2D source file to pin the
// non-authorisations preserved contractually.  If any future
// refactor accidentally introduces a Stripe call, a ClubSubscription
// write, a Club or User create, or a gov-ID surface, this test
// fires.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();

function listTsFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) listTsFiles(full, acc);
    else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) acc.push(full);
  }
  return acc;
}

const PHASE_2D_FILES = [
  "src/lib/signup/operator-verification.ts",
  "src/lib/signup/operator-action-shared.ts",
  ...listTsFiles(join(ROOT, "src/app/api/admin/signup-ops")),
  ...listTsFiles(join(ROOT, "src/app/app/admin/signup-ops")),
].map((p) => p.startsWith(ROOT) ? p : join(ROOT, p));

describe("SIGNUP-2 Phase 2D · forbidden patterns do not appear in any Phase 2D source file", () => {
  const forbidden = [
    /prisma\.clubSubscription\./,
    /prisma\.club\.create/,
    /prisma\.user\.create/,
    /prisma\.userClubRole\.create/,
    /prisma\.billingCycle\.(create|update|upsert)/,
    /\bstripe\./i,
    /@stripe\/stripe-js/,
    /accessTier\s*:/,
    /govId/i,
    /government[-_ ]?id/i,
    /passport\b/i,
  ];

  for (const path of PHASE_2D_FILES) {
    const content = readFileSync(path, "utf8");
    const rel = path.replace(ROOT, "").replace(/\\/g, "/");
    for (const re of forbidden) {
      it(`${rel} does NOT match ${re}`, () => {
        expect(content).not.toMatch(re);
      });
    }
  }
});

describe("SIGNUP-2 Phase 2D · service writes stay in the allowed table set", () => {
  const service = readFileSync(join(ROOT, "src/lib/signup/operator-verification.ts"), "utf8");

  it("only writes to operatorVerificationRecord + signupRegistration", () => {
    // Collect every prisma / tx mutation call.
    const writes = service.match(/(tx|prisma)\.([a-zA-Z]+)\.(create|createMany|update|updateMany|upsert|delete|deleteMany)/g) ?? [];
    const allowed = new Set(["operatorVerificationRecord", "signupRegistration"]);
    for (const w of writes) {
      const m = w.match(/\.([a-zA-Z]+)\./);
      expect(m, `could not parse write ${w}`).not.toBeNull();
      const model = m![1];
      expect(allowed, `unexpected write to ${model} in ${w}`).toContain(model);
    }
  });

  it("the two SignupRegistration mutations are strictly to the verification* / status columns", () => {
    const regUpdates = service.match(/tx\.signupRegistration\.updateMany\(\s*\{[\s\S]+?\}\s*\)/g) ?? [];
    for (const u of regUpdates) {
      // These are the only allowed field writes.  Any other field would
      // indicate a scope creep (e.g., writing adminEmail or accessTier).
      const forbiddenFields = /\b(adminEmail|adminMicrosoftOid|adminMicrosoftTenantId|accessTier|clubSubscriptionId|legalName)\s*:/g;
      expect(u).not.toMatch(forbiddenFields);
    }
  });
});
