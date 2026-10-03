// AR-HIST-1 §25 (2026-10-03) — source-contract regression guards.

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO = path.resolve(__dirname, "..");
const SCHEMA_SQLITE = path.join(REPO, "prisma/schema.prisma");
const SCHEMA_PG = path.join(REPO, "prisma-postgres/schema.prisma");
const MIG_PG = path.join(REPO, "prisma-postgres/migrations/20261003_ar_hist_1_ar_aging_snapshot/migration.sql");
const COMMIT = path.join(REPO, "src/lib/imports/ar-aging/commit-service.ts");
const LOADER = path.join(REPO, "src/lib/imports/ar-aging/jonas-xlsx-loader.ts");
const RESOLVER = path.join(REPO, "src/lib/reporting/ar-aging-resolver.ts");
const RATIO_REG = path.join(REPO, "src/lib/reporting/ratio-registry.ts");

// --------------------------------------------------------------
// SCHEMA
// --------------------------------------------------------------
describe("AR-HIST-1 §27-G — snapshot schema", () => {
  it("SQLite + Postgres schemas declare ArAgingImportBatch + ArAgingSnapshotRow", () => {
    for (const p of [SCHEMA_SQLITE, SCHEMA_PG]) {
      const s = readFileSync(p, "utf8");
      expect(s).toMatch(/^model ArAgingImportBatch\b/m);
      expect(s).toMatch(/^model ArAgingSnapshotRow\b/m);
    }
  });

  it("Postgres migration present with idempotency index", () => {
    expect(existsSync(MIG_PG)).toBe(true);
    const sql = readFileSync(MIG_PG, "utf8");
    expect(sql).toMatch(/CREATE UNIQUE INDEX "ArAgingImportBatch_idempotency"[\s\S]{0,300}sourceFileHash[\s\S]{0,100}sourceEffectiveDate/);
  });

  it("ArAgingSnapshotRow uses Decimal(18,2) for money", () => {
    const sql = readFileSync(MIG_PG, "utf8");
    expect(sql).toMatch(/"netAmount"\s+DECIMAL\(18,\s*2\)/);
    expect(sql).toMatch(/"current"\s+DECIMAL\(18,\s*2\)/);
    expect(sql).toMatch(/"overFourMonths"\s+DECIMAL\(18,\s*2\)/);
  });
});

// --------------------------------------------------------------
// LOADER
// --------------------------------------------------------------
describe("AR-HIST-1 — Jonas XLSX loader preserves Member Code strings", () => {
  it("loader never numerically coerces t='str' cells (preserves leading zeros)", () => {
    const src = readFileSync(LOADER, "utf8");
    // The branch for t="str" / inlineStr must return String(raw),
    // never Number(raw).
    expect(src).toMatch(/t === "str"[\s\S]{0,300}value = String\(raw\)/);
    expect(src).not.toMatch(/t === "str"[\s\S]{0,300}Number\(raw\)/);
  });

  it("loader computes a SHA-256 sourceFileHash", () => {
    const src = readFileSync(LOADER, "utf8");
    expect(src).toMatch(/createHash\("sha256"\)/);
  });
});

// --------------------------------------------------------------
// COMMIT GATE
// --------------------------------------------------------------
describe("AR-HIST-1 §14 — commit gate", () => {
  it("commit refuses when any Member Code is unmatched", () => {
    const src = readFileSync(COMMIT, "utf8");
    expect(src).toMatch(/matched === parse\.rows\.length/);
    expect(src).toMatch(/status === "RECONCILED"/);
    expect(src).toMatch(/parse\.aggregateReconcilesPerRow/);
    expect(src).toMatch(/AR-HIST-1 commit gate failed/);
  });

  it("commit never writes to JournalEntry / Charge / Payment / Statement / ReportingLedger", () => {
    const src = readFileSync(COMMIT, "utf8");
    expect(src).not.toMatch(/prisma\.journalEntry\.(create|update)/);
    expect(src).not.toMatch(/prisma\.charge\.(create|update)/);
    expect(src).not.toMatch(/prisma\.payment\.(create|update)/);
    expect(src).not.toMatch(/prisma\.statement\.(create|update)/);
    expect(src).not.toMatch(/prisma\.reportingLedger/);
    expect(src).not.toMatch(/prisma\.account\.(create|update)/);
  });

  it("commit resolves on MemberExternalIdentity ONLY (no fuzzy name matching)", () => {
    const src = readFileSync(COMMIT, "utf8");
    expect(src).toMatch(/prisma\.memberExternalIdentity\.findMany/);
    expect(src).not.toMatch(/levenshtein|fuzzysort|fuzzball/i);
    expect(src).not.toMatch(/firstName.*lastName.*match/);
  });

  it("§15 — name consistency check is secondary (never changes identity match)", () => {
    const src = readFileSync(COMMIT, "utf8");
    expect(src).toMatch(/name consistency check[\s\S]{0,200}does NOT change[\s\S]{0,200}identity match/);
  });

  it("§6 — resolution outcomes are MATCHED / UNMATCHED / AMBIGUOUS / INVALID", () => {
    const src = readFileSync(COMMIT, "utf8");
    expect(src).toMatch(/outcome:\s*"MATCHED"/);
    expect(src).toMatch(/outcome:\s*"UNMATCHED"/);
    expect(src).toMatch(/outcome:\s*"AMBIGUOUS"/);
    expect(src).toMatch(/outcome:\s*"INVALID"/);
  });

  it("§8 — MemberAccount is created ONLY for AR-resolved Members (no blanket 3,080)", () => {
    const src = readFileSync(COMMIT, "utf8");
    // The upsert path iterates ONLY over memberIds from matched
    // resolutions, not over all Members.
    expect(src).toMatch(/const memberIds = preview\.resolutions\.filter\(\(r\) => r\.outcome === "MATCHED"\)/);
    expect(src).toMatch(/prisma\.memberAccount\.create/);
    // Guard: no `prisma.member.findMany` enumerating all 3,080.
    expect(src).not.toMatch(/prisma\.member\.findMany\(\{\s*where:\s*\{\s*clubId\s*\}/);
  });

  it("§10 — idempotency key is (clubId, sourceSystem, sourceFileHash, sourceEffectiveDate)", () => {
    const src = readFileSync(COMMIT, "utf8");
    expect(src).toMatch(/clubId_sourceSystem_sourceFileHash_sourceEffectiveDate/);
    expect(src).toMatch(/already committed/i);
  });

  it("§13 — GL reconciliation tolerance is $0.01, never adjusted", () => {
    const src = readFileSync(COMMIT, "utf8");
    expect(src).toMatch(/toMoney\("0\.01"\)/);
    // No plug/adjustment language.
    expect(src).not.toMatch(/plug|adjustment.*post|allocateDifference/i);
    // The reconciliation decision uses `difference.abs().lte(TOLERANCE)`.
    expect(src).toMatch(/difference\.abs\(\)\.lte\(TOLERANCE\)/);
  });
});

// --------------------------------------------------------------
// RESOLVER
// --------------------------------------------------------------
describe("AR-HIST-1 §17 / §23 — AR aging resolver (snapshot-only, date-aware)", () => {
  it("resolver reads ArAgingImportBatch, not Charge / Payment tables", () => {
    const src = readFileSync(RESOLVER, "utf8");
    expect(src).toMatch(/prisma\.arAgingImportBatch\.findFirst/);
    expect(src).not.toMatch(/prisma\.charge\.(findMany|count)/);
    expect(src).not.toMatch(/prisma\.payment\.(findMany|count)/);
  });

  it("resolver matches on EXACT calendar day (no carry-forward)", () => {
    const src = readFileSync(RESOLVER, "utf8");
    expect(src).toMatch(/sourceEffectiveDate:\s*\{\s*gte:\s*dayStart,\s*lte:\s*dayEnd/);
  });

  it("resolver returns SOURCE_NOT_LOADED when no snapshot covers the asOf", () => {
    const src = readFileSync(RESOLVER, "utf8");
    expect(src).toMatch(/availability:\s*"SOURCE_NOT_LOADED"/);
  });
});

// --------------------------------------------------------------
// §19 — Board Package integration (ratio registry wiring)
// --------------------------------------------------------------
describe("AR-HIST-1 §19 — Board Package integration", () => {
  it("ratio-registry arCurrentPct consumes resolveArAgingAsOf when a snapshot exists", () => {
    const src = readFileSync(RATIO_REG, "utf8");
    expect(src).toMatch(/resolveArAgingAsOf/);
    expect(src).toMatch(/r\.provenance\.availability === "AVAILABLE"/);
    expect(src).toMatch(/batch=\$\{r\.snapshot\.batchId\}/);
  });
});

// --------------------------------------------------------------
// §21 — Privacy
// --------------------------------------------------------------
describe("AR-HIST-1 §21 — privacy", () => {
  it("snapshot row shape has no email / phone / address / DOB fields", () => {
    const s = readFileSync(SCHEMA_SQLITE, "utf8");
    const block = s.match(/model ArAgingSnapshotRow[\s\S]*?\n\}/)?.[0] ?? "";
    expect(block).not.toMatch(/\bemail\b/i);
    expect(block).not.toMatch(/\bphone\b/i);
    expect(block).not.toMatch(/\baddress\b/i);
    expect(block).not.toMatch(/\bpostal\b/i);
    expect(block).not.toMatch(/\bdob|birth\b/i);
    expect(block).not.toMatch(/\bcreditCard|bank/i);
  });

  it(".gitignore blocks the real AR workbook pattern", () => {
    const gi = readFileSync(path.join(REPO, ".gitignore"), "utf8");
    expect(gi).toMatch(/Jan\*31\*2026\*Aged\*AR\*listing\*\.xlsx|Aged\*AR\*listing\*\.xlsx/);
  });
});
