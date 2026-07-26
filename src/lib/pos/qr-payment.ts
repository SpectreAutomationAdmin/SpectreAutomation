// Step 19 — QR-code payment lifecycle.
//
// When a member's charge account is suspended (Member.accessStatus
// CHARGE_ACCOUNT_SUSPENDED or FULL_SUSPENSION), the server cannot
// post to MEMBER_ACCOUNT. Pay by QR Code is the alternative: a
// pending POSQRPayment row holds the "waiting for payment" state
// until the external gateway confirms (or declines / expires).
//
// Only on CONFIRMED do we touch the financials:
//   - settleCheckBySeats runs with a single QR_PAY group
//   - createSale + completeSale post the balanced JE (DR Cash 1010 /
//     CR F&B revenue / CR GST payable) — no AR charge
//   - the check closes, the table flips to DIRTY
//   - the merge-all receipt email fires
//
// DECLINED / EXPIRED / CANCELLED leave the check active so the server
// can retry or pick a different method. No GL, no receipt, no
// member-dining history are touched on those terminal states.
//
// DEVELOPMENT ONLY: `simulateQRPayment` lets the floor server drive
// the outcome from the SeatPOS modal during QA. It is hard-blocked
// from production by `assertSimulationAllowed` below.

import { Prisma } from "@prisma/client";
import { prisma } from "../prisma";
import { audit } from "../audit";
import { requirePermission, type Principal } from "../rbac";
import { assertTenantOwned } from "../services/tenant";
import { ConflictError, NotFoundError, ValidationError } from "../errors";
import { settleCheckBySeats } from "./seat-checks";

export const QR_PAYMENT_STATUSES = [
  "CREATED",
  "QR_ISSUED",
  "PENDING",
  "CONFIRMED",
  "DECLINED",
  "EXPIRED",
  "CANCELLED",
] as const;
export type QRPaymentStatus = (typeof QR_PAYMENT_STATUSES)[number];

const TERMINAL_FAILURE_STATUSES: QRPaymentStatus[] = ["DECLINED", "EXPIRED", "CANCELLED"];

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function assertSimulationAllowed() {
  if (process.env.NODE_ENV === "production") {
    throw new ConflictError("QR payment simulation is disabled in production.");
  }
}

// ---------------------------------------------------------------------------
// Amount derivation — mirrors the priced-line math in
// settleCheckBySeats so the QR amount and the eventual sale total
// agree to the cent.
//
// What counts as "unsettled":
//   - The line is on this check.
//   - Status is anything other than VOIDED or COMPED. Kitchen/service
//     statuses (DRAFT / SENT / FIRED / PREPARING / READY / SERVED)
//     are NOT settlement statuses and must all count.
//   - The line either has no settlementGroupId OR points to a group
//     that has not been SETTLED yet. (Step 20 — previously this was
//     a stricter `settlementGroupId: null`. If a prior settle attempt
//     stamped the line but didn't finalise — e.g. it threw mid-way —
//     the line stayed stamped and silently dropped out of the QR
//     amount, producing the "no unsettled amount" false negative.
//     The new predicate matches what `settleCheckBySeats` would
//     actually pick up.)
//
// Modifiers fold into the unit price; GST 5% applies to taxable
// lines only — same math as the settle engine.
// ---------------------------------------------------------------------------
type UnsettledTotal = {
  amount: number;
  lineCount: number;
  payableLineCount: number;
};

async function computeUnsettledTotal(checkId: string): Promise<UnsettledTotal> {
  const lines = await prisma.pOSCheckLine.findMany({
    where: {
      checkId,
      status: { notIn: ["VOIDED", "COMPED"] },
      OR: [
        { settlementGroupId: null },
        { settlementGroup: { status: { not: "SETTLED" } } },
      ],
    },
    include: { modifiers: true },
  });
  let subtotal = 0;
  let taxableSubtotal = 0;
  let payableLineCount = 0;
  for (const l of lines) {
    const qty = Number(l.quantity.toString());
    const baseUnit = Number(l.unitPrice.toString());
    const disc = Number(l.discountPct.toString());
    const modDeltaPerUnit = l.modifiers.reduce(
      (s, m) => s + Number(m.priceDelta.toString()),
      0,
    );
    const adjustedUnit = round2(baseUnit + modDeltaPerUnit);
    const lineGross = round2(qty * adjustedUnit);
    const lineDiscount = round2(lineGross * (disc / 100));
    const lineNet = round2(lineGross - lineDiscount);
    subtotal += lineNet;
    if (l.taxable) taxableSubtotal += lineNet;
    if (lineNet > 0) payableLineCount++;
  }
  const tax = round2(taxableSubtotal * 0.05);
  return {
    amount: round2(subtotal + tax),
    lineCount: lines.length,
    payableLineCount,
  };
}

// ---------------------------------------------------------------------------
// initiateWholeCheckQRPayment
//
// Creates (or returns the existing) pending POSQRPayment for the
// whole check. The check stays OPEN; settling is deferred to
// confirmQRPayment.
// ---------------------------------------------------------------------------
export async function initiateWholeCheckQRPayment(
  principal: Principal,
  clubId: string,
  args: { checkId: string; memberId?: string | null; origin: string },
) {
  requirePermission(principal, clubId, "inventory:write");
  const check = await prisma.pOSCheck.findUnique({
    where: { id: args.checkId },
  });
  if (!check) throw new NotFoundError("POSCheck", args.checkId);
  assertTenantOwned(check, principal);
  if (check.clubId !== clubId) {
    // Defensive: assertTenantOwned would have thrown; this also pins
    // multi-club admins to the explicitly-passed clubId.
    throw new ConflictError("Check belongs to a different club.");
  }
  if (check.status === "CLOSED" || check.status === "VOIDED") {
    throw new ConflictError(`Check is already ${check.status.toLowerCase()}.`);
  }

  // Idempotent: reuse the most recent open QR row for this check.
  const existing = await prisma.pOSQRPayment.findFirst({
    where: {
      posCheckId: args.checkId,
      clubId,
      status: { in: ["CREATED", "QR_ISSUED", "PENDING"] },
    },
    orderBy: { createdAt: "desc" },
  });
  if (existing) return existing;

  const { amount, lineCount, payableLineCount } = await computeUnsettledTotal(args.checkId);
  if (lineCount === 0) {
    // Truly nothing unpaid on this check.
    throw new ConflictError("No unpaid items remain on this check.");
  }
  if (payableLineCount === 0 || amount <= 0) {
    // Items exist, but the priced math collapses to zero. Almost
    // always means the menu item carries unitPrice=0 or every line
    // is 100%-discounted — surface that distinctly so staff knows
    // to fix the menu pricing rather than retrying.
    throw new ConflictError(
      "This check has items, but none could be priced for payment. Review menu pricing.",
    );
  }

  // Two-step write: create then patch the paymentUrl in. The id is
  // needed to build the URL, so a single .create can't both have a
  // valid URL and resolve it from the row id. Cheap on SQLite/PG.
  const created = await prisma.pOSQRPayment.create({
    data: {
      clubId,
      posCheckId: args.checkId,
      memberId: args.memberId ?? null,
      amount: new Prisma.Decimal(amount),
      paymentUrl: "",
      status: "QR_ISSUED",
      // 30-minute window matches the dev-default; expiry is enforced
      // by the EXPIRE path, not by a timer.
      expiresAt: new Date(Date.now() + 30 * 60 * 1000),
    },
  });
  const paymentUrl = `${args.origin.replace(/\/$/, "")}/qr/${created.id}`;
  const updated = await prisma.pOSQRPayment.update({
    where: { id: created.id },
    data: { paymentUrl },
  });

  await audit(principal, {
    action: "pos.qr-payment.issue",
    entityType: "POSQRPayment",
    entityId: created.id,
    clubId,
    after: { checkId: args.checkId, amount, memberId: args.memberId ?? null },
  });
  return updated;
}

// ---------------------------------------------------------------------------
// confirmQRPayment
//
// The "external gateway said paid" path. Idempotent — re-confirming
// a CONFIRMED row is a no-op (matches spec rule 20). On the first
// confirm: settle the whole check via the QR_PAY merge-all group,
// which posts the JE, closes the check, flips the table to DIRTY,
// and fires the receipt email.
// ---------------------------------------------------------------------------
export async function confirmQRPayment(
  principal: Principal,
  paymentId: string,
  opts: { origin: string },
) {
  const payment = await prisma.pOSQRPayment.findUnique({ where: { id: paymentId } });
  if (!payment) throw new NotFoundError("POSQRPayment", paymentId);
  assertTenantOwned(payment, principal);
  requirePermission(principal, payment.clubId, "inventory:write");

  if (payment.status === "CONFIRMED") {
    // Already-paid retry. Return current state without double-posting.
    const check = await prisma.pOSCheck.findUnique({ where: { id: payment.posCheckId } });
    return {
      payment,
      checkStatus: check?.status ?? "CLOSED",
      saleId: payment.posSaleId,
    };
  }
  if (TERMINAL_FAILURE_STATUSES.includes(payment.status as QRPaymentStatus)) {
    throw new ConflictError(`QR payment is already ${payment.status.toLowerCase()}.`);
  }

  // Determine which seats hold unsettled lines so the merge-all group
  // covers every line. Seat-less / table-level lines still post
  // (settleCheckBySeats distributes them onto the first group), but
  // they need at least one seatNumber in the group to satisfy the
  // schema.
  const lines = await prisma.pOSCheckLine.findMany({
    where: {
      checkId: payment.posCheckId,
      status: { not: "VOIDED" },
      settlementGroupId: null,
    },
    select: { seatNumber: true },
  });
  const seatSet = new Set<number>();
  for (const l of lines) {
    if (l.seatNumber !== null) seatSet.add(l.seatNumber);
  }
  if (seatSet.size === 0) seatSet.add(1);
  const seatNumbers = Array.from(seatSet).sort((a, b) => a - b);

  const settled = await settleCheckBySeats(principal, payment.posCheckId, {
    groups: [{
      label: "Pay by QR Code",
      seatNumbers,
      paymentMethod: "QR_PAY",
      memberId: payment.memberId ?? null,
    }],
    origin: opts.origin,
  });

  const saleId = settled.groups[0]?.posSaleId ?? null;
  const updated = await prisma.pOSQRPayment.update({
    where: { id: payment.id },
    data: {
      status: "CONFIRMED",
      confirmedAt: new Date(),
      posSaleId: saleId,
    },
  });
  await audit(principal, {
    action: "pos.qr-payment.confirm",
    entityType: "POSQRPayment",
    entityId: payment.id,
    clubId: payment.clubId,
    after: { saleId, checkStatus: settled.check.status, amount: Number(payment.amount.toString()) },
  });
  return {
    payment: updated,
    checkStatus: settled.check.status,
    saleId,
  };
}

// ---------------------------------------------------------------------------
// declineQRPayment / expireQRPayment / cancelQRPayment
//
// Terminal-failure paths: flip status, write audit, do nothing
// financial. The check stays in its current status (OPEN /
// PARTIALLY_SETTLED) so the server can retry or pick another method.
// ---------------------------------------------------------------------------
async function transitionToTerminalFailure(
  principal: Principal,
  paymentId: string,
  outcome: "DECLINED" | "EXPIRED" | "CANCELLED",
  reason?: string,
) {
  const payment = await prisma.pOSQRPayment.findUnique({ where: { id: paymentId } });
  if (!payment) throw new NotFoundError("POSQRPayment", paymentId);
  assertTenantOwned(payment, principal);
  requirePermission(principal, payment.clubId, "inventory:write");
  if (payment.status === "CONFIRMED") {
    throw new ConflictError("QR payment was already confirmed and cannot be reversed here.");
  }
  if (TERMINAL_FAILURE_STATUSES.includes(payment.status as QRPaymentStatus)) {
    // Idempotent terminal: leave the prior outcome stamp in place.
    return payment;
  }
  const now = new Date();
  const updates: Prisma.POSQRPaymentUpdateInput = {
    status: outcome,
    failureReason: reason ?? null,
  };
  if (outcome === "DECLINED") updates.declinedAt = now;
  if (outcome === "EXPIRED") updates.expiredAt = now;
  if (outcome === "CANCELLED") updates.cancelledAt = now;
  const updated = await prisma.pOSQRPayment.update({
    where: { id: payment.id },
    data: updates,
  });
  await audit(principal, {
    action: `pos.qr-payment.${outcome.toLowerCase()}`,
    entityType: "POSQRPayment",
    entityId: payment.id,
    clubId: payment.clubId,
    after: { outcome, reason: reason ?? null },
  });
  return updated;
}

export function declineQRPayment(principal: Principal, paymentId: string, reason?: string) {
  return transitionToTerminalFailure(principal, paymentId, "DECLINED", reason ?? "Declined by gateway");
}
export function expireQRPayment(principal: Principal, paymentId: string) {
  return transitionToTerminalFailure(principal, paymentId, "EXPIRED", "QR window elapsed");
}
export function cancelQRPayment(principal: Principal, paymentId: string, reason?: string) {
  return transitionToTerminalFailure(principal, paymentId, "CANCELLED", reason ?? "Cancelled by server");
}

// ---------------------------------------------------------------------------
// getQRPayment — tenant-safe single-row read. Used by the polling
// action so the UI can drive the pending → confirmed/declined
// transition in the modal.
// ---------------------------------------------------------------------------
export async function getQRPayment(principal: Principal, paymentId: string) {
  const payment = await prisma.pOSQRPayment.findUnique({ where: { id: paymentId } });
  if (!payment) throw new NotFoundError("POSQRPayment", paymentId);
  assertTenantOwned(payment, principal);
  requirePermission(principal, payment.clubId, "inventory:read");
  return payment;
}

// ---------------------------------------------------------------------------
// simulateQRPayment — DEVELOPMENT ONLY.
//
// Hard-blocked from production. UI displays the simulation buttons
// only when this gate would allow them. The action layer re-checks
// before invoking, so a forged client-side render cannot bypass it.
// ---------------------------------------------------------------------------
export async function simulateQRPayment(
  principal: Principal,
  paymentId: string,
  outcome: "CONFIRM" | "DECLINE" | "EXPIRE",
  opts: { origin: string },
) {
  assertSimulationAllowed();
  if (outcome === "CONFIRM") return confirmQRPayment(principal, paymentId, opts);
  if (outcome === "DECLINE") return declineQRPayment(principal, paymentId, "Simulated decline");
  if (outcome === "EXPIRE") return expireQRPayment(principal, paymentId);
  throw new ValidationError([{ path: "outcome", message: "Invalid simulate outcome" }]);
}

export function qrPaymentSimulationEnabled(): boolean {
  return process.env.NODE_ENV !== "production";
}
