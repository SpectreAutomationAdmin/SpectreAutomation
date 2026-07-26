// POS cleanup step 4 — modifiers flow through settlement.
//
// Pins the AR / GL / receipt path for the seated-dining settle: when a
// server applies a paid modifier on SeatPOS, every downstream record
// (POSSaleLine, POSSaleLineModifier, Charge, JournalEntry, member-side
// receipt) must reflect the modifier-adjusted total. Catalog changes
// after settlement must NOT mutate historical receipts.
//
// Scope: full-check member-account settlement (single group). Split
// billing, QR Pay, partial settlement, and the Quick Sale / Bar path
// are out of scope per the task spec.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { db, makeMember, makeUser, principalFor, resetDb, seedRbac } from "./util/db";
import { bootstrapAPClub } from "./util/ap";
import { seatTable, settleCheckBySeats } from "@/lib/pos/seat-checks";
import { addCheckLines } from "@/lib/pos/checks";
import { setLineModifiers } from "@/lib/pos/modifiers";
import { getDiningReceipt, LOUNGE_LOCATION_CODE, LOUNGE_TERMINAL_CODE } from "@/lib/pos/lounge";

async function bootstrapLoungeChartOfAccounts(clubId: string) {
  // The two GL accounts the POS settle path posts to are 1110 (Member
  // AR control) and 2110 (Sales tax payable) + the F&B revenue account
  // 4200. bootstrapAPClub already seeds the AR side; the lounge path
  // needs 4200 and the tax credit account too. Ensure they exist.
  const ensure = async (number: string, name: string, type: string, normalBalance: string) => {
    const existing = await db().account.findFirst({ where: { clubId, accountNumber: number } });
    if (existing) return existing;
    return db().account.create({
      data: {
        clubId, accountNumber: number, name, type, normalBalance,
        allowManualPosting: true, isActive: true,
      },
    });
  };
  await ensure("4200", "F&B Revenue", "REVENUE", "CREDIT");
  await ensure("2110", "Sales Tax Payable", "LIABILITY", "CREDIT");
  await ensure("2030", "Gratuity Payable", "LIABILITY", "CREDIT");
}

async function bootstrapBurgerLine(name: string) {
  const club = await bootstrapAPClub(name);
  await bootstrapLoungeChartOfAccounts(club.id);
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
  const cat = await db().pOSMenuCategory.create({
    data: { clubId: club.id, locationId: loc.id, name: "Mains", sortOrder: 1, isActive: true, chitDestination: "KITCHEN" },
  });
  const burger = await db().pOSMenuItem.create({
    data: { clubId: club.id, categoryId: cat.id, name: "Classic Burger", price: 18, taxable: true, isActive: true },
  });

  // Modifier catalog: one paid ADD option used by every settlement test.
  const addGroup = await db().pOSModifierGroup.create({
    data: { clubId: club.id, menuItemId: burger.id, modifierType: "ADD", label: "Add", sortOrder: 0, isActive: true },
  });
  const optBacon = await db().pOSModifierOption.create({
    data: { clubId: club.id, groupId: addGroup.id, label: "Add bacon", sortOrder: 0, isActive: true, priceDelta: 3 },
  });
  // A free (priceDelta=0) REMOVE option used for the "zero-delta still
  // appears on receipt" test.
  const removeGroup = await db().pOSModifierGroup.create({
    data: { clubId: club.id, menuItemId: burger.id, modifierType: "REMOVE", label: "Remove", sortOrder: 1, isActive: true },
  });
  const optNoOnions = await db().pOSModifierOption.create({
    data: { clubId: club.id, groupId: removeGroup.id, label: "No onions", sortOrder: 0, isActive: true, priceDelta: 0 },
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
  return { club, table, burger, host, optBacon, optNoOnions, addGroup, removeGroup };
}

async function adminFor(clubId: string, suffix: string) {
  const email = `seat-settle-${suffix}-${clubId}@example.com`;
  await makeUser({ email, role: "CLUB_ADMIN", clubId });
  return principalFor(email);
}

async function openWithBurger(suffix: string) {
  const ctx = await bootstrapBurgerLine(`Seat Settle ${suffix}`);
  const admin = await adminFor(ctx.club.id, suffix);
  const { checkId } = await seatTable(admin, ctx.club.id, {
    tableId: ctx.table.id, memberId: ctx.host.id, partySize: 4,
  });
  await addCheckLines(admin, checkId, {
    items: [{ menuItemId: ctx.burger.id, quantity: 1, seatNumber: 1 }],
  });
  // Deliberately do NOT call sendUnsentItems here — modifiers can only
  // be applied to DRAFT lines (sent lines are immutable by design).
  // Tests apply modifiers first, then settle with allowUnsentLines=true.
  const line = (await db().pOSCheckLine.findFirst({ where: { checkId } }))!;
  return { ...ctx, admin, checkId, line };
}

// Settle the whole check to the host's member account as a single
// "All seats" group. This is the canonical full-check member-account
// settlement the user's spec asks us to fix.
async function settleWhole(opts: {
  admin: Awaited<ReturnType<typeof adminFor>>;
  checkId: string;
  hostId: string;
}) {
  return settleCheckBySeats(opts.admin, opts.checkId, {
    groups: [{
      label: "All seats",
      seatNumbers: [1],
      paymentMethod: "MEMBER_ACCOUNT",
      memberId: opts.hostId,
    }],
    // Modifiers can only be applied to DRAFT lines, so the test
    // workflow is "add → modify → settle directly" without an
    // intermediate send. Production flows go DRAFT → SENT → settle;
    // the settlement engine accepts both.
    allowUnsentLines: true,
  });
}

beforeAll(async () => { await resetDb(); await seedRbac(); });
beforeEach(async () => { await resetDb(); await seedRbac(); });

// =============================================================================
// 1. Settlement includes paid modifier in line total
// =============================================================================
describe("Paid modifier rolls into line total at settlement", () => {
  it("Burger $18 + bacon $3 → POSSaleLine.lineSubtotal = $21", async () => {
    const { admin, checkId, line, host, optBacon } = await openWithBurger("line-total");
    await setLineModifiers(admin, line.id, {
      modifiers: [{ optionId: optBacon.id, modifierType: "ADD", label: "Add bacon", priceDelta: 3 }],
    });
    const r = await settleWhole({ admin, checkId, hostId: host.id });
    const settledSaleId = r.groups[0].posSaleId!;
    const saleLine = (await db().pOSSaleLine.findFirst({ where: { saleId: settledSaleId } }))!;
    expect(Number(saleLine.unitPrice.toString())).toBe(21); // base + per-unit delta
    expect(Number(saleLine.quantity.toString())).toBe(1);
    expect(Number(saleLine.lineSubtotal.toString())).toBe(21);
    expect(Number(saleLine.lineTotal.toString())).toBe(21);
  });
});

// =============================================================================
// 2. Settlement snapshots modifier onto sale line
// =============================================================================
describe("Modifier snapshot lands on POSSaleLineModifier", () => {
  it("a paid ADD modifier creates one POSSaleLineModifier with label + priceDelta preserved", async () => {
    const { admin, checkId, line, host, optBacon } = await openWithBurger("snapshot");
    await setLineModifiers(admin, line.id, {
      modifiers: [{ optionId: optBacon.id, modifierType: "ADD", label: "Add bacon", priceDelta: 3 }],
    });
    const r = await settleWhole({ admin, checkId, hostId: host.id });
    const saleId = r.groups[0].posSaleId!;
    const mods = await db().pOSSaleLineModifier.findMany({
      where: { saleLine: { saleId } },
    });
    expect(mods).toHaveLength(1);
    expect(mods[0].modifierType).toBe("ADD");
    expect(mods[0].label).toBe("Add bacon");
    expect(Number(mods[0].priceDelta.toString())).toBe(3);
  });
});

// =============================================================================
// 3. AR charge total includes modifier delta
// =============================================================================
describe("AR charge reflects the modifier-adjusted total", () => {
  it("Charge.amount = grand total with modifier baked in", async () => {
    const { admin, checkId, line, host, optBacon } = await openWithBurger("ar");
    await setLineModifiers(admin, line.id, {
      modifiers: [{ optionId: optBacon.id, modifierType: "ADD", label: "Add bacon", priceDelta: 3 }],
    });
    const r = await settleWhole({ admin, checkId, hostId: host.id });
    const grand = r.groups[0].grandTotal;
    expect(grand).toBeCloseTo(22.05, 2); // 21 + 5% GST

    const sale = await db().pOSSale.findUnique({
      where: { id: r.groups[0].posSaleId! },
      include: { arCharge: true },
    });
    expect(Number(sale!.grandTotal.toString())).toBeCloseTo(22.05, 2);

    // Charge on member AR carries the same amount (linked via POSSale.arChargeId).
    expect(sale!.arCharge).toBeTruthy();
    expect(Number(sale!.arCharge!.amount.toString())).toBeCloseTo(22.05, 2);
    expect(sale!.arCharge!.memberId).toBe(host.id);
  });
});

// =============================================================================
// 4. GL journal balances with modified total
// =============================================================================
describe("GL JE balances and posts the modified total", () => {
  it("DR Member AR / CR F&B Revenue + CR Sales Tax — sums equal, total = $22.05", async () => {
    const { admin, checkId, line, host, optBacon, club } = await openWithBurger("gl");
    await setLineModifiers(admin, line.id, {
      modifiers: [{ optionId: optBacon.id, modifierType: "ADD", label: "Add bacon", priceDelta: 3 }],
    });
    const r = await settleWhole({ admin, checkId, hostId: host.id });
    const sale = await db().pOSSale.findUnique({
      where: { id: r.groups[0].posSaleId! },
    });
    expect(sale!.postedJournalEntryId).toBeTruthy();

    const je = await db().journalEntry.findUnique({
      where: { id: sale!.postedJournalEntryId! },
      include: { lines: { include: { account: true } } },
    });
    expect(je).toBeTruthy();
    expect(je!.status).toBe("POSTED");

    // Debits = credits — JournalEntry totals come from the posting engine.
    expect(Number(je!.totalDebits.toString())).toBeCloseTo(
      Number(je!.totalCredits.toString()),
      2,
    );
    // Debits == grand total.
    expect(Number(je!.totalDebits.toString())).toBeCloseTo(22.05, 2);

    // Specific account routing:
    //   DR 1110 Member AR    $22.05
    //   CR 4200 F&B Revenue  $21.00
    //   CR 2110 Sales Tax    $1.05
    const ar = je!.lines.find((l) => l.account?.accountNumber === "1110");
    const fb = je!.lines.find((l) => l.account?.accountNumber === "4200");
    const tax = je!.lines.find((l) => l.account?.accountNumber === "2110");
    expect(ar).toBeTruthy(); expect(fb).toBeTruthy(); expect(tax).toBeTruthy();
    expect(Number(ar!.debit.toString())).toBeCloseTo(22.05, 2);
    expect(Number(fb!.credit.toString())).toBeCloseTo(21.00, 2);
    expect(Number(tax!.credit.toString())).toBeCloseTo(1.05, 2);

    void club;
  });
});

// =============================================================================
// 5. GST calculates on modified total
// =============================================================================
describe("Tax base includes modifier deltas", () => {
  it("GST is 5% of (base + modifiers) on a taxable line — $21 → $1.05", async () => {
    const { admin, checkId, line, host, optBacon } = await openWithBurger("tax");
    await setLineModifiers(admin, line.id, {
      modifiers: [{ optionId: optBacon.id, modifierType: "ADD", label: "Add bacon", priceDelta: 3 }],
    });
    const r = await settleWhole({ admin, checkId, hostId: host.id });
    expect(r.groups[0].tax).toBeCloseTo(1.05, 2);
    expect(r.groups[0].subtotal).toBeCloseTo(21.00, 2);

    const sale = await db().pOSSale.findUnique({ where: { id: r.groups[0].posSaleId! } });
    expect(Number(sale!.taxTotal.toString())).toBeCloseTo(1.05, 2);
    expect(Number(sale!.subtotal.toString())).toBeCloseTo(21.00, 2);
  });
});

// =============================================================================
// 6. Member dining receipt shows modifier
// =============================================================================
describe("Member dining receipt surfaces the modifier", () => {
  it("getDiningReceipt returns POSSaleLine.modifiers for the host", async () => {
    const { admin, checkId, line, host, optBacon } = await openWithBurger("receipt");
    await setLineModifiers(admin, line.id, {
      modifiers: [{ optionId: optBacon.id, modifierType: "ADD", label: "Add bacon", priceDelta: 3 }],
    });
    const r = await settleWhole({ admin, checkId, hostId: host.id });
    const receipt = await getDiningReceipt(r.groups[0].posSaleId!, host.id);
    expect(receipt).toBeTruthy();
    expect(receipt!.lines).toHaveLength(1);
    const ln = receipt!.lines[0];
    expect(ln.modifiers).toHaveLength(1);
    expect(ln.modifiers[0].label).toBe("Add bacon");
    expect(Number(ln.modifiers[0].priceDelta.toString())).toBe(3);
  });
});

// =============================================================================
// 7. Member dining receipt total matches POS settlement total
// =============================================================================
describe("Receipt total == POS settlement total", () => {
  it("receipt grand total equals the settlement engine's grand total", async () => {
    const { admin, checkId, line, host, optBacon } = await openWithBurger("totals-match");
    await setLineModifiers(admin, line.id, {
      modifiers: [{ optionId: optBacon.id, modifierType: "ADD", label: "Add bacon", priceDelta: 3 }],
    });
    const r = await settleWhole({ admin, checkId, hostId: host.id });
    const receipt = await getDiningReceipt(r.groups[0].posSaleId!, host.id);
    expect(Number(receipt!.grandTotal.toString())).toBeCloseTo(r.groups[0].grandTotal, 2);
    expect(Number(receipt!.subtotal.toString())).toBeCloseTo(r.groups[0].subtotal, 2);
    expect(Number(receipt!.taxTotal.toString())).toBeCloseTo(r.groups[0].tax, 2);
  });
});

// =============================================================================
// 8. Zero-dollar modifiers still appear on receipt
// =============================================================================
describe("Zero-delta modifiers persist to the receipt", () => {
  it("a REMOVE option with priceDelta=0 still creates a POSSaleLineModifier row", async () => {
    const { admin, checkId, line, host, optNoOnions, optBacon } = await openWithBurger("zero-delta");
    await setLineModifiers(admin, line.id, {
      modifiers: [
        { optionId: optNoOnions.id, modifierType: "REMOVE", label: "No onions", priceDelta: 0 },
        { optionId: optBacon.id, modifierType: "ADD", label: "Add bacon", priceDelta: 3 },
      ],
    });
    const r = await settleWhole({ admin, checkId, hostId: host.id });
    const mods = await db().pOSSaleLineModifier.findMany({
      where: { saleLine: { saleId: r.groups[0].posSaleId! } },
      orderBy: { sortOrder: "asc" },
    });
    expect(mods).toHaveLength(2);
    const removeMod = mods.find((m) => m.modifierType === "REMOVE")!;
    expect(removeMod.label).toBe("No onions");
    expect(Number(removeMod.priceDelta.toString())).toBe(0);
    // And the total is still $21 (no onions is free, bacon adds $3).
    expect(r.groups[0].subtotal).toBeCloseTo(21, 2);
  });
});

// =============================================================================
// 9. Allergy + free-text NOTE persist on the receipt
// =============================================================================
describe("ALLERGY + NOTE modifiers persist to the receipt", () => {
  it("ALLERGY + NOTE rows survive to POSSaleLineModifier with priceDelta=0", async () => {
    const { admin, checkId, line, host } = await openWithBurger("allergy");
    await setLineModifiers(admin, line.id, {
      modifiers: [
        { optionId: null, modifierType: "ALLERGY", label: "Peanut", priceDelta: 0 },
        { optionId: null, modifierType: "NOTE", label: "Medium-rare please", priceDelta: 0 },
      ],
    });
    const r = await settleWhole({ admin, checkId, hostId: host.id });
    const mods = await db().pOSSaleLineModifier.findMany({
      where: { saleLine: { saleId: r.groups[0].posSaleId! } },
    });
    const types = mods.map((m) => m.modifierType).sort();
    expect(types).toEqual(["ALLERGY", "NOTE"]);
    const allergy = mods.find((m) => m.modifierType === "ALLERGY")!;
    expect(allergy.label).toBe("Peanut");
    const note = mods.find((m) => m.modifierType === "NOTE")!;
    expect(note.label).toBe("Medium-rare please");
    // No price impact for these types.
    expect(r.groups[0].subtotal).toBeCloseTo(18, 2);
  });
});

// =============================================================================
// 10. Catalog edits after settlement don't change historical receipts
// =============================================================================
describe("Historical receipts are frozen at settlement", () => {
  it("deleting the master POSModifierOption after settle leaves the snapshot intact", async () => {
    const { admin, checkId, line, host, optBacon } = await openWithBurger("frozen");
    await setLineModifiers(admin, line.id, {
      modifiers: [{ optionId: optBacon.id, modifierType: "ADD", label: "Add bacon", priceDelta: 3 }],
    });
    const r = await settleWhole({ admin, checkId, hostId: host.id });
    const saleId = r.groups[0].posSaleId!;

    // Now edit + delete the master option to simulate a future menu change.
    await db().pOSModifierOption.update({
      where: { id: optBacon.id },
      data: { label: "Add premium bacon (NEW)", priceDelta: 99 },
    });
    await db().pOSModifierOption.delete({ where: { id: optBacon.id } });

    // The receipt still reads "Add bacon" at +$3 — the snapshot is the
    // source of truth, not the catalog.
    const receipt = await getDiningReceipt(saleId, host.id);
    expect(receipt).toBeTruthy();
    expect(receipt!.lines[0].modifiers).toHaveLength(1);
    expect(receipt!.lines[0].modifiers[0].label).toBe("Add bacon");
    expect(Number(receipt!.lines[0].modifiers[0].priceDelta.toString())).toBe(3);
    expect(Number(receipt!.grandTotal.toString())).toBeCloseTo(22.05, 2);
  });
});

// =============================================================================
// 11. Settlement without modifiers still works
// =============================================================================
describe("Backwards compat — settlement without modifiers", () => {
  it("Burger alone (no modifiers) → $18 subtotal, $0.90 tax, $18.90 grand", async () => {
    const { admin, checkId, host } = await openWithBurger("no-mods");
    // Deliberately skip setLineModifiers — no modifiers attached.
    const r = await settleWhole({ admin, checkId, hostId: host.id });
    expect(r.groups[0].subtotal).toBeCloseTo(18, 2);
    expect(r.groups[0].tax).toBeCloseTo(0.9, 2);
    expect(r.groups[0].grandTotal).toBeCloseTo(18.9, 2);

    // Sale line has no modifier snapshot rows.
    const mods = await db().pOSSaleLineModifier.findMany({
      where: { saleLine: { saleId: r.groups[0].posSaleId! } },
    });
    expect(mods).toHaveLength(0);
  });
});

// =============================================================================
// 12. Cross-tenant access blocked
// =============================================================================
describe("Cross-tenant safety", () => {
  it("a sale settled in club A is invisible via club B's member id", async () => {
    const a = await openWithBurger("xt-a");
    await setLineModifiers(a.admin, a.line.id, {
      modifiers: [{ optionId: a.optBacon.id, modifierType: "ADD", label: "Add bacon", priceDelta: 3 }],
    });
    const r = await settleWhole({ admin: a.admin, checkId: a.checkId, hostId: a.host.id });
    const saleId = r.groups[0].posSaleId!;

    // A different member at a different club tries to read it.
    const b = await bootstrapBurgerLine("Cross-tenant B");
    const noLeak = await getDiningReceipt(saleId, b.host.id);
    expect(noLeak).toBeNull();
  });

  it("a modifier option from club B cannot be attached to club A's line", async () => {
    const a = await openWithBurger("xt-mod-a");
    const b = await bootstrapBurgerLine("Cross-tenant Mod B");
    // The setLineModifiers service blocks cross-tenant option IDs.
    await expect(
      setLineModifiers(a.admin, a.line.id, {
        modifiers: [{ optionId: b.optBacon.id, modifierType: "ADD", label: "Add bacon (B)", priceDelta: 3 }],
      }),
    ).rejects.toThrow();
  });
});
