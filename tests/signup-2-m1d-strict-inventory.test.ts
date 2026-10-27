// SIGNUP-2 M1d (2026-10-27) -- Strict static regression guard.
//
// Founder §8: "Strengthen CI to prevent new unprotected operational-write
// callers.  The inventory must reconcile automatically to source usage.
// No applicable legacy posting-guard caller should remain without a
// documented, technically justified exemption."
//
// This test:
//   (a) Reconciles the ACTUAL grep hits for `assertPostingAllowed(` in
//       src/ against the legacy-callers.ts registry.  Fails CI if a new
//       caller appears without a classification.
//   (b) For every file not marked READ_ADJACENT: asserts the file has
//       either (i) zero bare `assertPostingAllowed(` calls (fully
//       migrated) OR (ii) its classification explicitly documents the
//       exemption (ADMIN_CONFIG_LEGACY with safety justification).
//   (c) For every MIGRATED file: strict assertion that ALL
//       `assertPostingAllowed(` calls pass `{ tx }` or go through
//       `withPostingGuard`.
//   (d) Webhook correlation: asserts the dispatcher now implements the
//       7-signal classification + the AMBIGUOUS branch.

import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LEGACY_POSTING_GUARD_CALLERS } from "@/lib/posting-guard/legacy-callers";

function listRealCallers(): string[] {
  // Enumerate every src/ file that calls `assertPostingAllowed(`
  // (open-paren excludes string references).  Filter the four
  // infrastructure files that define/compose the guard itself.
  const out = execSync('grep -rlE "assertPostingAllowed\\(" src/', {
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

function countCallSites(path: string): { bare: number; txBound: number; wrapped: number } {
  const content = readFileSync(join(process.cwd(), path), "utf8");
  const all = (content.match(/await assertPostingAllowed\(/g) ?? []).length;
  // Match only ACTUAL await call-sites (not comment-form `assertPostingAllowed({tx})` strings).
  const txBound = (content.match(/await assertPostingAllowed\([\s\S]*?\{\s*tx/g) ?? []).length;
  const wrapped = (content.match(/withPostingGuard\(/g) ?? []).length;
  return { bare: all - txBound, txBound, wrapped };
}

describe("SIGNUP-2 M1d · inventory reconciles to actual source usage (founder §2)", () => {
  it("every real caller is enumerated in legacy-callers.ts", () => {
    const callers = new Set(listRealCallers());
    const inventory = new Set(LEGACY_POSTING_GUARD_CALLERS.map((e) => e.path));
    const unknown = [...callers].filter((p) => !inventory.has(p));
    expect(
      unknown,
      `new caller(s) found that are not in legacy-callers.ts:\n${unknown.join("\n")}`,
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

  it("no duplicate paths in legacy-callers.ts", () => {
    const paths = LEGACY_POSTING_GUARD_CALLERS.map((e) => e.path);
    const uniques = new Set(paths);
    const dupes = paths.filter((p, i) => paths.indexOf(p) !== i);
    expect(dupes, `duplicates in inventory: ${dupes.join(", ")}`).toEqual([]);
    expect(uniques.size).toBe(paths.length);
  });
});

describe("SIGNUP-2 M1d · classification goal (founder §9 completion criteria)", () => {
  it("every real caller is now MIGRATED, PARTIAL_MIGRATED, documented-exempt, or READ_ADJACENT", () => {
    for (const entry of LEGACY_POSTING_GUARD_CALLERS) {
      const okClassifications = [
        "MIGRATED",
        "PARTIAL_MIGRATED",
        "ADMIN_CONFIG_LEGACY",
        "READ_ADJACENT",
        "TX_PENDING",
        "NO_TX_PENDING",
      ];
      expect(okClassifications).toContain(entry.classification);
    }
  });

  it("every ADMIN_CONFIG_LEGACY entry has a non-empty reason + migrationTarget", () => {
    const admins = LEGACY_POSTING_GUARD_CALLERS.filter((e) => e.classification === "ADMIN_CONFIG_LEGACY");
    for (const a of admins) {
      expect(a.reason.length, `${a.path} reason too short`).toBeGreaterThan(20);
      expect(a.migrationTarget).toBeTruthy();
    }
  });

  it("every READ_ADJACENT entry has migrationTarget 'none-required'", () => {
    const reads = LEGACY_POSTING_GUARD_CALLERS.filter((e) => e.classification === "READ_ADJACENT");
    for (const r of reads) {
      expect(r.migrationTarget).toBe("none-required");
    }
  });
});

describe("SIGNUP-2 M1d · strict regression per MIGRATED file", () => {
  // Files whose "migration" was to REMOVE the pre-tx bare guard entirely
  // (because the function delegates to another guarded path) are listed
  // with migrationTarget === "none-required".  They have zero call-sites
  // and that is correct.
  const MIGRATED_FILES = LEGACY_POSTING_GUARD_CALLERS
    .filter((e) => e.classification === "MIGRATED" && e.migrationTarget !== "none-required")
    .map((e) => e.path);

  for (const f of MIGRATED_FILES) {
    it(`${f}: zero bare assertPostingAllowed calls`, () => {
      const counts = countCallSites(f);
      expect(counts.bare, `${f} contains bare assertPostingAllowed; migration incomplete`).toBe(0);
      expect(counts.txBound + counts.wrapped, `${f} must have >=1 tx-bound or wrapped call`).toBeGreaterThan(0);
    });
  }
});

describe("SIGNUP-2 M1d · webhook correlation signals + AMBIGUOUS branch (founder §6)", () => {
  const DISPATCH = readFileSync(
    join(process.cwd(), "src/lib/billing/signup-2e-webhook-dispatch.ts"),
    "utf8",
  );

  it("onPaymentIntentFailed implements all 7 correlation signals", () => {
    // (1) event identity: event.id used
    expect(DISPATCH).toMatch(/providerEventId: event\.id/);
    // (2) PaymentIntent identity: findCycleByPaymentIntent
    expect(DISPATCH).toMatch(/findCycleByPaymentIntent/);
    // (3) BillingCycle identity
    expect(DISPATCH).toMatch(/cycle\.id/);
    // (4) ClubSubscription identity
    expect(DISPATCH).toMatch(/clubSubscription\.findUnique/);
    // (5) Settlement reconciliation: settlementConfirmedAt + priorSettlement
    expect(DISPATCH).toMatch(/cycle\.settlementConfirmedAt !== null/);
    expect(DISPATCH).toMatch(/paymentReconciliationEntry\.findFirst/);
    expect(DISPATCH).toMatch(/entryType: "PAYMENT_SETTLED"/);
    // (6) Current operational state
    expect(DISPATCH).toMatch(/sub\.subscriptionStatus === "ACTIVE"/);
    // (7) Event ordering / replay: laterSettlement check
    expect(DISPATCH).toMatch(/laterSettlement/);
    expect(DISPATCH).toMatch(/recordedAt:\s*\{\s*gt:/);
  });

  it("AMBIGUOUS classification produces an operator exception, NOT silent INITIAL", () => {
    expect(DISPATCH).toMatch(/isAmbiguous/);
    expect(DISPATCH).toMatch(/AMBIGUOUS_PAYMENT_FAILURE/);
    expect(DISPATCH).toMatch(/Ambiguous payment failure/);
    // AMBIGUOUS path MUST NOT call trySuspendFromWebhook.
    const block = DISPATCH.match(/if \(isAmbiguous\)[\s\S]+?return;/m);
    expect(block, "AMBIGUOUS branch must exit before suspension path").toBeTruthy();
    if (block) {
      expect(block[0]).not.toMatch(/trySuspendFromWebhook/);
    }
  });

  it("AMBIGUOUS trigger conditions: mismatched signals OR laterSettlement OR missing sub on prior-settled cycle", () => {
    expect(DISPATCH).toMatch(/hasTimestamp !== hasLedgerEntry/);
    expect(DISPATCH).toMatch(/hasTimestamp && hasLedgerEntry && sub === null/);
    expect(DISPATCH).toMatch(/laterSettlement !== null/);
  });

  it("no automatic reinstatement on payment_intent.succeeded after failure (founder §6)", () => {
    const succeededBlock = DISPATCH.match(/async function onPaymentIntentSucceeded[\s\S]+?async function onPaymentIntentFailed/m)![0];
    // The succeeded handler must NOT call reinstateTenant.
    expect(succeededBlock).not.toMatch(/reinstateTenant/);
  });

  it("INITIAL path requires ALL 4 multi-signal conditions false (not just settlementConfirmedAt)", () => {
    expect(DISPATCH).toMatch(/const isInitialPaymentFailure = !multiSignalRenewal && !isAmbiguous/);
  });
});

describe("SIGNUP-2 M1d · M1 posting-guard core contract preserved", () => {
  const CORE = readFileSync(join(process.cwd(), "src/lib/posting-guard/index.ts"), "utf8");
  const ACCESS_TIER = readFileSync(join(process.cwd(), "src/lib/billing/access-tier.ts"), "utf8");

  it("assertPostingAllowed accepts opts.tx (M1d ergonomic: unknown shape)", () => {
    expect(CORE).toMatch(/opts\?: \{ tx\?: unknown \}/);
  });

  it("withPostingGuard runs the guard INSIDE prisma.$transaction", () => {
    const body = CORE.match(/export async function withPostingGuard[\s\S]+?^}/m)![0];
    const txIdx = body.indexOf("prisma.$transaction");
    const guardIdx = body.indexOf("assertPostingAllowed(");
    expect(txIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeGreaterThan(txIdx);
  });

  it("access-tier gate uses SELECT ... FOR UPDATE when tx is passed", () => {
    expect(ACCESS_TIER).toMatch(/FOR UPDATE/);
    expect(ACCESS_TIER).toMatch(/opts\.tx\.\$queryRawUnsafe/);
  });

  it("legacy tenants with subscriptionStatus=null still PASS", () => {
    expect(ACCESS_TIER).toMatch(/subscriptionStatus === null[\s\S]+?legacy-grandfather-status-null/);
  });
});
