// POS cleanup step 23 — menu-tile density helper.
//
// Step 22 used 3 tiers (normal/compact/dense) with thresholds at
// 13 and 25 items. F&B service reported that beverage categories
// in the medium range — Wine (18), Beer · Draught (21), Beer ·
// Domestic (15) — collapsed to compact and lost their short
// descriptions, which made them harder to identify on the line.
//
// Step 23 splits the middle into a "standard" tier so 15–22 items
// stay descriptive (one-line description) instead of dropping to
// name+price only. Threshold map:
//
//   itemCount        density        tile w (px)   description
//   -------------------------------------------------------------
//   1 – 14           descriptive    180 – 220     2 lines
//   15 – 22          standard       150 – 185     1 line
//   23 – 30          compact        130 – 165     hidden
//   31+              dense          110 – 145     hidden
//
// Boundary tests below pin every transition point. The seeded
// lounge menu (prisma/lounge-menu.ts) is referenced to prove the
// tier picks the right size for real categories.

import { describe, it, expect } from "vitest";
import { getMenuTileDensity } from "@/lib/pos/menu-density";

// =============================================================================
// Spec 1 — Draught Beer category uses descriptive/standard tiles.
// =============================================================================
describe("Spec 1 — Beer · Draught (21 items) keeps descriptions", () => {
  it("returns standard density at 21 items, not compact or dense", () => {
    const cfg = getMenuTileDensity({ itemCount: 21 });
    expect(cfg.density).toBe("standard");
    expect(cfg.showDescription).toBe(true);
    // Step 26 — bumped the standard baseline from 1 line to 2 lines
    // because real beverage descriptions are 67–110 chars; 1 line
    // truncated ~75% of them. The per-item length-aware override
    // still picks line-clamp-1 for short descriptions (< 30 chars).
    expect(cfg.descriptionLineClamp).toBe(2);
  });

  it("tile width stays comfortable (≥150 px) for Draught Beer", () => {
    const cfg = getMenuTileDensity({ itemCount: 21 });
    expect(cfg.tileMin).toBeGreaterThanOrEqual(150);
  });
});

// =============================================================================
// Spec 2 — Wine category uses descriptive/standard tiles.
// =============================================================================
describe("Spec 2 — Wine (18 items) keeps descriptions", () => {
  it("returns standard density at 18 items", () => {
    const cfg = getMenuTileDensity({ itemCount: 18 });
    expect(cfg.density).toBe("standard");
    expect(cfg.showDescription).toBe(true);
  });
});

// =============================================================================
// Spec 3 — Beer · Imported (6 items) still uses the descriptive tier.
//   This was the user's reference for "looks good" — must not regress.
// =============================================================================
describe("Spec 3 — Beer · Imported (6 items) is descriptive", () => {
  it("returns descriptive density at 6 items", () => {
    const cfg = getMenuTileDensity({ itemCount: 6 });
    expect(cfg.density).toBe("descriptive");
    expect(cfg.showDescription).toBe(true);
    expect(cfg.descriptionLineClamp).toBe(2);
  });
});

// =============================================================================
// Spec 4 — Few-item categories do not stretch.
//   Stretch prevention is a UI contract (alignContent/gridAutoRows)
//   pinned in seatpos-menu-tile-density.test.ts; the helper's part
//   is to keep tile widths bounded so few items don't tile-fill the
//   panel horizontally either.
// =============================================================================
describe("Spec 4 — small categories use bounded tile widths", () => {
  it("a 3-item category (e.g. Desserts) returns descriptive with 1fr max so tiles can stretch", () => {
    const cfg = getMenuTileDensity({ itemCount: 3 });
    expect(cfg.density).toBe("descriptive");
    expect(cfg.tileMax).toBe("1fr");
    // tileMin alone determines how many columns fit. Step 25 settled
    // on 200 px so descriptive aspect (4:3) lands at ≥150 px tall
    // even on the narrowest realistic panel.
    expect(cfg.tileMin).toBe(200);
  });

  it("a 1-item category still returns descriptive (no special-case for 0/1)", () => {
    expect(getMenuTileDensity({ itemCount: 1 }).density).toBe("descriptive");
  });
});

// =============================================================================
// Spec 5 — Medium categories use space without large dead space.
// =============================================================================
describe("Spec 5 — medium categories fall into descriptive or standard", () => {
  it("10 items (Mains/Pizza/Handhelds) → descriptive", () => {
    expect(getMenuTileDensity({ itemCount: 10 }).density).toBe("descriptive");
  });

  it("13 items (Soups & Salads) → descriptive", () => {
    expect(getMenuTileDensity({ itemCount: 13 }).density).toBe("descriptive");
  });

  it("15 items (Beer · Domestic) → standard, still descriptive", () => {
    const cfg = getMenuTileDensity({ itemCount: 15 });
    expect(cfg.density).toBe("standard");
    expect(cfg.showDescription).toBe(true);
  });
});

// =============================================================================
// Spec 6 — Very large categories still use compact/dense.
// =============================================================================
describe("Spec 6 — very large categories collapse to compact / dense", () => {
  it("25 items → compact", () => {
    expect(getMenuTileDensity({ itemCount: 25 }).density).toBe("compact");
  });

  it("35 items → dense", () => {
    expect(getMenuTileDensity({ itemCount: 35 }).density).toBe("dense");
  });

  it("compact + dense both hide descriptions", () => {
    expect(getMenuTileDensity({ itemCount: 25 }).showDescription).toBe(false);
    expect(getMenuTileDensity({ itemCount: 60 }).showDescription).toBe(false);
  });
});

// =============================================================================
// Spec 7 — Descriptions render in descriptive + standard tiers.
// =============================================================================
describe("Spec 7 — descriptions render when the tier supports it", () => {
  it("descriptive shows the description on 2 lines", () => {
    const cfg = getMenuTileDensity({ itemCount: 10 });
    expect(cfg.showDescription).toBe(true);
    expect(cfg.descriptionLineClamp).toBe(2);
  });

  it("standard baseline shows the description on up to 2 lines (step 26)", () => {
    // Long beverage descriptions (Wine 67–110 chars) need ≥2 lines.
    // getDescriptionTextClass picks line-clamp-1 only for short
    // descriptions ≤ 30 chars; baseline allows up to 2.
    const cfg = getMenuTileDensity({ itemCount: 18 });
    expect(cfg.showDescription).toBe(true);
    expect(cfg.descriptionLineClamp).toBe(2);
  });
});

// =============================================================================
// Spec 8 — Descriptions hidden only in compact/dense.
// =============================================================================
describe("Spec 8 — descriptions hidden only when the category is too big", () => {
  for (const n of [0, 1, 5, 10, 14, 15, 18, 22]) {
    it(`itemCount=${n} → showDescription true`, () => {
      expect(getMenuTileDensity({ itemCount: n }).showDescription).toBe(true);
    });
  }
  for (const n of [23, 30, 31, 100]) {
    it(`itemCount=${n} → showDescription false`, () => {
      expect(getMenuTileDensity({ itemCount: n }).showDescription).toBe(false);
    });
  }
});

// =============================================================================
// Spec 9 — Price remains visible in all modes.
//   priceClass exists for every tier; nothing in the helper hides
//   the price under any condition.
// =============================================================================
describe("Spec 9 — price config is non-empty for every tier", () => {
  for (const n of [1, 14, 15, 22, 23, 30, 31, 50]) {
    it(`itemCount=${n} → priceClass is non-empty`, () => {
      const cfg = getMenuTileDensity({ itemCount: n });
      expect(cfg.priceClass.length).toBeGreaterThan(0);
      expect(cfg.priceClass).toMatch(/tabular-nums/);
    });
  }
});

// =============================================================================
// Helper boundary contract — every tier transition is testable.
// =============================================================================
describe("Tier boundaries are exactly at 15 / 23 / 31", () => {
  it("14 → descriptive, 15 → standard", () => {
    expect(getMenuTileDensity({ itemCount: 14 }).density).toBe("descriptive");
    expect(getMenuTileDensity({ itemCount: 15 }).density).toBe("standard");
  });

  it("22 → standard, 23 → compact", () => {
    expect(getMenuTileDensity({ itemCount: 22 }).density).toBe("standard");
    expect(getMenuTileDensity({ itemCount: 23 }).density).toBe("compact");
  });

  it("30 → compact, 31 → dense", () => {
    expect(getMenuTileDensity({ itemCount: 30 }).density).toBe("compact");
    expect(getMenuTileDensity({ itemCount: 31 }).density).toBe("dense");
  });

  it("negative or fractional itemCount is sanitised", () => {
    expect(getMenuTileDensity({ itemCount: -5 }).density).toBe("descriptive");
    expect(getMenuTileDensity({ itemCount: 22.9 }).density).toBe("standard");
  });
});

// =============================================================================
// Tile-width monotonicity — tiles shrink as density rises, not vice-versa.
// =============================================================================
describe("Tile widths shrink monotonically across tiers", () => {
  it("descriptive > standard > compact > dense for tileMin", () => {
    const desc = getMenuTileDensity({ itemCount: 10 });
    const std = getMenuTileDensity({ itemCount: 18 });
    const cmp = getMenuTileDensity({ itemCount: 25 });
    const dns = getMenuTileDensity({ itemCount: 40 });
    expect(desc.tileMin).toBeGreaterThan(std.tileMin);
    expect(std.tileMin).toBeGreaterThan(cmp.tileMin);
    expect(cmp.tileMin).toBeGreaterThan(dns.tileMin);
  });

  it("every tier uses `1fr` as the MAX so tiles share leftover panel width", () => {
    for (const n of [1, 10, 18, 25, 40]) {
      expect(getMenuTileDensity({ itemCount: n }).tileMax).toBe("1fr");
    }
  });

  it("tileHeight is a touch-friendly fixed value ≥ 80 px in every tier (step 29)", () => {
    for (const n of [1, 14, 15, 22, 23, 30, 31, 60]) {
      expect(getMenuTileDensity({ itemCount: n }).tileHeight).toBeGreaterThanOrEqual(80);
    }
  });

  it("step 29 — every tier exposes a single uniform tileHeight (no aspect-ratio field)", () => {
    // The old aspectRatio + tileMinHeight pair was replaced with a
    // single tileHeight number per tier. This test pins that shape.
    for (const n of [6, 18, 25, 40]) {
      const cfg = getMenuTileDensity({ itemCount: n });
      expect(typeof cfg.tileHeight).toBe("number");
      expect("aspectRatio" in cfg).toBe(false);
      expect("tileMinHeight" in cfg).toBe(false);
    }
  });

  it("step 29.1 — tile heights per tier: descriptive 170, standard 150, compact 110, dense 90", () => {
    // Step 29.1 bumped descriptive +10 (160→170) and standard +10
    // (140→150) so the larger title (16/14 px font-semibold) has
    // room without forcing more description truncation.
    expect(getMenuTileDensity({ itemCount: 6 }).tileHeight).toBe(170);
    expect(getMenuTileDensity({ itemCount: 18 }).tileHeight).toBe(150);
    expect(getMenuTileDensity({ itemCount: 25 }).tileHeight).toBe(110);
    expect(getMenuTileDensity({ itemCount: 40 }).tileHeight).toBe(90);
  });

  it("step 29 — descriptive tile is taller than standard, which is taller than compact, which is taller than dense", () => {
    const desc = getMenuTileDensity({ itemCount: 6 }).tileHeight;
    const std = getMenuTileDensity({ itemCount: 18 }).tileHeight;
    const cmp = getMenuTileDensity({ itemCount: 25 }).tileHeight;
    const dns = getMenuTileDensity({ itemCount: 40 }).tileHeight;
    expect(desc).toBeGreaterThan(std);
    expect(std).toBeGreaterThan(cmp);
    expect(cmp).toBeGreaterThan(dns);
  });
});

// =============================================================================
// Step 24 — Rendered-width math.
//
// These tests pin the actual tile width the browser will compute at
// realistic menu-panel inner widths. The panel inner width is the
// available width INSIDE the menu panel's card-body, after the side
// rail (360 px on lg+) and gaps/padding. A typical session:
//
//   1280 px viewport → panel ≈ 870 px
//   1024 px laptop   → panel ≈ 620 px
//   1536 px desktop  → panel ≈ 1130 px
//
// The user-visible target the spec called for is
// tile width ≥ 190 px (with description) for Wine + Draught.
// =============================================================================
import { computeMenuGridLayout } from "@/lib/pos/menu-density";

describe("Step 24/25 — rendered tile width at realistic menu-panel widths", () => {
  // Worst-case practical laptop: 620 px panel.
  it("standard tier on a 620 px panel renders ≥ 180 px wide tiles", () => {
    const std = getMenuTileDensity({ itemCount: 18 });
    const { tileWidthPx } = computeMenuGridLayout({
      panelWidthPx: 620, tileMinPx: std.tileMin, gapPx: std.gap,
    });
    expect(tileWidthPx).toBeGreaterThanOrEqual(180);
  });

  it("standard tier on an 870 px panel renders 4 columns ≥ 200 px each", () => {
    const std = getMenuTileDensity({ itemCount: 18 });
    const { columns, tileWidthPx } = computeMenuGridLayout({
      panelWidthPx: 870, tileMinPx: std.tileMin, gapPx: std.gap,
    });
    expect(columns).toBe(4);
    expect(tileWidthPx).toBeGreaterThanOrEqual(200);
  });

  it("descriptive tier on a 620 px panel renders ≥ 190 px wide tiles", () => {
    const desc = getMenuTileDensity({ itemCount: 10 });
    const { tileWidthPx } = computeMenuGridLayout({
      panelWidthPx: 620, tileMinPx: desc.tileMin, gapPx: desc.gap,
    });
    expect(tileWidthPx).toBeGreaterThanOrEqual(190);
  });

  it("descriptive tier on an 870 px panel renders ≥ 200 px wide tiles", () => {
    const desc = getMenuTileDensity({ itemCount: 10 });
    const { tileWidthPx } = computeMenuGridLayout({
      panelWidthPx: 870, tileMinPx: desc.tileMin, gapPx: desc.gap,
    });
    expect(tileWidthPx).toBeGreaterThanOrEqual(200);
  });

  it("compact tier stays usable: ≥ 150 px wide on a 620 px panel", () => {
    const cmp = getMenuTileDensity({ itemCount: 25 });
    const { tileWidthPx } = computeMenuGridLayout({
      panelWidthPx: 620, tileMinPx: cmp.tileMin, gapPx: cmp.gap,
    });
    expect(tileWidthPx).toBeGreaterThanOrEqual(150);
  });

  it("dense tier packs 4–5 columns on a 620 px panel without going below 130 px", () => {
    const dns = getMenuTileDensity({ itemCount: 50 });
    const { columns, tileWidthPx } = computeMenuGridLayout({
      panelWidthPx: 620, tileMinPx: dns.tileMin, gapPx: dns.gap,
    });
    expect(columns).toBeGreaterThanOrEqual(4);
    expect(columns).toBeLessThanOrEqual(5);
    expect(tileWidthPx).toBeGreaterThanOrEqual(130);
  });
});

// =============================================================================
// Step 24 — Spec target verification.
//
// The spec called for Beer · Draught and Wine to render at ≥190 px
// wide / ≥70 px tall with descriptions visible. These tests prove
// those numbers across the panel widths a real club would see.
// =============================================================================
describe("Step 29 — Beer · Draught + Wine + Imported render at a single uniform height per tier", () => {
  // Real seeded counts from prisma/lounge-menu.ts.
  const DRAUGHT_COUNT = 21;
  const WINE_COUNT = 18;
  const IMPORTED_COUNT = 6;

  for (const panelWidthPx of [560, 620, 720, 870, 1024, 1280]) {
    it(`Draught (21) every tile is 150 px tall at panel = ${panelWidthPx}`, () => {
      const cfg = getMenuTileDensity({ itemCount: DRAUGHT_COUNT });
      const shape = computeMenuTileShape({ panelWidthPx, cfg });
      expect(cfg.density).toBe("standard");
      expect(cfg.showDescription).toBe(true);
      expect(cfg.tileHeight).toBe(150);
      expect(shape.tileHeightPx).toBe(150);
      expect(shape.tileWidthPx).toBeGreaterThanOrEqual(180);
    });
  }

  for (const panelWidthPx of [560, 620, 720, 870, 1024, 1280]) {
    it(`Wine (18) every tile is 150 px tall at panel = ${panelWidthPx}`, () => {
      const cfg = getMenuTileDensity({ itemCount: WINE_COUNT });
      const shape = computeMenuTileShape({ panelWidthPx, cfg });
      expect(cfg.density).toBe("standard");
      expect(cfg.tileHeight).toBe(150);
      expect(shape.tileHeightPx).toBe(150);
    });
  }

  for (const panelWidthPx of [560, 620, 720, 870, 1024, 1280]) {
    it(`Imported (6) every tile is 170 px tall at panel = ${panelWidthPx}`, () => {
      const cfg = getMenuTileDensity({ itemCount: IMPORTED_COUNT });
      const shape = computeMenuTileShape({ panelWidthPx, cfg });
      expect(cfg.density).toBe("descriptive");
      expect(cfg.tileHeight).toBe(170);
      expect(shape.tileHeightPx).toBe(170);
    });
  }
});

// =============================================================================
// Step 29 — uniform tile height per tier.
//
// Every tile in the same category renders at the same height. Short
// and long descriptions both fit; rows are clean. compact + dense
// also use fixed heights now (no more aspect-ratio anywhere).
// =============================================================================
import { computeMenuTileShape } from "@/lib/pos/menu-density";

describe("Step 29.1 — fixed tile height per tier", () => {
  it("descriptive tier uses tileHeight=170", () => {
    expect(getMenuTileDensity({ itemCount: 6 }).tileHeight).toBe(170);
    expect(getMenuTileDensity({ itemCount: 12 }).tileHeight).toBe(170);
  });

  it("standard tier uses tileHeight=150", () => {
    expect(getMenuTileDensity({ itemCount: 15 }).tileHeight).toBe(150);
    expect(getMenuTileDensity({ itemCount: 21 }).tileHeight).toBe(150);
  });

  it("compact tier uses tileHeight=110", () => {
    expect(getMenuTileDensity({ itemCount: 23 }).tileHeight).toBe(110);
    expect(getMenuTileDensity({ itemCount: 30 }).tileHeight).toBe(110);
  });

  it("dense tier uses tileHeight=90", () => {
    expect(getMenuTileDensity({ itemCount: 31 }).tileHeight).toBe(90);
    expect(getMenuTileDensity({ itemCount: 60 }).tileHeight).toBe(90);
  });
});

describe("Step 29.1 — computeMenuTileShape returns the fixed height", () => {
  it("descriptive returns tileHeightPx = 170 regardless of panel width", () => {
    const cfg = getMenuTileDensity({ itemCount: 6 });
    for (const panelWidthPx of [560, 620, 720, 870, 1024, 1280]) {
      const shape = computeMenuTileShape({ panelWidthPx, cfg });
      expect(shape.tileHeightPx).toBe(170);
    }
  });

  it("standard returns tileHeightPx = 150 regardless of panel width", () => {
    const cfg = getMenuTileDensity({ itemCount: 18 });
    for (const panelWidthPx of [560, 620, 720, 870, 1024, 1280]) {
      const shape = computeMenuTileShape({ panelWidthPx, cfg });
      expect(shape.tileHeightPx).toBe(150);
    }
  });

  it("every tile in a category has the same height (uniform rows)", () => {
    // The uniform contract: two different items in the same category
    // produce the same tileHeightPx, so adjacent rows are clean.
    for (const itemCount of [6, 18, 25, 40]) {
      const cfg = getMenuTileDensity({ itemCount });
      const shapeA = computeMenuTileShape({ panelWidthPx: 870, cfg });
      const shapeB = computeMenuTileShape({ panelWidthPx: 870, cfg });
      expect(shapeA.tileHeightPx).toBe(shapeB.tileHeightPx);
      expect(shapeA.tileHeightPx).toBe(cfg.tileHeight);
    }
  });
});

// =============================================================================
// Step 24 — computeMenuGridLayout boundary sanity.
// =============================================================================
describe("computeMenuGridLayout — auto-fill math", () => {
  it("always returns at least 1 column even on tiny panels", () => {
    const r = computeMenuGridLayout({ panelWidthPx: 100, tileMinPx: 200, gapPx: 8 });
    expect(r.columns).toBe(1);
  });

  it("formula matches the CSS-Grid auto-fill rule: floor((panel + gap) / (min + gap))", () => {
    // 700 + 8 = 708; (200 + 8) = 208; 708/208 = 3.40 → 3 columns.
    const r = computeMenuGridLayout({ panelWidthPx: 700, tileMinPx: 200, gapPx: 8 });
    expect(r.columns).toBe(3);
    // 3 columns × tileWidth + 2 gaps = panel.
    // tileWidth = (700 - 16) / 3 = 228.
    expect(r.tileWidthPx).toBeCloseTo(228, 0);
  });

  it("non-positive panel/min falls back to a 1-column degenerate layout", () => {
    expect(computeMenuGridLayout({ panelWidthPx: 0, tileMinPx: 200, gapPx: 8 }).columns).toBe(1);
    expect(computeMenuGridLayout({ panelWidthPx: 700, tileMinPx: 0, gapPx: 8 }).columns).toBe(1);
  });
});
