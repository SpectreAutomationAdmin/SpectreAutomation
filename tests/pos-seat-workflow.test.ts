// Phase 18E — server-led self-seating + seat-level ordering + seat-group split bill.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { db, makeClub, makeMember, makeUser, principalFor, resetDb, seedRbac } from "./util/db";
import { bootstrapAPClub } from "./util/ap";
import { seatTable, settleCheckBySeats, seatSummary, assignCheckSeat } from "@/lib/pos/seat-checks";
import { addCheckLines, sendUnsentItems, listChitsForStation } from "@/lib/pos/checks";
import { LOUNGE_LOCATION_CODE, LOUNGE_TERMINAL_CODE } from "@/lib/pos/lounge";
import { ConflictError, TenantViolationError, ValidationError } from "@/lib/errors";

async function bootstrapLounge(name: string) {
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
  const cat = await db().pOSMenuCategory.create({
    data: { clubId: club.id, locationId: loc.id, name: "Mains", sortOrder: 1, isActive: true, chitDestination: "KITCHEN" },
  });
  const burger = await db().pOSMenuItem.create({
    data: { clubId: club.id, categoryId: cat.id, name: "Burger", price: 20, taxable: true, isActive: true },
  });
  const beer = await db().pOSMenuItem.create({
    data: {
      clubId: club.id,
      categoryId: (await db().pOSMenuCategory.create({
        data: { clubId: club.id, locationId: loc.id, name: "Drinks", sortOrder: 2, isActive: true, chitDestination: "BAR" },
      })).id,
      name: "Beer", price: 8, taxable: true, isActive: true,
    },
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
  // Phase 18F — every seated check requires a primary member, so the
  // helper now ships one out of the box.
  const host = await makeMember(club.id);
  return { club, table, burger, beer, host };
}

async function clubAdminFor(clubId: string, suffix = "") {
  const email = `seat-admin-${suffix}-${clubId}@example.com`;
  await makeUser({ email, role: "CLUB_ADMIN", clubId });
  return principalFor(email);
}

beforeAll(async () => { await resetDb(); await seedRbac(); });
beforeEach(async () => { await resetDb(); await seedRbac(); });

// ===========================================================================
// seatTable
// ===========================================================================
describe("Server-led self-seating", () => {
  it("seats an AVAILABLE table, flips it to SEATED, and opens a check stamped with tableId + party size", async () => {
    const { club, table } = await bootstrapLounge("Seat OK Club");
    const admin = await clubAdminFor(club.id, "ok");
    const member = await makeMember(club.id);
    const { checkId } = await seatTable(admin, club.id, {
      tableId: table.id, memberId: member.id, partySize: 4,
    });
    const t = await db().diningTable.findUnique({ where: { id: table.id } });
    expect(t?.status).toBe("SEATED");
    const check = await db().pOSCheck.findUnique({ where: { id: checkId } });
    expect(check?.tableId).toBe(table.id);
    expect(check?.memberId).toBe(member.id);
    expect(check?.partySize).toBe(4);
    expect(check?.tableNumber).toBe(table.tableNumber);
    expect(check?.status).toBe("OPEN");
    expect(check?.serverId).toBe(admin.id);
  });

  it("refuses to seat without a primary member (Phase 18F)", async () => {
    const { club, table } = await bootstrapLounge("Seat Primary Required Club");
    const admin = await clubAdminFor(club.id, "primary");
    // No memberId, no memberNumber → ValidationError from the schema refinement.
    await expect(seatTable(admin, club.id, { tableId: table.id, partySize: 2 })).rejects.toBeInstanceOf(ValidationError);
  });

  it("accepts memberNumber instead of memberId and resolves it to the primary member", async () => {
    const { club, table } = await bootstrapLounge("Seat MemberNumber Club");
    const admin = await clubAdminFor(club.id, "byNumber");
    const member = await makeMember(club.id);
    const { checkId } = await seatTable(admin, club.id, {
      tableId: table.id, memberNumber: member.memberNumber, partySize: 3,
    });
    const check = await db().pOSCheck.findUnique({ where: { id: checkId } });
    expect(check?.memberId).toBe(member.id);
  });

  it("creates one POSCheckSeat row per party member on seating: Seat 1 = primary member, Seats 2..N = unassigned guests (Step 17)", async () => {
    const { club, table } = await bootstrapLounge("Seat Primary Row Club");
    const admin = await clubAdminFor(club.id, "primaryRow");
    const member = await makeMember(club.id);
    const { checkId } = await seatTable(admin, club.id, {
      tableId: table.id, memberId: member.id, partySize: 4,
    });
    const seats = await db().pOSCheckSeat.findMany({
      where: { posCheckId: checkId },
      orderBy: { seatNumber: "asc" },
    });

    // Party size 4 → one row per seat (primary + 3 guests).
    expect(seats).toHaveLength(4);
    expect(seats.map((s) => s.seatNumber)).toEqual([1, 2, 3, 4]);

    // Exactly one primary, and it's Seat 1 carrying the member id.
    const primaries = seats.filter((s) => s.isPrimary);
    expect(primaries).toHaveLength(1);
    expect(primaries[0].seatNumber).toBe(1);
    expect(primaries[0].memberId).toBe(member.id);
    expect(primaries[0].guestName).toBeNull();

    // Seats 2..4 are unassigned guest placeholders — no member id, no
    // isPrimary flag, but a placeholder guestName so the seat view
    // shows the party shape immediately.
    const guests = seats.filter((s) => !s.isPrimary);
    expect(guests).toHaveLength(3);
    for (const g of guests) {
      expect(g.memberId).toBeNull();
      expect(g.isPrimary).toBe(false);
      expect(g.guestName).toBe("Guest");
    }

    // Every seat is scoped to the same check + club.
    expect(seats.every((s) => s.posCheckId === checkId)).toBe(true);
    expect(seats.every((s) => s.clubId === club.id)).toBe(true);
  });

  it("refuses to seat a DIRTY table", async () => {
    const { club, table } = await bootstrapLounge("Seat Dirty Club");
    const admin = await clubAdminFor(club.id, "dirty");
    const member = await makeMember(club.id);
    await db().diningTable.update({ where: { id: table.id }, data: { status: "DIRTY" } });
    await expect(seatTable(admin, club.id, { tableId: table.id, memberId: member.id })).rejects.toBeInstanceOf(ConflictError);
  });

  it("refuses to seat an OUT_OF_SERVICE table", async () => {
    const { club, table } = await bootstrapLounge("Seat OOS Club");
    const admin = await clubAdminFor(club.id, "oos");
    const member = await makeMember(club.id);
    await db().diningTable.update({ where: { id: table.id }, data: { status: "OUT_OF_SERVICE" } });
    await expect(seatTable(admin, club.id, { tableId: table.id, memberId: member.id })).rejects.toBeInstanceOf(ConflictError);
  });

  it("refuses to seat a SEATED table (existing check must be reused)", async () => {
    const { club, table } = await bootstrapLounge("Seat Twice Club");
    const admin = await clubAdminFor(club.id, "twice");
    const member = await makeMember(club.id);
    await seatTable(admin, club.id, { tableId: table.id, memberId: member.id, partySize: 2 });
    await expect(seatTable(admin, club.id, { tableId: table.id, memberId: member.id })).rejects.toBeInstanceOf(ConflictError);
  });

  it("admin of club B cannot seat club A's table", async () => {
    const a = await bootstrapLounge("Seat Iso A");
    const b = await makeClub("Seat Iso B");
    const adminB = await clubAdminFor(b.id, "iso");
    const memberB = await makeMember(b.id);
    await expect(seatTable(adminB, b.id, { tableId: a.table.id, memberId: memberB.id })).rejects.toBeInstanceOf(TenantViolationError);
  });
});

// ===========================================================================
// Seat-level ordering
// ===========================================================================
describe("Seat-level item ordering", () => {
  it("addCheckLines persists seatNumber on each line and skips tableLevel correctly", async () => {
    const { club, table, burger, beer, host } = await bootstrapLounge("Seat Add Club");
    const admin = await clubAdminFor(club.id, "add");
    const { checkId } = await seatTable(admin, club.id, { tableId: table.id, memberId: host.id, partySize: 4 });
    await addCheckLines(admin, checkId, {
      items: [
        { menuItemId: burger.id, quantity: 1, seatNumber: 2 },
        { menuItemId: beer.id, quantity: 1, seatNumber: 4 },
        { menuItemId: burger.id, quantity: 1, tableLevel: true },
      ],
    });
    const lines = await db().pOSCheckLine.findMany({ where: { checkId }, orderBy: { createdAt: "asc" } });
    expect(lines).toHaveLength(3);
    expect(lines[0].seatNumber).toBe(2);
    expect(lines[0].tableLevel).toBe(false);
    expect(lines[1].seatNumber).toBe(4);
    expect(lines[2].tableLevel).toBe(true);
    expect(lines[2].seatNumber).toBeNull();
  });

  it("kitchen chit lines capture the seat number on send (snapshotted)", async () => {
    const { club, table, burger, host } = await bootstrapLounge("Seat Chit Club");
    const admin = await clubAdminFor(club.id, "chit");
    const { checkId } = await seatTable(admin, club.id, { tableId: table.id, memberId: host.id, partySize: 4 });
    await addCheckLines(admin, checkId, {
      items: [{ menuItemId: burger.id, quantity: 1, seatNumber: 3 }],
    });
    await sendUnsentItems(admin, checkId);
    const chits = await listChitsForStation(admin, club.id, "KITCHEN", { limit: 5 });
    const target = chits.find((c) => c.checkId === checkId);
    expect(target).toBeTruthy();
    const line = target!.lines.find((l) => l.displaySeatNumber === 3);
    expect(line).toBeTruthy();
  });

  it("seatSummary returns the right subtotal per seat", async () => {
    const { club, table, burger, beer, host } = await bootstrapLounge("Seat Sum Club");
    const admin = await clubAdminFor(club.id, "sum");
    const { checkId } = await seatTable(admin, club.id, { tableId: table.id, memberId: host.id, partySize: 4 });
    await addCheckLines(admin, checkId, {
      items: [
        { menuItemId: burger.id, quantity: 1, seatNumber: 1 },  // $20
        { menuItemId: beer.id, quantity: 2, seatNumber: 1 },    // $16
        { menuItemId: burger.id, quantity: 1, seatNumber: 3 },  // $20
      ],
    });
    const r = await seatSummary(admin, checkId);
    const seat1 = r.seats.find((s) => s.seatNumber === 1)!;
    const seat3 = r.seats.find((s) => s.seatNumber === 3)!;
    expect(seat1.subtotal).toBeCloseTo(36, 2);
    expect(seat3.subtotal).toBeCloseTo(20, 2);
    expect(r.seats.find((s) => s.seatNumber === 2)?.items.length).toBe(0);
  });
});

// ===========================================================================
// Split-bill settlement
// ===========================================================================
describe("Seat-group split bill", () => {
  it("settles two groups, produces two POSSales, each with the right subtotal + tax, and closes the check", async () => {
    const { club, table, burger, beer, host } = await bootstrapLounge("Split Two Club");
    const admin = await clubAdminFor(club.id, "split");
    const a = await makeMember(club.id);
    const b = await makeMember(club.id);
    const { checkId } = await seatTable(admin, club.id, { tableId: table.id, memberId: host.id, partySize: 4 });
    await addCheckLines(admin, checkId, {
      items: [
        { menuItemId: burger.id, quantity: 1, seatNumber: 1 },  // $20 → group A
        { menuItemId: beer.id, quantity: 1, seatNumber: 2 },    // $8  → group A
        { menuItemId: burger.id, quantity: 1, seatNumber: 3 },  // $20 → group B
        { menuItemId: beer.id, quantity: 1, seatNumber: 4 },    // $8  → group B
      ],
    });
    await sendUnsentItems(admin, checkId);

    const r = await settleCheckBySeats(admin, checkId, {
      groups: [
        { label: "Seats 1+2", seatNumbers: [1, 2], paymentMethod: "MEMBER_ACCOUNT", memberId: a.id },
        { label: "Seats 3+4", seatNumbers: [3, 4], paymentMethod: "MEMBER_ACCOUNT", memberId: b.id },
      ],
    });
    expect(r.check.status).toBe("CLOSED");
    expect(r.groups).toHaveLength(2);
    const ga = r.groups.find((g) => g.label === "Seats 1+2")!;
    const gb = r.groups.find((g) => g.label === "Seats 3+4")!;
    expect(ga.subtotal).toBeCloseTo(28, 2);
    expect(ga.tax).toBeCloseTo(1.4, 2);
    expect(ga.grandTotal).toBeCloseTo(29.4, 2);
    expect(gb.subtotal).toBeCloseTo(28, 2);
    expect(gb.posSaleId).toBeTruthy();

    // Each group produced a real POSSale with only its own lines.
    const saleA = await db().pOSSale.findUnique({ where: { id: ga.posSaleId! }, include: { lines: true } });
    const saleB = await db().pOSSale.findUnique({ where: { id: gb.posSaleId! }, include: { lines: true } });
    expect(saleA?.status).toBe("COMPLETED");
    expect(saleA?.memberId).toBe(a.id);
    expect(saleA?.lines).toHaveLength(2);
    expect(saleB?.memberId).toBe(b.id);
    expect(saleB?.lines).toHaveLength(2);
    // Member dining history scoping: each member's sales contain only their lines.
    expect(saleA?.lines.every((l) => l.description.match(/Burger|Beer/))).toBe(true);
    expect(saleA?.lines.reduce((s, l) => s + Number(l.lineTotal.toString()), 0)).toBeGreaterThan(0);

    // Each group's settlement group row records the sale + status.
    const groups = await db().pOSSettlementGroup.findMany({ where: { posCheckId: checkId } });
    expect(groups).toHaveLength(2);
    expect(groups.every((g) => g.status === "SETTLED")).toBe(true);
    expect(groups.every((g) => g.posSaleId)).toBe(true);
  });

  // This test runs the full split-bill settlement path: seat the table,
  // add per-seat lines for two seats, send them, then settle only one
  // group. The path through settleCheckBySeats includes sale creation,
  // member-account charge, settlement-group write, and per-seat audit
  // events — measured at ~13s in isolation on Windows SQLite/WAL. No
  // hang, no unresolved promise: the work is genuinely there. The
  // Vitest default 20s testTimeout leaves no headroom for run-time
  // variance, so we bump this one test to 30s.
  it("only-some-seats group leaves the check PARTIALLY_SETTLED", { timeout: 30_000 }, async () => {
    const { club, table, burger, beer, host } = await bootstrapLounge("Split Partial Club");
    const admin = await clubAdminFor(club.id, "partial");
    const a = await makeMember(club.id);
    const { checkId } = await seatTable(admin, club.id, { tableId: table.id, memberId: host.id, partySize: 4 });
    await addCheckLines(admin, checkId, {
      items: [
        { menuItemId: burger.id, quantity: 1, seatNumber: 1 },
        { menuItemId: beer.id, quantity: 1, seatNumber: 3 },
      ],
    });
    await sendUnsentItems(admin, checkId);
    const r = await settleCheckBySeats(admin, checkId, {
      groups: [{ label: "Seat 1", seatNumbers: [1], paymentMethod: "MEMBER_ACCOUNT", memberId: a.id }],
    });
    expect(r.check.status).toBe("PARTIALLY_SETTLED");
    const groups = await db().pOSSettlementGroup.findMany({ where: { posCheckId: checkId } });
    expect(groups).toHaveLength(1);
  });

  it("refuses to overlap seats across groups", async () => {
    const { club, table, burger, host } = await bootstrapLounge("Split Overlap Club");
    const admin = await clubAdminFor(club.id, "overlap");
    const m = await makeMember(club.id);
    const { checkId } = await seatTable(admin, club.id, { tableId: table.id, memberId: host.id, partySize: 4 });
    await addCheckLines(admin, checkId, {
      items: [{ menuItemId: burger.id, quantity: 1, seatNumber: 1 }],
    });
    await sendUnsentItems(admin, checkId);
    await expect(
      settleCheckBySeats(admin, checkId, {
        groups: [
          { label: "G1", seatNumbers: [1, 2], paymentMethod: "MEMBER_ACCOUNT", memberId: m.id },
          { label: "G2", seatNumbers: [2, 3], paymentMethod: "MEMBER_ACCOUNT", memberId: m.id },
        ],
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("MEMBER_ACCOUNT group without a member is rejected", async () => {
    const { club, table, burger, host } = await bootstrapLounge("Split No Member Club");
    const admin = await clubAdminFor(club.id, "noMember");
    const { checkId } = await seatTable(admin, club.id, { tableId: table.id, memberId: host.id, partySize: 4 });
    await addCheckLines(admin, checkId, {
      items: [{ menuItemId: burger.id, quantity: 1, seatNumber: 1 }],
    });
    await sendUnsentItems(admin, checkId);
    await expect(
      settleCheckBySeats(admin, checkId, {
        groups: [{ label: "G1", seatNumbers: [1], paymentMethod: "MEMBER_ACCOUNT", memberId: null }],
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("QR_PAY combined with any other group is rejected (Step 19 — per-group QR_PAY is only legal as the single whole-check group)", async () => {
    // Product guard at src/lib/pos/seat-checks.ts:437 — rejects when
    // any QR_PAY group is part of a multi-group settlement. Single-
    // group QR_PAY falls through to the whole-check QR path
    // (covered by the positive test directly below).
    const { club, table, burger, beer, host } = await bootstrapLounge("Split QR Multi Club");
    const admin = await clubAdminFor(club.id, "qrMulti");
    const m = await makeMember(club.id);
    const { checkId } = await seatTable(admin, club.id, { tableId: table.id, memberId: host.id, partySize: 4 });
    await addCheckLines(admin, checkId, {
      items: [
        { menuItemId: burger.id, quantity: 1, seatNumber: 1 },
        { menuItemId: beer.id,   quantity: 1, seatNumber: 2 },
      ],
    });
    await sendUnsentItems(admin, checkId);
    await expect(
      settleCheckBySeats(admin, checkId, {
        groups: [
          { label: "G1", seatNumbers: [1], paymentMethod: "QR_PAY",         memberId: m.id },
          { label: "G2", seatNumbers: [2], paymentMethod: "MEMBER_ACCOUNT", memberId: m.id },
        ],
      }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("single-group QR_PAY for one seat settles via the whole-check QR path (Step 19)", async () => {
    // When the seat split is a single QR_PAY group, settleCheckBySeats
    // recognises the merge-all case and produces exactly one sale
    // attributed to the group's member; the check closes and the
    // settlement group row records the sale + status.
    const { club, table, burger, host } = await bootstrapLounge("Split QR Single Club");
    const admin = await clubAdminFor(club.id, "qrSingle");
    const m = await makeMember(club.id);
    const { checkId } = await seatTable(admin, club.id, { tableId: table.id, memberId: host.id, partySize: 4 });
    await addCheckLines(admin, checkId, {
      items: [{ menuItemId: burger.id, quantity: 1, seatNumber: 1 }],
    });
    await sendUnsentItems(admin, checkId);

    const r = await settleCheckBySeats(admin, checkId, {
      groups: [{ label: "G1", seatNumbers: [1], paymentMethod: "QR_PAY", memberId: m.id }],
    });

    // Check is closed, single settlement group recorded.
    expect(r.check.status).toBe("CLOSED");
    expect(r.groups).toHaveLength(1);
    const g = r.groups[0];
    expect(g.label).toBe("G1");
    expect(g.status).toBe("SETTLED");
    expect(g.posSaleId).toBeTruthy();

    // Totals add up — burger is $20 at the lounge fixture.
    expect(g.subtotal).toBe(20);
    expect(g.itemCount).toBe(1);
    expect(g.grandTotal).toBeGreaterThanOrEqual(g.subtotal);

    // The settlement group row matches what was returned.
    const dbGroups = await db().pOSSettlementGroup.findMany({ where: { posCheckId: checkId } });
    expect(dbGroups).toHaveLength(1);
    expect(dbGroups[0].status).toBe("SETTLED");
    expect(dbGroups[0].posSaleId).toBe(g.posSaleId);

    // The created sale is scoped to the same club, and the originating
    // check still points back to it through the POSCheckSale relation.
    const sale = await db().pOSSale.findUnique({ where: { id: g.posSaleId! } });
    expect(sale?.clubId).toBe(club.id);
    const closedCheck = await db().pOSCheck.findUnique({ where: { id: checkId } });
    expect(closedCheck?.posSaleId).toBe(g.posSaleId);
  });

  it("admin of club B cannot settle club A's check", async () => {
    const a = await bootstrapLounge("Split Iso A");
    const b = await makeClub("Split Iso B");
    const adminA = await clubAdminFor(a.club.id, "iso-a");
    const adminB = await clubAdminFor(b.id, "iso-b");
    const m = await makeMember(a.club.id);
    const { checkId } = await seatTable(adminA, a.club.id, { tableId: a.table.id, memberId: a.host.id, partySize: 2 });
    await addCheckLines(adminA, checkId, {
      items: [{ menuItemId: a.burger.id, quantity: 1, seatNumber: 1 }],
    });
    await sendUnsentItems(adminA, checkId);
    await expect(
      settleCheckBySeats(adminB, checkId, {
        groups: [{ label: "G1", seatNumbers: [1], paymentMethod: "MEMBER_ACCOUNT", memberId: m.id }],
      }),
    ).rejects.toBeInstanceOf(TenantViolationError);
  });
});

// ===========================================================================
// Phase 18F — per-seat member / guest assignment
// ===========================================================================
describe("Per-seat assignment", () => {
  it("assignCheckSeat assigns a member to seat 2 via memberNumber", async () => {
    const { club, table, host } = await bootstrapLounge("Assign Member Club");
    const admin = await clubAdminFor(club.id, "assignM");
    const second = await makeMember(club.id);
    const { checkId } = await seatTable(admin, club.id, { tableId: table.id, memberId: host.id, partySize: 4 });
    await assignCheckSeat(admin, checkId, { seatNumber: 2, memberNumber: second.memberNumber });
    const row = await db().pOSCheckSeat.findUnique({
      where: { posCheckId_seatNumber: { posCheckId: checkId, seatNumber: 2 } },
    });
    expect(row?.memberId).toBe(second.id);
    expect(row?.isPrimary).toBe(false);
    expect(row?.guestName).toBeNull();
  });

  it("assignCheckSeat marks a seat as a guest with a name", async () => {
    const { club, table, host } = await bootstrapLounge("Assign Guest Club");
    const admin = await clubAdminFor(club.id, "assignG");
    const { checkId } = await seatTable(admin, club.id, { tableId: table.id, memberId: host.id, partySize: 4 });
    await assignCheckSeat(admin, checkId, { seatNumber: 3, guestName: "Smith party" });
    const row = await db().pOSCheckSeat.findUnique({
      where: { posCheckId_seatNumber: { posCheckId: checkId, seatNumber: 3 } },
    });
    expect(row?.guestName).toBe("Smith party");
    expect(row?.memberId).toBeNull();
  });

  it("primary seat cannot be cleared", async () => {
    const { club, table, host } = await bootstrapLounge("Assign Primary Locked Club");
    const admin = await clubAdminFor(club.id, "primaryLocked");
    const { checkId } = await seatTable(admin, club.id, { tableId: table.id, memberId: host.id, partySize: 4 });
    await expect(
      assignCheckSeat(admin, checkId, { seatNumber: 1, memberId: null, guestName: null }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("seatSummary surfaces per-seat assignment with member display name + memberNumber", async () => {
    const { club, table, host } = await bootstrapLounge("Assign Summary Club");
    const admin = await clubAdminFor(club.id, "summaryAssign");
    const second = await makeMember(club.id);
    const { checkId } = await seatTable(admin, club.id, { tableId: table.id, memberId: host.id, partySize: 4 });
    await assignCheckSeat(admin, checkId, { seatNumber: 2, memberId: second.id });
    await assignCheckSeat(admin, checkId, { seatNumber: 3, guestName: "Brown +1" });
    const s = await seatSummary(admin, checkId);
    const seat1 = s.seats.find((x) => x.seatNumber === 1)!;
    expect(seat1.assignment.isPrimary).toBe(true);
    expect(seat1.assignment.memberId).toBe(host.id);
    expect(seat1.assignment.memberNumber).toBe(host.memberNumber);
    const seat2 = s.seats.find((x) => x.seatNumber === 2)!;
    expect(seat2.assignment.memberId).toBe(second.id);
    expect(seat2.assignment.memberDisplay).toBe(`${second.firstName} ${second.lastName}`);
    const seat3 = s.seats.find((x) => x.seatNumber === 3)!;
    expect(seat3.assignment.guestName).toBe("Brown +1");
    expect(seat3.assignment.memberId).toBeNull();
    // Seat 4 — never touched by assignCheckSeat. Step 17 pre-populates
    // it as a "Guest" placeholder when partySize is supplied at seating,
    // so seatSummary surfaces the placeholder guest name. A member id is
    // never set on a placeholder.
    const seat4 = s.seats.find((x) => x.seatNumber === 4)!;
    expect(seat4.assignment.memberId).toBeNull();
    expect(seat4.assignment.isPrimary).toBe(false);
    expect(seat4.assignment.guestName).toBe("Guest");
    expect(seat4.assignment.memberDisplay).toBeNull();
    expect(seat4.assignment.memberNumber).toBeNull();
  });

  it("rejects a memberNumber that doesn't belong to the same club (cross-tenant safety)", async () => {
    const { club, table, host } = await bootstrapLounge("Assign Iso Club");
    const otherClub = await makeClub("Assign Iso Other");
    const adminA = await clubAdminFor(club.id, "iso-assign");
    const intruder = await makeMember(otherClub.id);
    const { checkId } = await seatTable(adminA, club.id, { tableId: table.id, memberId: host.id, partySize: 4 });
    await expect(
      assignCheckSeat(adminA, checkId, { seatNumber: 2, memberNumber: intruder.memberNumber }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});
