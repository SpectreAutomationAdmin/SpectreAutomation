// Step 34 — floor-plan geometry helpers (overlap + spacing).
//
// Pure function tests — no Prisma, no DB. The same helper runs
// client-side in the editor (live validation panel + offender
// highlight) and server-side in validateDraftForPublish (publish
// blocker), so this suite locks the math.

import { describe, it, expect } from "vitest";
import {
  tableAabb,
  aabbsOverlap,
  aabbGap,
  computeSpacingIssues,
  offenderIdSet,
  MIN_CLEARANCE_PX,
} from "@/lib/hospitality/floor-plan-geometry";

function t(opts: Partial<{
  id: string; tableNumber: string; xPos: number; yPos: number;
  width: number; height: number; archived: boolean;
}> = {}) {
  return {
    id: opts.id ?? "id",
    tableNumber: opts.tableNumber ?? "T",
    xPos: opts.xPos ?? 100,
    yPos: opts.yPos ?? 100,
    width: opts.width ?? 80,
    height: opts.height ?? 80,
    archived: opts.archived ?? false,
  };
}

describe("tableAabb — converts centre coords to bounding box", () => {
  it("80×80 at (100,100) → 60..140 / 60..140", () => {
    expect(tableAabb(t({ xPos: 100, yPos: 100, width: 80, height: 80 }))).toEqual({
      left: 60, right: 140, top: 60, bottom: 140,
    });
  });

  it("asymmetric rectangle yields asymmetric box", () => {
    expect(tableAabb(t({ xPos: 200, yPos: 100, width: 140, height: 60 }))).toEqual({
      left: 130, right: 270, top: 70, bottom: 130,
    });
  });
});

describe("aabbsOverlap — strict intersection (touching is not overlap)", () => {
  it("disjoint boxes do not overlap", () => {
    const a = { left: 0, top: 0, right: 50, bottom: 50 };
    const b = { left: 60, top: 0, right: 100, bottom: 50 };
    expect(aabbsOverlap(a, b)).toBe(false);
  });

  it("touching boxes (shared edge only) do not overlap", () => {
    const a = { left: 0, top: 0, right: 50, bottom: 50 };
    const b = { left: 50, top: 0, right: 100, bottom: 50 };
    expect(aabbsOverlap(a, b)).toBe(false);
  });

  it("clearly intersecting boxes overlap", () => {
    const a = { left: 0, top: 0, right: 50, bottom: 50 };
    const b = { left: 40, top: 10, right: 90, bottom: 60 };
    expect(aabbsOverlap(a, b)).toBe(true);
  });
});

describe("aabbGap — shortest axis-aligned clearance", () => {
  it("returns 0 for boxes that touch", () => {
    const a = { left: 0, top: 0, right: 50, bottom: 50 };
    const b = { left: 50, top: 0, right: 100, bottom: 50 };
    expect(aabbGap(a, b)).toBe(0);
  });

  it("returns positive gap for separated boxes", () => {
    const a = { left: 0, top: 0, right: 50, bottom: 50 };
    const b = { left: 70, top: 0, right: 120, bottom: 50 };
    expect(aabbGap(a, b)).toBe(20);
  });

  it("returns negative depth for overlapping boxes", () => {
    const a = { left: 0, top: 0, right: 50, bottom: 50 };
    const b = { left: 40, top: 0, right: 90, bottom: 50 };
    expect(aabbGap(a, b)).toBeLessThan(0);
  });
});

describe("computeSpacingIssues — overlap detection", () => {
  it("two clearly overlapping tables → one OVERLAP issue", () => {
    const issues = computeSpacingIssues([
      t({ id: "a", tableNumber: "L1", xPos: 100, yPos: 100, width: 80, height: 80 }),
      t({ id: "b", tableNumber: "L2", xPos: 120, yPos: 100, width: 80, height: 80 }),
    ]);
    expect(issues.length).toBe(1);
    expect(issues[0].kind).toBe("OVERLAP");
    expect(issues[0].aTableNumber).toBe("L1");
    expect(issues[0].bTableNumber).toBe("L2");
    expect(issues[0].message).toMatch(/L1 overlaps L2/);
  });

  it("round-table overlap uses bounding-box approximation", () => {
    // Round 80×80 tiles centred 60px apart on x → both AABBs span
    // 30 px on each side of centre → overlap by 20 px.
    const issues = computeSpacingIssues([
      t({ id: "a", tableNumber: "R1", xPos: 100, yPos: 100, width: 60, height: 60 }),
      t({ id: "b", tableNumber: "R2", xPos: 140, yPos: 100, width: 60, height: 60 }),
    ]);
    expect(issues.length).toBe(1);
    expect(issues[0].kind).toBe("OVERLAP");
  });
});

describe("computeSpacingIssues — too-close detection", () => {
  it("tables sitting 8px apart trip the TOO_CLOSE rule (default 16px min)", () => {
    // 80×80 at xPos=100, second 80×80 at xPos=188 → 100+40=140, 188-40=148 → gap 8.
    const issues = computeSpacingIssues([
      t({ id: "a", tableNumber: "L1", xPos: 100, yPos: 100, width: 80, height: 80 }),
      t({ id: "b", tableNumber: "L2", xPos: 188, yPos: 100, width: 80, height: 80 }),
    ]);
    expect(issues.length).toBe(1);
    expect(issues[0].kind).toBe("TOO_CLOSE");
    if (issues[0].kind === "TOO_CLOSE") {
      expect(issues[0].gapPx).toBeLessThan(MIN_CLEARANCE_PX);
    }
  });

  it("tables exactly MIN_CLEARANCE_PX apart pass", () => {
    // 80×80 at xPos=100; 80×80 at xPos=196 → gap is 196-40 - (100+40) = 16.
    const issues = computeSpacingIssues([
      t({ id: "a", tableNumber: "L1", xPos: 100, yPos: 100, width: 80, height: 80 }),
      t({ id: "b", tableNumber: "L2", xPos: 196, yPos: 100, width: 80, height: 80 }),
    ]);
    expect(issues.length).toBe(0);
  });

  it("clearance threshold is configurable", () => {
    const issues = computeSpacingIssues(
      [
        t({ id: "a", tableNumber: "L1", xPos: 100, yPos: 100, width: 80, height: 80 }),
        t({ id: "b", tableNumber: "L2", xPos: 200, yPos: 100, width: 80, height: 80 }),
      ],
      { minClearancePx: 25 },
    );
    // gap is 20 < 25 → TOO_CLOSE.
    expect(issues.length).toBe(1);
    expect(issues[0].kind).toBe("TOO_CLOSE");
  });
});

describe("computeSpacingIssues — happy path", () => {
  it("a layout with widely-spaced tables has no issues", () => {
    const issues = computeSpacingIssues([
      t({ id: "a", tableNumber: "L1", xPos: 100, yPos: 100, width: 80, height: 80 }),
      t({ id: "b", tableNumber: "L2", xPos: 300, yPos: 100, width: 80, height: 80 }),
      t({ id: "c", tableNumber: "L3", xPos: 500, yPos: 100, width: 80, height: 80 }),
    ]);
    expect(issues.length).toBe(0);
  });

  it("ignores archived tables", () => {
    const issues = computeSpacingIssues([
      t({ id: "a", tableNumber: "L1", xPos: 100, yPos: 100, width: 80, height: 80 }),
      // This would overlap L1 — but archived rows don't count.
      t({ id: "b", tableNumber: "L2", xPos: 110, yPos: 100, width: 80, height: 80, archived: true }),
    ]);
    expect(issues.length).toBe(0);
  });

  it("empty + single-table layouts produce no issues", () => {
    expect(computeSpacingIssues([])).toEqual([]);
    expect(computeSpacingIssues([t({ id: "a", tableNumber: "L1" })])).toEqual([]);
  });
});

describe("computeSpacingIssues — stable ordering", () => {
  it("issues are sorted by (aTableNumber, bTableNumber)", () => {
    const issues = computeSpacingIssues([
      t({ id: "c", tableNumber: "L3", xPos: 100, yPos: 100, width: 80, height: 80 }),
      t({ id: "a", tableNumber: "L1", xPos: 110, yPos: 100, width: 80, height: 80 }),
      t({ id: "b", tableNumber: "L2", xPos: 220, yPos: 100, width: 80, height: 80 }),
    ]);
    // L1-L2 overlap with L3, and L1 overlaps L3 — multiple issues.
    expect(issues.length).toBeGreaterThan(0);
    for (let i = 1; i < issues.length; i++) {
      const prev = issues[i - 1];
      const curr = issues[i];
      const order = prev.aTableNumber.localeCompare(curr.aTableNumber);
      expect(order).toBeLessThanOrEqual(0);
    }
  });
});

describe("offenderIdSet", () => {
  it("returns the union of all ids from issues", () => {
    const set = offenderIdSet([
      { kind: "OVERLAP", aId: "a", bId: "b", aTableNumber: "L1", bTableNumber: "L2", message: "" },
      { kind: "TOO_CLOSE", aId: "b", bId: "c", aTableNumber: "L2", bTableNumber: "L3", gapPx: 5, message: "" },
    ]);
    expect(set.has("a")).toBe(true);
    expect(set.has("b")).toBe(true);
    expect(set.has("c")).toBe(true);
    expect(set.size).toBe(3);
  });

  it("empty issues → empty set", () => {
    expect(offenderIdSet([]).size).toBe(0);
  });
});
