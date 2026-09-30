// COA-UI-1 (2026-09-29) — empty Chart of Accounts layout fix.
//
// Regression guards:
//   * The table wrap now carries `data-mode="empty" | "populated"`
//     so a CSS rule can conditionally collapse the wrap when the
//     table has zero rows.
//   * globals.css has the matching rule:
//       .spectre-dw-table-wrap[data-mode="empty"] { flex: 0 0 auto; }
//     WITHOUT touching the default `.spectre-dw-table-wrap { flex: 1 }`
//     that the populated 562-row table relies on for scroll behaviour.
//
// These are cheap source-contract tests. Full visual verification of
// the layout at 1440×900 and 1920×1080 is captured in the acceptance
// package's viewport section.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..");

const CLIENT = readFileSync(
  path.join(REPO, "src", "components", "data-workspace", "ChartOfAccountsClient.tsx"),
  "utf8",
);
const GLOBALS = readFileSync(path.join(REPO, "src", "app", "globals.css"), "utf8");

describe("COA-UI-1 / COA-UI-1b · empty Chart-of-Accounts layout regression", () => {
  it("COA-UI-1 · ChartOfAccountsClient stamps data-mode on the table wrap conditional on filtered row count", () => {
    expect(CLIENT).toMatch(
      /className="spectre-dw-table-wrap"\s*\n\s*data-mode=\{sortedVisibleRows\.length === 0 \? "empty" : "populated"\}/,
    );
  });

  it("COA-UI-1b · ChartOfAccountsClient stamps data-mode on the ROOT keyed off TOTAL account count (true empty vs filtered empty)", () => {
    // Section 7 — the root's data-mode uses `props.rows.length`
    // (total accounts on the tenant), NOT `sortedVisibleRows.length`
    // (filtered visible rows). This prevents a search returning zero
    // results from collapsing the entire COA workspace.
    expect(CLIENT).toMatch(
      /className="spectre-dw-root"[\s\S]*?data-mode=\{props\.rows\.length === 0 \? "empty" : "populated"\}/,
    );
  });

  it("COA-UI-1 · globals.css keeps the default flex:1 for the populated wrap AND adds the empty-mode override", () => {
    expect(GLOBALS).toMatch(
      /\.spectre-dw-table-wrap\s*\{[^}]*flex:\s*1[^}]*overflow:\s*auto[^}]*\}/,
    );
    expect(GLOBALS).toMatch(
      /\.spectre-dw-table-wrap\[data-mode="empty"\]\s*\{[^}]*flex:\s*0 0 auto[^}]*\}/,
    );
  });

  it("COA-UI-1b · globals.css adds the ROOT-level empty-mode override for body / main / inspector-slot", () => {
    // Body must auto-flow into the next available track (right beneath
    // the toolbar), NOT stay pinned to `grid-row: -1` (which places it
    // in an implicit row after the `1fr` explicit track).
    expect(GLOBALS).toMatch(
      /\.spectre-dw-root\[data-mode="empty"\]\s*\.spectre-dw-body\s*\{[^}]*grid-row:\s*auto[^}]*\}/,
    );
    // Both panes inside the body collapse to content height in empty mode.
    expect(GLOBALS).toMatch(
      /\.spectre-dw-root\[data-mode="empty"\]\s*\.spectre-dw-main\s*\{[^}]*height:\s*auto[^}]*\}/,
    );
    expect(GLOBALS).toMatch(
      /\.spectre-dw-root\[data-mode="empty"\]\s*\.spectre-dw-inspector-slot\s*\{[^}]*height:\s*auto[^}]*\}/,
    );
  });

  it("COA-UI-1 · empty-mode wrap CSS does NOT re-declare flex:1 or a min-height that would defeat the collapse", () => {
    const emptyRuleMatch = GLOBALS.match(
      /\.spectre-dw-table-wrap\[data-mode="empty"\]\s*\{([^}]*)\}/,
    );
    expect(emptyRuleMatch).not.toBeNull();
    const rule = emptyRuleMatch![1];
    expect(rule).not.toMatch(/flex:\s*1\b/);
    expect(rule).not.toMatch(/min-height:\s*(?!0)/);
  });

  it("COA-UI-1b · empty-mode body CSS does NOT re-pin grid-row to -1 (would re-introduce the implicit-row gap)", () => {
    const bodyRuleMatch = GLOBALS.match(
      /\.spectre-dw-root\[data-mode="empty"\]\s*\.spectre-dw-body\s*\{([^}]*)\}/,
    );
    expect(bodyRuleMatch).not.toBeNull();
    expect(bodyRuleMatch![1]).not.toMatch(/grid-row:\s*-1/);
    // And no forced 100% height that would recreate the tall pane.
    expect(bodyRuleMatch![1]).not.toMatch(/height:\s*100%/);
  });

  it("Section 5 — the founder-required empty-state copy is preserved verbatim", () => {
    expect(CLIENT).toMatch(/The Chart of Accounts is empty\./);
    expect(CLIENT).toMatch(/Start by importing your Chart of Accounts from a CSV/);
  });

  it("Section 7 — filtered-empty (total rows > 0, visible rows = 0) does NOT trigger the true-empty collapse", () => {
    // The root's data-mode is keyed on `props.rows.length` (total),
    // not `sortedVisibleRows.length` (filtered). A search returning
    // zero results keeps `data-mode="populated"` on the root and
    // the empty-mode overrides never fire.
    // This structural assertion is redundant with the second test
    // above but is stated explicitly as a Section 7 guarantee.
    expect(CLIENT).toMatch(/data-mode=\{props\.rows\.length === 0 \? "empty" : "populated"\}/);
    expect(CLIENT).not.toMatch(/data-mode=\{sortedVisibleRows\.length === 0 \? "empty" : "populated"\}[^]*className="spectre-dw-root"/);
  });
});
