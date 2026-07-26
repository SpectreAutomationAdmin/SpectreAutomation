// POS cleanup step 20 — QR-payment unsettled-amount bug fix.
//
// Reported symptom: with a SENT Wagyu Beef Dumplings line on the
// check, "Pay by QR Code" threw "No unsettled amount on this check —
// nothing to charge".
//
// Root cause: initiateWholeCheckQRPayment's computeUnsettledTotal
// filtered with `settlementGroupId: null` — strict-null, whereas
// settleCheckBySeats does NOT filter on settlementGroupId at all.
// A line that had been stamped by a prior aborted settle attempt
// was invisible to the QR calculator but would still be picked up
// by the settle engine. Plus COMPED lines were never excluded.
//
// These tests pin:
//   - SENT / READY / SERVED / DRAFT all count
//   - VOIDED + COMPED are excluded
//   - Already-SETTLED group's lines are excluded
//   - A line in a non-SETTLED group is STILL counted (the bug fix)
//   - QR amount === settle modal total (priced-line math is the same)
//   - Disabled-charge-account member can QR-pay
//   - End-to-end CONFIRMED still posts, closes, and flips the table
//   - DECLINED leaves the check active
//   - The new error messages are surfaced under the right conditions

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { db, makeMember, makeUser, principalFor, resetDb, seedRbac } from "./util/db";
import { bootstrapAPClub } from "./util/ap";
import {
  initiateWholeCheckQRPayment,
  confirmQRPayment,
  declineQRPayment,
} from "@/lib/pos/qr-payment";
import { seatTable, settleCheckBySeats } from "@/lib/pos/seat-checks";
import { addCheckLines, sendUnsentItems } from "@/lib/pos/checks";
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
  const area = await db().diningArea.create({
    data: { clubId: club.id, name: "Lounge", sortOrder: 0 },
  });
  const table = await db().diningTable.create({
    data: {
      clubId: club.id, diningAreaId: area.id, tableNumber: "L3", capacity: 4,
      shape: "SQUARE", xPos: 100, yPos: 100, width: 110, height: 110,
    },
  });
  const cat = await db().pOSMenuCategory.create({
    data: { clubId: club.id, locationId: loc.id, name: "Mains", sortOrder: 1, isActive: true, chitDestination: "KITCHEN" },
  });
  // Wagyu Beef Dumplings — same shape as the user's reproduction:
  // taxable mains line at $16, kitchen-routed.
  const wagyu = await db().pOSMenuItem.create({
    data: { clubId: club.id, categoryId: cat.id, name: "Wagyu Beef Dumplings", price: 16, taxable: true, isActive: true },
  });
  const adminEmail = `qr-amt-${club.id}@example.com`;
  await makeUser({ email: adminEmail, role: "CLUB_ADMIN", clubId: club.id });
  const admin = await principalFor(adminEmail);
  return { club, loc, table, admin, wagyu };
}

async function disabledMember(clubId: string, memberNumber: string, firstName = "Margaret", lastName = "Holloway") {
  const m = await makeMember(clubId, { firstName, lastName });
  await db().member.update({
    where: { id: m.id },
    data: { memberNumber, accessStatus: "CHARGE_ACCOUNT_SUSPENDED", email: `${memberNumber}@example.com` },
  });
  return m;
}

beforeAll(async () => { await resetDb(); await seedRbac(); });
beforeEach(async () => { await resetDb(); await seedRbac(); });

// =============================================================================
// Specs 1, 2, 3 — SENT / READY / SERVED line statuses all count.
// =============================================================================
describe("Specs 1/2/3 — SENT / READY / SERVED lines are unsettled", () => {
  for (const status of ["SENT", "READY", "SERVED"] as const) {
    it(`includes a ${status} Wagyu line in the QR amount`, async () => {
      const ctx = await bootstrapLounge(`status-${status.toLowerCase()}`);
      const margaret = await disabledMember(ctx.club.id, "0613");
      const { checkId } = await seatTable(ctx.admin, ctx.club.id, {
        tableId: ctx.table.id, memberNumber: "0613", partySize: 2,
      });
      await addCheckLines(ctx.admin, checkId, {
        items: [{ menuItemId: ctx.wagyu.id, quantity: 1, seatNumber: 1 }],
      });
      // Force the line to the target status. Bypasses the chit path
      // because we're testing the QR filter, not the kitchen flow.
      await db().pOSCheckLine.updateMany({
        where: { checkId }, data: { status },
      });
      const payment = await initiateWholeCheckQRPayment(ctx.admin, ctx.club.id, {
        checkId, memberId: margaret.id, origin: "http://localhost:3000",
      });
      expect(Number(payment.amount.toString())).toBe(16.80); // 16 + 5% GST
    });
  }
});

// =============================================================================
// Spec 4 — DRAFT line counts (kitchen status, not settlement status).
// =============================================================================
describe("Spec 4 — DRAFT lines are unsettled too", () => {
  it("a DRAFT Wagyu line still feeds the QR amount", async () => {
    const ctx = await bootstrapLounge("status-draft");
    const margaret = await disabledMember(ctx.club.id, "0613");
    const { checkId } = await seatTable(ctx.admin, ctx.club.id, {
      tableId: ctx.table.id, memberNumber: "0613", partySize: 2,
    });
    await addCheckLines(ctx.admin, checkId, {
      items: [{ menuItemId: ctx.wagyu.id, quantity: 1, seatNumber: 1 }],
    });
    // Don't send to kitchen — line stays DRAFT.
    const payment = await initiateWholeCheckQRPayment(ctx.admin, ctx.club.id, {
      checkId, memberId: margaret.id, origin: "http://localhost:3000",
    });
    expect(Number(payment.amount.toString())).toBe(16.80);
  });
});

// =============================================================================
// Spec 5 — Wagyu Beef Dumplings shape works end-to-end (regression test).
// =============================================================================
describe("Spec 5 — Wagyu Beef Dumplings shape reaches the QR amount", () => {
  it("the exact user-reproduction shape generates a QR payment, not the false-negative error", async () => {
    const ctx = await bootstrapLounge("wagyu-repro");
    const margaret = await disabledMember(ctx.club.id, "0613");
    const { checkId } = await seatTable(ctx.admin, ctx.club.id, {
      tableId: ctx.table.id, memberNumber: "0613", partySize: 2,
    });
    await addCheckLines(ctx.admin, checkId, {
      items: [{ menuItemId: ctx.wagyu.id, quantity: 1, seatNumber: 1 }],
    });
    await sendUnsentItems(ctx.admin, checkId);

    const payment = await initiateWholeCheckQRPayment(ctx.admin, ctx.club.id, {
      checkId, memberId: margaret.id, origin: "http://localhost:3000",
    });
    expect(payment.status).toBe("QR_ISSUED");
    expect(Number(payment.amount.toString())).toBe(16.80);
  });
});

// =============================================================================
// Spec 6 — modifier deltas are included in the QR amount.
// =============================================================================
describe("Spec 6 — modifier deltas roll into the QR amount", () => {
  it("an ADD modifier with priceDelta=2 lifts the QR amount accordingly", async () => {
    const ctx = await bootstrapLounge("modifier-delta");
    const margaret = await disabledMember(ctx.club.id, "0613");
    const { checkId } = await seatTable(ctx.admin, ctx.club.id, {
      tableId: ctx.table.id, memberNumber: "0613", partySize: 2,
    });
    await addCheckLines(ctx.admin, checkId, {
      items: [{ menuItemId: ctx.wagyu.id, quantity: 1, seatNumber: 1 }],
    });
    const line = await db().pOSCheckLine.findFirstOrThrow({ where: { checkId } });
    // Add a $2 sauce modifier — modifier prices are per-unit.
    await db().pOSCheckLineModifier.create({
      data: {
        clubId: ctx.club.id, checkLineId: line.id,
        modifierType: "ADD", label: "Truffle sauce", printLabel: "Truffle sauce",
        priceDelta: 2, sortOrder: 0,
      },
    });

    const payment = await initiateWholeCheckQRPayment(ctx.admin, ctx.club.id, {
      checkId, memberId: margaret.id, origin: "http://localhost:3000",
    });
    // (16 + 2) * 1.05 = 18.90
    expect(Number(payment.amount.toString())).toBe(18.90);
  });
});

// =============================================================================
// Spec 7 — VOIDED lines are excluded.
// =============================================================================
describe("Spec 7 — VOIDED lines are excluded", () => {
  it("a VOIDED-only check throws the truly-nothing-unpaid error", async () => {
    const ctx = await bootstrapLounge("voided-only");
    const margaret = await disabledMember(ctx.club.id, "0613");
    const { checkId } = await seatTable(ctx.admin, ctx.club.id, {
      tableId: ctx.table.id, memberNumber: "0613", partySize: 2,
    });
    await addCheckLines(ctx.admin, checkId, {
      items: [{ menuItemId: ctx.wagyu.id, quantity: 1, seatNumber: 1 }],
    });
    await db().pOSCheckLine.updateMany({ where: { checkId }, data: { status: "VOIDED" } });

    await expect(
      initiateWholeCheckQRPayment(ctx.admin, ctx.club.id, {
        checkId, memberId: margaret.id, origin: "http://localhost:3000",
      }),
    ).rejects.toThrow(/No unpaid items remain/i);
  });

  it("a mix of VOIDED + active includes only the active line in the amount", async () => {
    const ctx = await bootstrapLounge("voided-mix");
    const margaret = await disabledMember(ctx.club.id, "0613");
    const { checkId } = await seatTable(ctx.admin, ctx.club.id, {
      tableId: ctx.table.id, memberNumber: "0613", partySize: 2,
    });
    // Two lines: one voided, one active.
    await addCheckLines(ctx.admin, checkId, {
      items: [
        { menuItemId: ctx.wagyu.id, quantity: 1, seatNumber: 1 },
        { menuItemId: ctx.wagyu.id, quantity: 1, seatNumber: 1 },
      ],
    });
    const lines = await db().pOSCheckLine.findMany({ where: { checkId } });
    await db().pOSCheckLine.update({ where: { id: lines[0].id }, data: { status: "VOIDED" } });

    const payment = await initiateWholeCheckQRPayment(ctx.admin, ctx.club.id, {
      checkId, memberId: margaret.id, origin: "http://localhost:3000",
    });
    expect(Number(payment.amount.toString())).toBe(16.80);
  });
});

// =============================================================================
// Spec 8 — COMPED lines are excluded.
// =============================================================================
describe("Spec 8 — COMPED lines are excluded", () => {
  it("a COMPED-only check throws the truly-nothing-unpaid error", async () => {
    const ctx = await bootstrapLounge("comped-only");
    const margaret = await disabledMember(ctx.club.id, "0613");
    const { checkId } = await seatTable(ctx.admin, ctx.club.id, {
      tableId: ctx.table.id, memberNumber: "0613", partySize: 2,
    });
    await addCheckLines(ctx.admin, checkId, {
      items: [{ menuItemId: ctx.wagyu.id, quantity: 1, seatNumber: 1 }],
    });
    await db().pOSCheckLine.updateMany({ where: { checkId }, data: { status: "COMPED" } });

    await expect(
      initiateWholeCheckQRPayment(ctx.admin, ctx.club.id, {
        checkId, memberId: margaret.id, origin: "http://localhost:3000",
      }),
    ).rejects.toThrow(/No unpaid items remain/i);
  });
});

// =============================================================================
// Spec 9 — Already-settled lines (group SETTLED) are excluded.
//           AND: a line in a NON-SETTLED group is STILL counted (bug fix).
// =============================================================================
describe("Spec 9 — settlement-group semantics", () => {
  it("a line in a SETTLED group is excluded from the QR amount", async () => {
    const ctx = await bootstrapLounge("settled-group-excluded");
    const margaret = await disabledMember(ctx.club.id, "0613");
    const { checkId } = await seatTable(ctx.admin, ctx.club.id, {
      tableId: ctx.table.id, memberNumber: "0613", partySize: 2,
    });
    await addCheckLines(ctx.admin, checkId, {
      items: [
        { menuItemId: ctx.wagyu.id, quantity: 1, seatNumber: 1 },
        { menuItemId: ctx.wagyu.id, quantity: 1, seatNumber: 2 },
      ],
    });
    // Stamp one line as SETTLED via a fake settled group, leave the
    // other free — the QR amount should reflect only the free one.
    const settledGroup = await db().pOSSettlementGroup.create({
      data: {
        clubId: ctx.club.id, posCheckId: checkId,
        label: "Already paid", status: "SETTLED",
        settlementMethod: "MEMBER_ACCOUNT",
        createdByUserId: ctx.admin.id,
        settledAt: new Date(),
      },
    });
    const lines = await db().pOSCheckLine.findMany({ where: { checkId } });
    await db().pOSCheckLine.update({
      where: { id: lines[0].id },
      data: { settlementGroupId: settledGroup.id },
    });

    const payment = await initiateWholeCheckQRPayment(ctx.admin, ctx.club.id, {
      checkId, memberId: margaret.id, origin: "http://localhost:3000",
    });
    expect(Number(payment.amount.toString())).toBe(16.80);
  });

  it("BUG FIX — a line in a NON-SETTLED (OPEN) group is still counted", async () => {
    const ctx = await bootstrapLounge("open-group-counted");
    const margaret = await disabledMember(ctx.club.id, "0613");
    const { checkId } = await seatTable(ctx.admin, ctx.club.id, {
      tableId: ctx.table.id, memberNumber: "0613", partySize: 2,
    });
    await addCheckLines(ctx.admin, checkId, {
      items: [{ menuItemId: ctx.wagyu.id, quantity: 1, seatNumber: 1 }],
    });
    // Mimic a prior aborted settle attempt that stamped the line
    // with a settlementGroupId pointing at an OPEN group.
    const orphanGroup = await db().pOSSettlementGroup.create({
      data: {
        clubId: ctx.club.id, posCheckId: checkId,
        label: "Aborted attempt", status: "OPEN",
        settlementMethod: "MEMBER_ACCOUNT",
        createdByUserId: ctx.admin.id,
      },
    });
    const line = await db().pOSCheckLine.findFirstOrThrow({ where: { checkId } });
    await db().pOSCheckLine.update({
      where: { id: line.id },
      data: { settlementGroupId: orphanGroup.id },
    });

    // Before the fix this threw "No unsettled amount on this check"
    // because the strict-null filter dropped the line. After the
    // fix the OPEN-group line counts and the QR amount is correct.
    const payment = await initiateWholeCheckQRPayment(ctx.admin, ctx.club.id, {
      checkId, memberId: margaret.id, origin: "http://localhost:3000",
    });
    expect(Number(payment.amount.toString())).toBe(16.80);
  });
});

// =============================================================================
// Spec 10 — Whole-check QR amount matches the settlement modal total.
//           The modal's per-group totalForGroup multiplies subtotal by 1.05
//           (GST 5%) — same priced-line math we use server-side.
// =============================================================================
describe("Spec 10 — QR amount matches the settle-modal merge-all total", () => {
  it("two Wagyu lines: QR amount === sum(seats.subtotal) * 1.05", async () => {
    const ctx = await bootstrapLounge("matches-modal");
    const margaret = await disabledMember(ctx.club.id, "0613");
    const { checkId } = await seatTable(ctx.admin, ctx.club.id, {
      tableId: ctx.table.id, memberNumber: "0613", partySize: 2,
    });
    await addCheckLines(ctx.admin, checkId, {
      items: [
        { menuItemId: ctx.wagyu.id, quantity: 1, seatNumber: 1 },
        { menuItemId: ctx.wagyu.id, quantity: 1, seatNumber: 2 },
      ],
    });
    await sendUnsentItems(ctx.admin, checkId);

    const payment = await initiateWholeCheckQRPayment(ctx.admin, ctx.club.id, {
      checkId, memberId: margaret.id, origin: "http://localhost:3000",
    });
    // 2 × 16 × 1.05 = 33.60
    expect(Number(payment.amount.toString())).toBe(33.60);
  });
});

// =============================================================================
// Spec 11 — disabled-charge-account member can QR-pay a check.
// =============================================================================
describe("Spec 11 — suspended member can QR-pay", () => {
  it("CHARGE_ACCOUNT_SUSPENDED is allowed for QR initiate", async () => {
    const ctx = await bootstrapLounge("suspended-can-qr");
    const margaret = await disabledMember(ctx.club.id, "0613");
    const { checkId } = await seatTable(ctx.admin, ctx.club.id, {
      tableId: ctx.table.id, memberNumber: "0613", partySize: 2,
    });
    await addCheckLines(ctx.admin, checkId, {
      items: [{ menuItemId: ctx.wagyu.id, quantity: 1, seatNumber: 1 }],
    });
    await sendUnsentItems(ctx.admin, checkId);

    const payment = await initiateWholeCheckQRPayment(ctx.admin, ctx.club.id, {
      checkId, memberId: margaret.id, origin: "http://localhost:3000",
    });
    expect(payment.status).toBe("QR_ISSUED");
    expect(payment.memberId).toBe(margaret.id);
  });
});

// =============================================================================
// Spec 12 — "No unsettled amount" only appears when truly nothing is unpaid.
// =============================================================================
describe("Spec 12 — error message wording matches the actual state", () => {
  it("zero lines → 'No unpaid items remain on this check.'", async () => {
    const ctx = await bootstrapLounge("zero-lines");
    const margaret = await disabledMember(ctx.club.id, "0613");
    const { checkId } = await seatTable(ctx.admin, ctx.club.id, {
      tableId: ctx.table.id, memberNumber: "0613", partySize: 2,
    });
    // No lines added.
    await expect(
      initiateWholeCheckQRPayment(ctx.admin, ctx.club.id, {
        checkId, memberId: margaret.id, origin: "http://localhost:3000",
      }),
    ).rejects.toThrow(/No unpaid items remain on this check\./);
  });

  it("priced-zero lines → 'review menu pricing' message", async () => {
    const ctx = await bootstrapLounge("priced-zero");
    const margaret = await disabledMember(ctx.club.id, "0613");
    const { checkId } = await seatTable(ctx.admin, ctx.club.id, {
      tableId: ctx.table.id, memberNumber: "0613", partySize: 2,
    });
    // Seed a $0 menu item — mimics a misconfigured catalog.
    const free = await db().pOSMenuItem.create({
      data: { clubId: ctx.club.id, categoryId: (await db().pOSMenuCategory.findFirstOrThrow({ where: { clubId: ctx.club.id } })).id, name: "Compliments of the chef", price: 0, taxable: false, isActive: true },
    });
    await addCheckLines(ctx.admin, checkId, {
      items: [{ menuItemId: free.id, quantity: 1, seatNumber: 1 }],
    });

    await expect(
      initiateWholeCheckQRPayment(ctx.admin, ctx.club.id, {
        checkId, memberId: margaret.id, origin: "http://localhost:3000",
      }),
    ).rejects.toThrow(/none could be priced for payment\. Review menu pricing\./);
  });
});

// =============================================================================
// Spec 13 — CONFIRMED still posts the correct GL (no regression on step 19).
// =============================================================================
describe("Spec 13 — CONFIRMED QR still posts a balanced JE to cash + revenue + GST", () => {
  it("end-to-end Wagyu confirm: DR 1010 / CR 4200 / CR 2110, no AR line", async () => {
    const ctx = await bootstrapLounge("posts-gl");
    const margaret = await disabledMember(ctx.club.id, "0613");
    const { checkId } = await seatTable(ctx.admin, ctx.club.id, {
      tableId: ctx.table.id, memberNumber: "0613", partySize: 2,
    });
    await addCheckLines(ctx.admin, checkId, {
      items: [{ menuItemId: ctx.wagyu.id, quantity: 1, seatNumber: 1 }],
    });
    await sendUnsentItems(ctx.admin, checkId);
    const payment = await initiateWholeCheckQRPayment(ctx.admin, ctx.club.id, {
      checkId, memberId: margaret.id, origin: "http://localhost:3000",
    });
    const r = await confirmQRPayment(ctx.admin, payment.id, { origin: "http://localhost:3000" });
    expect(r.saleId).not.toBeNull();
    const sale = await db().pOSSale.findUniqueOrThrow({
      where: { id: r.saleId! },
      include: { postedJournalEntry: { include: { lines: { include: { account: true } } } } },
    });
    const lines = sale.postedJournalEntry!.lines;
    expect(lines.find((l) => l.account.accountNumber === "1010")).toBeDefined();
    expect(lines.find((l) => l.account.accountNumber === "4200")).toBeDefined();
    expect(lines.find((l) => l.account.accountNumber === "2110")).toBeDefined();
    expect(lines.find((l) => l.account.accountNumber === "1110")).toBeUndefined();
    const charges = await db().charge.count({ where: { memberId: margaret.id } });
    expect(charges).toBe(0);
  });
});

// =============================================================================
// Spec 14 — CONFIRMED closes the check and flips the table to DIRTY.
// =============================================================================
describe("Spec 14 — CONFIRMED closes the check and moves the table to DIRTY", () => {
  it("table flips from SEATED to DIRTY after confirm", async () => {
    const ctx = await bootstrapLounge("table-dirty");
    const margaret = await disabledMember(ctx.club.id, "0613");
    const { checkId } = await seatTable(ctx.admin, ctx.club.id, {
      tableId: ctx.table.id, memberNumber: "0613", partySize: 2,
    });
    await addCheckLines(ctx.admin, checkId, {
      items: [{ menuItemId: ctx.wagyu.id, quantity: 1, seatNumber: 1 }],
    });
    await sendUnsentItems(ctx.admin, checkId);
    const payment = await initiateWholeCheckQRPayment(ctx.admin, ctx.club.id, {
      checkId, memberId: margaret.id, origin: "http://localhost:3000",
    });
    await confirmQRPayment(ctx.admin, payment.id, { origin: "http://localhost:3000" });

    const check = await db().pOSCheck.findUnique({ where: { id: checkId } });
    expect(check?.status).toBe("CLOSED");
    const table = await db().diningTable.findUnique({ where: { id: ctx.table.id } });
    expect(table?.status).toBe("DIRTY");
  });
});

// =============================================================================
// Spec 15 — DECLINED still leaves the check active.
// =============================================================================
describe("Spec 15 — DECLINED leaves the check active (no posting)", () => {
  it("declined QR does not flip the check or table", async () => {
    const ctx = await bootstrapLounge("declined");
    const margaret = await disabledMember(ctx.club.id, "0613");
    const { checkId } = await seatTable(ctx.admin, ctx.club.id, {
      tableId: ctx.table.id, memberNumber: "0613", partySize: 2,
    });
    await addCheckLines(ctx.admin, checkId, {
      items: [{ menuItemId: ctx.wagyu.id, quantity: 1, seatNumber: 1 }],
    });
    await sendUnsentItems(ctx.admin, checkId);
    const payment = await initiateWholeCheckQRPayment(ctx.admin, ctx.club.id, {
      checkId, memberId: margaret.id, origin: "http://localhost:3000",
    });
    await declineQRPayment(ctx.admin, payment.id, "Card declined");

    const check = await db().pOSCheck.findUnique({ where: { id: checkId } });
    expect(check?.status).not.toBe("CLOSED");
    const table = await db().diningTable.findUnique({ where: { id: ctx.table.id } });
    expect(table?.status).toBe("SEATED");
    // Server can retry: a fresh initiate now returns a new QR.
    const next = await initiateWholeCheckQRPayment(ctx.admin, ctx.club.id, {
      checkId, memberId: margaret.id, origin: "http://localhost:3000",
    });
    expect(next.status).toBe("QR_ISSUED");
    expect(next.id).not.toBe(payment.id);
  });
});
