"use server";

// Server actions for the seat-level POS workflow.
// Thin try/catch wrappers around src/lib/pos/seat-checks.ts.

import { revalidatePath } from "next/cache";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { isAppError } from "@/lib/errors";
import { seatTable, settleCheckBySeats, assignCheckSeat } from "@/lib/pos/seat-checks";
import { addCheckLines, sendUnsentItems, removeCheckLine } from "@/lib/pos/checks";
import { listModifiersForItem, setLineModifiers, type ModifierInput } from "@/lib/pos/modifiers";
import {
  initiateWholeCheckQRPayment,
  confirmQRPayment,
  declineQRPayment,
  expireQRPayment,
  cancelQRPayment,
  getQRPayment,
  simulateQRPayment,
  qrPaymentSimulationEnabled,
} from "@/lib/pos/qr-payment";

type Ok<T> = { ok: true; data: T };
type Err = { ok: false; error: string };
type Result<T> = Ok<T> | Err;
function fail(err: unknown, fallback: string): Err {
  return { ok: false, error: isAppError(err) ? err.safeMessage : fallback };
}
function unauthorized(): Err { return { ok: false, error: "Not signed in" }; }

async function ctx() {
  const p = await getCurrentPrincipal();
  if (!p) return null;
  const clubId = await getActiveClubId({ clubId: p.activeClubId ?? null, role: "" });
  return { p, clubId };
}

export async function seatTableAction(args: {
  tableId: string;
  // Either memberId or memberNumber must be present; the service
  // resolves a number to a member id inside the same club.
  memberId?: string;
  memberNumber?: string;
  partySize?: number;
  notes?: string | null;
}): Promise<Result<{ checkId: string }>> {
  const c = await ctx(); if (!c) return unauthorized();
  try {
    const r = await seatTable(c.p, c.clubId, args);
    revalidatePath("/app/admin/hospitality/reservations/floor");
    revalidatePath("/app/admin/ops/pos/lounge");
    return { ok: true, data: { checkId: r.checkId } };
  } catch (err) { return fail(err, "Could not seat table"); }
}

export async function assignSeatAction(checkId: string, args: {
  seatNumber: number;
  memberId?: string | null;
  memberNumber?: string | null;
  guestName?: string | null;
}): Promise<Result<{ ok: true }>> {
  const c = await ctx(); if (!c) return unauthorized();
  try {
    await assignCheckSeat(c.p, checkId, args);
    revalidatePath(`/app/admin/ops/pos/lounge/table/${checkId}`);
    return { ok: true, data: { ok: true } };
  } catch (err) { return fail(err, "Could not assign seat"); }
}

export async function addSeatItemAction(checkId: string, items: Array<{
  menuItemId: string;
  quantity: number;
  seatNumber?: number;
  tableLevel?: boolean;
  note?: string | null;
}>): Promise<Result<{ ok: true }>> {
  const c = await ctx(); if (!c) return unauthorized();
  try {
    await addCheckLines(c.p, checkId, { items });
    revalidatePath(`/app/admin/ops/pos/lounge/table/${checkId}`);
    return { ok: true, data: { ok: true } };
  } catch (err) { return fail(err, "Could not add item"); }
}

export async function removeSeatLineAction(checkId: string, checkLineId: string): Promise<Result<{ ok: true }>> {
  const c = await ctx(); if (!c) return unauthorized();
  try {
    // Thin wrapper around the existing removeCheckLine service. The
    // service enforces DRAFT-only + tenant + permission; we just plumb
    // the call and revalidate the seat view so the line disappears
    // immediately on success.
    await removeCheckLine(c.p, checkLineId);
    revalidatePath(`/app/admin/ops/pos/lounge/table/${checkId}`);
    return { ok: true, data: { ok: true } };
  } catch (err) { return fail(err, "Could not remove item"); }
}

// Modifier catalog for a single menu item — driven by the "Modify"
// button on a SeatPOS DRAFT line. Thin wrapper around the existing
// modifiers service (single source of truth for the catalog read).
export async function listSeatLineModifiersAction(
  menuItemId: string,
): Promise<Result<Awaited<ReturnType<typeof listModifiersForItem>>>> {
  const c = await ctx(); if (!c) return unauthorized();
  try {
    const data = await listModifiersForItem(c.p, menuItemId);
    return { ok: true, data };
  } catch (err) { return fail(err, "Could not load modifier options"); }
}

// Replace the modifier set on a draft seat line. Same shape the lounge
// POS uses — different action name so the SeatPOS imports stay local.
export async function setSeatLineModifiersAction(
  checkId: string,
  checkLineId: string,
  modifiers: ModifierInput[],
): Promise<Result<{ ok: true }>> {
  const c = await ctx(); if (!c) return unauthorized();
  try {
    await setLineModifiers(c.p, checkLineId, { modifiers });
    revalidatePath(`/app/admin/ops/pos/lounge/table/${checkId}`);
    return { ok: true, data: { ok: true } };
  } catch (err) { return fail(err, "Could not save modifiers"); }
}

export async function sendSeatItemsAction(checkId: string): Promise<Result<{ count: number }>> {
  const c = await ctx(); if (!c) return unauthorized();
  try {
    const r = await sendUnsentItems(c.p, checkId);
    revalidatePath(`/app/admin/ops/pos/lounge/table/${checkId}`);
    revalidatePath("/app/admin/ops/pos/lounge/kitchen");
    revalidatePath("/app/admin/ops/pos/lounge/bar");
    return { ok: true, data: { count: r.chitIds.length } };
  } catch (err) { return fail(err, "Could not send to kitchen/bar"); }
}

export async function settleBySeatsAction(checkId: string, body: {
  groups: Array<{
    label: string;
    seatNumbers: number[];
    paymentMethod: "MEMBER_ACCOUNT" | "QR_PAY";
    memberId?: string | null;
  }>;
  allowUnsentLines?: boolean;
}): Promise<Result<Awaited<ReturnType<typeof settleCheckBySeats>>>> {
  const c = await ctx(); if (!c) return unauthorized();
  try {
    // Resolve the calling request's origin so the receipt email body
    // links back at the same host that issued the receipt. Forwarded
    // headers handle the reverse-proxy case; fall back to `host`.
    // settleCheckBySeats uses this for the merge-all-into-one receipt
    // email (single-group, MEMBER_ACCOUNT, fully closed).
    const { headers } = await import("next/headers");
    const h = headers();
    const proto = h.get("x-forwarded-proto") ?? "http";
    const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
    const origin = `${proto}://${host}`;
    const r = await settleCheckBySeats(c.p, checkId, { ...body, origin });
    revalidatePath(`/app/admin/ops/pos/lounge/table/${checkId}`);
    revalidatePath("/app/admin/ops/pos/lounge");
    revalidatePath("/app/admin/ops/pos/lounge/history");
    return { ok: true, data: r };
  } catch (err) { return fail(err, "Could not settle the check"); }
}

// ---------------------------------------------------------------------------
// Step 19 — QR payment lifecycle.
//
// initiate → modal flips to "Waiting for payment" and starts polling
// poll → drives the modal status badge and triggers the close panel
// confirm / decline / expire / cancel → terminal transitions
// simulate → DEV ONLY; routes to one of confirm/decline/expire.
// ---------------------------------------------------------------------------

async function originFromHeaders(): Promise<string> {
  const { headers } = await import("next/headers");
  const h = headers();
  const proto = h.get("x-forwarded-proto") ?? "http";
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  return `${proto}://${host}`;
}

export async function initiateQRPaymentAction(args: {
  checkId: string;
  memberId?: string | null;
}): Promise<Result<{
  paymentId: string;
  paymentUrl: string;
  status: string;
  amount: number;
  simulationEnabled: boolean;
}>> {
  const c = await ctx(); if (!c) return unauthorized();
  try {
    const origin = await originFromHeaders();
    const payment = await initiateWholeCheckQRPayment(c.p, c.clubId, {
      checkId: args.checkId,
      memberId: args.memberId ?? null,
      origin,
    });
    revalidatePath(`/app/admin/ops/pos/lounge/table/${args.checkId}`);
    return {
      ok: true,
      data: {
        paymentId: payment.id,
        paymentUrl: payment.paymentUrl,
        status: payment.status,
        amount: Number(payment.amount.toString()),
        simulationEnabled: qrPaymentSimulationEnabled(),
      },
    };
  } catch (err) { return fail(err, "Could not start QR payment"); }
}

export async function getQRPaymentStatusAction(paymentId: string): Promise<Result<{
  status: string;
  paymentUrl: string;
  amount: number;
  saleId: string | null;
  checkStatus: string | null;
  failureReason: string | null;
}>> {
  const c = await ctx(); if (!c) return unauthorized();
  try {
    const payment = await getQRPayment(c.p, paymentId);
    // Lift current check status so the modal can collapse into the
    // success panel without a second round-trip.
    const { prisma } = await import("@/lib/prisma");
    const check = await prisma.pOSCheck.findUnique({
      where: { id: payment.posCheckId },
      select: { status: true },
    });
    return {
      ok: true,
      data: {
        status: payment.status,
        paymentUrl: payment.paymentUrl,
        amount: Number(payment.amount.toString()),
        saleId: payment.posSaleId,
        checkStatus: check?.status ?? null,
        failureReason: payment.failureReason,
      },
    };
  } catch (err) { return fail(err, "Could not load QR payment status"); }
}

export async function confirmQRPaymentAction(paymentId: string): Promise<Result<{
  status: string;
  saleId: string | null;
  checkStatus: string;
}>> {
  const c = await ctx(); if (!c) return unauthorized();
  try {
    const origin = await originFromHeaders();
    const r = await confirmQRPayment(c.p, paymentId, { origin });
    revalidatePath(`/app/admin/ops/pos/lounge/table/${r.payment.posCheckId}`);
    revalidatePath("/app/admin/ops/pos/lounge");
    revalidatePath("/app/admin/ops/pos/lounge/history");
    revalidatePath("/app/admin/hospitality/reservations/floor");
    return {
      ok: true,
      data: { status: r.payment.status, saleId: r.saleId, checkStatus: r.checkStatus },
    };
  } catch (err) { return fail(err, "Could not confirm QR payment"); }
}

export async function declineQRPaymentAction(paymentId: string, reason?: string): Promise<Result<{ status: string }>> {
  const c = await ctx(); if (!c) return unauthorized();
  try {
    const p = await declineQRPayment(c.p, paymentId, reason);
    revalidatePath(`/app/admin/ops/pos/lounge/table/${p.posCheckId}`);
    return { ok: true, data: { status: p.status } };
  } catch (err) { return fail(err, "Could not decline QR payment"); }
}

export async function expireQRPaymentAction(paymentId: string): Promise<Result<{ status: string }>> {
  const c = await ctx(); if (!c) return unauthorized();
  try {
    const p = await expireQRPayment(c.p, paymentId);
    revalidatePath(`/app/admin/ops/pos/lounge/table/${p.posCheckId}`);
    return { ok: true, data: { status: p.status } };
  } catch (err) { return fail(err, "Could not expire QR payment"); }
}

export async function cancelQRPaymentAction(paymentId: string, reason?: string): Promise<Result<{ status: string }>> {
  const c = await ctx(); if (!c) return unauthorized();
  try {
    const p = await cancelQRPayment(c.p, paymentId, reason);
    revalidatePath(`/app/admin/ops/pos/lounge/table/${p.posCheckId}`);
    return { ok: true, data: { status: p.status } };
  } catch (err) { return fail(err, "Could not cancel QR payment"); }
}

// DEVELOPMENT ONLY. Hard-blocked in production by simulateQRPayment.
export async function simulateQRPaymentAction(
  paymentId: string,
  outcome: "CONFIRM" | "DECLINE" | "EXPIRE",
): Promise<Result<{ status: string }>> {
  const c = await ctx(); if (!c) return unauthorized();
  try {
    const origin = await originFromHeaders();
    const r = await simulateQRPayment(c.p, paymentId, outcome, { origin });
    const status = "status" in r ? (r as { status: string }).status : (r as { payment: { status: string } }).payment.status;
    const { prisma } = await import("@/lib/prisma");
    const checkId = (await prisma.pOSQRPayment.findUnique({
      where: { id: paymentId }, select: { posCheckId: true },
    }))?.posCheckId;
    if (checkId) {
      revalidatePath(`/app/admin/ops/pos/lounge/table/${checkId}`);
    }
    return { ok: true, data: { status } };
  } catch (err) { return fail(err, "Could not simulate QR payment"); }
}
