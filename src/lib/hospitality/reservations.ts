// Lounge dining reservations — service layer.
//
// Hospitality, not OpenTable. Every state change is tenant-checked,
// permission-gated, and audited. A no-show on a member reservation
// runs through the existing AR posting pipeline (postCharge) so the
// fee appears on the member's account exactly like any other charge.
//
// Confirmation email uses the same email-adapter resolution as POS
// receipts — console / SMTP / SES / Microsoft 365 — so a club
// connected to its own Microsoft 365 tenant sends from its own
// mailbox without any reservation-specific configuration.

import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../prisma";
import { audit } from "../audit";
import { hasPermission, requirePermission, type Principal } from "../rbac";
import { assertTenantOwned, tenantWhere } from "../services/tenant";
import { ConflictError, NotFoundError, ValidationError, ForbiddenError } from "../errors";
import { postCharge } from "../services/ar";
import { selectEmailAdapter, getEmailDeliveryDescriptor } from "../integrations/email";
import { formatCurrency, formatDate } from "../finance";

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
// Settings row is created on first read so admin UIs don't have to
// handle a null state.
export async function getReservationSettings(clubId: string) {
  let s = await prisma.reservationSettings.findUnique({ where: { clubId } });
  if (!s) {
    s = await prisma.reservationSettings.create({ data: { clubId } });
  }
  return s;
}

const settingsSchema = z.object({
  reservationIntervalMinutes: z.number().int().min(5).max(120).optional(),
  defaultReservationDurationMinutes: z.number().int().min(15).max(360).optional(),
  noShowFeeAmount: z.number().nonnegative().max(500).optional(),
  noShowFeeEnabled: z.boolean().optional(),
  confirmationEmailEnabled: z.boolean().optional(),
  autoConfirmMemberReservations: z.boolean().optional(),
  dressCodeText: z.string().trim().min(1).max(2000).optional(),
  noShowPolicyText: z.string().trim().min(1).max(2000).optional(),
  contactPhone: z.string().trim().max(40).optional().or(z.literal("")),
  contactEmail: z.string().trim().email().max(254).optional().or(z.literal("")),
  maxPartySizeOnline: z.number().int().min(1).max(40).optional(),
  advanceBookingDays: z.number().int().min(1).max(365).optional(),
  cancellationCutoffHours: z.number().int().min(0).max(168).optional(),
});

export async function updateReservationSettings(
  principal: Principal,
  clubId: string,
  raw: unknown,
) {
  requirePermission(principal, clubId, "reservations:settings");
  const parsed = settingsSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  }
  const data: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(parsed.data)) {
    if (v === "" || v === undefined) continue;
    data[k] = v;
  }
  await getReservationSettings(clubId); // ensure row exists
  const updated = await prisma.reservationSettings.update({
    where: { clubId },
    data,
  });
  await audit(principal, {
    action: "reservation.settings.update",
    entityType: "ReservationSettings",
    entityId: updated.id,
    clubId,
    after: data,
  });
  return updated;
}

// ---------------------------------------------------------------------------
// Areas + tables
// ---------------------------------------------------------------------------
export async function listDiningAreas(principal: Principal, clubId: string) {
  requirePermission(principal, clubId, "reservations:read");
  return prisma.diningArea.findMany({
    where: { ...tenantWhere(principal, clubId), active: true },
    include: { tables: { where: { active: true }, orderBy: { tableNumber: "asc" } } },
    orderBy: { sortOrder: "asc" },
  });
}

// ---------------------------------------------------------------------------
// Reservation creation
// ---------------------------------------------------------------------------
const reservationCreateSchema = z.object({
  memberId: z.string().optional().nullable(),
  reservationType: z.enum(["MEMBER", "WALK_IN", "GUEST"]).default("MEMBER"),
  guestName: z.string().trim().max(120).optional().or(z.literal("")),
  guestEmail: z.string().email().max(254).optional().or(z.literal("")),
  guestPhone: z.string().trim().max(40).optional().or(z.literal("")),
  // ISO-string date OR datetime. We always anchor to local club time.
  startTime: z.string().min(8),
  durationMinutes: z.number().int().min(15).max(360).optional(),
  partySize: z.number().int().min(1).max(40),
  diningAreaId: z.string().min(1),
  tableId: z.string().optional().nullable(),
  specialRequests: z.string().trim().max(2000).optional().or(z.literal("")),
  occasion: z.string().trim().max(120).optional().or(z.literal("")),
  dressCodeAcknowledged: z.boolean().optional(),
  noShowFeeAcknowledged: z.boolean().optional(),
});
export type ReservationCreateInput = z.infer<typeof reservationCreateSchema>;

async function buildBaseReservationData(opts: {
  clubId: string;
  raw: unknown;
  defaultDurationMin: number;
}): Promise<{
  data: Prisma.DiningReservationUncheckedCreateInput;
  startsAt: Date;
}> {
  const parsed = reservationCreateSchema.safeParse(opts.raw);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  }
  const d = parsed.data;
  const startsAt = new Date(d.startTime);
  if (Number.isNaN(startsAt.getTime())) {
    throw new ValidationError([{ path: "startTime", message: "Invalid date/time" }]);
  }
  const duration = d.durationMinutes ?? opts.defaultDurationMin;
  const expectedEnd = new Date(startsAt.getTime() + duration * 60_000);

  // Sanity-check the area belongs to the club.
  const area = await prisma.diningArea.findUnique({ where: { id: d.diningAreaId } });
  if (!area || area.clubId !== opts.clubId) {
    throw new ValidationError([{ path: "diningAreaId", message: "Unknown dining area" }]);
  }
  if (d.tableId) {
    const table = await prisma.diningTable.findUnique({ where: { id: d.tableId } });
    if (!table || table.clubId !== opts.clubId || table.diningAreaId !== area.id) {
      throw new ValidationError([{ path: "tableId", message: "Table is not in this area" }]);
    }
  }
  if (d.memberId) {
    const member = await prisma.member.findUnique({ where: { id: d.memberId } });
    if (!member || member.clubId !== opts.clubId) {
      throw new ValidationError([{ path: "memberId", message: "Unknown member" }]);
    }
  }

  return {
    startsAt,
    data: {
      clubId: opts.clubId,
      memberId: d.memberId || null,
      guestName: d.guestName || null,
      guestEmail: d.guestEmail || null,
      guestPhone: d.guestPhone || null,
      reservationType: d.reservationType,
      reservationDate: new Date(Date.UTC(startsAt.getUTCFullYear(), startsAt.getUTCMonth(), startsAt.getUTCDate())),
      startTime: startsAt,
      expectedEndTime: expectedEnd,
      partySize: d.partySize,
      diningAreaId: d.diningAreaId,
      tableId: d.tableId || null,
      specialRequests: d.specialRequests || null,
      occasion: d.occasion || null,
      dressCodeAcknowledged: !!d.dressCodeAcknowledged,
      noShowFeeAcknowledged: !!d.noShowFeeAcknowledged,
      status: "CONFIRMED",
    },
  };
}

// Member-self booking. Caller must be the member, OR an admin with
// reservations:manage acting on their behalf. The acknowledgements are
// required so the member can't disclaim the no-show policy later.
export async function createMemberReservation(
  principal: Principal,
  clubId: string,
  raw: unknown,
) {
  // A member may book for themselves; a host may book for any member.
  if (!hasPermission(principal, clubId, "reservations:manage")) {
    requirePermission(principal, clubId, "reservations:self");
  }
  const settings = await getReservationSettings(clubId);
  const { data, startsAt } = await buildBaseReservationData({
    clubId, raw, defaultDurationMin: settings.defaultReservationDurationMinutes,
  });

  // Members booking through the portal must own their reservation.
  if (!hasPermission(principal, clubId, "reservations:manage")) {
    if (!principal.memberId || data.memberId !== principal.memberId) {
      throw new ForbiddenError("A member can only book a reservation for themselves.");
    }
    if (!data.dressCodeAcknowledged || !data.noShowFeeAcknowledged) {
      throw new ValidationError([
        { path: "dressCodeAcknowledged", message: "Please acknowledge the dress code and no-show policy before booking." },
      ]);
    }
    // Cap online party size; admins are not bound by this.
    if (data.partySize > settings.maxPartySizeOnline) {
      throw new ValidationError([
        { path: "partySize", message: `Online bookings are limited to ${settings.maxPartySizeOnline} guests. Please call the club for larger parties.` },
      ]);
    }
    // Advance-booking horizon.
    const maxFuture = Date.now() + settings.advanceBookingDays * 24 * 60 * 60 * 1000;
    if (startsAt.getTime() > maxFuture) {
      throw new ValidationError([
        { path: "startTime", message: `Reservations can be made up to ${settings.advanceBookingDays} days in advance.` },
      ]);
    }
    if (startsAt.getTime() < Date.now() - 60_000) {
      throw new ValidationError([{ path: "startTime", message: "Start time is in the past." }]);
    }
  }

  data.status = settings.autoConfirmMemberReservations ? "CONFIRMED" : "REQUESTED";
  data.createdById = principal.id;
  const created = await prisma.diningReservation.create({ data });
  await audit(principal, {
    action: "reservation.create",
    entityType: "DiningReservation",
    entityId: created.id,
    clubId,
    after: { status: created.status, startTime: created.startTime, partySize: created.partySize, memberId: created.memberId, type: created.reservationType },
  });

  if (created.status === "CONFIRMED" && settings.confirmationEmailEnabled) {
    await sendConfirmationEmail(created.id);
  }
  return prisma.diningReservation.findUnique({
    where: { id: created.id },
    include: defaultInclude(),
  });
}

// Host-created walk-in. Immediately SEATED; no confirmation email
// (the guest is already at the table). Same data model so the same
// analytics queries cover walk-ins and reservations.
export async function createWalkIn(
  principal: Principal,
  clubId: string,
  raw: unknown,
) {
  requirePermission(principal, clubId, "reservations:manage");
  const settings = await getReservationSettings(clubId);
  const { data } = await buildBaseReservationData({
    clubId, raw, defaultDurationMin: settings.defaultReservationDurationMinutes,
  });
  data.reservationType = "WALK_IN";
  data.status = "SEATED";
  data.actualSeatedAt = new Date();
  data.createdById = principal.id;
  // dressCode/noShow acknowledgements not required for walk-ins.
  data.dressCodeAcknowledged = true;
  data.noShowFeeAcknowledged = true;
  const created = await prisma.diningReservation.create({ data });
  if (created.tableId) {
    await prisma.diningTable.update({
      where: { id: created.tableId },
      data: { status: "SEATED" },
    });
  }
  await audit(principal, {
    action: "reservation.walkin.create",
    entityType: "DiningReservation",
    entityId: created.id,
    clubId,
    after: { tableId: created.tableId, partySize: created.partySize, memberId: created.memberId },
  });
  return prisma.diningReservation.findUnique({
    where: { id: created.id },
    include: defaultInclude(),
  });
}

// ---------------------------------------------------------------------------
// Lifecycle transitions
// ---------------------------------------------------------------------------

async function loadOwnedReservation(principal: Principal, id: string) {
  const r = await prisma.diningReservation.findUnique({ where: { id } });
  assertTenantOwned(r, principal);
  return r;
}

export async function confirmReservation(principal: Principal, id: string) {
  const r = await loadOwnedReservation(principal, id);
  requirePermission(principal, r.clubId, "reservations:manage");
  if (r.status !== "REQUESTED") throw new ConflictError(`Cannot confirm a ${r.status.toLowerCase()} reservation.`);
  const updated = await prisma.diningReservation.update({
    where: { id }, data: { status: "CONFIRMED" },
  });
  await audit(principal, { action: "reservation.confirm", entityType: "DiningReservation", entityId: id, clubId: r.clubId });
  const settings = await getReservationSettings(r.clubId);
  if (settings.confirmationEmailEnabled) await sendConfirmationEmail(id);
  return updated;
}

export async function assignTable(principal: Principal, id: string, tableId: string | null) {
  const r = await loadOwnedReservation(principal, id);
  requirePermission(principal, r.clubId, "reservations:manage");
  if (tableId) {
    const t = await prisma.diningTable.findUnique({ where: { id: tableId } });
    if (!t || t.clubId !== r.clubId) {
      throw new ValidationError([{ path: "tableId", message: "Unknown table." }]);
    }
  }
  const updated = await prisma.diningReservation.update({
    where: { id }, data: { tableId },
  });
  await audit(principal, {
    action: "reservation.assign-table",
    entityType: "DiningReservation",
    entityId: id, clubId: r.clubId,
    before: { tableId: r.tableId }, after: { tableId },
  });
  return updated;
}

export async function seatReservation(principal: Principal, id: string, tableId?: string | null) {
  const r = await loadOwnedReservation(principal, id);
  requirePermission(principal, r.clubId, "reservations:manage");
  if (r.status !== "CONFIRMED" && r.status !== "REQUESTED") {
    throw new ConflictError(`Cannot seat a ${r.status.toLowerCase()} reservation.`);
  }
  const finalTableId = tableId ?? r.tableId;
  if (!finalTableId) {
    throw new ValidationError([{ path: "tableId", message: "Assign a table before seating." }]);
  }
  const now = new Date();
  const updated = await prisma.diningReservation.update({
    where: { id },
    data: { status: "SEATED", actualSeatedAt: now, tableId: finalTableId },
  });
  await prisma.diningTable.update({
    where: { id: finalTableId },
    data: { status: "SEATED" },
  });
  await audit(principal, {
    action: "reservation.seat",
    entityType: "DiningReservation",
    entityId: id, clubId: r.clubId,
    after: { tableId: finalTableId, actualSeatedAt: now },
  });
  return updated;
}

export async function departReservation(principal: Principal, id: string) {
  const r = await loadOwnedReservation(principal, id);
  requirePermission(principal, r.clubId, "reservations:manage");
  if (r.status !== "SEATED") throw new ConflictError("Reservation is not currently seated.");
  // Step 18 — never mark departed while an unsettled check is open
  // on the same table. Closing the check first guarantees the seat
  // view + accounting agree on what was sold.
  if (r.tableId) {
    const openCheck = await prisma.pOSCheck.findFirst({
      where: { tableId: r.tableId, clubId: r.clubId, status: { notIn: ["CLOSED", "VOIDED"] } },
      select: { id: true },
    });
    if (openCheck) {
      throw new ConflictError("Settle the open check before marking departed.");
    }
  }
  const now = new Date();
  const updated = await prisma.diningReservation.update({
    where: { id },
    data: { status: "COMPLETED", actualDepartedAt: now },
  });
  if (r.tableId) {
    // Table goes to DIRTY so a host knows to bus before the next party.
    await prisma.diningTable.update({
      where: { id: r.tableId }, data: { status: "DIRTY" },
    });
  }
  await audit(principal, {
    action: "reservation.depart",
    entityType: "DiningReservation",
    entityId: id, clubId: r.clubId,
    after: { actualDepartedAt: now, durationMinutes: r.actualSeatedAt ? Math.round((now.getTime() - r.actualSeatedAt.getTime()) / 60_000) : null },
  });
  return updated;
}

export async function cancelReservation(
  principal: Principal,
  id: string,
  reason?: string,
) {
  const r = await loadOwnedReservation(principal, id);
  // Member self-cancel is allowed; admins use reservations:manage.
  if (!hasPermission(principal, r.clubId, "reservations:manage")) {
    if (!principal.memberId || r.memberId !== principal.memberId) {
      throw new ForbiddenError("Not permitted to cancel this reservation.");
    }
    if (r.status === "SEATED" || r.status === "COMPLETED" || r.status === "NO_SHOW") {
      throw new ConflictError(`Cannot cancel a reservation that is ${r.status.toLowerCase()}.`);
    }
    const settings = await getReservationSettings(r.clubId);
    const cutoff = r.startTime.getTime() - settings.cancellationCutoffHours * 60 * 60 * 1000;
    if (Date.now() > cutoff && settings.cancellationCutoffHours > 0) {
      throw new ConflictError(`Cancellations close ${settings.cancellationCutoffHours} hour(s) before the reservation. Please call the club to make a change.`);
    }
  }
  if (r.status === "CANCELLED") return r;
  const updated = await prisma.diningReservation.update({
    where: { id },
    data: {
      status: "CANCELLED",
      cancelledAt: new Date(),
      cancelledByUserId: principal.id,
      cancellationReason: reason?.trim().slice(0, 500) || null,
    },
  });
  await audit(principal, {
    action: "reservation.cancel",
    entityType: "DiningReservation",
    entityId: id, clubId: r.clubId,
    before: { status: r.status }, after: { status: "CANCELLED", reason: reason ?? null },
  });
  return updated;
}

// No-show + fee charging. The fee is posted through the existing
// AR pipeline (postCharge) so it goes through tenancy, audit, GL.
// If the reservation belongs to a guest (no memberId) we still mark
// no-show — there's just no account to bill.
export async function markNoShow(
  principal: Principal,
  id: string,
  opts: { reason?: string },
) {
  const r = await loadOwnedReservation(principal, id);
  requirePermission(principal, r.clubId, "reservations:manage");
  if (r.status === "NO_SHOW") return { reservation: r, feeChargeId: r.noShowFeeChargeId };
  if (r.status === "COMPLETED" || r.status === "SEATED") {
    throw new ConflictError(`Cannot mark a ${r.status.toLowerCase()} reservation as no-show.`);
  }
  const settings = await getReservationSettings(r.clubId);
  const now = new Date();
  const updated = await prisma.diningReservation.update({
    where: { id },
    data: {
      status: "NO_SHOW",
      noShowMarkedAt: now,
      noShowMarkedByUserId: principal.id,
      noShowReason: opts.reason?.trim().slice(0, 500) || null,
    },
  });
  await audit(principal, {
    action: "reservation.no-show",
    entityType: "DiningReservation",
    entityId: id, clubId: r.clubId,
    after: { reason: opts.reason ?? null, partySize: r.partySize },
  });

  let feeChargeId: string | null = null;
  const feeAmount = Number(settings.noShowFeeAmount.toString());
  // Charge only when: fee enabled AND there's an actual member to bill.
  if (settings.noShowFeeEnabled && feeAmount > 0 && r.memberId) {
    try {
      const charge = await postCharge(principal, r.memberId, {
        category: "OTHER",
        amount: feeAmount,
        description: `Lounge no-show fee — ${formatDate(r.startTime)} · party of ${r.partySize}`,
      });
      feeChargeId = charge.id;
      await prisma.diningReservation.update({
        where: { id },
        data: { noShowFeeChargeId: charge.id, noShowFeeChargedAt: new Date() },
      });
    } catch (err) {
      // Charge failure must not roll back the NO_SHOW status — the
      // floor manager has acted and the audit trail is intact.
      await audit(principal, {
        action: "reservation.no-show.fee-failed",
        entityType: "DiningReservation",
        entityId: id, clubId: r.clubId,
        after: { error: err instanceof Error ? err.message : String(err) },
      });
    }
  }
  return { reservation: updated, feeChargeId };
}

// ---------------------------------------------------------------------------
// Reservation lifecycle helper — is this reservation still "active"?
//
// "Active" = the floor host has unfinished business with it. SEATED is
// always active (someone is at the table; the host needs to mark them
// departed). CONFIRMED / REQUESTED count as active while the
// reservation window (start..expectedEnd) is open OR within a grace
// period after — beyond that, the reservation is STALE and the admin
// should mark it no-show, complete it, or cancel it.
//
// Stale reservations are surfaced on the admin Reservations page and
// the POS reconcile tool no longer treats them as a "the table is
// still in use" signal.
//
// Default grace = 120 minutes after expectedEndTime. Hardcoded for now
// (ReservationSettings doesn't carry a no-show-grace field yet); if a
// club wants tighter, we'll add a setting later.
// ---------------------------------------------------------------------------
export const RESERVATION_ACTIVE_STATUSES = ["REQUESTED", "CONFIRMED", "SEATED"] as const;
export const RESERVATION_GRACE_MINUTES = 120;

export type ReservationLifecycleSnapshot = {
  status: string;
  startTime: Date;
  expectedEndTime: Date;
};

export function isReservationActive(
  r: ReservationLifecycleSnapshot,
  now: Date = new Date(),
  graceMinutes: number = RESERVATION_GRACE_MINUTES,
): boolean {
  // SEATED is always active — the party is physically at the table.
  // Only the host can clear it (mark departed). Stale-SEATED is a real
  // operational problem; the admin Reservations page surfaces it.
  if (r.status === "SEATED") return true;
  if (r.status !== "REQUESTED" && r.status !== "CONFIRMED") return false;
  // Within the reservation's own window: always active.
  if (r.startTime.getTime() > now.getTime()) return true;
  // After expectedEnd + grace: stale, no longer blocks anything.
  const expired = r.expectedEndTime.getTime() + graceMinutes * 60_000 < now.getTime();
  return !expired;
}

// Inverse — anything in the active statuses that is NOT active is stale.
export function isReservationStale(
  r: ReservationLifecycleSnapshot,
  now: Date = new Date(),
  graceMinutes: number = RESERVATION_GRACE_MINUTES,
): boolean {
  if (!(RESERVATION_ACTIVE_STATUSES as readonly string[]).includes(r.status)) return false;
  return !isReservationActive(r, now, graceMinutes);
}

// ---------------------------------------------------------------------------
// Table status — DIRTY ↔ AVAILABLE ↔ OUT_OF_SERVICE.
// Seat / depart flips are owned by the reservation transitions above; this
// is the hostess-facing "mark this table cleaned / take it out of service"
// path that mirrors how real hospitality teams work the floor.
// ---------------------------------------------------------------------------
const ALLOWED_TABLE_STATUSES = ["AVAILABLE", "DIRTY", "OUT_OF_SERVICE"] as const;
export type ManualTableStatus = (typeof ALLOWED_TABLE_STATUSES)[number];

export async function setTableStatus(
  principal: Principal,
  tableId: string,
  status: ManualTableStatus,
) {
  const t = await prisma.diningTable.findUnique({ where: { id: tableId } });
  assertTenantOwned(t, principal);
  requirePermission(principal, t.clubId, "reservations:manage");
  if (!ALLOWED_TABLE_STATUSES.includes(status)) {
    throw new ValidationError([{ path: "status", message: "Unsupported table status." }]);
  }
  if (t.status === "SEATED" && status !== "OUT_OF_SERVICE") {
    throw new ConflictError("Cannot reset a seated table. Mark the reservation departed first.");
  }
  const updated = await prisma.diningTable.update({
    where: { id: tableId }, data: { status },
  });
  await audit(principal, {
    action: `reservation.table.status.${status.toLowerCase()}`,
    entityType: "DiningTable",
    entityId: tableId, clubId: t.clubId,
    before: { status: t.status }, after: { status },
  });
  return updated;
}

// ---------------------------------------------------------------------------
// Step 18 — releaseTable
//
// Counterpart to `departReservation` for the POS/self-seating path:
// when a waiter seated a party from the floor map without a backing
// reservation, "Mark departed" needs to land somewhere that doesn't
// require a reservation to exist. Same safety guard as the reservation
// path: refuse if an unsettled check is still on the table, otherwise
// flip the table to DIRTY so the next party knows to bus first.
// ---------------------------------------------------------------------------
export async function releaseTable(principal: Principal, tableId: string) {
  const t = await prisma.diningTable.findUnique({ where: { id: tableId } });
  assertTenantOwned(t, principal);
  requirePermission(principal, t.clubId, "reservations:manage");
  if (t.status !== "SEATED") {
    throw new ConflictError("Only a seated table can be marked departed.");
  }
  const openCheck = await prisma.pOSCheck.findFirst({
    where: { tableId, clubId: t.clubId, status: { notIn: ["CLOSED", "VOIDED"] } },
    select: { id: true },
  });
  if (openCheck) {
    throw new ConflictError("Settle the open check before marking departed.");
  }
  const updated = await prisma.diningTable.update({
    where: { id: tableId },
    data: { status: "DIRTY" },
  });
  await audit(principal, {
    action: "table.release",
    entityType: "DiningTable",
    entityId: tableId, clubId: t.clubId,
    before: { status: t.status }, after: { status: "DIRTY" },
  });
  return updated;
}

// ---------------------------------------------------------------------------
// POS check linkage
// ---------------------------------------------------------------------------
// Called by the host action "Open POS Check from reservation". Returns
// the underlying check, opening a new one if needed.
export async function ensureCheckForReservation(
  principal: Principal,
  reservationId: string,
): Promise<{ checkId: string; linkId: string }> {
  const r = await loadOwnedReservation(principal, reservationId);
  requirePermission(principal, r.clubId, "reservations:manage");
  if (r.status !== "SEATED") {
    throw new ConflictError("Open a check only after seating the party.");
  }
  if (!r.memberId && r.reservationType !== "WALK_IN") {
    // Guests without a member need a one-off check; current POS check
    // workflow assumes a member, so block this for now and route
    // through the existing legacy lounge sale path instead.
    throw new ConflictError("Guest-only reservations don't yet support POS checks. Use the legacy ring-up flow.");
  }
  // If a link already exists, reuse it (one primary check per reservation).
  const existing = await prisma.diningReservationCheckLink.findFirst({
    where: { reservationId },
    orderBy: { linkedAt: "asc" },
  });
  if (existing) return { checkId: existing.posCheckId, linkId: existing.id };

  if (!r.memberId) {
    throw new ConflictError("A member must be on the reservation to open a check.");
  }
  // Delegate to the existing openCheck — keeps tenancy / posting guard.
  // Stamp the DiningTable id so the floor map can offer the seat-level
  // drilldown for reservation-seated tables too.
  const { openCheck } = await import("../pos/checks");
  const check = await openCheck(principal, r.clubId, {
    memberId: r.memberId,
    reservationId: r.id,
    tableId: r.tableId,
  });
  // Phase 18F — pre-create the primary seat row so the seat view shows
  // the reservation's member on Seat 1 immediately.
  await prisma.pOSCheckSeat.create({
    data: {
      clubId: r.clubId, posCheckId: check.id, seatNumber: 1,
      memberId: r.memberId, isPrimary: true,
    },
  });
  // Step 17 — if the reservation carries a partySize, auto-populate
  // guest seats 2..partySize so the seat view reflects how many
  // people are seated. Seats above partySize stay unassigned and
  // render as "Unassigned" via seatSummary's 1..capacity loop.
  if (r.partySize && r.partySize > 1) {
    const guestSeats = [];
    for (let n = 2; n <= r.partySize; n++) {
      guestSeats.push({
        clubId: r.clubId, posCheckId: check.id, seatNumber: n,
        memberId: null, guestName: "Guest", isPrimary: false,
      });
    }
    await prisma.pOSCheckSeat.createMany({ data: guestSeats });
  }
  const link = await prisma.diningReservationCheckLink.create({
    data: {
      clubId: r.clubId,
      reservationId: r.id,
      posCheckId: check.id,
    },
  });
  await audit(principal, {
    action: "reservation.open-check",
    entityType: "DiningReservation",
    entityId: r.id, clubId: r.clubId,
    after: { checkId: check.id },
  });
  return { checkId: check.id, linkId: link.id };
}

// Called by settleCheck / settleCheckBySeats / confirmQRPayment after
// the sale completes. Idempotent — multiple settlement events for
// the same check resolve to the same row, and the auto-depart pass
// is a no-op if the reservation has already been completed.
//
// Step 30 — broadened from "link-only" to also auto-depart the
// reservation when the closed check was the last open one on its
// table. Without this, the DiningReservation stays SEATED forever,
// and the floor map keeps showing the member as actively seated
// (the L1 / Margaret Holloway bug).
export async function recordCheckSettlement(opts: {
  posCheckId: string;
  posSaleId: string;
  principal?: Principal | null;
}) {
  await prisma.diningReservationCheckLink.updateMany({
    where: { posCheckId: opts.posCheckId },
    data: { posSaleId: opts.posSaleId },
  });
  await autoDepartReservationOnCheckClose({
    posCheckId: opts.posCheckId,
    principal: opts.principal ?? null,
  });
}

// ---------------------------------------------------------------------------
// Step 30 — table-lifecycle reconciliation core.
//
// When a check transitions to CLOSED AND it was the last open check
// on its table AND there's a linked reservation in SEATED status,
// flip the reservation to COMPLETED + actualDepartedAt = now. Also
// flip the table to DIRTY defensively in case the settle path missed
// it. Exported so the reconciler (reconcile-reservations.ts) can
// re-use the exact same predicate for stale-data repair.
// ---------------------------------------------------------------------------
export async function autoDepartReservationOnCheckClose(opts: {
  posCheckId: string;
  principal: Principal | null;
}): Promise<{ departed: string[] }> {
  const check = await prisma.pOSCheck.findUnique({
    where: { id: opts.posCheckId },
    select: {
      id: true, clubId: true, status: true,
      tableId: true, reservationId: true,
    },
  });
  if (!check) return { departed: [] };
  if (check.status !== "CLOSED") return { departed: [] };

  // A check can be linked to a reservation two ways: POSCheck.reservationId
  // (direct FK) or DiningReservationCheckLink rows. Collect both.
  const reservationIds = new Set<string>();
  if (check.reservationId) reservationIds.add(check.reservationId);
  const links = await prisma.diningReservationCheckLink.findMany({
    where: { posCheckId: check.id },
    select: { reservationId: true },
  });
  for (const l of links) reservationIds.add(l.reservationId);

  if (reservationIds.size === 0) return { departed: [] };

  const departed: string[] = [];
  for (const reservationId of reservationIds) {
    const flipped = await tryAutoDepartReservation(reservationId, opts.principal);
    if (flipped) departed.push(reservationId);
  }
  return { departed };
}

// Per-reservation guard. Pure function over the data — same predicate
// is re-used by the batch reconciler.
async function tryAutoDepartReservation(
  reservationId: string,
  principal: Principal | null,
): Promise<boolean> {
  const r = await prisma.diningReservation.findUnique({
    where: { id: reservationId },
    select: {
      id: true, clubId: true, status: true, tableId: true,
      actualSeatedAt: true, memberId: true,
    },
  });
  if (!r) return false;
  // Only complete reservations that are still SEATED. Walk-ins and
  // no-shows aren't touched; double-confirms are idempotent.
  if (r.status !== "SEATED") return false;
  if (!r.tableId) return false;

  // Refuse if ANY check on the same table is still open — partial
  // settles and multi-check scenarios should keep the table SEATED.
  const otherOpenCheck = await prisma.pOSCheck.findFirst({
    where: {
      tableId: r.tableId,
      clubId: r.clubId,
      status: { notIn: ["CLOSED", "VOIDED"] },
    },
    select: { id: true },
  });
  if (otherOpenCheck) return false;

  const now = new Date();
  await prisma.diningReservation.update({
    where: { id: r.id },
    data: { status: "COMPLETED", actualDepartedAt: now },
  });
  // Defensive — make sure the table is DIRTY too. settleCheckBySeats
  // already does this for the closing check, but the reconciler
  // path may need it.
  await prisma.diningTable.updateMany({
    where: { id: r.tableId, clubId: r.clubId, status: "SEATED" },
    data: { status: "DIRTY" },
  });
  await audit(principal, {
    action: "reservation.auto-depart-on-close",
    entityType: "DiningReservation",
    entityId: r.id,
    clubId: r.clubId,
    after: {
      actualDepartedAt: now,
      durationMinutes: r.actualSeatedAt
        ? Math.round((now.getTime() - r.actualSeatedAt.getTime()) / 60_000)
        : null,
    },
  });
  return true;
}

// ---------------------------------------------------------------------------
// Queries (read-side)
// ---------------------------------------------------------------------------
export function defaultInclude() {
  return {
    member: { select: { id: true, firstName: true, lastName: true, memberNumber: true, email: true } },
    diningArea: { select: { id: true, name: true } },
    table: { select: { id: true, tableNumber: true, displayName: true, capacity: true } },
    checkLinks: {
      include: {
        posSale: { select: { id: true, grandTotal: true, saleNumber: true, status: true } },
        posCheck: { select: { id: true, checkNumber: true, status: true, receiptEmailStatus: true } },
      },
    },
  } as const;
}

export async function listReservationsForDate(
  principal: Principal,
  clubId: string,
  date: Date,
) {
  requirePermission(principal, clubId, "reservations:read");
  const dayStart = new Date(date);
  dayStart.setUTCHours(0, 0, 0, 0);
  const dayEnd = new Date(dayStart);
  dayEnd.setUTCDate(dayEnd.getUTCDate() + 1);
  return prisma.diningReservation.findMany({
    where: {
      ...tenantWhere(principal, clubId),
      startTime: { gte: dayStart, lt: dayEnd },
    },
    include: defaultInclude(),
    orderBy: { startTime: "asc" },
  });
}

export async function listUpcomingReservationsForMember(memberId: string, limit = 5) {
  return prisma.diningReservation.findMany({
    where: {
      memberId,
      status: { in: ["REQUESTED", "CONFIRMED", "SEATED"] },
      startTime: { gte: new Date(Date.now() - 4 * 60 * 60 * 1000) }, // include parties seated within the last 4h
    },
    include: defaultInclude(),
    orderBy: { startTime: "asc" },
    take: limit,
  });
}

export async function listPastReservationsForMember(memberId: string, limit = 25) {
  return prisma.diningReservation.findMany({
    where: {
      memberId,
      OR: [
        { status: "COMPLETED" },
        { status: "NO_SHOW" },
        { status: "CANCELLED" },
      ],
    },
    include: defaultInclude(),
    orderBy: { startTime: "desc" },
    take: limit,
  });
}

export async function getReservation(principal: Principal, id: string) {
  const r = await prisma.diningReservation.findUnique({
    where: { id },
    include: defaultInclude(),
  });
  assertTenantOwned(r, principal);
  if (!hasPermission(principal, r.clubId, "reservations:read")) {
    // Members can read their own reservation regardless.
    if (!principal.memberId || r.memberId !== principal.memberId) {
      throw new ForbiddenError("Not permitted to view this reservation.");
    }
  }
  return r;
}

// ---------------------------------------------------------------------------
// Confirmation email
// ---------------------------------------------------------------------------
export async function sendConfirmationEmail(reservationId: string) {
  const r = await prisma.diningReservation.findUnique({
    where: { id: reservationId },
    include: {
      member: { select: { firstName: true, lastName: true, email: true } },
      club: { select: { name: true } },
      diningArea: { select: { name: true } },
    },
  });
  if (!r) return { status: "FAILED", reason: "Reservation not found" } as const;
  const settings = await getReservationSettings(r.clubId);
  if (!settings.confirmationEmailEnabled) {
    return { status: "DISABLED" } as const;
  }
  const recipient =
    r.reservationType === "MEMBER" ? r.member?.email ?? null : (r.guestEmail || r.member?.email || null);
  if (!recipient || !recipient.includes("@")) {
    await prisma.diningReservation.update({
      where: { id: r.id },
      data: { confirmationEmailStatus: "SKIPPED_NO_EMAIL", confirmationEmailAddress: null },
    });
    return { status: "SKIPPED_NO_EMAIL" } as const;
  }

  const adapter = await selectEmailAdapter(r.clubId);
  const mode = (await getEmailDeliveryDescriptor(r.clubId)).mode;
  const firstName = r.member?.firstName ?? r.guestName ?? "guest";
  const subject = `${r.club.name} — your reservation is confirmed`;
  const body = buildConfirmationBody({
    firstName,
    clubName: r.club.name,
    areaName: r.diningArea.name,
    startTime: r.startTime,
    partySize: r.partySize,
    occasion: r.occasion,
    specialRequests: r.specialRequests,
    dressCodeText: settings.dressCodeText,
    noShowPolicyText: settings.noShowPolicyText,
    noShowFeeAmount: settings.noShowFeeEnabled ? Number(settings.noShowFeeAmount.toString()) : null,
    contactPhone: settings.contactPhone,
    contactEmail: settings.contactEmail,
  });
  const result = await adapter.send({
    clubId: r.clubId,
    channel: "EMAIL",
    to: { email: recipient, memberId: r.memberId ?? null },
    subject,
    body,
  });
  const persistedStatus =
    result.status === "SENT" && mode === "console" ? "DEV_LOGGED" :
    result.status === "SENT" ? "SENT" :
    result.failureReason?.startsWith("suppressed:") ? "SUPPRESSED" :
    "FAILED";
  await prisma.diningReservation.update({
    where: { id: r.id },
    data: {
      confirmationSentAt: result.status === "SENT" ? new Date() : null,
      confirmationEmailStatus: persistedStatus,
      confirmationEmailAddress: recipient,
      confirmationEmailFailure: persistedStatus === "FAILED" || persistedStatus === "SUPPRESSED" ? (result.failureReason ?? null) : null,
    },
  });
  return { status: persistedStatus, address: recipient } as const;
}

function buildConfirmationBody(input: {
  firstName: string;
  clubName: string;
  areaName: string;
  startTime: Date;
  partySize: number;
  occasion: string | null;
  specialRequests: string | null;
  dressCodeText: string;
  noShowPolicyText: string;
  noShowFeeAmount: number | null;
  contactPhone: string | null;
  contactEmail: string | null;
}): string {
  const when = input.startTime.toISOString().slice(0, 16).replace("T", " at ");
  return [
    `Dear ${input.firstName},`,
    ``,
    `Your reservation at ${input.clubName} is confirmed.`,
    ``,
    `  When:        ${when}`,
    `  Where:       ${input.areaName}`,
    `  Party size:  ${input.partySize}`,
    input.occasion ? `  Occasion:    ${input.occasion}` : "",
    input.specialRequests ? `  Note to staff: ${input.specialRequests}` : "",
    ``,
    `Dress code`,
    `----------`,
    input.dressCodeText,
    ``,
    `Cancellation policy`,
    `-------------------`,
    input.noShowPolicyText,
    input.noShowFeeAmount !== null
      ? `Missed reservations may be subject to a ${formatCurrency(input.noShowFeeAmount)} no-show fee charged to the member account.`
      : "",
    ``,
    (input.contactPhone || input.contactEmail)
      ? `If you need to change or cancel, please contact the Clubhouse:`
      : `If you need to change or cancel, please contact the Clubhouse.`,
    input.contactPhone ? `  ${input.contactPhone}` : "",
    input.contactEmail ? `  ${input.contactEmail}` : "",
    ``,
    `We look forward to seeing you.`,
    ``,
    input.clubName,
  ].filter((s) => s !== "").join("\n");
}

// Internal: re-export FOOD_BEVERAGE constants so callers don't have to
// import the survey module just to know the department key.
export const HOSPITALITY_DEPT_KEY = "FOOD_BEVERAGE";
