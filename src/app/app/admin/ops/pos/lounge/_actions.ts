"use server";

// Server actions for the open-check lounge POS flow.
//
// The lounge POS now operates on POSCheck records: server opens a
// check, adds DRAFT lines, sends them as POSChits to prep stations,
// and eventually settles the check (which routes through the existing
// `createSale + completeSale` engine for AR/GL posting).
//
// Tenant safety, posting guards, training-mode + support-readonly
// gates, and audit all live in the service layer — these actions are
// thin try/catch wrappers that translate exceptions into the
// `{ ok, data | error }` shape the client UI consumes.

import { revalidatePath } from "next/cache";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { isAppError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/rbac";
import { assertTenantOwned } from "@/lib/services/tenant";
import { audit } from "@/lib/audit";
import { sendAndRecordReceiptEmail, sendAndRecordGroupReceiptEmail } from "@/lib/pos/receipts";
import {
  openCheck,
  listOpenChecks,
  getCheck,
  addCheckLines,
  removeCheckLine,
  updateCheckLine,
  voidCheckLine,
  compCheckLine,
  setCheckDiningMode,
  setCheckDiscount,
  sendUnsentItems,
  settleCheck,
  voidCheck,
  acknowledgeChit,
  markChitReady,
  setAutoPace,
  fireNextCourse,
  markCheckLineServed,
  markChitServed,
  confirmQRPayment,
  declineQRPayment,
  expireQRPayment,
  listClosedChecks,
} from "@/lib/pos/checks";
import {
  listModifiersForItem,
  setLineModifiers,
  type ModifierInput,
} from "@/lib/pos/modifiers";
import { searchMembersForPos } from "@/lib/pos/lounge";

// ---------- Result helpers ----------
type ActionError = { ok: false; error: string };
type Ok<T> = { ok: true; data: T };
type Result<T> = Ok<T> | ActionError;
function unauthorized(): ActionError {
  return { ok: false, error: "Not signed in" };
}
function fail(err: unknown, fallback: string): ActionError {
  return { ok: false, error: isAppError(err) ? err.safeMessage : fallback };
}

// Used by the open-checks list + new-check member search.
export type SearchedMember = {
  id: string;
  firstName: string;
  lastName: string;
  memberNumber: string;
  status: string;
  accessStatus: string;
  paymentMethodStatus: string;
};

export async function searchMembersAction(query: string): Promise<Result<SearchedMember[]>> {
  const p = await getCurrentPrincipal();
  if (!p) return unauthorized();
  try {
    const clubId = await getActiveClubId({ clubId: p.activeClubId ?? null, role: "" });
    return { ok: true, data: await searchMembersForPos(p, clubId, query) };
  } catch (err) {
    return fail(err, "Could not search members");
  }
}

// ---------- Check management ----------

export async function listOpenChecksAction(): Promise<Result<Awaited<ReturnType<typeof listOpenChecks>>>> {
  const p = await getCurrentPrincipal();
  if (!p) return unauthorized();
  try {
    const clubId = await getActiveClubId({ clubId: p.activeClubId ?? null, role: "" });
    return { ok: true, data: await listOpenChecks(p, clubId) };
  } catch (err) {
    return fail(err, "Could not list open checks");
  }
}

export async function openCheckAction(input: { memberId: string; tableNumber?: string | null; diningMode?: "STAY" | "TO_GO" }): Promise<Result<{ checkId: string }>> {
  const p = await getCurrentPrincipal();
  if (!p) return unauthorized();
  try {
    const clubId = await getActiveClubId({ clubId: p.activeClubId ?? null, role: "" });
    const check = await openCheck(p, clubId, input);
    revalidatePath("/app/admin/ops/pos/lounge");
    return { ok: true, data: { checkId: check.id } };
  } catch (err) {
    return fail(err, "Could not open check");
  }
}

export async function getCheckAction(checkId: string): Promise<Result<Awaited<ReturnType<typeof getCheck>>>> {
  const p = await getCurrentPrincipal();
  if (!p) return unauthorized();
  try {
    return { ok: true, data: await getCheck(p, checkId) };
  } catch (err) {
    return fail(err, "Could not load check");
  }
}

export type AddItemInput = {
  checkId: string;
  items: Array<{
    menuItemId: string;
    quantity?: number;
    note?: string | null;
    discountPct?: number;
    course?: number;
  }>;
};
export async function addItemsAction(input: AddItemInput): Promise<Result<{ checkId: string }>> {
  const p = await getCurrentPrincipal();
  if (!p) return unauthorized();
  try {
    await addCheckLines(p, input.checkId, { items: input.items });
    revalidatePath("/app/admin/ops/pos/lounge");
    return { ok: true, data: { checkId: input.checkId } };
  } catch (err) {
    return fail(err, "Could not add items");
  }
}

export async function removeLineAction(checkLineId: string): Promise<Result<{ ok: true }>> {
  const p = await getCurrentPrincipal();
  if (!p) return unauthorized();
  try {
    await removeCheckLine(p, checkLineId);
    return { ok: true, data: { ok: true } };
  } catch (err) {
    return fail(err, "Could not remove item");
  }
}

export async function updateLineAction(checkLineId: string, patch: { quantity?: number; note?: string | null; discountPct?: number; course?: number }): Promise<Result<{ ok: true }>> {
  const p = await getCurrentPrincipal();
  if (!p) return unauthorized();
  try {
    await updateCheckLine(p, checkLineId, patch);
    return { ok: true, data: { ok: true } };
  } catch (err) {
    return fail(err, "Could not update item");
  }
}

export async function voidLineAction(checkLineId: string, reason: string): Promise<Result<{ ok: true }>> {
  const p = await getCurrentPrincipal();
  if (!p) return unauthorized();
  try {
    await voidCheckLine(p, checkLineId, reason);
    return { ok: true, data: { ok: true } };
  } catch (err) {
    return fail(err, "Could not void item");
  }
}

export async function compLineAction(checkLineId: string, reason: string): Promise<Result<{ ok: true }>> {
  const p = await getCurrentPrincipal();
  if (!p) return unauthorized();
  try {
    await compCheckLine(p, checkLineId, reason);
    return { ok: true, data: { ok: true } };
  } catch (err) {
    return fail(err, "Could not comp item");
  }
}

export async function setDiningModeAction(checkId: string, mode: "STAY" | "TO_GO"): Promise<Result<{ ok: true }>> {
  const p = await getCurrentPrincipal();
  if (!p) return unauthorized();
  try {
    await setCheckDiningMode(p, checkId, mode);
    return { ok: true, data: { ok: true } };
  } catch (err) {
    return fail(err, "Could not change dining mode");
  }
}

export async function setDiscountAction(checkId: string, pct: number): Promise<Result<{ ok: true }>> {
  const p = await getCurrentPrincipal();
  if (!p) return unauthorized();
  try {
    await setCheckDiscount(p, checkId, pct);
    return { ok: true, data: { ok: true } };
  } catch (err) {
    return fail(err, "Could not set discount");
  }
}

export type SendChitsResult = { checkId: string; chitIds: string[] };
export async function sendChitsAction(checkId: string): Promise<Result<SendChitsResult>> {
  const p = await getCurrentPrincipal();
  if (!p) return unauthorized();
  try {
    const r = await sendUnsentItems(p, checkId);
    // Refresh kitchen / bar views.
    revalidatePath("/app/admin/ops/pos/lounge/kitchen");
    revalidatePath("/app/admin/ops/pos/lounge/bar");
    return { ok: true, data: r };
  } catch (err) {
    return fail(err, "Could not send to prep stations");
  }
}

export type SettleInput = {
  checkId: string;
  paymentMethod: "MEMBER_ACCOUNT" | "QR_PAY";
  chitDiscountPct?: number;
  notes?: string | null;
  allowUnsentLines?: boolean;
};
export type SettleSuccess = {
  saleId: string;
  saleNumber: string;
  grandTotal: number;
  chargeMode: "MEMBER_ACCOUNT" | "QR_PAY";
};
export async function settleCheckAction(input: SettleInput): Promise<Result<SettleSuccess>> {
  const p = await getCurrentPrincipal();
  if (!p) return unauthorized();
  try {
    // Resolve the calling request's origin so the snapshot chit
    // bakes the right host into the QR Pay URL. Forwarded headers
    // (x-forwarded-*) cover the proxy case; falls back to `host`.
    const { headers } = await import("next/headers");
    const h = headers();
    const proto = h.get("x-forwarded-proto") ?? "http";
    const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
    const origin = `${proto}://${host}`;

    const { sale } = await settleCheck(p, input.checkId, {
      paymentMethod: input.paymentMethod,
      chitDiscountPct: input.chitDiscountPct,
      notes: input.notes,
      allowUnsentLines: input.allowUnsentLines,
      origin,
    });
    revalidatePath("/app/admin/ops/pos/lounge");
    revalidatePath("/app/admin/ops/pos/lounge/history");
    return {
      ok: true,
      data: {
        saleId: sale.id,
        saleNumber: sale.saleNumber,
        grandTotal: Number(sale.grandTotal.toString()),
        chargeMode: (sale.chargeMode === "QR_PAY" ? "QR_PAY" : "MEMBER_ACCOUNT") as "MEMBER_ACCOUNT" | "QR_PAY",
      },
    };
  } catch (err) {
    return fail(err, "Could not settle check");
  }
}

export async function setAutoPaceAction(checkId: string, gapMinutes: number | null): Promise<Result<{ ok: true }>> {
  const p = await getCurrentPrincipal();
  if (!p) return unauthorized();
  try {
    await setAutoPace(p, checkId, gapMinutes);
    return { ok: true, data: { ok: true } };
  } catch (err) {
    return fail(err, "Could not change auto-pace");
  }
}

export async function fireNextCourseAction(checkId: string): Promise<Result<{ fired: number; course: number | null }>> {
  const p = await getCurrentPrincipal();
  if (!p) return unauthorized();
  try {
    const r = await fireNextCourse(p, checkId);
    revalidatePath("/app/admin/ops/pos/lounge/kitchen");
    revalidatePath("/app/admin/ops/pos/lounge/bar");
    return { ok: true, data: r };
  } catch (err) {
    return fail(err, "Could not fire next course");
  }
}

// Modifier catalog for the menu item driving a given check line.
// Returns the active groups + their active options. Used by the
// modifier panel that opens from the "Modify" button on a cart row.
export async function listLineModifiersAction(
  menuItemId: string
): Promise<Result<Awaited<ReturnType<typeof listModifiersForItem>>>> {
  const p = await getCurrentPrincipal();
  if (!p) return unauthorized();
  try {
    const data = await listModifiersForItem(p, menuItemId);
    return { ok: true, data };
  } catch (err) {
    return fail(err, "Could not load modifier options");
  }
}

// Replace the modifier set on a draft check line. The UI passes
// the full desired set; the server transactionally swaps it.
export async function setLineModifiersAction(
  checkLineId: string,
  modifiers: ModifierInput[]
): Promise<Result<{ ok: true }>> {
  const p = await getCurrentPrincipal();
  if (!p) return unauthorized();
  try {
    await setLineModifiers(p, checkLineId, { modifiers });
    return { ok: true, data: { ok: true } };
  } catch (err) {
    return fail(err, "Could not save modifiers");
  }
}

// Mark a single READY line as SERVED. Used by the server's check
// detail view to confirm delivery to the table.
export async function markLineServedAction(checkLineId: string): Promise<Result<{ ok: true }>> {
  const p = await getCurrentPrincipal();
  if (!p) return unauthorized();
  try {
    await markCheckLineServed(p, checkLineId);
    revalidatePath("/app/admin/ops/pos/lounge");
    return { ok: true, data: { ok: true } };
  } catch (err) {
    return fail(err, "Could not mark item served");
  }
}

// Mark every line on a chit as SERVED in one tap — used by the
// kitchen / bar / expo station view.
export async function markChitServedAction(chitId: string): Promise<Result<{ ok: true }>> {
  const p = await getCurrentPrincipal();
  if (!p) return unauthorized();
  try {
    await markChitServed(p, chitId);
    revalidatePath("/app/admin/ops/pos/lounge/kitchen");
    revalidatePath("/app/admin/ops/pos/lounge/bar");
    revalidatePath("/app/admin/ops/pos/lounge");
    return { ok: true, data: { ok: true } };
  } catch (err) {
    return fail(err, "Could not mark chit served");
  }
}

// QR payment lifecycle — called from the public landing page (dev
// simulators) or, in production, from a gateway webhook. Resolves
// origin from headers so the snapshot chit's QR resolves correctly.
async function resolveOrigin(): Promise<string> {
  const { headers } = await import("next/headers");
  const h = headers();
  const proto = h.get("x-forwarded-proto") ?? "http";
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  return `${proto}://${host}`;
}

export async function confirmQRPaymentAction(saleId: string): Promise<Result<{ ok: true }>> {
  const p = await getCurrentPrincipal();
  if (!p) return unauthorized();
  try {
    const origin = await resolveOrigin();
    await confirmQRPayment(p, saleId, { origin });
    revalidatePath("/app/admin/ops/pos/lounge");
    revalidatePath(`/pos/pay/${saleId}`);
    return { ok: true, data: { ok: true } };
  } catch (err) {
    return fail(err, "Could not confirm payment");
  }
}

export async function declineQRPaymentAction(saleId: string, reason: string): Promise<Result<{ ok: true }>> {
  const p = await getCurrentPrincipal();
  if (!p) return unauthorized();
  try {
    await declineQRPayment(p, saleId, reason);
    revalidatePath("/app/admin/ops/pos/lounge");
    revalidatePath(`/pos/pay/${saleId}`);
    return { ok: true, data: { ok: true } };
  } catch (err) {
    return fail(err, "Could not decline payment");
  }
}

export async function expireQRPaymentAction(saleId: string): Promise<Result<{ ok: true }>> {
  const p = await getCurrentPrincipal();
  if (!p) return unauthorized();
  try {
    await expireQRPayment(p, saleId);
    revalidatePath("/app/admin/ops/pos/lounge");
    revalidatePath(`/pos/pay/${saleId}`);
    return { ok: true, data: { ok: true } };
  } catch (err) {
    return fail(err, "Could not expire payment");
  }
}

// Poll endpoint for the lounge POS PAYMENT_PENDING state — returns
// the latest payment status so the operator's UI can transition to
// success / failed without manual refresh.
export async function getQRPaymentStatusAction(saleId: string): Promise<Result<{
  saleId: string;
  saleStatus: string;
  paymentStatus: string | null;
  failureReason: string | null;
}>> {
  const p = await getCurrentPrincipal();
  if (!p) return unauthorized();
  try {
    const sale = await (await import("@/lib/prisma")).prisma.pOSSale.findUnique({
      where: { id: saleId },
      select: { id: true, clubId: true, status: true, payments: { take: 1 } },
    });
    if (!sale) return { ok: false, error: "Sale not found" };
    // Tenant guard
    if (!p.memberships.some((m) => m.clubId === sale.clubId || m.clubId === null)) {
      return { ok: false, error: "Forbidden" };
    }
    const pay = sale.payments[0];
    return {
      ok: true,
      data: {
        saleId: sale.id,
        saleStatus: sale.status,
        paymentStatus: pay?.externalPaymentStatus ?? null,
        failureReason: pay?.failureReason ?? null,
      },
    };
  } catch (err) {
    return fail(err, "Could not check payment status");
  }
}

// Closed-check history list for the lounge POS history page.
export async function listClosedChecksAction(filters: {
  from?: string;
  to?: string;
  settlementMethod?: "MEMBER_ACCOUNT" | "QR_PAY";
  search?: string;
}): Promise<Result<Awaited<ReturnType<typeof listClosedChecks>>>> {
  const p = await getCurrentPrincipal();
  if (!p) return unauthorized();
  try {
    const clubId = await getActiveClubId({ clubId: p.activeClubId ?? null, role: "" });
    const data = await listClosedChecks(p, clubId, {
      from: filters.from ? new Date(filters.from) : undefined,
      to: filters.to ? new Date(filters.to) : undefined,
      settlementMethod: filters.settlementMethod,
      search: filters.search,
    });
    return { ok: true, data };
  } catch (err) {
    return fail(err, "Could not load closed checks");
  }
}

// Resend the receipt email for an already-settled check. Routes
// through the same sendAndRecordReceiptEmail used at settlement so the
// success/dev-logged/failed status, EmailDeliveryEvent audit row, and
// POSCheck.receiptEmailStatus all stay consistent.
export async function resendReceiptEmailAction(checkId: string): Promise<Result<{
  status: string;
  address: string | null;
  failureReason: string | null;
}>> {
  const p = await getCurrentPrincipal();
  if (!p) return unauthorized();
  try {
    const check = await prisma.pOSCheck.findUnique({ where: { id: checkId } });
    if (!check) return { ok: false, error: "Check not found" };
    assertTenantOwned(check, p);
    requirePermission(p, check.clubId, "inventory:write");
    if (!check.posSaleId) return { ok: false, error: "Check has no settled sale to resend" };

    const { headers } = await import("next/headers");
    const h = headers();
    const proto = h.get("x-forwarded-proto") ?? "http";
    const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
    const origin = `${proto}://${host}`;

    const result = await sendAndRecordReceiptEmail({
      checkId: check.id,
      saleId: check.posSaleId,
      origin,
    });
    await audit(p, {
      action: "pos.check.receipt.resend",
      entityType: "POSCheck",
      entityId: check.id,
      clubId: check.clubId,
      after: { status: result.status, address: result.toAddress },
    });
    revalidatePath("/app/admin/ops/pos/lounge/history");
    return {
      ok: true,
      data: {
        status: result.status,
        address: result.toAddress,
        failureReason: result.failureReason ?? null,
      },
    };
  } catch (err) {
    return fail(err, "Could not resend receipt email");
  }
}

// Resend the receipt email for a single POSSettlementGroup (the
// split-bill case — each group has its own POSSale and its own paying
// member). Routes through the same `sendAndRecordGroupReceiptEmail`
// helper that fires the initial send at settle time, so:
//   - the email body comes from POSSale.lines (only that group's items),
//   - EmailDeliveryEvent gets a new row per attempt,
//   - POSSettlementGroup.receiptEmail* updates honestly (SENT /
//     DEV_LOGGED / FAILED / SUPPRESSED / SKIPPED_NO_EMAIL),
//   - the other groups on the check are untouched.
//
// Gates here are about whether resending makes sense; the underlying
// helper handles per-recipient outcomes (no email → SKIPPED_NO_EMAIL,
// suppressed → SUPPRESSED) without throwing.
export async function resendGroupReceiptEmailAction(groupId: string): Promise<Result<{
  status: string;
  address: string | null;
  failureReason: string | null;
}>> {
  const p = await getCurrentPrincipal();
  if (!p) return unauthorized();
  try {
    const group = await prisma.pOSSettlementGroup.findUnique({
      where: { id: groupId },
      include: {
        posCheck: { select: { id: true, clubId: true, status: true } },
      },
    });
    if (!group) return { ok: false, error: "Settlement group not found" };
    assertTenantOwned(group, p);
    requirePermission(p, group.clubId, "inventory:write");
    if (!group.posSaleId) {
      return { ok: false, error: "Group has no settled sale to resend" };
    }
    if (group.settlementMethod !== "MEMBER_ACCOUNT") {
      return { ok: false, error: "Resend is only supported for member-account groups" };
    }
    if (!group.memberId) {
      return { ok: false, error: "Group has no paying member" };
    }
    if (group.posCheck.status === "VOIDED") {
      return { ok: false, error: "Cannot resend a voided check's receipt" };
    }

    const { headers } = await import("next/headers");
    const h = headers();
    const proto = h.get("x-forwarded-proto") ?? "http";
    const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
    const origin = `${proto}://${host}`;

    const result = await sendAndRecordGroupReceiptEmail({
      groupId: group.id,
      saleId: group.posSaleId,
      origin,
    });
    await audit(p, {
      action: "pos.settlement-group.receipt.resend",
      entityType: "POSSettlementGroup",
      entityId: group.id,
      clubId: group.clubId,
      after: {
        status: result.status,
        address: result.toAddress,
        posCheckId: group.posCheckId,
        posSaleId: group.posSaleId,
      },
    });
    revalidatePath("/app/admin/ops/pos/lounge/history");
    return {
      ok: true,
      data: {
        status: result.status,
        address: result.toAddress,
        failureReason: result.failureReason ?? null,
      },
    };
  } catch (err) {
    return fail(err, "Could not resend group receipt email");
  }
}

export async function voidCheckAction(checkId: string, reason: string): Promise<Result<{ ok: true }>> {
  const p = await getCurrentPrincipal();
  if (!p) return unauthorized();
  try {
    await voidCheck(p, checkId, reason);
    revalidatePath("/app/admin/ops/pos/lounge");
    return { ok: true, data: { ok: true } };
  } catch (err) {
    return fail(err, "Could not void check");
  }
}

// ---------- Prep-station actions ----------

export async function acknowledgeChitAction(chitId: string): Promise<Result<{ ok: true }>> {
  const p = await getCurrentPrincipal();
  if (!p) return unauthorized();
  try {
    await acknowledgeChit(p, chitId);
    revalidatePath("/app/admin/ops/pos/lounge/kitchen");
    revalidatePath("/app/admin/ops/pos/lounge/bar");
    return { ok: true, data: { ok: true } };
  } catch (err) {
    return fail(err, "Could not acknowledge chit");
  }
}

export async function markChitReadyAction(chitId: string): Promise<Result<{ ok: true }>> {
  const p = await getCurrentPrincipal();
  if (!p) return unauthorized();
  try {
    await markChitReady(p, chitId);
    revalidatePath("/app/admin/ops/pos/lounge/kitchen");
    revalidatePath("/app/admin/ops/pos/lounge/bar");
    return { ok: true, data: { ok: true } };
  } catch (err) {
    return fail(err, "Could not mark chit ready");
  }
}
