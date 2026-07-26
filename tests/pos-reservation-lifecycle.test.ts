// POS cleanup step 15 — reservation/table lifecycle correctness.
//
// Pins the contract:
//   - Future CONFIRMED reservation → table shows RESERVED on the map
//     and the reservation appears on the Reservations page query.
//   - Seating a reservation flips table SEATED, settling the check
//     flips it DIRTY, resetting flips it AVAILABLE.
//   - Stale (past + 2-hour-grace) CONFIRMED / REQUESTED / SEATED no
//     longer block POS reconcile, AND they're surfaced on the
//     Reservations page's "Needs attention" query so admins can clear
//     them.
//   - Cross-tenant isolation holds.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { db, makeMember, makeUser, principalFor, resetDb, seedRbac } from "./util/db";
import { bootstrapAPClub } from "./util/ap";
import {
  seatReservation,
  setTableStatus,
  isReservationActive,
  isReservationStale,
  RESERVATION_GRACE_MINUTES,
} from "@/lib/hospitality/reservations";
import { reconcileSettledTablesToDirty } from "@/lib/pos/reconcile-tables";
import { seatTable, settleCheckBySeats } from "@/lib/pos/seat-checks";
import { addCheckLines } from "@/lib/pos/checks";
import { LOUNGE_LOCATION_CODE, LOUNGE_TERMINAL_CODE } from "@/lib/pos/lounge";

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
    data: { clubId: club.id, categoryId: cat.id, name: "Burger", price: 18, taxable: true, isActive: true },
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
  const host = await makeMember(club.id);
  const adminEmail = `lifecycle-${club.id}@example.com`;
  await makeUser({ email: adminEmail, role: "CLUB_ADMIN", clubId: club.id });
  const admin = await principalFor(adminEmail);
  return { club, admin, host, area, table, burger };
}

async function makeReservation(ctx: Awaited<ReturnType<typeof bootstrapLounge>>, opts: {
  status: string;
  startMinutesFromNow: number;
  durationMinutes?: number;
}) {
  const start = new Date(Date.now() + opts.startMinutesFromNow * 60_000);
  const dur = opts.durationMinutes ?? 90;
  const expectedEnd = new Date(start.getTime() + dur * 60_000);
  return db().diningReservation.create({
    data: {
      clubId: ctx.club.id,
      memberId: ctx.host.id,
      diningAreaId: ctx.area.id,
      tableId: ctx.table.id,
      partySize: 2,
      reservationDate: start,
      startTime: start,
      expectedEndTime: expectedEnd,
      status: opts.status,
      reservationType: "MEMBER",
    },
  });
}

beforeAll(async () => { await resetDb(); await seedRbac(); });
beforeEach(async () => { await resetDb(); await seedRbac(); });

// =============================================================================
// 1. Future CONFIRMED → table marked RESERVED by floor-map status mapping.
//    (Floor map does the mapping live in resolveDisplayStatus; we re-pin the
//    source-contract here so the rule can't drift.)
// =============================================================================
describe("Future CONFIRMED reservation derives RESERVED on the floor map", () => {
  const floorMapSrc = fs.readFileSync(
    path.resolve(process.cwd(), "src/app/app/admin/hospitality/reservations/floor/FloorMap.tsx"),
    "utf8",
  );

  it("the resolveDisplayStatus helper picks RESERVED for upcoming starts > 30 min", () => {
    expect(floorMapSrc).toMatch(/function resolveDisplayStatus/);
    expect(floorMapSrc).toMatch(/if \(mins > 30\) return "RESERVED";/);
    expect(floorMapSrc).toMatch(/if \(mins <= 30 && mins >= -5\) return "RESERVED_SOON";/);
  });
});

// =============================================================================
// 2. Floor map label for RESERVED is "Reserved" (distinct from SEATED/AVAILABLE).
// =============================================================================
describe("Floor map labels each status distinctly", () => {
  const floorMapSrc = fs.readFileSync(
    path.resolve(process.cwd(), "src/app/app/admin/hospitality/reservations/floor/FloorMap.tsx"),
    "utf8",
  );
  it("STATUS_STYLES carries Reserved + Seated + Needs Reset + Available labels", () => {
    expect(floorMapSrc).toMatch(/AVAILABLE:\s*\{[^}]*label:\s*"Available"/);
    expect(floorMapSrc).toMatch(/SEATED:\s*\{[^}]*label:\s*"Seated"/);
    expect(floorMapSrc).toMatch(/RESERVED:\s*\{[^}]*label:\s*"Reserved"/);
    expect(floorMapSrc).toMatch(/DIRTY:\s*\{[^}]*label:\s*"Needs Reset"/);
  });
});

// =============================================================================
// 3. Future CONFIRMED reservation is visible on the Reservations page's
//    same-day query.
// =============================================================================
describe("Future CONFIRMED reservation appears in same-day query", () => {
  it("listReservationsForDate(today) returns a reservation starting in 2 hours", async () => {
    const ctx = await bootstrapLounge("future-confirmed");
    await makeReservation(ctx, { status: "CONFIRMED", startMinutesFromNow: 120 });
    const { listReservationsForDate } = await import("@/lib/hospitality/reservations");
    const rows = await listReservationsForDate(ctx.admin, ctx.club.id, new Date());
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((r) => r.status === "CONFIRMED")).toBe(true);
  });
});

// =============================================================================
// 4. Seating a CONFIRMED reservation flips the table to SEATED.
// =============================================================================
describe("Seating a reservation flips table SEATED", () => {
  it("RESERVED + seatReservation → table.status = SEATED + reservation.status = SEATED", async () => {
    const ctx = await bootstrapLounge("seat-reservation");
    const r = await makeReservation(ctx, { status: "CONFIRMED", startMinutesFromNow: 10 });
    await seatReservation(ctx.admin, r.id, ctx.table.id);
    const t = await db().diningTable.findUnique({ where: { id: ctx.table.id } });
    const resv = await db().diningReservation.findUnique({ where: { id: r.id } });
    expect(t?.status).toBe("SEATED");
    expect(resv?.status).toBe("SEATED");
  });
});

// =============================================================================
// 5. Settling the seated party's check flips the table to DIRTY.
// =============================================================================
describe("Settling the SEATED party's check flips table DIRTY", () => {
  it("seat → add line → settleCheckBySeats CLOSED → table.status = DIRTY", async () => {
    const ctx = await bootstrapLounge("settle-to-dirty");
    // Use the POS seat-table path which the floor map's "Mark seated"
    // calls today — same end state as a reservation-led seat then
    // open-check, but the bug fix in step 13 lives on this path.
    const { checkId } = await seatTable(ctx.admin, ctx.club.id, {
      tableId: ctx.table.id, memberId: ctx.host.id, partySize: 2,
    });
    await addCheckLines(ctx.admin, checkId, {
      items: [{ menuItemId: ctx.burger.id, quantity: 1, seatNumber: 1 }],
    });
    await settleCheckBySeats(ctx.admin, checkId, {
      groups: [{
        label: "All seats", seatNumbers: [1],
        paymentMethod: "MEMBER_ACCOUNT", memberId: ctx.host.id,
      }],
      allowUnsentLines: true,
    });
    const after = await db().diningTable.findUnique({ where: { id: ctx.table.id } });
    expect(after?.status).toBe("DIRTY");
  });
});

// =============================================================================
// 6. Reset (DIRTY → AVAILABLE).
// =============================================================================
describe("Reset Table flips DIRTY → AVAILABLE", () => {
  it("setTableStatus('AVAILABLE') on a DIRTY table works", async () => {
    const ctx = await bootstrapLounge("reset");
    await db().diningTable.update({ where: { id: ctx.table.id }, data: { status: "DIRTY" } });
    await setTableStatus(ctx.admin, ctx.table.id, "AVAILABLE");
    const after = await db().diningTable.findUnique({ where: { id: ctx.table.id } });
    expect(after?.status).toBe("AVAILABLE");
  });
});

// =============================================================================
// 7. Past stale CONFIRMED reservation is still visible to admin.
// =============================================================================
describe("Stale CONFIRMED reservation is visible to admin (Reservations page query)", () => {
  it("a CONFIRMED reservation past expectedEnd + grace shows up in the stale-active query", async () => {
    const ctx = await bootstrapLounge("stale-visible");
    // 6 days ago — well past the 2-hour grace window.
    await makeReservation(ctx, { status: "CONFIRMED", startMinutesFromNow: -6 * 24 * 60 });
    const stale = await db().diningReservation.findMany({
      where: {
        clubId: ctx.club.id,
        status: { in: ["REQUESTED", "CONFIRMED", "SEATED"] },
        expectedEndTime: { lt: new Date(Date.now() - 120 * 60 * 1000) },
      },
    });
    expect(stale.length).toBeGreaterThan(0);
    expect(stale[0].status).toBe("CONFIRMED");
    // And the helper agrees.
    expect(isReservationStale(stale[0]!)).toBe(true);
  });
});

// =============================================================================
// 8. Stale CONFIRMED no longer blocks reconcile.
// =============================================================================
describe("Stale reservation no longer blocks reconcile (Silver Springs L4 fix)", () => {
  it("SEATED table + only a stale CONFIRMED reservation + no checks → reconcile flips to DIRTY", async () => {
    const ctx = await bootstrapLounge("stale-no-block");
    // Force SEATED but plant a 6-day-old CONFIRMED reservation.
    await db().diningTable.update({ where: { id: ctx.table.id }, data: { status: "SEATED" } });
    await makeReservation(ctx, { status: "CONFIRMED", startMinutesFromNow: -6 * 24 * 60 });
    const result = await reconcileSettledTablesToDirty(ctx.admin, {
      clubId: ctx.club.id, apply: true,
    });
    expect(result.tablesChanged).toBe(1);
    expect(result.tableNumbersChanged).toEqual(["L1"]);
    const t = await db().diningTable.findUnique({ where: { id: ctx.table.id } });
    expect(t?.status).toBe("DIRTY");
  });
});

// =============================================================================
// 9. ACTIVE future reservation still blocks reconcile with the clear reason.
// =============================================================================
describe("Active future reservation still blocks reconcile", () => {
  it("SEATED + future CONFIRMED reservation → skipped with ACTIVE_RESERVATION_PRESENT", async () => {
    const ctx = await bootstrapLounge("active-blocks");
    await db().diningTable.update({ where: { id: ctx.table.id }, data: { status: "SEATED" } });
    await makeReservation(ctx, { status: "CONFIRMED", startMinutesFromNow: 60 });
    const result = await reconcileSettledTablesToDirty(ctx.admin, {
      clubId: ctx.club.id, apply: true,
    });
    expect(result.tablesChanged).toBe(0);
    expect(result.skippedTables[0].reason).toBe("ACTIVE_RESERVATION_PRESENT");
    // Detail string includes the human-readable start timestamp so the
    // operator knows WHICH reservation is blocking.
    expect(result.skippedTables[0].detail).toContain("CONFIRMED");
  });
});

// =============================================================================
// 10. Reconcile repairs a table blocked only by stale reservation when POS
//     check is closed.
// =============================================================================
describe("Reconcile flips SEATED with closed check + stale reservation", () => {
  it("closed check + 6-day-old CONFIRMED reservation → table DIRTY (the Silver Springs L4 case)", async () => {
    const ctx = await bootstrapLounge("closed-check-stale-res");
    // Settle a check (step 13 flip would normally fire — wind it back).
    const { checkId } = await seatTable(ctx.admin, ctx.club.id, {
      tableId: ctx.table.id, memberId: ctx.host.id, partySize: 2,
    });
    await addCheckLines(ctx.admin, checkId, {
      items: [{ menuItemId: ctx.burger.id, quantity: 1, seatNumber: 1 }],
    });
    await settleCheckBySeats(ctx.admin, checkId, {
      groups: [{
        label: "All seats", seatNumbers: [1],
        paymentMethod: "MEMBER_ACCOUNT", memberId: ctx.host.id,
      }],
      allowUnsentLines: true,
    });
    // Force SEATED back (the stale state the bug created), and plant a
    // stale reservation that previously blocked reconcile forever.
    await db().diningTable.update({ where: { id: ctx.table.id }, data: { status: "SEATED" } });
    await makeReservation(ctx, { status: "CONFIRMED", startMinutesFromNow: -6 * 24 * 60 });

    const result = await reconcileSettledTablesToDirty(ctx.admin, {
      clubId: ctx.club.id, apply: true,
    });
    expect(result.tablesChanged).toBe(1);
    const t = await db().diningTable.findUnique({ where: { id: ctx.table.id } });
    expect(t?.status).toBe("DIRTY");
    // Audit row notes the stale reservation count + id list.
    const audit = await db().auditLog.findFirst({
      where: { clubId: ctx.club.id, action: "pos.table.reconcile", entityId: ctx.table.id },
      orderBy: { createdAt: "desc" },
    });
    expect(audit?.afterJson ?? "").toContain("staleReservations");
  });
});

// =============================================================================
// 11. Reservations page surfaces stale active reservations via the same
//     query the page renders.
// =============================================================================
describe("Reservations page query surfaces stale-active", () => {
  it("the page-level filter for stale reservations returns the past-but-CONFIRMED row", async () => {
    const ctx = await bootstrapLounge("page-filter");
    await makeReservation(ctx, { status: "CONFIRMED", startMinutesFromNow: -3 * 24 * 60 });
    await makeReservation(ctx, { status: "CONFIRMED", startMinutesFromNow: 60 }); // future, NOT stale
    await makeReservation(ctx, { status: "COMPLETED", startMinutesFromNow: -7 * 24 * 60 }); // not active
    // Mirror the page's exact where clause.
    const stale = await db().diningReservation.findMany({
      where: {
        clubId: ctx.club.id,
        status: { in: ["REQUESTED", "CONFIRMED", "SEATED"] },
        expectedEndTime: { lt: new Date(Date.now() - 120 * 60 * 1000) },
      },
    });
    expect(stale.length).toBe(1);
    expect(stale[0].status).toBe("CONFIRMED");
  });
});

// =============================================================================
// 12. Cross-tenant table/reservation status mutation blocked.
// =============================================================================
describe("Cross-tenant safety on reconcile + setTableStatus", () => {
  it("admin of club B cannot reconcile club A's tables", async () => {
    const a = await bootstrapLounge("xt-a");
    await db().diningTable.update({ where: { id: a.table.id }, data: { status: "SEATED" } });
    const b = await bootstrapLounge("xt-b");

    const result = await reconcileSettledTablesToDirty(b.admin, {
      clubId: b.club.id, apply: true,
    });
    // B's run sees ONLY B's tables — none stuck.
    expect(result.tablesScanned).toBe(0);
    const aTable = await db().diningTable.findUnique({ where: { id: a.table.id } });
    expect(aTable?.status).toBe("SEATED");
  });

  it("admin of club B cannot setTableStatus on club A's table", async () => {
    const a = await bootstrapLounge("xt-setStatus-a");
    await db().diningTable.update({ where: { id: a.table.id }, data: { status: "DIRTY" } });
    const b = await bootstrapLounge("xt-setStatus-b");
    await expect(
      setTableStatus(b.admin, a.table.id, "AVAILABLE"),
    ).rejects.toThrow();
  });
});

// =============================================================================
// Bonus — the helper itself: active/stale boundaries.
// =============================================================================
describe("isReservationActive / isReservationStale boundaries", () => {
  const now = new Date("2026-05-30T12:00:00Z");

  it("SEATED is always active regardless of time", () => {
    expect(isReservationActive({
      status: "SEATED",
      startTime: new Date("2020-01-01T00:00:00Z"),
      expectedEndTime: new Date("2020-01-01T01:30:00Z"),
    }, now)).toBe(true);
  });

  it("CONFIRMED in the future is active", () => {
    expect(isReservationActive({
      status: "CONFIRMED",
      startTime: new Date("2026-05-30T15:00:00Z"),
      expectedEndTime: new Date("2026-05-30T16:30:00Z"),
    }, now)).toBe(true);
  });

  it("CONFIRMED inside the window is active", () => {
    expect(isReservationActive({
      status: "CONFIRMED",
      startTime: new Date("2026-05-30T11:00:00Z"),
      expectedEndTime: new Date("2026-05-30T12:30:00Z"),
    }, now)).toBe(true);
  });

  it("CONFIRMED past expectedEnd but within grace is active", () => {
    // 30 minutes after expectedEnd, well within the 120-min grace.
    expect(isReservationActive({
      status: "CONFIRMED",
      startTime: new Date("2026-05-30T08:00:00Z"),
      expectedEndTime: new Date("2026-05-30T11:30:00Z"),
    }, now)).toBe(true);
  });

  it("CONFIRMED beyond expectedEnd + grace is STALE", () => {
    // 3 hours after expectedEnd, beyond the 120-min grace.
    expect(isReservationActive({
      status: "CONFIRMED",
      startTime: new Date("2026-05-30T06:00:00Z"),
      expectedEndTime: new Date("2026-05-30T09:00:00Z"),
    }, now)).toBe(false);
    expect(isReservationStale({
      status: "CONFIRMED",
      startTime: new Date("2026-05-30T06:00:00Z"),
      expectedEndTime: new Date("2026-05-30T09:00:00Z"),
    }, now)).toBe(true);
  });

  it("COMPLETED / CANCELLED / NO_SHOW are neither active nor stale", () => {
    const past = {
      startTime: new Date("2020-01-01T00:00:00Z"),
      expectedEndTime: new Date("2020-01-01T01:30:00Z"),
    };
    for (const status of ["COMPLETED", "CANCELLED", "NO_SHOW"]) {
      expect(isReservationActive({ ...past, status }, now)).toBe(false);
      expect(isReservationStale({ ...past, status }, now)).toBe(false);
    }
  });

  it("default grace is 120 minutes", () => {
    expect(RESERVATION_GRACE_MINUTES).toBe(120);
  });
});
