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

describe("COA-UI-1 · empty-state layout regression", () => {
  it("ChartOfAccountsClient stamps data-mode on the table wrap conditional on row count", () => {
    // The wrap now carries `data-mode={sortedVisibleRows.length === 0 ? "empty" : "populated"}`.
    expect(CLIENT).toMatch(
      /className="spectre-dw-table-wrap"\s*\n\s*data-mode=\{sortedVisibleRows\.length === 0 \? "empty" : "populated"\}/,
    );
  });

  it("globals.css keeps the default flex:1 for the populated wrap AND adds the empty-mode override", () => {
    // The populated default is preserved so the 562-row scroll behaviour still works.
    expect(GLOBALS).toMatch(
      /\.spectre-dw-table-wrap\s*\{[^}]*flex:\s*1[^}]*overflow:\s*auto[^}]*\}/,
    );
    // The empty-mode override collapses the wrap to content height.
    expect(GLOBALS).toMatch(
      /\.spectre-dw-table-wrap\[data-mode="empty"\]\s*\{[^}]*flex:\s*0 0 auto[^}]*\}/,
    );
  });

  it("empty-mode CSS does NOT re-declare flex:1 or a min-height that would defeat the collapse", () => {
    // Anti-regression: someone re-adding `flex: 1` or a `min-height:
    // calc(100vh - …)` inside the [data-mode="empty"] selector would
    // reintroduce the visual bug.
    const emptyRuleMatch = GLOBALS.match(
      /\.spectre-dw-table-wrap\[data-mode="empty"\]\s*\{([^}]*)\}/,
    );
    expect(emptyRuleMatch).not.toBeNull();
    const rule = emptyRuleMatch![1];
    expect(rule).not.toMatch(/flex:\s*1\b/);
    expect(rule).not.toMatch(/min-height:\s*(?!0)/);
  });

  it("the founder-required empty-state copy is preserved", () => {
    // Section 5 — do not change the copy.
    expect(CLIENT).toMatch(/The Chart of Accounts is empty\./);
    expect(CLIENT).toMatch(/Start by importing your Chart of Accounts from a CSV/);
  });

  it("EmptyStateForView(totalRows=0) still renders the founder copy (Section 5)", () => {
    // The routing rule: when totalRows === 0 the empty state uses
    // the founder-approved copy regardless of savedView.
    expect(CLIENT).toMatch(/if \(totalRows === 0\) \{[\s\S]*?The Chart of Accounts is empty\./);
  });
});
