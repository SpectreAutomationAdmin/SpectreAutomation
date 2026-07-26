// Step 34 — Floor-plan geometry helpers.
//
// Pure, dependency-free module (no Prisma, no Principal, no audit)
// so it can be imported by:
//   - validateDraftForPublish (server, blocking publish on bad geometry)
//   - FloorPlanEditor (client, live validation panel + offender highlight)
//
// Coordinate system matches the rest of the editor:
//   - xPos / yPos are the TABLE CENTER in the SVG's viewBox coordinate
//     space (1000 × 700 by default).
//   - width / height are the bounding-box dimensions.
//   - Round tables are approximated by their bounding box (acceptable
//     fidelity for v1 — see `MIN_CLEARANCE_PX` for the safety margin
//     that absorbs the corner-vs-ellipse approximation).
//
// Spacing rule:
//   - OVERLAP (bounding boxes intersect): blocking error.
//   - TOO_CLOSE (clearance < `MIN_CLEARANCE_PX`): blocking error too.
//     Per step-34 product decision, both block publish. Draft save
//     is still allowed so the admin can stage changes mid-edit.

export const MIN_CLEARANCE_PX = 16;

export type GeometryTable = {
  id: string;
  tableNumber: string;
  xPos: number;
  yPos: number;
  width: number;
  height: number;
  archived?: boolean;
};

export type Aabb = { left: number; top: number; right: number; bottom: number };

export type SpacingIssue =
  | { kind: "OVERLAP"; aId: string; bId: string; aTableNumber: string; bTableNumber: string; message: string }
  | { kind: "TOO_CLOSE"; aId: string; bId: string; aTableNumber: string; bTableNumber: string; gapPx: number; message: string };

// Center-based table → axis-aligned bounding box.
export function tableAabb(t: GeometryTable): Aabb {
  return {
    left: t.xPos - t.width / 2,
    right: t.xPos + t.width / 2,
    top: t.yPos - t.height / 2,
    bottom: t.yPos + t.height / 2,
  };
}

// Strict AABB intersection (touching counts as no overlap so the
// MIN_CLEARANCE check can take it from there).
export function aabbsOverlap(a: Aabb, b: Aabb): boolean {
  if (a.right <= b.left) return false;
  if (b.right <= a.left) return false;
  if (a.bottom <= b.top) return false;
  if (b.bottom <= a.top) return false;
  return true;
}

// Shortest axis-aligned gap between two AABBs. Returns 0 when the
// boxes touch but don't overlap, and a negative number when they
// overlap (depth of overlap in the more-overlapping axis).
export function aabbGap(a: Aabb, b: Aabb): number {
  const dx = Math.max(b.left - a.right, a.left - b.right);
  const dy = Math.max(b.top - a.bottom, a.top - b.bottom);
  // If both axes show negative (overlap) distance, the boxes overlap;
  // return the LARGER negative (least negative = least overlap depth).
  if (dx < 0 && dy < 0) return Math.max(dx, dy);
  // Otherwise the boxes are separated; clearance is the max of dx, dy.
  return Math.max(dx, dy, 0);
}

// Returns every spacing issue between non-archived tables. Stable
// ordering: by (aTableNumber, bTableNumber) so the editor's issue
// list doesn't reshuffle on every keystroke.
export function computeSpacingIssues(
  tables: ReadonlyArray<GeometryTable>,
  opts?: { minClearancePx?: number },
): SpacingIssue[] {
  const minClearance = opts?.minClearancePx ?? MIN_CLEARANCE_PX;
  const active = tables.filter((t) => !t.archived);
  const issues: SpacingIssue[] = [];
  for (let i = 0; i < active.length; i++) {
    for (let j = i + 1; j < active.length; j++) {
      const a = active[i]!;
      const b = active[j]!;
      const aBox = tableAabb(a);
      const bBox = tableAabb(b);
      if (aabbsOverlap(aBox, bBox)) {
        issues.push({
          kind: "OVERLAP",
          aId: a.id, bId: b.id,
          aTableNumber: a.tableNumber, bTableNumber: b.tableNumber,
          message: `${a.tableNumber} overlaps ${b.tableNumber}.`,
        });
        continue;
      }
      const gap = aabbGap(aBox, bBox);
      if (gap < minClearance) {
        issues.push({
          kind: "TOO_CLOSE",
          aId: a.id, bId: b.id,
          aTableNumber: a.tableNumber, bTableNumber: b.tableNumber,
          gapPx: Math.round(gap),
          message: `${a.tableNumber} is too close to ${b.tableNumber}. Minimum clearance is ${minClearance}px (current gap ${Math.round(gap)}px).`,
        });
      }
    }
  }
  // Stable order.
  issues.sort((x, y) => {
    const k = x.aTableNumber.localeCompare(y.aTableNumber);
    if (k !== 0) return k;
    return x.bTableNumber.localeCompare(y.bTableNumber);
  });
  return issues;
}

// Convenience: returns the set of plan-table ids that appear in any
// spacing issue. The editor uses this to paint offender outlines.
export function offenderIdSet(issues: ReadonlyArray<SpacingIssue>): Set<string> {
  const out = new Set<string>();
  for (const i of issues) {
    out.add(i.aId);
    out.add(i.bId);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Step 35 — sequential auto-naming for palette-dropped tables.
//
// `displayName` follows the human-readable convention the founder
// asked for: "Round 1", "Round 2", ..., per shape. We scan existing
// non-archived rows for the maximum integer suffix matching the
// shape's title-case prefix, and return prefix + (max + 1).
//
// `tableNumber` is the operational unique identifier the POS and
// reservations use. Convention: area-prefix + integer ("L1", "P1").
// We scan BOTH the draft plan AND the live DiningTable rows for the
// area so a new draft number doesn't collide with a live one and
// trip the publish-time unique-constraint guard.
//
// Both helpers are pure (no Prisma) — server passes pre-fetched
// rows; client computes locally when needed for preview.
// ---------------------------------------------------------------------------

// Step 40 — every new dropped table is named "Table N" regardless
// of its palette kind (Round / Square / Rectangle / Bar Stool).
// Operational vocabulary is the persisted `tableNumber` (L1, P2, …);
// the user-visible displayName is uniformly "Table N" so admins don't
// have to mentally translate between four naming conventions on the
// floor map. Existing historical "Round 1" / "Square 1" names on
// previously-saved tables are left alone — they're not counted toward
// the new "Table N" sequence (so we don't reuse a "Table 7" that
// historically named some other tile).
export const DISPLAY_NAME_PREFIX = "Table";

export function nextSequentialDisplayName(
  // Kept for source compatibility with callers that pass the palette
  // kind. The kind no longer drives the prefix.
  _kind: string,
  existingTables: ReadonlyArray<{ displayName?: string | null; archived?: boolean }>,
): string {
  const re = new RegExp(`^${DISPLAY_NAME_PREFIX}\\s+(\\d+)$`, "i");
  let max = 0;
  for (const t of existingTables) {
    if (t.archived) continue;
    if (!t.displayName) continue;
    const m = re.exec(t.displayName.trim());
    if (m) {
      const n = Number(m[1]);
      if (!Number.isNaN(n) && n > max) max = n;
    }
  }
  return `${DISPLAY_NAME_PREFIX} ${max + 1}`;
}

export function nextTableNumberForArea(
  areaPrefix: string,
  existingTableNumbers: ReadonlyArray<string>,
): string {
  // Sanity: prefer a single uppercase letter from the area name.
  const prefix = (areaPrefix || "T").trim().slice(0, 1).toUpperCase() || "T";
  const re = new RegExp(`^${prefix}(\\d+)$`);
  let max = 0;
  for (const n of existingTableNumbers) {
    const m = re.exec(n.trim());
    if (m) {
      const num = Number(m[1]);
      if (!Number.isNaN(num) && num > max) max = num;
    }
  }
  return `${prefix}${max + 1}`;
}

// Step 35/36 — defaults per palette kind. `kind` is the editor's
// vocabulary (Round / Square / Rectangle / Bar Stool); `shape` is
// what gets persisted on DiningFloorPlanTable.shape. Bar Stool maps
// to a small ROUND tile because the schema only carries the three
// canonical shapes.
export type PaletteKind = "ROUND" | "SQUARE" | "RECTANGLE" | "BAR_STOOL";
export type PersistedShape = "ROUND" | "SQUARE" | "RECTANGLE";

export const PALETTE_DEFAULTS: Record<PaletteKind, {
  shape: PersistedShape;
  width: number;
  height: number;
  capacity: number;
}> = {
  ROUND:     { shape: "ROUND",     width: 90,  height: 90, capacity: 4 },
  SQUARE:    { shape: "SQUARE",    width: 90,  height: 90, capacity: 4 },
  RECTANGLE: { shape: "RECTANGLE", width: 130, height: 80, capacity: 6 },
  // Bar Stool — visually a small round, capacity 1.
  BAR_STOOL: { shape: "ROUND",     width: 45,  height: 45, capacity: 1 },
};
