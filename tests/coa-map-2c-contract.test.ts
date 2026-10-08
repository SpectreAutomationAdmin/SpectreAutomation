// COA-MAP-2C (2026-10-06) — pointer-driven whole-row mapping drag.
//
// This slice replaces the HTML5 drag transport on the Chart of
// Accounts Account List with a pointer-driven implementation.  The
// canonical mapping APIs, Preview panel, drawer, and effective-
// dating are unchanged.  These pins protect the new interaction:
//
//   §A  useAccountDrag hook exists, exports both the hook + the
//       AccountDragOverlay component, and defines the key tuning
//       constants (threshold + edge zone + velocity curve).
//   §B  Click vs drag threshold is 6 px squared-distance.
//   §C  Overlay is fixed-position, transform-translated, pointer-
//       events: none so elementFromPoint sees through it.
//   §D  Source row fades via a data-attribute (no reflow / no
//       permanent style mutation).
//   §E  Drop target detection uses document.elementFromPoint walked
//       to the nearest [data-fs-group-id] ancestor.  Never derived
//       from text / fsGroupKey / fsGroupLabel.
//   §F  Interactive child exclusions (checkbox / button / link /
//       select / textarea / label / role=button / role=checkbox /
//       data-no-row-drag) preserve native click behaviour.
//   §G  Auto-scroll uses a quadratic velocity ramp (2 → 14 px/frame)
//       driven by LAST KNOWN pointer Y (not event rate).
//   §H  Shared Preview + drawer unchanged — one canonical mapping
//       workflow.

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO    = path.resolve(__dirname, "..");
const HOOK    = path.join(REPO, "src/components/coa-mapping/useAccountDrag.tsx");
const COA_UI  = path.join(REPO, "src/components/data-workspace/ChartOfAccountsClient.tsx");
const CSS     = path.join(REPO, "src/app/globals.css");
const DRAWER  = path.join(REPO, "src/components/coa-mapping/AccountListMappingDrawer.tsx");
const SHARED  = path.join(REPO, "src/components/coa-mapping/MappingPreviewPanel.tsx");

describe("COA-MAP-2C §A — useAccountDrag hook + overlay", () => {
  it("hook file exists", () => expect(existsSync(HOOK)).toBe(true));

  const src = readFileSync(HOOK, "utf8");

  it("exports both the hook and the overlay component", () => {
    expect(src).toMatch(/export function useAccountDrag\(/);
    expect(src).toMatch(/export function AccountDragOverlay\(/);
  });

  it("defines the required tuning constants", () => {
    expect(src).toMatch(/const DRAG_THRESHOLD_PX = 6;/);
    expect(src).toMatch(/const EDGE_ZONE_PX = 100;/);
    expect(src).toMatch(/const V_BASE_PX_PER_FRAME = 2;/);
    expect(src).toMatch(/const V_MAX_PX_PER_FRAME = 14;/);
  });
});

describe("COA-MAP-2C §B — click vs drag threshold", () => {
  const src = readFileSync(HOOK, "utf8");

  it("activate requires squared-distance >= threshold^2 before entering drag", () => {
    // Squared comparison avoids a Math.sqrt per pointermove.
    expect(src).toMatch(/dx \* dx \+ dy \* dy >= DRAG_THRESHOLD_PX \* DRAG_THRESHOLD_PX/);
  });

  it("below-threshold pointerup is a plain click (no drag event fired)", () => {
    expect(src).toMatch(/Below threshold — treat as a plain click/);
  });

  it("primary button only (ignores middle / right / stylus-eraser)", () => {
    expect(src).toMatch(/if \(e\.button !== 0\) return;/);
  });
});

describe("COA-MAP-2C §C — overlay motion", () => {
  const src = readFileSync(HOOK, "utf8");

  it("overlay is fixed-position, transform-translated, pointer-events: none", () => {
    expect(src).toMatch(/position:\s*"fixed"/);
    expect(src).toMatch(/transform:\s*`translate3d\(\$\{x\}px,\s*\$\{y\}px,\s*0\)`/);
    expect(src).toMatch(/pointerEvents:\s*"none"/);
    expect(src).toMatch(/willChange:\s*"transform"/);
  });

  it("overlay carries data-testid='coa-mapping-drag-overlay'", () => {
    expect(src).toMatch(/data-testid="coa-mapping-drag-overlay"/);
  });

  it("overlay renders account number + name (identity visible during drag)", () => {
    expect(src).toMatch(/\{info\.accountNumber\}/);
    expect(src).toMatch(/\{info\.accountName\}/);
  });

  it("overlay riding offset places it below+right of the pointer (not under cursor)", () => {
    expect(src).toMatch(/const x = pointer\.x \+ 14;/);
    expect(src).toMatch(/const y = pointer\.y - 10;/);
  });
});

describe("COA-MAP-2C §D — source row fade via data-attribute", () => {
  const src = readFileSync(HOOK, "utf8");
  const css = readFileSync(CSS, "utf8");

  it("activate() sets data-dragging-source on the source row element", () => {
    expect(src).toMatch(/setAttribute\("data-dragging-source",\s*"true"\)/);
  });

  it("cleanup() removes the data-dragging-source attribute", () => {
    expect(src).toMatch(/removeAttribute\("data-dragging-source"\)/);
  });

  it("globals.css fades the source row (no reflow — opacity only)", () => {
    expect(css).toMatch(/tr\.spectre-dw-row\[data-dragging-source="true"\]\s*\{[\s\S]*?opacity:\s*0\.35/);
  });

  it("transition is subtractive (160ms ease-out — no bounce / spring)", () => {
    expect(css).toMatch(/transition:\s*opacity 160ms ease-out/);
  });
});

describe("COA-MAP-2C §E — drop target detection via elementFromPoint", () => {
  const src = readFileSync(HOOK, "utf8");

  it("findFsGroupIdAtPoint uses document.elementFromPoint + closest(data-fs-group-id)", () => {
    expect(src).toMatch(/document\.elementFromPoint\(x,\s*y\)/);
    expect(src).toMatch(/\.closest\("\[data-fs-group-id\]"\)/);
  });

  it("destination id is read directly from getAttribute('data-fs-group-id') — never from text / fsGroupKey", () => {
    expect(src).toMatch(/target\.getAttribute\("data-fs-group-id"\)/);
    expect(src).not.toMatch(/fsGroupKey/);
    expect(src).not.toMatch(/fsGroupLabel\?.trim\(\)/);
  });

  it("empty-string fsGroupId is rejected (treated as 'no target')", () => {
    expect(src).toMatch(/id && id\.length > 0 \? id : null/);
  });
});

describe("COA-MAP-2C §F — interactive child exclusions", () => {
  const src = readFileSync(HOOK, "utf8");

  it("isInteractiveTarget covers inputs, buttons, selects, textareas, labels (COA-MAP-3C REMOVED <a>)", () => {
    // Links were intentionally removed from the exclusion list in
    // COA-MAP-3C: the account Name column wraps the name in a
    // <Link> to the GL account page; blocking drag on <a> broke
    // the founder's natural grab point on account rows.  See
    // tests/coa-map-3c-contract.test.ts for the full justification.
    expect(src).toMatch(/t === "INPUT" \|\| t === "BUTTON" \|\| t === "SELECT" \|\| t === "TEXTAREA" \|\| t === "LABEL"/);
    expect(src).not.toMatch(/t === "A"/);
  });

  it("role=button / role=menuitem / role=checkbox are excluded (COA-MAP-3C REMOVED role=link)", () => {
    expect(src).toMatch(/role === "button" \|\| role === "menuitem" \|\| role === "checkbox"/);
    expect(src).not.toMatch(/role === "link"/);
  });

  it("data-no-row-drag attribute lets callers opt a wrapper out of drag", () => {
    expect(src).toMatch(/hasAttribute\("data-no-row-drag"\)/);
  });

  it("onRowPointerDown bails out when the pointer-down target is interactive", () => {
    expect(src).toMatch(/if \(isInteractiveTarget\(e\.target\)\) return;/);
  });
});

describe("COA-MAP-2C §G — progressive quadratic auto-scroll", () => {
  const src = readFileSync(HOOK, "utf8");

  it("velocity curve is quadratic (t * t) — slow start, faster at the edge", () => {
    const matches = (src.match(/t \* t \* \(V_MAX_PX_PER_FRAME - V_BASE_PX_PER_FRAME\)/g) ?? []).length;
    expect(matches).toBeGreaterThanOrEqual(2); // one each for top and bottom edge
  });

  it("rAF loop reads the LAST KNOWN pointer Y (not event-rate driven)", () => {
    expect(src).toMatch(/const y = pointerRef\.current\.y;/);
    expect(src).toMatch(/requestAnimationFrame\(scrollStep\)/);
  });

  it("velocity profile is 2 (outer) → 14 (edge) — substantially slower than COA-MAP-2B (6 → 24)", () => {
    expect(src).toMatch(/V_BASE_PX_PER_FRAME = 2;/);
    expect(src).toMatch(/V_MAX_PX_PER_FRAME = 14;/);
    // Hard-fail if anyone tries to reinstate the aggressive ramp.
    expect(src).not.toMatch(/V_MAX_PX_PER_FRAME = 24/);
    expect(src).not.toMatch(/V_BASE_PX_PER_FRAME = 6/);
  });

  it("scroll owner is the first scrollable ancestor of the source row (not hardcoded)", () => {
    expect(src).toMatch(/findScrollableAncestor\(srcEl\)/);
  });
});

describe("COA-MAP-2C §H — canonical mapping workflow unchanged", () => {
  const drawer = readFileSync(DRAWER, "utf8");
  const shared = readFileSync(SHARED, "utf8");

  it("AccountListMappingDrawer still calls /api/admin/coa-mapping/preview", () => {
    expect(drawer).toMatch(/\/api\/admin\/coa-mapping\/preview/);
  });

  it("AccountListMappingDrawer still calls /api/admin/coa-mapping/accounts/{id}/reassign", () => {
    expect(drawer).toMatch(/\/api\/admin\/coa-mapping\/accounts\/\$\{accountId\}\/reassign/);
  });

  it("shared MappingPreviewPanel still exports the canonical type", () => {
    expect(shared).toMatch(/export type MappingPreviewResult/);
    expect(shared).toMatch(/export function MappingPreviewPanel/);
  });
});

describe("COA-MAP-2C §I — ChartOfAccountsClient wiring", () => {
  const src = readFileSync(COA_UI, "utf8");

  it("imports both the hook and the overlay", () => {
    expect(src).toMatch(/import \{ useAccountDrag, AccountDragOverlay \} from "@\/components\/coa-mapping\/useAccountDrag"/);
  });

  it("the HTML5 drag handle has been removed from AccountRow", () => {
    expect(src).not.toMatch(/data-testid=\{`coa-mapping-drag-handle-/);
    expect(src).not.toMatch(/<span\s*\n?\s*draggable/);
  });

  it("<tr> carries onPointerDown and the whole-row drag is gated by canEdit + !fundMode", () => {
    expect(src).toMatch(/onPointerDown=\{dragEnabled \? \(e\) => onRowPointerDown!/);
    expect(src).toMatch(/const dragEnabled = !!onRowPointerDown && !fundMode && canEdit;/);
  });

  it("mounts <AccountDragOverlay state={drag.state} /> for the floating representation", () => {
    expect(src).toMatch(/<AccountDragOverlay state=\{drag\.state\}/);
  });

  it("drag.onDrop callback opens the AccountListMappingDrawer", () => {
    expect(src).toMatch(/drag\.onDrop\(\(accountId,\s*targetFsGroupId\)\s*=>\s*\{[\s\S]*?setMappingDrop\(\{\s*accountId,\s*targetFsGroupId\s*\}\)/);
  });
});
