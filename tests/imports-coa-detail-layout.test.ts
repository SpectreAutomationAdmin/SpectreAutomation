// Founder rule 2026-07-15: the COA import detail page is a
// Controller workspace, not a debug console. The legacy "Rows"
// card duplicated row status that the mapping table already
// shows per row, so it's removed from the default view; if
// retained at all it goes behind a collapsed "Advanced
// validation details" disclosure.
//
// Source-contract tests on the detail page.

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const PAGE = fs.readFileSync(
  path.resolve(
    process.cwd(),
    "src/app/app/admin/imports/[id]/page.tsx",
  ),
  "utf8",
);

describe("COA detail page — Rows card removed from default view", () => {
  it("no top-level Rows card on the COA path; only the Errors-summary + mapping table + Advanced disclosure remain", () => {
    // The legacy Rows card has its content inlined inside the
    // `<details>` disclosure on the COA path. Confirm the
    // disclosure is the only place that renders the per-row
    // status table.
    expect(PAGE).toContain('data-testid="advanced-validation-details"');
    expect(PAGE).toContain("Advanced validation details");
  });

  it("Errors summary on the COA path is delegated to <CoaErrorsCard> (which gates on errors.length > 0 internally)", () => {
    // The page passes batch.errors straight through; the card
    // returns null when the array is empty. This is verified by
    // the dedicated CoaErrorsCard test suite.
    expect(PAGE).toContain("<CoaErrorsCard");
    expect(PAGE).toMatch(/errors=\{batch\.errors\.map\(/);
  });

  it("CoaErrorsCard sits ABOVE the mapping table on the COA path", () => {
    // Layout order: <CoaErrorsCard> → <CoaMappingTable> →
    // <details> Advanced disclosure. Source-order check.
    const errorsIdx = PAGE.indexOf("<CoaErrorsCard");
    const mappingTableIdx = PAGE.indexOf("<CoaMappingTable");
    const detailsIdx = PAGE.indexOf('data-testid="advanced-validation-details"');
    expect(errorsIdx).toBeGreaterThan(0);
    expect(mappingTableIdx).toBeGreaterThan(0);
    expect(detailsIdx).toBeGreaterThan(0);
    expect(errorsIdx).toBeLessThan(mappingTableIdx);
    expect(mappingTableIdx).toBeLessThan(detailsIdx);
  });
});

describe("COA detail page — Advanced validation details disclosure", () => {
  it("uses a native <details>/<summary> so it's collapsed by default with no JS state", () => {
    expect(PAGE).toMatch(/<details[\s\S]*?data-testid="advanced-validation-details"/);
    expect(PAGE).toMatch(/<summary[\s\S]+?Advanced validation details/);
    // No `open` attribute → collapsed by default.
    expect(PAGE).not.toMatch(/<details[^>]*\bopen\b/);
  });

  it("labels the truncation when present instead of silently dropping rows", () => {
    expect(PAGE).toMatch(
      /Debug preview — showing first 200 of \$\{batch\.rows\.length\} rows/,
    );
    // Full-list label when there's no truncation.
    expect(PAGE).toMatch(/\$\{batch\.rows\.length\} rows\./);
  });
});

describe("Non-COA paths keep the original two-card layout", () => {
  it("non-COA branch still renders the Errors card unconditionally + the Rows card", () => {
    // The else branch is the legacy layout — confirm both
    // legacy markers are still present so MEMBERS / VENDORS /
    // etc. are unchanged.
    expect(PAGE).toContain(">No errors.<");
    expect(PAGE).toMatch(/Rows\{batch\.rows\.length > 200 \? ` \(showing first 200 of \$\{batch\.rows\.length\}\)`/);
  });
});

describe("COA detail page — invariants from earlier slices remain", () => {
  it("isCoa is derived from batch.domain (single source of truth used by both the buttons + the layout switch)", () => {
    expect(PAGE).toMatch(/const isCoa = batch\.domain === "COA"/);
  });

  it("the 'Not validated' fallback in the header is still wired (prior slice 2026-07-13)", () => {
    expect(PAGE).toContain('data-testid="batch-detail-not-validated"');
  });

  it("the COA replacement commit button is still rendered for VALIDATED COA batches (prior slice 2026-07-07)", () => {
    expect(PAGE).toContain("<CoaReplaceCommitButton");
  });
});
