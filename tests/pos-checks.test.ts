// Open-check workflow tests.
//
// The lounge POS now uses open POSChecks (servers add items, send
// chits, settle later) rather than the legacy "ring up + complete in
// one shot" path. This file covers the 25 assertions listed in the
// refactor spec, grouped where the assertions naturally cluster.

import { describe, it, expect, beforeEach } from "vitest";
import { db, makeUser, makeMember, resetDb, principalFor } from "./util/db";
import { bootstrapAPClub } from "./util/ap";
import {
  openCheck,
  listOpenChecks,
  getCheck,
  addCheckLines,
  removeCheckLine,
  voidCheckLine,
  sendUnsentItems,
  settleCheck,
  voidCheck,
  listChitsForStation,
  listHeldChitsForStation,
  acknowledgeChit,
  markChitReady,
  setAutoPace,
  fireNextCourse,
  promoteDueHeldChits,
} from "@/lib/pos/checks";
import {
  LOUNGE_LOCATION_CODE,
  LOUNGE_TERMINAL_CODE,
} from "@/lib/pos/lounge";
import { ConflictError, ValidationError } from "@/lib/errors";
import { TrainingModeBlockedError } from "@/lib/training";
import { SupportReadOnlyError } from "@/lib/support-access";

// ---------------------------------------------------------------------------
// Fixture: a club with the lounge fully provisioned + a member + an
// admin principal authorised to work the POS.
// ---------------------------------------------------------------------------
async function bootstrapLounge(name = "Lounge Check Test Club") {
  const club = await bootstrapAPClub(name);
  const fbDept = await db().department.findFirst({ where: { clubId: club.id, code: "FB" } });
  const location = await db().pOSLocation.create({
    data: { clubId: club.id, code: LOUNGE_LOCATION_CODE, name: "Clubhouse Lounge", departmentId: fbDept?.id ?? null },
  });
  const terminal = await db().pOSTerminal.create({
    data: { clubId: club.id, code: LOUNGE_TERMINAL_CODE, name: "Lounge Terminal 1", locationId: location.id },
  });
  await db().pOSSession.create({
    data: { clubId: club.id, locationId: location.id, terminalId: terminal.id, status: "OPEN", openingFloat: 0 },
  });
  // Menu: one kitchen category + one bar category
  const mains = await db().pOSMenuCategory.create({
    data: { clubId: club.id, locationId: location.id, name: "Mains", sortOrder: 1, isActive: true, chitDestination: "KITCHEN" },
  });
  const burger = await db().pOSMenuItem.create({
    data: { clubId: club.id, categoryId: mains.id, name: "Silver Burger", price: 22, taxable: true, isActive: true },
  });
  const fish = await db().pOSMenuItem.create({
    data: { clubId: club.id, categoryId: mains.id, name: "Fish & Chips", price: 20, taxable: true, isActive: true },
  });
  const beer = await db().pOSMenuCategory.create({
    data: { clubId: club.id, locationId: location.id, name: "Beer", sortOrder: 2, isActive: true, chitDestination: "BAR" },
  });
  const stella = await db().pOSMenuItem.create({
    data: { clubId: club.id, categoryId: beer.id, name: "Stella Artois", price: 8, taxable: true, isActive: true },
  });
  return { club, items: { burger, fish, stella } };
}

async function clubAdmin(clubId: string, suffix = "") {
  const email = `chk-admin${suffix}-${clubId}@example.com`;
  await makeUser({ email, role: "CLUB_ADMIN", clubId });
  return principalFor(email);
}

beforeEach(async () => { await resetDb(); });

// ===========================================================================
// 1–4 — Open a check; add items; food → kitchen / drinks → bar at SEND time
// ===========================================================================
describe("Open check workflow — basics", () => {
  it("1–4: open check → add food + drink items → confirm routing prepStation values", async () => {
    const { club, items } = await bootstrapLounge();
    const p = await clubAdmin(club.id);
    const member = await makeMember(club.id, { firstName: "James", lastName: "Whitfield" });

    const check = await openCheck(p, club.id, { memberId: member.id });
    expect(check.status).toBe("OPEN");
    expect(check.checkNumber).toMatch(/^CHK-\d{4}-\d{6}$/);

    await addCheckLines(p, check.id, {
      items: [
        { menuItemId: items.burger.id, quantity: 1 },
        { menuItemId: items.stella.id, quantity: 2 },
      ],
    });
    const full = await getCheck(p, check.id);
    expect(full.lines).toHaveLength(2);
    const burgerLine = full.lines.find((l) => l.menuItemId === items.burger.id);
    const stellaLine = full.lines.find((l) => l.menuItemId === items.stella.id);
    expect(burgerLine?.prepStation).toBe("KITCHEN");
    expect(stellaLine?.prepStation).toBe("BAR");
    expect(burgerLine?.status).toBe("DRAFT");
    expect(stellaLine?.status).toBe("DRAFT");
  });
});

// ===========================================================================
// 5–8 — One send creates separate kitchen/bar chits; check stays open; no AR/GL
// ===========================================================================
describe("Send to prep stations", () => {
  it("5–8: one send → distinct kitchen and bar chits; no AR Charge; no JournalEntry", async () => {
    const { club, items } = await bootstrapLounge();
    const p = await clubAdmin(club.id);
    const member = await makeMember(club.id);
    const check = await openCheck(p, club.id, { memberId: member.id });
    await addCheckLines(p, check.id, {
      items: [
        { menuItemId: items.burger.id, quantity: 1 },
        { menuItemId: items.stella.id, quantity: 1 },
      ],
    });

    const before = {
      charges: await db().charge.count({ where: { memberId: member.id } }),
      journalEntries: await db().journalEntry.count({ where: { clubId: club.id } }),
    };

    const result = await sendUnsentItems(p, check.id);
    expect(result.chitIds).toHaveLength(2); // one kitchen, one bar

    const chits = await db().pOSChit.findMany({ where: { checkId: check.id } });
    const stations = chits.map((c) => c.station).sort();
    expect(stations).toEqual(["BAR", "KITCHEN"]);

    const refreshed = await getCheck(p, check.id);
    // Check stayed open (SENT means all DRAFTs went out, but it's not CLOSED).
    expect(["SENT", "PARTIALLY_SENT"]).toContain(refreshed.status);
    expect(refreshed.lines.every((l) => l.status === "SENT")).toBe(true);

    // No financial side-effects from sending.
    const after = {
      charges: await db().charge.count({ where: { memberId: member.id } }),
      journalEntries: await db().journalEntry.count({ where: { clubId: club.id } }),
    };
    expect(after.charges).toBe(before.charges);
    expect(after.journalEntries).toBe(before.journalEntries);
  });

  it("9: second send only sends NEW draft items", async () => {
    const { club, items } = await bootstrapLounge();
    const p = await clubAdmin(club.id);
    const member = await makeMember(club.id);
    const check = await openCheck(p, club.id, { memberId: member.id });

    await addCheckLines(p, check.id, { items: [{ menuItemId: items.burger.id, quantity: 1 }] });
    const send1 = await sendUnsentItems(p, check.id);
    expect(send1.chitIds).toHaveLength(1);

    // Add a second round.
    await addCheckLines(p, check.id, { items: [{ menuItemId: items.stella.id, quantity: 1 }] });
    const send2 = await sendUnsentItems(p, check.id);
    expect(send2.chitIds).toHaveLength(1);

    // Now there should be exactly 2 chits total (one per round).
    const allChits = await db().pOSChit.findMany({ where: { checkId: check.id }, include: { lines: true } });
    expect(allChits).toHaveLength(2);
    // First chit's chit-line should be the burger; second the stella.
    const burgerChit = allChits.find((c) => c.station === "KITCHEN");
    const stellaChit = allChits.find((c) => c.station === "BAR");
    expect(burgerChit?.lines).toHaveLength(1);
    expect(stellaChit?.lines).toHaveLength(1);
  });
});

// ===========================================================================
// 10–13 — Station views + chit acknowledge / ready
// ===========================================================================
describe("Prep-station views and chit lifecycle", () => {
  it("10–11: kitchen view shows kitchen chits only; bar view shows bar chits only", async () => {
    const { club, items } = await bootstrapLounge();
    const p = await clubAdmin(club.id);
    const member = await makeMember(club.id);
    const check = await openCheck(p, club.id, { memberId: member.id });
    await addCheckLines(p, check.id, {
      items: [
        { menuItemId: items.burger.id, quantity: 1 },
        { menuItemId: items.stella.id, quantity: 1 },
      ],
    });
    await sendUnsentItems(p, check.id);

    const kitchen = await listChitsForStation(p, club.id, "KITCHEN");
    const bar = await listChitsForStation(p, club.id, "BAR");
    expect(kitchen).toHaveLength(1);
    expect(bar).toHaveLength(1);
    expect(kitchen[0].station).toBe("KITCHEN");
    expect(bar[0].station).toBe("BAR");
  });

  it("12–13: chit can be acknowledged then marked ready", async () => {
    const { club, items } = await bootstrapLounge();
    const p = await clubAdmin(club.id);
    const member = await makeMember(club.id);
    const check = await openCheck(p, club.id, { memberId: member.id });
    await addCheckLines(p, check.id, { items: [{ menuItemId: items.burger.id, quantity: 1 }] });
    const { chitIds } = await sendUnsentItems(p, check.id);
    const chitId = chitIds[0];

    await acknowledgeChit(p, chitId);
    let chit = await db().pOSChit.findUnique({ where: { id: chitId } });
    expect(chit?.status).toBe("ACKNOWLEDGED");
    expect(chit?.acknowledgedAt).toBeTruthy();

    await markChitReady(p, chitId);
    chit = await db().pOSChit.findUnique({ where: { id: chitId } });
    expect(chit?.status).toBe("READY");

    // Underlying check line should mirror.
    const lines = await db().pOSCheckLine.findMany({ where: { checkId: check.id } });
    expect(lines[0].status).toBe("READY");
  });
});

// ===========================================================================
// 14–15 — Void unsent / void sent (sent requires reason)
// ===========================================================================
describe("Removing and voiding items", () => {
  it("14: unsent (DRAFT) item is removed by removeCheckLine", async () => {
    const { club, items } = await bootstrapLounge();
    const p = await clubAdmin(club.id);
    const member = await makeMember(club.id);
    const check = await openCheck(p, club.id, { memberId: member.id });
    await addCheckLines(p, check.id, { items: [{ menuItemId: items.burger.id, quantity: 1 }] });
    const full = await getCheck(p, check.id);
    const lineId = full.lines[0].id;

    await removeCheckLine(p, lineId);
    const remaining = await db().pOSCheckLine.count({ where: { checkId: check.id } });
    expect(remaining).toBe(0);
  });

  it("14b: removeCheckLine refuses a SENT line — caller must void instead", async () => {
    const { club, items } = await bootstrapLounge();
    const p = await clubAdmin(club.id);
    const member = await makeMember(club.id);
    const check = await openCheck(p, club.id, { memberId: member.id });
    await addCheckLines(p, check.id, { items: [{ menuItemId: items.burger.id, quantity: 1 }] });
    await sendUnsentItems(p, check.id);
    const full = await getCheck(p, check.id);
    const lineId = full.lines[0].id;

    await expect(removeCheckLine(p, lineId)).rejects.toBeInstanceOf(ConflictError);
  });

  it("15: voidCheckLine requires a reason (min 3 chars) and stamps audit fields", async () => {
    const { club, items } = await bootstrapLounge();
    const p = await clubAdmin(club.id);
    const member = await makeMember(club.id);
    const check = await openCheck(p, club.id, { memberId: member.id });
    await addCheckLines(p, check.id, { items: [{ menuItemId: items.burger.id, quantity: 1 }] });
    await sendUnsentItems(p, check.id);
    const full = await getCheck(p, check.id);
    const lineId = full.lines[0].id;

    await expect(voidCheckLine(p, lineId, "")).rejects.toBeInstanceOf(ValidationError);
    await voidCheckLine(p, lineId, "Guest changed their mind");
    const line = await db().pOSCheckLine.findUnique({ where: { id: lineId } });
    expect(line?.status).toBe("VOIDED");
    expect(line?.voidedReason).toBe("Guest changed their mind");
    expect(line?.voidedByUserId).toBe(p.id);
  });
});

// ===========================================================================
// 16–19 — Settlement creates POSSale + AR Charge + balanced JE
// ===========================================================================
describe("Settlement", () => {
  it("16–19: settle closes check, creates POSSale + Charge + balanced JE; member balance recomputes", async () => {
    const { club, items } = await bootstrapLounge();
    const p = await clubAdmin(club.id);
    const member = await makeMember(club.id);
    const check = await openCheck(p, club.id, { memberId: member.id });
    await addCheckLines(p, check.id, {
      items: [
        { menuItemId: items.burger.id, quantity: 1 }, // $22
        { menuItemId: items.stella.id, quantity: 1 }, // $8
      ],
    });
    await sendUnsentItems(p, check.id);

    const balanceBefore = (await db().memberAccount.findUnique({ where: { memberId: member.id } }))?.currentBalance ?? 0;

    const { sale } = await settleCheck(p, check.id, { paymentMethod: "MEMBER_ACCOUNT" });
    expect(sale.status).toBe("COMPLETED");

    // Check is closed and linked.
    const closed = await db().pOSCheck.findUnique({ where: { id: check.id } });
    expect(closed?.status).toBe("CLOSED");
    expect(closed?.posSaleId).toBe(sale.id);

    // POSSale created with the expected total. $30 subtotal + 5% GST = $31.50.
    expect(Number(sale.grandTotal.toString())).toBeCloseTo(31.5, 2);

    // AR Charge linked + posted.
    expect(sale.arChargeId).toBeTruthy();
    const charge = await db().charge.findUnique({ where: { id: sale.arChargeId! } });
    expect(charge?.category).toBe("FOOD_BEVERAGE");
    expect(charge?.amount).toBeCloseTo(31.5, 2);

    // JE balances (debits === credits, > 0).
    expect(sale.postedJournalEntryId).toBeTruthy();
    const je = await db().journalEntry.findUnique({
      where: { id: sale.postedJournalEntryId! },
      include: { lines: true },
    });
    const dr = (je?.lines ?? []).reduce((s, l) => s + Number((l.debit ?? 0).toString()), 0);
    const cr = (je?.lines ?? []).reduce((s, l) => s + Number((l.credit ?? 0).toString()), 0);
    expect(dr).toBeCloseTo(cr, 6);
    expect(dr).toBeGreaterThan(0);

    // Member balance bumped.
    const balanceAfter = (await db().memberAccount.findUnique({ where: { memberId: member.id } }))?.currentBalance ?? 0;
    expect(Number(balanceAfter)).toBeCloseTo(Number(balanceBefore) + 31.5, 2);
  });

  it("25: empty check (no billable lines) cannot be settled", async () => {
    const { club } = await bootstrapLounge();
    const p = await clubAdmin(club.id);
    const member = await makeMember(club.id);
    const check = await openCheck(p, club.id, { memberId: member.id });
    await expect(settleCheck(p, check.id, { paymentMethod: "MEMBER_ACCOUNT" })).rejects.toBeInstanceOf(ConflictError);
  });

  it("25b: empty check has nothing to send", async () => {
    const { club } = await bootstrapLounge();
    const p = await clubAdmin(club.id);
    const member = await makeMember(club.id);
    const check = await openCheck(p, club.id, { memberId: member.id });
    await expect(sendUnsentItems(p, check.id)).rejects.toBeInstanceOf(ConflictError);
  });

  it("settle refuses unsent lines unless allowUnsentLines=true", async () => {
    const { club, items } = await bootstrapLounge();
    const p = await clubAdmin(club.id);
    const member = await makeMember(club.id);
    const check = await openCheck(p, club.id, { memberId: member.id });
    await addCheckLines(p, check.id, { items: [{ menuItemId: items.burger.id, quantity: 1 }] });
    // No send → settling without allowUnsentLines errors.
    await expect(settleCheck(p, check.id, { paymentMethod: "MEMBER_ACCOUNT" })).rejects.toBeInstanceOf(ConflictError);
    // With allowUnsentLines true, settlement proceeds.
    const { sale } = await settleCheck(p, check.id, { paymentMethod: "MEMBER_ACCOUNT", allowUnsentLines: true });
    expect(sale.status).toBe("COMPLETED");
  });
});

// ===========================================================================
// 20–21 — Member dining widget shows settled only; receipt is itemized
// ===========================================================================
describe("Member dining surfaces", () => {
  it("20–21: only settled checks surface as completed POSSales for the dining widget", async () => {
    const { club, items } = await bootstrapLounge();
    const p = await clubAdmin(club.id);
    const member = await makeMember(club.id);

    // Open check, add items, send — but DON'T settle.
    const open = await openCheck(p, club.id, { memberId: member.id });
    await addCheckLines(p, open.id, { items: [{ menuItemId: items.burger.id, quantity: 1 }] });
    await sendUnsentItems(p, open.id);

    // Open checks aren't POSSales yet — dining widget reads POSSale.
    const salesBefore = await db().pOSSale.count({
      where: { memberId: member.id, status: "COMPLETED", location: { code: LOUNGE_LOCATION_CODE } },
    });
    expect(salesBefore).toBe(0);

    // Settle a second check.
    const settle = await openCheck(p, club.id, { memberId: member.id });
    await addCheckLines(p, settle.id, { items: [{ menuItemId: items.burger.id, quantity: 1 }] });
    await sendUnsentItems(p, settle.id);
    const { sale } = await settleCheck(p, settle.id, { paymentMethod: "MEMBER_ACCOUNT" });

    const salesAfter = await db().pOSSale.findMany({
      where: { memberId: member.id, status: "COMPLETED", location: { code: LOUNGE_LOCATION_CODE } },
      include: { lines: true, fromCheck: true },
    });
    expect(salesAfter).toHaveLength(1);
    expect(salesAfter[0].id).toBe(sale.id);
    expect(salesAfter[0].fromCheck?.id).toBe(settle.id);
    // Receipt is itemised — lines reflect the original menu items.
    expect(salesAfter[0].lines.length).toBe(1);
    expect(salesAfter[0].lines[0].description).toBe(items.burger.name);
  });
});

// ===========================================================================
// 22 — Cross-tenant member cannot be charged
// ===========================================================================
describe("Tenant safety", () => {
  it("22: open check refuses a member from a different club", async () => {
    const { club: clubA } = await bootstrapLounge("Club A");
    const { club: clubB } = await bootstrapLounge("Club B");
    const adminA = await clubAdmin(clubA.id, "a");
    const memberB = await makeMember(clubB.id);
    await expect(openCheck(adminA, clubA.id, { memberId: memberB.id })).rejects.toThrow();
  });
});

// ===========================================================================
// 23–24 — Training mode and support read-only block settlement (not draft entry)
// ===========================================================================
describe("Posting guards", () => {
  it("23: training mode blocks settlement but allows opening / adding / sending", async () => {
    const { club, items } = await bootstrapLounge();
    const p = await clubAdmin(club.id);
    const member = await makeMember(club.id);
    const check = await openCheck(p, club.id, { memberId: member.id });
    await addCheckLines(p, check.id, { items: [{ menuItemId: items.burger.id, quantity: 1 }] });
    await sendUnsentItems(p, check.id);

    // Turn on training mode AFTER the operational work.
    await db().clubTrainingMode.create({
      data: { clubId: club.id, enabled: true, enabledByUserId: p.id, notes: "test", enabledAt: new Date() },
    });
    // Settlement should now be blocked.
    await expect(settleCheck(p, check.id, { paymentMethod: "MEMBER_ACCOUNT" })).rejects.toBeInstanceOf(TrainingModeBlockedError);
  });

  it("24: support read-only blocks settlement", async () => {
    const { club, items } = await bootstrapLounge();
    const supportEmail = `support-${club.id}@example.com`;
    await makeUser({ email: supportEmail, role: "SUPER_ADMIN", clubId: null });
    const p = await principalFor(supportEmail);
    p.activeClubId = club.id;
    p.memberships = [{ clubId: club.id, roleKey: "SUPER_ADMIN" }];
    const member = await makeMember(club.id);
    const check = await openCheck(p, club.id, { memberId: member.id });
    await addCheckLines(p, check.id, { items: [{ menuItemId: items.burger.id, quantity: 1 }] });
    await sendUnsentItems(p, check.id);

    const grant = await db().supportAccessGrant.create({
      data: {
        clubId: club.id, supportUserId: p.id,
        mode: "READ_ONLY", reason: "test",
        requestedByUserId: p.id,
        approvedAt: new Date(), approvedByUserId: p.id,
        expiresAt: new Date(Date.now() + 3600_000),
        status: "APPROVED",
      },
    });
    await db().supportSession.create({
      data: {
        clubId: club.id, supportUserId: p.id, grantId: grant.id,
        mode: "READ_ONLY",
        startedAt: new Date(),
      },
    });
    await expect(settleCheck(p, check.id, { paymentMethod: "MEMBER_ACCOUNT" })).rejects.toBeInstanceOf(SupportReadOnlyError);
  });
});

// ===========================================================================
// listOpenChecks — convenience smoke test
// ===========================================================================
describe("Open-checks list", () => {
  it("voidCheck cancels active chits so they disappear from station displays", async () => {
    const { club, items } = await bootstrapLounge();
    const p = await clubAdmin(club.id);
    const member = await makeMember(club.id);
    const check = await openCheck(p, club.id, { memberId: member.id });
    await addCheckLines(p, check.id, {
      items: [
        { menuItemId: items.burger.id, quantity: 1 },
        { menuItemId: items.stella.id, quantity: 1 },
      ],
    });
    await sendUnsentItems(p, check.id);
    // Both stations have an active chit
    expect((await listChitsForStation(p, club.id, "KITCHEN")).length).toBe(1);
    expect((await listChitsForStation(p, club.id, "BAR")).length).toBe(1);

    await voidCheck(p, check.id, "Server error");

    // Chits are now CANCELLED → no longer surface on station views
    expect((await listChitsForStation(p, club.id, "KITCHEN")).length).toBe(0);
    expect((await listChitsForStation(p, club.id, "BAR")).length).toBe(0);
    // Check itself is VOIDED + dropped from the open-checks list
    expect((await listOpenChecks(p, club.id)).length).toBe(0);
  });

  it("listOpenChecks excludes settled and voided checks", async () => {
    const { club, items } = await bootstrapLounge();
    const p = await clubAdmin(club.id);
    const m1 = await makeMember(club.id, { firstName: "Open" });
    const m2 = await makeMember(club.id, { firstName: "Closed" });

    // Open one and leave it.
    await openCheck(p, club.id, { memberId: m1.id });

    // Open one, send, settle.
    const closed = await openCheck(p, club.id, { memberId: m2.id });
    await addCheckLines(p, closed.id, { items: [{ menuItemId: items.burger.id, quantity: 1 }] });
    await sendUnsentItems(p, closed.id);
    await settleCheck(p, closed.id, { paymentMethod: "MEMBER_ACCOUNT" });

    const open = await listOpenChecks(p, club.id);
    expect(open).toHaveLength(1);
    expect(open[0].member?.firstName).toBe("Open");
  });
});

// ===========================================================================
// Check pacing — courses, manual fire, auto-pace timer
//
// Workflow under test:
//   1. Server puts a burger on course 1 (apps) and a fish on course 2 (mains).
//   2. Sends the check. Course 1 fires immediately (status=QUEUED), course 2
//      is HELD (firedAt=null).
//   3. Manual: server taps Fire course 2 → that chit promotes.
//   4. Auto: with autoFireGapMinutes=15, course 2's fireAt is set to 15 min
//      after send. The kitchen page loader (promoteDueHeldChits) promotes
//      chits once their fireAt is in the past.
// ===========================================================================
describe("Check pacing — coursing + auto-pace", () => {
  it("mixed-course send: course 1 → QUEUED + firedAt; course 2 → HELD + firedAt=null", async () => {
    const { club, items } = await bootstrapLounge();
    const p = await clubAdmin(club.id);
    const member = await makeMember(club.id);
    const check = await openCheck(p, club.id, { memberId: member.id });
    await addCheckLines(p, check.id, {
      items: [
        { menuItemId: items.burger.id, quantity: 1, course: 1 }, // apps
        { menuItemId: items.fish.id, quantity: 1, course: 2 },   // mains
      ],
    });
    await sendUnsentItems(p, check.id);

    const chits = await db().pOSChit.findMany({
      where: { checkId: check.id },
      orderBy: { course: "asc" },
    });
    expect(chits).toHaveLength(2);
    const [c1, c2] = chits;
    expect(c1.course).toBe(1);
    expect(c1.status).toBe("QUEUED");
    expect(c1.firedAt).toBeTruthy();
    expect(c2.course).toBe(2);
    expect(c2.status).toBe("HELD");
    expect(c2.firedAt).toBeNull();
    expect(c2.fireAt).toBeNull(); // no auto-pace was set

    // Station view should expose course 1 but not course 2.
    const active = await listChitsForStation(p, club.id, "KITCHEN");
    expect(active).toHaveLength(1);
    expect(active[0].id).toBe(c1.id);
    const held = await listHeldChitsForStation(p, club.id, "KITCHEN");
    expect(held).toHaveLength(1);
    expect(held[0].id).toBe(c2.id);
  });

  it("fireNextCourse promotes only the lowest-numbered held course", async () => {
    const { club, items } = await bootstrapLounge();
    const p = await clubAdmin(club.id);
    const member = await makeMember(club.id);
    const check = await openCheck(p, club.id, { memberId: member.id });
    // Course 1 (immediate), course 2 (held), course 3 (held).
    await addCheckLines(p, check.id, {
      items: [
        { menuItemId: items.burger.id, quantity: 1, course: 1 },
        { menuItemId: items.fish.id, quantity: 1, course: 2 },
        { menuItemId: items.stella.id, quantity: 1, course: 3 },
      ],
    });
    await sendUnsentItems(p, check.id);

    const before = await db().pOSChit.findMany({ where: { checkId: check.id }, orderBy: { course: "asc" } });
    expect(before.map((c) => c.status)).toEqual(["QUEUED", "HELD", "HELD"]);

    const r = await fireNextCourse(p, check.id);
    expect(r.fired).toBe(1);
    expect(r.course).toBe(2);

    const after = await db().pOSChit.findMany({ where: { checkId: check.id }, orderBy: { course: "asc" } });
    expect(after[0].status).toBe("QUEUED");
    expect(after[1].status).toBe("QUEUED"); // course 2 now active
    expect(after[1].firedAt).toBeTruthy();
    expect(after[2].status).toBe("HELD");   // course 3 still waiting
    expect(after[2].firedAt).toBeNull();
  });

  it("autoFireGapMinutes sets fireAt on held chits relative to send time", async () => {
    const { club, items } = await bootstrapLounge();
    const p = await clubAdmin(club.id);
    const member = await makeMember(club.id);
    const check = await openCheck(p, club.id, { memberId: member.id });
    await setAutoPace(p, check.id, 15);
    await addCheckLines(p, check.id, {
      items: [
        { menuItemId: items.burger.id, quantity: 1, course: 1 },
        { menuItemId: items.fish.id, quantity: 1, course: 2 },
        { menuItemId: items.stella.id, quantity: 1, course: 3 },
      ],
    });
    const sendStart = Date.now();
    await sendUnsentItems(p, check.id);

    const chits = await db().pOSChit.findMany({ where: { checkId: check.id }, orderBy: { course: "asc" } });
    // Course 1: no fireAt (already fired).
    expect(chits[0].fireAt).toBeNull();
    expect(chits[0].firedAt).toBeTruthy();
    // Course 2: fireAt ≈ send + 15 min.
    const fireAt2Ms = chits[1].fireAt!.getTime();
    expect(fireAt2Ms - sendStart).toBeGreaterThanOrEqual(15 * 60_000 - 1000);
    expect(fireAt2Ms - sendStart).toBeLessThanOrEqual(15 * 60_000 + 5000);
    // Course 3: fireAt ≈ send + 30 min.
    const fireAt3Ms = chits[2].fireAt!.getTime();
    expect(fireAt3Ms - sendStart).toBeGreaterThanOrEqual(30 * 60_000 - 1000);
    expect(fireAt3Ms - sendStart).toBeLessThanOrEqual(30 * 60_000 + 5000);
  });

  it("promoteDueHeldChits flips a HELD chit whose fireAt has passed", async () => {
    const { club, items } = await bootstrapLounge();
    const p = await clubAdmin(club.id);
    const member = await makeMember(club.id);
    const check = await openCheck(p, club.id, { memberId: member.id });
    await addCheckLines(p, check.id, {
      items: [
        { menuItemId: items.burger.id, quantity: 1, course: 1 },
        { menuItemId: items.fish.id, quantity: 1, course: 2 },
      ],
    });
    await sendUnsentItems(p, check.id);

    // Force the course-2 chit's fireAt into the past so the sweep
    // should promote it. (We don't wait 15 real minutes in tests.)
    await db().pOSChit.updateMany({
      where: { checkId: check.id, course: 2 },
      data: { fireAt: new Date(Date.now() - 60_000) },
    });

    const r = await promoteDueHeldChits(club.id, "KITCHEN");
    expect(r.promoted).toBe(1);

    const c2 = await db().pOSChit.findFirst({ where: { checkId: check.id, course: 2 } });
    expect(c2?.status).toBe("QUEUED");
    expect(c2?.firedAt).toBeTruthy();
    expect(c2?.fireAt).toBeNull();
  });

  it("voidCheck cancels HELD chits as well as active ones", async () => {
    const { club, items } = await bootstrapLounge();
    const p = await clubAdmin(club.id);
    const member = await makeMember(club.id);
    const check = await openCheck(p, club.id, { memberId: member.id });
    await addCheckLines(p, check.id, {
      items: [
        { menuItemId: items.burger.id, quantity: 1, course: 1 },
        { menuItemId: items.fish.id, quantity: 1, course: 2 },
      ],
    });
    await sendUnsentItems(p, check.id);
    // Confirm we have one active + one held before voiding.
    expect((await listChitsForStation(p, club.id, "KITCHEN")).length).toBe(1);
    expect((await listHeldChitsForStation(p, club.id, "KITCHEN")).length).toBe(1);

    await voidCheck(p, check.id, "Walk-out");

    // Both kitchen lists empty — held chit was cancelled too.
    expect((await listChitsForStation(p, club.id, "KITCHEN")).length).toBe(0);
    expect((await listHeldChitsForStation(p, club.id, "KITCHEN")).length).toBe(0);
    const heldChit = await db().pOSChit.findFirst({ where: { checkId: check.id, course: 2 } });
    expect(heldChit?.status).toBe("CANCELLED");
  });

  it("acknowledge / markReady refuse to act on a HELD chit", async () => {
    const { club, items } = await bootstrapLounge();
    const p = await clubAdmin(club.id);
    const member = await makeMember(club.id);
    const check = await openCheck(p, club.id, { memberId: member.id });
    await addCheckLines(p, check.id, {
      items: [
        { menuItemId: items.burger.id, quantity: 1, course: 1 },
        { menuItemId: items.fish.id, quantity: 1, course: 2 },
      ],
    });
    await sendUnsentItems(p, check.id);
    const held = await db().pOSChit.findFirst({ where: { checkId: check.id, course: 2 } });
    expect(held?.status).toBe("HELD");
    await expect(acknowledgeChit(p, held!.id)).rejects.toBeInstanceOf(ConflictError);
    await expect(markChitReady(p, held!.id)).rejects.toBeInstanceOf(ConflictError);
  });
});

// ===========================================================================
// PDF chit linked to the GL transaction.
//
// Every settled POSSale must carry an immutable SIGNATURE chit row so
// auditors can walk JE → POSSale → POSSaleChit and pull the exact
// receipt the journal entry corresponds to. The same path runs for
// both QR_PAY and MEMBER_ACCOUNT settlements.
// ===========================================================================
describe("Chit snapshot at settlement", () => {
  it("settling on member account writes a SIGNATURE POSSaleChit linked to the sale", async () => {
    const { club, items } = await bootstrapLounge();
    const p = await clubAdmin(club.id);
    const member = await makeMember(club.id);
    const check = await openCheck(p, club.id, { memberId: member.id });
    await addCheckLines(p, check.id, { items: [{ menuItemId: items.burger.id, quantity: 1 }] });
    await sendUnsentItems(p, check.id);
    const { sale } = await settleCheck(p, check.id, { paymentMethod: "MEMBER_ACCOUNT" });

    const chit = await db().pOSSaleChit.findUnique({
      where: { saleId_type: { saleId: sale.id, type: "SIGNATURE" } },
    });
    expect(chit).not.toBeNull();
    expect(chit?.byteSize).toBeGreaterThan(500); // a real PDF is at least ~1KB
    expect(chit?.clubId).toBe(club.id);
    // PDFs start with %PDF — quick sanity that the bytes are a real PDF.
    expect(chit!.pdfBytes.subarray(0, 4).toString()).toBe("%PDF");
    // And the chit links back through the sale to the posted JE.
    const reloaded = await db().pOSSale.findUnique({
      where: { id: sale.id },
      select: { postedJournalEntryId: true, chits: { select: { type: true } } },
    });
    expect(reloaded?.postedJournalEntryId).toBeTruthy();
    expect(reloaded?.chits.map((c) => c.type)).toContain("SIGNATURE");
  });

  it("QR_PAY: settle requests payment (no chit yet); chit + close happen only after confirmQRPayment", async () => {
    const { confirmQRPayment } = await import("@/lib/pos/checks");
    const { club, items } = await bootstrapLounge();
    const p = await clubAdmin(club.id);
    const member = await makeMember(club.id);
    const check = await openCheck(p, club.id, { memberId: member.id });
    await addCheckLines(p, check.id, { items: [{ menuItemId: items.burger.id, quantity: 1 }] });
    await sendUnsentItems(p, check.id);
    const { sale } = await settleCheck(p, check.id, {
      paymentMethod: "QR_PAY",
      origin: "https://test.spectre.example",
    });
    // Pending state: check is PAYMENT_PENDING, no chit snapshot yet,
    // sale is still DRAFT (no AR Charge / JE).
    const pendingCheck = await db().pOSCheck.findUnique({ where: { id: check.id } });
    expect(pendingCheck?.status).toBe("PAYMENT_PENDING");
    expect(pendingCheck?.closedAt).toBeNull();
    const pendingChit = await db().pOSSaleChit.findUnique({
      where: { saleId_type: { saleId: sale.id, type: "SIGNATURE" } },
    });
    expect(pendingChit).toBeNull();
    const pendingPayment = await db().pOSPayment.findFirst({ where: { saleId: sale.id } });
    expect(pendingPayment?.externalPaymentStatus).toBe("PENDING");

    // Confirm — now the chit + GL posting + close all kick in.
    await confirmQRPayment(p, sale.id, { origin: "https://test.spectre.example" });
    const closed = await db().pOSCheck.findUnique({ where: { id: check.id } });
    expect(closed?.status).toBe("CLOSED");
    expect(closed?.closedAt).not.toBeNull();
    expect(closed?.settlementMethod).toBe("QR_PAY");
    const confirmedChit = await db().pOSSaleChit.findUnique({
      where: { saleId_type: { saleId: sale.id, type: "SIGNATURE" } },
    });
    expect(confirmedChit).not.toBeNull();
    expect(confirmedChit?.byteSize).toBeGreaterThan(500);
    expect(confirmedChit!.pdfBytes.subarray(0, 4).toString()).toBe("%PDF");
    const confirmedPayment = await db().pOSPayment.findFirst({ where: { saleId: sale.id } });
    expect(confirmedPayment?.externalPaymentStatus).toBe("CONFIRMED");
    expect(confirmedPayment?.confirmedAt).not.toBeNull();
  });
});
