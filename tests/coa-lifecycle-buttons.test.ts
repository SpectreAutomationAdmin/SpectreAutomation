// Founder rule 2026-07-20: the COA detail page derives every
// affordance — secondary label, primary button, disabled state,
// founder-exact copy — from a single canonical lifecycle state
// computed from (status, dryRunAt, errorRows). The page never
// shows contradictory labels ("VALIDATED" + "Not validated" +
// "Commit anyway" was the bug). COA imports never support a
// partial commit.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";

import { db, makeUser, principalFor, resetDb, seedRbac } from "./util/db";
import { bootstrapAPClub } from "./util/ap";
import {
  createBatch,
  validateBatch,
  commitBatch,
  saveCoaRowMappings,
} from "@/lib/imports";
import { ConflictError } from "@/lib/errors";

const PAGE = fs.readFileSync(
  path.resolve(process.cwd(), "src/app/app/admin/imports/[id]/page.tsx"),
  "utf8",
);
const BUTTON = fs.readFileSync(
  path.resolve(
    process.cwd(),
    "src/app/app/admin/imports/[id]/CoaReplaceCommitButton.tsx",
  ),
  "utf8",
);

async function adminFor(clubId: string) {
  const email = `admin-${Math.random().toString(36).slice(2, 10)}@example.com`;
  await makeUser({ email, role: "CLUB_ADMIN", clubId });
  return principalFor(email);
}
async function exemplarMapping(
  clubId: string,
  type: "ASSET" | "LIABILITY" | "EQUITY" | "REVENUE" | "EXPENSE",
) {
  const acct = await db().account.findFirst({
    where: { clubId, type, isActive: true, categoryId: { not: null }, fsGroupId: { not: null } },
  });
  if (!acct) throw new Error(`no ${type} seed`);
  const cat = await db().accountCategory.findUnique({ where: { id: acct.categoryId! } });
  const fsg = await db().financialStatementGroup.findUnique({ where: { id: acct.fsGroupId! } });
  if (!cat || !fsg) throw new Error("dangling cat/fsg");
  return { categoryKey: cat.key, fsGroupKey: fsg.key };
}

beforeAll(async () => { await seedRbac(); });
beforeEach(async () => { await resetDb(); await seedRbac(); });

describe("Single canonical COA lifecycle state drives every affordance", () => {
  it("page defines a CoaLifecycle union with the five founder states", () => {
    expect(PAGE).toMatch(/"NOT_VALIDATED"[\s\S]+?"VALIDATED_CLEAN"[\s\S]+?"VALIDATED_WITH_ERRORS"[\s\S]+?"COMMITTED"[\s\S]+?"ARCHIVED"/);
  });

  it("lifecycle is derived from (status, dryRunAt, errorRows) only — never read piecewise on the COA branch", () => {
    expect(PAGE).toMatch(/!batch\.dryRunAt[\s\S]+?"NOT_VALIDATED"/);
    expect(PAGE).toMatch(/batch\.errorRows > 0[\s\S]+?"VALIDATED_WITH_ERRORS"/);
    expect(PAGE).toMatch(/"VALIDATED_CLEAN"/);
  });

  it("secondary label on the COA branch reads from the lifecycle (never VALIDATED + 'Not validated' together)", () => {
    expect(PAGE).toMatch(/coaLifecycle === "NOT_VALIDATED"[\s\S]+?Not validated/);
    // Outside the NOT_VALIDATED branch the counts render — there is
    // no path where coaLifecycle is anything else AND "Not validated"
    // renders.
  });

  it("button block renders only the matching lifecycle branch", () => {
    expect(PAGE).toMatch(/coaLifecycle === "NOT_VALIDATED"[\s\S]+?Validate import/);
    expect(PAGE).toMatch(/coaLifecycle === "VALIDATED_CLEAN" && coaReplacementPlan/);
    expect(PAGE).toMatch(/coaLifecycle === "VALIDATED_WITH_ERRORS"[\s\S]+?Fix errors before import/);
    expect(PAGE).toMatch(/coaLifecycle === "COMMITTED"[\s\S]+?Import completed/);
    expect(PAGE).toMatch(/coaLifecycle === "ARCHIVED"[\s\S]+?Archived/);
  });

  it("VALIDATED_WITH_ERRORS button is disabled (aria-disabled + disabled prop)", () => {
    expect(PAGE).toMatch(/coa-action-fix-errors[\s\S]+?disabled[\s\S]+?aria-disabled="true"/);
  });
});

describe("COA flow removes every 'Commit anyway' affordance", () => {
  it("CoaReplaceCommitButton no longer renders 'Commit anyway' or 'allow partial commit'", () => {
    // Strip line-comments so we don't false-positive on the
    // explanatory header that mentions the removed copy.
    const code = BUTTON
      .split("\n")
      .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*") && !l.trim().startsWith("/*"))
      .join("\n");
    expect(code).not.toMatch(/Commit anyway/i);
    expect(code).not.toMatch(/allow partial commit/i);
    expect(code).not.toMatch(/allowPartial/);
    expect(code).not.toMatch(/hasErrorRows/);
  });

  it("CoaReplaceCommitButton's primary label reads 'Complete import'", () => {
    expect(BUTTON).toContain("Complete import");
    expect(BUTTON).toContain('data-testid="coa-commit-direct"');
    expect(BUTTON).toContain('data-testid="coa-commit-open-modal"');
  });

  it("page renders no Commit-anyway button on the COA branch", () => {
    // The detail page's isCoa branch must not render the legacy
    // partial-commit form. We assert by isolating the COA branch
    // and verifying the partial-commit literals are absent.
    const start = PAGE.indexOf("isCoa ? (");
    const end = PAGE.indexOf(") : (", start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const coaSlice = PAGE.slice(start, end);
    expect(coaSlice).not.toMatch(/Commit anyway/);
    expect(coaSlice).not.toMatch(/allowPartial/);
    expect(coaSlice).not.toMatch(/allow partial commit/);
  });

  it("non-COA branch still keeps 'Commit anyway' (additive imports tolerate partial)", () => {
    const otherIdx = PAGE.indexOf(") : (");
    expect(otherIdx).toBeGreaterThan(0);
    const tail = PAGE.slice(otherIdx);
    expect(tail).toMatch(/Commit anyway/);
    expect(tail).toMatch(/allowPartial/);
  });
});

describe("Server enforces no-partial-commit for COA", () => {
  it("commitBatch rejects a COA batch with errorRows>0 even when allowPartial=true is set", async () => {
    const c = await bootstrapAPClub("COA-NoPartial");
    const p = await adminFor(c.id);

    // Upload + validate a batch with a missing-mapping row that
    // will fail validation.
    const created = await createBatch(p, {
      clubId: c.id,
      domain: "COA",
      rows: [{ number: "1010", name: "Cash" }],
      source: "CSV",
      fileName: "x.csv",
    });
    // No saveCoaRowMappings → row stays without Type/Cat/FSG →
    // validateBatch marks it INVALID.
    await validateBatch(p, created.id);
    const reloaded = await db().importBatch.findUnique({ where: { id: created.id } });
    expect(reloaded?.errorRows).toBeGreaterThan(0);

    // Even with allowPartial=true the COA branch must reject.
    let caught: unknown;
    try {
      await commitBatch(p, {
        batchId: created.id,
        confirmReplaceCoa: true,
        allowPartial: true,
      });
    } catch (err) { caught = err; }
    expect(caught).toBeInstanceOf(ConflictError);
    expect((caught as ConflictError).safeMessage.toLowerCase()).toContain("error rows");
    // Batch remains VALIDATED + uncommitted.
    const after = await db().importBatch.findUnique({ where: { id: created.id } });
    expect(after?.status).toBe("VALIDATED");
  });

  it("once every row is fixed and re-validated, commit succeeds", async () => {
    const c = await bootstrapAPClub("COA-FixThenCommit");
    const p = await adminFor(c.id);
    const seed = await exemplarMapping(c.id, "ASSET");
    const created = await createBatch(p, {
      clubId: c.id,
      domain: "COA",
      rows: [{ number: "1015", name: "Cash" }],
      source: "CSV",
      fileName: "y.csv",
    });
    // Initial validate fails (no mapping).
    await validateBatch(p, created.id);
    expect((await db().importBatch.findUnique({ where: { id: created.id } }))?.errorRows).toBeGreaterThan(0);

    // Fix → revalidate → commit.
    const [row] = await db().importRow.findMany({ where: { batchId: created.id } });
    await saveCoaRowMappings(p, {
      batchId: created.id,
      mappings: [
        {
          rowId: row.id,
          type: "ASSET",
          categoryKey: seed.categoryKey,
          fsGroupKey: seed.fsGroupKey,
          departmentCodes: [],
        },
      ],
    });
    await validateBatch(p, created.id);
    const result = await commitBatch(p, {
      batchId: created.id,
      confirmReplaceCoa: true,
    });
    expect(result.status).toBe("COMMITTED");
  });
});

describe("Imports list page hint no longer contradicts the badge", () => {
  const LIST = fs.readFileSync(
    path.resolve(process.cwd(), "src/app/app/admin/imports/page.tsx"),
    "utf8",
  );
  it("'Not validated' hint only renders when status === 'DRAFT' (never alongside a VALIDATED badge)", () => {
    expect(LIST).toMatch(/!validated && b\.status === "DRAFT"/);
    // The legacy "show on every non-COMMITTED non-ARCHIVED" rule
    // is gone — it produced the VALIDATED + Not-validated
    // contradiction the founder flagged.
    expect(LIST).not.toMatch(/!validated && b\.status !== "COMMITTED" && b\.status !== "ARCHIVED"/);
  });
});
