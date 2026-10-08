// COA-MAP-3D (2026-10-08) — whole-row drag · every non-interactive
// cell is a valid grab point.
//
// Founder requirement, verbatim: "Every non-interactive part of the
// entire account row must support click-and-hold dragging — number,
// name, type, FS Group, department, fund, balance, status, and empty
// space within any cell.  Only interactive controls (checkboxes,
// buttons, menus, form inputs) should be excluded."
//
// This is a REGRESSION-GUARD slice.  The code already supports the
// requirement after COA-MAP-3C (which removed `A` + `role="link"`
// from the interactive-target exclusion list).  These pins protect
// against future drift that would re-break whole-row drag:
//
//   §A  isInteractiveTarget lists ONLY the directive-approved
//       blocking tags — INPUT, BUTTON, SELECT, TEXTAREA, LABEL —
//       and refuses to add any other tag.  Adding `SPAN`, `DIV`,
//       `TD`, `TR`, `A`, or `IMG` would silently take entire
//       columns out of the drag region.
//
//   §B  Role-based exclusions are limited to the three directive-
//       approved roles — button, menuitem, checkbox — and refuse
//       to re-add `link` (COA-MAP-3C removed it).
//
//   §C  AccountRow passes onPointerDown on the ENTIRE <tr> (not a
//       dedicated handle wrapper), so every cell inside the row
//       inherits the gesture.
//
//   §D  The browser matrix spec lives at the canonical path for
//       the staging run.

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO     = path.resolve(__dirname, "..");
const HOOK     = path.join(REPO, "src/components/coa-mapping/useAccountDrag.tsx");
const COA_UI   = path.join(REPO, "src/components/data-workspace/ChartOfAccountsClient.tsx");
const MATRIX   = path.join(REPO, "tests/e2e/coa-map-3d-column-matrix.staging.spec.ts");

describe("COA-MAP-3D §A — tag exclusion list is exactly the directive-approved blockers", () => {
  const src = readFileSync(HOOK, "utf8");

  it("blocks exactly INPUT / BUTTON / SELECT / TEXTAREA / LABEL — no more, no less", () => {
    // The exact literal from the directive's "excluded controls" list.
    expect(src).toMatch(/t === "INPUT" \|\| t === "BUTTON" \|\| t === "SELECT" \|\| t === "TEXTAREA" \|\| t === "LABEL"/);
  });

  it("does NOT re-add `A` (anchor) — COA-MAP-3C removed it, 3D keeps it out", () => {
    // Re-adding `t === "A"` would reinstate the exact regression the
    // founder reported.  The matrix test (name-link column) also
    // proves at runtime that anchors remain drag-eligible.
    expect(src).not.toMatch(/t === "A"/);
  });

  it("does NOT list SPAN / DIV / TD / TR / IMG / SVG — adding any of these would silently block entire columns", () => {
    // Status cell pills, fund chips, balance values, type/fs-group
    // labels, and the row element itself are all plain spans / tds /
    // divs — the whole-row drag requirement forbids blocking them.
    expect(src).not.toMatch(/t === "SPAN"/);
    expect(src).not.toMatch(/t === "DIV"/);
    expect(src).not.toMatch(/t === "TD"/);
    expect(src).not.toMatch(/t === "TR"/);
    expect(src).not.toMatch(/t === "IMG"/);
    expect(src).not.toMatch(/t === "SVG"/);
  });
});

describe("COA-MAP-3D §B — role exclusion list is exactly button / menuitem / checkbox", () => {
  const src = readFileSync(HOOK, "utf8");

  it("blocks exactly role=button / role=menuitem / role=checkbox", () => {
    expect(src).toMatch(/role === "button" \|\| role === "menuitem" \|\| role === "checkbox"/);
  });

  it("does NOT re-add role=\"link\" — 3C removed it, 3D keeps it out", () => {
    expect(src).not.toMatch(/role === "link"/);
  });

  it("does NOT list role=\"row\" / role=\"cell\" / role=\"gridcell\" — adding would silently block the row and its cells", () => {
    expect(src).not.toMatch(/role === "row"/);
    expect(src).not.toMatch(/role === "cell"/);
    expect(src).not.toMatch(/role === "gridcell"/);
  });
});

describe("COA-MAP-3D §C — AccountRow attaches onPointerDown to the <tr>, not a dedicated handle", () => {
  const src = readFileSync(COA_UI, "utf8");

  it("the <tr> element carries onPointerDown with the entire-row-drag gate", () => {
    expect(src).toMatch(/onPointerDown=\{dragEnabled \? \(e\) => onRowPointerDown!/);
    expect(src).toMatch(/const dragEnabled = !!onRowPointerDown && !fundMode && canEdit;/);
  });

  it("no stand-alone drag-handle testid is reintroduced", () => {
    // A dedicated handle (e.g. the old six-dot <span draggable>)
    // would signal that drag is handle-only — the opposite of the
    // whole-row requirement.
    expect(src).not.toMatch(/data-testid=\{`coa-mapping-drag-handle-/);
    expect(src).not.toMatch(/<span\s*\n?\s*draggable/);
  });

  it("Name <Link>'s onClick stopPropagation does NOT swallow pointerdown — drag can still arm on name", () => {
    // The Link stops `click` propagation to the TR so the Inspector
    // doesn't open when the user navigates to the GL account page.
    // It must NOT stop `pointerdown` propagation — otherwise the
    // useAccountDrag hook on the TR would never see it.
    const linkIdx = src.indexOf("name-text");
    expect(linkIdx).toBeGreaterThan(0);
    const linkBlock = src.slice(linkIdx, linkIdx + 400);
    expect(linkBlock).toMatch(/onClick=\{\(e\) => e\.stopPropagation\(\)\}/);
    // Must NOT be onPointerDownCapture / onPointerDown stopping.
    expect(linkBlock).not.toMatch(/onPointerDown=\{\(e\) => e\.stopPropagation\(\)\}/);
    expect(linkBlock).not.toMatch(/onPointerDownCapture=/);
  });
});

describe("COA-MAP-3D §D — browser matrix spec exists at the canonical path", () => {
  it("tests/e2e/coa-map-3d-column-matrix.staging.spec.ts exists", () => {
    expect(existsSync(MATRIX)).toBe(true);
  });

  const src = readFileSync(MATRIX, "utf8");

  it("probes all 11 column positions — 9 drag-eligible + 2 blocked", () => {
    for (const label of [
      "01-select-cell-checkbox",
      "02-num-col",
      "03-name-link",
      "04-name-cell-whitespace",
      "05-type-tag",
      "06-fsgroup-tag",
      "07-dept-tag",
      "08-fund-chip",
      "09-balance-cell",
      "10-status-flags",
      "11-actions-button",
    ]) {
      expect(src).toContain(label);
    }
  });

  it("checkbox toggle + menu open preservation checks are present", () => {
    expect(src).toMatch(/COA_MAP_3D_CHECKBOX_TOGGLE/);
    expect(src).toMatch(/COA_MAP_3D_MENU_OPEN/);
  });

  it("end-to-end drop-from-non-name-column check (flags cell → drawer → cancel) is present", () => {
    expect(src).toMatch(/COA_MAP_3D_FLAGS_DRAG_OVERLAY/);
    expect(src).toMatch(/COA_MAP_3D_FLAGS_DRAWER_OPENED/);
    expect(src).toMatch(/COA_MAP_3D_FLAGS_CANCEL_SAFE/);
  });
});
