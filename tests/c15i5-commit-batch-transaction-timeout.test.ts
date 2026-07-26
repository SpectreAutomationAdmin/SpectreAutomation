// Sprint 3 · Checkpoint 15I-5 — source-contract lock for the
// commit-batch transaction timeout fix.
//
// Root incident: 2026-07-26T21:02:07Z, Coulee Ridge staging.
// Founder clicked "Complete import" on a 237-account COA batch.
// Server returned an application error with digest 3147618077.
// Fly logs identified Prisma P2028 — "Transaction not found.
// Transaction ID is invalid, refers to an old closed transaction"
// — thrown from commitCoaBatchAsReplacement's importRow.update
// call after the 5-second default Prisma $transaction timeout
// expired mid-loop. Postgres rolled the whole transaction back
// cleanly (0 Account rows, 0 AccountDepartment rows), but the
// batch could not commit.
//
// Fix: pass an explicit `{ timeout: 120_000, maxWait: 30_000 }`
// options bag to the two long-running $transaction calls
// (commitCoaBatchAsReplacement + the TB commit path). Both loops
// do N × several DB round-trips and can exceed 5s on Neon.
//
// This test locks the options are wired so a future refactor
// can't silently drop them and regress into the same P2028.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const IMPORTS = readFileSync(join(process.cwd(), "src/lib/imports/index.ts"), "utf8");

describe("15I-5 — long-running $transaction calls must set an explicit timeout", () => {
  it("commitCoaBatchAsReplacement passes { timeout, maxWait } to $transaction", () => {
    const start = IMPORTS.indexOf("async function commitCoaBatchAsReplacement");
    expect(start).toBeGreaterThan(0);
    const end = IMPORTS.indexOf("\nasync function commitDomainRow", start);
    expect(end).toBeGreaterThan(start);
    const region = IMPORTS.slice(start, end);
    expect(region).toMatch(/timeout:\s*120_000/);
    expect(region).toMatch(/maxWait:\s*30_000/);
  });

  it("the TB commit $transaction (in commitBatch) also sets explicit timeout options", () => {
    // The TB path is the same shape: N ImportRow updates in a loop
    // inside a single $transaction. It hasn't hit the founder yet
    // because staging TB imports are smaller, but the exact bug
    // exists there too. Fixed in lockstep with the COA path.
    const start = IMPORTS.indexOf("const tbCommit = await prisma.$transaction(async (tx) =>");
    expect(start).toBeGreaterThan(0);
    // The outer $transaction's second argument sits AFTER the
    // callback closer. Look forward until the "// Other domains"
    // marker that begins the next branch (guaranteed comment
    // present in the file below the TB block).
    const end = IMPORTS.indexOf("// ── Other domains", start);
    expect(end).toBeGreaterThan(start);
    const region = IMPORTS.slice(start, end);
    expect(region).toMatch(/timeout:\s*120_000/);
    expect(region).toMatch(/maxWait:\s*30_000/);
  });

  it("the fast, non-loop $transaction call in createBatch is unchanged (no timeout needed)", () => {
    // createBatch at line ~86 does exactly two DB operations
    // (importBatch.create + importRow.createMany) — comfortably
    // inside 5s even for 10 000 rows. This test locks that we
    // did NOT scatter timeout options into every $transaction
    // reflexively; only the loops that actually need it.
    const start = IMPORTS.indexOf("export async function createBatch(principal:");
    expect(start).toBeGreaterThan(0);
    const end = IMPORTS.indexOf("\n// ---", start);
    expect(end).toBeGreaterThan(start);
    const region = IMPORTS.slice(start, end);
    // Should still have $transaction but no timeout options.
    expect(region).toMatch(/prisma\.\$transaction\(async \(tx\) =>/);
    expect(region).not.toMatch(/timeout:\s*\d/);
  });

  it("the diagnostic comment for the 15I-5 fix is present so future readers understand the WHY", () => {
    expect(IMPORTS).toMatch(/Sprint 3 · Checkpoint 15I-5/);
    expect(IMPORTS).toMatch(/P2028/);
    expect(IMPORTS).toMatch(/digest 3147618077/);
  });
});
