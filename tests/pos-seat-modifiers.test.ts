// POS cleanup step 3 — modifiers on the SeatPOS workflow.
//
// The modifier engine (POSModifierGroup / Option / POSCheckLineModifier
// service in src/lib/pos/modifiers.ts) is reused — we are NOT building
// a second engine. These tests pin the seat-side wiring:
//   - the SeatPOS UI exposes Modify on DRAFT lines only,
//   - the per-line modifier rows flow from page.tsx into the client,
//   - line and check totals reflect modifier price deltas,
//   - chits emitted from the seat workflow carry the modifier rows,
//   - allergy + free-text + cross-tenant rules hold via the existing
//     service.
//
// Settlement, split bill, QR pay, receipts, analytics, and the Quick
// Sale / Bar flow are all out of scope for this task.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { db, makeClub, makeMember, makeUser, principalFor, resetDb, seedRbac } from "./util/db";
import { bootstrapAPClub } from "./util/ap";
import { seatTable, seatSummary } from "@/lib/pos/seat-checks";
import {
  addCheckLines, sendUnsentItems, listChitsForStation,
} from "@/lib/pos/checks";
import {
  listModifiersForItem, setLineModifiers, modifierDeltaPerUnit, summarizeModifiers,
} from "@/lib/pos/modifiers";
import { LOUNGE_LOCATION_CODE, LOUNGE_TERMINAL_CODE } from "@/lib/pos/lounge";
import { ConflictError, ValidationError } from "@/lib/errors";

// Bootstrap with one item that has every modifier group type wired —
// the same shape the real Silver Springs lounge seeds.
async function bootstrapSeatedTableWithModifiers(name: string) {
  const club = await bootstrapAPClub(name);
  const fbDept = await db().department.findFirst({ where: { clubId: club.id, code: "FB" } });
  const loc = await db().pOSLocation.create({
    data: { clubId: club.id, code: LOUNGE_LOCATION_CODE, name: "Clubhouse Lounge", departmentId: fbDept?.id ?? null },
  });
  const terminal = await db().pOSTerminal.create({
    data: { clubId: club.id, code: LOUNGE_TERMINAL_CODE, name: "Lounge Terminal", locationId: loc.id },
  });
  await db().pOSSession.create({
    data: { clubId: club.id, locationId: loc.id, terminalId: terminal.id, status: "OPEN", openingFloat: 0 },
  });

  // Mains (KITCHEN) + Drinks (BAR) so the send pass produces chits at
  // both stations.
  const foodCat = await db().pOSMenuCategory.create({
    data: { clubId: club.id, locationId: loc.id, name: "Mains", sortOrder: 1, isActive: true, chitDestination: "KITCHEN" },
  });
  const drinkCat = await db().pOSMenuCategory.create({
    data: { clubId: club.id, locationId: loc.id, name: "Drinks", sortOrder: 2, isActive: true, chitDestination: "BAR" },
  });
  const burger = await db().pOSMenuItem.create({
    data: { clubId: club.id, categoryId: foodCat.id, name: "Classic Burger", price: 18, taxable: true, isActive: true },
  });
  const beer = await db().pOSMenuItem.create({
    data: { clubId: club.id, categoryId: drinkCat.id, name: "House Lager", price: 8, taxable: true, isActive: true },
  });

  // Modifier catalog for the burger: Remove, Add (with priceDelta),
  // Substitute (with priceDelta).
  const removeGroup = await db().pOSModifierGroup.create({
    data: {
      clubId: club.id, menuItemId: burger.id,
      modifierType: "REMOVE", label: "Remove", sortOrder: 0, isActive: true,
    },
  });
  const optNoOnions = await db().pOSModifierOption.create({
    data: { clubId: club.id, groupId: removeGroup.id, label: "No onions", sortOrder: 0, isActive: true, priceDelta: 0 },
  });
  const optNoSauce = await db().pOSModifierOption.create({
    data: { clubId: club.id, groupId: removeGroup.id, label: "No sauce", sortOrder: 1, isActive: true, priceDelta: 0 },
  });
  const addGroup = await db().pOSModifierGroup.create({
    data: {
      clubId: club.id, menuItemId: burger.id,
      modifierType: "ADD", label: "Add", sortOrder: 1, isActive: true,
    },
  });
  const optBacon = await db().pOSModifierOption.create({
    data: { clubId: club.id, groupId: addGroup.id, label: "Add bacon", sortOrder: 0, isActive: true, priceDelta: 3 },
  });
  const subGroup = await db().pOSModifierGroup.create({
    data: {
      clubId: club.id, menuItemId: burger.id,
      modifierType: "SUBSTITUTE", label: "Side substitution", sortOrder: 2, isActive: true,
    },
  });
  const optFriesSalad = await db().pOSModifierOption.create({
    data: { clubId: club.id, groupId: subGroup.id, label: "Fries → House salad", sortOrder: 0, isActive: true, priceDelta: 2 },
  });

  const area = await db().diningArea.create({
    data: { clubId: club.id, name: "Lounge", sortOrder: 0 },
  });
  const table = await db().diningTable.create({
    data: {
      clubId: club.id, diningAreaId: area.id, tableNumber: "L4", capacity: 4,
      shape: "SQUARE", xPos: 460, yPos: 250, width: 110, height: 110,
    },
  });
  const host = await makeMember(club.id);
  return {
    club, table, host,
    burger, beer,
    optNoOnions, optNoSauce, optBacon, optFriesSalad,
    removeGroup, addGroup, subGroup,
  };
}

async function adminFor(clubId: string, suffix: string) {
  const email = `seat-mod-${suffix}-${clubId}@example.com`;
  await makeUser({ email, role: "CLUB_ADMIN", clubId });
  return principalFor(email);
}

async function openCheckWithBurger(suffix: string) {
  const ctx = await bootstrapSeatedTableWithModifiers(`Seat Mod ${suffix}`);
  const admin = await adminFor(ctx.club.id, suffix);
  const { checkId } = await seatTable(admin, ctx.club.id, {
    tableId: ctx.table.id, memberId: ctx.host.id, partySize: 4,
  });
  await addCheckLines(admin, checkId, {
    items: [{ menuItemId: ctx.burger.id, quantity: 1, seatNumber: 1 }],
  });
  const line = (await db().pOSCheckLine.findFirst({ where: { checkId } }))!;
  return { ...ctx, admin, checkId, line };
}

beforeAll(async () => { await resetDb(); await seedRbac(); });
beforeEach(async () => { await resetDb(); await seedRbac(); });

const SEAT_POS_SRC = fs.readFileSync(
  path.resolve(process.cwd(), "src/app/app/admin/ops/pos/lounge/table/[checkId]/SeatPOS.tsx"),
  "utf8",
);
const TABLE_ACTIONS_SRC = fs.readFileSync(
  path.resolve(process.cwd(), "src/app/app/admin/ops/pos/lounge/table/_actions.ts"),
  "utf8",
);

// =============================================================================
// 1 + 2. DRAFT shows Modify; sent does not
// =============================================================================
describe("Modify button visibility (UI source contract)", () => {
  it("renders a Modify button only when status === DRAFT and the line has a menuItemId", () => {
    expect(SEAT_POS_SRC).toMatch(/l\.status === "DRAFT" && l\.menuItemId \?/);
    expect(SEAT_POS_SRC).toMatch(/onClick=\{\(\) => onModify\(l\)\}/);
    expect(SEAT_POS_SRC).toMatch(/aria-label=\{`Modify \$\{l\.description\}`\}/);
  });

  it("sent lines render a spacer in the Modify slot (button suppressed)", () => {
    // The DRAFT?true:false branch renders a spacer span on the false
    // side so the row stays aligned. The branch literal in the source.
    expect(SEAT_POS_SRC).toMatch(/className="ml-1 inline-block h-7 w-\[60px\]"/);
  });
});

// =============================================================================
// 3. Modifier modal opens — wired through the parent's modifierLine state
// =============================================================================
describe("Modifier modal wiring (UI source contract)", () => {
  it("SeatPOS state holds the line being modified and renders SeatModifierModal when set", () => {
    expect(SEAT_POS_SRC).toMatch(/useState<SeatItem \| TableLine \| null>\(null\)/);
    expect(SEAT_POS_SRC).toMatch(/{modifierLine && \(\s*<SeatModifierModal/);
  });

  it("openModifier sets the line; saveModifier calls setSeatLineModifiersAction", () => {
    expect(SEAT_POS_SRC).toMatch(/function openModifier\(line: SeatItem \| TableLine\)/);
    expect(SEAT_POS_SRC).toMatch(/await setSeatLineModifiersAction\(checkId, lineId, mods\)/);
  });

  it("table/_actions exposes listSeatLineModifiersAction + setSeatLineModifiersAction", () => {
    expect(TABLE_ACTIONS_SRC).toMatch(/export async function listSeatLineModifiersAction/);
    expect(TABLE_ACTIONS_SRC).toMatch(/export async function setSeatLineModifiersAction/);
    // Both wrap the existing modifier service — no second engine.
    expect(TABLE_ACTIONS_SRC).toMatch(/await listModifiersForItem\(/);
    expect(TABLE_ACTIONS_SRC).toMatch(/await setLineModifiers\(/);
  });
});

// =============================================================================
// 4 + 5 + 6. Remove / paid Add / paid Substitute can be saved via seat flow
// =============================================================================
describe("Saving modifier types on a seat-level DRAFT line", () => {
  it("saves a REMOVE modifier (priceDelta=0) and snapshots label", async () => {
    const { admin, line, optNoOnions } = await openCheckWithBurger("rm");
    await setLineModifiers(admin, line.id, {
      modifiers: [{
        optionId: optNoOnions.id, modifierType: "REMOVE",
        label: "No onions", priceDelta: 0,
      }],
    });
    const mods = await db().pOSCheckLineModifier.findMany({ where: { checkLineId: line.id } });
    expect(mods).toHaveLength(1);
    expect(mods[0].modifierType).toBe("REMOVE");
    expect(mods[0].label).toBe("No onions");
    expect(Number(mods[0].priceDelta.toString())).toBe(0);
    expect(mods[0].optionId).toBe(optNoOnions.id);
  });

  it("saves a paid ADD modifier with priceDelta > 0", async () => {
    const { admin, line, optBacon } = await openCheckWithBurger("add");
    await setLineModifiers(admin, line.id, {
      modifiers: [{
        optionId: optBacon.id, modifierType: "ADD",
        label: "Add bacon", priceDelta: 3,
      }],
    });
    const mods = await db().pOSCheckLineModifier.findMany({ where: { checkLineId: line.id } });
    expect(Number(mods[0].priceDelta.toString())).toBe(3);
    expect(mods[0].modifierType).toBe("ADD");
  });

  it("saves a SUBSTITUTE modifier with priceDelta", async () => {
    const { admin, line, optFriesSalad } = await openCheckWithBurger("sub");
    await setLineModifiers(admin, line.id, {
      modifiers: [{
        optionId: optFriesSalad.id, modifierType: "SUBSTITUTE",
        label: "Fries → House salad", priceDelta: 2,
      }],
    });
    const mods = await db().pOSCheckLineModifier.findMany({ where: { checkLineId: line.id } });
    expect(mods[0].modifierType).toBe("SUBSTITUTE");
    expect(Number(mods[0].priceDelta.toString())).toBe(2);
  });
});

// =============================================================================
// 7. Allergy requires non-empty label
// =============================================================================
describe("Allergy validation", () => {
  it("setLineModifiers rejects an ALLERGY row with an empty label", async () => {
    const { admin, line } = await openCheckWithBurger("alrg-empty");
    await expect(
      setLineModifiers(admin, line.id, {
        modifiers: [{ optionId: null, modifierType: "ALLERGY", label: "   ", priceDelta: 0 }],
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("accepts a non-empty ALLERGY label and flips POSCheckLine.hasAllergy", async () => {
    const { admin, line } = await openCheckWithBurger("alrg-ok");
    await setLineModifiers(admin, line.id, {
      modifiers: [{ optionId: null, modifierType: "ALLERGY", label: "Peanut", priceDelta: 0 }],
    });
    const after = await db().pOSCheckLine.findUnique({ where: { id: line.id } });
    expect(after?.hasAllergy).toBe(true);
    const mods = await db().pOSCheckLineModifier.findMany({ where: { checkLineId: line.id } });
    expect(mods.some((m) => m.modifierType === "ALLERGY" && m.label === "Peanut")).toBe(true);
  });
});

// =============================================================================
// 8. Free-text NOTE persists
// =============================================================================
describe("Free-text NOTE persists on the seat line", () => {
  it("saves a NOTE modifier with the typed text", async () => {
    const { admin, line } = await openCheckWithBurger("note");
    await setLineModifiers(admin, line.id, {
      modifiers: [{
        optionId: null, modifierType: "NOTE",
        label: "Plate child portion separately", priceDelta: 0,
      }],
    });
    const mods = await db().pOSCheckLineModifier.findMany({ where: { checkLineId: line.id } });
    const note = mods.find((m) => m.modifierType === "NOTE");
    expect(note).toBeTruthy();
    expect(note!.label).toBe("Plate child portion separately");
    // NOTE rows must not flip hasAllergy.
    const after = await db().pOSCheckLine.findUnique({ where: { id: line.id } });
    expect(after?.hasAllergy).toBe(false);
  });
});

// =============================================================================
// 9. Modifier summary visible under the item in SeatPOS
// =============================================================================
describe("Modifier summary renders under the item (UI source contract)", () => {
  it("renders structured modifiers as small chips below the line", () => {
    expect(SEAT_POS_SRC).toMatch(/structuredMods\.map\(\(m\) => \(/);
    expect(SEAT_POS_SRC).toMatch(/m\.printLabel \|\| m\.label/);
  });

  it("allergy block is red-bordered, prefixed with ALLERGY, and uses red text", () => {
    expect(SEAT_POS_SRC).toMatch(/border-2 border-red-400 bg-red-50/);
    expect(SEAT_POS_SRC).toMatch(/uppercase tracking-wide">Allergy:/);
  });

  it("free-text NOTE is italicised below the line", () => {
    expect(SEAT_POS_SRC).toMatch(/italic/);
    expect(SEAT_POS_SRC).toMatch(/Note: \{noteMod\.label\}/);
  });
});

// =============================================================================
// 10. Paid modifier updates line total — service-level fact
// =============================================================================
describe("Paid modifier rolls into line total (server-side fact)", () => {
  it("seatSummary's per-seat items expose the modifier price deltas the UI needs", async () => {
    const { admin, checkId, line, optBacon } = await openCheckWithBurger("line-total");
    await setLineModifiers(admin, line.id, {
      modifiers: [{
        optionId: optBacon.id, modifierType: "ADD",
        label: "Add bacon", priceDelta: 3,
      }],
    });
    const r = await seatSummary(admin, checkId);
    const seat1 = r.seats.find((s) => s.seatNumber === 1)!;
    const ln = seat1.items[0]!;
    expect(ln.modifiers).toHaveLength(1);
    expect(Number(ln.modifiers[0].priceDelta.toString())).toBe(3);
    // modifierDeltaPerUnit utility matches what the UI imports.
    expect(modifierDeltaPerUnit(ln.modifiers)).toBe(3);
    // Per-unit × quantity is what the UI displays in the row.
    const unitPrice = Number(ln.unitPrice.toString());
    const qty = Number(ln.quantity.toString());
    const expectedLineTotal = unitPrice * qty + modifierDeltaPerUnit(ln.modifiers) * qty;
    expect(expectedLineTotal).toBe(21); // burger 18 + bacon 3
  });
});

// =============================================================================
// 11. Paid modifier updates check total (SeatPOS recomputes from line items)
// =============================================================================
describe("Paid modifier rolls into check total in SeatPOS (UI source contract)", () => {
  it("the totals reducer adds seatModDelta on top of server subtotal", () => {
    expect(SEAT_POS_SRC).toMatch(/lineModifierTotal\(it\)/);
    expect(SEAT_POS_SRC).toMatch(/return s \+ x\.subtotal \+ seatModDelta;/);
  });

  it("table-line totals use lineTotal() (which already includes the delta)", () => {
    expect(SEAT_POS_SRC).toMatch(/tableLines\.reduce\(\(s, l\) => s \+ lineTotal\(l\)/);
  });
});

// =============================================================================
// 12. Send → chit lines carry the modifier rows from the underlying check line
// =============================================================================
describe("Sending to kitchen / bar — chits surface the modifiers", () => {
  it("listChitsForStation includes modifiers via checkLine.modifiers for the seat flow", async () => {
    const {
      admin, club, checkId, burger, line, beer,
      optBacon, optFriesSalad,
    } = await openCheckWithBurger("send-mods");
    // Apply two modifiers + an allergy to seat 1's burger.
    await setLineModifiers(admin, line.id, {
      modifiers: [
        { optionId: optBacon.id, modifierType: "ADD", label: "Add bacon", priceDelta: 3 },
        { optionId: optFriesSalad.id, modifierType: "SUBSTITUTE", label: "Fries → House salad", priceDelta: 2 },
        { optionId: null, modifierType: "ALLERGY", label: "Peanut", priceDelta: 0 },
      ],
    });
    // Add a drink so the BAR chit fires too.
    await addCheckLines(admin, checkId, {
      items: [{ menuItemId: beer.id, quantity: 1, seatNumber: 2 }],
    });
    const sent = await sendUnsentItems(admin, checkId);
    expect(sent.chitIds.length).toBe(2);

    const kitchenChits = await listChitsForStation(admin, club.id, "KITCHEN", { limit: 5 });
    const kitchenChit = kitchenChits.find((c) => c.checkId === checkId);
    expect(kitchenChit).toBeTruthy();
    const burgerLine = kitchenChit!.lines.find((l) => l.displayDescription.includes("Burger"));
    expect(burgerLine).toBeTruthy();
    expect(burgerLine!.displaySeatNumber).toBe(1);

    const modSet = burgerLine!.checkLine?.modifiers ?? [];
    expect(modSet.map((m) => m.modifierType).sort()).toEqual(["ADD", "ALLERGY", "SUBSTITUTE"].sort());
    expect(modSet.some((m) => m.modifierType === "ALLERGY" && m.label === "Peanut")).toBe(true);
    expect(burgerLine!.checkLine?.hasAllergy).toBe(true);
  });
});

// =============================================================================
// 13. Allergy renders prominently on chit (StationView source contract)
// =============================================================================
describe("Allergy is prominent on the chit (StationView source contract)", () => {
  const stationViewSrc = fs.readFileSync(
    path.resolve(process.cwd(), "src/app/app/admin/ops/pos/lounge/StationView.tsx"),
    "utf8",
  );

  it("renders a red-bordered ALLERGY block under any chit line with allergyMods", () => {
    expect(stationViewSrc).toMatch(/allergyMods\.length > 0/);
    // The red block is class-cued by border-2 + bg-red-50 + red text.
    expect(stationViewSrc).toMatch(/border-2 border-red-400 bg-red-50/);
    expect(stationViewSrc).toMatch(/uppercase tracking-wide">Allergy:/);
  });

  it("structured modifiers print as sub-bullets under each chit line", () => {
    expect(stationViewSrc).toMatch(/structuredMods\.length > 0/);
    expect(stationViewSrc).toMatch(/printLabel \|\| m\.label/);
  });
});

// =============================================================================
// 14. Cross-tenant modifier option blocked
// =============================================================================
describe("Cross-tenant modifier option blocked", () => {
  it("an option from club B's catalog cannot be attached to club A's line", async () => {
    const a = await openCheckWithBurger("xt-a");
    const b = await bootstrapSeatedTableWithModifiers("Cross-tenant B");
    // Use A's admin trying to attach B's optBacon.
    await expect(
      setLineModifiers(a.admin, a.line.id, {
        modifiers: [{
          optionId: b.optBacon.id, modifierType: "ADD",
          label: "Add bacon (B)", priceDelta: 3,
        }],
      }),
    ).rejects.toBeInstanceOf(ConflictError);
    // Catalog read from a foreign tenant is blocked too — fixture
    // for the table/_actions wrapper that calls listModifiersForItem.
    const otherAdmin = await adminFor(b.club.id, "xt-b");
    await expect(
      listModifiersForItem(a.admin, b.burger.id),
    ).rejects.toThrow();
    void otherAdmin;
  });
});

// =============================================================================
// 15. Existing per-seat ordering still works without modifiers
// =============================================================================
describe("Existing per-seat ordering still works without modifiers", () => {
  it("can send a seat line with zero modifiers and the chit has no modifier rows", async () => {
    const { admin, club, checkId } = await openCheckWithBurger("no-mods");
    // No setLineModifiers call.
    const sent = await sendUnsentItems(admin, checkId);
    expect(sent.chitIds.length).toBe(1);

    const chits = await listChitsForStation(admin, club.id, "KITCHEN", { limit: 5 });
    const chit = chits.find((c) => c.checkId === checkId);
    expect(chit).toBeTruthy();
    expect(chit!.lines).toHaveLength(1);
    expect(chit!.lines[0].checkLine?.modifiers ?? []).toHaveLength(0);
    expect(chit!.lines[0].checkLine?.hasAllergy).toBe(false);
  });

  it("summarizeModifiers gracefully returns empty string when no modifiers", () => {
    expect(summarizeModifiers([])).toBe("");
  });
});
