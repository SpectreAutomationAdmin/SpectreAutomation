// POS cleanup step 22 — adaptive menu-tile density.
//
// Reported failures:
//   - Item tiles stretched to fill the menu panel when a category
//     only had a few items (e.g. Desserts with 3).
//   - The fixed `md:grid-cols-2` couldn't scale to more items: when
//     a category grew past ~12 items the tiles became uncomfortably
//     dense in just two columns while wasting horizontal room.
//
// The fix introduces three density tiers (normal/compact/dense)
// driven by the active category's item count, and uses an
// auto-fill + minmax grid template plus `gridAutoRows: min-content`
// + `alignContent: start` so:
//   - Tiles never stretch vertically with few items.
//   - More items repack into more columns automatically.
//   - F&B Manager edits to the menu can't break the layout — there
//     are no hardcoded item counts.
//
// These tests pin the contract by source-asserting the three tiers,
// the auto-fill grid template, and the stretch-prevention CSS.

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const SEAT_POS_PATH = path.resolve(
  process.cwd(),
  "src/app/app/admin/ops/pos/lounge/table/[checkId]/SeatPOS.tsx",
);
const SRC = fs.readFileSync(SEAT_POS_PATH, "utf8");

// Convenience: the items-grid block as a slice for targeted regexes.
function itemsGridBlock(): string {
  const start = SRC.indexOf('data-testid="seatpos-menu-items"');
  expect(start).toBeGreaterThan(0);
  // The grid is rendered from inside an IIFE; pick a generous window
  // so the regexes can match the surrounding tile button (which
  // grew in step 26 with per-item description-class logic) as well.
  return SRC.slice(Math.max(0, start - 4500), start + 5500);
}

// =============================================================================
// Spec 1 — Category with 3 items uses default tile size and does not stretch.
// =============================================================================
describe("Spec 1 — few items: normal tile size, no vertical stretch", () => {
  it("the items grid uses gridAutoRows: 'min-content' so rows hug content", () => {
    expect(itemsGridBlock()).toMatch(/gridAutoRows:\s*["']min-content["']/);
  });

  it("the items grid uses alignContent: 'start' so rows stack at the top", () => {
    expect(itemsGridBlock()).toMatch(/alignContent:\s*["']start["']/);
  });

  it("the items grid uses justifyContent: 'start' so tiles don't stretch horizontally to fill", () => {
    expect(itemsGridBlock()).toMatch(/justifyContent:\s*["']start["']/);
  });
});

// =============================================================================
// Spec 2 — Category with 8 items uses normal/descriptive tier (≤14 → descriptive).
// Spec 3 — Category with 18 items uses standard/compact tier (15–22 in step 23).
// Spec 4 — Category with 35 items uses dense scrollable grid (31+ in step 23).
//
// Step 22 set the original (3-tier) thresholds. Step 23 split the
// middle into a "standard" tier so beverage categories like Wine
// and Beer · Draught keep their descriptions instead of collapsing
// to name+price only. The threshold values now live in
// getMenuTileDensity — boundary behavior is unit-tested in
// tests/menu-density.test.ts. Here we only assert the SeatPOS
// integration: the helper is imported + invoked, and its output
// drives the grid.
// =============================================================================
describe("Specs 2/3/4 — SeatPOS delegates tile density to the helper", () => {
  it("imports getMenuTileDensity from the shared helper", () => {
    // Step 26 added a sibling import (`getDescriptionTextClass`) on
    // the same line — the assertion only cares that the menu-density
    // helper is imported from the canonical path.
    expect(SRC).toMatch(/import \{[\s\S]*?getMenuTileDensity[\s\S]*?\} from "@\/lib\/pos\/menu-density"/);
  });

  it("invokes getMenuTileDensity with the active category's itemCount", () => {
    expect(itemsGridBlock()).toMatch(/getMenuTileDensity\(\{\s*itemCount:\s*items\.length\s*\}\)/);
  });

  it("the items grid scrolls internally (overflow-y-auto on the grid container)", () => {
    expect(itemsGridBlock()).toMatch(/data-testid="seatpos-menu-items"[\s\S]*?overflow-y-auto/);
  });
});

// =============================================================================
// Spec 5 — Tiles do not expand to full panel height with few items.
// =============================================================================
describe("Spec 5 — tiles never expand to full panel height", () => {
  it("alignContent + gridAutoRows together prevent vertical stretching", () => {
    expect(itemsGridBlock()).toMatch(/alignContent:\s*["']start["']/);
    expect(itemsGridBlock()).toMatch(/gridAutoRows:\s*["']min-content["']/);
  });

  it("tile height comes from the density config (step 29: cfg.tileHeight)", () => {
    expect(itemsGridBlock()).toMatch(/height:\s*cfg\.tileHeight/);
  });
});

// =============================================================================
// Spec 6 — Item grid stays inside the menu panel.
// =============================================================================
describe("Spec 6 — items grid is bounded by the menu panel", () => {
  it("items grid lives INSIDE the seatpos-menu-panel block", () => {
    const panelIdx = SRC.indexOf('data-testid="seatpos-menu-panel"');
    const itemsIdx = SRC.indexOf('data-testid="seatpos-menu-items"');
    const panelEnd = SRC.indexOf("</main>", panelIdx);
    expect(panelIdx).toBeGreaterThan(0);
    expect(panelEnd).toBeGreaterThan(panelIdx);
    expect(itemsIdx).toBeGreaterThan(panelIdx);
    expect(itemsIdx).toBeLessThan(panelEnd);
  });

  it("items grid uses min-h-0 flex-1 so it fills the panel without overflowing it", () => {
    expect(itemsGridBlock()).toMatch(/data-testid="seatpos-menu-items"[\s\S]*?min-h-0/);
    expect(itemsGridBlock()).toMatch(/data-testid="seatpos-menu-items"[\s\S]*?flex-1/);
  });
});

// =============================================================================
// Spec 7 — Sticky action bar remains visible regardless of menu size.
//          (Step 21 contract; re-asserted here so a future menu refactor
//           that nests the bar inside the panel is caught.)
// =============================================================================
describe("Spec 7 — sticky action bar remains a sibling of the workspace", () => {
  it("the action bar is rendered AFTER the workspace closes", () => {
    const workspaceIdx = SRC.indexOf('data-testid="seatpos-workspace"');
    const actionBarIdx = SRC.indexOf('data-testid="seatpos-action-bar"');
    expect(workspaceIdx).toBeGreaterThan(0);
    expect(actionBarIdx).toBeGreaterThan(workspaceIdx);
  });

  it("the action bar still carries flex-shrink-0 so the menu can't squeeze it out", () => {
    const idx = SRC.indexOf('data-testid="seatpos-action-bar"');
    const tagSlice = SRC.slice(idx, idx + 400);
    expect(tagSlice).toMatch(/flex-shrink-0/);
  });
});

// =============================================================================
// Spec 8 — Category controls remain usable with many items.
// =============================================================================
describe("Spec 8 — category chip row stays anchored above the scrolling grid", () => {
  it("category chip row uses flex-shrink-0 so it doesn't scroll out of view", () => {
    const panelIdx = SRC.indexOf('data-testid="seatpos-menu-panel"');
    const itemsIdx = SRC.indexOf('data-testid="seatpos-menu-items"');
    const chipsBlock = SRC.slice(panelIdx, itemsIdx);
    // The chip row is the `flex flex-wrap` row with the category buttons.
    expect(chipsBlock).toMatch(/flex-shrink-0[\s\S]*?menu\.map/);
  });
});

// =============================================================================
// Spec 9 — Item name and price remain visible across all density tiers.
// =============================================================================
describe("Spec 9 — item name + price always render", () => {
  it("name span uses the cfg.nameClass from the helper", () => {
    // Step 28 — interpolated into a template literal alongside the
    // tile's layout classes.
    expect(itemsGridBlock()).toMatch(/\$\{cfg\.nameClass\}/);
  });

  it("price span uses cfg.priceClass and is never conditionally hidden", () => {
    expect(itemsGridBlock()).toMatch(/className=\{cfg\.priceClass\}/);
    // No conditional render around the price.
    expect(itemsGridBlock()).not.toMatch(/showPrice/);
  });

  it("name + price classes are pulled from the density config (cfg.nameClass / cfg.priceClass)", () => {
    // Step 28 — name interpolates cfg.nameClass into a template-
    // literal className alongside layout classes; price still uses
    // {cfg.priceClass} directly.
    expect(itemsGridBlock()).toMatch(/\$\{cfg\.nameClass\}/);
    expect(itemsGridBlock()).toMatch(/className=\{cfg\.priceClass\}/);
  });
});

// =============================================================================
// Spec 10/11/12 — Existing workflows still wired up after the layout change.
// =============================================================================
describe("Specs 10/11/12 — existing add / modifier / send / settle / QR still wired", () => {
  it("add-item still routes through addSeatItemAction → runAdd(it.id)", () => {
    expect(SRC).toMatch(/addSeatItemAction[\s\S]*?from "\.\.\/_actions"/);
    expect(itemsGridBlock()).toMatch(/runAdd\(it\.id\)/);
  });

  it("modifier modal still rendered, setSeatLineModifiersAction still wired", () => {
    expect(SRC).toMatch(/<SeatModifierModal/);
    expect(SRC).toMatch(/setSeatLineModifiersAction\(/);
  });

  it("Send + Split & settle buttons remain in the action bar footer", () => {
    const barIdx = SRC.indexOf('data-testid="seatpos-action-bar"');
    const barEnd = SRC.indexOf("</footer>", barIdx);
    const barBlock = SRC.slice(barIdx, barEnd);
    expect(barBlock).toMatch(/Send to kitchen \/ bar/);
    expect(barBlock).toMatch(/<SplitSettleButton/);
  });

  it("QR payment actions still imported (no regression on step 19/20)", () => {
    expect(SRC).toMatch(/initiateQRPaymentAction/);
    expect(SRC).toMatch(/getQRPaymentStatusAction/);
    expect(SRC).toMatch(/simulateQRPaymentAction/);
  });
});

// =============================================================================
// Bonus — auto-fill template means F&B Manager can add items without
//          breaking the layout (no hardcoded item count).
// =============================================================================
describe("Bonus — adaptive grid template uses auto-fill so the layout scales with the menu", () => {
  it("grid-template-columns is `repeat(auto-fill, minmax(MIN, MAX))` driven by the helper", () => {
    // Step 24 — MAX is now `1fr` (when cfg.tileMax === "1fr") so
    // tiles share leftover panel width; the template builder picks
    // the token via a local `maxToken` const before interpolating.
    expect(itemsGridBlock()).toMatch(/repeat\(auto-fill,\s*minmax\(\$\{cfg\.tileMin\}px,\s*\$\{maxToken\}\)\)/);
    expect(itemsGridBlock()).toMatch(/const maxToken = cfg\.tileMax === ["']1fr["']/);
  });

  it("no fixed grid-cols-N class on the items grid (auto-fill drives the column count)", () => {
    // The items grid <div> should not carry grid-cols-1/2/3/4 classes.
    const idx = SRC.indexOf('data-testid="seatpos-menu-items"');
    const tagSlice = SRC.slice(idx, idx + 500);
    expect(tagSlice).not.toMatch(/className="[^"]*grid-cols-\d/);
    expect(tagSlice).not.toMatch(/md:grid-cols-\d/);
  });

  it("empty-category state surfaces a clear message instead of an empty void", () => {
    expect(itemsGridBlock()).toMatch(/No items in this category yet\./);
  });
});
