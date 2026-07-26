// POS cleanup step 2 — seat-level ordering golden path.
//
// These tests pin down the workflow a server uses after they click into
// a seated table from the floor-map POS:
//
//   click Seat 1 → add burger → burger appears under Seat 1
//   click Seat 2 → add drink → drink appears under Seat 2
//   click Send → kitchen + bar chits exist with seat numbers
//
// Settlement, split bills, modifiers, receipts, QR pay are deliberately
// OUT OF SCOPE. The single goal here is: the seat-level ordering path
// is correct, tenant-safe, and does not post any AR / GL on send.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { db, makeClub, makeMember, makeUser, principalFor, resetDb, seedRbac } from "./util/db";
import { bootstrapAPClub } from "./util/ap";
import { seatTable, seatSummary } from "@/lib/pos/seat-checks";
import { addCheckLines, sendUnsentItems, listChitsForStation } from "@/lib/pos/checks";
import { LOUNGE_LOCATION_CODE, LOUNGE_TERMINAL_CODE } from "@/lib/pos/lounge";
import { ConflictError, TenantViolationError } from "@/lib/errors";

// Replica of the bootstrap from pos-seat-workflow — different name so
// the tests in this file are independent (no cross-file shared state).
async function bootstrapSeatedTable(name: string) {
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
    data: { clubId: club.id, categoryId: foodCat.id, name: "Grilled Cheese & Fries", price: 14, taxable: true, isActive: true },
  });
  const beer = await db().pOSMenuItem.create({
    data: { clubId: club.id, categoryId: drinkCat.id, name: "Beer", price: 8, taxable: true, isActive: true },
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
  return { club, table, foodCat, drinkCat, burger, beer, host };
}

async function adminFor(clubId: string, suffix: string) {
  const email = `seat-ord-${suffix}-${clubId}@example.com`;
  await makeUser({ email, role: "CLUB_ADMIN", clubId });
  return principalFor(email);
}

async function openSeatedCheck(suffix: string) {
  const ctx = await bootstrapSeatedTable(`Seat Order ${suffix}`);
  const admin = await adminFor(ctx.club.id, suffix);
  const { checkId } = await seatTable(admin, ctx.club.id, {
    tableId: ctx.table.id, memberId: ctx.host.id, partySize: 4,
  });
  return { ...ctx, admin, checkId };
}

beforeAll(async () => { await resetDb(); await seedRbac(); });
beforeEach(async () => { await resetDb(); await seedRbac(); });

// =============================================================================
// 1. Seat view loads for an open seated check
// =============================================================================
describe("Seat view loads", () => {
  it("seatSummary returns the table label, capacity, and one row per seat", async () => {
    const { admin, checkId, table } = await openSeatedCheck("loads");
    const r = await seatSummary(admin, checkId);
    expect(r.check.id).toBe(checkId);
    expect(r.check.status).toBe("OPEN");
    expect(r.check.table?.tableNumber).toBe(table.tableNumber);
    expect(r.seats).toHaveLength(table.capacity);
    expect(r.seats.map((s) => s.seatNumber)).toEqual([1, 2, 3, 4]);
    // Seat 1 is the primary host; rows 2..4 unassigned.
    expect(r.seats[0].assignment.isPrimary).toBe(true);
    expect(r.seats[0].assignment.memberId).toBeTruthy();
    expect(r.seats[1].assignment.memberId).toBeNull();
  });
});

// =============================================================================
// 2 + 3. Selecting Seat 1 / Seat 2 updates active seat (UI source contract)
// =============================================================================
describe("Active seat selection (UI source contract)", () => {
  const src = fs.readFileSync(
    path.resolve(process.cwd(), "src/app/app/admin/ops/pos/lounge/table/[checkId]/SeatPOS.tsx"),
    "utf8",
  );

  it("active seat starts as null so the empty state renders first", () => {
    // Initial useState value — anchors the 'Select a seat' empty state.
    expect(src).toMatch(/useState<number \| "TABLE" \| null>\(null\)/);
  });

  it("each seat circle calls setActiveSeat with its number on click", () => {
    // The seat strip wires every seat's click handler to onSelect(seat).
    expect(src).toMatch(/onClick=\{\(\) => onSelect\(seat\)\}/);
    // The parent passes setActiveSeat as onSelect.
    expect(src).toMatch(/onSelect=\{\(n\) => setActiveSeat\(n\)\}/);
  });

  it("active seat number drives the per-seat order panel heading", () => {
    // Heading line shows the active seat number.
    expect(src).toMatch(/`Seat \$\{activeSeat\}`/);
  });
});

// =============================================================================
// 4 + 5. Adding menu item to Seat 1/2 creates line with correct seatNumber
// =============================================================================
describe("Adding items per seat", () => {
  it("adding to Seat 1 creates a POSCheckLine with seatNumber=1, tableLevel=false, server-side price", async () => {
    const { admin, checkId, burger } = await openSeatedCheck("add1");
    await addCheckLines(admin, checkId, {
      items: [{ menuItemId: burger.id, quantity: 1, seatNumber: 1 }],
    });
    const lines = await db().pOSCheckLine.findMany({ where: { checkId } });
    expect(lines).toHaveLength(1);
    expect(lines[0].seatNumber).toBe(1);
    expect(lines[0].tableLevel).toBe(false);
    expect(lines[0].menuItemId).toBe(burger.id);
    expect(lines[0].status).toBe("DRAFT");
    expect(lines[0].prepStation).toBe("KITCHEN");
    // Server is authoritative on price — the test passes no price, the
    // service uses POSMenuItem.price ($14 from bootstrap).
    expect(Number(lines[0].unitPrice.toString())).toBe(14);
  });

  it("adding to Seat 2 creates a POSCheckLine with seatNumber=2", async () => {
    const { admin, checkId, beer } = await openSeatedCheck("add2");
    await addCheckLines(admin, checkId, {
      items: [{ menuItemId: beer.id, quantity: 1, seatNumber: 2 }],
    });
    const lines = await db().pOSCheckLine.findMany({ where: { checkId } });
    expect(lines).toHaveLength(1);
    expect(lines[0].seatNumber).toBe(2);
    expect(lines[0].prepStation).toBe("BAR");
  });
});

// =============================================================================
// 6. Items render under the correct seat in seatSummary
// =============================================================================
describe("Per-seat item bucketing", () => {
  it("seatSummary buckets each line under its own seat (no cross-talk)", async () => {
    const { admin, checkId, burger, beer } = await openSeatedCheck("bucket");
    await addCheckLines(admin, checkId, {
      items: [
        { menuItemId: burger.id, quantity: 1, seatNumber: 1 },
        { menuItemId: beer.id, quantity: 1, seatNumber: 2 },
      ],
    });
    const r = await seatSummary(admin, checkId);
    const s1 = r.seats.find((s) => s.seatNumber === 1)!;
    const s2 = r.seats.find((s) => s.seatNumber === 2)!;
    const s3 = r.seats.find((s) => s.seatNumber === 3)!;
    expect(s1.items.map((l) => l.menuItemId)).toEqual([burger.id]);
    expect(s2.items.map((l) => l.menuItemId)).toEqual([beer.id]);
    expect(s3.items).toHaveLength(0);
  });
});

// =============================================================================
// 7. Cannot add item without selected seat (UI source contract)
// =============================================================================
describe("Cannot add item without a selected seat", () => {
  const src = fs.readFileSync(
    path.resolve(process.cwd(), "src/app/app/admin/ops/pos/lounge/table/[checkId]/SeatPOS.tsx"),
    "utf8",
  );

  it("runAdd short-circuits when activeSeat is null and shows the prompt", () => {
    // Source contract: the add handler refuses to fire without a seat
    // and surfaces the "Select a seat to begin ordering." prompt.
    expect(src).toMatch(/if \(activeSeat === null\)/);
    expect(src).toMatch(/Select a seat to begin ordering\./);
  });

  it("the 'Table' button is opt-in (explicit second click), not the default", () => {
    // activeSeat must be explicitly set to "TABLE" by clicking the
    // Table chip; nothing in the file initialises it to "TABLE".
    expect(src).not.toMatch(/useState<number \| "TABLE" \| null>\("TABLE"\)/);
    expect(src).toMatch(/onClick=\{\(\) => onSelect\("TABLE"\)\}/);
  });
});

// =============================================================================
// 8. Cannot add item to closed/voided check (service contract)
// =============================================================================
describe("Cannot add to closed / voided check", () => {
  it("addCheckLines rejects a CLOSED check with ConflictError", async () => {
    const { admin, checkId, burger } = await openSeatedCheck("closed");
    await db().pOSCheck.update({
      where: { id: checkId }, data: { status: "CLOSED", closedAt: new Date() },
    });
    await expect(
      addCheckLines(admin, checkId, { items: [{ menuItemId: burger.id, quantity: 1, seatNumber: 1 }] }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("addCheckLines rejects a VOIDED check with ConflictError", async () => {
    const { admin, checkId, burger } = await openSeatedCheck("voided");
    await db().pOSCheck.update({ where: { id: checkId }, data: { status: "VOIDED" } });
    await expect(
      addCheckLines(admin, checkId, { items: [{ menuItemId: burger.id, quantity: 1, seatNumber: 1 }] }),
    ).rejects.toBeInstanceOf(ConflictError);
  });
});

// =============================================================================
// 9 + 10. Send creates kitchen / bar chits with the seat number
// =============================================================================
describe("Send unsent items → station chits with seat numbers", () => {
  it("sendUnsentItems creates one KITCHEN chit and one BAR chit; each chit line carries the seat number", async () => {
    const { admin, club, checkId, burger, beer } = await openSeatedCheck("send");
    await addCheckLines(admin, checkId, {
      items: [
        { menuItemId: burger.id, quantity: 1, seatNumber: 1 }, // kitchen
        { menuItemId: beer.id,   quantity: 1, seatNumber: 2 }, // bar
      ],
    });
    const sent = await sendUnsentItems(admin, checkId);
    expect(sent.chitIds.length).toBe(2);

    const kitchenChits = await listChitsForStation(admin, club.id, "KITCHEN", { limit: 5 });
    const barChits     = await listChitsForStation(admin, club.id, "BAR",     { limit: 5 });
    const kChit = kitchenChits.find((c) => c.checkId === checkId);
    const bChit = barChits.find((c) => c.checkId === checkId);
    expect(kChit).toBeTruthy();
    expect(bChit).toBeTruthy();

    // displaySeatNumber is the snapshot the prep station prints.
    expect(kChit!.lines.some((l) => l.displaySeatNumber === 1 && l.displayDescription.includes("Grilled Cheese"))).toBe(true);
    expect(bChit!.lines.some((l) => l.displaySeatNumber === 2 && l.displayDescription.includes("Beer"))).toBe(true);
  });

  it("the chit's check carries the table number so the prep station can route the runner", async () => {
    const { admin, club, checkId, burger, table } = await openSeatedCheck("send-table-no");
    await addCheckLines(admin, checkId, {
      items: [{ menuItemId: burger.id, quantity: 1, seatNumber: 1 }],
    });
    await sendUnsentItems(admin, checkId);
    const chit = (await listChitsForStation(admin, club.id, "KITCHEN", { limit: 5 })).find((c) => c.checkId === checkId);
    expect(chit).toBeTruthy();
    // The chit references the POSCheck which still holds tableNumber + tableId.
    const check = await db().pOSCheck.findUnique({ where: { id: chit!.checkId } });
    expect(check?.tableNumber).toBe(table.tableNumber);
    expect(check?.tableId).toBe(table.id);
  });
});

// =============================================================================
// 11 + 12. Sending items posts nothing financial
// =============================================================================
describe("Send does not post anything financial", () => {
  it("no Charge, no Payment, no JournalEntry, no POSSale exist after a send", async () => {
    const { admin, club, checkId, burger, host } = await openSeatedCheck("noar");

    // Snapshot AR + GL counts BEFORE the send so we ignore anything the
    // bootstrap may have written (it shouldn't, but be defensive).
    const chargesBefore = await db().charge.count({ where: { clubId: club.id } });
    const paymentsBefore = await db().payment.count({ where: { clubId: club.id } });
    const jesBefore = await db().journalEntry.count({ where: { clubId: club.id } });
    const salesBefore = await db().pOSSale.count({ where: { clubId: club.id } });

    await addCheckLines(admin, checkId, {
      items: [{ menuItemId: burger.id, quantity: 1, seatNumber: 1 }],
    });
    await sendUnsentItems(admin, checkId);

    expect(await db().charge.count({ where: { clubId: club.id } })).toBe(chargesBefore);
    expect(await db().payment.count({ where: { clubId: club.id } })).toBe(paymentsBefore);
    expect(await db().journalEntry.count({ where: { clubId: club.id } })).toBe(jesBefore);
    expect(await db().pOSSale.count({ where: { clubId: club.id } })).toBe(salesBefore);

    // Member account balance untouched.
    const acct = await db().memberAccount.findUnique({ where: { memberId: host.id } });
    if (acct) expect(Number(acct.currentBalance.toString())).toBe(0);
  });

  it("the check stays OPEN-family (not CLOSED, not VOIDED) after send", async () => {
    const { admin, checkId, burger } = await openSeatedCheck("openish");
    await addCheckLines(admin, checkId, {
      items: [{ menuItemId: burger.id, quantity: 1, seatNumber: 1 }],
    });
    await sendUnsentItems(admin, checkId);
    const check = await db().pOSCheck.findUnique({ where: { id: checkId } });
    expect(["OPEN", "PARTIALLY_SENT", "SENT"]).toContain(check?.status);
    expect(check?.posSaleId).toBeNull();
    expect(check?.closedAt).toBeNull();
  });
});

// =============================================================================
// 13. Already-sent lines are not resent on the next send pass
// =============================================================================
describe("Idempotent sends", () => {
  it("a second send with no new DRAFT lines is rejected and creates no new chits", async () => {
    const { admin, checkId, burger } = await openSeatedCheck("idem");
    await addCheckLines(admin, checkId, {
      items: [{ menuItemId: burger.id, quantity: 1, seatNumber: 1 }],
    });
    const first = await sendUnsentItems(admin, checkId);
    expect(first.chitIds.length).toBe(1);
    // The service refuses to send if there is nothing draft. Honest
    // behaviour — "nothing to send" is a conflict, not a silent no-op.
    await expect(sendUnsentItems(admin, checkId)).rejects.toBeInstanceOf(ConflictError);
    const chitsForCheck = await db().pOSChit.count({ where: { checkId } });
    expect(chitsForCheck).toBe(1);
  });

  it("adding a third item after a send and resending only sends the new one", async () => {
    const { admin, checkId, burger, beer } = await openSeatedCheck("topup");
    await addCheckLines(admin, checkId, {
      items: [{ menuItemId: burger.id, quantity: 1, seatNumber: 1 }],
    });
    await sendUnsentItems(admin, checkId);
    await addCheckLines(admin, checkId, {
      items: [{ menuItemId: beer.id, quantity: 1, seatNumber: 2 }],
    });
    const r = await sendUnsentItems(admin, checkId);
    expect(r.chitIds.length).toBe(1);
    // Original burger line should still be SENT (not double-sent / re-DRAFTed).
    const lines = await db().pOSCheckLine.findMany({ where: { checkId }, orderBy: { createdAt: "asc" } });
    expect(lines.map((l) => ({ menu: l.menuItemId, status: l.status }))).toEqual([
      { menu: burger.id, status: "SENT" },
      { menu: beer.id,   status: "SENT" },
    ]);
  });
});

// =============================================================================
// 14. Cross-tenant menu item / check blocked
// =============================================================================
describe("Cross-tenant safety on seat-level ordering", () => {
  it("admin of club B cannot add items to club A's check", async () => {
    const a = await openSeatedCheck("xt-a");
    const b = await bootstrapSeatedTable("Cross-tenant B");
    const adminB = await adminFor(b.club.id, "xtB");
    await expect(
      addCheckLines(adminB, a.checkId, { items: [{ menuItemId: a.burger.id, quantity: 1, seatNumber: 1 }] }),
    ).rejects.toBeInstanceOf(TenantViolationError);
  });

  it("admin of club B cannot send chits on club A's check", async () => {
    const a = await openSeatedCheck("xt-send-a");
    const b = await bootstrapSeatedTable("Cross-tenant Send B");
    const adminB = await adminFor(b.club.id, "xtSendB");
    // First put a DRAFT line on A's check using the right admin.
    await addCheckLines(a.admin, a.checkId, {
      items: [{ menuItemId: a.burger.id, quantity: 1, seatNumber: 1 }],
    });
    await expect(sendUnsentItems(adminB, a.checkId)).rejects.toBeInstanceOf(TenantViolationError);
  });

  it("club A's check cannot order club B's menu item (cross-club menu reference)", async () => {
    const a = await openSeatedCheck("xt-menu-a");
    const b = await bootstrapSeatedTable("Cross-tenant Menu B");
    // Try to add B's burger to A's check using A's admin.
    await expect(
      addCheckLines(a.admin, a.checkId, { items: [{ menuItemId: b.burger.id, quantity: 1, seatNumber: 1 }] }),
    ).rejects.toBeInstanceOf(ConflictError);
  });
});

// =============================================================================
// Bonus — remove DRAFT line UX
// =============================================================================
describe("Remove unsent (DRAFT) line", () => {
  const src = fs.readFileSync(
    path.resolve(process.cwd(), "src/app/app/admin/ops/pos/lounge/table/[checkId]/SeatPOS.tsx"),
    "utf8",
  );
  const actions = fs.readFileSync(
    path.resolve(process.cwd(), "src/app/app/admin/ops/pos/lounge/table/_actions.ts"),
    "utf8",
  );

  it("table/_actions exports removeSeatLineAction wrapping removeCheckLine", () => {
    expect(actions).toMatch(/export async function removeSeatLineAction/);
    expect(actions).toMatch(/await removeCheckLine\(/);
  });

  it("SeatPOS imports removeSeatLineAction and wires it through runRemove", () => {
    expect(src).toMatch(/removeSeatLineAction/);
    expect(src).toMatch(/function runRemove\(checkLineId: string\)/);
  });

  it("the × button renders only for DRAFT lines (sent lines are immutable)", () => {
    // Conditional render — DRAFT shows button; otherwise a spacer.
    expect(src).toMatch(/l\.status === "DRAFT" \? \(/);
    expect(src).toMatch(/aria-label=\{`Remove \$\{l\.description\}`\}/);
  });
});
