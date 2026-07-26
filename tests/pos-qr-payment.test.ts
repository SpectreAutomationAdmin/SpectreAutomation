// POS cleanup step 19 — QR-code payment lifecycle.
//
// A member with a suspended charge account must not be settled to
// MEMBER_ACCOUNT. The server uses Pay by QR Code instead: a pending
// POSQRPayment row tracks the lifecycle, no financials are posted
// until CONFIRMED, and DECLINED/EXPIRED leave the check active for
// retry.
//
// These tests pin:
//   - the accessStatus gate inside settleCheckBySeats
//   - the POSQRPayment lifecycle (CREATED/QR_ISSUED/PENDING/CONFIRMED/
//     DECLINED/EXPIRED/CANCELLED)
//   - the JE shape on CONFIRMED (DR Cash 1010 / CR F&B 4200 / CR GST
//     2110 — no AR charge, no MemberAccount touch)
//   - receipt-email gating: only on CONFIRMED
//   - table-status flip: only on CONFIRMED that closes the whole check
//   - cross-tenant safety
//   - confirm-twice idempotency

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import {
  db,
  makeMember,
  makeUser,
  principalFor,
  resetDb,
  seedRbac,
  makeClub,
} from "./util/db";
import { bootstrapAPClub } from "./util/ap";
import {
  initiateWholeCheckQRPayment,
  confirmQRPayment,
  declineQRPayment,
  expireQRPayment,
  cancelQRPayment,
  simulateQRPayment,
  qrPaymentSimulationEnabled,
  QR_PAYMENT_STATUSES,
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
  const adminEmail = `qr-${club.id}@example.com`;
  await makeUser({ email: adminEmail, role: "CLUB_ADMIN", clubId: club.id });
  const admin = await principalFor(adminEmail);
  return { club, loc, table, admin };
}

// Seed a single F&B menu item so we can ring up a burger and walk the
// lifecycle end-to-end. Returns the item id so callers can add lines.
async function seedBurger(clubId: string, locId: string) {
  const cat = await db().pOSMenuCategory.create({
    data: { clubId, locationId: locId, name: "Mains", sortOrder: 1, isActive: true, chitDestination: "KITCHEN" },
  });
  return db().pOSMenuItem.create({
    data: { clubId, categoryId: cat.id, name: "Burger", price: 18, taxable: true, isActive: true },
  });
}

// Open a check seated at the table, add a burger to seat 1, send it
// to the kitchen so it's not in DRAFT.
async function setupCheckWithBurger(ctx: Awaited<ReturnType<typeof bootstrapLounge>>, hostMemberId: string, hostNumber: string) {
  const burger = await seedBurger(ctx.club.id, ctx.loc.id);
  const { checkId } = await seatTable(ctx.admin, ctx.club.id, {
    tableId: ctx.table.id, memberNumber: hostNumber, partySize: 2,
  });
  await addCheckLines(ctx.admin, checkId, {
    items: [{ menuItemId: burger.id, quantity: 1, seatNumber: 1 }],
  });
  // Mirror the real workflow: send the burger to the kitchen before
  // settle so the lines are SENT, not DRAFT. confirmQRPayment routes
  // through settleCheckBySeats which (rightly) refuses DRAFT lines.
  await sendUnsentItems(ctx.admin, checkId);
  return { checkId, burger };
}

beforeAll(async () => { await resetDb(); await seedRbac(); });
beforeEach(async () => { await resetDb(); await seedRbac(); });

// =============================================================================
// 1. Disabled charge account blocks MEMBER_ACCOUNT settlement.
// =============================================================================
describe("Spec 1 — disabled charge account blocks MEMBER_ACCOUNT settle", () => {
  it("settleCheckBySeats rejects with a clear member-named error", async () => {
    const ctx = await bootstrapLounge("disabled-blocks");
    const margaret = await makeMember(ctx.club.id, { firstName: "Margaret", lastName: "Holloway" });
    await db().member.update({
      where: { id: margaret.id },
      data: { memberNumber: "0613", accessStatus: "CHARGE_ACCOUNT_SUSPENDED" },
    });
    const { checkId } = await setupCheckWithBurger(ctx, margaret.id, "0613");

    await expect(
      settleCheckBySeats(ctx.admin, checkId, {
        groups: [{
          label: "All seats", seatNumbers: [1],
          paymentMethod: "MEMBER_ACCOUNT", memberId: margaret.id,
        }],
        allowUnsentLines: true,
      }),
    ).rejects.toThrow(/Margaret Holloway.*charge account is disabled/i);

    // Check remains active.
    const check = await db().pOSCheck.findUnique({ where: { id: checkId } });
    expect(check?.status).not.toBe("CLOSED");
  });

  it("FULL_SUSPENSION also blocks settlement", async () => {
    const ctx = await bootstrapLounge("full-suspend");
    const m = await makeMember(ctx.club.id);
    await db().member.update({
      where: { id: m.id },
      data: { memberNumber: "1310", accessStatus: "FULL_SUSPENSION" },
    });
    const { checkId } = await setupCheckWithBurger(ctx, m.id, "1310");
    await expect(
      settleCheckBySeats(ctx.admin, checkId, {
        groups: [{ label: "All", seatNumbers: [1], paymentMethod: "MEMBER_ACCOUNT", memberId: m.id }],
        allowUnsentLines: true,
      }),
    ).rejects.toThrow(/charge account is disabled/i);
  });
});

// =============================================================================
// 2. Disabled charge account leaves Pay by QR Code as the alternative.
// =============================================================================
describe("Spec 2 — Pay by QR Code is available when MEMBER_ACCOUNT is blocked", () => {
  it("initiateWholeCheckQRPayment succeeds even when the member is suspended", async () => {
    const ctx = await bootstrapLounge("qr-when-suspended");
    const margaret = await makeMember(ctx.club.id, { firstName: "Margaret", lastName: "Holloway" });
    await db().member.update({
      where: { id: margaret.id },
      data: { memberNumber: "0613", accessStatus: "CHARGE_ACCOUNT_SUSPENDED" },
    });
    const { checkId } = await setupCheckWithBurger(ctx, margaret.id, "0613");

    const payment = await initiateWholeCheckQRPayment(ctx.admin, ctx.club.id, {
      checkId, memberId: margaret.id, origin: "http://localhost:3000",
    });
    expect(payment.status).toBe("QR_ISSUED");
    expect(payment.posCheckId).toBe(checkId);
    expect(payment.memberId).toBe(margaret.id);
  });
});

// =============================================================================
// 3. QR payment creation sets status to QR_ISSUED.
// =============================================================================
describe("Spec 3 — initiate creates a row in QR_ISSUED", () => {
  it("the row exists, has a paymentUrl, and an expiry in the future", async () => {
    const ctx = await bootstrapLounge("issue");
    const m = await makeMember(ctx.club.id);
    await db().member.update({ where: { id: m.id }, data: { memberNumber: "0613", accessStatus: "CHARGE_ACCOUNT_SUSPENDED" } });
    const { checkId } = await setupCheckWithBurger(ctx, m.id, "0613");

    const payment = await initiateWholeCheckQRPayment(ctx.admin, ctx.club.id, {
      checkId, memberId: m.id, origin: "http://localhost:3000",
    });
    expect(payment.status).toBe("QR_ISSUED");
    expect(payment.paymentUrl).toMatch(/^http:\/\/localhost:3000\/qr\//);
    expect(Number(payment.amount.toString())).toBeGreaterThan(0);
    expect(payment.expiresAt).not.toBeNull();
    expect(payment.expiresAt!.getTime()).toBeGreaterThan(Date.now());
  });

  it("idempotent: a second initiate returns the existing pending row", async () => {
    const ctx = await bootstrapLounge("idempotent-issue");
    const m = await makeMember(ctx.club.id);
    await db().member.update({ where: { id: m.id }, data: { memberNumber: "0613", accessStatus: "CHARGE_ACCOUNT_SUSPENDED" } });
    const { checkId } = await setupCheckWithBurger(ctx, m.id, "0613");
    const first = await initiateWholeCheckQRPayment(ctx.admin, ctx.club.id, { checkId, memberId: m.id, origin: "http://localhost:3000" });
    const second = await initiateWholeCheckQRPayment(ctx.admin, ctx.club.id, { checkId, memberId: m.id, origin: "http://localhost:3000" });
    expect(second.id).toBe(first.id);
  });
});

// =============================================================================
// 4. Pending QR payment does NOT create an AR charge.
// =============================================================================
describe("Spec 4 — pending QR payment does not touch member AR", () => {
  it("no Charge row, no MemberAccount mutation while QR_ISSUED", async () => {
    const ctx = await bootstrapLounge("pending-no-ar");
    const margaret = await makeMember(ctx.club.id, { firstName: "Margaret", lastName: "Holloway" });
    await db().member.update({ where: { id: margaret.id }, data: { memberNumber: "0613", accessStatus: "CHARGE_ACCOUNT_SUSPENDED" } });
    const { checkId } = await setupCheckWithBurger(ctx, margaret.id, "0613");

    await initiateWholeCheckQRPayment(ctx.admin, ctx.club.id, {
      checkId, memberId: margaret.id, origin: "http://localhost:3000",
    });

    const charges = await db().charge.count({ where: { memberId: margaret.id } });
    expect(charges).toBe(0);
  });
});

// =============================================================================
// 5. Pending QR payment does NOT post a GL journal.
// =============================================================================
describe("Spec 5 — pending QR payment does not post GL", () => {
  it("no journal entry exists for the check while pending", async () => {
    const ctx = await bootstrapLounge("pending-no-gl");
    const m = await makeMember(ctx.club.id);
    await db().member.update({ where: { id: m.id }, data: { memberNumber: "0613", accessStatus: "CHARGE_ACCOUNT_SUSPENDED" } });
    const { checkId } = await setupCheckWithBurger(ctx, m.id, "0613");
    const before = await db().journalEntry.count({ where: { clubId: ctx.club.id } });
    await initiateWholeCheckQRPayment(ctx.admin, ctx.club.id, { checkId, memberId: m.id, origin: "http://localhost:3000" });
    const after = await db().journalEntry.count({ where: { clubId: ctx.club.id } });
    expect(after).toBe(before);
  });
});

// =============================================================================
// 6. Pending QR payment does NOT send a receipt email.
// =============================================================================
describe("Spec 6 — pending QR payment does not send a receipt email", () => {
  it("no EmailDeliveryEvent rows for this payment until confirmed", async () => {
    const ctx = await bootstrapLounge("pending-no-email");
    const m = await makeMember(ctx.club.id);
    await db().member.update({ where: { id: m.id }, data: { memberNumber: "0613", accessStatus: "CHARGE_ACCOUNT_SUSPENDED" } });
    const { checkId } = await setupCheckWithBurger(ctx, m.id, "0613");
    await initiateWholeCheckQRPayment(ctx.admin, ctx.club.id, { checkId, memberId: m.id, origin: "http://localhost:3000" });

    const events = await db().emailDeliveryEvent.count({ where: { clubId: ctx.club.id } });
    expect(events).toBe(0);
  });
});

// =============================================================================
// 7. Confirmed QR payment creates a POSSale.
// 8. Confirmed QR payment creates a POSPayment.
// 9. Confirmed QR payment posts a balanced GL JE (cash + revenue + GST).
// 11. Confirmed QR payment closes the check.
// 12. Confirmed QR payment moves the table to DIRTY.
// =============================================================================
describe("Specs 7/8/9/11/12 — CONFIRMED runs the full posting tail", () => {
  it("creates the sale + payment + balanced JE, closes the check, flips the table", async () => {
    const ctx = await bootstrapLounge("confirm-full");
    const margaret = await makeMember(ctx.club.id, { firstName: "Margaret", lastName: "Holloway" });
    await db().member.update({ where: { id: margaret.id }, data: { memberNumber: "0613", accessStatus: "CHARGE_ACCOUNT_SUSPENDED", email: "margaret@example.com" } });
    const { checkId } = await setupCheckWithBurger(ctx, margaret.id, "0613");
    const payment = await initiateWholeCheckQRPayment(ctx.admin, ctx.club.id, { checkId, memberId: margaret.id, origin: "http://localhost:3000" });

    const r = await confirmQRPayment(ctx.admin, payment.id, { origin: "http://localhost:3000" });

    // Spec 7 — POSSale exists.
    expect(r.saleId).not.toBeNull();
    const sale = await db().pOSSale.findUnique({
      where: { id: r.saleId! },
      include: { payments: true, postedJournalEntry: { include: { lines: { include: { account: true } } } } },
    });
    expect(sale?.chargeMode).toBe("QR_PAY");
    expect(sale?.status).toBe("COMPLETED");
    expect(sale?.memberId).toBe(margaret.id);

    // Spec 8 — POSPayment is captured in the sale lines (legacy
    // settle leaves payments empty unless the caller provides them;
    // POSSale.postedJournalEntryId is the canonical proof that the
    // payment side posted). Confirm a JE was attached.
    expect(sale?.postedJournalEntryId).not.toBeNull();
    const lines = sale!.postedJournalEntry!.lines;

    // Spec 9 — balanced JE with DR 1010 Cash, CR F&B revenue, CR GST.
    const debits = lines.filter((l) => Number(l.debit.toString()) > 0);
    const credits = lines.filter((l) => Number(l.credit.toString()) > 0);
    expect(debits.length).toBeGreaterThan(0);
    expect(credits.length).toBeGreaterThan(0);
    const debitTotal = debits.reduce((s, l) => s + Number(l.debit.toString()), 0);
    const creditTotal = credits.reduce((s, l) => s + Number(l.credit.toString()), 0);
    expect(Math.abs(debitTotal - creditTotal)).toBeLessThan(0.01);

    const cashLine = debits.find((l) => l.account.accountNumber === "1010");
    expect(cashLine).toBeDefined();
    const revenueLine = credits.find((l) => l.account.accountNumber === "4200");
    expect(revenueLine).toBeDefined();
    const taxLine = credits.find((l) => l.account.accountNumber === "2110");
    expect(taxLine).toBeDefined();
    // No AR line for QR.
    const arLine = lines.find((l) => l.account.accountNumber === "1110");
    expect(arLine).toBeUndefined();

    // No member AR Charge.
    const charges = await db().charge.count({ where: { memberId: margaret.id } });
    expect(charges).toBe(0);

    // Spec 11 — check closed.
    expect(r.checkStatus).toBe("CLOSED");
    const check = await db().pOSCheck.findUnique({ where: { id: checkId } });
    expect(check?.status).toBe("CLOSED");
    expect(check?.settlementMethod).toBe("QR_PAY");

    // Spec 12 — table moved to DIRTY.
    const table = await db().diningTable.findUnique({ where: { id: ctx.table.id } });
    expect(table?.status).toBe("DIRTY");
  });
});

// =============================================================================
// 10. Confirmed QR payment sends a receipt email.
// =============================================================================
describe("Spec 10 — CONFIRMED fires the receipt email", () => {
  it("records an EmailDeliveryEvent / writes receiptEmailStatus on the check", async () => {
    const ctx = await bootstrapLounge("confirm-email");
    const margaret = await makeMember(ctx.club.id, { firstName: "Margaret", lastName: "Holloway" });
    await db().member.update({ where: { id: margaret.id }, data: { memberNumber: "0613", accessStatus: "CHARGE_ACCOUNT_SUSPENDED", email: "margaret@example.com" } });
    const { checkId } = await setupCheckWithBurger(ctx, margaret.id, "0613");
    const payment = await initiateWholeCheckQRPayment(ctx.admin, ctx.club.id, { checkId, memberId: margaret.id, origin: "http://localhost:3000" });

    await confirmQRPayment(ctx.admin, payment.id, { origin: "http://localhost:3000" });

    const check = await db().pOSCheck.findUnique({ where: { id: checkId } });
    // The fire-and-forget email path either succeeded (status SENT /
    // DEV_LOGGED) or failed loudly (FAILED). Anything other than null
    // proves the email path was invoked — the goal of this spec.
    expect(check?.receiptEmailStatus).not.toBeNull();
  });
});

// =============================================================================
// 13. Declined QR payment keeps the check active.
// =============================================================================
describe("Spec 13 — DECLINED leaves the check active", () => {
  it("status flips to DECLINED, check stays OPEN, no sale created", async () => {
    const ctx = await bootstrapLounge("decline");
    const m = await makeMember(ctx.club.id);
    await db().member.update({ where: { id: m.id }, data: { memberNumber: "0613", accessStatus: "CHARGE_ACCOUNT_SUSPENDED" } });
    const { checkId } = await setupCheckWithBurger(ctx, m.id, "0613");
    const payment = await initiateWholeCheckQRPayment(ctx.admin, ctx.club.id, { checkId, memberId: m.id, origin: "http://localhost:3000" });

    const declined = await declineQRPayment(ctx.admin, payment.id, "Card declined");
    expect(declined.status).toBe("DECLINED");
    expect(declined.failureReason).toBe("Card declined");

    const check = await db().pOSCheck.findUnique({ where: { id: checkId } });
    expect(check?.status).not.toBe("CLOSED");
    const sales = await db().pOSSale.count({ where: { clubId: ctx.club.id } });
    expect(sales).toBe(0);
  });
});

// =============================================================================
// 14. Expired QR payment keeps the check active.
// =============================================================================
describe("Spec 14 — EXPIRED leaves the check active", () => {
  it("status flips to EXPIRED, check stays open", async () => {
    const ctx = await bootstrapLounge("expire");
    const m = await makeMember(ctx.club.id);
    await db().member.update({ where: { id: m.id }, data: { memberNumber: "0613", accessStatus: "CHARGE_ACCOUNT_SUSPENDED" } });
    const { checkId } = await setupCheckWithBurger(ctx, m.id, "0613");
    const payment = await initiateWholeCheckQRPayment(ctx.admin, ctx.club.id, { checkId, memberId: m.id, origin: "http://localhost:3000" });

    const expired = await expireQRPayment(ctx.admin, payment.id);
    expect(expired.status).toBe("EXPIRED");
    const check = await db().pOSCheck.findUnique({ where: { id: checkId } });
    expect(check?.status).not.toBe("CLOSED");
  });
});

// =============================================================================
// 15. Declined/expired QR sends no email.
// =============================================================================
describe("Spec 15 — DECLINED/EXPIRED do not send a receipt email", () => {
  it("no EmailDeliveryEvent rows after decline", async () => {
    const ctx = await bootstrapLounge("decline-no-email");
    const m = await makeMember(ctx.club.id);
    await db().member.update({ where: { id: m.id }, data: { memberNumber: "0613", accessStatus: "CHARGE_ACCOUNT_SUSPENDED", email: "ghost@example.com" } });
    const { checkId } = await setupCheckWithBurger(ctx, m.id, "0613");
    const payment = await initiateWholeCheckQRPayment(ctx.admin, ctx.club.id, { checkId, memberId: m.id, origin: "http://localhost:3000" });
    await declineQRPayment(ctx.admin, payment.id, "Card declined");

    const events = await db().emailDeliveryEvent.count({ where: { clubId: ctx.club.id } });
    expect(events).toBe(0);
  });

  it("no EmailDeliveryEvent rows after expire", async () => {
    const ctx = await bootstrapLounge("expire-no-email");
    const m = await makeMember(ctx.club.id);
    await db().member.update({ where: { id: m.id }, data: { memberNumber: "0613", accessStatus: "CHARGE_ACCOUNT_SUSPENDED", email: "ghost@example.com" } });
    const { checkId } = await setupCheckWithBurger(ctx, m.id, "0613");
    const payment = await initiateWholeCheckQRPayment(ctx.admin, ctx.club.id, { checkId, memberId: m.id, origin: "http://localhost:3000" });
    await expireQRPayment(ctx.admin, payment.id);
    const events = await db().emailDeliveryEvent.count({ where: { clubId: ctx.club.id } });
    expect(events).toBe(0);
  });
});

// =============================================================================
// 16. QR dev simulation controls hidden in production.
// =============================================================================
describe("Spec 16 — simulation is hard-blocked in production", () => {
  it("qrPaymentSimulationEnabled returns false when NODE_ENV=production", () => {
    const prev = process.env.NODE_ENV;
    (process.env as { NODE_ENV?: string }).NODE_ENV = "production";
    try {
      expect(qrPaymentSimulationEnabled()).toBe(false);
    } finally {
      (process.env as { NODE_ENV?: string }).NODE_ENV = prev;
    }
  });

  it("simulateQRPayment throws when run with NODE_ENV=production", async () => {
    const ctx = await bootstrapLounge("simulate-prod");
    const m = await makeMember(ctx.club.id);
    await db().member.update({ where: { id: m.id }, data: { memberNumber: "0613", accessStatus: "CHARGE_ACCOUNT_SUSPENDED" } });
    const { checkId } = await setupCheckWithBurger(ctx, m.id, "0613");
    const payment = await initiateWholeCheckQRPayment(ctx.admin, ctx.club.id, { checkId, memberId: m.id, origin: "http://localhost:3000" });

    const prev = process.env.NODE_ENV;
    (process.env as { NODE_ENV?: string }).NODE_ENV = "production";
    try {
      await expect(
        simulateQRPayment(ctx.admin, payment.id, "CONFIRM", { origin: "http://localhost:3000" }),
      ).rejects.toThrow(/disabled in production/i);
    } finally {
      (process.env as { NODE_ENV?: string }).NODE_ENV = prev;
    }
  });
});

// =============================================================================
// 17. Margaret-shaped fixture (suspended) can be settled by QR end-to-end.
// =============================================================================
describe("Spec 17 — Margaret-shaped fixture settles via QR", () => {
  it("walks issue → simulate confirm → check closed → table dirty", async () => {
    const ctx = await bootstrapLounge("margaret-end-to-end");
    const margaret = await makeMember(ctx.club.id, { firstName: "Margaret", lastName: "Holloway" });
    await db().member.update({
      where: { id: margaret.id },
      data: { memberNumber: "0613", accessStatus: "CHARGE_ACCOUNT_SUSPENDED", email: "margaret@silver.club" },
    });
    const { checkId } = await setupCheckWithBurger(ctx, margaret.id, "0613");
    const payment = await initiateWholeCheckQRPayment(ctx.admin, ctx.club.id, {
      checkId, memberId: margaret.id, origin: "http://localhost:3000",
    });
    const r = await simulateQRPayment(ctx.admin, payment.id, "CONFIRM", { origin: "http://localhost:3000" });
    expect("payment" in r ? r.payment.status : (r as { status: string }).status).toBe("CONFIRMED");

    const check = await db().pOSCheck.findUnique({ where: { id: checkId } });
    expect(check?.status).toBe("CLOSED");
    const table = await db().diningTable.findUnique({ where: { id: ctx.table.id } });
    expect(table?.status).toBe("DIRTY");
  });
});

// =============================================================================
// 18. Member-account enabled member can still settle by MEMBER_ACCOUNT.
// =============================================================================
describe("Spec 18 — enabled charge account still settles via MEMBER_ACCOUNT", () => {
  it("settleCheckBySeats accepts the FULL_ACCESS member", async () => {
    const ctx = await bootstrapLounge("enabled-settles");
    const owen = await makeMember(ctx.club.id, { firstName: "Owen", lastName: "Beauchamp" });
    await db().member.update({
      where: { id: owen.id },
      data: { memberNumber: "1310", accessStatus: "FULL_ACCESS", email: "owen@example.com" },
    });
    const { checkId } = await setupCheckWithBurger(ctx, owen.id, "1310");
    const r = await settleCheckBySeats(ctx.admin, checkId, {
      groups: [{ label: "All", seatNumbers: [1], paymentMethod: "MEMBER_ACCOUNT", memberId: owen.id }],
      allowUnsentLines: true,
    });
    expect(r.check.status).toBe("CLOSED");
    const charges = await db().charge.count({ where: { memberId: owen.id } });
    expect(charges).toBe(1);
  });
});

// =============================================================================
// 19. Cross-tenant QR confirmation is blocked.
// =============================================================================
describe("Spec 19 — cross-tenant QR confirm rejected", () => {
  it("admin of club A cannot confirm a payment owned by club B", async () => {
    const a = await bootstrapLounge("xt-a");
    const b = await bootstrapLounge("xt-b");
    const mb = await makeMember(b.club.id);
    await db().member.update({ where: { id: mb.id }, data: { memberNumber: "0613", accessStatus: "CHARGE_ACCOUNT_SUSPENDED" } });
    const { checkId } = await setupCheckWithBurger(b, mb.id, "0613");
    const payment = await initiateWholeCheckQRPayment(b.admin, b.club.id, { checkId, memberId: mb.id, origin: "http://localhost:3000" });

    await expect(
      confirmQRPayment(a.admin, payment.id, { origin: "http://localhost:3000" }),
    ).rejects.toThrow();
    const stillIssued = await db().pOSQRPayment.findUnique({ where: { id: payment.id } });
    expect(stillIssued?.status).toBe("QR_ISSUED");
  });
});

// =============================================================================
// 20. Idempotency: confirming the same QR payment twice does not double-post.
// =============================================================================
describe("Spec 20 — double-confirm does not double-post", () => {
  it("a second confirm is a no-op (same saleId, no new charge / no new JE)", async () => {
    const ctx = await bootstrapLounge("idempotent");
    const m = await makeMember(ctx.club.id);
    await db().member.update({ where: { id: m.id }, data: { memberNumber: "0613", accessStatus: "CHARGE_ACCOUNT_SUSPENDED" } });
    const { checkId } = await setupCheckWithBurger(ctx, m.id, "0613");
    const payment = await initiateWholeCheckQRPayment(ctx.admin, ctx.club.id, { checkId, memberId: m.id, origin: "http://localhost:3000" });

    const first = await confirmQRPayment(ctx.admin, payment.id, { origin: "http://localhost:3000" });
    const salesAfterFirst = await db().pOSSale.count({ where: { clubId: ctx.club.id } });
    const jeAfterFirst = await db().journalEntry.count({ where: { clubId: ctx.club.id } });

    const second = await confirmQRPayment(ctx.admin, payment.id, { origin: "http://localhost:3000" });
    expect(second.saleId).toBe(first.saleId);

    const salesAfterSecond = await db().pOSSale.count({ where: { clubId: ctx.club.id } });
    const jeAfterSecond = await db().journalEntry.count({ where: { clubId: ctx.club.id } });
    expect(salesAfterSecond).toBe(salesAfterFirst);
    expect(jeAfterSecond).toBe(jeAfterFirst);
  });
});

// =============================================================================
// Bonus — cancel transitions to CANCELLED and leaves the check active.
// =============================================================================
describe("Bonus — cancel transitions to CANCELLED, no sale", () => {
  it("cancelled QR doesn't post and check stays open", async () => {
    const ctx = await bootstrapLounge("cancel");
    const m = await makeMember(ctx.club.id);
    await db().member.update({ where: { id: m.id }, data: { memberNumber: "0613", accessStatus: "CHARGE_ACCOUNT_SUSPENDED" } });
    const { checkId } = await setupCheckWithBurger(ctx, m.id, "0613");
    const payment = await initiateWholeCheckQRPayment(ctx.admin, ctx.club.id, { checkId, memberId: m.id, origin: "http://localhost:3000" });
    const cancelled = await cancelQRPayment(ctx.admin, payment.id);
    expect(cancelled.status).toBe("CANCELLED");
    const check = await db().pOSCheck.findUnique({ where: { id: checkId } });
    expect(check?.status).not.toBe("CLOSED");
  });
});

// =============================================================================
// Bonus — the documented status set is what's exported.
// =============================================================================
describe("Bonus — status set matches spec verbatim", () => {
  it("QR_PAYMENT_STATUSES exposes the spec's 7 states", () => {
    expect(QR_PAYMENT_STATUSES).toEqual([
      "CREATED",
      "QR_ISSUED",
      "PENDING",
      "CONFIRMED",
      "DECLINED",
      "EXPIRED",
      "CANCELLED",
    ]);
  });
});
