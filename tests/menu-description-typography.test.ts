// POS cleanup step 26 — description typography fix.
//
// F&B service feedback: "description font is too big compared to
// the item tile title font size." Step 25's baseline had the
// description at 11–12 px against a 13–14 px title — only 2 px
// smaller, with `line-clamp-1` truncating most beverage
// descriptions to a useless prefix.
//
// Step 26 introduces getDescriptionTextClass(density,
// descriptionLength). Two invariants:
//   1. Description font is always strictly smaller than the tier's
//      title font.
//   2. Long descriptions (real wine/draught are 67–110 chars) get
//      a smaller font + more line-clamp lines, so the description
//      actually fits inside the tile.
//
// These tests pin both invariants by parsing the helper's return
// values directly — no source-regex magic; the strings are what
// React renders into the tile className.

import { describe, it, expect } from "vitest";
import {
  getMenuTileDensity,
  getDescriptionTextClass,
} from "@/lib/pos/menu-density";

// Extract the px size from a Tailwind text class like "text-[11px]"
// or "text-sm" (sm = 14 px in the project's default config).
function pxFromTextClass(className: string): number {
  const arbitrary = className.match(/text-\[(\d+(?:\.\d+)?)px\]/);
  if (arbitrary) return Number(arbitrary[1]);
  if (className.includes(" text-sm") || className.startsWith("text-sm")) return 14;
  if (className.includes(" text-xs") || className.startsWith("text-xs")) return 12;
  if (className.includes(" text-base") || className.startsWith("text-base")) return 16;
  return Number.NaN;
}

function lineClampOf(className: string): number {
  const m = className.match(/line-clamp-(\d+)/);
  return m ? Number(m[1]) : 0;
}

// =============================================================================
// Step 29.1 — visual-hierarchy invariants the previous tests missed.
//
// Tests before step 29.1 checked title.px > description.px (math).
// That passed even when the title was font-medium (500) on 1 line
// while the description was font-normal (400) on 4 lines, and the
// browser screenshot showed the description visually dominating.
// These new invariants catch the dominance defect by checking:
//   1. Title is font-semibold or font-bold (not just font-medium).
//   2. Title font size exceeds description font size by ≥ 3 px.
//   3. Title color is darker than description (text-stone-900 vs
//      text-stone-500).
// =============================================================================
describe("Step 29.1 — title visually dominates the description", () => {
  function fontWeightOf(className: string): number {
    if (className.includes("font-bold")) return 700;
    if (className.includes("font-semibold")) return 600;
    if (className.includes("font-medium")) return 500;
    return 400;
  }

  it("title font-weight is ≥ semibold (600) in every tier", () => {
    for (const itemCount of [6, 18, 25, 40]) {
      const cfg = getMenuTileDensity({ itemCount });
      expect(fontWeightOf(cfg.nameClass)).toBeGreaterThanOrEqual(600);
    }
  });

  it("title is at least 3 px larger than description for every length", () => {
    const tiers: Array<{ density: "descriptive" | "standard"; itemCount: number }> = [
      { density: "descriptive", itemCount: 6 },
      { density: "standard", itemCount: 18 },
    ];
    for (const { density, itemCount } of tiers) {
      const cfg = getMenuTileDensity({ itemCount });
      const titlePx = pxFromTextClass(cfg.nameClass);
      for (const len of [12, 30, 60, 90, 120]) {
        const cls = getDescriptionTextClass({ density, descriptionLength: len });
        if (cls === "") continue;
        const descPx = pxFromTextClass(cls);
        expect(titlePx - descPx).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it("title is dark stone-900, description is muted stone-500", () => {
    for (const itemCount of [6, 18, 25, 40]) {
      const cfg = getMenuTileDensity({ itemCount });
      expect(cfg.nameClass).toMatch(/text-stone-900/);
    }
    // getDescriptionTextClass output uses text-stone-500 muted color.
    const cls = getDescriptionTextClass({ density: "descriptive", descriptionLength: 60 });
    expect(cls).toMatch(/text-stone-500/);
  });
});

// =============================================================================
// Spec 1 — Description font class is smaller than title font class.
// Spec 2 — Title font class remains unchanged.
//
// The title pixel size for each tier is what step 25 set; this
// test pins that step 26 did NOT touch it, AND that every
// description size returned by the helper is strictly smaller.
// =============================================================================
describe("Specs 1/2 — title size unchanged, description always smaller than title", () => {
  // Step 29.1 — title sizes bumped to give clear visual hierarchy
  // over multi-line descriptions: descriptive 14→16 px, standard
  // 13→14 px. Compact stays 13 px (no description there).
  const cases: Array<{ density: "descriptive" | "standard" | "compact"; titlePx: number; itemCount: number }> = [
    { density: "descriptive", titlePx: 16, itemCount: 6 },
    { density: "standard",    titlePx: 14, itemCount: 18 },
    { density: "compact",     titlePx: 13, itemCount: 25 },
  ];
  for (const { density, titlePx, itemCount } of cases) {
    it(`${density} — title is ${titlePx}px`, () => {
      const cfg = getMenuTileDensity({ itemCount });
      expect(pxFromTextClass(cfg.nameClass)).toBe(titlePx);
    });

    // Test at multiple realistic description lengths.
    for (const len of [12, 30, 60, 90, 120]) {
      it(`${density} @ ${len} chars — description font < ${titlePx}px title`, () => {
        const cls = getDescriptionTextClass({ density, descriptionLength: len });
        if (cls === "") return; // hidden in this tier — no invariant to check.
        const descPx = pxFromTextClass(cls);
        expect(descPx).toBeLessThan(titlePx);
      });
    }
  }
});

// =============================================================================
// Spec 3 — Descriptive tier allows longer descriptions than standard.
// =============================================================================
describe("Spec 3 — descriptive tier permits more lines than standard", () => {
  // Step 29.1 — tightened to prevent the description from
  // visually dominating the title. Max 3 lines descriptive, max
  // 2 lines standard.
  it("descriptive at 90 chars uses line-clamp-3", () => {
    const cls = getDescriptionTextClass({ density: "descriptive", descriptionLength: 90 });
    expect(lineClampOf(cls)).toBe(3);
  });

  it("standard at 90 chars uses line-clamp-2", () => {
    const cls = getDescriptionTextClass({ density: "standard", descriptionLength: 90 });
    expect(lineClampOf(cls)).toBe(2);
  });

  it("descriptive line-clamp always >= standard line-clamp at the same length", () => {
    for (const len of [20, 50, 90, 120]) {
      const desc = getDescriptionTextClass({ density: "descriptive", descriptionLength: len });
      const std = getDescriptionTextClass({ density: "standard", descriptionLength: len });
      expect(lineClampOf(desc)).toBeGreaterThanOrEqual(lineClampOf(std));
    }
  });
});

// =============================================================================
// Spec 4 — Standard tier description is smaller and line-clamped.
// =============================================================================
describe("Spec 4 — standard tier description is 10–11 px, clamped to 2 lines (step 29.1)", () => {
  it("at 30 chars uses text-[11px] line-clamp-2", () => {
    const cls = getDescriptionTextClass({ density: "standard", descriptionLength: 30 });
    expect(cls).toMatch(/text-\[11px\]/);
    expect(cls).toMatch(/line-clamp-2/);
  });

  it("at 75 chars uses text-[10px] line-clamp-2 (smaller, still 2 lines)", () => {
    const cls = getDescriptionTextClass({ density: "standard", descriptionLength: 75 });
    expect(cls).toMatch(/text-\[10px\]/);
    expect(cls).toMatch(/line-clamp-2/);
  });
});

// =============================================================================
// Spec 5 — Long description uses smaller text class.
// =============================================================================
describe("Spec 5 — font sized to fill canvas, holding smaller-than-title invariant", () => {
  // Step 27 — descriptions stay at a consistent 11 px (standard) and
  // 12 px (descriptive) across all lengths. We don't shrink the
  // font any further because the canvas already fills via
  // line-clamp-3/4. The smaller-than-title invariant (≥2 px below)
  // is enforced in Spec 1/2.
  it("descriptive font is 11 px at every realistic length (step 29.1)", () => {
    for (const len of [30, 60, 90, 110]) {
      expect(pxFromTextClass(getDescriptionTextClass({ density: "descriptive", descriptionLength: len }))).toBe(11);
    }
  });

  it("standard font: 11 px at short lengths, 10 px when long (step 29.1)", () => {
    expect(pxFromTextClass(getDescriptionTextClass({ density: "standard", descriptionLength: 25 }))).toBe(11);
    expect(pxFromTextClass(getDescriptionTextClass({ density: "standard", descriptionLength: 90 }))).toBe(10);
  });

  it("font size is monotonic non-increasing as length grows", () => {
    for (const density of ["descriptive", "standard"] as const) {
      let lastPx = Infinity;
      for (const len of [10, 25, 40, 60, 80, 100, 150]) {
        const cls = getDescriptionTextClass({ density, descriptionLength: len });
        if (cls === "") continue;
        const px = pxFromTextClass(cls);
        expect(px).toBeLessThanOrEqual(lastPx);
        lastPx = px;
      }
    }
  });
});

// =============================================================================
// Spec 6 — Very long description does not overflow tile contract.
//
// SeatPOS wraps the description in `overflow-hidden` containers and
// the helper sets `line-clamp-N` on the description element itself.
// Tile geometry: standard ≈ 211×141, with title 28px + price 22px
// reserved → ≈ 80 px available for description. At 10 px font /
// 13 px line-height × 2 lines = 26 px content + breathing room.
// =============================================================================
describe("Spec 6 — extreme lengths still produce a clamped class, never empty string", () => {
  it("descriptive at 500 chars uses line-clamp-3 + 11 px (step 29.1)", () => {
    const cls = getDescriptionTextClass({ density: "descriptive", descriptionLength: 500 });
    expect(cls).toMatch(/line-clamp-3/);
    expect(pxFromTextClass(cls)).toBe(11);
  });

  it("standard at 500 chars uses line-clamp-2 + 10 px (step 29.1)", () => {
    const cls = getDescriptionTextClass({ density: "standard", descriptionLength: 500 });
    expect(cls).toMatch(/line-clamp-2/);
    expect(pxFromTextClass(cls)).toBe(10);
  });

  it("SeatPOS tile clips overflow via the overflow-hidden contract", () => {
    // Source-contract guard so a future tile refactor can't silently
    // remove the overflow cap that backs the line-clamp behaviour.
    const fs = require("node:fs") as typeof import("node:fs");
    const path = require("node:path") as typeof import("node:path");
    const src = fs.readFileSync(
      path.resolve(process.cwd(), "src/app/app/admin/ops/pos/lounge/table/[checkId]/SeatPOS.tsx"),
      "utf8",
    );
    // Step 29.1 — tile is uniform-height with overflow-hidden. The
    // description is split across two divs: outer flex-1 middle
    // band, inner carries the line-clamp class (avoids the CSS
    // display-mode collision between flex-1 and -webkit-box).
    expect(src).toMatch(/height: cfg\.tileHeight/);
    expect(src).not.toMatch(/aspectRatio: cfg\./);
    expect(src).toMatch(/flex flex-col overflow-hidden/);
    expect(src).toMatch(/mt-2 min-h-0 flex-1 overflow-hidden/);
    expect(src).toMatch(/break-words \$\{descClass\}/);
  });
});

// =============================================================================
// Spec 7 — Price remains rendered after description.
// =============================================================================
describe("Spec 7 — price is outside the description's flex child", () => {
  it("price is in a separate flex-shrink-0 footer inside the tile", () => {
    const fs = require("node:fs") as typeof import("node:fs");
    const path = require("node:path") as typeof import("node:path");
    const src = fs.readFileSync(
      path.resolve(process.cwd(), "src/app/app/admin/ops/pos/lounge/table/[checkId]/SeatPOS.tsx"),
      "utf8",
    );
    // Step 28 — tile is a natural flex-col stack; the price footer
    // is the last `flex-shrink-0` child. No `justify-between` on
    // the parent and no `flex-1` description: content-sized tiles
    // grow only as tall as their content + padding need.
    expect(src).toMatch(/flex flex-col overflow-hidden/);
    expect(src).toMatch(/flex flex-shrink-0 items-end justify-end[\s\S]*?cfg\.priceClass/);
  });
});

// =============================================================================
// Spec 8 — Description hidden in dense tier (and on long compact entries).
// =============================================================================
describe("Spec 8 — dense never renders a description; compact hides over-length", () => {
  it("dense returns '' at every realistic length", () => {
    for (const len of [10, 50, 100, 250]) {
      expect(getDescriptionTextClass({ density: "dense", descriptionLength: len })).toBe("");
    }
  });

  it("compact returns '' when length > 40 chars (step 27 boundary)", () => {
    // Step 27 bumped the cutoff from 32 → 40 because compact tiles
    // now use line-clamp-2 (was 1), so they can fit a slightly
    // longer description before truncation looks ugly.
    expect(getDescriptionTextClass({ density: "compact", descriptionLength: 40 })).not.toBe("");
    expect(getDescriptionTextClass({ density: "compact", descriptionLength: 41 })).toBe("");
  });

  it("length 0 always returns '' (no description to render)", () => {
    for (const density of ["descriptive", "standard", "compact", "dense"] as const) {
      expect(getDescriptionTextClass({ density, descriptionLength: 0 })).toBe("");
    }
  });
});

// =============================================================================
// Spec 9 — Beer · Draught descriptions: visible and smaller than title.
// Real seeded lengths from prisma/lounge-menu.ts: 66, 74, 75, 80, 85, 87, 90.
// =============================================================================
describe("Spec 9 — Beer · Draught descriptions (66–90 chars)", () => {
  for (const len of [66, 74, 75, 80, 85, 87, 90]) {
    it(`${len}-char description renders smaller than 13px title`, () => {
      const cls = getDescriptionTextClass({ density: "standard", descriptionLength: len });
      expect(cls).not.toBe("");
      expect(pxFromTextClass(cls)).toBeLessThan(13);
      expect(lineClampOf(cls)).toBeGreaterThanOrEqual(1);
    });
  }
});

// =============================================================================
// Spec 10 — Wine descriptions: visible and smaller than title.
// Real seeded lengths from prisma/lounge-menu.ts: 67–110 chars.
// =============================================================================
describe("Spec 10 — Wine descriptions (67–110 chars)", () => {
  for (const len of [67, 72, 84, 93, 97, 101, 110]) {
    it(`${len}-char description renders smaller than 13px title`, () => {
      const cls = getDescriptionTextClass({ density: "standard", descriptionLength: len });
      expect(cls).not.toBe("");
      expect(pxFromTextClass(cls)).toBeLessThan(13);
    });
  }
});

// =============================================================================
// Spec 11 — Beer · Imported descriptions render cleanly.
// Real seeded lengths from prisma/lounge-menu.ts: 69, 75, 78, 80, 92, 103.
// =============================================================================
describe("Spec 11 — Beer · Imported descriptions (69–103 chars)", () => {
  for (const len of [69, 75, 78, 80, 92, 103]) {
    it(`${len}-char description renders smaller than 14px title`, () => {
      const cls = getDescriptionTextClass({ density: "descriptive", descriptionLength: len });
      expect(cls).not.toBe("");
      expect(pxFromTextClass(cls)).toBeLessThan(14);
      // Imported sits in the descriptive tier — should show 2 or 3 lines.
      expect(lineClampOf(cls)).toBeGreaterThanOrEqual(2);
    });
  }
});

// =============================================================================
// Spec 12 — Existing add-item workflow still wired up.
// =============================================================================
describe("Spec 12 — SeatPOS still wires the add-item action through getDescriptionTextClass", () => {
  it("imports getDescriptionTextClass and uses it on each item", () => {
    const fs = require("node:fs") as typeof import("node:fs");
    const path = require("node:path") as typeof import("node:path");
    const src = fs.readFileSync(
      path.resolve(process.cwd(), "src/app/app/admin/ops/pos/lounge/table/[checkId]/SeatPOS.tsx"),
      "utf8",
    );
    expect(src).toMatch(/import \{[\s\S]*?getDescriptionTextClass[\s\S]*?\} from "@\/lib\/pos\/menu-density"/);
    expect(src).toMatch(/getDescriptionTextClass\(\{\s*density: cfg\.density,\s*descriptionLength: it\.description\.length/);
    // Add-item action is still imported + invoked.
    expect(src).toMatch(/addSeatItemAction/);
    expect(src).toMatch(/runAdd\(it\.id\)/);
  });
});
