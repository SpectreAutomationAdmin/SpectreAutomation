// Step 35/36 — palette drop + sequential naming + edit modal.
//
// Pure helpers (nextSequentialDisplayName, nextTableNumberForArea,
// PALETTE_DEFAULTS) and the service-layer flow
// (addDraftTableFromPalette) get unit-tested here; the editor's drag
// + modal wiring is pinned by source-contract assertions because
// HTML5 DnD can't run in this vitest config.
//
// Step 36 added:
//  - Bar Stool palette kind (visually ROUND, capacity 1, 45×45,
//    displayName "Bar Stool N").
//  - Right-rail Tables list removed; double-click is the sole edit
//    path and the modal carries the Remove action.
//  - Optimistic drop: ghost row inserts immediately; Publish is
//    locked while ghosts pend.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  db, makeUser, principalFor, resetDb, seedRbac,
} from "./util/db";
import { bootstrapAPClub } from "./util/ap";
import {
  getOrCreateDraftForArea,
  addDraftTableFromPalette,
  archiveDraftTable,
  publishDraft,
} from "@/lib/hospitality/floor-plan";
import {
  nextSequentialDisplayName,
  nextTableNumberForArea,
  PALETTE_DEFAULTS,
} from "@/lib/hospitality/floor-plan-geometry";

async function bootstrap(name: string) {
  const club = await bootstrapAPClub(name);
  const lounge = await db().diningArea.create({
    data: { clubId: club.id, name: "Lounge", sortOrder: 0 },
  });
  const patio = await db().diningArea.create({
    data: { clubId: club.id, name: "Patio", sortOrder: 1 },
  });
  // Seed L1 + P1 so getOrCreateDraft has something to clone.
  await db().diningTable.create({
    data: {
      clubId: club.id, diningAreaId: lounge.id, tableNumber: "L1", capacity: 4,
      shape: "SQUARE", xPos: 100, yPos: 100, width: 80, height: 80,
    },
  });
  await db().diningTable.create({
    data: {
      clubId: club.id, diningAreaId: patio.id, tableNumber: "P1", capacity: 4,
      shape: "ROUND", xPos: 100, yPos: 100, width: 80, height: 80,
    },
  });
  const adminEmail = `palette-${club.id}@example.com`;
  await makeUser({ email: adminEmail, role: "CLUB_ADMIN", clubId: club.id });
  const admin = await principalFor(adminEmail);
  return { club, lounge, patio, admin };
}

beforeAll(async () => { await resetDb(); await seedRbac(); });
beforeEach(async () => { await resetDb(); await seedRbac(); });

// =============================================================================
// Step 40 — every new dropped table is named "Table N" regardless of its
// palette kind. Historical "Round 1" / "Square 1" / "Bar Stool 1" names
// on previously-saved tables are not counted toward the new sequence.
// =============================================================================
describe("Step 40 — sequential display name is uniform 'Table N'", () => {
  it("Table 1 + Table 2 existing → Table 3 (regardless of kind passed)", () => {
    for (const k of ["ROUND", "SQUARE", "RECTANGLE", "BAR_STOOL"] as const) {
      expect(
        nextSequentialDisplayName(k, [
          { displayName: "Table 1" },
          { displayName: "Table 2" },
        ]),
      ).toBe("Table 3");
    }
  });

  it("empty list → Table 1 regardless of kind", () => {
    for (const k of ["ROUND", "SQUARE", "RECTANGLE", "BAR_STOOL"] as const) {
      expect(nextSequentialDisplayName(k, [])).toBe("Table 1");
    }
  });

  it("ignores archived 'Table N' rows when picking the next number", () => {
    expect(
      nextSequentialDisplayName("ROUND", [
        { displayName: "Table 1" },
        { displayName: "Table 2", archived: true },
      ]),
    ).toBe("Table 2");
  });

  it("historical Round/Square/Rectangle/Bar Stool names do NOT count toward Table sequence", () => {
    // A draft full of pre-step-40 names — the next new drop is "Table 1"
    // because no existing "Table N" row exists yet.
    expect(
      nextSequentialDisplayName("ROUND", [
        { displayName: "Round 1" },
        { displayName: "Square 1" },
        { displayName: "Rectangle 1" },
        { displayName: "Bar Stool 1" },
      ]),
    ).toBe("Table 1");
  });

  it("uses the highest existing Table number, not count (Table 1 + Table 5 → Table 6)", () => {
    expect(
      nextSequentialDisplayName("ROUND", [
        { displayName: "Table 1" },
        { displayName: "Table 5" },
      ]),
    ).toBe("Table 6");
  });

  it("mix of legacy + new names: new drop continues the Table sequence only", () => {
    expect(
      nextSequentialDisplayName("BAR_STOOL", [
        { displayName: "Round 1" },        // legacy — ignored
        { displayName: "Table 1" },        // counted
        { displayName: "Table 2" },        // counted
        { displayName: "Bar Stool 7" },    // legacy — ignored
      ]),
    ).toBe("Table 3");
  });
});

// =============================================================================
// Pure helper — nextTableNumberForArea.
// =============================================================================
describe("Spec 12 — generated tableNumber is unique within the area", () => {
  it("Lounge with L1 + L2 → L3", () => {
    expect(nextTableNumberForArea("L", ["L1", "L2"])).toBe("L3");
  });

  it("Patio with P1 + P2 → P3", () => {
    expect(nextTableNumberForArea("P", ["P1", "P2"])).toBe("P3");
  });

  it("ignores numbers that don't match the prefix", () => {
    expect(nextTableNumberForArea("L", ["L1", "P9", "L2"])).toBe("L3");
  });

  it("returns Prefix1 when no existing numbers match", () => {
    expect(nextTableNumberForArea("L", [])).toBe("L1");
    expect(nextTableNumberForArea("P", ["L1", "L2"])).toBe("P1");
  });

  it("falls back to T prefix when given an empty / whitespace area prefix", () => {
    expect(nextTableNumberForArea("", [])).toBe("T1");
  });
});

// =============================================================================
// Palette defaults.
// =============================================================================
describe("Palette defaults match the spec", () => {
  it("ROUND → 90×90, capacity 4, persisted as ROUND", () => {
    expect(PALETTE_DEFAULTS.ROUND).toEqual({
      shape: "ROUND", width: 90, height: 90, capacity: 4,
    });
  });
  it("SQUARE → 90×90, capacity 4, persisted as SQUARE", () => {
    expect(PALETTE_DEFAULTS.SQUARE).toEqual({
      shape: "SQUARE", width: 90, height: 90, capacity: 4,
    });
  });
  it("RECTANGLE → 130×80, capacity 6, persisted as RECTANGLE", () => {
    expect(PALETTE_DEFAULTS.RECTANGLE).toEqual({
      shape: "RECTANGLE", width: 130, height: 80, capacity: 6,
    });
  });
  // Step 36 — Bar Stool defaults: small round, single seat.
  it("BAR_STOOL → 45×45, capacity 1, persisted as ROUND (schema only carries ROUND/SQUARE/RECTANGLE)", () => {
    expect(PALETTE_DEFAULTS.BAR_STOOL).toEqual({
      shape: "ROUND", width: 45, height: 45, capacity: 1,
    });
  });
});

// =============================================================================
// Spec 3/4/5 — addDraftTableFromPalette creates the right shape.
// =============================================================================
describe("Specs 3/4/5 — palette drop creates the chosen shape", () => {
  for (const kind of ["ROUND", "SQUARE", "RECTANGLE"] as const) {
    it(`palette drop of ${kind} creates a ${kind} draft row`, async () => {
      const ctx = await bootstrap(`drop-${kind.toLowerCase()}`);
      const plan = await getOrCreateDraftForArea(ctx.admin, ctx.club.id, ctx.lounge.id);
      const row = await addDraftTableFromPalette(ctx.admin, plan.id, {
        kind, xPos: 300, yPos: 300,
      });
      expect(row.shape).toBe(kind);
    });
  }

  // Step 36/40 — Bar Stool round-trip through the service. As of
  // step 40 the displayName is uniform "Table N" regardless of kind.
  it("palette drop of BAR_STOOL creates a ROUND row labelled 'Table 1' at 45×45 capacity 1", async () => {
    const ctx = await bootstrap("drop-bar-stool");
    const plan = await getOrCreateDraftForArea(ctx.admin, ctx.club.id, ctx.lounge.id);
    const row = await addDraftTableFromPalette(ctx.admin, plan.id, {
      kind: "BAR_STOOL", xPos: 300, yPos: 300,
    });
    expect(row.shape).toBe("ROUND");
    expect(row.displayName).toBe("Table 1");
    expect(row.width).toBe(45);
    expect(row.height).toBe(45);
    expect(row.capacity).toBe(1);
  });
});

// =============================================================================
// Spec 6 — table is placed at the drop coordinates.
// Spec 7 — sequential naming applies (covered above for the pure
// helper; here we prove the service flows through correctly).
// =============================================================================
describe("Spec 6/7 — placement + sequential naming end-to-end", () => {
  it("first Round drop on a clean draft is Round 1, second is Round 2", async () => {
    const ctx = await bootstrap("seq-end-to-end");
    const plan = await getOrCreateDraftForArea(ctx.admin, ctx.club.id, ctx.lounge.id);
    const r1 = await addDraftTableFromPalette(ctx.admin, plan.id, {
      kind: "ROUND", xPos: 300, yPos: 300,
    });
    const r2 = await addDraftTableFromPalette(ctx.admin, plan.id, {
      kind: "ROUND", xPos: 500, yPos: 300,
    });
    expect(r1.displayName).toBe("Table 1");
    expect(r2.displayName).toBe("Table 2");
    expect(r1.xPos).toBe(300);
    expect(r1.yPos).toBe(300);
  });

  it("tableNumber is unique and sequenced from the area prefix (Lounge → L2 because L1 is seeded)", async () => {
    const ctx = await bootstrap("seq-area-prefix");
    const plan = await getOrCreateDraftForArea(ctx.admin, ctx.club.id, ctx.lounge.id);
    const r = await addDraftTableFromPalette(ctx.admin, plan.id, {
      kind: "ROUND", xPos: 300, yPos: 300,
    });
    expect(r.tableNumber).toBe("L2");
  });

  it("Patio drops use P prefix", async () => {
    const ctx = await bootstrap("patio-prefix");
    const plan = await getOrCreateDraftForArea(ctx.admin, ctx.club.id, ctx.patio.id);
    const r = await addDraftTableFromPalette(ctx.admin, plan.id, {
      kind: "ROUND", xPos: 300, yPos: 300,
    });
    expect(r.tableNumber).toBe("P2");
  });

  // Step 36/40 — multiple drops in a row use the uniform Table sequence.
  it("three drops yield Table 1 / 2 / 3 sequentially regardless of kind", async () => {
    const ctx = await bootstrap("mixed-seq");
    const plan = await getOrCreateDraftForArea(ctx.admin, ctx.club.id, ctx.lounge.id);
    const a = await addDraftTableFromPalette(ctx.admin, plan.id, { kind: "BAR_STOOL", xPos: 200, yPos: 200 });
    const b = await addDraftTableFromPalette(ctx.admin, plan.id, { kind: "ROUND",     xPos: 400, yPos: 200 });
    const c = await addDraftTableFromPalette(ctx.admin, plan.id, { kind: "RECTANGLE", xPos: 600, yPos: 200 });
    expect(a.displayName).toBe("Table 1");
    expect(b.displayName).toBe("Table 2");
    expect(c.displayName).toBe("Table 3");
    // Each gets the next available L-prefixed tableNumber.
    expect(a.tableNumber).toBe("L2");
    expect(b.tableNumber).toBe("L3");
    expect(c.tableNumber).toBe("L4");
  });
});

// =============================================================================
// Spec 18 — new dragged table participates in overlap validation.
// Spec 19 — Save Draft / Publish workflow still works.
// =============================================================================
describe("Specs 18/19 — palette drops participate in spacing rules", () => {
  it("dropping a table on top of L1 produces a spacing issue (overlap)", async () => {
    const ctx = await bootstrap("overlap-after-drop");
    const plan = await getOrCreateDraftForArea(ctx.admin, ctx.club.id, ctx.lounge.id);
    // Drop a Round table on top of L1 (which sits at 100,100 80×80).
    await addDraftTableFromPalette(ctx.admin, plan.id, {
      kind: "ROUND", xPos: 100, yPos: 100,
    });
    const { validateDraftForPublish } = await import("@/lib/hospitality/floor-plan");
    const issues = await validateDraftForPublish(ctx.admin, plan.id);
    expect(issues.some((i) => /overlap/i.test(i.message))).toBe(true);
  });
});

// =============================================================================
// Specs 20/21 — Live POS isolation + publish makes it live.
// =============================================================================
describe("Specs 20/21 — draft isolation + publish go-live", () => {
  it("palette drop is not in DiningTable until publish; after publish it is", async () => {
    const ctx = await bootstrap("isolation-and-publish");
    const plan = await getOrCreateDraftForArea(ctx.admin, ctx.club.id, ctx.lounge.id);
    const r = await addDraftTableFromPalette(ctx.admin, plan.id, {
      kind: "ROUND", xPos: 400, yPos: 400,
    });
    let live = await db().diningTable.findFirst({
      where: { clubId: ctx.club.id, tableNumber: r.tableNumber },
    });
    expect(live).toBeNull();
    await publishDraft(ctx.admin, plan.id);
    live = await db().diningTable.findFirst({
      where: { clubId: ctx.club.id, tableNumber: r.tableNumber },
    });
    expect(live?.active).toBe(true);
    expect(live?.shape).toBe("ROUND");
  });

  // Step 36/40 — Bar Stool persists as ROUND on DiningTable; the
  // uniform displayName is "Table N".
  it("Bar Stool publish persists as ROUND on DiningTable with displayName 'Table 1'", async () => {
    const ctx = await bootstrap("bar-stool-publish");
    const plan = await getOrCreateDraftForArea(ctx.admin, ctx.club.id, ctx.lounge.id);
    const r = await addDraftTableFromPalette(ctx.admin, plan.id, {
      kind: "BAR_STOOL", xPos: 400, yPos: 400,
    });
    await publishDraft(ctx.admin, plan.id);
    const live = await db().diningTable.findFirst({
      where: { clubId: ctx.club.id, tableNumber: r.tableNumber },
    });
    expect(live?.shape).toBe("ROUND");
    expect(live?.displayName).toBe("Table 1");
    expect(live?.capacity).toBe(1);
    expect(live?.width).toBe(45);
    expect(live?.height).toBe(45);
  });
});

// =============================================================================
// Spec 22 — cross-tenant edit/create is blocked.
// =============================================================================
describe("Spec 22 — cross-tenant palette drop is rejected", () => {
  it("admin of club A cannot drop onto club B's draft", async () => {
    const a = await bootstrap("ct-a");
    const b = await bootstrap("ct-b");
    const bPlan = await getOrCreateDraftForArea(b.admin, b.club.id, b.lounge.id);
    await expect(
      addDraftTableFromPalette(a.admin, bPlan.id, { kind: "ROUND", xPos: 300, yPos: 300 }),
    ).rejects.toThrow();
  });

  // Step 36 — Bar Stool gets the same tenant isolation as the other kinds.
  it("Bar Stool drop is rejected cross-tenant", async () => {
    const a = await bootstrap("ct-bs-a");
    const b = await bootstrap("ct-bs-b");
    const bPlan = await getOrCreateDraftForArea(b.admin, b.club.id, b.lounge.id);
    await expect(
      addDraftTableFromPalette(a.admin, bPlan.id, { kind: "BAR_STOOL", xPos: 300, yPos: 300 }),
    ).rejects.toThrow();
  });
});

// =============================================================================
// Sequential naming continues correctly after an archive.
// =============================================================================
describe("Sequential naming respects archived rows (uses highest number, not count)", () => {
  it("Table 1 + archived Table 2 → next palette drop is Table 2 (slot reclaimed)", async () => {
    const ctx = await bootstrap("seq-archive");
    const plan = await getOrCreateDraftForArea(ctx.admin, ctx.club.id, ctx.lounge.id);
    await addDraftTableFromPalette(ctx.admin, plan.id, { kind: "ROUND", xPos: 300, yPos: 300 });
    const r2 = await addDraftTableFromPalette(ctx.admin, plan.id, { kind: "ROUND", xPos: 500, yPos: 300 });
    await archiveDraftTable(ctx.admin, r2.id);
    const r3 = await addDraftTableFromPalette(ctx.admin, plan.id, { kind: "ROUND", xPos: 700, yPos: 300 });
    expect(r3.displayName).toBe("Table 2");
  });
});

// =============================================================================
// Source contract — palette + drop + edit modal are wired in the editor.
// (HTML5 DnD can't run in this vitest config; we pin code shape instead.)
// =============================================================================
describe("Specs 1/2/13 — palette UI + drop + edit modal source contract", () => {
  const SRC = fs.readFileSync(
    path.resolve(process.cwd(), "src/app/app/admin/ops/floor-plans/FloorPlanEditor.tsx"),
    "utf8",
  );

  it("Specs 1/2 — AddTablePalette renders four kind cards (Round, Square, Rectangle, Bar Stool)", () => {
    expect(SRC).toMatch(/function AddTablePalette/);
    // testid is interpolated from the kind constant.
    expect(SRC).toMatch(/data-testid=\{`palette-kind-\$\{k\.kind\.toLowerCase\(\)\}`\}/);
    expect(SRC).toMatch(/kind: "ROUND"/);
    expect(SRC).toMatch(/kind: "SQUARE"/);
    expect(SRC).toMatch(/kind: "RECTANGLE"/);
    expect(SRC).toMatch(/kind: "BAR_STOOL"/);
    // Bar Stool gets a visible label "Bar Stool" — must not look like a typo.
    expect(SRC).toMatch(/label: "Bar Stool"/);
  });

  it("Spec 7 — palette items expose draggable + setData with the kind key", () => {
    expect(SRC).toMatch(/draggable=\{!pending\}/);
    expect(SRC).toMatch(/setData\("application\/x-spectre-table-shape", k\.kind\)/);
  });

  it("Specs 3/4/5/6 — canvas wires onDragOver + onDrop, accepts BAR_STOOL, converts client coords + snaps to 10px", () => {
    expect(SRC).toMatch(/onDragOver=\{\(e\) => \{/);
    expect(SRC).toMatch(/onDrop=\{\(e\) => \{/);
    expect(SRC).toMatch(/Math\.round\(vb\.x \/ 10\) \* 10/);
    expect(SRC).toMatch(/Math\.round\(vb\.y \/ 10\) \* 10/);
    expect(SRC).toMatch(/onPaletteDrop\(kind as PaletteKind, snappedX, snappedY\)/);
    // Bar Stool must survive the drop guard.
    expect(SRC).toMatch(/kind !== "BAR_STOOL"/);
  });

  it("Spec 13 — double-click on a non-ghost tile opens the edit modal", () => {
    expect(SRC).toMatch(/onDoubleClick=\{\(e\) =>[\s\S]+?onOpenEditModal\?\.\(t\.id\)/);
    // Ghost tiles don't open the modal.
    expect(SRC).toMatch(/t\.id\.startsWith\("temp_"\)/);
  });

  it("Specs 14/15/16/17 — EditTableModal renders inputs for name, capacity, width, height + Save/Cancel", () => {
    expect(SRC).toMatch(/data-testid="edit-table-modal"/);
    expect(SRC).toMatch(/Table number/);
    expect(SRC).toMatch(/Display name/);
    expect(SRC).toMatch(/Capacity/);
    expect(SRC).toMatch(/Width/);
    expect(SRC).toMatch(/Height/);
    expect(SRC).toMatch(/Math\.max\(1, Math\.min\(24, Number/);
  });

  it("Modal Save calls updateTableAction with the patch fields", () => {
    expect(SRC).toMatch(/onSave=\{\(patch\) => \{[\s\S]+?updateTableAction\(editingTable\.id, patch\)/);
  });

  // Step 36 — Modal carries a Remove action; it calls archiveTableAction
  // and the same server-side blockers still apply.
  it("Spec 36/Remove — EditTableModal carries a 'Remove table' button that calls archiveTableAction", () => {
    expect(SRC).toMatch(/data-testid="edit-table-modal-remove"/);
    expect(SRC).toMatch(/Remove table/);
    expect(SRC).toMatch(/onRemove=\{\(\) => \{[\s\S]+?archiveTableAction\(editingTable\.id\)/);
  });

  it("addTableFromPaletteAction is imported and used by commitPaletteDrop", () => {
    expect(SRC).toMatch(/addTableFromPaletteAction/);
    expect(SRC).toMatch(/function commitPaletteDrop[\s\S]+?addTableFromPaletteAction\(draft\.id/);
  });

  // Step 36 — the right-rail per-row Tables list is gone. The
  // editor must not render <TableRow> rows or a "Tables" h3.
  it("Spec 36/Tables-list — right-rail per-row Tables list has been removed", () => {
    expect(SRC).not.toMatch(/<TableRow /);
    expect(SRC).not.toMatch(/function TableRow\(/);
    expect(SRC).not.toMatch(/<h3[^>]*>Tables<\/h3>/);
  });

  // Step 36 — right rail is a dedicated palette + status surface.
  it("Spec 36/Palette-right-rail — AddTablePalette is the primary right-rail content", () => {
    expect(SRC).toMatch(/<AddTablePalette/);
    expect(SRC).not.toMatch(/<AddTableForm /);
    // Editor tips block (informational, fills leftover space).
    expect(SRC).toMatch(/Editing tips/);
  });

  // Step 36 — optimistic UI shape: pendingDrops state + ghost tables
  // + Publish locked while ghosts pend.
  it("Spec 36/Optimistic — pendingDrops state + ghost tables + Publish lock", () => {
    expect(SRC).toMatch(/setPendingDrops/);
    expect(SRC).toMatch(/ghostTables/);
    expect(SRC).toMatch(/hasPendingDrops/);
    // Publish disabled while a drop OR a move is in flight (step 37 extends this).
    expect(SRC).toMatch(/disabled=\{pending \|\| hasPendingDrops \|\| hasPendingMoves\}/);
    // On server failure the ghost is rolled back.
    expect(SRC).toMatch(/setPendingDrops\(\(prev\) => prev\.filter\(\(p\) => p\.tempId !== tempId\)\)/);
  });

  it("Spec 36/PaletteKind — service action takes `kind` not `shape`", () => {
    expect(SRC).toMatch(/addTableFromPaletteAction\(draft\.id, \{ kind, xPos, yPos \}\)/);
    expect(SRC).toMatch(/function commitPaletteDrop\(kind: PaletteKind/);
  });

  // ============================================================================
  // Step 37 — drop no longer auto-opens the modal; existing-table drag is
  // optimistic so it never snaps back; Publish waits for in-flight moves.
  // ============================================================================
  describe("Step 37 — interaction polish", () => {
    it("Task 1 — commitPaletteDrop success branch does NOT call setEditModalId (no auto-open)", () => {
      // Pull the commitPaletteDrop function body so we can assert about
      // its success path specifically — the rest of the file legitimately
      // mentions setEditModalId in onDoubleClick wiring.
      const match = SRC.match(/function commitPaletteDrop\([\s\S]+?\n  \}\n/);
      expect(match, "commitPaletteDrop should exist in editor source").toBeTruthy();
      const body = match![0];
      expect(body).not.toMatch(/setEditModalId\(r\.data\.id\)/);
      // Selection sticking after drop is allowed and useful.
      expect(body).toMatch(/setSelectedTableId\(r\.data\.id\)/);
    });

    it("Task 2 — pendingMoves state exists; commitDragMove sets it BEFORE awaiting the server", () => {
      expect(SRC).toMatch(/const \[pendingMoves, setPendingMoves\] = useState/);
      // Match the body of commitDragMove and assert setPendingMoves
      // appears before the startTransition callback (i.e. before the
      // server roundtrip is queued). This guarantees the very next
      // render after pointerup keeps the tile at the new coords.
      const match = SRC.match(/function commitDragMove\([\s\S]+?\n  \}\n/);
      expect(match, "commitDragMove should exist").toBeTruthy();
      const body = match![0];
      const setIdx = body.indexOf("setPendingMoves((prev) => ({");
      const transitionIdx = body.indexOf("startTransition(");
      expect(setIdx).toBeGreaterThan(-1);
      expect(transitionIdx).toBeGreaterThan(-1);
      expect(setIdx).toBeLessThan(transitionIdx);
    });

    it("Task 2 — failed move reverts override and shows the user-facing error", () => {
      const match = SRC.match(/function commitDragMove\([\s\S]+?\n  \}\n/);
      const body = match![0];
      expect(body).toMatch(/Move could not be saved\. Reverted to previous position\./);
      // The override is removed on failure (revert path).
      expect(body).toMatch(/setPendingMoves\(\(prev\) => \{[\s\S]+?delete next\[tableId\];/);
    });

    it("Task 2 — draftWithGhosts memo folds pendingMoves so validation/canvas use optimistic position", () => {
      // The memo dependency array includes pendingMoves AND the body
      // applies the override before appending ghost tables.
      expect(SRC).toMatch(/\}, \[draft, ghostTables, pendingMoves\]\);/);
      expect(SRC).toMatch(/const move = pendingMoves\[t\.id\]/);
    });

    it("Task 2 — Publish gate covers hasPendingMoves (existing-table moves)", () => {
      expect(SRC).toMatch(/const hasPendingMoves = Object\.keys\(pendingMoves\)\.length > 0/);
      // Publish button title surfaces a friendly explanation while
      // anything is mid-save.
      expect(SRC).toMatch(/Wait for in-flight changes to save before publishing\./);
    });

    it("Task 2 — savingIds prop flows from the editor into PreviewCanvas for the saving cue", () => {
      // The editor builds the set from pendingMoves keys.
      expect(SRC).toMatch(/const savingIds = useMemo<Set<string>>\(\s*\(\) => new Set\(Object\.keys\(pendingMoves\)\)/);
      // It is passed to PreviewCanvas.
      expect(SRC).toMatch(/savingIds=\{savingIds\}/);
      // The canvas applies a subtle opacity to saving tiles AND exposes
      // a data-saving attribute so tests + DevTools can pick it out.
      expect(SRC).toMatch(/data-saving=\{isSaving \? "true" : undefined\}/);
      // Step 42 added the isDragging branch in front of isGhost/isSaving
      // (dimmed-source-tile while ghost is in flight). Match the new shape.
      expect(SRC).toMatch(/opacity=\{isDragging \? 0\.3 : isGhost \? 0\.55 : isSaving \? 0\.8 : 1\}/);
    });

    it("Task 2 — Publish button title + label reflect pending-move state", () => {
      // Label flips to "Saving moves…" when only moves are pending.
      expect(SRC).toMatch(/hasPendingMoves\s*[\s\S]*?"Saving moves…"/);
    });
  });

  // ============================================================================
  // Step 38 — flicker root-cause fix. Override is kept until the persisted
  // prop catches up (async router.refresh window), not cleared on a timer.
  // ============================================================================
  describe("Step 38 — flicker fix (reconciliation, not timer)", () => {
    it("commitDragMove success branch does NOT clear pendingMoves synchronously after refresh()", () => {
      const match = SRC.match(/function commitDragMove\([\s\S]+?\n  \}\n/);
      expect(match, "commitDragMove must exist").toBeTruthy();
      const body = match![0];
      // Failure branch still clears (revert path). Success branch does
      // NOT — that's the flicker fix. Sanity check by counting
      // setPendingMoves((prev) => { ... delete next[tableId]; ... })
      // patterns in the body — must be exactly ONE (the failure path).
      const deletes = body.match(/delete next\[tableId\];/g) ?? [];
      expect(deletes.length, "exactly one delete in failure branch").toBe(1);
    });

    it("reconciliation useEffect drops the override when persisted catches up", () => {
      // The effect watches [draft, pendingMoves] and removes entries
      // whose persisted xPos/yPos already match the override.
      expect(SRC).toMatch(/useEffect\(\(\) => \{[\s\S]+?persisted\.xPos === move\.xPos && persisted\.yPos === move\.yPos[\s\S]+?\}, \[draft, pendingMoves\]\);/);
    });

    it("tile group exposes data-x / data-y for Playwright assertions", () => {
      expect(SRC).toMatch(/data-x=\{cx\}/);
      expect(SRC).toMatch(/data-y=\{cy\}/);
    });

    it("data-x / data-y use the rendered (optimistic) coordinate, not raw t.xPos", () => {
      // Step 39 changed how cx/cy are computed (ref-based drag means
      // React never sees per-pointermove updates), but the rendered
      // value is still the optimistic-overlay coordinate, which is
      // exactly what the user sees.
      expect(SRC).toMatch(/const cx = t\.xPos;/);
      expect(SRC).toMatch(/const cy = t\.yPos;/);
    });
  });

  // ============================================================================
  // Step 39 — keyboard delete. Drag-perf assertions from this step are
  // superseded by Step 42 (floating HTML ghost). Keyboard delete contract
  // is unchanged.
  // ============================================================================
  describe("Step 39 — keyboard delete", () => {
    it("keyboard delete handler exists with input/modal safety gates", () => {
      expect(SRC).toMatch(/e\.key !== "Delete" && e\.key !== "Backspace"/);
      expect(SRC).toMatch(/selectedTableId\.startsWith\("temp_"\)/);
      expect(SRC).toMatch(/editModalId \|\| publishConfirm/);
      expect(SRC).toMatch(/tag === "INPUT" \|\| tag === "TEXTAREA" \|\| tag === "SELECT"/);
      expect(SRC).toMatch(/isContentEditable/);
    });

    it("keyboard delete calls archiveTableAction (same server path as the modal Remove)", () => {
      expect(SRC).toMatch(/window\.addEventListener\("keydown", onKeyDown\)/);
      expect(SRC).toMatch(/archiveTableAction\(selectedTableId\)/);
    });
  });

  // ============================================================================
  // Step 40 — free-float drag + SVG overflow + Table N naming. The free-float
  // contract is now satisfied by the position:fixed ghost (step 42), not
  // SVG transforms, but the SVG overflow rule + the palette naming still
  // apply to the underlying canvas.
  // ============================================================================
  describe("Step 40 — uniform naming + SVG overflow", () => {
    it("SVG canvas allows overflow so a dragged tile can escape the viewBox", () => {
      expect(SRC).toMatch(/style=\{\{ overflow: "visible" \}\}/);
    });

    it("palette tooltips use 'auto-named Table N' (uniform naming)", () => {
      expect(SRC).toMatch(/auto-named Table N/);
      expect(SRC).not.toMatch(/Auto-named Round N/);
      expect(SRC).not.toMatch(/Auto-named Square N/);
      expect(SRC).not.toMatch(/Auto-named Rectangle N/);
      expect(SRC).not.toMatch(/Auto-named Bar Stool N/);
    });
  });

  // ============================================================================
  // Step 42 — FLOATING HTML GHOST DRAG. SVG transform dragging is gone;
  // the drag visual is now a position:fixed <div> at viewport level.
  // ============================================================================
  describe("Step 42 — floating HTML ghost drag", () => {
    it("floatingDrag state replaces SVG-transform drag (no dragRef element)", () => {
      // The old dragRef holding an SVGGElement is gone.
      expect(SRC).not.toMatch(/element: SVGGElement;/);
      // New state shape: tableId + viewBox snapshot + ghost pixel size.
      expect(SRC).toMatch(/const \[floatingDrag, setFloatingDrag\] = useState<FloatingDrag \| null>/);
      expect(SRC).toMatch(/ghostPxWidth: number;/);
      expect(SRC).toMatch(/ghostPxHeight: number;/);
    });

    it("ghost is rendered with position:fixed + transform translate(-50%,-50%)", () => {
      expect(SRC).toMatch(/data-testid="floor-plan-floating-drag-ghost"/);
      expect(SRC).toMatch(/position: "fixed"/);
      expect(SRC).toMatch(/transform: "translate\(-50%, -50%\)"/);
      // zIndex high so the ghost sits above all other UI chrome.
      expect(SRC).toMatch(/zIndex: 9999/);
      expect(SRC).toMatch(/pointerEvents: "none"/);
    });

    it("onPointerMove updates the ghost element's left/top directly (no React state)", () => {
      const match = SRC.match(/function onPointerMove\([\s\S]+?\n  \}\n/);
      expect(match, "onPointerMove must exist").toBeTruthy();
      const body = match![0];
      // Direct DOM mutation of the ghost element.
      expect(body).toMatch(/el\.style\.left = `\$\{e\.clientX\}px`/);
      expect(body).toMatch(/el\.style\.top = `\$\{e\.clientY\}px`/);
      // No SVG transform mutation anywhere in the hot path.
      expect(body).not.toMatch(/setAttribute\("transform"/);
      // No clamp / snap / server call during drag.
      expect(body).not.toMatch(/clampToCanvas\(/);
      expect(body).not.toMatch(/onCommitDragMove\(/);
      expect(body).not.toMatch(/updateTableAction\(/);
    });

    it("onPointerUp converts cursor → viewBox, clamps, snaps, commits exactly once", () => {
      const match = SRC.match(/function onPointerUp\([\s\S]+?\n  \}\n/);
      expect(match).toBeTruthy();
      const body = match![0];
      // Conversion + clamp use floatingDrag's snapshot, not stale refs.
      expect(body).toMatch(/clientToViewBox\(final\.x, final\.y\)/);
      expect(body).toMatch(/floatingDrag\.viewBoxWidth/);
      expect(body).toMatch(/floatingDrag\.viewBoxHeight/);
      expect(body).toMatch(/Math\.round\(clamped\.x \/ 10\) \* 10/);
      expect(body).toMatch(/Math\.round\(clamped\.y \/ 10\) \* 10/);
      const calls = body.match(/onCommitDragMove\(/g) ?? [];
      expect(calls.length, "exactly one onCommitDragMove call").toBe(1);
      // floatingDrag cleared on release so the ghost unmounts.
      expect(body).toMatch(/setFloatingDrag\(null\)/);
    });

    it("original SVG tile is dimmed (opacity 0.3) while the ghost is in flight", () => {
      // The render's opacity expression includes the isDragging branch.
      expect(SRC).toMatch(/opacity=\{isDragging \? 0\.3/);
    });

    it("debug HUD measures the ghost element vs cursor (not the SVG shape)", () => {
      // The helper queries the ghost ref, not a shape inside the <g>.
      expect(SRC).toMatch(/updateDebugFromGhost\(/);
      expect(SRC).toMatch(/ghostElRef\.current/);
    });
  });
});
