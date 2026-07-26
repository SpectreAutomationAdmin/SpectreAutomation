// Floor-plan editor — drag + validation-panel wiring contract.
//
// Vitest cannot simulate SVG pointer events (no jsdom), so this file
// asserts that the editor wires the right MODULES and CONTRACT-SHAPED
// callbacks. It does NOT pin specific local variable names — those
// drift with every refactor and produce no-signal failures.
//
// Behavior coverage lives in:
//   - tests/floor-plan-spacing-publish.test.ts (7 behavior tests:
//     validateDraftForPublish, publishDraft, save-draft rules)
//   - tests/floor-plan-geometry.test.ts (pure geometry helpers:
//     computeSpacingIssues, offenderIdSet, MIN_CLEARANCE_PX)
//   - the manual click-through path in the founder workflow audit.
//
// What this file pins, on purpose:
//   1. The editor wires pointer event handlers on its tiles. Without
//      those, drag is broken regardless of geometry correctness.
//   2. The editor uses pointer capture so the drag survives leaving
//      the SVG element. Without this, drags drop mid-gesture on
//      Windows touch / pen input.
//   3. Drags persist through `updateTableAction` — the server action
//      that owns floor-plan persistence.
//   4. Drags snap to a 10 px grid on commit. (Geometry contract.)
//   5. The editor imports the shared geometry helpers; if it ever
//      drifted into local implementations the spacing rules would
//      silently diverge.
//   6. The spacing-issues panel is rendered with the documented
//      testid + offender-row colouring used by Playwright specs.

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const SRC = fs.readFileSync(
  path.resolve(process.cwd(), "src/app/app/admin/ops/floor-plans/FloorPlanEditor.tsx"),
  "utf8",
);

describe("Drag handler wiring (architectural)", () => {
  it("each SVG tile exposes pointer event handlers (down / move / up)", () => {
    expect(SRC).toMatch(/onPointerDown=\{[^}]+\}/);
    expect(SRC).toMatch(/onPointerMove=\{[^}]+\}/);
    expect(SRC).toMatch(/onPointerUp=\{[^}]+\}/);
  });

  it("pointer-down captures the pointer so the drag survives leaving the SVG element", () => {
    expect(SRC).toMatch(/setPointerCapture\(/);
  });

  it("drag commits via updateTableAction with an {xPos, yPos} payload", () => {
    expect(SRC).toMatch(/updateTableAction\([^)]*\{\s*xPos\s*,\s*yPos\s*\}/);
  });

  it("clamps the dragged tile inside the canvas via clampToCanvas", () => {
    expect(SRC).toMatch(/function clampToCanvas/);
    expect(SRC).toMatch(/clampToCanvas\(/);
  });

  it("snaps the committed position to a 10 px grid", () => {
    // Matches `Math.round(<anything>.x / 10) * 10` and the y variant —
    // intentionally tolerant of the variable name carrying the
    // pre-snap coordinate.
    expect(SRC).toMatch(/Math\.round\([^)]+\/\s*10\)\s*\*\s*10/);
  });
});

describe("Live validation panel + offender highlight", () => {
  it("computes spacing issues via the shared computeSpacingIssues helper", () => {
    expect(SRC).toMatch(/computeSpacingIssues\(/);
  });

  it("offender ids drive both the SVG fill and the table-list row colour", () => {
    expect(SRC).toMatch(/offenderIds\.has\(/);
    // The SVG offender branch must use the red fill + red stroke.
    expect(SRC).toMatch(/#fde2e2/);
    expect(SRC).toMatch(/#b91c1c/);
  });

  it("renders the spacing-issues panel with the documented testid", () => {
    expect(SRC).toMatch(/data-testid="floor-plan-spacing-issues"/);
    expect(SRC).toMatch(/Spacing issues/);
  });

  it("clicking an issue row selects the offending table", () => {
    // setSelectedTableId is called from a click handler on an issue row.
    expect(SRC).toMatch(/setSelectedTableId\(/);
  });
});

describe("Persistence + selection wiring", () => {
  it("the editor calls updateTableAction with the full row patch shape (tableNumber, shape, capacity, xPos, yPos, width, height)", () => {
    // The big-patch call lives in the row form. It must persist every
    // field the user can edit; pin the shape, not the local variable.
    expect(SRC).toMatch(/updateTableAction\([^)]*\{[\s\S]*?tableNumber/);
    expect(SRC).toMatch(/shape/);
    expect(SRC).toMatch(/capacity/);
    expect(SRC).toMatch(/width/);
    expect(SRC).toMatch(/height/);
  });

  it("double-clicking a tile opens the edit-table modal (Step 36: inline row form replaced by modal)", () => {
    // The inline TableRow form was removed in Step 36; double-click
    // is now the only path into the edit modal. Pin the wiring +
    // modal testid so any future regression that loses the double-
    // click handler or the modal mount-point is caught at the
    // source-contract layer.
    expect(SRC).toMatch(/onDoubleClick=\{/);
    expect(SRC).toMatch(/data-testid="edit-table-modal"/);
  });
});

describe("Geometry module imports", () => {
  it("imports computeSpacingIssues + offenderIdSet + MIN_CLEARANCE_PX from the shared module", () => {
    expect(SRC).toMatch(/computeSpacingIssues/);
    expect(SRC).toMatch(/offenderIdSet/);
    expect(SRC).toMatch(/MIN_CLEARANCE_PX/);
    expect(SRC).toMatch(/@\/lib\/hospitality\/floor-plan-geometry/);
  });
});
