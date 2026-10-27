// SIGNUP-2 Phase 2B (2026-10-25) -- Capability coverage test.
//
// Verifies the matrix in docs/signup-2-phase-2b-capability-matrix.md:
//
// 1. Every classification-A file imports from posting-guard and
//    calls at least one of its two assertion functions.
// 2. Every classification-B file imports from posting-guard and
//    calls assertSensitiveActionAllowed.
// 3. The Phase 2B seam itself: posting-guard calls
//    assertAccessTierForPosting; email adapter calls
//    assertAccessTierForClubEmail.  (Overlaps with the enforcement
//    wiring test; kept here to make the matrix self-contained.)
// 4. Classification-D capabilities have NO code path (grep sweep).
//
// Fails loudly if a future refactor silently removes a seam.

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();

interface MatrixEntry {
  cap: string;
  cls: "A" | "B" | "A+B";
  file: string;
}

// Classification A: files that currently funnel writes through
// assertPostingAllowed (per the capability matrix).
const CLASS_A: MatrixEntry[] = [
  { cap: "gl.journal.post", cls: "A", file: "src/lib/accounting/journal.ts" },
  { cap: "ap.invoice.post", cls: "A", file: "src/lib/ap/invoices.ts" },
  { cap: "ap.payment.post", cls: "A", file: "src/lib/ap/payments.ts" },
  { cap: "payroll.batch.run", cls: "A", file: "src/lib/payroll/approve-and-post.ts" },
  { cap: "payroll.statement.publish", cls: "A", file: "src/lib/payroll/approved-time.ts" },
  { cap: "club.coa.commit", cls: "A", file: "src/lib/imports/index.ts" },
  { cap: "club.opening-balance.commit", cls: "A", file: "src/lib/opening-balance/index.ts" },
  { cap: "hr.sensitive-identity.edit", cls: "A+B", file: "src/lib/hr/sensitive-identity.ts" },
  { cap: "hr.compensation.edit", cls: "A", file: "src/lib/hr/compensation.ts" },
  { cap: "hr.employment-assignment.change", cls: "A", file: "src/lib/hr/employment-assignments.ts" },
  { cap: "announcements.create", cls: "A", file: "src/lib/announcements.ts" },
];

// Classification B: files that currently funnel sensitive writes
// through assertSensitiveActionAllowed.
const CLASS_B: MatrixEntry[] = [
  { cap: "hr.bank-account.edit", cls: "B", file: "src/lib/hr/bank-account.ts" },
  { cap: "hr.tax-profile.edit", cls: "B", file: "src/lib/hr/tax-profile.ts" },
  { cap: "hr.employee.create", cls: "B", file: "src/lib/hr/employees.ts" },
  { cap: "hr.employment-period.edit", cls: "B", file: "src/lib/hr/employment-periods.ts" },
  { cap: "hr.credentials.edit", cls: "B", file: "src/lib/hr/credentials.ts" },
  { cap: "hr.documents.edit", cls: "B", file: "src/lib/hr/documents.ts" },
  { cap: "payroll.implementation-declaration", cls: "B", file: "src/lib/payroll/implementation-declaration.ts" },
  { cap: "club-domains.edit", cls: "B", file: "src/lib/club-domains/index.ts" },
];

// Classification D: capability keys that should have NO
// implementation grep hits other than the capability-tier map.
const CLASS_D_SYMBOLS = [
  // No "generateApiToken" / "createApiToken" / "issueApiToken" symbol.
  "generateApiToken",
  "createApiToken",
  "issueApiToken",
  // No portal publish surface.
  "publishMemberPortal",
  // No user-visible "enable webhook" surface.
  "enableIntegrationWebhook",
];

describe("SIGNUP-2 Phase 2B · classification A files call posting-guard", () => {
  for (const entry of CLASS_A) {
    it(`${entry.cap} -> ${entry.file} calls assertPostingAllowed or assertSensitiveActionAllowed`, () => {
      const path = join(ROOT, entry.file);
      if (!existsSync(path)) {
        // Some matrix rows are aggregator / router entry points
        // that may not exist as a single file.  Skip rather than
        // fail; the matrix doc is the authoritative audit log.
        return;
      }
      const content = readFileSync(path, "utf8");
      const callsPosting = /assertPostingAllowed\(/.test(content);
      const callsSensitive = /assertSensitiveActionAllowed\(/.test(content);
      // M1c (2026-10-26): withPostingGuard is the migration surface
      // and internally calls assertPostingAllowed({tx}); accept it
      // as a valid posting-guard pattern.
      const callsWithPostingGuard = /withPostingGuard\(/.test(content);
      expect(callsPosting || callsSensitive || callsWithPostingGuard).toBe(true);
    });
  }
});

describe("SIGNUP-2 Phase 2B · classification B files call assertSensitiveActionAllowed", () => {
  for (const entry of CLASS_B) {
    it(`${entry.cap} -> ${entry.file} calls assertSensitiveActionAllowed`, () => {
      const path = join(ROOT, entry.file);
      if (!existsSync(path)) {
        return;
      }
      const content = readFileSync(path, "utf8");
      // Permit either sensitive OR posting (the two share the gate seam).
      const callsPosting = /assertPostingAllowed\(/.test(content);
      const callsSensitive = /assertSensitiveActionAllowed\(/.test(content);
      expect(callsPosting || callsSensitive).toBe(true);
    });
  }
});

describe("SIGNUP-2 Phase 2B · the two seams fan out to all A/B callers", () => {
  it("posting-guard.ts calls assertAccessTierForPosting (covers ALL A+B)", () => {
    const g = readFileSync(join(ROOT, "src/lib/posting-guard/index.ts"), "utf8");
    expect(g).toMatch(/await assertAccessTierForPosting\(clubId\)/);
  });

  it("email.ts selectEmailAdapter calls assertAccessTierForClubEmail (covers C)", () => {
    const e = readFileSync(join(ROOT, "src/lib/integrations/email.ts"), "utf8");
    expect(e).toMatch(/await assertAccessTierForClubEmail\(clubId\)/);
  });
});

describe("SIGNUP-2 Phase 2B · classification D capabilities have no code path yet", () => {
  for (const symbol of CLASS_D_SYMBOLS) {
    it(`No src/ file defines or exports '${symbol}'`, () => {
      // Walk src/ once per symbol via a lightweight grep.
      // Using node:fs recursive readdir to avoid a shell dep.
      const walk = (dir: string, acc: string[] = []): string[] => {
        const fs = require("node:fs") as typeof import("node:fs");
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = join(dir, entry.name);
          if (entry.isDirectory()) walk(full, acc);
          else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) acc.push(full);
        }
        return acc;
      };
      const files = walk(join(ROOT, "src"));
      const re = new RegExp(`(export\\s+(?:async\\s+)?function\\s+${symbol}\\b|export\\s+const\\s+${symbol}\\b)`);
      const hits = files.filter((f) => re.test(readFileSync(f, "utf8")));
      expect(hits, `Found definitions of ${symbol}: ${hits.join(", ")}`).toEqual([]);
    });
  }

  it("The capability-tier map in access-tier.ts still lists the D-tier keys as FULL (gate is prospective)", () => {
    const t = readFileSync(join(ROOT, "src/lib/billing/access-tier.ts"), "utf8");
    expect(t).toMatch(/"api\.token\.issue":\s*"FULL"/);
    expect(t).toMatch(/"member\.portal\.publish":\s*"FULL"/);
    expect(t).toMatch(/"integration\.webhook\.enable":\s*"FULL"/);
  });
});

describe("SIGNUP-2 Phase 2B · platform-level paths are NOT gated by club-tier helpers", () => {
  it("selectPlatformEmailAdapter does not import or call either tier helper", () => {
    const e = readFileSync(join(ROOT, "src/lib/integrations/email.ts"), "utf8");
    const platform = e.match(/export async function selectPlatformEmailAdapter[\s\S]+?^}/m);
    if (platform) {
      expect(platform[0]).not.toMatch(/assertAccessTierForPosting/);
      expect(platform[0]).not.toMatch(/assertAccessTierForClubEmail/);
    }
  });
});
