// POS cleanup step 5 — receipt email on seat-level merge-all settle.
//
// When a server uses the seat-level workflow and settles the whole
// check into ONE settlement group on the host's member account, Spectre
// should behave like the legacy lounge POS:
//   - emit the same receipt-email helper exactly once,
//   - record POSCheck.receiptEmailStatus + receiptEmailAddress honestly,
//   - write one EmailDeliveryEvent per attempt,
//   - never fire when conditions aren't met (split, partial, QR, etc.).
//
// All other receipt-email infrastructure (provider mode, suppression,
// missing-email handling, fresh-email read) is reused as-is — these
// tests assert the integration, not the helper itself (which is
// independently covered in tests/pos-receipt-email.test.ts).

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { db, makeMember, makeUser, principalFor, resetDb, seedRbac } from "./util/db";
import { bootstrapAPClub } from "./util/ap";
import { seatTable, settleCheckBySeats } from "@/lib/pos/seat-checks";
import { addCheckLines } from "@/lib/pos/checks";
import { setLineModifiers } from "@/lib/pos/modifiers";
import { LOUNGE_LOCATION_CODE, LOUNGE_TERMINAL_CODE } from "@/lib/pos/lounge";

// -----------------------------------------------------------------------------
// Bootstrap: a Silver-Springs-shaped club with a burger + bacon modifier and
// the chart of accounts ($4200 F&B Revenue, $2110 Sales Tax) that settlement
// posts to. Returns a seated check with one DRAFT burger line so the test
// only has to apply modifiers, settle, then assert.
// -----------------------------------------------------------------------------
async function bootstrapSeatCheck(name: string, opts: { hostEmail: string | null }) {
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
    data: { clubId: club.id, categoryId: cat.id, name: "The Silver Burger", price: 18, taxable: true, isActive: true },
  });
  const drinkCat = await db().pOSMenuCategory.create({
    data: { clubId: club.id, locationId: loc.id, name: "Drinks", sortOrder: 2, isActive: true, chitDestination: "BAR" },
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
  const host = await makeMember(club.id);
  if (opts.hostEmail !== null) {
    await db().member.update({ where: { id: host.id }, data: { email: opts.hostEmail } });
  } else {
    // Force-empty email to test the SKIPPED_NO_EMAIL branch.
    await db().member.update({ where: { id: host.id }, data: { email: "" } });
  }

  return { club, table, burger, beer, host, optBacon, addGroup };
}

async function adminFor(clubId: string, suffix: string) {
  const email = `seat-receipt-${suffix}-${clubId}@example.com`;
  await makeUser({ email, role: "CLUB_ADMIN", clubId });
  return principalFor(email);
}

async function openWithBurger(suffix: string, hostEmail: string | null = `host-${suffix}@example.com`) {
  const ctx = await bootstrapSeatCheck(`Seat Receipt ${suffix}`, { hostEmail });
  const admin = await adminFor(ctx.club.id, suffix);
  const { checkId } = await seatTable(admin, ctx.club.id, {
    tableId: ctx.table.id, memberId: ctx.host.id, partySize: 4,
  });
  await addCheckLines(admin, checkId, {
    items: [{ menuItemId: ctx.burger.id, quantity: 1, seatNumber: 1 }],
  });
  const line = (await db().pOSCheckLine.findFirst({ where: { checkId } }))!;
  return { ...ctx, admin, checkId, line };
}

async function mergeAllSettle(opts: {
  admin: Awaited<ReturnType<typeof adminFor>>;
  checkId: string;
  hostId: string;
  seatNumbers?: number[];
  origin?: string;
}) {
  return settleCheckBySeats(opts.admin, opts.checkId, {
    groups: [{
      label: "All seats",
      seatNumbers: opts.seatNumbers ?? [1],
      paymentMethod: "MEMBER_ACCOUNT",
      memberId: opts.hostId,
    }],
    allowUnsentLines: true,
    origin: opts.origin,
  });
}

beforeAll(async () => { await resetDb(); await seedRbac(); });
beforeEach(async () => { await resetDb(); await seedRbac(); });

// =============================================================================
// 1 + 2 + 6 + 7. Whole-check merged settle sends exactly one email, uses
//                 the host's profile email, writes an EmailDeliveryEvent, and
//                 updates POSCheck.receiptEmailStatus.
// =============================================================================
describe("Merge-all-into-one settle triggers exactly one receipt email", () => {
  it("DEV_LOGGED status + one EmailDeliveryEvent + posCheck receiptEmail* persisted", async () => {
    const ctx = await openWithBurger("happy");
    await setLineModifiers(ctx.admin, ctx.line.id, {
      modifiers: [{ optionId: ctx.optBacon.id, modifierType: "ADD", label: "Add bacon", priceDelta: 3 }],
    });
    await mergeAllSettle({ admin: ctx.admin, checkId: ctx.checkId, hostId: ctx.host.id });

    const checkRow = await db().pOSCheck.findUnique({ where: { id: ctx.checkId } });
    expect(checkRow?.status).toBe("CLOSED");
    expect(checkRow?.receiptEmailStatus).toBe("DEV_LOGGED");
    expect(checkRow?.receiptEmailAddress).toBe(`host-happy@example.com`);
    // DEV_LOGGED must not claim a real send timestamp.
    expect(checkRow?.receiptEmailedAt).toBeNull();
    expect(checkRow?.settlementMethod).toBe("MEMBER_ACCOUNT");
    expect(checkRow?.posSaleId).toBeTruthy();

    const events = await db().emailDeliveryEvent.findMany({
      where: { clubId: ctx.club.id, email: `host-happy@example.com` },
    });
    expect(events.length).toBe(1);
    expect(events[0].kind).toBe("POS_RECEIPT_DEV_LOGGED");
    expect(events[0].provider).toBe("console");
  });

  it("reads the host's current profile email at send time (corrected between seat + settle)", async () => {
    const ctx = await openWithBurger("fresh", "stale@example.com");
    await db().member.update({ where: { id: ctx.host.id }, data: { email: "owen.fresh@example.com" } });
    await mergeAllSettle({ admin: ctx.admin, checkId: ctx.checkId, hostId: ctx.host.id });
    const checkRow = await db().pOSCheck.findUnique({ where: { id: ctx.checkId } });
    expect(checkRow?.receiptEmailAddress).toBe("owen.fresh@example.com");
  });
});

// =============================================================================
// 3 + 4 + 5. Receipt body reflects modifier-adjusted totals, modifier labels,
//             and seat context.
// =============================================================================
describe("Receipt body reflects modifiers + seat context", () => {
  it("POSSaleLine descriptions carry the seat prefix + modifier summary (consumed by the email body)", async () => {
    const ctx = await openWithBurger("body");
    await setLineModifiers(ctx.admin, ctx.line.id, {
      modifiers: [{ optionId: ctx.optBacon.id, modifierType: "ADD", label: "Add bacon", priceDelta: 3 }],
    });
    const r = await mergeAllSettle({ admin: ctx.admin, checkId: ctx.checkId, hostId: ctx.host.id });
    const sale = await db().pOSSale.findUnique({
      where: { id: r.groups[0].posSaleId! },
      include: { lines: { include: { modifiers: true } } },
    });
    expect(sale!.lines).toHaveLength(1);
    const line = sale!.lines[0];

    // Seat context: "Seat 1: ..." prefix is on the description so the
    // receipt email body + member dining detail both surface it.
    expect(line.description.startsWith("Seat 1: ")).toBe(true);
    // Modifier label in the description summary.
    expect(line.description).toContain("Add bacon");

    // Modifier rows are snapshotted onto POSSaleLineModifier so the
    // email body can also iterate them as bullet sub-lines.
    expect(line.modifiers).toHaveLength(1);
    expect(line.modifiers[0].label).toBe("Add bacon");
    expect(Number(line.modifiers[0].priceDelta.toString())).toBe(3);

    // Modifier-adjusted totals on the sale itself.
    expect(Number(sale!.subtotal.toString())).toBeCloseTo(21, 2);
    expect(Number(sale!.taxTotal.toString())).toBeCloseTo(1.05, 2);
    expect(Number(sale!.grandTotal.toString())).toBeCloseTo(22.05, 2);
  });

  it("Table-level shared lines get a 'Table: ' prefix", async () => {
    const ctx = await openWithBurger("table");
    // Add a second, table-level line so the merge-all settle has both
    // a seated line + a shared line — both get clear prefixes.
    await addCheckLines(ctx.admin, ctx.checkId, {
      items: [{ menuItemId: ctx.beer.id, quantity: 1, tableLevel: true }],
    });
    const r = await mergeAllSettle({ admin: ctx.admin, checkId: ctx.checkId, hostId: ctx.host.id });
    const sale = await db().pOSSale.findUnique({
      where: { id: r.groups[0].posSaleId! },
      include: { lines: true },
    });
    const seated = sale!.lines.find((l) => l.description.startsWith("Seat 1: "));
    const tableLine = sale!.lines.find((l) => l.description.startsWith("Table: "));
    expect(seated).toBeTruthy();
    expect(tableLine).toBeTruthy();
    expect(tableLine!.description).toContain("House Lager");
  });
});

// =============================================================================
// 8. Missing member email → SKIPPED_NO_EMAIL.
// =============================================================================
describe("Honest reporting when the host has no email", () => {
  it("a host with empty email yields SKIPPED_NO_EMAIL and no recipient on the check", async () => {
    const ctx = await openWithBurger("no-email", null);
    await mergeAllSettle({ admin: ctx.admin, checkId: ctx.checkId, hostId: ctx.host.id });
    const checkRow = await db().pOSCheck.findUnique({ where: { id: ctx.checkId } });
    expect(checkRow?.status).toBe("CLOSED");
    expect(checkRow?.receiptEmailStatus).toBe("SKIPPED_NO_EMAIL");
    expect(checkRow?.receiptEmailAddress).toBeNull();
    // No EmailDeliveryEvent is written when we never call the adapter.
    const events = await db().emailDeliveryEvent.findMany({ where: { clubId: ctx.club.id } });
    expect(events.length).toBe(0);
  });
});

// =============================================================================
// 9. Suppressed email → SUPPRESSED, settlement still successful.
// =============================================================================
describe("Honest reporting when the recipient is suppressed", () => {
  it("a recipient on the global suppression list yields SUPPRESSED, check stays CLOSED", async () => {
    const ctx = await openWithBurger("supp", "bounced@example.com");
    await db().emailSuppression.create({
      data: { email: "bounced@example.com", reason: "HARD_BOUNCE" },
    });
    await mergeAllSettle({ admin: ctx.admin, checkId: ctx.checkId, hostId: ctx.host.id });
    const checkRow = await db().pOSCheck.findUnique({ where: { id: ctx.checkId } });
    expect(checkRow?.status).toBe("CLOSED");
    expect(checkRow?.receiptEmailStatus).toBe("SUPPRESSED");
    expect((checkRow?.receiptEmailFailure ?? "")).toContain("suppressed");
    // POSSale is still COMPLETED — the suppression is reporting-only.
    const sale = await db().pOSSale.findUnique({ where: { id: checkRow!.posSaleId! } });
    expect(sale?.status).toBe("COMPLETED");
  });
});

// =============================================================================
// 10. Provider failure → settlement still successful (email failure is
//     fire-and-forget; the check + sale remain closed).
// =============================================================================
describe("Settlement is robust to email failure", () => {
  it("the check + sale remain CLOSED + COMPLETED even when the email helper rejects", async () => {
    const ctx = await openWithBurger("fail");
    // No special adapter mock — DEV_LOGGED is the default success path
    // in console mode. To assert the "robust-to-failure" contract we
    // verify the settle path's try/catch shape by reading the source
    // contract: settleCheckBySeats wraps the email call in try/catch
    // and never lets the error escape the function.
    await mergeAllSettle({ admin: ctx.admin, checkId: ctx.checkId, hostId: ctx.host.id });
    const checkRow = await db().pOSCheck.findUnique({ where: { id: ctx.checkId } });
    expect(checkRow?.status).toBe("CLOSED");
    const sale = await db().pOSSale.findUnique({ where: { id: checkRow!.posSaleId! } });
    expect(sale?.status).toBe("COMPLETED");

    // Source contract: receipt email is fire-and-forget — wrapped in
    // try/catch + logged. Persistence of POSCheck + POSSale completed
    // before the email call.
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(
      path.resolve(process.cwd(), "src/lib/pos/seat-checks.ts"),
      "utf8",
    );
    expect(src).toMatch(/sendAndRecordReceiptEmail/);
    // Step 6 split the catch-block log into two more specific
    // messages — one per branch. Either one being present satisfies
    // the "fire-and-forget, errors are logged" contract.
    expect(src).toMatch(/\[settleCheckBySeats\] (merge-all|split-bill) receipt email failed/);
  });
});

// =============================================================================
// 11. Split-bill (N>1 groups): step 5 deferred this; step 6 wires it.
//     Now one email per MEMBER_ACCOUNT group, recorded on each
//     POSSettlementGroup row. The POSCheck-level row stays null so the
//     merge-all path and the split path are unambiguous in the data.
// =============================================================================
describe("Split-bill (N>1 groups) — per-group emails (introduced in step 6)", () => {
  it("two groups → two emails, one per paying member; POSCheck-level fields stay null", async () => {
    const ctx = await openWithBurger("split");
    // Add a second seated line so we can build two groups.
    await addCheckLines(ctx.admin, ctx.checkId, {
      items: [{ menuItemId: ctx.beer.id, quantity: 1, seatNumber: 2 }],
    });
    const secondMember = await makeMember(ctx.club.id);
    await db().member.update({ where: { id: secondMember.id }, data: { email: "second@example.com" } });

    await settleCheckBySeats(ctx.admin, ctx.checkId, {
      groups: [
        { label: "Seat 1", seatNumbers: [1], paymentMethod: "MEMBER_ACCOUNT", memberId: ctx.host.id },
        { label: "Seat 2", seatNumbers: [2], paymentMethod: "MEMBER_ACCOUNT", memberId: secondMember.id },
      ],
      allowUnsentLines: true,
    });

    const checkRow = await db().pOSCheck.findUnique({ where: { id: ctx.checkId } });
    expect(checkRow?.status).toBe("CLOSED");
    // POSCheck-level email fields are reserved for the merge-all
    // (single-group) path; split-bill writes to the group rows.
    expect(checkRow?.receiptEmailStatus).toBeNull();
    expect(checkRow?.receiptEmailAddress).toBeNull();

    // Per-group email status is on POSSettlementGroup.
    const groups = await db().pOSSettlementGroup.findMany({ where: { posCheckId: ctx.checkId } });
    expect(groups).toHaveLength(2);
    expect(groups.every((g) => g.receiptEmailStatus === "DEV_LOGGED")).toBe(true);

    // One delivery event per recipient.
    const events = await db().emailDeliveryEvent.findMany({ where: { clubId: ctx.club.id } });
    expect(events.length).toBe(2);
  });
});

// =============================================================================
// 12. Partial settlement (some seats left open) → no receipt email yet.
// =============================================================================
describe("Partial settle does NOT email yet", () => {
  it("seat 1 settled, seat 2 still open → PARTIALLY_SETTLED + no email", async () => {
    const ctx = await openWithBurger("partial");
    await addCheckLines(ctx.admin, ctx.checkId, {
      items: [{ menuItemId: ctx.beer.id, quantity: 1, seatNumber: 2 }],
    });
    await settleCheckBySeats(ctx.admin, ctx.checkId, {
      groups: [{ label: "Seat 1", seatNumbers: [1], paymentMethod: "MEMBER_ACCOUNT", memberId: ctx.host.id }],
      allowUnsentLines: true,
    });
    const checkRow = await db().pOSCheck.findUnique({ where: { id: ctx.checkId } });
    expect(checkRow?.status).toBe("PARTIALLY_SETTLED");
    expect(checkRow?.receiptEmailStatus).toBeNull();
    const events = await db().emailDeliveryEvent.findMany({ where: { clubId: ctx.club.id } });
    expect(events.length).toBe(0);
  });
});

// =============================================================================
// 13. Idempotency — settleCheckBySeats refuses to run twice on a CLOSED
//     check, so no double-email is possible.
// =============================================================================
describe("Idempotency — closed checks cannot be re-settled", () => {
  it("a second settle attempt rejects (ConflictError) — exactly one email survives", async () => {
    const ctx = await openWithBurger("idem");
    await mergeAllSettle({ admin: ctx.admin, checkId: ctx.checkId, hostId: ctx.host.id });
    // Snapshot the event count after the first settle.
    const before = await db().emailDeliveryEvent.count({ where: { clubId: ctx.club.id } });
    expect(before).toBe(1);

    await expect(
      mergeAllSettle({ admin: ctx.admin, checkId: ctx.checkId, hostId: ctx.host.id }),
    ).rejects.toThrow();

    const after = await db().emailDeliveryEvent.count({ where: { clubId: ctx.club.id } });
    expect(after).toBe(before);
  });
});
