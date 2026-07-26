// POS cleanup step 17 — party-size auto-population.
//
// Pins the seat-creation contract when a server starts a check from
// the floor map (or when a reservation's check is auto-opened):
//   - Seat 1 = primary member (HOST). Already enforced; reasserted here.
//   - Seats 2..partySize = Guest placeholders ("Guest" + isPrimary:false).
//   - Seats > partySize stay unmodeled (no POSCheckSeat row). seatSummary
//     iterates 1..capacity and renders the missing rows as "Unassigned".
//   - Party size > table.capacity is rejected at the service boundary.
//   - The SeatStrip name label collapses placeholder Guest seats to
//     plain "Guest", not "Guest (guest)".
//   - SelfSeatingForm displays the table's capacity.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { db, makeMember, makeUser, principalFor, resetDb, seedRbac } from "./util/db";
import { bootstrapAPClub } from "./util/ap";
import {
  seatTable,
  assignCheckSeat,
  seatSummary,
} from "@/lib/pos/seat-checks";
import { LOUNGE_LOCATION_CODE, LOUNGE_TERMINAL_CODE } from "@/lib/pos/lounge";
import { ensureCheckForReservation } from "@/lib/hospitality/reservations";

async function bootstrapLounge(name: string, opts?: { capacity?: number }) {
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
  const area = await db().diningArea.create({
    data: { clubId: club.id, name: "Lounge", sortOrder: 0 },
  });
  const table = await db().diningTable.create({
    data: {
      clubId: club.id, diningAreaId: area.id, tableNumber: "L3", capacity: opts?.capacity ?? 4,
      shape: "SQUARE", xPos: 100, yPos: 100, width: 110, height: 110,
    },
  });
  const adminEmail = `party-size-${club.id}@example.com`;
  await makeUser({ email: adminEmail, role: "CLUB_ADMIN", clubId: club.id });
  const admin = await principalFor(adminEmail);
  return { club, table, admin };
}

beforeAll(async () => { await resetDb(); await seedRbac(); });
beforeEach(async () => { await resetDb(); await seedRbac(); });

// =============================================================================
// 1. Seat 1 is the primary member (host).
// =============================================================================
describe("seatTable — Seat 1 is the primary member", () => {
  it("creates Seat 1 with the resolved memberId and isPrimary=true", async () => {
    const ctx = await bootstrapLounge("seat1-host");
    const margaret = await makeMember(ctx.club.id, { firstName: "Margaret", lastName: "Holloway" });
    await db().member.update({ where: { id: margaret.id }, data: { memberNumber: "0613" } });

    const { checkId } = await seatTable(ctx.admin, ctx.club.id, {
      tableId: ctx.table.id, memberNumber: "0613", partySize: 2,
    });
    const seat1 = await db().pOSCheckSeat.findFirst({
      where: { posCheckId: checkId, seatNumber: 1 },
    });
    expect(seat1?.memberId).toBe(margaret.id);
    expect(seat1?.isPrimary).toBe(true);
    expect(seat1?.guestName).toBeNull();
  });
});

// =============================================================================
// 2. Seats 2..partySize are auto-created as Guest.
// =============================================================================
describe("seatTable — auto-creates guest seats up to partySize", () => {
  it("partySize=2 creates exactly Seat 1 (member) + Seat 2 (Guest)", async () => {
    const ctx = await bootstrapLounge("party2");
    const margaret = await makeMember(ctx.club.id);
    await db().member.update({ where: { id: margaret.id }, data: { memberNumber: "0613" } });

    const { checkId } = await seatTable(ctx.admin, ctx.club.id, {
      tableId: ctx.table.id, memberNumber: "0613", partySize: 2,
    });
    const seats = await db().pOSCheckSeat.findMany({
      where: { posCheckId: checkId },
      orderBy: { seatNumber: "asc" },
    });
    expect(seats.map((s) => s.seatNumber)).toEqual([1, 2]);
    expect(seats[1].memberId).toBeNull();
    expect(seats[1].guestName).toBe("Guest");
    expect(seats[1].isPrimary).toBe(false);
  });

  it("partySize=3 creates Seats 1..3 with Seats 2..3 as Guest", async () => {
    const ctx = await bootstrapLounge("party3", { capacity: 6 });
    const m = await makeMember(ctx.club.id);
    await db().member.update({ where: { id: m.id }, data: { memberNumber: "1310" } });

    const { checkId } = await seatTable(ctx.admin, ctx.club.id, {
      tableId: ctx.table.id, memberNumber: "1310", partySize: 3,
    });
    const seats = await db().pOSCheckSeat.findMany({
      where: { posCheckId: checkId },
      orderBy: { seatNumber: "asc" },
    });
    expect(seats.map((s) => s.seatNumber)).toEqual([1, 2, 3]);
    expect(seats[1].guestName).toBe("Guest");
    expect(seats[2].guestName).toBe("Guest");
  });
});

// =============================================================================
// 3. Seats above partySize stay unmodeled (no POSCheckSeat row).
// =============================================================================
describe("seatTable — seats above partySize are not pre-created", () => {
  it("capacity=4, partySize=2 → only 2 rows exist (Seats 3 + 4 absent)", async () => {
    const ctx = await bootstrapLounge("above-party", { capacity: 4 });
    const m = await makeMember(ctx.club.id);
    await db().member.update({ where: { id: m.id }, data: { memberNumber: "1310" } });

    const { checkId } = await seatTable(ctx.admin, ctx.club.id, {
      tableId: ctx.table.id, memberNumber: "1310", partySize: 2,
    });
    const seats = await db().pOSCheckSeat.findMany({ where: { posCheckId: checkId } });
    expect(seats.length).toBe(2);
    expect(seats.find((s) => s.seatNumber === 3)).toBeUndefined();
    expect(seats.find((s) => s.seatNumber === 4)).toBeUndefined();
  });
});

// =============================================================================
// 4. seatSummary renders the seat strip correctly.
// =============================================================================
describe("seatSummary renders Guest + Unassigned in the right slots", () => {
  it("capacity=4, partySize=2 → [HOST, Guest, Unassigned, Unassigned]", async () => {
    const ctx = await bootstrapLounge("summary-mix", { capacity: 4 });
    const m = await makeMember(ctx.club.id, { firstName: "Margaret", lastName: "Holloway" });
    await db().member.update({ where: { id: m.id }, data: { memberNumber: "0613" } });

    const { checkId } = await seatTable(ctx.admin, ctx.club.id, {
      tableId: ctx.table.id, memberNumber: "0613", partySize: 2,
    });
    const summary = await seatSummary(ctx.admin, checkId);
    expect(summary.seats.length).toBe(4);
    expect(summary.seats[0].assignment?.isPrimary).toBe(true);
    expect(summary.seats[0].assignment?.memberId).toBe(m.id);
    expect(summary.seats[1].assignment?.guestName).toBe("Guest");
    expect(summary.seats[1].assignment?.memberId).toBeNull();
    // Seats 3 + 4 render as "Unassigned" — no member, no guestName.
    // seatSummary fills the row with a null-everywhere assignment shell
    // rather than a literal null, so check the field values.
    expect(summary.seats[2].assignment?.memberId).toBeNull();
    expect(summary.seats[2].assignment?.guestName).toBeNull();
    expect(summary.seats[3].assignment?.memberId).toBeNull();
    expect(summary.seats[3].assignment?.guestName).toBeNull();
  });
});

// =============================================================================
// 5. partySize > table.capacity throws.
// =============================================================================
describe("seatTable rejects partySize > table.capacity", () => {
  it("capacity=4, partySize=6 → ConflictError", async () => {
    const ctx = await bootstrapLounge("over-cap", { capacity: 4 });
    const m = await makeMember(ctx.club.id);
    await db().member.update({ where: { id: m.id }, data: { memberNumber: "1310" } });

    await expect(
      seatTable(ctx.admin, ctx.club.id, {
        tableId: ctx.table.id, memberNumber: "1310", partySize: 6,
      }),
    ).rejects.toThrow(/cannot exceed this table's capacity/i);
  });

  it("partySize === capacity is allowed (boundary)", async () => {
    const ctx = await bootstrapLounge("at-cap", { capacity: 4 });
    const m = await makeMember(ctx.club.id);
    await db().member.update({ where: { id: m.id }, data: { memberNumber: "1310" } });

    const { checkId } = await seatTable(ctx.admin, ctx.club.id, {
      tableId: ctx.table.id, memberNumber: "1310", partySize: 4,
    });
    const seats = await db().pOSCheckSeat.findMany({ where: { posCheckId: checkId } });
    expect(seats.length).toBe(4);
  });
});

// =============================================================================
// 6. Guest seats can be reassigned to a member.
// =============================================================================
describe("Guest seats can be reassigned to a real member", () => {
  it("assignCheckSeat on a Guest seat overwrites guestName with memberId", async () => {
    const ctx = await bootstrapLounge("guest-to-member");
    const host = await makeMember(ctx.club.id, { firstName: "Owen", lastName: "Beauchamp" });
    await db().member.update({ where: { id: host.id }, data: { memberNumber: "1310" } });
    const second = await makeMember(ctx.club.id, { firstName: "Henry", lastName: "Wexford" });
    await db().member.update({ where: { id: second.id }, data: { memberNumber: "0420" } });

    const { checkId } = await seatTable(ctx.admin, ctx.club.id, {
      tableId: ctx.table.id, memberNumber: "1310", partySize: 2,
    });
    // Seat 2 should currently be a Guest placeholder.
    const before = await db().pOSCheckSeat.findFirst({
      where: { posCheckId: checkId, seatNumber: 2 },
    });
    expect(before?.guestName).toBe("Guest");
    expect(before?.memberId).toBeNull();

    await assignCheckSeat(ctx.admin, checkId, {
      seatNumber: 2, memberNumber: "0420",
    });
    const after = await db().pOSCheckSeat.findFirst({
      where: { posCheckId: checkId, seatNumber: 2 },
    });
    expect(after?.memberId).toBe(second.id);
    expect(after?.guestName).toBeNull();
  });
});

// =============================================================================
// 7. partySize=1 → only Seat 1 is created (no guest rows).
// =============================================================================
describe("seatTable — partySize=1 makes no guest rows", () => {
  it("only Seat 1 exists when partySize=1", async () => {
    const ctx = await bootstrapLounge("solo");
    const m = await makeMember(ctx.club.id);
    await db().member.update({ where: { id: m.id }, data: { memberNumber: "1310" } });

    const { checkId } = await seatTable(ctx.admin, ctx.club.id, {
      tableId: ctx.table.id, memberNumber: "1310", partySize: 1,
    });
    const seats = await db().pOSCheckSeat.findMany({ where: { posCheckId: checkId } });
    expect(seats.length).toBe(1);
    expect(seats[0].seatNumber).toBe(1);
  });
});

// =============================================================================
// 8. partySize omitted → only Seat 1 is created (backwards compat).
// =============================================================================
describe("seatTable — partySize omitted is backwards-compatible", () => {
  it("no partySize → only Seat 1", async () => {
    const ctx = await bootstrapLounge("no-party");
    const m = await makeMember(ctx.club.id);
    await db().member.update({ where: { id: m.id }, data: { memberNumber: "1310" } });

    const { checkId } = await seatTable(ctx.admin, ctx.club.id, {
      tableId: ctx.table.id, memberNumber: "1310",
    });
    const seats = await db().pOSCheckSeat.findMany({ where: { posCheckId: checkId } });
    expect(seats.length).toBe(1);
    expect(seats[0].seatNumber).toBe(1);
  });
});

// =============================================================================
// 9. ensureCheckForReservation auto-populates guest seats too.
// =============================================================================
describe("ensureCheckForReservation auto-populates guest seats from reservation partySize", () => {
  it("reservation.partySize=3 → Seat 1 (member) + Seats 2/3 (Guest)", async () => {
    const ctx = await bootstrapLounge("res-party-3", { capacity: 6 });
    const m = await makeMember(ctx.club.id, { firstName: "Margaret", lastName: "Holloway" });
    await db().member.update({ where: { id: m.id }, data: { memberNumber: "0613" } });

    const reservation = await db().diningReservation.create({
      data: {
        clubId: ctx.club.id,
        diningAreaId: ctx.table.diningAreaId,
        tableId: ctx.table.id,
        memberId: m.id,
        partySize: 3,
        reservationDate: new Date(),
        startTime: new Date(Date.now() - 60_000),
        expectedEndTime: new Date(Date.now() + 60 * 60_000),
        // ensureCheckForReservation requires the reservation to already
        // be SEATED — the floor-map "Seat now" action flips it before
        // calling this. Pre-seat for the test.
        status: "SEATED",
        guestName: "Margaret Holloway",
      },
    });

    const { checkId } = await ensureCheckForReservation(ctx.admin, reservation.id);
    const seats = await db().pOSCheckSeat.findMany({
      where: { posCheckId: checkId },
      orderBy: { seatNumber: "asc" },
    });
    expect(seats.map((s) => s.seatNumber)).toEqual([1, 2, 3]);
    expect(seats[0].memberId).toBe(m.id);
    expect(seats[0].isPrimary).toBe(true);
    expect(seats[1].guestName).toBe("Guest");
    expect(seats[2].guestName).toBe("Guest");
  });
});

// =============================================================================
// 10. SeatStrip label rule — plain "Guest" (no "(guest)" suffix).
// =============================================================================
describe("SeatStrip name label uses plain 'Guest' for placeholder guest seats (UI source contract)", () => {
  it("SeatPOS.tsx collapses guestName==='Guest' to 'Guest' (no suffix)", () => {
    const src = fs.readFileSync(
      path.resolve(process.cwd(), "src/app/app/admin/ops/pos/lounge/table/[checkId]/SeatPOS.tsx"),
      "utf8",
    );
    // The label must special-case guestName === "Guest" → "Guest".
    expect(src).toMatch(/a\.guestName === "Guest" \? "Guest"/);
  });
});

// =============================================================================
// 11. SelfSeatingForm shows table capacity (UI source contract).
// =============================================================================
describe("SelfSeatingForm exposes table capacity (UI source contract)", () => {
  it("FloorMap.tsx renders 'Capacity:' near the party-size input", () => {
    const src = fs.readFileSync(
      path.resolve(process.cwd(), "src/app/app/admin/hospitality/reservations/floor/FloorMap.tsx"),
      "utf8",
    );
    expect(src).toMatch(/Capacity:\s*\{capacity\}/);
  });

  it("Party-size input is bounded by capacity, not a hard-coded 24", () => {
    const src = fs.readFileSync(
      path.resolve(process.cwd(), "src/app/app/admin/hospitality/reservations/floor/FloorMap.tsx"),
      "utf8",
    );
    expect(src).toMatch(/max=\{capacity\}/);
  });
});

// =============================================================================
// 12. DiningTable.status flips to SEATED after the seat-creation block.
// =============================================================================
describe("seatTable still flips DiningTable.status to SEATED", () => {
  it("table is SEATED after seatTable resolves", async () => {
    const ctx = await bootstrapLounge("status-flip");
    const m = await makeMember(ctx.club.id);
    await db().member.update({ where: { id: m.id }, data: { memberNumber: "1310" } });

    await seatTable(ctx.admin, ctx.club.id, {
      tableId: ctx.table.id, memberNumber: "1310", partySize: 2,
    });
    const t = await db().diningTable.findUnique({ where: { id: ctx.table.id } });
    expect(t?.status).toBe("SEATED");
  });
});

// =============================================================================
// 13. Capacity check runs before any rows are written (no partial seat state).
// =============================================================================
describe("Capacity overflow leaves no orphan rows", () => {
  it("rejected over-capacity seatTable creates zero POSCheckSeat rows", async () => {
    const ctx = await bootstrapLounge("no-orphans", { capacity: 4 });
    const m = await makeMember(ctx.club.id);
    await db().member.update({ where: { id: m.id }, data: { memberNumber: "1310" } });

    await expect(
      seatTable(ctx.admin, ctx.club.id, {
        tableId: ctx.table.id, memberNumber: "1310", partySize: 6,
      }),
    ).rejects.toThrow();
    const seats = await db().pOSCheckSeat.findMany({
      where: { clubId: ctx.club.id },
    });
    expect(seats.length).toBe(0);
    // Table status stays AVAILABLE.
    const t = await db().diningTable.findUnique({ where: { id: ctx.table.id } });
    expect(t?.status).toBe("AVAILABLE");
  });
});

// =============================================================================
// 14. seatTable + addCheckLines + settle still works with the new guest rows.
// =============================================================================
describe("Settle workflow unaffected by guest seat auto-population", () => {
  it("seat (partySize=2) + add line on Seat 1 + settle Seat 1 succeeds", async () => {
    const ctx = await bootstrapLounge("settle-after");
    const m = await makeMember(ctx.club.id, { firstName: "Margaret", lastName: "Holloway" });
    await db().member.update({ where: { id: m.id }, data: { memberNumber: "0613" } });
    const cat = await db().pOSMenuCategory.create({
      data: {
        clubId: ctx.club.id,
        locationId: (await db().pOSLocation.findFirst({ where: { clubId: ctx.club.id } }))!.id,
        name: "Mains", sortOrder: 1, isActive: true, chitDestination: "KITCHEN",
      },
    });
    const burger = await db().pOSMenuItem.create({
      data: { clubId: ctx.club.id, categoryId: cat.id, name: "Burger", price: 18, taxable: true, isActive: true },
    });
    const { addCheckLines } = await import("@/lib/pos/checks");
    const { settleCheckBySeats } = await import("@/lib/pos/seat-checks");
    const { checkId } = await seatTable(ctx.admin, ctx.club.id, {
      tableId: ctx.table.id, memberNumber: "0613", partySize: 2,
    });
    await addCheckLines(ctx.admin, checkId, {
      items: [{ menuItemId: burger.id, quantity: 1, seatNumber: 1 }],
    });
    const r = await settleCheckBySeats(ctx.admin, checkId, {
      groups: [{
        label: "Host", seatNumbers: [1],
        paymentMethod: "MEMBER_ACCOUNT", memberId: m.id,
      }],
      allowUnsentLines: true,
    });
    expect(r.check.status).toBe("CLOSED");
    // Guest seat in slot 2 must be untouched.
    const seat2 = await db().pOSCheckSeat.findFirst({
      where: { posCheckId: checkId, seatNumber: 2 },
    });
    expect(seat2?.guestName).toBe("Guest");
  });
});
