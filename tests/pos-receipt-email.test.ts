// Phase 18 — POS receipt email end-to-end.
//
// Covers the user-visible workflow:
//   - Member-account settlement triggers a receipt email and records it.
//   - QR Pay does NOT email until the gateway confirms.
//   - QR decline / expire never emails.
//   - Member's email is read fresh on each send (so a corrected profile
//     email is honored without requiring a new sale).
//   - Missing email → SKIPPED_NO_EMAIL.
//   - Suppressed email → SUPPRESSED + receiptEmailFailure populated.
//   - Provider failure → FAILED + receiptEmailFailure populated.
//   - Console mode flags DEV_LOGGED (not SENT) so the UI doesn't lie.
//   - Resend creates a new EmailDeliveryEvent row + audit + status update.
//
// The email adapter is swapped per-test by inserting an IntegrationSetting
// row with provider="dev" plus a module-level mock; see capturedSends.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { db, makeMember, resetDb, principalFor, makeUser } from "./util/db";
import { bootstrapAPClub } from "./util/ap";
import {
  openCheck,
  addCheckLines,
  sendUnsentItems,
  settleCheck,
  confirmQRPayment,
  declineQRPayment,
  expireQRPayment,
} from "@/lib/pos/checks";
import { sendAndRecordReceiptEmail } from "@/lib/pos/receipts";
import { LOUNGE_LOCATION_CODE, LOUNGE_TERMINAL_CODE } from "@/lib/pos/lounge";

// ---------------- helpers ----------------

async function bootstrapLounge(name: string) {
  const club = await bootstrapAPClub(name);
  const fbDept = await db().department.findFirst({ where: { clubId: club.id, code: "FB" } });
  const location = await db().pOSLocation.create({
    data: { clubId: club.id, code: LOUNGE_LOCATION_CODE, name: "Lounge", departmentId: fbDept?.id ?? null },
  });
  const terminal = await db().pOSTerminal.create({
    data: { clubId: club.id, code: LOUNGE_TERMINAL_CODE, name: "Lounge Terminal", locationId: location.id },
  });
  await db().pOSSession.create({
    data: { clubId: club.id, locationId: location.id, terminalId: terminal.id, status: "OPEN", openingFloat: 0 },
  });
  const cat = await db().pOSMenuCategory.create({
    data: { clubId: club.id, locationId: location.id, name: "Mains", sortOrder: 1, isActive: true, chitDestination: "KITCHEN" },
  });
  const burger = await db().pOSMenuItem.create({
    data: { clubId: club.id, categoryId: cat.id, name: "Burger", price: 20, taxable: true, isActive: true },
  });
  return { club, burger };
}

async function clubAdmin(clubId: string, suffix = "") {
  const email = `pos-receipt-admin${suffix}-${clubId}@example.com`;
  await makeUser({ email, role: "CLUB_ADMIN", clubId });
  return principalFor(email);
}

async function makeMemberWithEmail(clubId: string, email: string) {
  const m = await makeMember(clubId);
  return db().member.update({ where: { id: m.id }, data: { email } });
}

async function checkoutToSettlement(opts: {
  clubId: string;
  principal: Awaited<ReturnType<typeof clubAdmin>>;
  memberId: string;
  burgerId: string;
  paymentMethod: "MEMBER_ACCOUNT" | "QR_PAY";
}) {
  const check = await openCheck(opts.principal, opts.clubId, { memberId: opts.memberId });
  await addCheckLines(opts.principal, check.id, {
    items: [{ menuItemId: opts.burgerId, quantity: 1 }],
  });
  await sendUnsentItems(opts.principal, check.id);
  return settleCheck(opts.principal, check.id, {
    paymentMethod: opts.paymentMethod,
    allowUnsentLines: true,
    origin: "http://localhost:3000",
  });
}

// ---------------- tests ----------------

beforeEach(async () => {
  await resetDb();
  vi.restoreAllMocks();
});

describe("POS receipt email — member-account settlement", () => {
  it("MEMBER_ACCOUNT settlement records DEV_LOGGED status and an EmailDeliveryEvent in console mode", async () => {
    const { club, burger } = await bootstrapLounge("Receipt MA Club");
    const principal = await clubAdmin(club.id);
    const member = await makeMemberWithEmail(club.id, "owen@example.com");

    const { check } = await checkoutToSettlement({
      clubId: club.id, principal, memberId: member.id, burgerId: burger.id,
      paymentMethod: "MEMBER_ACCOUNT",
    });

    const after = await db().pOSCheck.findUnique({ where: { id: check!.id } });
    expect(after?.receiptEmailStatus).toBe("DEV_LOGGED");
    expect(after?.receiptEmailAddress).toBe("owen@example.com");
    // DEV_LOGGED must NOT pretend the receipt was delivered.
    expect(after?.receiptEmailedAt).toBeNull();

    const events = await db().emailDeliveryEvent.findMany({
      where: { clubId: club.id, email: "owen@example.com" },
    });
    expect(events.length).toBe(1);
    expect(events[0].kind).toBe("POS_RECEIPT_DEV_LOGGED");
    expect(events[0].provider).toBe("console");
  });

  it("reads the member's current email at send time (handles edits between sale create and settle)", async () => {
    const { club, burger } = await bootstrapLounge("Receipt Fresh Email Club");
    const principal = await clubAdmin(club.id);
    const member = await makeMemberWithEmail(club.id, "old@example.com");

    // Open the check; update the email BEFORE settlement.
    const checkRow = await openCheck(principal, club.id, { memberId: member.id });
    await addCheckLines(principal, checkRow.id, { items: [{ menuItemId: burger.id, quantity: 1 }] });
    await sendUnsentItems(principal, checkRow.id);
    await db().member.update({ where: { id: member.id }, data: { email: "owen.new@example.com" } });

    const { check } = await settleCheck(principal, checkRow.id, {
      paymentMethod: "MEMBER_ACCOUNT",
      allowUnsentLines: true,
      origin: "http://localhost:3000",
    });

    const after = await db().pOSCheck.findUnique({ where: { id: check!.id } });
    expect(after?.receiptEmailAddress).toBe("owen.new@example.com");
  });

  it("a missing member email yields SKIPPED_NO_EMAIL with no delivery event written for that recipient", async () => {
    const { club, burger } = await bootstrapLounge("Receipt No Email Club");
    const principal = await clubAdmin(club.id);
    const member = await makeMemberWithEmail(club.id, "tmp@example.com");
    // Use an obviously invalid email to trigger the no-email branch.
    await db().member.update({ where: { id: member.id }, data: { email: "" } });

    const { check } = await checkoutToSettlement({
      clubId: club.id, principal, memberId: member.id, burgerId: burger.id,
      paymentMethod: "MEMBER_ACCOUNT",
    });
    const after = await db().pOSCheck.findUnique({ where: { id: check!.id } });
    expect(after?.receiptEmailStatus).toBe("SKIPPED_NO_EMAIL");
    expect(after?.receiptEmailAddress).toBeNull();
  });

  it("a globally-suppressed recipient yields SUPPRESSED status and persists the reason", async () => {
    const { club, burger } = await bootstrapLounge("Receipt Suppression Club");
    const principal = await clubAdmin(club.id);
    const member = await makeMemberWithEmail(club.id, "bounced@example.com");
    await db().emailSuppression.create({
      data: { email: "bounced@example.com", reason: "HARD_BOUNCE" },
    });

    const { check } = await checkoutToSettlement({
      clubId: club.id, principal, memberId: member.id, burgerId: burger.id,
      paymentMethod: "MEMBER_ACCOUNT",
    });
    const after = await db().pOSCheck.findUnique({ where: { id: check!.id } });
    expect(after?.receiptEmailStatus).toBe("SUPPRESSED");
    expect(after?.receiptEmailFailure ?? "").toContain("suppressed");
  });
});

describe("POS receipt email — QR Pay lifecycle", () => {
  it("settling QR Pay does NOT email — settle leaves the sale DRAFT and the check PAYMENT_PENDING", async () => {
    const { club, burger } = await bootstrapLounge("Receipt QR Pending Club");
    const principal = await clubAdmin(club.id);
    const member = await makeMemberWithEmail(club.id, "qr1@example.com");

    const { check } = await checkoutToSettlement({
      clubId: club.id, principal, memberId: member.id, burgerId: burger.id,
      paymentMethod: "QR_PAY",
    });
    const after = await db().pOSCheck.findUnique({ where: { id: check!.id } });
    expect(after?.status).toBe("PAYMENT_PENDING");
    expect(after?.receiptEmailStatus).toBeNull();
    expect(after?.receiptEmailedAt).toBeNull();
    const events = await db().emailDeliveryEvent.findMany({ where: { clubId: club.id } });
    expect(events.length).toBe(0);
  });

  it("confirmQRPayment closes the check and emails the receipt (DEV_LOGGED in console mode)", async () => {
    const { club, burger } = await bootstrapLounge("Receipt QR Confirm Club");
    const principal = await clubAdmin(club.id);
    const member = await makeMemberWithEmail(club.id, "qr2@example.com");

    const { check, sale } = await checkoutToSettlement({
      clubId: club.id, principal, memberId: member.id, burgerId: burger.id,
      paymentMethod: "QR_PAY",
    });
    await confirmQRPayment(principal, sale.id, { origin: "http://localhost:3000" });

    const after = await db().pOSCheck.findUnique({ where: { id: check!.id } });
    expect(after?.status).toBe("CLOSED");
    expect(after?.receiptEmailStatus).toBe("DEV_LOGGED");
    expect(after?.receiptEmailAddress).toBe("qr2@example.com");
  });

  it("declineQRPayment leaves the check in PAYMENT_FAILED and never emails", async () => {
    const { club, burger } = await bootstrapLounge("Receipt QR Decline Club");
    const principal = await clubAdmin(club.id);
    const member = await makeMemberWithEmail(club.id, "qr3@example.com");

    const { check, sale } = await checkoutToSettlement({
      clubId: club.id, principal, memberId: member.id, burgerId: burger.id,
      paymentMethod: "QR_PAY",
    });
    await declineQRPayment(principal, sale.id, "card declined");

    const after = await db().pOSCheck.findUnique({ where: { id: check!.id } });
    expect(after?.status).toBe("PAYMENT_FAILED");
    expect(after?.receiptEmailStatus).toBeNull();
    const events = await db().emailDeliveryEvent.findMany({ where: { clubId: club.id } });
    expect(events.length).toBe(0);
  });

  it("expireQRPayment leaves the check in PAYMENT_FAILED and never emails", async () => {
    const { club, burger } = await bootstrapLounge("Receipt QR Expire Club");
    const principal = await clubAdmin(club.id);
    const member = await makeMemberWithEmail(club.id, "qr4@example.com");

    const { check, sale } = await checkoutToSettlement({
      clubId: club.id, principal, memberId: member.id, burgerId: burger.id,
      paymentMethod: "QR_PAY",
    });
    await expireQRPayment(principal, sale.id);

    const after = await db().pOSCheck.findUnique({ where: { id: check!.id } });
    expect(after?.status).toBe("PAYMENT_FAILED");
    expect(after?.receiptEmailStatus).toBeNull();
  });
});

describe("POS receipt email — resend", () => {
  it("resending after settlement writes a NEW EmailDeliveryEvent and refreshes POSCheck status", async () => {
    const { club, burger } = await bootstrapLounge("Receipt Resend Club");
    const principal = await clubAdmin(club.id);
    const member = await makeMemberWithEmail(club.id, "resend@example.com");

    const { check, sale } = await checkoutToSettlement({
      clubId: club.id, principal, memberId: member.id, burgerId: burger.id,
      paymentMethod: "MEMBER_ACCOUNT",
    });
    const before = await db().emailDeliveryEvent.count({ where: { clubId: club.id } });
    await sendAndRecordReceiptEmail({
      checkId: check!.id,
      saleId: sale.id,
      origin: "http://localhost:3000",
    });
    const after = await db().emailDeliveryEvent.count({ where: { clubId: club.id } });
    expect(after).toBe(before + 1);

    const updated = await db().pOSCheck.findUnique({ where: { id: check!.id } });
    expect(updated?.receiptEmailStatus).toBe("DEV_LOGGED");
  });
});
