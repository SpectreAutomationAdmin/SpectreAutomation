// POS cleanup step 13 — table lifecycle bug fix.
//
// Bug: after a SEATED table was fully settled, DiningTable.status
// stayed SEATED. The floor map kept showing the table as occupied even
// though guests had left. The fix flips the table to DIRTY on full
// close in every settle path (seat-level, legacy lounge, QR-pay
// confirm). Partial settle keeps it SEATED.
//
// DIRTY is the existing "needs reset" state — the floor map already
// renders it in orange and surfaces the Reset Table button. We're
// just plumbing the trigger.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { db, makeMember, makeUser, principalFor, resetDb, seedRbac } from "./util/db";
import { bootstrapAPClub } from "./util/ap";
import { seatTable, settleCheckBySeats } from "@/lib/pos/seat-checks";
import { addCheckLines } from "@/lib/pos/checks";
import { setTableStatus } from "@/lib/hospitality/reservations";
import { LOUNGE_LOCATION_CODE, LOUNGE_TERMINAL_CODE } from "@/lib/pos/lounge";

async function bootstrapTableWithTwoSeats(name: string) {
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
  const drinkCat = await db().pOSMenuCategory.create({
    data: { clubId: club.id, locationId: loc.id, name: "Drinks", sortOrder: 2, isActive: true, chitDestination: "BAR" },
  });
  const burger = await db().pOSMenuItem.create({
    data: { clubId: club.id, categoryId: cat.id, name: "The Silver Burger", price: 18, taxable: true, isActive: true },
  });
  const beer = await db().pOSMenuItem.create({
    data: { clubId: club.id, categoryId: drinkCat.id, name: "House Lager", price: 8, taxable: true, isActive: true },
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
  const margaret = await makeMember(club.id, { firstName: "Margaret", lastName: "Lin" });
  const adminEmail = `lifecycle-${club.id}@example.com`;
  await makeUser({ email: adminEmail, role: "CLUB_ADMIN", clubId: club.id });
  const admin = await principalFor(adminEmail);
  return { club, table, burger, beer, owen, margaret, admin };
}

async function seatAndAddTwo(ctx: Awaited<ReturnType<typeof bootstrapTableWithTwoSeats>>) {
  const { checkId } = await seatTable(ctx.admin, ctx.club.id, {
    tableId: ctx.table.id, memberId: ctx.owen.id, partySize: 4,
  });
  await addCheckLines(ctx.admin, checkId, {
    items: [{ menuItemId: ctx.burger.id, quantity: 1, seatNumber: 1 }],
  });
  await addCheckLines(ctx.admin, checkId, {
    items: [{ menuItemId: ctx.beer.id, quantity: 1, seatNumber: 2 }],
  });
  return checkId;
}

beforeAll(async () => { await resetDb(); await seedRbac(); });
beforeEach(async () => { await resetDb(); await seedRbac(); });

// =============================================================================
// 1. Full settlement (merge-all) flips SEATED → DIRTY.
// =============================================================================
describe("Full settlement flips table SEATED → DIRTY", () => {
  it("merge-all-into-one settle on a SEATED table → table.status = DIRTY", async () => {
    const ctx = await bootstrapTableWithTwoSeats("full-merge");
    const checkId = await seatAndAddTwo(ctx);

    // Sanity: after seatTable the table is SEATED.
    const beforeSettle = await db().diningTable.findUnique({ where: { id: ctx.table.id } });
    expect(beforeSettle?.status).toBe("SEATED");

    await settleCheckBySeats(ctx.admin, checkId, {
      groups: [{
        label: "All seats", seatNumbers: [1, 2],
        paymentMethod: "MEMBER_ACCOUNT", memberId: ctx.owen.id,
      }],
      allowUnsentLines: true,
    });
    const afterSettle = await db().diningTable.findUnique({ where: { id: ctx.table.id } });
    expect(afterSettle?.status).toBe("DIRTY");
  });
});

// =============================================================================
// 2. Partial settlement does NOT transition the table.
// =============================================================================
describe("Partial settlement leaves the table SEATED", () => {
  it("only one of two seats settled → check is PARTIALLY_SETTLED + table stays SEATED", async () => {
    const ctx = await bootstrapTableWithTwoSeats("partial");
    const checkId = await seatAndAddTwo(ctx);

    // Settle only seat 1; seat 2 still has an unsettled line.
    const r = await settleCheckBySeats(ctx.admin, checkId, {
      groups: [{
        label: "Seat 1 only", seatNumbers: [1],
        paymentMethod: "MEMBER_ACCOUNT", memberId: ctx.owen.id,
      }],
      allowUnsentLines: true,
    });
    expect(r.check.status).toBe("PARTIALLY_SETTLED");
    const table = await db().diningTable.findUnique({ where: { id: ctx.table.id } });
    expect(table?.status).toBe("SEATED");
  });
});

// =============================================================================
// 3. Failed settlement does not transition.
// =============================================================================
describe("Failed settlement does not flip the table", () => {
  it("a QR_PAY group rejection (entire settle throws) leaves SEATED untouched", async () => {
    const ctx = await bootstrapTableWithTwoSeats("failed");
    const checkId = await seatAndAddTwo(ctx);

    // QR_PAY in a split group is intentionally rejected at the service
    // layer (deferred). The whole settle throws, so nothing flips.
    await expect(
      settleCheckBySeats(ctx.admin, checkId, {
        groups: [
          { label: "Seat 1", seatNumbers: [1], paymentMethod: "MEMBER_ACCOUNT", memberId: ctx.owen.id },
          { label: "Seat 2", seatNumbers: [2], paymentMethod: "QR_PAY", memberId: ctx.margaret.id },
        ],
        allowUnsentLines: true,
      }),
    ).rejects.toThrow();
    const table = await db().diningTable.findUnique({ where: { id: ctx.table.id } });
    expect(table?.status).toBe("SEATED");
  });
});

// =============================================================================
// 4. Split-bill partial — Group A settled, Group B not → table stays SEATED.
// =============================================================================
describe("Split bill: one of two groups settled", () => {
  it("only Group A in this pass → check PARTIALLY_SETTLED, table SEATED", async () => {
    const ctx = await bootstrapTableWithTwoSeats("split-partial");
    const checkId = await seatAndAddTwo(ctx);

    // Single MEMBER_ACCOUNT group for seat 1 only — seat 2's line stays
    // unsettled (no settlement group references it).
    const r = await settleCheckBySeats(ctx.admin, checkId, {
      groups: [{
        label: "Group A — Seat 1", seatNumbers: [1],
        paymentMethod: "MEMBER_ACCOUNT", memberId: ctx.owen.id,
      }],
      allowUnsentLines: true,
    });
    expect(r.check.status).toBe("PARTIALLY_SETTLED");
    const table = await db().diningTable.findUnique({ where: { id: ctx.table.id } });
    expect(table?.status).toBe("SEATED");
  });
});

// =============================================================================
// 5. Split bill fully settled → DIRTY.
// =============================================================================
describe("Split bill: all groups settled in one call", () => {
  it("Group A + Group B both settled → check CLOSED, table DIRTY", async () => {
    const ctx = await bootstrapTableWithTwoSeats("split-full");
    const checkId = await seatAndAddTwo(ctx);

    const r = await settleCheckBySeats(ctx.admin, checkId, {
      groups: [
        { label: "Group A — Seat 1", seatNumbers: [1], paymentMethod: "MEMBER_ACCOUNT", memberId: ctx.owen.id },
        { label: "Group B — Seat 2", seatNumbers: [2], paymentMethod: "MEMBER_ACCOUNT", memberId: ctx.margaret.id },
      ],
      allowUnsentLines: true,
    });
    expect(r.check.status).toBe("CLOSED");
    const table = await db().diningTable.findUnique({ where: { id: ctx.table.id } });
    expect(table?.status).toBe("DIRTY");
  });
});

// =============================================================================
// 6. Floor map renders DIRTY with a distinct style + the Reset Table button
//    (UI source contract — already in place from prior steps; re-pin so the
//    spec's "visually obvious" requirement is monitored).
// =============================================================================
describe("Floor map surfaces DIRTY state (UI source contract)", () => {
  const floorMapSrc = fs.readFileSync(
    path.resolve(process.cwd(), "src/app/app/admin/hospitality/reservations/floor/FloorMap.tsx"),
    "utf8",
  );

  it("DIRTY gets a distinct fill/stroke colour (orange, not green or blue)", () => {
    // STATUS_STYLES maps DIRTY -> fill: "#ffedd5", stroke: "#c0651e".
    // Other statuses use distinct colours.
    expect(floorMapSrc).toMatch(/DIRTY:\s*\{\s*fill:\s*"#ffedd5"/);
    // AVAILABLE + SEATED do not use the same fill as DIRTY.
    expect(floorMapSrc).toMatch(/AVAILABLE:\s*\{\s*fill:\s*"#ecfdf5"/);
    expect(floorMapSrc).toMatch(/SEATED:\s*\{\s*fill:\s*"#dbe7f5"/);
  });

  it("DIRTY tables get a Reset Table button (renamed from 'Mark cleaned')", () => {
    expect(floorMapSrc).toMatch(/table\.status === "DIRTY"/);
    expect(floorMapSrc).toMatch(/Reset Table/);
    // The button calls setTableStatusAction(table.id, "AVAILABLE").
    expect(floorMapSrc).toMatch(/setTableStatusAction\(table\.id, "AVAILABLE"\)/);
    // The legacy label should NOT be there.
    expect(floorMapSrc).not.toMatch(/Mark cleaned/);
  });
});

// =============================================================================
// 7. Reset action flips DIRTY → AVAILABLE.
// =============================================================================
describe("Reset action: DIRTY → AVAILABLE", () => {
  it("setTableStatus(table, 'AVAILABLE') on a DIRTY table flips it", async () => {
    const ctx = await bootstrapTableWithTwoSeats("reset");
    // Put the table in DIRTY directly so the test only exercises reset.
    await db().diningTable.update({ where: { id: ctx.table.id }, data: { status: "DIRTY" } });
    await setTableStatus(ctx.admin, ctx.table.id, "AVAILABLE");
    const table = await db().diningTable.findUnique({ where: { id: ctx.table.id } });
    expect(table?.status).toBe("AVAILABLE");
  });
});

// =============================================================================
// 8. Reset action does NOT delete historical checks.
// =============================================================================
describe("Reset preserves history", () => {
  it("after settle → reset → AVAILABLE, the closed POSCheck + POSSale rows are still queryable", async () => {
    const ctx = await bootstrapTableWithTwoSeats("history-1");
    const checkId = await seatAndAddTwo(ctx);
    const r = await settleCheckBySeats(ctx.admin, checkId, {
      groups: [{
        label: "All seats", seatNumbers: [1, 2],
        paymentMethod: "MEMBER_ACCOUNT", memberId: ctx.owen.id,
      }],
      allowUnsentLines: true,
    });
    const saleId = r.groups[0].posSaleId!;

    // Reset.
    await setTableStatus(ctx.admin, ctx.table.id, "AVAILABLE");

    // The check + sale + lines are still there.
    const checkAfter = await db().pOSCheck.findUnique({ where: { id: checkId } });
    expect(checkAfter?.status).toBe("CLOSED");
    expect(checkAfter?.posSaleId).toBe(saleId);
    const saleAfter = await db().pOSSale.findUnique({
      where: { id: saleId },
      include: { lines: true },
    });
    expect(saleAfter?.status).toBe("COMPLETED");
    expect(saleAfter!.lines.length).toBeGreaterThan(0);
    // And the table itself is now AVAILABLE.
    const tableAfter = await db().diningTable.findUnique({ where: { id: ctx.table.id } });
    expect(tableAfter?.status).toBe("AVAILABLE");
  });
});

// =============================================================================
// 9. Historical sales remain accessible (same as 8 — separated for clarity).
// =============================================================================
describe("Historical sales remain accessible after reset", () => {
  it("the settled POSSale's lines + total are unchanged after reset", async () => {
    const ctx = await bootstrapTableWithTwoSeats("history-2");
    const checkId = await seatAndAddTwo(ctx);
    const r = await settleCheckBySeats(ctx.admin, checkId, {
      groups: [{
        label: "All seats", seatNumbers: [1, 2],
        paymentMethod: "MEMBER_ACCOUNT", memberId: ctx.owen.id,
      }],
      allowUnsentLines: true,
    });
    const saleBefore = await db().pOSSale.findUnique({ where: { id: r.groups[0].posSaleId! } });
    const totalBefore = Number(saleBefore!.grandTotal.toString());
    await setTableStatus(ctx.admin, ctx.table.id, "AVAILABLE");
    const saleAfter = await db().pOSSale.findUnique({ where: { id: r.groups[0].posSaleId! } });
    expect(Number(saleAfter!.grandTotal.toString())).toBeCloseTo(totalBefore, 2);
  });
});

// =============================================================================
// 10. Cross-tenant reset blocked.
// =============================================================================
describe("Cross-tenant reset is blocked", () => {
  it("admin of club B cannot reset club A's table", async () => {
    const a = await bootstrapTableWithTwoSeats("xt-a");
    await db().diningTable.update({ where: { id: a.table.id }, data: { status: "DIRTY" } });
    const b = await bootstrapTableWithTwoSeats("xt-b");
    await expect(
      setTableStatus(b.admin, a.table.id, "AVAILABLE"),
    ).rejects.toThrow();
    // Club A's table is unchanged.
    const stillDirty = await db().diningTable.findUnique({ where: { id: a.table.id } });
    expect(stillDirty?.status).toBe("DIRTY");
  });
});

// =============================================================================
// Bonus — the flip is guarded by the SEATED status (defence in depth).
// A table that's RESERVED or OUT_OF_SERVICE when a check happens to close
// must NOT be silently bulldozed to DIRTY (host UX owns those states).
// =============================================================================
describe("Status flip is guarded", () => {
  it("if the table is somehow OUT_OF_SERVICE at close, the flip skips it", async () => {
    const ctx = await bootstrapTableWithTwoSeats("guarded");
    const checkId = await seatAndAddTwo(ctx);
    // Force OUT_OF_SERVICE between seating and settle — defence in depth.
    await db().diningTable.update({
      where: { id: ctx.table.id },
      data: { status: "OUT_OF_SERVICE" },
    });
    await settleCheckBySeats(ctx.admin, checkId, {
      groups: [{
        label: "All seats", seatNumbers: [1, 2],
        paymentMethod: "MEMBER_ACCOUNT", memberId: ctx.owen.id,
      }],
      allowUnsentLines: true,
    });
    const table = await db().diningTable.findUnique({ where: { id: ctx.table.id } });
    expect(table?.status).toBe("OUT_OF_SERVICE");
  });
});
