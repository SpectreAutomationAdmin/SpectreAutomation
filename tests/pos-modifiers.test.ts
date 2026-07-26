// Lounge POS item-modifier tests.
//
// Covers the full Modify flow: catalog seeding, applying modifiers to
// draft lines, total math (modifier deltas in subtotal + GST), chit
// display data, sale-line snapshot at settlement, AR/GL balance,
// receipt rendering of modifiers, tenant + sent-line guards, and
// free-text + allergy persistence end-to-end.

import { describe, it, expect, beforeEach } from "vitest";
import { db, makeUser, makeMember, resetDb, principalFor } from "./util/db";
import { bootstrapAPClub } from "./util/ap";
import {
  openCheck,
  addCheckLines,
  sendUnsentItems,
  settleCheck,
  getCheck,
  priceCheckLines,
} from "@/lib/pos/checks";
import { listModifiersForItem, setLineModifiers } from "@/lib/pos/modifiers";
import { getDiningReceipt, LOUNGE_LOCATION_CODE, LOUNGE_TERMINAL_CODE } from "@/lib/pos/lounge";
import { ConflictError, ValidationError } from "@/lib/errors";

// ---------------------------------------------------------------------------
// Fixture — a club with a lounge + a minimal menu + modifier catalog.
// We seed modifiers directly rather than via the script so the tests
// can lean on stable IDs.
// ---------------------------------------------------------------------------
async function bootstrapLoungeForMods(name = "Mod Test Club") {
  const club = await bootstrapAPClub(name);
  const fbDept = await db().department.findFirst({ where: { clubId: club.id, code: "FB" } });
  const location = await db().pOSLocation.create({
    data: { clubId: club.id, code: LOUNGE_LOCATION_CODE, name: "Lounge", departmentId: fbDept?.id ?? null },
  });
  const terminal = await db().pOSTerminal.create({
    data: { clubId: club.id, code: LOUNGE_TERMINAL_CODE, name: "T1", locationId: location.id },
  });
  await db().pOSSession.create({
    data: { clubId: club.id, locationId: location.id, terminalId: terminal.id, status: "OPEN", openingFloat: 0 },
  });
  const mainsCat = await db().pOSMenuCategory.create({
    data: { clubId: club.id, locationId: location.id, name: "Handhelds", sortOrder: 1, isActive: true, chitDestination: "KITCHEN" },
  });
  const barCat = await db().pOSMenuCategory.create({
    data: { clubId: club.id, locationId: location.id, name: "Bar", sortOrder: 2, isActive: true, chitDestination: "BAR" },
  });
  const burger = await db().pOSMenuItem.create({
    data: { clubId: club.id, categoryId: mainsCat.id, name: "Silver Burger", price: 22, taxable: true, isActive: true },
  });
  const beer = await db().pOSMenuItem.create({
    data: { clubId: club.id, categoryId: barCat.id, name: "Stella", price: 8, taxable: true, isActive: true },
  });

  // Burger modifier groups.
  const removeGroup = await db().pOSModifierGroup.create({
    data: { clubId: club.id, menuItemId: burger.id, modifierType: "REMOVE", label: "Remove", sortOrder: 0, isActive: true },
  });
  const noOnions = await db().pOSModifierOption.create({
    data: { clubId: club.id, groupId: removeGroup.id, label: "No onions", priceDelta: 0, sortOrder: 0, isActive: true },
  });
  const noPickle = await db().pOSModifierOption.create({
    data: { clubId: club.id, groupId: removeGroup.id, label: "No pickle", priceDelta: 0, sortOrder: 1, isActive: true },
  });
  const addGroup = await db().pOSModifierGroup.create({
    data: { clubId: club.id, menuItemId: burger.id, modifierType: "ADD", label: "Add", sortOrder: 1, isActive: true },
  });
  const addBacon = await db().pOSModifierOption.create({
    data: { clubId: club.id, groupId: addGroup.id, label: "Add bacon", priceDelta: 3, sortOrder: 0, isActive: true },
  });
  const subGroup = await db().pOSModifierGroup.create({
    data: { clubId: club.id, menuItemId: burger.id, modifierType: "SUBSTITUTE", label: "Side substitution", sortOrder: 2, isActive: true },
  });
  const friesToSalad = await db().pOSModifierOption.create({
    data: { clubId: club.id, groupId: subGroup.id, label: "Fries → Salad", priceDelta: 2, sortOrder: 0, isActive: true },
  });

  return {
    club,
    location,
    items: { burger, beer },
    options: { noOnions, noPickle, addBacon, friesToSalad },
    groups: { removeGroup, addGroup, subGroup },
  };
}

async function clubAdmin(clubId: string, suffix = "") {
  const email = `mod-admin${suffix}-${clubId}@example.com`;
  await makeUser({ email, role: "CLUB_ADMIN", clubId });
  return principalFor(email);
}

beforeEach(async () => {
  await resetDb();
});

// ===========================================================================
// 1 — Modifier catalog is queryable per menu item
// ===========================================================================
describe("modifier catalog", () => {
  it("listModifiersForItem returns the burger's three groups with their options", async () => {
    const { club, items } = await bootstrapLoungeForMods();
    const p = await clubAdmin(club.id);
    const groups = await listModifiersForItem(p, items.burger.id);
    expect(groups).toHaveLength(3);
    const remove = groups.find((g) => g.modifierType === "REMOVE");
    expect(remove?.options.map((o) => o.label).sort()).toEqual(["No onions", "No pickle"]);
    const add = groups.find((g) => g.modifierType === "ADD");
    expect(add?.options.find((o) => o.label === "Add bacon")?.priceDelta).toBe(3);
    const sub = groups.find((g) => g.modifierType === "SUBSTITUTE");
    expect(sub?.options.find((o) => o.label === "Fries → Salad")?.priceDelta).toBe(2);
  });
});

// ===========================================================================
// 2-5 — Apply modifiers (Remove / Add / Substitute / Allergy / Note)
// ===========================================================================
describe("setLineModifiers", () => {
  it("2/3/4: applies remove + add + substitute modifiers to a draft line", async () => {
    const { club, items, options } = await bootstrapLoungeForMods();
    const p = await clubAdmin(club.id);
    const member = await makeMember(club.id);
    const check = await openCheck(p, club.id, { memberId: member.id });
    await addCheckLines(p, check.id, { items: [{ menuItemId: items.burger.id, quantity: 1 }] });
    const full = await getCheck(p, check.id);
    const lineId = full.lines[0].id;

    await setLineModifiers(p, lineId, {
      modifiers: [
        { optionId: options.noOnions.id, modifierType: "REMOVE", label: "No onions", priceDelta: 0 },
        { optionId: options.addBacon.id, modifierType: "ADD", label: "Add bacon", priceDelta: 3 },
        { optionId: options.friesToSalad.id, modifierType: "SUBSTITUTE", label: "Fries → Salad", priceDelta: 2 },
      ],
    });

    const refreshed = await db().pOSCheckLine.findUnique({ where: { id: lineId }, include: { modifiers: true } });
    expect(refreshed?.modifiers).toHaveLength(3);
    expect(refreshed?.modifiers.map((m) => m.label).sort()).toEqual([
      "Add bacon",
      "Fries → Salad",
      "No onions",
    ]);
    // hasAllergy flag stays false when there's no allergy modifier
    expect(refreshed?.hasAllergy).toBe(false);
  });

  it("5: adding an allergy modifier flips the line's hasAllergy flag", async () => {
    const { club, items } = await bootstrapLoungeForMods();
    const p = await clubAdmin(club.id);
    const member = await makeMember(club.id);
    const check = await openCheck(p, club.id, { memberId: member.id });
    await addCheckLines(p, check.id, { items: [{ menuItemId: items.burger.id, quantity: 1 }] });
    const full = await getCheck(p, check.id);
    const lineId = full.lines[0].id;

    await setLineModifiers(p, lineId, {
      modifiers: [{ optionId: null, modifierType: "ALLERGY", label: "Gluten sensitivity", priceDelta: 0 }],
    });
    const refreshed = await db().pOSCheckLine.findUnique({ where: { id: lineId } });
    expect(refreshed?.hasAllergy).toBe(true);
  });

  it("18: rejects an allergy modifier with an empty label", async () => {
    const { club, items } = await bootstrapLoungeForMods();
    const p = await clubAdmin(club.id);
    const member = await makeMember(club.id);
    const check = await openCheck(p, club.id, { memberId: member.id });
    await addCheckLines(p, check.id, { items: [{ menuItemId: items.burger.id, quantity: 1 }] });
    const full = await getCheck(p, check.id);
    const lineId = full.lines[0].id;
    await expect(
      setLineModifiers(p, lineId, {
        modifiers: [{ optionId: null, modifierType: "ALLERGY", label: "   ", priceDelta: 0 }],
      })
    ).rejects.toThrow(ValidationError);
  });

  it("17/19: setLineModifiers replaces the prior set, free-text note persists", async () => {
    const { club, items, options } = await bootstrapLoungeForMods();
    const p = await clubAdmin(club.id);
    const member = await makeMember(club.id);
    const check = await openCheck(p, club.id, { memberId: member.id });
    await addCheckLines(p, check.id, { items: [{ menuItemId: items.burger.id, quantity: 1 }] });
    const full = await getCheck(p, check.id);
    const lineId = full.lines[0].id;

    // First set — bacon + note.
    await setLineModifiers(p, lineId, {
      modifiers: [
        { optionId: options.addBacon.id, modifierType: "ADD", label: "Add bacon", priceDelta: 3 },
        { optionId: null, modifierType: "NOTE", label: "Dressing on the side", priceDelta: 0 },
      ],
    });
    let mods = await db().pOSCheckLineModifier.findMany({ where: { checkLineId: lineId } });
    expect(mods).toHaveLength(2);

    // Clear all — empty array.
    await setLineModifiers(p, lineId, { modifiers: [] });
    mods = await db().pOSCheckLineModifier.findMany({ where: { checkLineId: lineId } });
    expect(mods).toHaveLength(0);
  });
});

// ===========================================================================
// 6/7 — Pricing math: cart total + GST reflect modifier deltas
// ===========================================================================
describe("price math", () => {
  it("6/7: cart total and GST include modifier priceDelta × quantity", async () => {
    // 2× Burger ($22 each) + (Add bacon $3, Fries→Salad $2) per unit
    // Effective unit = 22 + 5 = 27. Line subtotal = 2 × 27 = 54.
    // GST = 5% × 54 = 2.70. Grand total = 56.70.
    const lines = [
      {
        status: "DRAFT",
        quantity: 2,
        unitPrice: 22,
        discountPct: 0,
        taxable: true,
        modifiers: [
          { priceDelta: 3 },
          { priceDelta: 2 },
        ],
      },
    ];
    const totals = priceCheckLines(lines, 0);
    expect(totals.subtotal).toBe(54);
    expect(totals.modifierTotal).toBe(10);
    expect(totals.taxTotal).toBeCloseTo(2.7, 2);
    expect(totals.grandTotal).toBeCloseTo(56.7, 2);
  });
});

// ===========================================================================
// 8 — Chits expose modifiers via the checkLine join
// ===========================================================================
describe("chit display", () => {
  it("8/9: sent chit lines expose modifier rows including the allergy flag", async () => {
    const { club, items, options } = await bootstrapLoungeForMods();
    const p = await clubAdmin(club.id);
    const member = await makeMember(club.id);
    const check = await openCheck(p, club.id, { memberId: member.id });
    await addCheckLines(p, check.id, { items: [{ menuItemId: items.burger.id, quantity: 1 }] });
    const full = await getCheck(p, check.id);
    const lineId = full.lines[0].id;
    await setLineModifiers(p, lineId, {
      modifiers: [
        { optionId: options.noOnions.id, modifierType: "REMOVE", label: "No onions", priceDelta: 0 },
        { optionId: options.addBacon.id, modifierType: "ADD", label: "Add bacon", priceDelta: 3 },
        { optionId: null, modifierType: "ALLERGY", label: "Gluten sensitivity", priceDelta: 0 },
      ],
    });
    await sendUnsentItems(p, check.id);
    const chits = await db().pOSChit.findMany({
      where: { checkId: check.id },
      include: { lines: { include: { checkLine: { include: { modifiers: true } } } } },
    });
    expect(chits).toHaveLength(1);
    const chitLine = chits[0].lines[0];
    expect(chitLine.checkLine?.hasAllergy).toBe(true);
    expect(chitLine.checkLine?.modifiers.map((m) => m.label).sort()).toEqual([
      "Add bacon",
      "Gluten sensitivity",
      "No onions",
    ]);
  });
});

// ===========================================================================
// 10/11/12 — Settlement folds deltas into total, AR + GL balance, sale snapshot
// ===========================================================================
describe("settlement with modifiers", () => {
  it("10/11/12: settle includes modifier deltas in AR charge + GL balanced + sale snapshot", async () => {
    const { club, items, options } = await bootstrapLoungeForMods();
    const p = await clubAdmin(club.id);
    const member = await makeMember(club.id);
    const check = await openCheck(p, club.id, { memberId: member.id });
    await addCheckLines(p, check.id, { items: [{ menuItemId: items.burger.id, quantity: 1 }] });
    const full = await getCheck(p, check.id);
    const lineId = full.lines[0].id;
    await setLineModifiers(p, lineId, {
      modifiers: [
        { optionId: options.addBacon.id, modifierType: "ADD", label: "Add bacon", priceDelta: 3 },
        { optionId: options.friesToSalad.id, modifierType: "SUBSTITUTE", label: "Fries → Salad", priceDelta: 2 },
      ],
    });
    await sendUnsentItems(p, check.id);

    const { sale } = await settleCheck(p, check.id, { paymentMethod: "MEMBER_ACCOUNT" });

    // $22 burger + $5 in modifiers = $27 + 5% GST = $28.35
    expect(Number(sale.grandTotal.toString())).toBeCloseTo(28.35, 2);
    const charge = await db().charge.findUnique({ where: { id: sale.arChargeId! } });
    expect(Number(charge?.amount ?? 0)).toBeCloseTo(28.35, 2);

    const je = await db().journalEntry.findUnique({
      where: { id: sale.postedJournalEntryId! },
      include: { lines: true },
    });
    const dr = (je?.lines ?? []).reduce((s, l) => s + Number((l.debit ?? 0).toString()), 0);
    const cr = (je?.lines ?? []).reduce((s, l) => s + Number((l.credit ?? 0).toString()), 0);
    expect(dr).toBeCloseTo(cr, 6);

    // Sale-line modifier snapshot exists
    const saleLine = await db().pOSSaleLine.findFirst({
      where: { saleId: sale.id },
      include: { modifiers: true },
    });
    expect(saleLine?.modifiers).toHaveLength(2);
    expect(saleLine?.modifiers.map((m) => m.label).sort()).toEqual([
      "Add bacon",
      "Fries → Salad",
    ]);
  });
});

// ===========================================================================
// 13 — Member dining receipt surfaces modifiers
// ===========================================================================
describe("member dining receipt", () => {
  it("13: getDiningReceipt returns modifier snapshot per sale line", async () => {
    const { club, items, options } = await bootstrapLoungeForMods();
    const p = await clubAdmin(club.id);
    const member = await makeMember(club.id);
    const check = await openCheck(p, club.id, { memberId: member.id });
    await addCheckLines(p, check.id, { items: [{ menuItemId: items.burger.id, quantity: 1 }] });
    const full = await getCheck(p, check.id);
    const lineId = full.lines[0].id;
    await setLineModifiers(p, lineId, {
      modifiers: [
        { optionId: options.noOnions.id, modifierType: "REMOVE", label: "No onions", priceDelta: 0 },
        { optionId: null, modifierType: "NOTE", label: "Well done", priceDelta: 0 },
      ],
    });
    await sendUnsentItems(p, check.id);
    const { sale } = await settleCheck(p, check.id, { paymentMethod: "MEMBER_ACCOUNT" });

    const receipt = await getDiningReceipt(sale.id, member.id);
    expect(receipt).toBeTruthy();
    expect(receipt!.lines[0].modifiers.map((m) => m.label).sort()).toEqual([
      "No onions",
      "Well done",
    ]);
    expect(receipt!.lines[0].modifiers.find((m) => m.modifierType === "NOTE")?.label).toBe("Well done");
  });
});

// ===========================================================================
// 14 — Tenant safety
// ===========================================================================
describe("tenant safety", () => {
  it("14: cross-tenant modifier option is blocked", async () => {
    const a = await bootstrapLoungeForMods("Club A");
    const b = await bootstrapLoungeForMods("Club B");
    const pA = await clubAdmin(a.club.id, "a");
    const memberA = await makeMember(a.club.id);
    const checkA = await openCheck(pA, a.club.id, { memberId: memberA.id });
    await addCheckLines(pA, checkA.id, { items: [{ menuItemId: a.items.burger.id, quantity: 1 }] });
    const full = await getCheck(pA, checkA.id);
    const lineId = full.lines[0].id;

    // Use club B's option ID against club A's line.
    await expect(
      setLineModifiers(pA, lineId, {
        modifiers: [{ optionId: b.options.addBacon.id, modifierType: "ADD", label: "Add bacon", priceDelta: 3 }],
      })
    ).rejects.toThrow(ConflictError);
  });
});

// ===========================================================================
// 15/16 — Sent + voided line modification is blocked
// ===========================================================================
describe("status guards", () => {
  it("15: a sent line cannot be modified", async () => {
    const { club, items, options } = await bootstrapLoungeForMods();
    const p = await clubAdmin(club.id);
    const member = await makeMember(club.id);
    const check = await openCheck(p, club.id, { memberId: member.id });
    await addCheckLines(p, check.id, { items: [{ menuItemId: items.burger.id, quantity: 1 }] });
    await sendUnsentItems(p, check.id);
    const full = await getCheck(p, check.id);
    const lineId = full.lines[0].id;
    await expect(
      setLineModifiers(p, lineId, {
        modifiers: [{ optionId: options.addBacon.id, modifierType: "ADD", label: "Add bacon", priceDelta: 3 }],
      })
    ).rejects.toThrow(ConflictError);
  });

  it("16: a voided line cannot be modified", async () => {
    const { club, items, options } = await bootstrapLoungeForMods();
    const p = await clubAdmin(club.id);
    const member = await makeMember(club.id);
    const check = await openCheck(p, club.id, { memberId: member.id });
    await addCheckLines(p, check.id, { items: [{ menuItemId: items.burger.id, quantity: 1 }] });
    const full = await getCheck(p, check.id);
    const lineId = full.lines[0].id;
    // Send + mark line VOIDED (mimics a manager voiding a sent item)
    await sendUnsentItems(p, check.id);
    await db().pOSCheckLine.update({ where: { id: lineId }, data: { status: "VOIDED" } });
    await expect(
      setLineModifiers(p, lineId, {
        modifiers: [{ optionId: options.addBacon.id, modifierType: "ADD", label: "Add bacon", priceDelta: 3 }],
      })
    ).rejects.toThrow(ConflictError);
  });
});

// ===========================================================================
// 20 — Existing unmodified flow still works
// ===========================================================================
describe("regression — unmodified items still settle cleanly", () => {
  it("20: a line with zero modifiers prices and settles exactly as before", async () => {
    const { club, items } = await bootstrapLoungeForMods();
    const p = await clubAdmin(club.id);
    const member = await makeMember(club.id);
    const check = await openCheck(p, club.id, { memberId: member.id });
    await addCheckLines(p, check.id, { items: [{ menuItemId: items.burger.id, quantity: 1 }] });
    await sendUnsentItems(p, check.id);
    const { sale } = await settleCheck(p, check.id, { paymentMethod: "MEMBER_ACCOUNT" });
    expect(Number(sale.grandTotal.toString())).toBeCloseTo(22 * 1.05, 2);
    const saleLine = await db().pOSSaleLine.findFirst({
      where: { saleId: sale.id },
      include: { modifiers: true },
    });
    expect(saleLine?.modifiers).toHaveLength(0);
  });
});
