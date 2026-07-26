// Step 29 — adaptive menu-tile density (V5, FINAL).
//
// Decision history:
//   V3 (step 25) used fixed CSS aspect-ratio per tier. Short
//   descriptions left empty interior.
//   V4 (step 28) made descriptive + standard CONTENT-SIZED. Solved
//   per-tile empty space but produced uneven row heights within a
//   category (messy menu).
//   V5 (step 29) — FINAL. Each tier has a single fixed `tileHeight`
//   (a plain px value, not an aspect-ratio). Every tile in a
//   category is exactly the same height, so rows are clean and
//   uniform. Empty space for short-description tiles is accepted
//   as intentional "card padding" — the cost of a uniform grid.
//
// Tier heights chosen to fit a typical content stack of name +
// 2–4-line description + price + padding:
//
//   tier         tileHeight   description lines (max)
//   descriptive    160 px     3–4 lines
//   standard       140 px     2–3 lines
//   compact        110 px     1 line (short) or hidden
//   dense           90 px     none — name + price only
//
// Grid template still uses `repeat(auto-fill, minmax(MIN, 1fr))`
// so columns share leftover panel width predictably.

export type MenuTileDensity = "descriptive" | "standard" | "compact" | "dense";

export type MenuTileConfig = {
  density: MenuTileDensity;
  /** Minimum tile width in px — drives the auto-fill column count. */
  tileMin: number;
  /**
   * Maximum tile width. `"1fr"` means tiles share leftover row
   * width; a number caps the tile at an absolute px.
   */
  tileMax: number | "1fr";
  /**
   * Tile height in px. Every tile in the category renders at this
   * exact height regardless of description length, so rows are
   * uniform. Short descriptions leave intentional whitespace inside
   * the tile; long descriptions are line-clamped by
   * `getDescriptionTextClass`. Step 29 replaces V3's aspect-ratio
   * rule and V4's content-sized rule with one uniform px per tier.
   */
  tileHeight: number;
  /** Inter-tile gap in px. */
  gap: number;
  /** Tailwind padding classes for the tile button body. */
  tilePadding: string;
  /** Tailwind text classes for the item name. */
  nameClass: string;
  /** Tailwind text classes for the price. */
  priceClass: string;
  /** Tailwind text classes for the description. */
  descriptionClass: string;
  /** Whether the tile renders the item's description at all. */
  showDescription: boolean;
  /** When showing the description, how many lines before truncation. */
  descriptionLineClamp: 1 | 2;
};

export function getMenuTileDensity(input: { itemCount: number }): MenuTileConfig {
  const n = Math.max(0, Math.floor(input.itemCount));
  if (n >= 31) {
    return {
      density: "dense",
      tileMin: 130, tileMax: "1fr",
      tileHeight: 90, gap: 6,
      tilePadding: "px-2 py-1.5",
      // Step 29.1 — title is font-semibold so it visually dominates
      // even when the description is multi-line. font-medium was
      // too weak against a "wall of text" description.
      nameClass: "text-[13px] font-semibold text-stone-900 leading-tight line-clamp-2",
      priceClass: "text-[11px] tabular-nums text-stone-700 font-medium",
      descriptionClass: "text-[10px] text-stone-500 leading-tight line-clamp-1",
      showDescription: false,
      descriptionLineClamp: 1,
    };
  }
  if (n >= 23) {
    return {
      density: "compact",
      tileMin: 160, tileMax: "1fr",
      tileHeight: 110, gap: 8,
      tilePadding: "px-2.5 py-2",
      nameClass: "text-[13px] font-semibold text-stone-900 leading-tight line-clamp-2",
      priceClass: "text-[12px] tabular-nums text-stone-700 font-medium",
      descriptionClass: "text-[10px] text-stone-500 leading-tight line-clamp-1",
      showDescription: false,
      descriptionLineClamp: 1,
    };
  }
  if (n >= 15) {
    // STANDARD — Wine, Draught, Domestic. Step 29.1: 150 px uniform
    // tile (was 140). Title bumped to 14 px font-semibold so it's
    // visibly dominant over the 10–11 px description.
    return {
      density: "standard",
      tileMin: 180, tileMax: "1fr",
      tileHeight: 150, gap: 10,
      tilePadding: "px-3 py-2.5",
      nameClass: "text-[14px] font-semibold text-stone-900 leading-snug line-clamp-2",
      priceClass: "text-[13px] tabular-nums text-stone-700 font-medium",
      descriptionClass: "text-[10px] text-stone-500 leading-tight line-clamp-2",
      showDescription: true,
      descriptionLineClamp: 2,
    };
  }
  // DESCRIPTIVE — Imported, Mains, Pizza, Soups & Salads, Appetizers,
  // Desserts, Kids, Highballs, anything ≤14 items. Step 29.1: 170 px
  // uniform tile (was 160). Title bumped to text-base (16 px)
  // font-semibold — a clear 5 px size gap + weight contrast over the
  // 11 px description so the hierarchy reads correctly in the browser.
  return {
    density: "descriptive",
    tileMin: 200, tileMax: "1fr",
    tileHeight: 170, gap: 12,
    tilePadding: "px-3 py-3",
    nameClass: "text-base font-semibold text-stone-900 leading-snug line-clamp-2",
    priceClass: "text-[14px] tabular-nums text-stone-700 font-semibold",
    descriptionClass: "text-[11px] text-stone-500 leading-snug line-clamp-2",
    showDescription: true,
    descriptionLineClamp: 2,
  };
}

// ---------------------------------------------------------------------------
// Step 26 — length-aware description typography.
//
// Real seeded descriptions span 67–110 chars (median 85) — far more
// than the 1-line clamp could fit. This helper picks the right font
// size + line-clamp from (density, descriptionLength) so the
// description actually shows in the tile instead of being truncated
// to "Crisp..." or hidden entirely.
//
// Invariant: the returned font size is ALWAYS smaller than the
// tier's title size. The tier-vs-length matrix:
//
//   density       length     class
//   ---------------------------------------------------------------
//   descriptive   ≤ 40       text-[11px] leading-snug line-clamp-2
//   descriptive   41 – 90    text-[11px] leading-snug line-clamp-3
//   descriptive   91+        text-[10px] leading-snug line-clamp-3
//
//   standard      ≤ 30       text-[11px] leading-tight line-clamp-1
//   standard      31 – 60    text-[10px] leading-tight line-clamp-2
//   standard      61+        text-[10px] leading-tight line-clamp-2
//
//   compact       ≤ 32       text-[10px] leading-tight line-clamp-1
//   compact       33+        "" (hidden — won't fit a 5/3 tile)
//
//   dense         any        "" (hidden — name+price only)
//
// Returns "" if the description should not render at all. The
// caller checks for "" before emitting the <div>.
// ---------------------------------------------------------------------------

export function getDescriptionTextClass(args: {
  density: MenuTileDensity;
  descriptionLength: number;
}): string {
  const len = Math.max(0, args.descriptionLength | 0);
  if (len === 0) return "";

  const muted = "text-stone-500";

  if (args.density === "dense") return "";

  if (args.density === "compact") {
    if (len > 40) return "";
    return `text-[10px] ${muted} leading-snug line-clamp-2`;
  }

  if (args.density === "standard") {
    // Standard tile = 150 px uniform (step 29.1). Title 14 px (~22)
    // + price 13 px (~18) + padding 20 + gaps 16 = 76 px reserved;
    // middle band ≈ 74 px. At 10–11 px / leading-tight (~13–15 px
    // per line) × 2 lines = 26–30 px. Visible breathing room rather
    // than a wall of text — title stays visually dominant.
    if (len <= 30) {
      return `text-[11px] ${muted} leading-tight line-clamp-2`;
    }
    return `text-[10px] ${muted} leading-tight line-clamp-2`;
  }

  // descriptive — tile = 170 px uniform. Title 16 px (~24) + price
  // 14 px (~20) + padding 24 + gaps 16 = 84 px reserved; middle
  // band ≈ 86 px. At 11 px / leading-snug (~15 px per line) × 3
  // lines = 45 px. Step 29.1 reduced from line-clamp-4 → 3 so
  // descriptions don't dominate.
  if (len <= 40) {
    return `text-[11px] ${muted} leading-snug line-clamp-2`;
  }
  return `text-[11px] ${muted} leading-snug line-clamp-3`;
}

// ---------------------------------------------------------------------------
// Step 24/25 — `auto-fill` column-count math.
//
// Pure replication of what the browser does for
// `grid-template-columns: repeat(auto-fill, minmax(MIN, 1fr))` so the
// test suite can prove the actual rendered tile width and height
// at common menu-panel widths without spinning up a real browser.
//
// computeMenuTileShape combines the width math with the tier's
// aspect ratio to yield the final rendered tile box.
// ---------------------------------------------------------------------------

export function computeMenuGridLayout(args: {
  panelWidthPx: number;
  tileMinPx: number;
  gapPx: number;
}): { columns: number; tileWidthPx: number } {
  const { panelWidthPx, tileMinPx, gapPx } = args;
  if (panelWidthPx <= 0 || tileMinPx <= 0) return { columns: 1, tileWidthPx: panelWidthPx };
  const columns = Math.max(
    1,
    Math.floor((panelWidthPx + gapPx) / (tileMinPx + gapPx)),
  );
  const tileWidthPx = (panelWidthPx - gapPx * (columns - 1)) / columns;
  return { columns, tileWidthPx };
}

export function computeMenuTileShape(args: {
  panelWidthPx: number;
  cfg: MenuTileConfig;
}): { columns: number; tileWidthPx: number; tileHeightPx: number; aspectRatio: number } {
  const { panelWidthPx, cfg } = args;
  const { columns, tileWidthPx } = computeMenuGridLayout({
    panelWidthPx, tileMinPx: cfg.tileMin, gapPx: cfg.gap,
  });
  // Step 29 — every tile in the category is exactly cfg.tileHeight
  // tall; aspect-ratio is whatever the width/height math produces.
  return {
    columns,
    tileWidthPx,
    tileHeightPx: cfg.tileHeight,
    aspectRatio: tileWidthPx / cfg.tileHeight,
  };
}
