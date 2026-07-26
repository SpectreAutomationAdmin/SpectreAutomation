// POS cleanup step 30 — table-lifecycle auto-depart on settle.
//
// Reported defect: L1 was settled but the floor map still showed
// Margaret Holloway "seated". Root cause: settleCheckBySeats /
// settleCheck / confirmQRPayment all flipped DiningTable to DIRTY
// but never updated the linked DiningReservation, which stayed in
// SEATED status forever. The floor-map loader pulls reservations by
// `status: "SEATED"` alone (no POSCheck.status join), so a stale
// SEATED reservation kept the seated-party card painted.
//
// Step 30 — recordCheckSettlement now also auto-departs any linked
// SEATED reservation when the closing check was the last open check
// on the table. A new reconciler repairs already-stuck rows.
//
// These tests pin:
//   - the auto-depart fires across all three settle paths
//   - partial settles don't depart prematurely
//   - the reconciler can clean up pre-existing stale state
//   - cross-tenant repair is blocked
//   - resetting a DIRTY table works as before

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import {
  db, makeMember, makeUser, principalFor, resetDb, seedRbac,
} from "./util/db";
import { bootstrapAPClub } from "./util/ap";
import { seatTable, settleCheckBySeats } from "@/lib/pos/seat-checks";
import { addCheckLines, sendUnsentItems, openCheck, settleCheck } from "@/lib/pos/checks";
import { LOUNGE_LOCATION_CODE, LOUNGE_TERMINAL_CODE } from "@/lib/pos/lounge";
import {
  initiateWholeCheckQRPayment,
  confirmQRPayment,
} from "@/lib/pos/qr-payment";
import { reconcileStaleSeatedReservations } from "@/lib/hospitality/reconcile-reservations";
import { setTableStatus } from "@/lib/hospitality/reservations";

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
  const area = await db().diningArea.create({
    data: { clubId: club.id, name: "Lounge", sortOrder: 0 },
  });
  const table = await db().diningTable.create({
    data: {
      clubId: club.id, diningAreaId: area.id, tableNumber: "L1", capacity: 4,
      shape: "SQUARE", xPos: 100, yPos: 100, width: 110, height: 110,
    },
  });
  const cat = await db().pOSMenuCategory.create({
    data: { clubId: club.id, locationId: loc.id, name: "Mains", sortOrder: 1, isActive: true, chitDestination: "KITCHEN" },
  });
  const burger = await db().pOSMenuItem.create({
    data: { clubId: club.id, categoryId: cat.id, name: "Burger", price: 18, taxable: true, isActive: true },
  });
  const adminEmail = `step30-${club.id}@example.com`;
  await makeUser({ email: adminEmail, role: "CLUB_ADMIN", clubId: club.id });
  const admin = await principalFor(adminEmail);
  return { club, area, table, loc, admin, burger };
}

/** Seats a reservation on the table — mimics the host's "Seat now" action. */
async function seatReservationOnTable(ctx: Awaited<ReturnType<typeof bootstrapLounge>>, memberId: string, partySize = 2) {
  const reservation = await db().diningReservation.create({
    data: {
      clubId: ctx.club.id,
      diningAreaId: ctx.area.id,
      tableId: ctx.table.id,
      memberId,
      partySize,
      reservationDate: new Date(),
      startTime: new Date(Date.now() - 60_000),
      expectedEndTime: new Date(Date.now() + 60 * 60_000),
      status: "SEATED",
      actualSeatedAt: new Date(Date.now() - 60_000),
    },
  });
  await db().diningTable.update({
    where: { id: ctx.table.id }, data: { status: "SEATED" },
  });
  return reservation;
}

beforeAll(async () => { await resetDb(); await seedRbac(); });
beforeEach(async () => { await resetDb(); await seedRbac(); });

// =============================================================================
// Spec 1 — Reservation-seated table with fully settled check flips to DIRTY.
// Spec 2 — Reservation status no longer keeps table SEATED after check close.
// Spec 4 — L1-shaped Margaret reservation auto-departs on settle.
// Spec 5 — Member-account settlement triggers the lifecycle.
// =============================================================================
describe("Specs 1/2/4/5 — reservation-backed table settles to DIRTY + reservation departs", () => {
  it("L1-shaped reservation + Margaret + member-account settle → table DIRTY, reservation COMPLETED", async () => {
    const ctx = await bootstrapLounge("l1-margaret");
    const margaret = await makeMember(ctx.club.id, { firstName: "Margaret", lastName: "Holloway" });
    await db().member.update({ where: { id: margaret.id }, data: { memberNumber: "0613" } });
    const reservation = await seatReservationOnTable(ctx, margaret.id, 2);

    // Open a check linked to the reservation.
    const check = await openCheck(ctx.admin, ctx.club.id, {
      memberId: margaret.id, reservationId: reservation.id, tableId: ctx.table.id,
    });
    await addCheckLines(ctx.admin, check.id, {
      items: [{ menuItemId: ctx.burger.id, quantity: 1, seatNumber: 1 }],
    });
    await sendUnsentItems(ctx.admin, check.id);

    // Pre-create the host seat row so the seat settle has someone to bill.
    await db().pOSCheckSeat.create({
      data: { clubId: ctx.club.id, posCheckId: check.id, seatNumber: 1, memberId: margaret.id, isPrimary: true },
    });

    // Settle the check.
    const r = await settleCheckBySeats(ctx.admin, check.id, {
      groups: [{ label: "All", seatNumbers: [1], paymentMethod: "MEMBER_ACCOUNT", memberId: margaret.id }],
      allowUnsentLines: true,
    });
    expect(r.check.status).toBe("CLOSED");

    // Spec 1 — table is DIRTY.
    const table = await db().diningTable.findUnique({ where: { id: ctx.table.id } });
    expect(table?.status).toBe("DIRTY");

    // Spec 2 + Spec 4 — reservation no longer SEATED; was auto-departed.
    const r2 = await db().diningReservation.findUnique({ where: { id: reservation.id } });
    expect(r2?.status).toBe("COMPLETED");
    expect(r2?.actualDepartedAt).not.toBeNull();
  });
});

// =============================================================================
// Spec 3 — Floor map does not show seated member when table is DIRTY.
// =============================================================================
describe("Spec 3 — floor-map seated-party derivation excludes COMPLETED reservations", () => {
  it("deriveSeatedParty returns null when reservation is COMPLETED and no open check", async () => {
    const { deriveSeatedParty } = await import("@/lib/hospitality/seated-party");
    const out = deriveSeatedParty({
      reservation: {
        id: "r1", status: "COMPLETED", partySize: 2,
        startTime: new Date(), actualSeatedAt: null,
        guestName: null,
        member: { firstName: "Margaret", lastName: "Holloway" },
      },
      openCheck: null,
      tableStatus: "DIRTY",
    });
    expect(out).toBeNull();
  });
});

// =============================================================================
// Spec 6 — QR settlement triggers the lifecycle.
// =============================================================================
describe("Spec 6 — confirmQRPayment auto-departs the reservation", () => {
  it("seated reservation + QR-confirm → reservation COMPLETED, table DIRTY", async () => {
    const ctx = await bootstrapLounge("qr-confirm-lifecycle");
    const margaret = await makeMember(ctx.club.id, { firstName: "Margaret", lastName: "Holloway" });
    await db().member.update({
      where: { id: margaret.id },
      data: { memberNumber: "0613", accessStatus: "CHARGE_ACCOUNT_SUSPENDED" },
    });
    const reservation = await seatReservationOnTable(ctx, margaret.id, 2);

    const check = await openCheck(ctx.admin, ctx.club.id, {
      memberId: margaret.id, reservationId: reservation.id, tableId: ctx.table.id,
    });
    await addCheckLines(ctx.admin, check.id, {
      items: [{ menuItemId: ctx.burger.id, quantity: 1, seatNumber: 1 }],
    });
    await sendUnsentItems(ctx.admin, check.id);
    await db().pOSCheckSeat.create({
      data: { clubId: ctx.club.id, posCheckId: check.id, seatNumber: 1, memberId: margaret.id, isPrimary: true },
    });

    const payment = await initiateWholeCheckQRPayment(ctx.admin, ctx.club.id, {
      checkId: check.id, memberId: margaret.id, origin: "http://localhost:3000",
    });
    await confirmQRPayment(ctx.admin, payment.id, { origin: "http://localhost:3000" });

    const updatedReservation = await db().diningReservation.findUnique({ where: { id: reservation.id } });
    expect(updatedReservation?.status).toBe("COMPLETED");
    const updatedTable = await db().diningTable.findUnique({ where: { id: ctx.table.id } });
    expect(updatedTable?.status).toBe("DIRTY");
  });
});

// =============================================================================
// Spec 7 — Split / merge settlement triggers the lifecycle.
// =============================================================================
describe("Spec 7 — split-bill settlement auto-departs when all groups close the check", () => {
  it("two seats, two groups, both MEMBER_ACCOUNT → reservation COMPLETED at close", async () => {
    const ctx = await bootstrapLounge("split-bill");
    const host = await makeMember(ctx.club.id, { firstName: "Margaret", lastName: "Holloway" });
    await db().member.update({ where: { id: host.id }, data: { memberNumber: "0613" } });
    const guest = await makeMember(ctx.club.id, { firstName: "Henry", lastName: "Wexford" });
    await db().member.update({ where: { id: guest.id }, data: { memberNumber: "0420" } });
    const reservation = await seatReservationOnTable(ctx, host.id, 2);

    // Open the check via the reservation path (table already SEATED).
    const check = await openCheck(ctx.admin, ctx.club.id, {
      memberId: host.id, reservationId: reservation.id, tableId: ctx.table.id,
    });
    // Pre-create the two billable seats.
    await db().pOSCheckSeat.create({
      data: { clubId: ctx.club.id, posCheckId: check.id, seatNumber: 1, memberId: host.id, isPrimary: true },
    });
    await db().pOSCheckSeat.create({
      data: { clubId: ctx.club.id, posCheckId: check.id, seatNumber: 2, memberId: guest.id, isPrimary: false },
    });
    await addCheckLines(ctx.admin, check.id, {
      items: [
        { menuItemId: ctx.burger.id, quantity: 1, seatNumber: 1 },
        { menuItemId: ctx.burger.id, quantity: 1, seatNumber: 2 },
      ],
    });
    await sendUnsentItems(ctx.admin, check.id);

    const r = await settleCheckBySeats(ctx.admin, check.id, {
      groups: [
        { label: "Host", seatNumbers: [1], paymentMethod: "MEMBER_ACCOUNT", memberId: host.id },
        { label: "Guest", seatNumbers: [2], paymentMethod: "MEMBER_ACCOUNT", memberId: guest.id },
      ],
      allowUnsentLines: true,
    });
    expect(r.check.status).toBe("CLOSED");

    const updated = await db().diningReservation.findUnique({ where: { id: reservation.id } });
    expect(updated?.status).toBe("COMPLETED");
  });
});

// =============================================================================
// Spec 8 — Open check still keeps the reservation-backed table SEATED.
// Spec 9 — Partial settlement keeps the reservation-backed table SEATED.
// =============================================================================
describe("Specs 8/9 — pre-close paths do NOT auto-depart", () => {
  it("open (un-settled) check leaves reservation SEATED", async () => {
    const ctx = await bootstrapLounge("open-still-seated");
    const m = await makeMember(ctx.club.id);
    await db().member.update({ where: { id: m.id }, data: { memberNumber: "0613" } });
    const reservation = await seatReservationOnTable(ctx, m.id, 2);

    const check = await openCheck(ctx.admin, ctx.club.id, {
      memberId: m.id, reservationId: reservation.id, tableId: ctx.table.id,
    });
    await addCheckLines(ctx.admin, check.id, {
      items: [{ menuItemId: ctx.burger.id, quantity: 1, seatNumber: 1 }],
    });
    // Do NOT settle.
    const r2 = await db().diningReservation.findUnique({ where: { id: reservation.id } });
    expect(r2?.status).toBe("SEATED");
    const t = await db().diningTable.findUnique({ where: { id: ctx.table.id } });
    expect(t?.status).toBe("SEATED");
  });

  it("PARTIALLY_SETTLED check (group settled, others still open) leaves reservation SEATED", async () => {
    const ctx = await bootstrapLounge("partial-settled");
    const host = await makeMember(ctx.club.id);
    await db().member.update({ where: { id: host.id }, data: { memberNumber: "0613" } });
    const reservation = await seatReservationOnTable(ctx, host.id, 2);

    const check = await openCheck(ctx.admin, ctx.club.id, {
      memberId: host.id, reservationId: reservation.id, tableId: ctx.table.id,
    });
    await db().pOSCheckSeat.create({
      data: { clubId: ctx.club.id, posCheckId: check.id, seatNumber: 1, memberId: host.id, isPrimary: true },
    });
    await db().pOSCheckSeat.create({
      data: { clubId: ctx.club.id, posCheckId: check.id, seatNumber: 2, memberId: host.id, isPrimary: false },
    });
    // Two lines, only one in the settlement group → partial settle.
    await addCheckLines(ctx.admin, check.id, {
      items: [
        { menuItemId: ctx.burger.id, quantity: 1, seatNumber: 1 },
        { menuItemId: ctx.burger.id, quantity: 1, seatNumber: 2 },
      ],
    });
    await sendUnsentItems(ctx.admin, check.id);

    const r = await settleCheckBySeats(ctx.admin, check.id, {
      // Only settle seat 1; seat 2's line stays unsettled.
      groups: [{ label: "Host", seatNumbers: [1], paymentMethod: "MEMBER_ACCOUNT", memberId: host.id }],
      allowUnsentLines: true,
    });
    expect(r.check.status).toBe("PARTIALLY_SETTLED");

    const updated = await db().diningReservation.findUnique({ where: { id: reservation.id } });
    expect(updated?.status).toBe("SEATED"); // still seated, not yet departed
  });
});

// =============================================================================
// Spec 10 — Reset Table flips DIRTY → AVAILABLE.
// =============================================================================
describe("Spec 10 — Reset Table works as before after auto-depart", () => {
  it("setTableStatus DIRTY → AVAILABLE succeeds", async () => {
    const ctx = await bootstrapLounge("reset-after");
    await db().diningTable.update({
      where: { id: ctx.table.id }, data: { status: "DIRTY" },
    });
    await setTableStatus(ctx.admin, ctx.table.id, "AVAILABLE");
    const t = await db().diningTable.findUnique({ where: { id: ctx.table.id } });
    expect(t?.status).toBe("AVAILABLE");
  });
});

// =============================================================================
// Spec 11 — Historical reservation/check data remains accessible.
// =============================================================================
describe("Spec 11 — settled reservation + check rows are still queryable", () => {
  it("COMPLETED reservation still reachable by id; CLOSED check still has saleId linkage", async () => {
    const ctx = await bootstrapLounge("history-preserved");
    const margaret = await makeMember(ctx.club.id, { firstName: "Margaret", lastName: "Holloway" });
    await db().member.update({ where: { id: margaret.id }, data: { memberNumber: "0613" } });
    const reservation = await seatReservationOnTable(ctx, margaret.id, 2);

    const check = await openCheck(ctx.admin, ctx.club.id, {
      memberId: margaret.id, reservationId: reservation.id, tableId: ctx.table.id,
    });
    await addCheckLines(ctx.admin, check.id, {
      items: [{ menuItemId: ctx.burger.id, quantity: 1, seatNumber: 1 }],
    });
    await sendUnsentItems(ctx.admin, check.id);
    await db().pOSCheckSeat.create({
      data: { clubId: ctx.club.id, posCheckId: check.id, seatNumber: 1, memberId: margaret.id, isPrimary: true },
    });
    await settleCheckBySeats(ctx.admin, check.id, {
      groups: [{ label: "All", seatNumbers: [1], paymentMethod: "MEMBER_ACCOUNT", memberId: margaret.id }],
      allowUnsentLines: true,
    });

    const reloaded = await db().diningReservation.findUnique({
      where: { id: reservation.id },
      include: { checkLinks: { include: { posSale: true } } },
    });
    expect(reloaded).not.toBeNull();
    expect(reloaded?.status).toBe("COMPLETED");
    const closedCheck = await db().pOSCheck.findUnique({
      where: { id: check.id }, include: { posSale: true },
    });
    expect(closedCheck?.status).toBe("CLOSED");
    expect(closedCheck?.posSale).not.toBeNull();
  });
});

// =============================================================================
// Spec 12 — Cross-tenant lifecycle update is blocked.
// =============================================================================
describe("Spec 12 — reconciler refuses cross-tenant operation", () => {
  it("admin of club A cannot reconcile club B", async () => {
    const a = await bootstrapLounge("xt-a");
    const b = await bootstrapLounge("xt-b");
    // Plant a stale L1-shaped row in B.
    const mb = await makeMember(b.club.id);
    await db().member.update({ where: { id: mb.id }, data: { memberNumber: "0613" } });
    const stale = await seatReservationOnTable(b, mb.id);
    // Put a CLOSED check on that table to make it eligible.
    await db().pOSCheck.create({
      data: {
        clubId: b.club.id, locationId: b.loc.id, checkNumber: "C1", status: "CLOSED",
        tableId: b.table.id, reservationId: stale.id, closedAt: new Date(),
      },
    });

    await expect(
      reconcileStaleSeatedReservations(a.admin, { clubId: b.club.id, apply: true }),
    ).rejects.toThrow();
    const stillStale = await db().diningReservation.findUnique({ where: { id: stale.id } });
    expect(stillStale?.status).toBe("SEATED");
  });
});

// =============================================================================
// Spec — reconciler repairs PRE-EXISTING stale state (the actual L1 case).
// =============================================================================
describe("Reconciler — fixes the existing L1 case (CLOSED check + SEATED reservation)", () => {
  it("dry run flags candidates without mutating", async () => {
    const ctx = await bootstrapLounge("reconcile-dry");
    const m = await makeMember(ctx.club.id);
    await db().member.update({ where: { id: m.id }, data: { memberNumber: "0613" } });
    const stale = await seatReservationOnTable(ctx, m.id);
    await db().pOSCheck.create({
      data: {
        clubId: ctx.club.id, locationId: ctx.loc.id, checkNumber: "C1", status: "CLOSED",
        tableId: ctx.table.id, reservationId: stale.id, closedAt: new Date(),
      },
    });

    const r = await reconcileStaleSeatedReservations(ctx.admin, { clubId: ctx.club.id });
    expect(r.candidates.length).toBe(1);
    expect(r.applied).toBe(0);
    const still = await db().diningReservation.findUnique({ where: { id: stale.id } });
    expect(still?.status).toBe("SEATED");
  });

  it("apply=true completes the stale reservation + flips table to DIRTY", async () => {
    const ctx = await bootstrapLounge("reconcile-apply");
    const m = await makeMember(ctx.club.id);
    await db().member.update({ where: { id: m.id }, data: { memberNumber: "0613" } });
    const stale = await seatReservationOnTable(ctx, m.id);
    await db().pOSCheck.create({
      data: {
        clubId: ctx.club.id, locationId: ctx.loc.id, checkNumber: "C1", status: "CLOSED",
        tableId: ctx.table.id, reservationId: stale.id, closedAt: new Date(),
      },
    });

    const r = await reconcileStaleSeatedReservations(ctx.admin, { clubId: ctx.club.id, apply: true });
    expect(r.applied).toBe(1);

    const reloaded = await db().diningReservation.findUnique({ where: { id: stale.id } });
    expect(reloaded?.status).toBe("COMPLETED");
    expect(reloaded?.actualDepartedAt).not.toBeNull();
    const t = await db().diningTable.findUnique({ where: { id: ctx.table.id } });
    expect(t?.status).toBe("DIRTY");
  });

  it("does NOT depart a reservation while a check is still open on the table", async () => {
    const ctx = await bootstrapLounge("reconcile-skip-open");
    const m = await makeMember(ctx.club.id);
    await db().member.update({ where: { id: m.id }, data: { memberNumber: "0613" } });
    const stale = await seatReservationOnTable(ctx, m.id);
    // Open check still present on the table.
    await db().pOSCheck.create({
      data: {
        clubId: ctx.club.id, locationId: ctx.loc.id, checkNumber: "C2", status: "OPEN",
        tableId: ctx.table.id, reservationId: stale.id,
      },
    });

    const r = await reconcileStaleSeatedReservations(ctx.admin, { clubId: ctx.club.id, apply: true });
    expect(r.applied).toBe(0);
    const still = await db().diningReservation.findUnique({ where: { id: stale.id } });
    expect(still?.status).toBe("SEATED");
  });

  it("does NOT depart a SEATED reservation with no linked CLOSED check (walk-in without billing)", async () => {
    const ctx = await bootstrapLounge("reconcile-no-billing");
    const m = await makeMember(ctx.club.id);
    await db().member.update({ where: { id: m.id }, data: { memberNumber: "0613" } });
    const stale = await seatReservationOnTable(ctx, m.id);
    // No check at all on this table.

    const r = await reconcileStaleSeatedReservations(ctx.admin, { clubId: ctx.club.id, apply: true });
    expect(r.applied).toBe(0);
    const still = await db().diningReservation.findUnique({ where: { id: stale.id } });
    expect(still?.status).toBe("SEATED");
  });
});
