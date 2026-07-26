// Permanent guard for the 2026-06-19 chapter-id naming convention:
//
//   RULE: Every visible menu label has a sectionId derived from
//         the label. Manually entered ids that diverge from the
//         visible label are forbidden.
//
// What this suite verifies:
//   1. `chapterIdFor()` produces the exact outputs the founder spec
//      lists for every label class (plain words, ampersands, P&L
//      and AR-style abbreviations).
//   2. The MONTHLY_CHAPTERS list in `src/app/app/admin/reporting/
//      layout.tsx` contains NO `id:` fields — the layout cannot
//      manually pin an id.
//   3. Every chapter label resolves to a section anchor that exists
//      in the monthly page body — either `<section id="X">` or
//      `<div id="X">` for the cover chapter.
//   4. The group labels used in layout.tsx all slugify cleanly
//      (no ampersand spillage, no double dashes, etc.).

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

import { chapterIdFor } from "@/lib/reporting/chapter-id";

const LAYOUT_PATH = path.resolve(process.cwd(), "src/app/app/admin/reporting/layout.tsx");
const PAGE_PATH = path.resolve(process.cwd(), "src/app/app/admin/reporting/monthly/page.tsx");

const LAYOUT_SRC = fs.readFileSync(LAYOUT_PATH, "utf8");
const PAGE_SRC = fs.readFileSync(PAGE_PATH, "utf8");

describe("chapterIdFor — slugify must produce the founder-spec'd outputs", () => {
  // Exact pairings from the founder's spec list (2026-06-19).
  const expected: ReadonlyArray<[string, string]> = [
    ["Executive Opening",       "executive-opening"],
    ["Financial Performance",   "financial-performance"],
    ["Stewardship Dashboard",   "stewardship-dashboard"],
    ["Statement of Activities", "statement-of-activities"],
    ["Capital Fund",            "capital-fund"],
    ["Capital Projects",        "capital-projects"],
    ["Financial Position",      "financial-position"],
    ["AR Aging",                "ar-aging"],
    ["Operating Statistics",    "operating-statistics"],
    ["Departmental P&L",        "departmental-p-and-l"],
    ["Weather & Utilization",   "weather-and-utilization"],
    ["Payroll Analysis",        "payroll-analysis"],
    ["F&B Statistics",          "f-and-b-statistics"],
    ["Inventory Analysis",      "inventory-analysis"],
    ["Financial Statements",    "financial-statements"],
    ["Operations & Analytics",  "operations-and-analytics"],
    ["Member Overview",         "member-overview"],
  ];

  for (const [label, slug] of expected) {
    it(`"${label}" → "${slug}"`, () => {
      expect(chapterIdFor(label)).toBe(slug);
    });
  }

  // Sanity edge cases the algorithm is expected to handle.
  it("leading/trailing whitespace and punctuation get trimmed", () => {
    expect(chapterIdFor("  Capital Fund  ")).toBe("capital-fund");
    expect(chapterIdFor("Capital Fund!")).toBe("capital-fund");
    expect(chapterIdFor("- Capital Fund -")).toBe("capital-fund");
  });

  it("multiple ampersands collapse cleanly", () => {
    expect(chapterIdFor("A & B & C")).toBe("a-and-b-and-c");
  });

  it("output is always lowercase, kebab-case, alphanumeric+dash", () => {
    for (const [label] of expected) {
      const slug = chapterIdFor(label);
      expect(slug).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    }
  });
});

describe("MONTHLY_CHAPTERS — naming-convention invariants", () => {
  it("layout.tsx declares NO manual `id:` field on chapter entries", () => {
    // The convention 2026-06-19: chapter entries declare only
    // `number`, `label`, and `group`. The id is derived from the
    // label by chapterIdFor() — manually pinning an id field is
    // forbidden because it would allow the id to diverge from the
    // visible label.
    expect(
      LAYOUT_SRC,
      "MONTHLY_CHAPTERS entries MUST NOT have an `id:` property — the section id is derived from the label",
    ).not.toMatch(/\{\s*id:\s*"/);
  });

  it("every chapter label resolves to a section/div anchor in page.tsx", () => {
    // Pull every chapter label from layout.tsx, slugify it, and
    // assert the monthly page body contains a matching anchor —
    // `<section id="X">` for chapters II onward and `<div id="X">`
    // for the cover chapter (chapter I).
    const labels = Array.from(
      LAYOUT_SRC.matchAll(/label: "([^"]+)",\s*group:/g),
      (m) => m[1],
    );
    expect(labels.length, "at least one chapter must be defined").toBeGreaterThan(0);

    const missing: string[] = [];
    for (const label of labels) {
      const id = chapterIdFor(label);
      const sectionMatch = PAGE_SRC.includes(`<section id="${id}"`);
      const divMatch = PAGE_SRC.includes(`<div id="${id}"`);
      if (!sectionMatch && !divMatch) {
        missing.push(`"${label}" → "${id}"`);
      }
    }
    expect(
      missing,
      `the following chapter labels have no matching <section id=""> or <div id=""> in page.tsx: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("every group label slugifies cleanly (no double dashes, no leading/trailing dashes)", () => {
    const groups = Array.from(
      new Set(
        Array.from(
          LAYOUT_SRC.matchAll(/group: "([^"]+)"/g),
          (m) => m[1],
        ),
      ),
    );
    expect(groups.length, "at least one group must be defined").toBeGreaterThan(0);
    for (const group of groups) {
      const slug = chapterIdFor(group);
      expect(slug, `group "${group}" must slugify to a clean kebab-case identifier (got "${slug}")`)
        .toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    }
  });

  it("group label 'Financial Statements' is present (2026-06-19 rename from 'Financial Performance')", () => {
    expect(LAYOUT_SRC).toMatch(/group: "Financial Statements"/);
    expect(
      LAYOUT_SRC,
      "the legacy 'Financial Performance' group label must NOT appear (rename target was 'Financial Statements')",
    ).not.toMatch(/group: "Financial Performance"/);
  });
});
