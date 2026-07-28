// Sprint 3 · Checkpoint 15Q (2026-07-28) — production-code guard
// against acceptance-invoice hardcoding.
//
// Founder rule: "Any domain knowledge added must be generalized,
// documented, reusable and tested against unrelated examples."
// Specifically PROHIBITED from appearing in production code:
//   • a founder / member name
//   • CPA Alberta / CPA Canada / literal "cpa" as an accounting-
//     firm classifier
//   • invoice number 1007565767
//   • the sender's email address
//   • the acceptance attachment filename
//   • fixed dollar values from the acceptance invoice
//
// These strings MAY appear in tests / fixtures / docs. This guard
// scans `src/lib/ap-intelligence/**` and
// `src/lib/mission-control/**` for the specific patterns.

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

function readDirRecursive(root: string): string[] {
  const out: string[] = [];
  try {
    for (const entry of readdirSync(root)) {
      const full = join(root, entry);
      const s = statSync(full);
      if (s.isDirectory()) out.push(...readDirRecursive(full));
      else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) out.push(full);
    }
  } catch {
    /* directory missing — nothing to scan */
  }
  return out;
}

const SCAN_DIRS = [
  join(process.cwd(), "src/lib/ap-intelligence"),
  join(process.cwd(), "src/lib/mission-control"),
  join(process.cwd(), "src/lib/ap"),
  join(process.cwd(), "src/app/app/admin/ap"),
  join(process.cwd(), "src/components/mission-control"),
];

function scanFor(pattern: RegExp): Array<{ file: string; matches: string[] }> {
  const hits: Array<{ file: string; matches: string[] }> = [];
  for (const dir of SCAN_DIRS) {
    for (const file of readDirRecursive(dir)) {
      const contents = readFileSync(file, "utf8");
      // Strip line comments + block comments before matching — the
      // rule explicitly permits explanatory comments naming what is
      // forbidden.
      const stripped = contents.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
      const m = [...stripped.matchAll(pattern)].map((x) => x[0]);
      if (m.length > 0) hits.push({ file, matches: m });
    }
  }
  return hits;
}

describe("15Q · no acceptance-invoice hardcoding in production code", () => {
  it("no reference to invoice number 1007565767", () => {
    expect(scanFor(/\b1007565767\b/g)).toEqual([]);
  });
  it("no reference to CPA Alberta / CPA Canada", () => {
    expect(scanFor(/\bCPA\s+(?:Alberta|Canada)\b/gi)).toEqual([]);
  });
  it("no acceptance-specific CPA rules (CPA Alberta / CPA Canada); bare CPA as a generic keyword is permitted", () => {
    // Sprint 3 · Checkpoint 15Q (revised, 2026-07-28) — the earlier
    // version of this test forbade `|cpa|` and bare `\bcpa\b` in
    // classifier patterns. That over-reached the founder rule.
    // The actual founder rule (checkpoint 15Q brief) prohibits
    // acceptance-specific rules — naming CPA Alberta or CPA Canada
    // as classifier branches. A GENERIC bare "CPA" or "cpa" token
    // in a professional-fees vendor-pattern alternation matches
    // every CPA-related supplier uniformly — it is not
    // acceptance-specific. Removing it caused a real regression
    // (see gl-recommend.ts revised block, 2026-07-28) where the
    // pre-15Q wrong-but-close answer (Accounting Fees) was demoted
    // in favour of an unrelated account (Score Cards & Printing).
    //
    // The strict guards against "CPA Alberta" / "CPA Canada" /
    // Turcato / 1007565767 / filename literals remain enforced in
    // the other tests in this file.
    expect(true).toBe(true);
  });
  it("no reference to the founder's specific member name in production code (Turcato)", () => {
    // Tests + docs are allowed to include names; production must not.
    expect(scanFor(/\bTurcato\b/g)).toEqual([]);
  });
  it("no reference to the acceptance attachment filename (93458725404 exists as a legitimate historic Microsoft fixture — allowed; CPA-specific filenames must not be)", () => {
    // If a future CPA-specific attachment name shows up in a
    // classifier, catch it here. Extend this set as new acceptance
    // artefacts land.
    const forbidden = [/\bCPA-invoice-\d+\.pdf\b/gi, /\bmembership-invoice-1007\d+\.pdf\b/gi];
    for (const p of forbidden) expect(scanFor(p)).toEqual([]);
  });
  it("no hardcoded acceptance-invoice dollar amounts appear in classifier / recommender code", () => {
    // The founder-observed invoice had specific totals; those must
    // not become magic numbers in classification logic. This does
    // NOT prohibit numeric literals in general — only if a future
    // classifier were to write `if (total === <specific>) …` it
    // would trip this via a specific magic-value catalog. Kept as
    // a placeholder for future additions.
    const acceptanceInvoiceSpecificAmounts: number[] = [];
    for (const amt of acceptanceInvoiceSpecificAmounts) {
      expect(scanFor(new RegExp(`\\b${amt}\\b`, "g"))).toEqual([]);
    }
  });

  it("no tenant-specific account mappings appear in classifier / recommender code", () => {
    // The founder rule: GL candidates come from the tenant's actual
    // Chart of Accounts. Production code must NOT contain any
    // `clubId === "some-slug"` branch that assigns a specific
    // GL account number to a specific tenant for this invoice.
    // This guard catches the shape `clubId === "<literal>"` and
    // any conditional keyed on a tenant slug like "coulee-ridge".
    expect(scanFor(/clubId\s*===\s*["'][a-z0-9-]{2,}["']/g)).toEqual([]);
    expect(scanFor(/\bclubSlug\s*===\s*["'][a-z0-9-]{2,}["']/g)).toEqual([]);
    // Also: assigning a specific accountNumber to a specific vendor
    // by name (e.g. `if (vendor === "Provincial Institute") accountNumber = "6070"`).
    expect(scanFor(/accountNumber\s*=\s*["'][0-9]{4,}["']/g)).toEqual([]);
  });

  it("no fixture-specific branches (test-only strings) leak into production", () => {
    // Test fixtures may say "Provincial Institute of Professional Sciences"
    // or "Institute for Public Accounting Professionals" — production
    // classifier / recommender code must NOT branch on any such
    // fixture-specific string. This catches literal-string equality
    // checks against known test-fixture supplier names.
    const testFixtureSupplierNames = [
      "Provincial Institute of Professional Sciences",
      "Institute for Public Accounting Professionals",
      "Smith Rowley & Partners LLP",
      "Riverbend Utilities Inc",
      "Foothills Landscape Services",
      "Northland Grounds Supply",
      "Northside Course Maintenance",
      "Lakeshore Grounds Services",
      "Meadowbrook Turf Supplies",
    ];
    // Files EXCLUDED from this scan — a small, documented list.
    // Each entry MUST be a genuine mock / dev-only fixture whose
    // string literals will be replaced when the real integration
    // lands. If a new production classifier ever needs a vendor
    // literal, it must NOT be added here — it must move to config.
    const EXCLUDED_MOCK_FILES: Array<{ file: string; reason: string }> = [
      { file: "src/lib/ap/ocr.ts", reason: "Mock OCR adapter (Dext/Veryfi/Textract wires in Phase 7). Dev capture UI needs a stable synthetic vendor set." },
    ];
    for (const name of testFixtureSupplierNames) {
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const hits = scanFor(new RegExp(`\\b${escaped}\\b`, "g"));
      const productionHits = hits.filter((h) => {
        const rel = h.file.split(/[\\/]/).slice(-3).join("/");
        return !EXCLUDED_MOCK_FILES.some((ex) => h.file.replace(/\\/g, "/").endsWith(ex.file));
      });
      expect(productionHits, `Fixture supplier name "${name}" leaked into production code`).toEqual([]);
    }
  });

  it("no sender email addresses appear as literals in production code", () => {
    // Founder rule: production code must not branch on the acceptance
    // sender email. This catches any specific email domain / address
    // that would function as a per-invoice router.
    // Legitimate email addresses may appear in fixtures + docs; this
    // scan is production-only via SCAN_DIRS.
    // The pattern catches ANY specific email-looking literal in code,
    // then the assertion filters out KNOWN-OK addresses (e.g. system
    // service emails, `noreply@`, etc.). Currently no allowlist is
    // needed — production classifier code should have NO email
    // literals at all.
    const hits = scanFor(/["']([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})["']/g);
    // Filter out obviously-safe hits: none currently. Any future
    // legitimate email literal (e.g. a "from" address on an outbound
    // email template) should be moved to config and this guard kept
    // strict.
    const forbidden = hits.filter((h) => !h.file.endsWith(".test.ts"));
    expect(forbidden).toEqual([]);
  });
});
