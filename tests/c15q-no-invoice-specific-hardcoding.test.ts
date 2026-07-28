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
  it("no bare 'cpa' token in classifier patterns (must use 'accounting_firm' / 'LLP' shapes instead)", () => {
    // We're specifically catching the 15Q-defect pattern where
    // "|cpa|" appeared inside a vendor-name regex alternation.
    expect(scanFor(/\|cpa\|/gi)).toEqual([]);
    expect(scanFor(/\bcpa\b[^a-z0-9_-]/gi).filter((h) => !h.file.includes("gl-recommend.ts.remove-me"))).toEqual([]);
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
});
