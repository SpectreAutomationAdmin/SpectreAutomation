// COA-MAP-2D (2026-10-06) — layout regression repair.
//
// The founder reported a visual regression on /app/admin/coa:
// enormous blank vertical area between the search/filter toolbar
// and the next piece of content.  The DOM probe confirmed the
// Account List table/column header renders correctly top-aligned,
// BUT the adjacent Inspector-column empty state was vertically
// centred inside its full-height column — producing a ~240 px
// cream band immediately beside the toolbar that read as a
// pushed-down table.
//
// Root cause: `.spectre-dw-inspector-empty` had
// `justify-content: center`.
//
// §A  Fix: top-align the empty state via `justify-content: flex-start`.
// §B  The fix is a pure CSS layout change — no inline styles, no
//     negative margins, no viewport-specific offsets.

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO = path.resolve(__dirname, "..");
const CSS  = path.join(REPO, "src/app/globals.css");

describe("COA-MAP-2D §A — Inspector empty state top-aligned", () => {
  const css = readFileSync(CSS, "utf8");

  it(".spectre-dw-inspector-empty uses justify-content: flex-start (NOT center)", () => {
    // Scope the match to the single declaration line so a hover /
    // modifier rule elsewhere in the file can't accidentally pass
    // the assertion.
    const re = /\.spectre-dw-inspector-empty\s*\{[^}]*justify-content:\s*flex-start/;
    expect(css).toMatch(re);
    // Hard-fail the regressed form:
    expect(css).not.toMatch(/\.spectre-dw-inspector-empty\s*\{[^}]*justify-content:\s*center/);
  });

  it("fix is pure CSS — no inline style, no !important hack, no viewport-specific media offset", () => {
    const emptyIdx = css.indexOf(".spectre-dw-inspector-empty");
    const slice = css.slice(emptyIdx, emptyIdx + 400);
    // No negative margins, no fixed-position bandaids.
    expect(slice).not.toMatch(/margin-top:\s*-/);
    expect(slice).not.toMatch(/position:\s*absolute/);
    expect(slice).not.toMatch(/!important/);
    // No hardcoded 1440x900 offset.
    expect(slice).not.toMatch(/top:\s*\d{3,}px/);
  });
});

describe("COA-MAP-2D §B — Account List vertical layout chain preserved", () => {
  const css = readFileSync(CSS, "utf8");

  it(".spectre-dw-table-wrap keeps flex: 1 + overflow: auto (preserves COA-MAP-2C auto-scroll owner)", () => {
    expect(css).toMatch(/\.spectre-dw-table-wrap\s*\{[^}]*flex:\s*1[^}]*overflow:\s*auto/);
  });

  it(".spectre-dw-root keeps the locked viewport contract (height: calc + overflow: hidden)", () => {
    const idx = css.indexOf(".spectre-dw-root ");
    const slice = css.slice(idx, idx + 400);
    expect(slice).toMatch(/height:\s*calc\(100vh/);
    expect(slice).toMatch(/overflow:\s*hidden/);
  });

  it(".spectre-dw-main does NOT use justify-content: flex-end (never bottom-aligns its children)", () => {
    const idx = css.indexOf(".spectre-dw-main ");
    if (idx < 0) return;
    const slice = css.slice(idx, idx + 400);
    expect(slice).not.toMatch(/justify-content:\s*flex-end/);
  });
});
