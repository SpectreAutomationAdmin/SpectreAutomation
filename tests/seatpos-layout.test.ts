// POS cleanup step 21 — SeatPOS layout contract.
//
// The reported failure: with many items on a seat, the entire page
// scrolled and the "Send to kitchen / bar" + "Split & settle" buttons
// dropped off-screen. Root cause: the page itself scrolled (no
// viewport lock), the active-seat card grew unbounded with line
// count, and the action bar was in normal flow inside the same
// scrolling parent.
//
// The fix is a three-zone, viewport-locked grid:
//   - Header (compact)
//   - Workspace: LEFT menu panel (dominant, 1fr) + RIGHT side rail (360px)
//   - Sticky footer (outside all scroll containers)
//
// These tests pin the contract that future edits cannot silently
// break — source-contract assertions on SeatPOS.tsx since there's
// no Playwright in this repo and the layout is structural enough
// that a regex on the JSX is decisive. Pair with the existing
// runtime suites for ordering / modifiers / send / settle / QR to
// prove the workflows themselves still function.

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const SEAT_POS_PATH = path.resolve(
  process.cwd(),
  "src/app/app/admin/ops/pos/lounge/table/[checkId]/SeatPOS.tsx",
);
const SRC = fs.readFileSync(SEAT_POS_PATH, "utf8");

// =============================================================================
// Spec 1 — Menu panel occupies the majority of horizontal space.
// =============================================================================
describe("Spec 1 — menu panel is the dominant column", () => {
  it("workspace grid is `1fr` on the left and `360px` on the right (menu wins)", () => {
    // The grid template puts the flexible 1fr column FIRST so the
    // menu (which is the lg:order-default first child) gets it.
    expect(SRC).toMatch(/lg:grid-cols-\[minmax\(0,1fr\)_360px\]/);
  });

  it("menu panel is rendered as the first grid child (the 1fr track)", () => {
    // The `data-testid="seatpos-menu-panel"` block must appear in
    // the source BEFORE the side-rail block — same DOM order = same
    // grid order (no `order-` overrides).
    const menuIdx = SRC.indexOf('data-testid="seatpos-menu-panel"');
    const railIdx = SRC.indexOf('data-testid="seatpos-side-rail"');
    expect(menuIdx).toBeGreaterThan(0);
    expect(railIdx).toBeGreaterThan(menuIdx);
  });
});

// =============================================================================
// Spec 2 — Seat/check panel occupies the minority of horizontal space.
// =============================================================================
describe("Spec 2 — side rail is the narrower track", () => {
  it("side rail is the fixed 360px track on lg+", () => {
    expect(SRC).toMatch(/lg:grid-cols-\[minmax\(0,1fr\)_360px\]/);
  });

  it("side rail renders the SeatStrip (table visual) inside it", () => {
    // The SeatStrip must live INSIDE the side-rail container, not in
    // the menu panel.
    const railIdx = SRC.indexOf('data-testid="seatpos-side-rail"');
    const railEnd = SRC.indexOf("</aside>", railIdx);
    const railBlock = SRC.slice(railIdx, railEnd);
    expect(railBlock).toMatch(/<SeatStrip/);
  });
});

// =============================================================================
// Spec 3 — Action bar is outside any scrolling container.
// =============================================================================
describe("Spec 3 — action bar is outside scroll containers", () => {
  it("the action bar is a SIBLING of the workspace, not nested inside it", () => {
    const workspaceIdx = SRC.indexOf('data-testid="seatpos-workspace"');
    const actionBarIdx = SRC.indexOf('data-testid="seatpos-action-bar"');
    expect(workspaceIdx).toBeGreaterThan(0);
    expect(actionBarIdx).toBeGreaterThan(workspaceIdx);

    // Between the workspace open tag and the action bar, there must
    // be a closing `</div>` for the workspace — otherwise the action
    // bar is nested inside it.
    const between = SRC.slice(workspaceIdx, actionBarIdx);
    expect(between).toMatch(/<\/div>/);
  });

  it("action bar has `flex-shrink-0` so it never collapses out of the layout", () => {
    const idx = SRC.indexOf('data-testid="seatpos-action-bar"');
    expect(idx).toBeGreaterThan(0);
    // The next 400 chars after the testid contain the className —
    // assert flex-shrink-0 is part of it.
    const tagSlice = SRC.slice(idx, idx + 400);
    expect(tagSlice).toMatch(/flex-shrink-0/);
  });

  it("action bar element is not inside an overflow-y-auto container", () => {
    // Reasonable structural proof: the closest ancestor scroll
    // container of the action bar would have to appear between the
    // shell root and the bar. Verify the bar is a direct child of
    // the shell flex column by checking it sits between the
    // workspace `</div>` and the final shell `</div>`.
    const shellIdx = SRC.indexOf('data-testid="seatpos-shell"');
    const barIdx = SRC.indexOf('data-testid="seatpos-action-bar"');
    expect(barIdx).toBeGreaterThan(shellIdx);
    // No `overflow-y-auto` appears immediately wrapping the action
    // bar — assert by scanning a small window around it.
    const windowAroundBar = SRC.slice(Math.max(0, barIdx - 200), barIdx);
    expect(windowAroundBar).not.toMatch(/overflow-y-auto[^"]*"\s*>?\s*$/);
  });
});

// =============================================================================
// Spec 4 — Send button remains visible with many items (structural proof).
// Spec 5 — Split & settle remains visible with many items (structural proof).
// =============================================================================
describe("Specs 4/5 — Send + Split & settle are pinned to the sticky footer", () => {
  it("the Send button is rendered inside the action-bar footer", () => {
    const barIdx = SRC.indexOf('data-testid="seatpos-action-bar"');
    const barEnd = SRC.indexOf("</footer>", barIdx);
    expect(barIdx).toBeGreaterThan(0);
    expect(barEnd).toBeGreaterThan(barIdx);
    const barBlock = SRC.slice(barIdx, barEnd);
    expect(barBlock).toMatch(/Send to kitchen \/ bar/);
  });

  it("SplitSettleButton is rendered inside the action-bar footer", () => {
    const barIdx = SRC.indexOf('data-testid="seatpos-action-bar"');
    const barEnd = SRC.indexOf("</footer>", barIdx);
    const barBlock = SRC.slice(barIdx, barEnd);
    expect(barBlock).toMatch(/<SplitSettleButton/);
  });

  it("the shell is viewport-locked (`h-[calc(100vh-` ...) so the footer cannot scroll off", () => {
    expect(SRC).toMatch(/data-testid="seatpos-shell"[\s\S]*?h-\[calc\(100vh-/);
  });
});

// =============================================================================
// Spec 6 — Long seat item lists scroll internally.
// =============================================================================
describe("Spec 6 — active-seat lines scroll internally", () => {
  it("the active-seat container has `overflow-y-auto` and `min-h-0`", () => {
    const idx = SRC.indexOf('data-testid="seatpos-active-seat"');
    expect(idx).toBeGreaterThan(0);
    const tagSlice = SRC.slice(idx, idx + 400);
    expect(tagSlice).toMatch(/overflow-y-auto/);
    expect(tagSlice).toMatch(/min-h-0/);
  });
});

// =============================================================================
// Spec 7 — Long menu / item lists scroll internally.
// =============================================================================
describe("Spec 7 — menu items grid scrolls internally", () => {
  it("menu panel has min-h-0 + flex column so its child can scroll", () => {
    const idx = SRC.indexOf('data-testid="seatpos-menu-panel"');
    expect(idx).toBeGreaterThan(0);
    const tagSlice = SRC.slice(idx, idx + 400);
    expect(tagSlice).toMatch(/min-h-0/);
    expect(tagSlice).toMatch(/flex-col|flex .* flex-col/);
  });

  it("the items grid inside the menu panel has overflow-y-auto and min-h-0 flex-1", () => {
    // Scan the entire menu-panel block — step 22 moved the items
    // grid inside an IIFE that builds tier-aware classNames, so a
    // fixed-window slice can miss it. The block-bounded slice is
    // resilient to that kind of inner refactor.
    const panelIdx = SRC.indexOf('data-testid="seatpos-menu-panel"');
    const panelEnd = SRC.indexOf("</main>", panelIdx);
    expect(panelIdx).toBeGreaterThan(0);
    expect(panelEnd).toBeGreaterThan(panelIdx);
    const panelBlock = SRC.slice(panelIdx, panelEnd);
    expect(panelBlock).toMatch(/overflow-y-auto/);
    expect(panelBlock).toMatch(/min-h-0/);
    expect(panelBlock).toMatch(/flex-1/);
  });
});

// =============================================================================
// Specs 8 / 9 / 10 / 11 / 12 — Existing workflows still function.
//
// The layout refactor must not have touched the action handlers,
// component props, or any service-layer code. Assert that every
// pre-existing action/component reference is still present in the
// file — this is a cheap canary that catches accidental deletions.
// =============================================================================
describe("Specs 8/9/10/11/12 — pre-existing workflows still wired up", () => {
  it("ordering workflow: addSeatItemAction is still imported + invoked", () => {
    expect(SRC).toMatch(/import [\s\S]*?addSeatItemAction[\s\S]*?from "\.\.\/_actions"/);
    expect(SRC).toMatch(/addSeatItemAction\(/);
  });

  it("modifier workflow: SeatModifierModal + setSeatLineModifiersAction still wired", () => {
    expect(SRC).toMatch(/<SeatModifierModal/);
    expect(SRC).toMatch(/setSeatLineModifiersAction\(/);
  });

  it("send-to-kitchen workflow: sendSeatItemsAction still imported + runSend still defined", () => {
    expect(SRC).toMatch(/sendSeatItemsAction[\s\S]*?from "\.\.\/_actions"/);
    expect(SRC).toMatch(/function runSend\(\)/);
    expect(SRC).toMatch(/sendSeatItemsAction\(checkId\)/);
  });

  it("split-and-settle workflow: SplitSettleButton + settleBySeatsAction still present", () => {
    expect(SRC).toMatch(/<SplitSettleButton/);
    expect(SRC).toMatch(/settleBySeatsAction\(/);
  });

  it("QR payment workflow: all four QR actions are still imported + wired", () => {
    expect(SRC).toMatch(/initiateQRPaymentAction/);
    expect(SRC).toMatch(/getQRPaymentStatusAction/);
    expect(SRC).toMatch(/cancelQRPaymentAction/);
    expect(SRC).toMatch(/simulateQRPaymentAction/);
  });
});

// =============================================================================
// Bonus — visual priority. The menu's category strip must NOT render
// every category expanded vertically at once; it remains a chip row
// that switches the items grid in place.
// =============================================================================
describe("Bonus — single-category-at-a-time menu rendering", () => {
  it("activeCat state still gates which category's items render", () => {
    expect(SRC).toMatch(/menu\.find\(\(c\) => c\.id === activeCat\)/);
  });

  it("category chips remain a flex-wrap row, not a vertical list", () => {
    const idx = SRC.indexOf('data-testid="seatpos-menu-panel"');
    const next1500 = SRC.slice(idx, idx + 2500);
    expect(next1500).toMatch(/flex[\s\S]*?flex-wrap/);
  });
});
