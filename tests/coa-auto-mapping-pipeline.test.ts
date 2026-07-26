// applyCoaAutoMapping pipeline + UI contract tests for the
// intelligent COA auto-mapping engine (founder rule 2026-06-29).
//
// Behavioural: applyCoaAutoMapping populates mappings + writes
// _prediction metadata. Source-contract: the page + table read
// confidence + render the indicators.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";

import { db, makeUser, principalFor, resetDb, seedRbac } from "./util/db";
import { bootstrapAPClub } from "./util/ap";
import {
  createBatch,
  validateBatch,
  applyCoaAutoMapping,
  detectCoaDuplicates,
  normaliseAccountName,
} from "@/lib/imports";

async function adminFor(clubId: string) {
  const email = `admin-${Math.random().toString(36).slice(2, 10)}@example.com`;
  await makeUser({ email, role: "CLUB_ADMIN", clubId });
  return principalFor(email);
}

beforeAll(async () => { await seedRbac(); });
beforeEach(async () => { await resetDb(); await seedRbac(); });

describe("applyCoaAutoMapping — pipeline behavior", () => {
  it("predicts every row from name keywords + persists confidence/source in _prediction", async () => {
    const c = await bootstrapAPClub("AutoMap-Keyword");
    const p = await adminFor(c.id);
    const created = await createBatch(p, {
      clubId: c.id,
      domain: "COA",
      rows: [
        { number: "9000", name: "Petty Cash" },
        { number: "9001", name: "Accounts Payable" },
        { number: "9002", name: "Membership Dues" },
        { number: "9003", name: "Depreciation Expense" },
      ],
      source: "CSV",
      fileName: "automap.csv",
    });
    const result = await applyCoaAutoMapping(p, created.id);
    expect(result.predicted).toBe(4);
    expect(result.high).toBe(4);
    expect(result.medium).toBe(0);
    expect(result.low).toBe(0);

    const rows = await db().importRow.findMany({
      where: { batchId: created.id },
      orderBy: { rowNumber: "asc" },
    });
    for (const r of rows) {
      const raw = JSON.parse(String(r.rawJson));
      expect(raw._prediction).toBeTruthy();
      expect(raw._prediction.confidence).toBe("high");
      expect(raw._prediction.source).toBe("name-keyword");
      // Mapping was saved through — type/category/fsGroup land in raw.
      expect(raw.type).toBeTruthy();
      expect(raw.categoryKey).toBeTruthy();
      expect(raw.fsGroupKey).toBeTruthy();
    }
  });

  it("an existing-account match takes precedence over the keyword rule (the 'learning' path)", async () => {
    const c = await bootstrapAPClub("AutoMap-Learning");
    const p = await adminFor(c.id);
    // Seed an existing account at number 9050 with a deliberately
    // odd category to prove the predictor inherits it.
    const cat = await db().accountCategory.findFirst({
      where: { clubId: c.id, key: "OTHER_REVENUE" },
    });
    // Use IS_INTEREST_INCOME — a SPECIFIC FS Group, not a
    // generic "Other ..." bucket. Founder rule 2026-06-29
    // refinement: keyword only overrides existing when existing
    // is generic. A specific existing mapping wins so the
    // operator's prior decisions are preserved across imports.
    const fsg = await db().financialStatementGroup.findFirst({
      where: { clubId: c.id, key: "IS_INTEREST_INCOME" },
    });
    await db().account.create({
      data: {
        clubId: c.id,
        accountNumber: "9050",
        name: "Strange Existing Account",
        type: "REVENUE",
        normalBalance: "CREDIT",
        categoryId: cat!.id,
        fsGroupId: fsg!.id,
      },
    });
    const created = await createBatch(p, {
      clubId: c.id,
      domain: "COA",
      rows: [{ number: "9050", name: "Operating Bank Account" }],
      source: "CSV",
      fileName: "x.csv",
    });
    await applyCoaAutoMapping(p, created.id);
    const [row] = await db().importRow.findMany({ where: { batchId: created.id } });
    const raw = JSON.parse(String(row.rawJson));
    // Despite the name screaming "Petty Cash" / "BS_CASH_EQUIVALENTS",
    // we INHERITED the existing SPECIFIC mapping. (If existing
    // had been a generic Other bucket, the keyword would win —
    // see the engine's "Generic-override" tests for that case.)
    expect(raw._prediction.source).toBe("existing-account");
    expect(raw.fsGroupKey).toBe("IS_INTEREST_INCOME");
    expect(raw.categoryKey).toBe("OTHER_REVENUE");
    expect(raw.type).toBe("REVENUE");
  });

  it("number-range fallback yields medium confidence for rows with no keyword match", async () => {
    const c = await bootstrapAPClub("AutoMap-Range");
    const p = await adminFor(c.id);
    const created = await createBatch(p, {
      clubId: c.id,
      domain: "COA",
      rows: [
        { number: "1599", name: "ZZZ Unknown Asset" },
        { number: "2899", name: "ZZZ Unknown Liability" },
      ],
      source: "CSV",
      fileName: "y.csv",
    });
    const result = await applyCoaAutoMapping(p, created.id);
    expect(result.medium).toBe(2);
    const rows = await db().importRow.findMany({
      where: { batchId: created.id },
      orderBy: { rowNumber: "asc" },
    });
    for (const r of rows) {
      const raw = JSON.parse(String(r.rawJson));
      expect(raw._prediction.confidence).toBe("medium");
      expect(raw._prediction.source).toBe("number-range");
    }
  });

  it("validateBatch after applyCoaAutoMapping marks every predicted row VALID (clean upload)", async () => {
    const c = await bootstrapAPClub("AutoMap-Validate");
    const p = await adminFor(c.id);
    const created = await createBatch(p, {
      clubId: c.id,
      domain: "COA",
      rows: [
        { number: "1000", name: "Petty Cash" },
        { number: "2000", name: "Accounts Payable" },
        { number: "4000", name: "Membership Dues" },
        { number: "6000", name: "Salaries & Wages" },
      ],
      source: "CSV",
      fileName: "z.csv",
    });
    await applyCoaAutoMapping(p, created.id);
    await validateBatch(p, created.id);
    const after = await db().importBatch.findUnique({ where: { id: created.id } });
    expect(after?.totalRows).toBe(4);
    expect(after?.validRows).toBe(4);
    expect(after?.errorRows).toBe(0);
  });

  it("writes an import.coa.auto-map audit row with the confidence counts", async () => {
    const c = await bootstrapAPClub("AutoMap-Audit");
    const p = await adminFor(c.id);
    const created = await createBatch(p, {
      clubId: c.id,
      domain: "COA",
      rows: [{ number: "1000", name: "Petty Cash" }],
      source: "CSV",
      fileName: "a.csv",
    });
    await applyCoaAutoMapping(p, created.id);
    const audits = await db().auditLog.findMany({
      where: { clubId: c.id, entityId: created.id, action: "import.coa.auto-map" },
    });
    expect(audits.length).toBe(1);
    const after = JSON.parse(String(audits[0].afterJson ?? "{}"));
    expect(after.predicted).toBe(1);
    expect(after.high).toBe(1);
  });
});

describe("Upload-action source contract: COA branch runs auto-mapping before validate", () => {
  const ACTIONS = fs.readFileSync(
    path.resolve(process.cwd(), "src/app/app/admin/imports/_actions.ts"),
    "utf8",
  );
  it("imports applyCoaAutoMapping and calls it before validateBatch on the COA branch", () => {
    expect(ACTIONS).toMatch(/applyCoaAutoMapping/);
    // Ordering: applyCoaAutoMapping fires before validateBatch.
    const automapIdx = ACTIONS.indexOf("await applyCoaAutoMapping(principal, created.id)");
    const validateIdx = ACTIONS.indexOf("await validateBatch(principal, created.id)");
    expect(automapIdx).toBeGreaterThan(0);
    expect(validateIdx).toBeGreaterThan(automapIdx);
  });
});

describe("Page + CoaMappingTable: confidence flows from DB → UI", () => {
  const PAGE = fs.readFileSync(
    path.resolve(process.cwd(), "src/app/app/admin/imports/[id]/page.tsx"),
    "utf8",
  );
  const TABLE = fs.readFileSync(
    path.resolve(process.cwd(), "src/app/app/admin/imports/[id]/CoaMappingTable.tsx"),
    "utf8",
  );

  it("page reads _prediction.confidence + .source from rawJson and threads it into InitialCoaRow", () => {
    expect(PAGE).toContain('rawForPrediction._prediction');
    expect(PAGE).toMatch(/predictionConfidence/);
    expect(PAGE).toMatch(/predictionSource/);
  });

  it("CoaMappingTable extends InitialCoaRow with predictionConfidence + predictionSource fields", () => {
    expect(TABLE).toMatch(/predictionConfidence\?: "high" \| "medium" \| "low" \| null/);
    expect(TABLE).toMatch(/predictionSource\?: string \| null/);
  });

  it("Row renders amber-dot indicator for medium + amber-tint for low; nothing for high", () => {
    // The conditional indicator is gated on conf === "medium"
    // OR conf === "low".
    expect(TABLE).toMatch(/conf === "medium" \|\| conf === "low"/);
    // Per-conf data-testid lets e2e count high/medium/low rows.
    expect(TABLE).toMatch(/coa-row-\$\{row\.number\}-confidence-\$\{conf\}/);
    // Low-confidence row tint.
    expect(TABLE).toMatch(/conf === "low" \? "bg-amber-50\/40" : ""/);
    // Dot color: low = amber-500, medium = amber-300.
    expect(TABLE).toMatch(/conf === "low" \? "bg-amber-500" : "bg-amber-300"/);
  });

  it("row carries data-prediction-confidence for assistive tech + e2e querying", () => {
    expect(TABLE).toMatch(/data-prediction-confidence=\{conf \?\? undefined\}/);
  });
});

// ---------------------------------------------------------------------------
// Founder rule 2026-06-29 v12 — duplicate account detection
// ---------------------------------------------------------------------------
describe("normaliseAccountName + detectCoaDuplicates (unit)", () => {
  it("trim + collapse whitespace + lowercase + strip quotes", () => {
    expect(normaliseAccountName("Accounts Payable")).toBe("accounts payable");
    expect(normaliseAccountName("accounts payable")).toBe("accounts payable");
    expect(normaliseAccountName("Accounts  Payable")).toBe("accounts payable");
    expect(normaliseAccountName("  Accounts Payable  ")).toBe("accounts payable");
    expect(normaliseAccountName('"Accounts Payable"')).toBe("accounts payable");
    expect(normaliseAccountName("'Accounts Payable'")).toBe("accounts payable");
  });

  it("flags duplicate numbers + pairs + names across a row batch", () => {
    const dups = detectCoaDuplicates([
      { number: "1000", name: "Cash" },
      { number: "1000", name: "Cash" },              // pair-duplicate
      { number: "1100", name: "Bank" },
      { number: "1100", name: "Operating Account" }, // number-only duplicate
      { number: "1200", name: "Repairs and Maintenance" },
      { number: "1201", name: "REPAIRS AND MAINTENANCE" }, // name-only duplicate (case)
      { number: "1202", name: "  Repairs  and  Maintenance " }, // name-only (whitespace)
    ]);
    expect(dups.duplicateNumbers.has("1000")).toBe(true);
    expect(dups.duplicateNumbers.has("1100")).toBe(true);
    expect(dups.duplicateNumbers.has("1200")).toBe(false);
    expect(dups.duplicatePairs.has("1000::cash")).toBe(true);
    expect(dups.duplicatePairs.has("1100::bank")).toBe(false);
    expect(dups.duplicateNames.has("repairs and maintenance")).toBe(true);
    expect(dups.duplicateNames.has("cash")).toBe(true);
  });
});

async function automapAndValidate(p: Awaited<ReturnType<typeof principalFor>>, batchId: string) {
  await applyCoaAutoMapping(p, batchId);
  await validateBatch(p, batchId);
  return Promise.all([
    db().importBatch.findUnique({ where: { id: batchId } }),
    db().importError.findMany({ where: { batchId }, orderBy: { rowNumber: "asc" } }),
    db().importRow.findMany({ where: { batchId }, orderBy: { rowNumber: "asc" } }),
  ]);
}

describe("Duplicate account detection — validateBatch end-to-end", () => {
  it("duplicate ACCOUNT NUMBER → both rows marked INVALID + DUPLICATE_ACCOUNT_NUMBER error each (HARD)", async () => {
    const c = await bootstrapAPClub("Dup-Number");
    const p = await adminFor(c.id);
    const created = await createBatch(p, {
      clubId: c.id, domain: "COA",
      rows: [
        { number: "9000", name: "Cash" },
        { number: "9000", name: "Petty Cash" },        // SAME number, different name
        { number: "9001", name: "Accounts Payable" },  // clean
      ],
      source: "CSV", fileName: "dup-num.csv",
    });
    const [batch, errors, rows] = await automapAndValidate(p, created.id);
    const dupNumErrors = errors.filter((e) => e.code === "DUPLICATE_ACCOUNT_NUMBER");
    expect(dupNumErrors.length).toBe(2);
    expect(dupNumErrors.every((e) => e.severity === "ERROR")).toBe(true);
    expect(dupNumErrors[0].message).toMatch(/Account number 9000 appears more than once/);
    const invalidRows = rows.filter((r) => r.status === "INVALID");
    expect(invalidRows.length).toBe(2);
    expect(batch?.errorRows).toBe(2);
    expect(batch?.validRows).toBe(1);
  });

  it("duplicate ACCOUNT NUMBER + NAME pair → DUPLICATE_ACCOUNT error each (HARD)", async () => {
    const c = await bootstrapAPClub("Dup-Pair");
    const p = await adminFor(c.id);
    const created = await createBatch(p, {
      clubId: c.id, domain: "COA",
      rows: [
        { number: "9100", name: "Accounts Receivable" },
        { number: "9100", name: "Accounts Receivable" },  // exact pair duplicate
        { number: "9101", name: "Cash" },
      ],
      source: "CSV", fileName: "dup-pair.csv",
    });
    const [batch, errors, rows] = await automapAndValidate(p, created.id);
    const pairErrors = errors.filter((e) => e.code === "DUPLICATE_ACCOUNT");
    expect(pairErrors.length).toBe(2);
    expect(pairErrors.every((e) => e.severity === "ERROR")).toBe(true);
    expect(pairErrors[0].message).toMatch(/Account 9100 · Accounts Receivable appears more than once/);
    expect(rows.filter((r) => r.status === "INVALID").length).toBe(2);
    expect(batch?.errorRows).toBe(2);
  });

  it("duplicate ACCOUNT NAME (different numbers) → DUPLICATE_ACCOUNT_NAME WARNING (NOT blocking)", async () => {
    const c = await bootstrapAPClub("Dup-Name-Warn");
    const p = await adminFor(c.id);
    const created = await createBatch(p, {
      clubId: c.id, domain: "COA",
      rows: [
        { number: "9200", name: "Repairs and Maintenance" },
        { number: "9201", name: "Repairs and Maintenance" },  // same name, different number
        { number: "9202", name: "Cash" },
      ],
      source: "CSV", fileName: "dup-name.csv",
    });
    const [batch, errors, rows] = await automapAndValidate(p, created.id);
    const nameWarnings = errors.filter((e) => e.code === "DUPLICATE_ACCOUNT_NAME");
    expect(nameWarnings.length).toBe(2);
    expect(nameWarnings.every((e) => e.severity === "WARNING")).toBe(true);
    expect(nameWarnings[0].message).toMatch(/Confirm these are intentionally separate accounts/);
    // Both name-duplicate rows still VALID — warnings don't block.
    expect(rows.filter((r) => r.status === "VALID").length).toBe(3);
    expect(batch?.errorRows).toBe(0);    // warnings excluded from errorRows
    expect(batch?.validRows).toBe(3);
  });

  it("normalisation: case + whitespace + quoted variations are all caught as duplicates", async () => {
    const c = await bootstrapAPClub("Dup-Normalize");
    const p = await adminFor(c.id);
    const created = await createBatch(p, {
      clubId: c.id, domain: "COA",
      rows: [
        { number: "9300", name: "Accounts Payable" },
        { number: "9301", name: "accounts payable" },           // case
        { number: "9302", name: "Accounts  Payable" },          // double space
        { number: "9303", name: " Accounts Payable " },         // surrounding spaces
        { number: "9304", name: '"Accounts Payable"' },         // quoted
        { number: "9305", name: "Cash" },                       // clean
      ],
      source: "CSV", fileName: "dup-norm.csv",
    });
    const [batch, errors] = await automapAndValidate(p, created.id);
    const nameWarnings = errors.filter((e) => e.code === "DUPLICATE_ACCOUNT_NAME");
    // 5 of the 6 rows share the normalised name → 5 warnings.
    expect(nameWarnings.length).toBe(5);
    expect(nameWarnings.every((e) => e.severity === "WARNING")).toBe(true);
    expect(batch?.errorRows).toBe(0); // all rows VALID — warnings only.
  });

  it("clean COA (no duplicates) validates successfully — batch.errorRows = 0", async () => {
    const c = await bootstrapAPClub("Dup-Clean-237");
    const p = await adminFor(c.id);
    // Generate 237 unique rows mirroring the founder's Silver
    // Springs row count, with every number AND every name unique.
    const cleanRows = Array.from({ length: 237 }, (_, i) => ({
      number: `${1000 + i}`,
      name: `Account ${i + 1}`,
    }));
    const created = await createBatch(p, {
      clubId: c.id, domain: "COA", rows: cleanRows,
      source: "CSV", fileName: "clean-237.csv",
    });
    const [batch, errors] = await automapAndValidate(p, created.id);
    expect(errors.filter((e) => e.code.startsWith("DUPLICATE")).length).toBe(0);
    expect(batch?.errorRows).toBe(0);
    expect(batch?.validRows).toBe(237);
  });
});

describe("UI source-contract: duplicate rows highlight + warnings split out", () => {
  const ERRORS_CARD = fs.readFileSync(
    path.resolve(process.cwd(), "src/app/app/admin/imports/[id]/CoaErrorsCard.tsx"),
    "utf8",
  );
  const TABLE_SRC = fs.readFileSync(
    path.resolve(process.cwd(), "src/app/app/admin/imports/[id]/CoaMappingTable.tsx"),
    "utf8",
  );
  const PAGE_SRC = fs.readFileSync(
    path.resolve(process.cwd(), "src/app/app/admin/imports/[id]/page.tsx"),
    "utf8",
  );

  it("CoaErrorsCard splits hardErrors vs warnings; warnings get their own count chip", () => {
    expect(ERRORS_CARD).toMatch(/const hardErrors = errors\.filter/);
    expect(ERRORS_CARD).toMatch(/const warnings = errors\.filter/);
    expect(ERRORS_CARD).toMatch(/coa-warnings-summary-count/);
  });

  it("CoaErrorsCard row carries data-severity for assistive tech + amber styling on warnings", () => {
    expect(ERRORS_CARD).toMatch(/data-severity=\{isWarn \? "WARNING" : "ERROR"\}/);
    expect(ERRORS_CARD).toMatch(/hover:bg-amber-50/);
  });

  it("CoaMappingTable applies red tint + left-border on INVALID rows (existing isError path; duplicates flow through it)", () => {
    expect(TABLE_SRC).toMatch(/isError \? "bg-red-50\/60 border-l-4 border-l-red-500"/);
  });

  it("page threads severity from ImportError rows through to the ErrorsCard props", () => {
    expect(PAGE_SRC).toMatch(/severity: \(e as \{ severity\?: string \}\)\.severity === "WARNING" \? "WARNING" : "ERROR"/);
  });
});
