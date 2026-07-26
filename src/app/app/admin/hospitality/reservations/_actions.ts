"use server";

// Reservation host/admin server actions. Thin try/catch wrappers
// around the service layer that translate AppErrors into the
// { ok, data | error } shape the client UIs consume.

import { revalidatePath } from "next/cache";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { isAppError } from "@/lib/errors";
import {
  createMemberReservation,
  createWalkIn,
  confirmReservation,
  seatReservation,
  departReservation,
  markNoShow,
  cancelReservation,
  assignTable,
  ensureCheckForReservation,
  updateReservationSettings,
  setTableStatus,
  releaseTable,
  type ReservationCreateInput,
  type ManualTableStatus,
} from "@/lib/hospitality/reservations";

type Ok<T> = { ok: true; data: T };
type Err = { ok: false; error: string };
type Result<T> = Ok<T> | Err;
function fail(err: unknown, fallback: string): Err {
  return { ok: false, error: isAppError(err) ? err.safeMessage : fallback };
}
function unauthorized(): Err { return { ok: false, error: "Not signed in" }; }

function reval() {
  revalidatePath("/app/admin/hospitality/reservations");
  revalidatePath("/app/admin/hospitality/reservations/floor");
}

async function activeClub() {
  const p = await getCurrentPrincipal();
  if (!p) return null;
  const clubId = await getActiveClubId({ clubId: p.activeClubId ?? null, role: "" });
  return { p, clubId };
}

export async function createReservationAction(raw: ReservationCreateInput): Promise<Result<{ id: string }>> {
  const ctx = await activeClub(); if (!ctx) return unauthorized();
  try {
    const r = await createMemberReservation(ctx.p, ctx.clubId, raw);
    reval();
    return { ok: true, data: { id: r!.id } };
  } catch (err) { return fail(err, "Could not create reservation"); }
}

export async function createWalkInAction(raw: ReservationCreateInput): Promise<Result<{ id: string }>> {
  const ctx = await activeClub(); if (!ctx) return unauthorized();
  try {
    const r = await createWalkIn(ctx.p, ctx.clubId, raw);
    reval();
    return { ok: true, data: { id: r!.id } };
  } catch (err) { return fail(err, "Could not record walk-in"); }
}

export async function confirmReservationAction(id: string): Promise<Result<{ ok: true }>> {
  const ctx = await activeClub(); if (!ctx) return unauthorized();
  try { await confirmReservation(ctx.p, id); reval(); return { ok: true, data: { ok: true } }; }
  catch (err) { return fail(err, "Could not confirm"); }
}

export async function seatReservationAction(id: string, tableId: string | null): Promise<Result<{ ok: true }>> {
  const ctx = await activeClub(); if (!ctx) return unauthorized();
  try { await seatReservation(ctx.p, id, tableId); reval(); return { ok: true, data: { ok: true } }; }
  catch (err) { return fail(err, "Could not seat reservation"); }
}

export async function departReservationAction(id: string): Promise<Result<{ ok: true }>> {
  const ctx = await activeClub(); if (!ctx) return unauthorized();
  try { await departReservation(ctx.p, id); reval(); return { ok: true, data: { ok: true } }; }
  catch (err) { return fail(err, "Could not mark departed"); }
}

export async function noShowReservationAction(id: string, reason: string): Promise<Result<{ feeChargeId: string | null }>> {
  const ctx = await activeClub(); if (!ctx) return unauthorized();
  try {
    const { feeChargeId } = await markNoShow(ctx.p, id, { reason });
    reval();
    return { ok: true, data: { feeChargeId } };
  } catch (err) { return fail(err, "Could not mark no-show"); }
}

export async function cancelReservationAction(id: string, reason: string): Promise<Result<{ ok: true }>> {
  const ctx = await activeClub(); if (!ctx) return unauthorized();
  try { await cancelReservation(ctx.p, id, reason); reval(); return { ok: true, data: { ok: true } }; }
  catch (err) { return fail(err, "Could not cancel"); }
}

export async function assignTableAction(id: string, tableId: string | null): Promise<Result<{ ok: true }>> {
  const ctx = await activeClub(); if (!ctx) return unauthorized();
  try { await assignTable(ctx.p, id, tableId); reval(); return { ok: true, data: { ok: true } }; }
  catch (err) { return fail(err, "Could not assign table"); }
}

export async function openCheckAction(id: string): Promise<Result<{ checkId: string }>> {
  const ctx = await activeClub(); if (!ctx) return unauthorized();
  try {
    const r = await ensureCheckForReservation(ctx.p, id);
    reval();
    revalidatePath("/app/admin/ops/pos/lounge");
    return { ok: true, data: { checkId: r.checkId } };
  } catch (err) { return fail(err, "Could not open POS check"); }
}

export async function setTableStatusAction(tableId: string, status: ManualTableStatus): Promise<Result<{ ok: true }>> {
  const ctx = await activeClub(); if (!ctx) return unauthorized();
  try { await setTableStatus(ctx.p, tableId, status); reval(); return { ok: true, data: { ok: true } }; }
  catch (err) { return fail(err, "Could not update table status"); }
}

// Step 18 — Mark departed for POS/self-seated tables (no reservation
// backing them). Refuses while an unsettled check is open. Reservation-
// backed depart still routes through `departReservationAction` above.
export async function releaseTableAction(tableId: string): Promise<Result<{ ok: true }>> {
  const ctx = await activeClub(); if (!ctx) return unauthorized();
  try { await releaseTable(ctx.p, tableId); reval(); return { ok: true, data: { ok: true } }; }
  catch (err) { return fail(err, "Could not mark table departed"); }
}

export async function updateSettingsAction(raw: Parameters<typeof updateReservationSettings>[2]): Promise<Result<{ ok: true }>> {
  const ctx = await activeClub(); if (!ctx) return unauthorized();
  try { await updateReservationSettings(ctx.p, ctx.clubId, raw); revalidatePath("/app/admin/hospitality/reservations"); return { ok: true, data: { ok: true } }; }
  catch (err) { return fail(err, "Could not update settings"); }
}
