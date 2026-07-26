// POS cleanup step 6 — split-bill receipt emails.
//
// When a server splits a seated table into N MEMBER_ACCOUNT groups and
// settles all of them at once, each paying member should get exactly
// one receipt email for their own group's items. Failed/suppressed/
// missing-email outcomes for one group must NOT block another group's
// email. The N==1 (merge-all) path keeps the legacy POSCheck-level
// status — that branch is preserved.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { db, makeMember, makeUser, principalFor, resetDb, seedRbac } from "./util/db";
import { bootstrapAPClub } from "./util/ap";
import { seatTable, settleCheckBySeats } from "@/lib/pos/seat-checks";
import { addCheckLines } from "@/lib/pos/checks";
import { setLineModifiers } from "@/lib/pos/modifiers";
import { getDiningReceipt, LOUNGE_LOCATION_CODE, LOUNGE_TERMINAL_CODE } from "@/lib/pos/lounge";

// Bootstrap a Silver-Springs-shaped club with two payers (Owen + Margaret),
// a burger with a bacon modifier, and a beer. Two seats are pre-prepared:
//   Seat 1 owned by Owen,
//   Seat 2 owned by Margaret.
async function bootstrapTwoPayerCheck(name: string, opts?: { owenEmail?: string | null; margaretEmail?: string | null }) {
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
  const foodCat = await db().pOSMenuCategory.create({
    data: { clubId: club.id, locationId: loc.id, name: "Mains", sortOrder: 1, isActive: true, chitDestination: "KITCHEN" },
  });
  const drinkCat = await db().pOSMenuCategory.create({
    data: { clubId: club.id, locationId: loc.id, name: "Drinks", sortOrder: 2, isActive: true, chitDestination: "BAR" },
  });
  const burger = await db().pOSMenuItem.create({
    data: { clubId: club.id, categoryId: foodCat.id, name: "The Silver Burger", price: 18, taxable: true, isActive: true },
  });
  const beer = await db().pOSMenuItem.create({
    data: { clubId: club.id, categoryId: drinkCat.id, name: "House Lager", price: 8, taxable: true, isActive: true },
  });
  const addGroup = await db().pOSModifierGroup.create({
    data: { clubId: club.id, menuItemId: burger.id, modifierType: "ADD", label: "Add", sortOrder: 0, isActive: true },
  });
  const optBacon = await db().pOSModifierOption.create({
    data: { clubId: club.id, groupId: addGroup.id, label: "Add bacon", sortOrder: 0, isActive: true, priceDelta: 3 },
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
  const owen = await makeMember(club.id, { firstName: "Owen", lastName: "Beauchamp" });
  await db().member.update({
    where: { id: owen.id },
    data: { email: opts?.owenEmail === undefined ? "owen@example.com" : opts.owenEmail ?? "" },
  });
  const margaret = await makeMember(club.id, { firstName: "Margaret", lastName: "Lin" });
  await db().member.update({
    where: { id: margaret.id },
    data: { email: opts?.margaretEmail === undefined ? "margaret@example.com" : opts.margaretEmail ?? "" },
  });
  return { club, table, burger, beer, optBacon, owen, margaret };
}

async function adminFor(clubId: string, suffix: string) {
  const email = `split-receipt-${suffix}-${clubId}@example.com`;
  await makeUser({ email, role: "CLUB_ADMIN", clubId });
  return principalFor(email);
}

async function openTwoPayerTable(suffix: string, opts?: { owenEmail?: string | null; margaretEmail?: string | null }) {
  const ctx = await bootstrapTwoPayerCheck(`Split Receipt ${suffix}`, opts);
  const admin = await adminFor(ctx.club.id, suffix);
  const { checkId } = await seatTable(admin, ctx.club.id, {
    tableId: ctx.table.id, memberId: ctx.owen.id, partySize: 4,
  });
  // Seat 1: Owen's burger + bacon.
  await addCheckLines(admin, checkId, {
    items: [{ menuItemId: ctx.burger.id, quantity: 1, seatNumber: 1 }],
  });
  // Seat 2: Margaret's beer.
  await addCheckLines(admin, checkId, {
    items: [{ menuItemId: ctx.beer.id, quantity: 1, seatNumber: 2 }],
  });
  const burgerLine = (await db().pOSCheckLine.findFirst({ where: { checkId, seatNumber: 1 } }))!;
  await setLineModifiers(admin, burgerLine.id, {
    modifiers: [{ optionId: ctx.optBacon.id, modifierType: "ADD", label: "Add bacon", priceDelta: 3 }],
  });
  return { ...ctx, admin, checkId, burgerLine };
}

function splitSettle(opts: {
  admin: Awaited<ReturnType<typeof adminFor>>;
  checkId: string;
  owenId: string;
  margaretId: string;
}) {
  return settleCheckBySeats(opts.admin, opts.checkId, {
    groups: [
      { label: "Group A — Seat 1", seatNumbers: [1], paymentMethod: "MEMBER_ACCOUNT", memberId: opts.owenId },
      { label: "Group B — Seat 2", seatNumbers: [2], paymentMethod: "MEMBER_ACCOUNT", memberId: opts.margaretId },
    ],
    allowUnsentLines: true,
  });
}

beforeAll(async () => { await resetDb(); await seedRbac(); });
beforeEach(async () => { await resetDb(); await seedRbac(); });

// =============================================================================
// 1 + 2 + 6. Two groups → two emails, each to the right payer.
// =============================================================================
describe("Two MEMBER_ACCOUNT groups send one email each to the right payer", () => {
  it("writes a POSSettlementGroup.receiptEmailStatus per group + one EmailDeliveryEvent per recipient", async () => {
    const ctx = await openTwoPayerTable("happy");
    const r = await splitSettle({
      admin: ctx.admin, checkId: ctx.checkId,
      owenId: ctx.owen.id, margaretId: ctx.margaret.id,
    });
    expect(r.check.status).toBe("CLOSED");
    expect(r.groups).toHaveLength(2);

    const groups = await db().pOSSettlementGroup.findMany({
      where: { posCheckId: ctx.checkId },
      orderBy: { createdAt: "asc" },
    });
    expect(groups).toHaveLength(2);
    const owenGroup = groups.find((g) => g.memberId === ctx.owen.id)!;
    const margaretGroup = groups.find((g) => g.memberId === ctx.margaret.id)!;
    expect(owenGroup.receiptEmailStatus).toBe("DEV_LOGGED");
    expect(margaretGroup.receiptEmailStatus).toBe("DEV_LOGGED");
    expect(owenGroup.receiptEmailAddress).toBe("owen@example.com");
    expect(margaretGroup.receiptEmailAddress).toBe("margaret@example.com");

    // EmailDeliveryEvent — one row per recipient.
    const events = await db().emailDeliveryEvent.findMany({ where: { clubId: ctx.club.id }, orderBy: { occurredAt: "asc" } });
    expect(events.length).toBe(2);
    const owenEv = events.find((e) => e.email === "owen@example.com")!;
    const margaretEv = events.find((e) => e.email === "margaret@example.com")!;
    expect(owenEv.kind).toBe("POS_RECEIPT_DEV_LOGGED");
    expect(margaretEv.kind).toBe("POS_RECEIPT_DEV_LOGGED");
  });

  it("the POSCheck-level receiptEmailStatus stays NULL on split-bill (per-group rows carry status)", async () => {
    const ctx = await openTwoPayerTable("check-null");
    await splitSettle({
      admin: ctx.admin, checkId: ctx.checkId,
      owenId: ctx.owen.id, margaretId: ctx.margaret.id,
    });
    const check = await db().pOSCheck.findUnique({ where: { id: ctx.checkId } });
    expect(check?.receiptEmailStatus).toBeNull();
    expect(check?.receiptEmailAddress).toBeNull();
  });
});

// =============================================================================
// 3 + 4 + 17. Each group's POSSale contains ONLY its own items; the
//              member-side dining receipt also scopes correctly.
// =============================================================================
describe("Each receipt contains only that group's items", () => {
  it("Group A's POSSale carries Owen's burger; Group B's POSSale carries Margaret's beer — no cross-contamination", async () => {
    const ctx = await openTwoPayerTable("scope");
    const r = await splitSettle({
      admin: ctx.admin, checkId: ctx.checkId,
      owenId: ctx.owen.id, margaretId: ctx.margaret.id,
    });
    const owenSale = await db().pOSSale.findUnique({
      where: { id: r.groups[0].posSaleId! },
      include: { lines: { include: { modifiers: true } } },
    });
    const margaretSale = await db().pOSSale.findUnique({
      where: { id: r.groups[1].posSaleId! },
      include: { lines: { include: { modifiers: true } } },
    });
    expect(owenSale!.lines).toHaveLength(1);
    expect(owenSale!.lines[0].description).toContain("Silver Burger");
    expect(margaretSale!.lines).toHaveLength(1);
    expect(margaretSale!.lines[0].description).toContain("House Lager");

    // Sanity: neither sale carries the other's line.
    expect(owenSale!.lines.some((l) => l.description.includes("Lager"))).toBe(false);
    expect(margaretSale!.lines.some((l) => l.description.includes("Burger"))).toBe(false);
  });

  it("member dining detail page (getDiningReceipt) scopes per payer", async () => {
    const ctx = await openTwoPayerTable("dining-scope");
    const r = await splitSettle({
      admin: ctx.admin, checkId: ctx.checkId,
      owenId: ctx.owen.id, margaretId: ctx.margaret.id,
    });
    // Owen sees Group A only.
    const owenReceipt = await getDiningReceipt(r.groups[0].posSaleId!, ctx.owen.id);
    expect(owenReceipt).toBeTruthy();
    expect(owenReceipt!.lines.some((l) => l.description.includes("Burger"))).toBe(true);
    expect(owenReceipt!.lines.some((l) => l.description.includes("Lager"))).toBe(false);
    // Margaret CANNOT see Group A (different memberId).
    const owenSaleAsMargaret = await getDiningReceipt(r.groups[0].posSaleId!, ctx.margaret.id);
    expect(owenSaleAsMargaret).toBeNull();
    // And vice-versa.
    const margaretReceipt = await getDiningReceipt(r.groups[1].posSaleId!, ctx.margaret.id);
    expect(margaretReceipt).toBeTruthy();
    expect(margaretReceipt!.lines.some((l) => l.description.includes("Lager"))).toBe(true);
    expect(margaretReceipt!.lines.some((l) => l.description.includes("Burger"))).toBe(false);
  });
});

// =============================================================================
// 5 + 6 + 7. Seat numbers + modifier labels + allergy modifiers appear on
//             the correct group's sale.
// =============================================================================
describe("Seat numbers + modifiers + allergies land on the right group", () => {
  it("seat-prefix on the description ('Seat 1:', 'Seat 2:') survives to the snapshot", async () => {
    const ctx = await openTwoPayerTable("seat-prefix");
    // Add an allergy to Owen's burger so we can verify it lands only
    // on Owen's group's sale.
    await setLineModifiers(ctx.admin, ctx.burgerLine.id, {
      modifiers: [
        { optionId: ctx.optBacon.id, modifierType: "ADD", label: "Add bacon", priceDelta: 3 },
        { optionId: null, modifierType: "ALLERGY", label: "Peanut", priceDelta: 0 },
      ],
    });
    const r = await splitSettle({
      admin: ctx.admin, checkId: ctx.checkId,
      owenId: ctx.owen.id, margaretId: ctx.margaret.id,
    });
    const owenSale = await db().pOSSale.findUnique({
      where: { id: r.groups[0].posSaleId! },
      include: { lines: { include: { modifiers: true } } },
    });
    const margaretSale = await db().pOSSale.findUnique({
      where: { id: r.groups[1].posSaleId! },
      include: { lines: { include: { modifiers: true } } },
    });
    expect(owenSale!.lines[0].description.startsWith("Seat 1: ")).toBe(true);
    expect(margaretSale!.lines[0].description.startsWith("Seat 2: ")).toBe(true);

    // Modifier rows on Owen's sale only.
    const owenMods = owenSale!.lines[0].modifiers;
    expect(owenMods.some((m) => m.label === "Add bacon")).toBe(true);
    expect(owenMods.some((m) => m.modifierType === "ALLERGY" && m.label === "Peanut")).toBe(true);
    // Margaret's sale has no modifiers (no bacon, no allergy from Owen).
    expect(margaretSale!.lines[0].modifiers).toHaveLength(0);
  });
});

// =============================================================================
// 8. Group totals match group settlement totals.
// =============================================================================
describe("Per-group totals are honest", () => {
  it("Owen's group = $22.05 (burger 18 + bacon 3 + 5% GST), Margaret's = $8.40 (beer 8 + 5% GST)", async () => {
    const ctx = await openTwoPayerTable("totals");
    const r = await splitSettle({
      admin: ctx.admin, checkId: ctx.checkId,
      owenId: ctx.owen.id, margaretId: ctx.margaret.id,
    });
    const owenGroup = r.groups[0];
    const margaretGroup = r.groups[1];
    expect(owenGroup.subtotal).toBeCloseTo(21, 2);
    expect(owenGroup.tax).toBeCloseTo(1.05, 2);
    expect(owenGroup.grandTotal).toBeCloseTo(22.05, 2);
    expect(margaretGroup.subtotal).toBeCloseTo(8, 2);
    expect(margaretGroup.tax).toBeCloseTo(0.4, 2);
    expect(margaretGroup.grandTotal).toBeCloseTo(8.4, 2);

    // POSSale.grandTotal mirrors the group total.
    const owenSale = await db().pOSSale.findUnique({ where: { id: owenGroup.posSaleId! } });
    const margaretSale = await db().pOSSale.findUnique({ where: { id: margaretGroup.posSaleId! } });
    expect(Number(owenSale!.grandTotal.toString())).toBeCloseTo(22.05, 2);
    expect(Number(margaretSale!.grandTotal.toString())).toBeCloseTo(8.4, 2);
  });
});

// =============================================================================
// 9. Full check closes only after all groups settle.
// =============================================================================
describe("Check closes only when every billable seat is in a group", () => {
  it("settling only seat 1 leaves the check PARTIALLY_SETTLED (seat 2 still open)", async () => {
    const ctx = await openTwoPayerTable("partial");
    await settleCheckBySeats(ctx.admin, ctx.checkId, {
      groups: [{ label: "Just seat 1", seatNumbers: [1], paymentMethod: "MEMBER_ACCOUNT", memberId: ctx.owen.id }],
      allowUnsentLines: true,
    });
    const check = await db().pOSCheck.findUnique({ where: { id: ctx.checkId } });
    expect(check?.status).toBe("PARTIALLY_SETTLED");
    // No emails fire on PARTIALLY_SETTLED — neither the merge-all nor
    // the split-bill branch is taken because the loop saw N==1 but the
    // check didn't close.
    const events = await db().emailDeliveryEvent.findMany({ where: { clubId: ctx.club.id } });
    expect(events.length).toBe(0);
  });

  it("two groups covering all seats → check.status = CLOSED + two emails", async () => {
    const ctx = await openTwoPayerTable("closed");
    await splitSettle({
      admin: ctx.admin, checkId: ctx.checkId,
      owenId: ctx.owen.id, margaretId: ctx.margaret.id,
    });
    const check = await db().pOSCheck.findUnique({ where: { id: ctx.checkId } });
    expect(check?.status).toBe("CLOSED");
    const events = await db().emailDeliveryEvent.findMany({ where: { clubId: ctx.club.id } });
    expect(events.length).toBe(2);
  });
});

// =============================================================================
// 10. Missing email → SKIPPED_NO_EMAIL for that group; settlement still OK.
// =============================================================================
describe("Missing email is honest per group", () => {
  it("Margaret has no email → her group is SKIPPED_NO_EMAIL; Owen's group is DEV_LOGGED", async () => {
    const ctx = await openTwoPayerTable("no-margaret-email", { margaretEmail: null });
    await splitSettle({
      admin: ctx.admin, checkId: ctx.checkId,
      owenId: ctx.owen.id, margaretId: ctx.margaret.id,
    });
    const groups = await db().pOSSettlementGroup.findMany({
      where: { posCheckId: ctx.checkId },
      include: { member: true },
    });
    const owenGroup = groups.find((g) => g.memberId === ctx.owen.id)!;
    const margaretGroup = groups.find((g) => g.memberId === ctx.margaret.id)!;
    expect(owenGroup.receiptEmailStatus).toBe("DEV_LOGGED");
    expect(margaretGroup.receiptEmailStatus).toBe("SKIPPED_NO_EMAIL");
    expect(margaretGroup.receiptEmailAddress).toBeNull();
    // No event for Margaret — adapter was never called for her.
    const events = await db().emailDeliveryEvent.findMany({ where: { clubId: ctx.club.id } });
    expect(events.length).toBe(1);
    expect(events[0].email).toBe("owen@example.com");
  });
});

// =============================================================================
// 11 + 12 + 13. Suppressed/provider-failure on one group; the OTHER group's
//                email still goes out; settlement remains successful.
// =============================================================================
describe("Suppression / failure on one group does not block the other", () => {
  it("Margaret's email is on the global suppression list → SUPPRESSED on her group only; Owen's is DEV_LOGGED; check still CLOSED", async () => {
    const ctx = await openTwoPayerTable("supp", { margaretEmail: "bounced@example.com" });
    await db().emailSuppression.create({
      data: { email: "bounced@example.com", reason: "HARD_BOUNCE" },
    });
    const r = await splitSettle({
      admin: ctx.admin, checkId: ctx.checkId,
      owenId: ctx.owen.id, margaretId: ctx.margaret.id,
    });
    const check = await db().pOSCheck.findUnique({ where: { id: ctx.checkId } });
    expect(check?.status).toBe("CLOSED");

    const groups = await db().pOSSettlementGroup.findMany({ where: { posCheckId: ctx.checkId } });
    const owenGroup = groups.find((g) => g.memberId === ctx.owen.id)!;
    const margaretGroup = groups.find((g) => g.memberId === ctx.margaret.id)!;
    expect(owenGroup.receiptEmailStatus).toBe("DEV_LOGGED");
    expect(margaretGroup.receiptEmailStatus).toBe("SUPPRESSED");
    expect((margaretGroup.receiptEmailFailure ?? "")).toContain("suppressed");

    // POSSale for the suppressed group is still COMPLETED — suppression
    // is reporting-only.
    const margaretSale = await db().pOSSale.findUnique({ where: { id: r.groups[1].posSaleId! } });
    expect(margaretSale?.status).toBe("COMPLETED");
  });

  it("settle response carries per-group email status to the UI", async () => {
    const ctx = await openTwoPayerTable("response");
    const r = await splitSettle({
      admin: ctx.admin, checkId: ctx.checkId,
      owenId: ctx.owen.id, margaretId: ctx.margaret.id,
    });
    expect(r.groups[0].receiptEmailStatus).toBe("DEV_LOGGED");
    expect(r.groups[1].receiptEmailStatus).toBe("DEV_LOGGED");
    expect(r.groups[0].receiptEmailAddress).toBe("owen@example.com");
    expect(r.groups[1].receiptEmailAddress).toBe("margaret@example.com");
  });
});

// =============================================================================
// 14. Idempotency — a CLOSED check can't be settled twice, so no double-send.
// =============================================================================
describe("Idempotency — CLOSED check cannot be re-settled", () => {
  it("two settle attempts on the same check → one set of emails, second call rejects", async () => {
    const ctx = await openTwoPayerTable("idem");
    await splitSettle({
      admin: ctx.admin, checkId: ctx.checkId,
      owenId: ctx.owen.id, margaretId: ctx.margaret.id,
    });
    const before = await db().emailDeliveryEvent.count({ where: { clubId: ctx.club.id } });
    expect(before).toBe(2);

    await expect(
      splitSettle({
        admin: ctx.admin, checkId: ctx.checkId,
        owenId: ctx.owen.id, margaretId: ctx.margaret.id,
      }),
    ).rejects.toThrow();

    const after = await db().emailDeliveryEvent.count({ where: { clubId: ctx.club.id } });
    expect(after).toBe(before);
  });
});

// =============================================================================
// 15. QR/unsupported group does NOT email (and is already blocked at the
//     service level — re-pin the boundary).
// =============================================================================
describe("QR_PAY group is blocked before any email could fire", () => {
  it("a group with paymentMethod=QR_PAY rejects with ConflictError, no settlement, no emails", async () => {
    const ctx = await openTwoPayerTable("qr");
    await expect(
      settleCheckBySeats(ctx.admin, ctx.checkId, {
        groups: [
          { label: "Group A", seatNumbers: [1], paymentMethod: "MEMBER_ACCOUNT", memberId: ctx.owen.id },
          { label: "Group B", seatNumbers: [2], paymentMethod: "QR_PAY", memberId: ctx.margaret.id },
        ],
        allowUnsentLines: true,
      }),
    ).rejects.toThrow();
    const events = await db().emailDeliveryEvent.findMany({ where: { clubId: ctx.club.id } });
    expect(events.length).toBe(0);
  });
});

// =============================================================================
// 16. Single merged group still uses the legacy POSCheck-level email path.
// =============================================================================
describe("Merge-all-into-one (N=1) preserves the POSCheck-level email", () => {
  it("one MEMBER_ACCOUNT group covering both seats → exactly one email, POSCheck status DEV_LOGGED, group-level row receiptEmailStatus NULL", async () => {
    const ctx = await openTwoPayerTable("merge");
    await settleCheckBySeats(ctx.admin, ctx.checkId, {
      groups: [{
        label: "All seats",
        seatNumbers: [1, 2],
        paymentMethod: "MEMBER_ACCOUNT",
        memberId: ctx.owen.id,
      }],
      allowUnsentLines: true,
    });
    const check = await db().pOSCheck.findUnique({ where: { id: ctx.checkId } });
    expect(check?.status).toBe("CLOSED");
    // Merge-all path writes to POSCheck (legacy / source of truth here).
    expect(check?.receiptEmailStatus).toBe("DEV_LOGGED");
    expect(check?.receiptEmailAddress).toBe("owen@example.com");

    const groups = await db().pOSSettlementGroup.findMany({ where: { posCheckId: ctx.checkId } });
    expect(groups).toHaveLength(1);
    // Group row is left NULL for the merge-all case — no split-bill
    // status to record there.
    expect(groups[0].receiptEmailStatus).toBeNull();

    const events = await db().emailDeliveryEvent.findMany({ where: { clubId: ctx.club.id } });
    expect(events.length).toBe(1);
  });
});
