// POS cleanup step 14 — table-status reconciliation.
//
// Pins the safety contract of reconcileSettledTablesToDirty:
//   - flips SEATED + only closed/voided checks → DIRTY
//   - leaves SEATED + any active check / reservation alone
//   - never touches OUT_OF_SERVICE / RESERVED / DIRTY / AVAILABLE
//   - tenant-scoped (cannot touch other clubs)
//   - dry-run is a true no-op (no mutations)
//   - apply writes one audit row per real change
//   - summary surfaces tableNumbersChanged + skip reasons

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { db, makeMember, makeUser, principalFor, resetDb, seedRbac } from "./util/db";
import { bootstrapAPClub } from "./util/ap";
import { reconcileSettledTablesToDirty } from "@/lib/pos/reconcile-tables";
import { seatTable, settleCheckBySeats } from "@/lib/pos/seat-checks";
import { addCheckLines } from "@/lib/pos/checks";
import { LOUNGE_LOCATION_CODE, LOUNGE_TERMINAL_CODE } from "@/lib/pos/lounge";

async function bootstrapLoungeWithTables(name: string) {
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
  // Two tables so we can exercise different states in one run.
  const table1 = await db().diningTable.create({
    data: {
      clubId: club.id, diningAreaId: area.id, tableNumber: "T1", capacity: 4,
      shape: "SQUARE", xPos: 100, yPos: 100, width: 110, height: 110,
    },
  });
  const table2 = await db().diningTable.create({
    data: {
      clubId: club.id, diningAreaId: area.id, tableNumber: "T2", capacity: 2,
      shape: "ROUND", xPos: 250, yPos: 100, width: 80, height: 80,
    },
  });
  const host = await makeMember(club.id);
  const adminEmail = `reconcile-${club.id}@example.com`;
  await makeUser({ email: adminEmail, role: "CLUB_ADMIN", clubId: club.id });
  const admin = await principalFor(adminEmail);
  return { club, admin, host, table1, table2, burger };
}

// Make a fully-settled SEATED table by reaching INTO the DB after settle
// to undo the SEATED → DIRTY flip step 13 added. That's the EXACT stale
// state this service exists to repair.
async function makeStaleSettledTable(ctx: Awaited<ReturnType<typeof bootstrapLoungeWithTables>>, table: { id: string }) {
  const { checkId } = await seatTable(ctx.admin, ctx.club.id, {
    tableId: table.id, memberId: ctx.host.id, partySize: 2,
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
  // Force the stale state — wind the table back to SEATED after settle.
  await db().diningTable.update({
    where: { id: table.id },
    data: { status: "SEATED" },
  });
  return { checkId };
}

beforeAll(async () => { await resetDb(); await seedRbac(); });
beforeEach(async () => { await resetDb(); await seedRbac(); });

// =============================================================================
// 1. Stale SEATED + closed check → DIRTY (apply mode).
// =============================================================================
describe("Reconcile happy path", () => {
  it("flips a stuck SEATED table with only a closed check to DIRTY", async () => {
    const ctx = await bootstrapLoungeWithTables("happy");
    await makeStaleSettledTable(ctx, ctx.table1);
    // Pre-condition sanity.
    const before = await db().diningTable.findUnique({ where: { id: ctx.table1.id } });
    expect(before?.status).toBe("SEATED");

    const result = await reconcileSettledTablesToDirty(ctx.admin, {
      clubId: ctx.club.id, apply: true,
    });
    expect(result.applied).toBe(true);
    expect(result.tablesChanged).toBe(1);
    expect(result.tableNumbersChanged).toEqual(["T1"]);

    const after = await db().diningTable.findUnique({ where: { id: ctx.table1.id } });
    expect(after?.status).toBe("DIRTY");
  });
});

// =============================================================================
// 2. Open check blocks reconcile.
// =============================================================================
describe("Active check blocks reconcile", () => {
  it("a SEATED table with an OPEN check is skipped with ACTIVE_CHECK_PRESENT", async () => {
    const ctx = await bootstrapLoungeWithTables("open-check");
    // Seat the table; do NOT settle (check is OPEN).
    await seatTable(ctx.admin, ctx.club.id, {
      tableId: ctx.table1.id, memberId: ctx.host.id, partySize: 2,
    });
    const result = await reconcileSettledTablesToDirty(ctx.admin, {
      clubId: ctx.club.id, apply: true,
    });
    expect(result.tablesChanged).toBe(0);
    expect(result.skippedTables).toHaveLength(1);
    expect(result.skippedTables[0].tableNumber).toBe("T1");
    expect(result.skippedTables[0].reason).toBe("ACTIVE_CHECK_PRESENT");
    const after = await db().diningTable.findUnique({ where: { id: ctx.table1.id } });
    expect(after?.status).toBe("SEATED");
  });
});

// =============================================================================
// 3. Partially settled check blocks reconcile.
// =============================================================================
describe("Partial settlement blocks reconcile", () => {
  it("a SEATED table whose check is PARTIALLY_SETTLED is skipped", async () => {
    const ctx = await bootstrapLoungeWithTables("partial");
    const { checkId } = await seatTable(ctx.admin, ctx.club.id, {
      tableId: ctx.table1.id, memberId: ctx.host.id, partySize: 2,
    });
    // Two seats settled separately: only seat 1 in this pass so seat
    // 2's line stays unsettled → PARTIALLY_SETTLED.
    await addCheckLines(ctx.admin, checkId, {
      items: [
        { menuItemId: ctx.burger.id, quantity: 1, seatNumber: 1 },
        { menuItemId: ctx.burger.id, quantity: 1, seatNumber: 2 },
      ],
    });
    await settleCheckBySeats(ctx.admin, checkId, {
      groups: [{ label: "Seat 1", seatNumbers: [1], paymentMethod: "MEMBER_ACCOUNT", memberId: ctx.host.id }],
      allowUnsentLines: true,
    });
    const result = await reconcileSettledTablesToDirty(ctx.admin, {
      clubId: ctx.club.id, apply: true,
    });
    expect(result.tablesChanged).toBe(0);
    expect(result.skippedTables[0].reason).toBe("ACTIVE_CHECK_PRESENT");
    const after = await db().diningTable.findUnique({ where: { id: ctx.table1.id } });
    expect(after?.status).toBe("SEATED");
  });
});

// =============================================================================
// 4. OUT_OF_SERVICE never gets touched.
// =============================================================================
describe("OUT_OF_SERVICE is untouched", () => {
  it("an OUT_OF_SERVICE table is not even considered (query filter)", async () => {
    const ctx = await bootstrapLoungeWithTables("oos");
    await db().diningTable.update({
      where: { id: ctx.table1.id },
      data: { status: "OUT_OF_SERVICE" },
    });
    const result = await reconcileSettledTablesToDirty(ctx.admin, {
      clubId: ctx.club.id, apply: true,
    });
    // The reconcile only scans SEATED rows; the OOS table never
    // appears in the scan set.
    expect(result.tablesScanned).toBe(0);
    expect(result.tablesChanged).toBe(0);
    const after = await db().diningTable.findUnique({ where: { id: ctx.table1.id } });
    expect(after?.status).toBe("OUT_OF_SERVICE");
  });
});

// =============================================================================
// 5. Cross-tenant table is invisible.
// =============================================================================
describe("Cross-tenant safety", () => {
  it("running reconcile as club A's admin does not touch club B's stuck table", async () => {
    const a = await bootstrapLoungeWithTables("xt-a");
    const b = await bootstrapLoungeWithTables("xt-b");
    // Make club B's table stale-SEATED.
    await makeStaleSettledTable(b, b.table1);

    // Run reconcile as A's admin against A's club id.
    const result = await reconcileSettledTablesToDirty(a.admin, {
      clubId: a.club.id, apply: true,
    });
    // A's club has zero SEATED tables right now.
    expect(result.tablesScanned).toBe(0);

    // B's stale table is untouched.
    const bTable = await db().diningTable.findUnique({ where: { id: b.table1.id } });
    expect(bTable?.status).toBe("SEATED");
  });
});

// =============================================================================
// 6. Dry-run is a true no-op.
// =============================================================================
describe("Dry-run is a no-op", () => {
  it("apply=false returns the candidate list but does not mutate", async () => {
    const ctx = await bootstrapLoungeWithTables("dry");
    await makeStaleSettledTable(ctx, ctx.table1);
    await makeStaleSettledTable(ctx, ctx.table2);

    const result = await reconcileSettledTablesToDirty(ctx.admin, {
      clubId: ctx.club.id, apply: false,
    });
    expect(result.applied).toBe(false);
    expect(result.tablesChanged).toBe(2);
    expect(result.tableNumbersChanged.sort()).toEqual(["T1", "T2"]);

    // No mutation — both still SEATED.
    const t1 = await db().diningTable.findUnique({ where: { id: ctx.table1.id } });
    const t2 = await db().diningTable.findUnique({ where: { id: ctx.table2.id } });
    expect(t1?.status).toBe("SEATED");
    expect(t2?.status).toBe("SEATED");
  });
});

// =============================================================================
// 7. Apply mode mutates + writes audit log per change.
// =============================================================================
describe("Apply mode writes one audit row per change", () => {
  it("two flipped tables → two audit rows with action=pos.table.reconcile", async () => {
    const ctx = await bootstrapLoungeWithTables("audit");
    await makeStaleSettledTable(ctx, ctx.table1);
    await makeStaleSettledTable(ctx, ctx.table2);

    const before = await db().auditLog.count({
      where: { clubId: ctx.club.id, action: "pos.table.reconcile" },
    });
    const result = await reconcileSettledTablesToDirty(ctx.admin, {
      clubId: ctx.club.id, apply: true,
    });
    expect(result.tablesChanged).toBe(2);
    const after = await db().auditLog.count({
      where: { clubId: ctx.club.id, action: "pos.table.reconcile" },
    });
    expect(after - before).toBe(2);

    const rows = await db().auditLog.findMany({
      where: { clubId: ctx.club.id, action: "pos.table.reconcile" },
      orderBy: { createdAt: "desc" },
      take: 2,
    });
    // Each row references the right table via entityType + entityId.
    expect(rows.every((r) => r.entityType === "DiningTable")).toBe(true);
    const ids = rows.map((r) => r.entityId).sort();
    expect(ids).toEqual([ctx.table1.id, ctx.table2.id].sort());
    // Actor is the principal.
    expect(rows.every((r) => r.userId === ctx.admin.id)).toBe(true);
  });
});

// =============================================================================
// 8. Summary surfaces the changed table numbers in order.
// =============================================================================
describe("Summary shape", () => {
  it("tableNumbersChanged is populated, skippedTables carries reasons", async () => {
    const ctx = await bootstrapLoungeWithTables("summary");
    // One stale (will flip), one active (will skip).
    await makeStaleSettledTable(ctx, ctx.table1);
    await seatTable(ctx.admin, ctx.club.id, {
      tableId: ctx.table2.id, memberId: ctx.host.id, partySize: 2,
    });
    const result = await reconcileSettledTablesToDirty(ctx.admin, {
      clubId: ctx.club.id, apply: false,
    });
    expect(result.tablesScanned).toBe(2);
    expect(result.tableNumbersChanged).toEqual(["T1"]);
    expect(result.skippedTables).toHaveLength(1);
    expect(result.skippedTables[0].tableNumber).toBe("T2");
    expect(result.skippedTables[0].reason).toBe("ACTIVE_CHECK_PRESENT");
    expect(result.skippedTables[0].detail).toContain("OPEN");
  });
});

// =============================================================================
// 9. Floor map renders DIRTY as "Needs Reset" (UI source contract).
// =============================================================================
describe("Floor map display copy", () => {
  const floorMapSrc = fs.readFileSync(
    path.resolve(process.cwd(), "src/app/app/admin/hospitality/reservations/floor/FloorMap.tsx"),
    "utf8",
  );

  it("STATUS_STYLES.DIRTY.label reads 'Needs Reset' (capital R)", () => {
    expect(floorMapSrc).toMatch(/DIRTY:\s*\{[^}]*label:\s*"Needs Reset"/);
    // No lowercase variant lingering.
    expect(floorMapSrc).not.toMatch(/label:\s*"Needs reset"/);
  });

  it("Reset Table button label survives", () => {
    expect(floorMapSrc).toMatch(/Reset Table/);
  });
});

// =============================================================================
// 10. Reset Table still flips DIRTY → AVAILABLE.
// =============================================================================
describe("Reset Table still works after reconcile", () => {
  it("setTableStatus('AVAILABLE') on a reconciled table returns it to service", async () => {
    const ctx = await bootstrapLoungeWithTables("post-reconcile");
    await makeStaleSettledTable(ctx, ctx.table1);
    await reconcileSettledTablesToDirty(ctx.admin, {
      clubId: ctx.club.id, apply: true,
    });
    expect((await db().diningTable.findUnique({ where: { id: ctx.table1.id } }))?.status).toBe("DIRTY");

    // Use the existing service to reset — same code path the floor
    // map's "Reset Table" button calls.
    const { setTableStatus } = await import("@/lib/hospitality/reservations");
    await setTableStatus(ctx.admin, ctx.table1.id, "AVAILABLE");
    expect((await db().diningTable.findUnique({ where: { id: ctx.table1.id } }))?.status).toBe("AVAILABLE");
  });
});

// =============================================================================
// Bonus — active SEATED reservation blocks reconcile (this is exactly why
// Silver Springs' L1 / L4 were correctly skipped in the apply run).
// =============================================================================
describe("Active reservation blocks reconcile (Silver Springs L1/L4 case)", () => {
  it("a SEATED table with a SEATED reservation but no check is skipped with ACTIVE_RESERVATION_PRESENT", async () => {
    const ctx = await bootstrapLoungeWithTables("active-reservation");
    // Force the same shape as Silver Springs L1: SEATED table, no
    // POSCheck rows, but an active SEATED reservation.
    await db().diningTable.update({
      where: { id: ctx.table1.id },
      data: { status: "SEATED" },
    });
    await db().diningReservation.create({
      data: {
        clubId: ctx.club.id,
        memberId: ctx.host.id,
        diningAreaId: ctx.table1.diningAreaId,
        tableId: ctx.table1.id,
        partySize: 2,
        reservationDate: new Date(),
        startTime: new Date(),
        expectedEndTime: new Date(Date.now() + 90 * 60 * 1000),
        status: "SEATED",
        reservationType: "MEMBER",
      },
    });
    const result = await reconcileSettledTablesToDirty(ctx.admin, {
      clubId: ctx.club.id, apply: true,
    });
    expect(result.tablesChanged).toBe(0);
    expect(result.skippedTables[0].reason).toBe("ACTIVE_RESERVATION_PRESENT");
    expect(result.skippedTables[0].detail).toContain("SEATED");
    const after = await db().diningTable.findUnique({ where: { id: ctx.table1.id } });
    expect(after?.status).toBe("SEATED");
  });

  it("a CONFIRMED upcoming reservation also blocks (Silver Springs L4 case)", async () => {
    const ctx = await bootstrapLoungeWithTables("confirmed-upcoming");
    await db().diningReservation.create({
      data: {
        clubId: ctx.club.id,
        memberId: ctx.host.id,
        diningAreaId: ctx.table1.diningAreaId,
        tableId: ctx.table1.id,
        partySize: 2,
        reservationDate: new Date(Date.now() + 24 * 60 * 60 * 1000),
        startTime: new Date(Date.now() + 24 * 60 * 60 * 1000),
        expectedEndTime: new Date(Date.now() + 24 * 60 * 60 * 1000 + 90 * 60 * 1000),
        status: "CONFIRMED",
        reservationType: "MEMBER",
      },
    });
    await db().diningTable.update({
      where: { id: ctx.table1.id },
      data: { status: "SEATED" },
    });
    const result = await reconcileSettledTablesToDirty(ctx.admin, {
      clubId: ctx.club.id, apply: false,
    });
    expect(result.tablesChanged).toBe(0);
    expect(result.skippedTables[0].reason).toBe("ACTIVE_RESERVATION_PRESENT");
    expect(result.skippedTables[0].detail).toContain("CONFIRMED");
  });
});
