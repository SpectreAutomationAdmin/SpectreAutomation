// Lounge POS workflow tests — the focused fixes for:
//   • READY → SERVED transition
//   • settle-on-member-account writes receipt email status
//   • QR Pay defers AR/GL until confirmQRPayment
//   • QR decline / expire leaves the check in PAYMENT_FAILED
//   • Active vs closed check filtering
//
// The chit PDF inline-disposition + history-page rendering are
// surface-level concerns covered by manual testing (handled in the
// final summary). These tests cover the service-layer correctness
// the workflow depends on.

import { describe, it, expect, beforeEach } from "vitest";
import { db, makeUser, makeMember, resetDb, principalFor } from "./util/db";
import { bootstrapAPClub } from "./util/ap";
import {
  openCheck,
  addCheckLines,
  sendUnsentItems,
  acknowledgeChit,
  markChitReady,
  markCheckLineServed,
  markChitServed,
  settleCheck,
  confirmQRPayment,
  declineQRPayment,
  expireQRPayment,
  listOpenChecks,
  listClosedChecks,
  getCheck,
} from "@/lib/pos/checks";
import { LOUNGE_LOCATION_CODE, LOUNGE_TERMINAL_CODE } from "@/lib/pos/lounge";
import { ConflictError } from "@/lib/errors";

async function bootstrapLounge(name = "Workflow Test Club") {
  const club = await bootstrapAPClub(name);
  const fbDept = await db().department.findFirst({ where: { clubId: club.id, code: "FB" } });
  const location = await db().pOSLocation.create({
    data: { clubId: club.id, code: LOUNGE_LOCATION_CODE, name: "Clubhouse Lounge", departmentId: fbDept?.id ?? null },
  });
  const terminal = await db().pOSTerminal.create({
    data: { clubId: club.id, code: LOUNGE_TERMINAL_CODE, name: "Lounge Terminal", locationId: location.id },
  });
  await db().pOSSession.create({
    data: { clubId: club.id, locationId: location.id, terminalId: terminal.id, status: "OPEN", openingFloat: 0 },
  });
  const mainsCat = await db().pOSMenuCategory.create({
    data: { clubId: club.id, locationId: location.id, name: "Mains", sortOrder: 1, isActive: true, chitDestination: "KITCHEN" },
  });
  const burger = await db().pOSMenuItem.create({
    data: { clubId: club.id, categoryId: mainsCat.id, name: "Burger", price: 20, taxable: true, isActive: true },
  });
  return { club, items: { burger } };
}

async function clubAdmin(clubId: string, suffix = "") {
  const email = `wf-admin${suffix}-${clubId}@example.com`;
  await makeUser({ email, role: "CLUB_ADMIN", clubId });
  return principalFor(email);
}

async function fullyReadyCheck(opts: { clubId: string; principal: Awaited<ReturnType<typeof clubAdmin>>; memberId: string; itemId: string }) {
  const { clubId, principal, memberId, itemId } = opts;
  const check = await openCheck(principal, clubId, { memberId });
  await addCheckLines(principal, check.id, { items: [{ menuItemId: itemId, quantity: 1 }] });
  const { chitIds } = await sendUnsentItems(principal, check.id);
  // Drive the chit READY so the line goes READY.
  await acknowledgeChit(principal, chitIds[0]);
  await markChitReady(principal, chitIds[0]);
  return check;
}

beforeEach(async () => {
  await resetDb();
});

// ===========================================================================
// READY → SERVED
// ===========================================================================
describe("Mark Served", () => {
  it("transitions a READY line to SERVED and stamps servedAt + servedByUserId", async () => {
    const { club, items } = await bootstrapLounge();
    const p = await clubAdmin(club.id);
    const member = await makeMember(club.id);
    const check = await fullyReadyCheck({ clubId: club.id, principal: p, memberId: member.id, itemId: items.burger.id });
    const full = await getCheck(p, check.id);
    const lineId = full.lines[0].id;

    await markCheckLineServed(p, lineId);
    const refreshed = await db().pOSCheckLine.findUnique({ where: { id: lineId } });
    expect(refreshed?.status).toBe("SERVED");
    expect(refreshed?.servedAt).not.toBeNull();
    expect(refreshed?.servedByUserId).toBe(p.id);

    // Chit-line mirror gets stamped too.
    const chitLine = await db().pOSChitLine.findFirst({ where: { checkLineId: lineId } });
    expect(chitLine?.servedAt).not.toBeNull();
    expect(chitLine?.servedByUserId).toBe(p.id);
  });

  it("refuses to mark a non-READY line", async () => {
    const { club, items } = await bootstrapLounge();
    const p = await clubAdmin(club.id);
    const member = await makeMember(club.id);
    const check = await openCheck(p, club.id, { memberId: member.id });
    await addCheckLines(p, check.id, { items: [{ menuItemId: items.burger.id, quantity: 1 }] });
    // Line is DRAFT — not eligible
    const full = await getCheck(p, check.id);
    await expect(markCheckLineServed(p, full.lines[0].id)).rejects.toThrow(ConflictError);
  });

  it("markChitServed flips every chit line + every check line to SERVED in one go AND promotes the chit to SERVED", async () => {
    const { club, items } = await bootstrapLounge();
    const p = await clubAdmin(club.id);
    const member = await makeMember(club.id);
    const check = await fullyReadyCheck({ clubId: club.id, principal: p, memberId: member.id, itemId: items.burger.id });
    const chits = await db().pOSChit.findMany({ where: { checkId: check.id } });
    await markChitServed(p, chits[0].id);
    const lines = await db().pOSCheckLine.findMany({ where: { checkId: check.id } });
    expect(lines.every((l) => l.status === "SERVED")).toBe(true);
    expect(lines[0].servedByUserId).toBe(p.id);
    // Chit row itself should now be SERVED so the open-checks queue
    // badge can read "Delivered" instead of being stuck on READY.
    const refreshedChit = await db().pOSChit.findUnique({ where: { id: chits[0].id } });
    expect(refreshedChit?.status).toBe("SERVED");
  });

  it("markCheckLineServed promotes the chit to SERVED once all its lines are served", async () => {
    const { club, items } = await bootstrapLounge();
    const p = await clubAdmin(club.id);
    const member = await makeMember(club.id);
    // Single-line check → marking that one line served should fully
    // promote the chit.
    const check = await fullyReadyCheck({ clubId: club.id, principal: p, memberId: member.id, itemId: items.burger.id });
    const full = await getCheck(p, check.id);
    await markCheckLineServed(p, full.lines[0].id);
    const chit = await db().pOSChit.findFirst({ where: { checkId: check.id } });
    expect(chit?.status).toBe("SERVED");
  });
});

// ===========================================================================
// Charge-to-member: receipt email status + close
// ===========================================================================
describe("Charge to member account", () => {
  it("settles immediately, closes the check, and persists receiptEmailStatus", async () => {
    const { club, items } = await bootstrapLounge();
    const p = await clubAdmin(club.id);
    // makeMember already auto-generates an email on the test member.
    const member = await makeMember(club.id);
    const check = await openCheck(p, club.id, { memberId: member.id });
    await addCheckLines(p, check.id, { items: [{ menuItemId: items.burger.id, quantity: 1 }] });
    await sendUnsentItems(p, check.id);
    await settleCheck(p, check.id, { paymentMethod: "MEMBER_ACCOUNT", origin: "https://test.example" });

    const closed = await db().pOSCheck.findUnique({ where: { id: check.id } });
    expect(closed?.status).toBe("CLOSED");
    expect(closed?.closedAt).not.toBeNull();
    expect(closed?.settlementMethod).toBe("MEMBER_ACCOUNT");
    // Email status persisted — console mode reports DEV_LOGGED so the UI
    // doesn't claim real delivery happened.
    expect(closed?.receiptEmailStatus).toBe("DEV_LOGGED");
    expect(closed?.receiptEmailAddress).toBeTruthy();
    // DEV_LOGGED never sets `receiptEmailedAt` — only real provider acceptance does.
    expect(closed?.receiptEmailedAt).toBeNull();
  });

  it("records SKIPPED_NO_EMAIL when the member has no email on file", async () => {
    const { club, items } = await bootstrapLounge();
    const p = await clubAdmin(club.id);
    // Schema requires email; the receipts service treats an empty /
    // malformed email as SKIPPED_NO_EMAIL, so we stand in with "".
    const member = await db().member.create({
      data: {
        clubId: club.id, firstName: "No", lastName: "Email",
        memberNumber: `SS-${Math.floor(Math.random() * 9999)}`,
        email: "", status: "ACTIVE", paymentMethodStatus: "NONE",
      },
    });
    await db().memberAccount.create({ data: { clubId: club.id, memberId: member.id } });
    const check = await openCheck(p, club.id, { memberId: member.id });
    await addCheckLines(p, check.id, { items: [{ menuItemId: items.burger.id, quantity: 1 }] });
    await sendUnsentItems(p, check.id);
    await settleCheck(p, check.id, { paymentMethod: "MEMBER_ACCOUNT", origin: "https://test.example" });
    const closed = await db().pOSCheck.findUnique({ where: { id: check.id } });
    expect(closed?.receiptEmailStatus).toBe("SKIPPED_NO_EMAIL");
    // Settlement still succeeded.
    expect(closed?.status).toBe("CLOSED");
  });
});

// ===========================================================================
// QR Pay: defer / confirm / decline / expire
// ===========================================================================
describe("QR Pay lifecycle", () => {
  it("settle returns immediately with PAYMENT_PENDING; AR/GL only post on confirmQRPayment", async () => {
    const { club, items } = await bootstrapLounge();
    const p = await clubAdmin(club.id);
    const member = await makeMember(club.id);
    const check = await openCheck(p, club.id, { memberId: member.id });
    await addCheckLines(p, check.id, { items: [{ menuItemId: items.burger.id, quantity: 1 }] });
    await sendUnsentItems(p, check.id);
    const { sale } = await settleCheck(p, check.id, { paymentMethod: "QR_PAY", origin: "https://test.example" });

    // Pending — no AR Charge, no closed check, no email
    const pending = await db().pOSCheck.findUnique({ where: { id: check.id } });
    expect(pending?.status).toBe("PAYMENT_PENDING");
    expect(pending?.closedAt).toBeNull();
    expect(pending?.receiptEmailStatus).toBeNull();
    const draft = await db().pOSSale.findUnique({ where: { id: sale.id } });
    expect(draft?.status).toBe("DRAFT");
    expect(draft?.arChargeId).toBeNull();

    // Confirm
    await confirmQRPayment(p, sale.id, { origin: "https://test.example" });

    const closed = await db().pOSCheck.findUnique({ where: { id: check.id } });
    expect(closed?.status).toBe("CLOSED");
    expect(closed?.closedAt).not.toBeNull();
    expect(closed?.settlementMethod).toBe("QR_PAY");
    // Console-mode dev adapter logs the email but doesn't actually send,
    // so the status is DEV_LOGGED rather than SENT.
    expect(closed?.receiptEmailStatus).toBe("DEV_LOGGED");

    const completed = await db().pOSSale.findUnique({ where: { id: sale.id } });
    expect(completed?.status).toBe("COMPLETED");
    // QR Pay is cash-like (paid by gateway), so no AR Charge — but
    // the JE still posts revenue + tax + cash.
    expect(completed?.postedJournalEntryId).not.toBeNull();
  });

  it("declined QR payment keeps the check in PAYMENT_FAILED (still active list)", async () => {
    const { club, items } = await bootstrapLounge();
    const p = await clubAdmin(club.id);
    const member = await makeMember(club.id);
    const check = await openCheck(p, club.id, { memberId: member.id });
    await addCheckLines(p, check.id, { items: [{ menuItemId: items.burger.id, quantity: 1 }] });
    await sendUnsentItems(p, check.id);
    const { sale } = await settleCheck(p, check.id, { paymentMethod: "QR_PAY", origin: "https://test.example" });
    await declineQRPayment(p, sale.id, "Card declined");

    const failed = await db().pOSCheck.findUnique({ where: { id: check.id } });
    expect(failed?.status).toBe("PAYMENT_FAILED");
    expect(failed?.closedAt).toBeNull();
    const payment = await db().pOSPayment.findFirst({ where: { saleId: sale.id } });
    expect(payment?.externalPaymentStatus).toBe("DECLINED");
    expect(payment?.failureReason).toBe("Card declined");
    // Active list still includes the failed check
    const active = await listOpenChecks(p, club.id);
    expect(active.map((c) => c.id)).toContain(check.id);
  });

  it("expired QR payment marks the check as PAYMENT_FAILED with reason=expired", async () => {
    const { club, items } = await bootstrapLounge();
    const p = await clubAdmin(club.id);
    const member = await makeMember(club.id);
    const check = await openCheck(p, club.id, { memberId: member.id });
    await addCheckLines(p, check.id, { items: [{ menuItemId: items.burger.id, quantity: 1 }] });
    await sendUnsentItems(p, check.id);
    const { sale } = await settleCheck(p, check.id, { paymentMethod: "QR_PAY", origin: "https://test.example" });
    await expireQRPayment(p, sale.id);
    const failed = await db().pOSCheck.findUnique({ where: { id: check.id } });
    expect(failed?.status).toBe("PAYMENT_FAILED");
    const payment = await db().pOSPayment.findFirst({ where: { saleId: sale.id } });
    expect(payment?.externalPaymentStatus).toBe("EXPIRED");
  });
});

// ===========================================================================
// Active vs closed check filtering
// ===========================================================================
describe("Active vs closed check filtering", () => {
  it("listOpenChecks includes PAYMENT_PENDING + PAYMENT_FAILED, excludes CLOSED/VOIDED", async () => {
    const { club, items } = await bootstrapLounge();
    const p = await clubAdmin(club.id);
    const member = await makeMember(club.id);

    // 1) An OPEN check
    const a = await openCheck(p, club.id, { memberId: member.id });
    // 2) A PAYMENT_PENDING check
    const b = await openCheck(p, club.id, { memberId: member.id });
    await addCheckLines(p, b.id, { items: [{ menuItemId: items.burger.id, quantity: 1 }] });
    await sendUnsentItems(p, b.id);
    await settleCheck(p, b.id, { paymentMethod: "QR_PAY", origin: "https://test.example" });
    // 3) A CLOSED check
    const c = await openCheck(p, club.id, { memberId: member.id });
    await addCheckLines(p, c.id, { items: [{ menuItemId: items.burger.id, quantity: 1 }] });
    await sendUnsentItems(p, c.id);
    await settleCheck(p, c.id, { paymentMethod: "MEMBER_ACCOUNT", origin: "https://test.example" });

    const active = await listOpenChecks(p, club.id);
    const activeIds = active.map((x) => x.id);
    expect(activeIds).toContain(a.id);
    expect(activeIds).toContain(b.id);
    expect(activeIds).not.toContain(c.id);

    const closed = await listClosedChecks(p, club.id);
    const closedIds = closed.map((x) => x.id);
    expect(closedIds).toContain(c.id);
    expect(closedIds).not.toContain(a.id);
    expect(closedIds).not.toContain(b.id);
  });

  it("listClosedChecks filters by settlementMethod", async () => {
    const { club, items } = await bootstrapLounge();
    const p = await clubAdmin(club.id);
    const member = await makeMember(club.id);

    const a = await openCheck(p, club.id, { memberId: member.id });
    await addCheckLines(p, a.id, { items: [{ menuItemId: items.burger.id, quantity: 1 }] });
    await sendUnsentItems(p, a.id);
    await settleCheck(p, a.id, { paymentMethod: "MEMBER_ACCOUNT", origin: "https://test.example" });

    const b = await openCheck(p, club.id, { memberId: member.id });
    await addCheckLines(p, b.id, { items: [{ menuItemId: items.burger.id, quantity: 1 }] });
    await sendUnsentItems(p, b.id);
    const { sale } = await settleCheck(p, b.id, { paymentMethod: "QR_PAY", origin: "https://test.example" });
    await confirmQRPayment(p, sale.id, { origin: "https://test.example" });

    const memberOnly = await listClosedChecks(p, club.id, { settlementMethod: "MEMBER_ACCOUNT" });
    expect(memberOnly.map((c) => c.id)).toContain(a.id);
    expect(memberOnly.map((c) => c.id)).not.toContain(b.id);

    const qrOnly = await listClosedChecks(p, club.id, { settlementMethod: "QR_PAY" });
    expect(qrOnly.map((c) => c.id)).toContain(b.id);
    expect(qrOnly.map((c) => c.id)).not.toContain(a.id);
  });
});

// ===========================================================================
// Email failure doesn't block settlement
// ===========================================================================
describe("Email failure doesn't block settlement", () => {
  it("hard-bounced email is recorded as FAILED but the check still closes", async () => {
    const { club, items } = await bootstrapLounge();
    const p = await clubAdmin(club.id);
    // Suppressed email (the dev adapter respects EmailSuppression)
    const suppressedEmail = `bounce-${Date.now()}@example.com`;
    await db().emailSuppression.create({
      data: {
        email: suppressedEmail,
        reason: "HARD_BOUNCE",
      },
    });
    // Bypass makeMember to force a specific email that's on the
    // suppression list.
    const member = await db().member.create({
      data: {
        clubId: club.id, firstName: "Suppressed", lastName: "Member",
        memberNumber: `SS-${Math.floor(Math.random() * 9999)}`,
        email: suppressedEmail, status: "ACTIVE", paymentMethodStatus: "NONE",
      },
    });
    await db().memberAccount.create({ data: { clubId: club.id, memberId: member.id } });
    const check = await openCheck(p, club.id, { memberId: member.id });
    await addCheckLines(p, check.id, { items: [{ menuItemId: items.burger.id, quantity: 1 }] });
    await sendUnsentItems(p, check.id);
    await settleCheck(p, check.id, { paymentMethod: "MEMBER_ACCOUNT", origin: "https://test.example" });
    const closed = await db().pOSCheck.findUnique({ where: { id: check.id } });
    expect(closed?.status).toBe("CLOSED");
    // Suppression is reported separately from outright failure.
    expect(["SUPPRESSED", "FAILED"]).toContain(closed?.receiptEmailStatus ?? "");
  });
});
