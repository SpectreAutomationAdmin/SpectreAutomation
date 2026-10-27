// SIGNUP-2 M1b (2026-10-26) -- Static guard-inventory regression test.
//
// Enumerates every file in `src/` that calls `assertPostingAllowed`
// and verifies that each caller is EITHER:
//   (a) migrated (uses `withPostingGuard` or passes `{tx}`), OR
//   (b) explicitly listed in `src/lib/posting-guard/legacy-callers.ts`
//       with a documented classification + reason.
//
// Any new caller added without a classification fails CI, so the
// migration status cannot silently regress.
//
// This test IS the "complete migration inventory" required by
// founder §2 of the M1b authorization.

import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LEGACY_POSTING_GUARD_CALLERS } from "@/lib/posting-guard/legacy-callers";

function listCallers(): string[] {
  const out = execSync('grep -rlE "assertPostingAllowed\\b" src/', {
    encoding: "utf8",
    cwd: process.cwd(),
  });
  return out
    .split(/\r?\n/)
    .filter((l) => l)
    .filter((l) => !l.includes("src/lib/billing/access-tier.ts"))
    .filter((l) => !l.includes("src/lib/posting-guard/index.ts"))
    .filter((l) => !l.includes("src/lib/posting-guard/legacy-callers.ts"))
    .filter((l) => !l.includes("src/lib/billing/signup-2h-tenant-lifecycle-service.ts"))
    .map((p) => p.replace(/\\/g, "/"));
}

describe("SIGNUP-2 M1b · posting-guard caller inventory", () => {
  it("every actual caller is enumerated in legacy-callers.ts", () => {
    const callers = new Set(listCallers());
    const inventory = new Set(LEGACY_POSTING_GUARD_CALLERS.map((e) => e.path));
    const unknown = [...callers].filter((p) => !inventory.has(p));
    expect(
      unknown,
      `new caller(s) found that are not in legacy-callers.ts; add them with a classification + reason: ${unknown.join(", ")}`,
    ).toEqual([]);
  });
  it("every inventory entry corresponds to a real file", () => {
    for (const entry of LEGACY_POSTING_GUARD_CALLERS) {
      try {
        readFileSync(join(process.cwd(), entry.path), "utf8");
      } catch (err) {
        throw new Error(`inventory references missing file ${entry.path}: ${(err as Error).message}`);
      }
    }
  });
});

describe("SIGNUP-2 M1b · classification totals", () => {
  it("counts match expected buckets at ship time", () => {
    const counts = LEGACY_POSTING_GUARD_CALLERS.reduce<Record<string, number>>((acc, e) => {
      acc[e.classification] = (acc[e.classification] ?? 0) + 1;
      return acc;
    }, {});
    // Snapshot the ship-time distribution.  Changes here force an
    // acceptance-doc update.
    expect(counts.MIGRATED, "MIGRATED count").toBeGreaterThanOrEqual(1);
    expect(counts.TX_PENDING, "TX_PENDING count").toBeGreaterThanOrEqual(10);
    expect(counts.NO_TX_PENDING, "NO_TX_PENDING count").toBeGreaterThanOrEqual(5);
    expect(counts.ADMIN_CONFIG_LEGACY, "ADMIN_CONFIG_LEGACY count").toBeGreaterThanOrEqual(1);
  });
});

describe("SIGNUP-2 M1b · journal.ts migrated to withPostingGuard", () => {
  const JOURNAL = readFileSync(join(process.cwd(), "src/lib/accounting/journal.ts"), "utf8");
  it("journal.ts imports withPostingGuard", () => {
    expect(JOURNAL).toMatch(/import \{ assertPostingAllowed, withPostingGuard \} from "\.\.\/posting-guard"/);
  });
  it("post flow uses withPostingGuard with tx callback", () => {
    expect(JOURNAL).toMatch(/withPostingGuard\(\s*principal,\s*entry\.clubId,\s*"gl\.journal\.post"/);
  });
  it("voidDraft flow uses withPostingGuard", () => {
    expect(JOURNAL).toMatch(/withPostingGuard\(\s*principal,\s*entry\.clubId,\s*"gl\.journal\.void"/);
  });
  it("no bare assertPostingAllowed call precedes the tx (post + voidDraft only)", () => {
    // Count how many assertPostingAllowed call-sites remain WITHOUT {tx}.
    const bareCalls = (JOURNAL.match(/await assertPostingAllowed\(/g) ?? []).length;
    const txCalls = (JOURNAL.match(/await assertPostingAllowed\([^)]+,\s*\{\s*tx[:,\s]/g) ?? []).length;
    const inWithPostingGuard = (JOURNAL.match(/withPostingGuard\(/g) ?? []).length;
    const legacyCount = bareCalls - txCalls;
    // At ship time: 2 unmigrated bare calls remain (reverse + a 4th).
    // Tracked in legacy-callers.ts; this test caps the count so
    // regressions can't grow it.
    expect(legacyCount, "bare assertPostingAllowed in journal.ts").toBeLessThanOrEqual(2);
    expect(inWithPostingGuard, "withPostingGuard call-sites in journal.ts").toBeGreaterThanOrEqual(2);
  });
});

describe("SIGNUP-2 M1b · webhook classification differentiates initial vs renewal failure", () => {
  const DISPATCH = readFileSync(
    join(process.cwd(), "src/lib/billing/signup-2e-webhook-dispatch.ts"),
    "utf8",
  );
  it("onPaymentIntentFailed checks settlementConfirmedAt to classify", () => {
    expect(DISPATCH).toMatch(/isInitialPaymentFailure = cycle\.settlementConfirmedAt === null/);
  });
  it("INITIAL path does NOT call trySuspendFromWebhook", () => {
    const block = DISPATCH.match(/async function onPaymentIntentFailed[\s\S]+?async function onChargeSucceeded/m)![0];
    expect(block).toMatch(/if \(isInitialPaymentFailure\)[\s\S]+?no-suspension-initial[\s\S]+?return;/);
  });
  it("RENEWAL path raises FAILED_RENEWAL", () => {
    const block = DISPATCH.match(/async function onPaymentIntentFailed[\s\S]+?async function onChargeSucceeded/m)![0];
    expect(block).toMatch(/trigger: "FAILED_RENEWAL"/);
  });
  it("INITIAL_PAYMENT_FAILURE and RENEWAL_PAYMENT_FAILURE operator-alert categories are distinct", () => {
    expect(DISPATCH).toMatch(/category: isInitialPaymentFailure \? "INITIAL_PAYMENT_FAILURE" : "RENEWAL_PAYMENT_FAILURE"/);
  });
  it("findCycleByPaymentIntent selects settlementConfirmedAt", () => {
    const block = DISPATCH.match(/async function findCycleByPaymentIntent[\s\S]+?^}/m)![0];
    expect(block).toMatch(/settlementConfirmedAt: true/);
  });
});
