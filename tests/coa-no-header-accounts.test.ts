// Founder rule 2026-07-08: no header accounts in the COA.
//
// Covers:
//   1. The default seed template no longer marks any account as a
//      header (isHeader=true is gone from DEFAULT_ACCOUNTS).
//   2. The COA importer's commit path never sets isHeader=true,
//      regardless of input.
//   3. The new-account UI form drops the "Header" checkbox and
//      hard-codes isHeader=false in its server action.
//   4. The Finance → Chart of Accounts page renders no "Header"
//      badge and groups by Type → Category → FS Group.
//   5. The clearLegacyHeaderFlags() helper flips every existing
//      isHeader=true row into a posting account (isHeader=false,
//      allowManualPosting=true), idempotently, scoped to the
//      given clubId.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";

import { db, makeUser, principalFor, resetDb, seedRbac } from "./util/db";
import { bootstrapAPClub } from "./util/ap";

import { clearLegacyHeaderFlags } from "@/lib/accounting/coa";
import { DEFAULT_ACCOUNTS } from "@/lib/accounting/coa-template";

beforeAll(async () => {
  await seedRbac();
});

beforeEach(async () => {
  await resetDb();
  await seedRbac();
});

describe("Founder rule: no header accounts in the default seed", () => {
  it("DEFAULT_ACCOUNTS contains zero entries with isHeader=true", () => {
    const headers = DEFAULT_ACCOUNTS.filter((a) => a.isHeader === true);
    expect(headers).toEqual([]);
  });

  it("DEFAULT_ACCOUNTS still includes the previously-header names as posting accounts", () => {
    // Each of these names existed as a header in the legacy
    // template; the founder kept the numbers + names and just
    // wants them to post normally.
    const names = DEFAULT_ACCOUNTS.map((a) => a.name);
    expect(names).toContain("Cash & Bank");
    expect(names).toContain("Accounts Receivable");
    expect(names).toContain("Inventory");
    expect(names).toContain("Accounts Payable");
    expect(names).toContain("Property & Equipment");
  });
});

describe("Source-contract: importer + UI never set isHeader=true", () => {
  it("commit code in src/lib/imports/index.ts never writes isHeader=true on the COA branch", () => {
    const src = fs.readFileSync(
      path.resolve(process.cwd(), "src/lib/imports/index.ts"),
      "utf8",
    );
    // The COA commit branch upserts Account rows with explicit
    // field assignments; isHeader is intentionally absent. (The
    // schema default is false.) If anyone re-introduces it, the
    // assertion below catches the regression.
    const coaSection = src.split("if (domain === \"COA\")")[1] ?? "";
    expect(coaSection).not.toMatch(/isHeader:\s*true/);
    const replaceFn = src.split("commitCoaBatchAsReplacement")[1] ?? "";
    expect(replaceFn).not.toMatch(/isHeader:\s*true/);
  });

  it("the new-account form action hard-codes isHeader=false", () => {
    const src = fs.readFileSync(
      path.resolve(process.cwd(), "src/app/app/admin/coa/new/page.tsx"),
      "utf8",
    );
    expect(src).toMatch(/isHeader:\s*false/);
    // The form no longer renders the Header checkbox.
    expect(src).not.toMatch(/name="isHeader"/);
    expect(src).not.toContain("Header (no posting)");
  });
});

describe("Source-contract: Finance / Chart of Accounts page", () => {
  const COA_PAGE = fs.readFileSync(
    path.resolve(process.cwd(), "src/app/app/admin/coa/page.tsx"),
    "utf8",
  );
  // Data Workspace Foundation v1.0 (2026-07-18) — the grouped
  // table rendering moved into the client component; source
  // contracts about the grouping shape are proved against both
  // files.
  const COA_CLIENT = fs.readFileSync(
    path.resolve(process.cwd(), "src/components/data-workspace/ChartOfAccountsClient.tsx"),
    "utf8",
  );
  const COA_RENDERED = COA_PAGE + "\n// ---- rendered-source separator ----\n" + COA_CLIENT;

  it("renders no 'Header' badge anywhere on the page", () => {
    expect(COA_RENDERED).not.toContain(">Header<");
    expect(COA_RENDERED).not.toMatch(/badge.*Header/);
  });

  it("groups dynamically by Type → Category → FS Group using account metadata", () => {
    // The workspace groups by Type at the tbody level and by
    // Category · FS Group at the sub-header level. The Category
    // + FS Group tier is combined into one label row per the
    // approved concept (fewer ornamental headings between small
    // numbers of rows), so the fsgroup testid family carries the
    // category key too — proving both metadata sources still
    // drive the layout.
    expect(COA_RENDERED).toMatch(/coa-type-\$\{type\}/);
    expect(COA_RENDERED).toMatch(/coa-fsgroup-\$\{type\}-\$\{catKey\}-\$\{fsg\.key\}/);
    expect(COA_RENDERED).toMatch(/coa-fsgroup-label-\$\{fsg\.key\}/);
  });

  it("never branches the row layout on isHeader", () => {
    expect(COA_RENDERED).not.toMatch(/a\.isHeader/);
    expect(COA_RENDERED).not.toMatch(/isHeader \?/);
  });
});

describe("clearLegacyHeaderFlags helper", () => {
  it("flips every isHeader=true row to a posting account on the given club", async () => {
    const c = await bootstrapAPClub("Headers-Cleanup-Test");
    // Manually mark 3 accounts as legacy headers so we have
    // something to clean up. Disable manual posting on them so
    // we can prove the flag flips back on.
    const targets = await db().account.findMany({
      where: { clubId: c.id, isActive: true },
      take: 3,
    });
    for (const a of targets) {
      await db().account.update({
        where: { id: a.id },
        data: { isHeader: true, allowManualPosting: false },
      });
    }
    const beforeHeaders = await db().account.count({
      where: { clubId: c.id, isHeader: true },
    });
    expect(beforeHeaders).toBe(3);

    const converted = await clearLegacyHeaderFlags(c.id);
    expect(converted).toBe(3);

    const afterHeaders = await db().account.count({
      where: { clubId: c.id, isHeader: true },
    });
    expect(afterHeaders).toBe(0);
    for (const a of targets) {
      const reloaded = await db().account.findUnique({ where: { id: a.id } });
      expect(reloaded?.isHeader).toBe(false);
      expect(reloaded?.allowManualPosting).toBe(true);
      // Account row itself survives (FK references intact).
      expect(reloaded?.id).toBe(a.id);
    }
  });

  it("is idempotent — a second call on an already-clean club converts zero rows", async () => {
    const c = await bootstrapAPClub("Headers-Idempotent-Test");
    await clearLegacyHeaderFlags(c.id);
    const second = await clearLegacyHeaderFlags(c.id);
    expect(second).toBe(0);
  });

  it("is tenant-scoped — does not touch accounts in another club", async () => {
    const a = await bootstrapAPClub("Tenant-A");
    const b = await bootstrapAPClub("Tenant-B");
    // Manually flag one account in B as a header.
    const targetB = await db().account.findFirst({ where: { clubId: b.id, isActive: true } });
    if (!targetB) throw new Error("no seed account in B");
    await db().account.update({
      where: { id: targetB.id },
      data: { isHeader: true, allowManualPosting: false },
    });
    const converted = await clearLegacyHeaderFlags(a.id);
    expect(converted).toBe(0);
    const reloadedB = await db().account.findUnique({ where: { id: targetB.id } });
    expect(reloadedB?.isHeader).toBe(true);
  });
});

describe("End-to-end: seeded clubs have zero header accounts after bootstrap", () => {
  it("a fresh club seeded via bootstrapAPClub has no isHeader=true rows", async () => {
    const c = await bootstrapAPClub("Fresh-Bootstrap-Test");
    const count = await db().account.count({ where: { clubId: c.id, isHeader: true } });
    expect(count).toBe(0);
  });
});
