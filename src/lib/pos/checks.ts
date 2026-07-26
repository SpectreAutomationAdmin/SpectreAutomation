// Open-check workflow for the lounge POS.
//
// A POSCheck is the operational record of an in-progress order: server
// opens a check → adds DRAFT lines → sends them to prep stations as
// POSChits (transitioning lines to SENT) → eventually settles the
// check, which delegates to the existing `createSale + completeSale`
// engine to produce the final POSSale, AR Charge, and GL JournalEntry.
//
// Until settlement, NOTHING financial is posted. Sending chits is
// purely operational — it tells the kitchen / bar what to make next.
// The check carries running totals (recomputed on each line change)
// but those numbers don't reach the GL until `settleCheck` runs.
//
// Tenant safety, posting guards, training-mode / support-readonly
// gates, audit, and member-balance recompute all live in the same
// places they do today — `settleCheck` is the only function that
// touches money paths, and it reaches them via the existing engine.

import { z } from "zod";
import { prisma } from "../prisma";
import { audit } from "../audit";
import { requirePermission, type Principal } from "../rbac";
import { assertTenantOwned, tenantWhere } from "../services/tenant";
import { ConflictError, NotFoundError, ValidationError, ForbiddenError } from "../errors";
import { assertPostingAllowed } from "../posting-guard";
import { createSale, completeSale } from "./index";
import {
  LOUNGE_LOCATION_CODE,
  LOUNGE_TERMINAL_CODE,
  GST_RATE,
} from "./lounge";

// F&B revenue account default for the lounge — same as the legacy
// path. When per-club COA mappings ship, this becomes a lookup.
// Exported so the seat-level settlement (`settleCheckBySeats`) routes
// to the same account as the legacy lounge settle path.
export const FB_REVENUE_ACCOUNT = "4200";

// ---------------------------------------------------------------------------
// Status enums (string-typed for SQLite flexibility — the values are
// documented on the schema model).
// ---------------------------------------------------------------------------
export type CheckStatus =
  | "OPEN" | "PARTIALLY_SENT" | "SENT" | "READY" | "PARTIALLY_SETTLED" | "CLOSED" | "VOIDED";

export type CheckLineStatus =
  | "DRAFT" | "SENT" | "FIRED" | "PREPARING" | "READY" | "SERVED" | "VOIDED" | "COMPED";

export type PrepStation = "KITCHEN" | "BAR" | "DESSERT" | "NONE";

export type ChitStatus = "HELD" | "QUEUED" | "PRINTED" | "ACKNOWLEDGED" | "READY" | "CANCELLED";

// Min / max course we'll let a server pick. Four covers
// apps / mains / desserts / nightcap and is more than enough for the
// floor. Clamping keeps the UI tight.
export const MIN_COURSE = 1;
export const MAX_COURSE = 4;

// Auto-pace gap whitelist (minutes). 0 / null is "manual fire only".
export const AUTO_PACE_OPTIONS = [0, 5, 10, 15, 20] as const;
export type AutoPaceOption = typeof AUTO_PACE_OPTIONS[number];

// ---------------------------------------------------------------------------
// Open a fresh check for a member at the lounge.
// ---------------------------------------------------------------------------
const openCheckSchema = z.object({
  memberId: z.string().min(1),
  tableNumber: z.string().trim().max(20).optional().nullable(),
  diningMode: z.enum(["STAY", "TO_GO"]).default("STAY"),
  // Phase 18C — when the host opens a check from the reservation
  // detail page we stamp the reservation id here so settlement can
  // roll spend back to the reservation without a second join hop.
  reservationId: z.string().optional().nullable(),
  // Phase 18E — stamp the DiningTable id so the floor map can find
  // the open check via DiningTable.posChecks and offer the seat-level
  // drilldown. Set by ensureCheckForReservation as well as the
  // server-led self-seating path.
  tableId: z.string().optional().nullable(),
});

export async function nextCheckNumber(clubId: string): Promise<string> {
  const year = new Date().getFullYear();
  const count = await prisma.pOSCheck.count({
    where: { clubId, createdAt: { gte: new Date(year, 0, 1) } },
  });
  return `CHK-${year}-${String(count + 1).padStart(6, "0")}`;
}

export async function openCheck(principal: Principal, clubId: string, raw: unknown) {
  requirePermission(principal, clubId, "inventory:write");
  const parsed = openCheckSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  }
  const d = parsed.data;
  const member = await prisma.member.findUnique({ where: { id: d.memberId } });
  if (!member) throw new NotFoundError("Member", d.memberId);
  assertTenantOwned(member, principal);
  if (member.clubId !== clubId) throw new ConflictError("Member is not at this club");

  const location = await prisma.pOSLocation.findFirst({
    where: { clubId, code: LOUNGE_LOCATION_CODE },
  });
  if (!location) throw new ConflictError(`Lounge location not provisioned (${LOUNGE_LOCATION_CODE})`);
  const terminal = await prisma.pOSTerminal.findFirst({
    where: { clubId, code: LOUNGE_TERMINAL_CODE },
  });
  const session = await prisma.pOSSession.findFirst({
    where: { clubId, locationId: location.id, status: "OPEN" },
    orderBy: { openedAt: "desc" },
  });

  const checkNumber = await nextCheckNumber(clubId);
  const check = await prisma.pOSCheck.create({
    data: {
      clubId,
      locationId: location.id,
      terminalId: terminal?.id ?? null,
      sessionId: session?.id ?? null,
      memberId: member.id,
      tableNumber: d.tableNumber ?? null,
      openedByUserId: principal.id,
      checkNumber,
      status: "OPEN",
      diningMode: d.diningMode,
      reservationId: d.reservationId ?? null,
      tableId: d.tableId ?? null,
    },
  });
  await prisma.pOSCheckEvent.create({
    data: {
      clubId, checkId: check.id, type: "OPENED",
      payloadJson: JSON.stringify({ memberId: member.id, tableNumber: d.tableNumber ?? null, diningMode: d.diningMode }),
      byUserId: principal.id,
    },
  });
  return check;
}

// ---------------------------------------------------------------------------
// List open checks (for the POS "open checks" picker).
//
// A check is "active" while it's still in service workflow OR while
// it's awaiting QR payment confirmation OR while a previous QR
// attempt failed (so the server can retry). CLOSED + VOIDED checks
// belong in the history view, not here.
// ---------------------------------------------------------------------------
export async function listOpenChecks(principal: Principal, clubId: string) {
  requirePermission(principal, clubId, "inventory:read");
  return prisma.pOSCheck.findMany({
    where: {
      ...tenantWhere(principal, clubId),
      status: {
        in: [
          "OPEN",
          "PARTIALLY_SENT",
          "SENT",
          "READY",
          "PARTIALLY_SETTLED",
          // Awaiting the QR gateway's confirmation — still on screen
          // so the server can monitor / decline / retry.
          "PAYMENT_PENDING",
          // Last QR attempt declined / expired — needs operator action
          // before the check can be closed.
          "PAYMENT_FAILED",
        ],
      },
    },
    include: {
      member: { select: { id: true, firstName: true, lastName: true, memberNumber: true } },
      lines: { select: { id: true, status: true } },
      // Chit status drives the operator-facing badge in the open-checks
      // queue ("Preparing" / "Kitchen ready" / "Ready for pickup", etc.).
      // We only need a couple of fields per chit; the derived label is
      // computed client-side from this set.
      chits: { select: { id: true, status: true, station: true } },
      // For QR Pay checks the queue badge wants to show the gateway
      // status (declined vs expired) — pull the latest payment row
      // attached to the active sale.
      posSale: {
        select: {
          id: true,
          payments: {
            select: { externalPaymentStatus: true, failureReason: true },
            take: 1,
            orderBy: { capturedAt: "desc" },
          },
        },
      },
    },
    orderBy: { createdAt: "desc" },
  });
}

// ---------------------------------------------------------------------------
// Fetch a single check with everything the POS UI needs.
// ---------------------------------------------------------------------------
export async function getCheck(principal: Principal, checkId: string) {
  const check = await prisma.pOSCheck.findUnique({
    where: { id: checkId },
    include: {
      member: { select: { id: true, firstName: true, lastName: true, memberNumber: true, status: true, accessStatus: true, paymentMethodStatus: true } },
      lines: {
        orderBy: { createdAt: "asc" },
        include: {
          menuItem: { include: { category: true } },
          modifiers: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
        },
      },
      chits: {
        orderBy: { sentAt: "desc" },
        include: { lines: true },
      },
      events: { orderBy: { occurredAt: "asc" } },
      posSale: { select: { id: true, saleNumber: true, status: true } },
    },
  });
  if (!check) throw new NotFoundError("POSCheck", checkId);
  assertTenantOwned(check, principal);
  requirePermission(principal, check.clubId, "inventory:read");
  return check;
}

// ---------------------------------------------------------------------------
// Add one or more menu items to a check as DRAFT lines.
// ---------------------------------------------------------------------------
const addLineSchema = z.object({
  menuItemId: z.string().min(1),
  quantity: z.number().int().positive().max(99).default(1),
  note: z.string().trim().max(200).optional().nullable(),
  discountPct: z.number().min(0).max(100).default(0),
  course: z.number().int().min(MIN_COURSE).max(MAX_COURSE).default(1),
  // Phase 18E — seat-level ordering. `seatNumber` is 1-based; `tableLevel`
  // marks a shared-by-the-table line (water carafe, bread service, etc.).
  // Exactly one of the two should be set; the resolver below enforces it.
  seatNumber: z.number().int().min(1).max(24).optional(),
  tableLevel: z.boolean().optional(),
});
const addLinesSchema = z.object({ items: z.array(addLineSchema).min(1) });

export async function addCheckLines(principal: Principal, checkId: string, raw: unknown) {
  const check = await prisma.pOSCheck.findUnique({ where: { id: checkId } });
  if (!check) throw new NotFoundError("POSCheck", checkId);
  assertTenantOwned(check, principal);
  requirePermission(principal, check.clubId, "inventory:write");
  if (check.status === "CLOSED" || check.status === "VOIDED") {
    throw new ConflictError(`Cannot add items to a ${check.status.toLowerCase()} check`);
  }
  const parsed = addLinesSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  }

  const itemIds = Array.from(new Set(parsed.data.items.map((i) => i.menuItemId)));
  const items = await prisma.pOSMenuItem.findMany({
    where: { clubId: check.clubId, id: { in: itemIds }, isActive: true },
    include: { category: { select: { chitDestination: true } } },
  });
  const byId = new Map(items.map((i) => [i.id, i]));

  const created: Array<{ id: string }> = [];
  for (const ci of parsed.data.items) {
    const mi = byId.get(ci.menuItemId);
    if (!mi) throw new ConflictError(`Unknown or inactive menu item: ${ci.menuItemId}`);
    const description = ci.note ? `${mi.name} — ${ci.note}` : mi.name;
    const isTableLine = !!ci.tableLevel || ci.seatNumber === undefined;
    const line = await prisma.pOSCheckLine.create({
      data: {
        clubId: check.clubId,
        checkId: check.id,
        menuItemId: mi.id,
        description,
        quantity: ci.quantity,
        unitPrice: mi.price,
        discountPct: ci.discountPct,
        taxable: mi.taxable,
        prepStation: (mi.category.chitDestination as PrepStation) ?? "KITCHEN",
        course: ci.course,
        note: ci.note ?? null,
        status: "DRAFT",
        seatNumber: isTableLine ? null : (ci.seatNumber ?? null),
        tableLevel: isTableLine,
      },
    });
    created.push({ id: line.id });
  }
  await prisma.pOSCheckEvent.create({
    data: {
      clubId: check.clubId, checkId: check.id, type: "ITEM_ADDED",
      payloadJson: JSON.stringify({ itemIds, count: created.length }),
      byUserId: principal.id,
    },
  });
  // OPEN status holds while there are unsent items; transitions on send.
  return getCheck(principal, check.id);
}

// ---------------------------------------------------------------------------
// Remove a DRAFT line. Sent lines must use voidCheckLine instead.
// ---------------------------------------------------------------------------
export async function removeCheckLine(principal: Principal, checkLineId: string) {
  const line = await prisma.pOSCheckLine.findUnique({
    where: { id: checkLineId },
    include: { check: true },
  });
  if (!line) throw new NotFoundError("POSCheckLine", checkLineId);
  assertTenantOwned(line, principal);
  requirePermission(principal, line.clubId, "inventory:write");
  if (line.status !== "DRAFT") {
    throw new ConflictError(`Only DRAFT lines can be removed (this one is ${line.status}). Use void instead.`);
  }
  await prisma.pOSCheckLine.delete({ where: { id: line.id } });
  await prisma.pOSCheckEvent.create({
    data: {
      clubId: line.clubId, checkId: line.checkId, type: "ITEM_REMOVED",
      payloadJson: JSON.stringify({ checkLineId: line.id, description: line.description }),
      byUserId: principal.id,
    },
  });
}

// ---------------------------------------------------------------------------
// Update a DRAFT line's quantity / note / discount. Sent lines are
// immutable from the staff POV — they can only be voided.
// ---------------------------------------------------------------------------
const updateLineSchema = z.object({
  quantity: z.number().int().positive().max(99).optional(),
  note: z.string().trim().max(200).optional().nullable(),
  discountPct: z.number().min(0).max(100).optional(),
  course: z.number().int().min(MIN_COURSE).max(MAX_COURSE).optional(),
});

export async function updateCheckLine(principal: Principal, checkLineId: string, raw: unknown) {
  const line = await prisma.pOSCheckLine.findUnique({
    where: { id: checkLineId },
    include: { menuItem: true },
  });
  if (!line) throw new NotFoundError("POSCheckLine", checkLineId);
  assertTenantOwned(line, principal);
  requirePermission(principal, line.clubId, "inventory:write");
  if (line.status !== "DRAFT") {
    throw new ConflictError(`Only DRAFT lines can be updated (this one is ${line.status})`);
  }
  const parsed = updateLineSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  }
  const d = parsed.data;
  // If the note changes, the description also updates so it stays in sync.
  let description = line.description;
  if (d.note !== undefined && line.menuItem) {
    description = d.note ? `${line.menuItem.name} — ${d.note}` : line.menuItem.name;
  }
  const courseChanged = d.course !== undefined && d.course !== line.course;
  await prisma.pOSCheckLine.update({
    where: { id: line.id },
    data: {
      quantity: d.quantity ?? line.quantity,
      note: d.note ?? line.note,
      description,
      discountPct: d.discountPct ?? line.discountPct,
      course: d.course ?? line.course,
    },
  });
  if (courseChanged) {
    await prisma.pOSCheckEvent.create({
      data: {
        clubId: line.clubId, checkId: line.checkId, type: "ITEM_COURSE_CHANGED",
        payloadJson: JSON.stringify({ checkLineId: line.id, from: line.course, to: d.course }),
        byUserId: principal.id,
      },
    });
  }
}

// ---------------------------------------------------------------------------
// Void a sent line. Requires a non-empty reason; emits a timeline event.
// We rely on `inventory:write` as the gate today — if/when a manager-
// only RBAC role lands, swap this for the stricter permission key.
// ---------------------------------------------------------------------------
export async function voidCheckLine(principal: Principal, checkLineId: string, reason: string) {
  const trimmed = reason.trim();
  if (trimmed.length < 3) {
    throw new ValidationError([{ path: "reason", message: "Void reason is required (min 3 chars)" }]);
  }
  const line = await prisma.pOSCheckLine.findUnique({ where: { id: checkLineId } });
  if (!line) throw new NotFoundError("POSCheckLine", checkLineId);
  assertTenantOwned(line, principal);
  requirePermission(principal, line.clubId, "inventory:write");
  if (line.status === "VOIDED" || line.status === "COMPED") {
    throw new ConflictError(`Line is already ${line.status}`);
  }
  await prisma.pOSCheckLine.update({
    where: { id: line.id },
    data: { status: "VOIDED", voidedAt: new Date(), voidedByUserId: principal.id, voidedReason: trimmed },
  });
  await prisma.pOSCheckEvent.create({
    data: {
      clubId: line.clubId, checkId: line.checkId, type: "ITEM_VOIDED",
      payloadJson: JSON.stringify({ checkLineId: line.id, reason: trimmed }),
      byUserId: principal.id,
    },
  });
}

// Mark a line as COMPED (100% off, retained on the check for the kitchen
// but excluded from the bill at settlement). Same gate as void.
export async function compCheckLine(principal: Principal, checkLineId: string, reason: string) {
  const trimmed = reason.trim();
  if (trimmed.length < 3) {
    throw new ValidationError([{ path: "reason", message: "Comp reason is required (min 3 chars)" }]);
  }
  const line = await prisma.pOSCheckLine.findUnique({ where: { id: checkLineId } });
  if (!line) throw new NotFoundError("POSCheckLine", checkLineId);
  assertTenantOwned(line, principal);
  requirePermission(principal, line.clubId, "inventory:write");
  if (line.status === "VOIDED" || line.status === "COMPED") {
    throw new ConflictError(`Line is already ${line.status}`);
  }
  await prisma.pOSCheckLine.update({
    where: { id: line.id },
    data: { status: "COMPED", discountPct: 100, compedByUserId: principal.id },
  });
  await prisma.pOSCheckEvent.create({
    data: {
      clubId: line.clubId, checkId: line.checkId, type: "ITEM_COMPED",
      payloadJson: JSON.stringify({ checkLineId: line.id, reason: trimmed }),
      byUserId: principal.id,
    },
  });
}

// ---------------------------------------------------------------------------
// Send the check's unsent DRAFT lines to their respective prep stations.
// Lines are grouped by (station, course); one POSChit per group. Course 1
// fires immediately (status=QUEUED, firedAt=now). Later courses are HELD;
// if the check has autoFireGapMinutes, a fireAt is set at
// sendTime + (course-1) * gap, otherwise they wait for a manual
// fireNextCourse.
// ---------------------------------------------------------------------------
export async function sendUnsentItems(principal: Principal, checkId: string) {
  const check = await prisma.pOSCheck.findUnique({
    where: { id: checkId },
    include: {
      lines: { where: { status: "DRAFT" } },
    },
  });
  if (!check) throw new NotFoundError("POSCheck", checkId);
  assertTenantOwned(check, principal);
  requirePermission(principal, check.clubId, "inventory:write");
  if (check.status === "CLOSED" || check.status === "VOIDED") {
    throw new ConflictError(`Cannot send chits on a ${check.status.toLowerCase()} check`);
  }
  if (check.lines.length === 0) {
    throw new ConflictError("No unsent items on this check");
  }

  // Group by (station, course). NONE-routed lines skip the chit step
  // entirely and go straight to SENT.
  const groups = new Map<string, { station: string; course: number; lines: typeof check.lines }>();
  const noStationLines: typeof check.lines = [];
  for (const line of check.lines) {
    if (line.prepStation === "NONE") {
      noStationLines.push(line);
      continue;
    }
    const key = `${line.prepStation}#${line.course}`;
    const g = groups.get(key);
    if (g) g.lines.push(line);
    else groups.set(key, { station: line.prepStation, course: line.course, lines: [line] });
  }

  const now = new Date();
  const gap = check.autoFireGapMinutes ?? 0;
  const createdChitIds: string[] = [];
  for (const { station, course, lines } of groups.values()) {
    const isFirstCourse = course === 1;
    // Held chits get a fireAt only when auto-pace is on.
    const fireAt = !isFirstCourse && gap > 0
      ? new Date(now.getTime() + (course - 1) * gap * 60_000)
      : null;
    const chit = await prisma.pOSChit.create({
      data: {
        clubId: check.clubId,
        checkId: check.id,
        station,
        course,
        status: isFirstCourse ? "QUEUED" : "HELD",
        sentByUserId: principal.id,
        sentAt: now,
        firedAt: isFirstCourse ? now : null,
        fireAt,
      },
    });
    for (const line of lines) {
      await prisma.pOSChitLine.create({
        data: {
          clubId: check.clubId,
          chitId: chit.id,
          checkLineId: line.id,
          displayDescription: line.description,
          displayQuantity: line.quantity,
          displayNote: line.note,
          displaySeatNumber: line.seatNumber,
          displayTableLevel: line.tableLevel,
        },
      });
      await prisma.pOSCheckLine.update({
        where: { id: line.id },
        data: { status: "SENT", sentAt: now },
      });
    }
    createdChitIds.push(chit.id);
    await prisma.pOSCheckEvent.create({
      data: {
        clubId: check.clubId, checkId: check.id, type: "CHIT_SENT",
        payloadJson: JSON.stringify({
          station, course, chitId: chit.id, lineCount: lines.length,
          held: !isFirstCourse, fireAt: fireAt?.toISOString() ?? null,
        }),
        byUserId: principal.id,
      },
    });
  }
  // NONE-routed lines (e.g. retail) bypass chits.
  for (const line of noStationLines) {
    await prisma.pOSCheckLine.update({
      where: { id: line.id },
      data: { status: "SENT", sentAt: now },
    });
  }

  const anyDraft = await prisma.pOSCheckLine.count({
    where: { checkId: check.id, status: "DRAFT" },
  });
  await prisma.pOSCheck.update({
    where: { id: check.id },
    data: { status: anyDraft > 0 ? "PARTIALLY_SENT" : "SENT" },
  });

  return { checkId: check.id, chitIds: createdChitIds };
}

// ---------------------------------------------------------------------------
// Set the auto-pace gap on a check. Passing 0 / null disables auto-pace
// (manual fire only). Affects only chits created AFTER this call —
// previously-sent held chits keep their pre-existing fireAt.
// ---------------------------------------------------------------------------
export async function setAutoPace(principal: Principal, checkId: string, gapMinutes: number | null) {
  const check = await prisma.pOSCheck.findUnique({ where: { id: checkId } });
  if (!check) throw new NotFoundError("POSCheck", checkId);
  assertTenantOwned(check, principal);
  requirePermission(principal, check.clubId, "inventory:write");
  if (check.status === "CLOSED" || check.status === "VOIDED") {
    throw new ConflictError(`Cannot change pacing on a ${check.status.toLowerCase()} check`);
  }
  const normalized = gapMinutes && gapMinutes > 0 ? Math.min(60, Math.floor(gapMinutes)) : null;
  if (normalized !== null && !AUTO_PACE_OPTIONS.includes(normalized as AutoPaceOption)) {
    throw new ValidationError([{ path: "gapMinutes", message: `Must be one of ${AUTO_PACE_OPTIONS.join(", ")}` }]);
  }
  await prisma.pOSCheck.update({
    where: { id: check.id },
    data: { autoFireGapMinutes: normalized },
  });
  await prisma.pOSCheckEvent.create({
    data: {
      clubId: check.clubId, checkId: check.id, type: "AUTO_PACE_CHANGED",
      payloadJson: JSON.stringify({ from: check.autoFireGapMinutes, to: normalized }),
      byUserId: principal.id,
    },
  });
}

// ---------------------------------------------------------------------------
// Manually fire the next held course on a check. Promotes every HELD chit
// at the lowest-numbered held course to QUEUED, sets firedAt=now, clears
// the fireAt timer (no longer auto-firing — it just fired). Idempotent:
// returns { fired: 0 } when there are no held chits.
// ---------------------------------------------------------------------------
export async function fireNextCourse(principal: Principal, checkId: string) {
  const check = await prisma.pOSCheck.findUnique({ where: { id: checkId } });
  if (!check) throw new NotFoundError("POSCheck", checkId);
  assertTenantOwned(check, principal);
  requirePermission(principal, check.clubId, "inventory:write");
  if (check.status === "CLOSED" || check.status === "VOIDED") {
    throw new ConflictError(`Cannot fire courses on a ${check.status.toLowerCase()} check`);
  }
  const held = await prisma.pOSChit.findMany({
    where: { checkId: check.id, status: "HELD" },
    orderBy: { course: "asc" },
  });
  if (held.length === 0) return { fired: 0, course: null as number | null };

  const nextCourse = held[0].course;
  const toFire = held.filter((c) => c.course === nextCourse);
  const now = new Date();
  await prisma.pOSChit.updateMany({
    where: { id: { in: toFire.map((c) => c.id) } },
    data: { status: "QUEUED", firedAt: now, fireAt: null },
  });
  await prisma.pOSCheckEvent.create({
    data: {
      clubId: check.clubId, checkId: check.id, type: "COURSE_FIRED",
      payloadJson: JSON.stringify({ course: nextCourse, chitIds: toFire.map((c) => c.id), manual: true }),
      byUserId: principal.id,
    },
  });
  return { fired: toFire.length, course: nextCourse };
}

// ---------------------------------------------------------------------------
// Auto-promote any HELD chits whose fireAt has passed. Called from the
// kitchen / bar page loaders right before reading the active chit list.
// No-op when there's nothing to promote. Tenant-scoped.
// ---------------------------------------------------------------------------
export async function promoteDueHeldChits(clubId: string, station: PrepStation) {
  const now = new Date();
  const due = await prisma.pOSChit.findMany({
    where: {
      clubId,
      station,
      status: "HELD",
      fireAt: { not: null, lte: now },
    },
    select: { id: true, checkId: true, course: true },
  });
  if (due.length === 0) return { promoted: 0 };
  await prisma.pOSChit.updateMany({
    where: { id: { in: due.map((c) => c.id) } },
    data: { status: "QUEUED", firedAt: now, fireAt: null },
  });
  // One event per check (group by checkId).
  const byCheck = new Map<string, { course: number; chitIds: string[] }>();
  for (const c of due) {
    const existing = byCheck.get(c.checkId);
    if (existing) {
      existing.chitIds.push(c.id);
      existing.course = Math.min(existing.course, c.course);
    } else {
      byCheck.set(c.checkId, { course: c.course, chitIds: [c.id] });
    }
  }
  for (const [checkId, info] of byCheck.entries()) {
    await prisma.pOSCheckEvent.create({
      data: {
        clubId, checkId, type: "COURSE_FIRED",
        payloadJson: JSON.stringify({ course: info.course, chitIds: info.chitIds, manual: false }),
      },
    });
  }
  return { promoted: due.length };
}

// ---------------------------------------------------------------------------
// Settle the check. Delegates to `createSale` + `completeSale` so all
// the financial guarantees the engine provides (posting guard,
// training-mode block, support-readonly block, JE balance check,
// audit, AR Charge, member-balance recompute) apply unchanged.
// ---------------------------------------------------------------------------
const settleSchema = z.object({
  paymentMethod: z.enum(["MEMBER_ACCOUNT", "QR_PAY"]).default("MEMBER_ACCOUNT"),
  chitDiscountPct: z.number().min(0).max(100).optional(),
  notes: z.string().trim().max(1000).optional().nullable(),
  // When true, settles even if there are still DRAFT (unsent) lines on
  // the check. The UI prompts the staff to confirm before passing this.
  allowUnsentLines: z.boolean().optional(),
  // Request origin (e.g. "https://members.silversprings.club") so the
  // saved chit's QR code resolves at the same host that issued it.
  // Pulled from `headers()` by the calling server action.
  origin: z.string().url().optional(),
});

export async function settleCheck(principal: Principal, checkId: string, raw: unknown) {
  const parsed = settleSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  }
  const d = parsed.data;

  const check = await prisma.pOSCheck.findUnique({
    where: { id: checkId },
    include: {
      member: true,
      lines: {
        include: {
          menuItem: true,
          // Modifier set per line so settlement folds priceDelta into
          // unitPrice + snapshots the modifiers onto the sale line.
          modifiers: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
        },
        orderBy: { createdAt: "asc" },
      },
    },
  });
  if (!check) throw new NotFoundError("POSCheck", checkId);
  assertTenantOwned(check, principal);
  requirePermission(principal, check.clubId, "inventory:write");
  if (check.status === "CLOSED") {
    throw new ConflictError("Check is already settled");
  }
  if (check.status === "VOIDED") {
    throw new ConflictError("Cannot settle a voided check");
  }
  if (!check.memberId || !check.member) {
    throw new ConflictError("Check has no member — open checks must be settled to a member account or QR Pay");
  }
  // Filter out VOIDED lines; COMPED lines stay (100% discount applies).
  const billableLines = check.lines.filter((l) => l.status !== "VOIDED");
  if (billableLines.length === 0) {
    throw new ConflictError("Check has no billable items");
  }
  const draftLines = billableLines.filter((l) => l.status === "DRAFT");
  if (draftLines.length > 0 && !d.allowUnsentLines) {
    throw new ConflictError(`${draftLines.length} item${draftLines.length === 1 ? " is" : "s are"} unsent — send to the kitchen/bar first, or pass allowUnsentLines=true to settle without sending.`);
  }

  // Fire the posting-guard early with a write-flavoured action name
  // so a READ_ONLY support session is rejected before any DB writes.
  await assertPostingAllowed(principal, check.clubId, "pos.check.settle.post", "POSCheck", check.id);

  // ---- Apply the same discount math as the legacy lounge service ---
  // Chit-level pct can be updated at settlement (server may have
  // discounted at the end). If not provided, use the stored value.
  const chitPctRaw = d.chitDiscountPct ?? Number(check.chitDiscountPct.toString());
  const chitPct = Math.max(0, Math.min(100, chitPctRaw));
  const chitOverrides = chitPct > 0;

  type PricedModifier = {
    modifierType: string;
    label: string;
    printLabel: string | null;
    priceDelta: number;
    sortOrder: number;
  };
  type Priced = {
    checkLineId: string;
    menuItemId: string | null;
    description: string;
    itemName: string;
    quantity: number;
    // Modifier-adjusted unit price — `(base + per-unit modifier delta)`.
    // Fed into createSale as the line's unitPrice so GST + discount
    // math computes on the actually-paid amount.
    unitPrice: number;
    lineSubtotal: number;
    lineDiscountPct: number;
    isComp: boolean;
    effectivePct: number;
    totalLineDiscount: number;
    taxAmount: number;
    taxable: boolean;
    modifiers: PricedModifier[];
  };
  const priced: Priced[] = billableLines.map((l) => {
    const baseUnitPrice = Number(l.unitPrice.toString());
    const quantity = Number(l.quantity.toString());
    // Per-unit sum of modifier deltas (negative for cheaper subs, zero
    // for free removals, positive for paid adds).
    const modDeltaPerUnit = l.modifiers.reduce(
      (s, m) => s + Number(m.priceDelta.toString()),
      0
    );
    const unitPrice = round2(baseUnitPrice + modDeltaPerUnit);
    const lineSubtotal = round2(quantity * unitPrice);
    const lineDiscountPct = Number(l.discountPct.toString());
    const isComp = l.status === "COMPED" || lineDiscountPct >= 100;
    const effectivePct = isComp ? 100 : chitOverrides ? chitPct : lineDiscountPct;
    const totalLineDiscount = round2(lineSubtotal * (effectivePct / 100));
    const finalNet = round2(lineSubtotal - totalLineDiscount);
    const taxAmount = l.taxable ? round2(finalNet * GST_RATE) : 0;
    // Build a receipt-friendly description that includes a compact
    // summary of modifiers ("Burger — no onions, add bacon").
    const labelSummary = l.modifiers
      .filter((m) => m.modifierType !== "NOTE" && m.modifierType !== "ALLERGY")
      .map((m) => m.printLabel || m.label);
    const description = labelSummary.length > 0
      ? `${l.description} — ${labelSummary.join(", ")}`
      : l.description;
    return {
      checkLineId: l.id,
      menuItemId: l.menuItemId,
      description,
      itemName: l.menuItem?.name ?? l.description,
      quantity,
      unitPrice,
      lineSubtotal,
      lineDiscountPct,
      isComp,
      effectivePct,
      totalLineDiscount,
      taxAmount,
      taxable: l.taxable,
      modifiers: l.modifiers.map((m) => ({
        modifierType: m.modifierType,
        label: m.label,
        printLabel: m.printLabel,
        priceDelta: Number(m.priceDelta.toString()),
        sortOrder: m.sortOrder,
      })),
    };
  });

  const taxTotal = round2(priced.reduce((s, l) => s + l.taxAmount, 0));
  const chitAppliedTotal = chitOverrides
    ? round2(priced.filter((l) => !l.isComp).reduce((s, l) => s + l.totalLineDiscount, 0))
    : 0;

  // Build POSDiscount entries (engine sums them into discountTotal).
  const discountEntries: Array<{ label: string; kind: "PERCENT"; value: number; amount: number }> = [];
  for (const l of priced) {
    if (l.isComp && l.totalLineDiscount > 0) {
      discountEntries.push({
        label: `Line: ${l.itemName} 100% off`,
        kind: "PERCENT", value: 100, amount: l.totalLineDiscount,
      });
    }
  }
  if (chitOverrides) {
    if (chitAppliedTotal > 0) {
      discountEntries.push({
        label: `Chit discount ${chitPct}%`,
        kind: "PERCENT", value: chitPct, amount: chitAppliedTotal,
      });
    }
  } else {
    for (const l of priced) {
      if (!l.isComp && l.totalLineDiscount > 0) {
        discountEntries.push({
          label: `Line: ${l.itemName} ${l.lineDiscountPct}% off`,
          kind: "PERCENT", value: l.lineDiscountPct, amount: l.totalLineDiscount,
        });
      }
    }
  }

  const draft = await createSale(principal, check.clubId, {
    locationCode: LOUNGE_LOCATION_CODE,
    terminalCode: LOUNGE_TERMINAL_CODE,
    sessionId: check.sessionId ?? null,
    memberId: check.memberId,
    chargeMode: d.paymentMethod,
    diningMode: check.diningMode === "TO_GO" ? "TO_GO" : "STAY",
    lines: priced.map((l) => ({
      kind: "SERVICE" as const,
      menuItemId: l.menuItemId,
      description: l.description,
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      taxAmount: l.taxAmount,
      discountAmount: l.totalLineDiscount,
      revenueAccountNumber: FB_REVENUE_ACCOUNT,
    })),
    taxLines: taxTotal > 0
      ? [{ label: "GST 5%", rate: GST_RATE, amount: taxTotal, taxCodeKey: "GST_5" }]
      : [],
    discounts: discountEntries,
    payments: [{
      method: d.paymentMethod,
      amount: round2(priced.reduce((s, l) => s + l.lineSubtotal - l.totalLineDiscount, 0) + taxTotal),
      tipAmount: 0,
    }],
    notes: d.notes ?? check.notes ?? null,
  });

  // ---- Branch on payment method ----
  // Charge-to-member account: post AR + GL immediately. The check
  // closes the moment this returns.
  // QR Pay: hold the sale in DRAFT until the gateway confirms — the
  // check transitions to PAYMENT_PENDING, no AR/GL is posted yet,
  // and the operator (or simulator) calls `confirmQRPayment` once
  // the gateway reports a successful payment.
  if (d.paymentMethod === "QR_PAY") {
    // Mark the auto-created payment row as PENDING so the public
    // QR landing + the operator's pending screen reflect the right
    // state. createSale inserts payments at status="CAPTURED" by
    // default; we override here for the deferred path.
    await prisma.pOSPayment.updateMany({
      where: { saleId: draft.id },
      data: {
        status: "PENDING",
        externalPaymentStatus: "PENDING",
      },
    });
    // Snapshot sale-line modifiers now (they're derived from the
    // priced array and don't change between request and confirm).
    await snapshotSaleLineModifiers(check.clubId, draft.id, priced);
    // Move the check into the PAYMENT_PENDING active-list bucket.
    await prisma.pOSCheck.update({
      where: { id: check.id },
      data: {
        status: "PAYMENT_PENDING",
        settledByUserId: principal.id,
        settlementMethod: "QR_PAY",
        posSaleId: draft.id,
        chitDiscountPct: chitPct,
      },
    });
    await prisma.pOSCheckEvent.create({
      data: {
        clubId: check.clubId, checkId: check.id, type: "QR_PAYMENT_REQUESTED",
        payloadJson: JSON.stringify({ saleId: draft.id, grandTotal: Number(draft.grandTotal.toString()) }),
        byUserId: principal.id,
      },
    });
    return {
      check: await prisma.pOSCheck.findUnique({ where: { id: check.id } }),
      sale: draft,
    };
  }

  // MEMBER_ACCOUNT path — post immediately.
  const completed = await completeSale(principal, draft.id);

  await snapshotSaleLineModifiers(check.clubId, completed.id, priced);
  await snapshotSignatureChit({ clubId: check.clubId, saleId: completed.id, origin: d.origin });

  // Close the check, link the sale, mark lines SERVED.
  const now = new Date();
  await prisma.pOSCheck.update({
    where: { id: check.id },
    data: {
      status: "CLOSED",
      settledAt: now,
      closedAt: now,
      settledByUserId: principal.id,
      settlementMethod: "MEMBER_ACCOUNT",
      posSaleId: completed.id,
      chitDiscountPct: chitPct,
    },
  });
  // Step 13 — flip the dining table SEATED → DIRTY on full close so the
  // floor map immediately shows "needs reset". updateMany with the
  // SEATED guard prevents stomping a RESERVED/OUT_OF_SERVICE/DIRTY
  // status that another flow has already set.
  if (check.tableId) {
    await prisma.diningTable.updateMany({
      where: { id: check.tableId, clubId: check.clubId, status: "SEATED" },
      data: { status: "DIRTY" },
    });
  }
  await prisma.pOSCheckLine.updateMany({
    where: { checkId: check.id, status: { in: ["DRAFT", "SENT", "FIRED", "PREPARING", "READY"] } },
    data: { status: "SERVED", servedAt: now },
  });
  await prisma.pOSCheckEvent.create({
    data: {
      clubId: check.clubId, checkId: check.id, type: "SETTLED",
      payloadJson: JSON.stringify({
        posSaleId: completed.id, paymentMethod: d.paymentMethod,
        grandTotal: Number(completed.grandTotal.toString()),
      }),
      byUserId: principal.id,
    },
  });
  await audit(principal, {
    action: "pos.check.settle", entityType: "POSCheck", entityId: check.id,
    clubId: check.clubId,
    after: { posSaleId: completed.id, paymentMethod: d.paymentMethod },
  });

  // Fire-and-forget receipt email (not awaited beyond its single DB
  // write; errors don't roll back settlement — they're persisted to
  // POSCheck.receiptEmailStatus for the UI to surface).
  try {
    const { sendAndRecordReceiptEmail } = await import("./receipts");
    await sendAndRecordReceiptEmail({
      checkId: check.id,
      saleId: completed.id,
      origin: d.origin ?? "http://localhost:3000",
    });
  } catch (err) {
    console.error(`[settleCheck] receipt email failed for sale ${completed.id}:`, err);
  }

  // Reservation link (Phase 18C) — if this check was opened from a
  // reservation, surface the final sale id so dining analytics can roll
  // spend back to the visit. Step 30 — also auto-departs a still-SEATED
  // linked reservation when this was the last open check on the table.
  // Idempotent + tolerant of missing links.
  try {
    const { recordCheckSettlement } = await import("../hospitality/reservations");
    await recordCheckSettlement({ posCheckId: check.id, posSaleId: completed.id, principal });
  } catch { /* analytics-only — never block settlement */ }

  return { check: await prisma.pOSCheck.findUnique({ where: { id: check.id } }), sale: completed };
}

// ---------------------------------------------------------------------------
// Helpers used by settleCheck + the QR-pay confirm flow.
// ---------------------------------------------------------------------------

export type PricedForSnapshot = {
  modifiers: Array<{
    modifierType: string;
    label: string;
    printLabel: string | null;
    priceDelta: number;
    sortOrder: number;
  }>;
};

// Snapshot the modifier set onto POSSaleLineModifier rows so the
// receipt + member dining detail page render exactly what was ordered
// even if the master modifier catalog later changes. Order-aligned —
// `priced[idx]` maps to the saleLine inserted at index idx.
//
// Exported so settleCheckBySeats reuses the same code path the legacy
// settleCheck uses. No second snapshotter.
export async function snapshotSaleLineModifiers(
  clubId: string,
  saleId: string,
  priced: PricedForSnapshot[]
) {
  const linesWithMods = priced.filter((p) => p.modifiers.length > 0);
  if (linesWithMods.length === 0) return;
  const saleLines = await prisma.pOSSaleLine.findMany({
    where: { saleId },
    orderBy: { id: "asc" },
    select: { id: true },
  });
  if (saleLines.length !== priced.length) return;
  // Idempotent — wipe any prior snapshot for this sale before re-inserting.
  await prisma.pOSSaleLineModifier.deleteMany({
    where: { saleLine: { saleId } },
  });
  const inserts = priced.flatMap((p, idx) =>
    p.modifiers.map((m, midx) => ({
      clubId,
      saleLineId: saleLines[idx].id,
      modifierType: m.modifierType,
      label: m.label,
      printLabel: m.printLabel,
      priceDelta: m.priceDelta,
      sortOrder: m.sortOrder ?? midx,
    }))
  );
  if (inserts.length > 0) {
    await prisma.pOSSaleLineModifier.createMany({ data: inserts });
  }
}

async function snapshotSignatureChit(opts: { clubId: string; saleId: string; origin?: string }) {
  try {
    const { buildChitData, renderChitPDF } = await import("./chit");
    const data = await buildChitData(opts.saleId, "SIGNATURE", { origin: opts.origin });
    const pdf = await renderChitPDF(data);
    await prisma.pOSSaleChit.upsert({
      where: { saleId_type: { saleId: opts.saleId, type: "SIGNATURE" } },
      create: {
        clubId: opts.clubId,
        saleId: opts.saleId,
        type: "SIGNATURE",
        pdfBytes: pdf,
        byteSize: pdf.length,
      },
      update: { pdfBytes: pdf, byteSize: pdf.length },
    });
  } catch (err) {
    console.error(`[snapshotSignatureChit] failed for sale ${opts.saleId}:`, err);
  }
}

// ---------------------------------------------------------------------------
// QR Pay lifecycle.
//
// Three operator-visible outcomes once a check has reached the
// PAYMENT_PENDING state:
//   • confirmQRPayment — gateway reported success → post AR/GL +
//     snapshot chit + email receipt + close check
//   • declineQRPayment — gateway declined → mark payment failed +
//     leave check in PAYMENT_FAILED (still on the active list)
//   • expireQRPayment — QR window elapsed without confirmation →
//     same as decline with reason="expired"
//
// The simulator on the public QR landing (`/pos/pay/[saleId]`) drives
// all three for dev/testing; a production gateway webhook would call
// confirm/decline based on its signed callback.
// ---------------------------------------------------------------------------

export async function confirmQRPayment(
  principal: Principal,
  saleId: string,
  opts: { origin?: string; gatewayReference?: string | null } = {}
) {
  const sale = await prisma.pOSSale.findUnique({
    where: { id: saleId },
    include: { fromCheck: true, payments: true },
  });
  if (!sale) throw new NotFoundError("POSSale", saleId);
  assertTenantOwned(sale, principal);
  requirePermission(principal, sale.clubId, "inventory:write");
  if (sale.chargeMode !== "QR_PAY") {
    throw new ConflictError("Sale is not a QR Pay sale");
  }
  if (sale.status === "COMPLETED") {
    // Idempotent — already confirmed.
    return { check: sale.fromCheck, sale };
  }
  if (sale.status === "VOIDED" || sale.status === "REFUNDED") {
    throw new ConflictError(`Cannot confirm a ${sale.status.toLowerCase()} sale`);
  }
  const check = sale.fromCheck;
  if (!check) throw new ConflictError("Sale has no linked check");
  if (check.status !== "PAYMENT_PENDING" && check.status !== "PAYMENT_FAILED") {
    throw new ConflictError(`Check is in ${check.status} state; cannot confirm payment`);
  }

  // 1) Post AR + GL via the existing engine.
  const completed = await completeSale(principal, sale.id);

  // 2) Flip the payment row to CONFIRMED.
  await prisma.pOSPayment.updateMany({
    where: { saleId: completed.id },
    data: {
      status: "CAPTURED",
      externalPaymentStatus: "CONFIRMED",
      confirmedAt: new Date(),
      externalReference: opts.gatewayReference ?? null,
    },
  });

  // 3) Snapshot the chit PDF for the audit trail.
  await snapshotSignatureChit({ clubId: sale.clubId, saleId: completed.id, origin: opts.origin });

  // 4) Close the check.
  const now = new Date();
  await prisma.pOSCheck.update({
    where: { id: check.id },
    data: {
      status: "CLOSED",
      settledAt: check.settledAt ?? now,
      closedAt: now,
      settlementMethod: "QR_PAY",
      posSaleId: completed.id,
    },
  });
  // Step 13 — same SEATED → DIRTY flip on QR-pay confirm. Mirrors the
  // member-account close above.
  if (check.tableId) {
    await prisma.diningTable.updateMany({
      where: { id: check.tableId, clubId: check.clubId, status: "SEATED" },
      data: { status: "DIRTY" },
    });
  }
  await prisma.pOSCheckLine.updateMany({
    where: { checkId: check.id, status: { in: ["DRAFT", "SENT", "FIRED", "PREPARING", "READY"] } },
    data: { status: "SERVED", servedAt: now },
  });
  await prisma.pOSCheckEvent.create({
    data: {
      clubId: sale.clubId, checkId: check.id, type: "QR_PAYMENT_CONFIRMED",
      payloadJson: JSON.stringify({
        saleId: completed.id, gatewayReference: opts.gatewayReference ?? null,
      }),
      byUserId: principal.id,
    },
  });
  await audit(principal, {
    action: "pos.check.qr.confirm", entityType: "POSCheck", entityId: check.id,
    clubId: sale.clubId,
    after: { posSaleId: completed.id },
  });

  // 5) Send receipt email (status persisted; failures don't roll back).
  try {
    const { sendAndRecordReceiptEmail } = await import("./receipts");
    await sendAndRecordReceiptEmail({
      checkId: check.id,
      saleId: completed.id,
      origin: opts.origin ?? "http://localhost:3000",
    });
  } catch (err) {
    console.error(`[confirmQRPayment] receipt email failed for sale ${completed.id}:`, err);
  }

  // 6) Update reservation linkage + auto-depart if this was the last
  //    open check on the table (step 30).
  try {
    const { recordCheckSettlement } = await import("../hospitality/reservations");
    await recordCheckSettlement({ posCheckId: check.id, posSaleId: completed.id, principal });
  } catch { /* analytics-only */ }

  return {
    check: await prisma.pOSCheck.findUnique({ where: { id: check.id } }),
    sale: completed,
  };
}

// Mark a pending QR payment as DECLINED. Leaves the check in
// PAYMENT_FAILED so the server can retry or pick another method.
export async function declineQRPayment(
  principal: Principal,
  saleId: string,
  reason: string
) {
  return failQRPayment(principal, saleId, "DECLINED", reason);
}

// Mark a pending QR payment as EXPIRED (QR window elapsed without
// confirmation). Same outcome as decline — check returns to active
// list as PAYMENT_FAILED.
export async function expireQRPayment(principal: Principal, saleId: string) {
  return failQRPayment(principal, saleId, "EXPIRED", "QR payment window expired");
}

async function failQRPayment(
  principal: Principal,
  saleId: string,
  externalStatus: "DECLINED" | "EXPIRED",
  reason: string
) {
  const sale = await prisma.pOSSale.findUnique({
    where: { id: saleId },
    include: { fromCheck: true },
  });
  if (!sale) throw new NotFoundError("POSSale", saleId);
  assertTenantOwned(sale, principal);
  requirePermission(principal, sale.clubId, "inventory:write");
  if (sale.chargeMode !== "QR_PAY") {
    throw new ConflictError("Sale is not a QR Pay sale");
  }
  if (sale.status === "COMPLETED") {
    throw new ConflictError("Sale is already confirmed");
  }
  const check = sale.fromCheck;
  if (!check) throw new ConflictError("Sale has no linked check");

  const now = new Date();
  await prisma.pOSPayment.updateMany({
    where: { saleId: sale.id },
    data: {
      status: "VOIDED",
      externalPaymentStatus: externalStatus,
      failedAt: now,
      failureReason: reason,
    },
  });
  await prisma.pOSCheck.update({
    where: { id: check.id },
    data: { status: "PAYMENT_FAILED" },
  });
  await prisma.pOSCheckEvent.create({
    data: {
      clubId: sale.clubId, checkId: check.id, type: "QR_PAYMENT_FAILED",
      payloadJson: JSON.stringify({ saleId: sale.id, externalStatus, reason }),
      byUserId: principal.id,
    },
  });
  await audit(principal, {
    action: "pos.check.qr.fail", entityType: "POSCheck", entityId: check.id,
    clubId: sale.clubId,
    after: { externalStatus, reason },
  });
  return { check: await prisma.pOSCheck.findUnique({ where: { id: check.id } }) };
}

// Used by the public landing page's "Mark paid" / simulate buttons,
// which don't run with the operator's session. Resolves the
// originally-created-by user from the sale and builds a Principal
// from their memberships so the AR/GL post is attributed correctly.
export async function principalForSaleConfirmation(saleId: string): Promise<Principal | null> {
  const sale = await prisma.pOSSale.findUnique({
    where: { id: saleId },
    select: { createdByUserId: true, clubId: true },
  });
  if (!sale?.createdByUserId) return null;
  const { loadPrincipal } = await import("../rbac");
  const p = await loadPrincipal(sale.createdByUserId, sale.clubId);
  return p;
}

// ---------------------------------------------------------------------------
// Void an OPEN check (before settlement). All lines become VOIDED.
// Already-settled checks can't be voided — refund the linked POSSale.
// ---------------------------------------------------------------------------
export async function voidCheck(principal: Principal, checkId: string, reason: string) {
  const trimmed = reason.trim();
  if (trimmed.length < 3) {
    throw new ValidationError([{ path: "reason", message: "Void reason is required (min 3 chars)" }]);
  }
  const check = await prisma.pOSCheck.findUnique({ where: { id: checkId } });
  if (!check) throw new NotFoundError("POSCheck", checkId);
  assertTenantOwned(check, principal);
  requirePermission(principal, check.clubId, "inventory:write");
  if (check.status === "CLOSED") {
    throw new ConflictError("Cannot void a settled check — refund the linked sale instead");
  }
  if (check.status === "VOIDED") {
    throw new ConflictError("Check is already voided");
  }
  await prisma.pOSCheck.update({
    where: { id: check.id },
    data: {
      status: "VOIDED", voidedAt: new Date(), voidedByUserId: principal.id, voidedReason: trimmed,
    },
  });
  await prisma.pOSCheckLine.updateMany({
    where: { checkId: check.id, status: { notIn: ["VOIDED", "COMPED"] } },
    data: { status: "VOIDED", voidedAt: new Date(), voidedByUserId: principal.id, voidedReason: trimmed },
  });
  // Cancel any active OR held chits on the check so they disappear from
  // the kitchen / bar prep displays AND the "Up next" strip. Already-
  // READY chits stay marked READY (the item was made before the void)
  // — only in-progress tickets get pulled.
  await prisma.pOSChit.updateMany({
    where: { checkId: check.id, status: { in: ["HELD", "QUEUED", "PRINTED", "ACKNOWLEDGED"] } },
    data: { status: "CANCELLED", cancelledAt: new Date(), cancelledByUserId: principal.id, cancelledReason: trimmed },
  });
  await prisma.pOSCheckEvent.create({
    data: {
      clubId: check.clubId, checkId: check.id, type: "VOIDED",
      payloadJson: JSON.stringify({ reason: trimmed }),
      byUserId: principal.id,
    },
  });
}

// ---------------------------------------------------------------------------
// Update chit-level fields without sending or settling.
// ---------------------------------------------------------------------------
export async function setCheckDiningMode(principal: Principal, checkId: string, mode: "STAY" | "TO_GO") {
  const check = await prisma.pOSCheck.findUnique({ where: { id: checkId } });
  if (!check) throw new NotFoundError("POSCheck", checkId);
  assertTenantOwned(check, principal);
  requirePermission(principal, check.clubId, "inventory:write");
  await prisma.pOSCheck.update({ where: { id: check.id }, data: { diningMode: mode } });
  await prisma.pOSCheckEvent.create({
    data: {
      clubId: check.clubId, checkId: check.id, type: "DINING_MODE_CHANGED",
      payloadJson: JSON.stringify({ from: check.diningMode, to: mode }),
      byUserId: principal.id,
    },
  });
}

export async function setCheckDiscount(principal: Principal, checkId: string, pct: number) {
  if (pct < 0 || pct > 100) throw new ValidationError([{ path: "pct", message: "0–100 only" }]);
  const check = await prisma.pOSCheck.findUnique({ where: { id: checkId } });
  if (!check) throw new NotFoundError("POSCheck", checkId);
  assertTenantOwned(check, principal);
  requirePermission(principal, check.clubId, "inventory:write");
  await prisma.pOSCheck.update({ where: { id: check.id }, data: { chitDiscountPct: pct } });
  await prisma.pOSCheckEvent.create({
    data: {
      clubId: check.clubId, checkId: check.id, type: "DISCOUNT_CHANGED",
      payloadJson: JSON.stringify({ from: Number(check.chitDiscountPct.toString()), to: pct }),
      byUserId: principal.id,
    },
  });
}

// ---------------------------------------------------------------------------
// Kitchen / Bar prep-station views.
// ---------------------------------------------------------------------------
export async function listChitsForStation(principal: Principal, clubId: string, station: PrepStation, opts: { includeReady?: boolean; limit?: number } = {}) {
  requirePermission(principal, clubId, "inventory:read");
  const statuses = opts.includeReady
    ? ["QUEUED", "PRINTED", "ACKNOWLEDGED", "READY"]
    : ["QUEUED", "PRINTED", "ACKNOWLEDGED"];
  return prisma.pOSChit.findMany({
    where: {
      ...tenantWhere(principal, clubId),
      station,
      status: { in: statuses },
    },
    include: {
      lines: {
        include: {
          // Modifiers are stored on the underlying check line; the
          // kitchen view surfaces them under each chit-line so the
          // prep crew sees "no onions / add bacon" without flipping
          // back to the POS screen.
          checkLine: {
            select: {
              hasAllergy: true,
              modifiers: {
                orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
                select: {
                  id: true,
                  modifierType: true,
                  label: true,
                  printLabel: true,
                  priceDelta: true,
                },
              },
            },
          },
        },
      },
      check: {
        include: {
          member: { select: { firstName: true, lastName: true, memberNumber: true } },
        },
      },
    },
    orderBy: [{ firedAt: "asc" }, { sentAt: "asc" }],
    take: opts.limit ?? 50,
  });
}

// HELD chits for the "Up next" strip on the kitchen / bar page. Returns
// them in the order they will fire — fireAt first (auto-pace), then
// course / sentAt for manual-fire chits.
export async function listHeldChitsForStation(principal: Principal, clubId: string, station: PrepStation, opts: { limit?: number } = {}) {
  requirePermission(principal, clubId, "inventory:read");
  return prisma.pOSChit.findMany({
    where: {
      ...tenantWhere(principal, clubId),
      station,
      status: "HELD",
    },
    include: {
      lines: {
        include: {
          // Modifiers are stored on the underlying check line; the
          // kitchen view surfaces them under each chit-line so the
          // prep crew sees "no onions / add bacon" without flipping
          // back to the POS screen.
          checkLine: {
            select: {
              hasAllergy: true,
              modifiers: {
                orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
                select: {
                  id: true,
                  modifierType: true,
                  label: true,
                  printLabel: true,
                  priceDelta: true,
                },
              },
            },
          },
        },
      },
      check: {
        include: {
          member: { select: { firstName: true, lastName: true, memberNumber: true } },
        },
      },
    },
    orderBy: [{ course: "asc" }, { fireAt: "asc" }, { sentAt: "asc" }],
    take: opts.limit ?? 50,
  });
}

export async function acknowledgeChit(principal: Principal, chitId: string) {
  const chit = await prisma.pOSChit.findUnique({ where: { id: chitId } });
  if (!chit) throw new NotFoundError("POSChit", chitId);
  assertTenantOwned(chit, principal);
  requirePermission(principal, chit.clubId, "inventory:write");
  if (chit.status === "HELD") {
    throw new ConflictError("Chit is held — fire its course before acknowledging");
  }
  if (chit.status === "ACKNOWLEDGED" || chit.status === "READY" || chit.status === "CANCELLED") return;
  await prisma.pOSChit.update({
    where: { id: chit.id },
    data: { status: "ACKNOWLEDGED", acknowledgedAt: new Date(), acknowledgedByUserId: principal.id },
  });
  await prisma.pOSCheckEvent.create({
    data: {
      clubId: chit.clubId, checkId: chit.checkId, type: "CHIT_ACKNOWLEDGED",
      payloadJson: JSON.stringify({ chitId: chit.id }),
      byUserId: principal.id,
    },
  });
}

export async function markChitReady(principal: Principal, chitId: string) {
  const chit = await prisma.pOSChit.findUnique({
    where: { id: chitId },
    include: { lines: true },
  });
  if (!chit) throw new NotFoundError("POSChit", chitId);
  assertTenantOwned(chit, principal);
  requirePermission(principal, chit.clubId, "inventory:write");
  if (chit.status === "HELD") {
    throw new ConflictError("Chit is held — fire its course before marking ready");
  }
  if (chit.status === "READY" || chit.status === "CANCELLED") return;
  await prisma.pOSChit.update({
    where: { id: chit.id },
    data: { status: "READY", readyAt: new Date(), readyByUserId: principal.id },
  });
  // Cascade to the underlying check lines so the server-side check
  // view knows what's ready.
  const lineIds = chit.lines.map((l) => l.checkLineId);
  if (lineIds.length > 0) {
    await prisma.pOSCheckLine.updateMany({
      where: { id: { in: lineIds }, status: { in: ["SENT", "FIRED", "PREPARING"] } },
      data: { status: "READY", readyAt: new Date() },
    });
  }
  await prisma.pOSCheckEvent.create({
    data: {
      clubId: chit.clubId, checkId: chit.checkId, type: "CHIT_READY",
      payloadJson: JSON.stringify({ chitId: chit.id }),
      byUserId: principal.id,
    },
  });
}

// ---------------------------------------------------------------------------
// READY → SERVED transition.
//
// Servers / expo / kitchen staff confirm that a ready item has been
// delivered to the table. SERVED items are immutable from the cart
// (no edits, no voids without manager); they stay visible in the
// timeline + history.
// ---------------------------------------------------------------------------
export async function markCheckLineServed(principal: Principal, checkLineId: string) {
  const line = await prisma.pOSCheckLine.findUnique({
    where: { id: checkLineId },
    include: { chitLines: { select: { id: true, chitId: true } } },
  });
  if (!line) throw new NotFoundError("POSCheckLine", checkLineId);
  assertTenantOwned(line, principal);
  requirePermission(principal, line.clubId, "inventory:write");
  if (line.status !== "READY") {
    throw new ConflictError(
      `Only READY items can be marked SERVED (this line is ${line.status})`
    );
  }
  const now = new Date();
  const chitIds = Array.from(new Set(line.chitLines.map((cl) => cl.chitId)));
  await prisma.$transaction(async (tx) => {
    await tx.pOSCheckLine.update({
      where: { id: line.id },
      data: { status: "SERVED", servedAt: now, servedByUserId: principal.id },
    });
    // Mirror onto every chit line for this check line so the kitchen /
    // bar view can render a "Served" badge from chit data alone.
    if (line.chitLines.length > 0) {
      await tx.pOSChitLine.updateMany({
        where: { id: { in: line.chitLines.map((c) => c.id) } },
        data: { servedAt: now, servedByUserId: principal.id },
      });
    }
    await tx.pOSCheckEvent.create({
      data: {
        clubId: line.clubId, checkId: line.checkId, type: "ITEM_SERVED",
        payloadJson: JSON.stringify({ checkLineId: line.id }),
        byUserId: principal.id,
      },
    });
  });

  // For each chit this line participated in, promote the chit to
  // SERVED once every one of its underlying check lines has been
  // marked served. Otherwise the open-checks queue badge would stay
  // at "Ready for pickup" even though the row was delivered.
  for (const chitId of chitIds) {
    const remaining = await prisma.pOSChitLine.count({
      where: {
        chitId,
        checkLine: { status: { in: ["READY", "FIRED", "PREPARING", "SENT"] } },
      },
    });
    if (remaining === 0) {
      await prisma.pOSChit.updateMany({
        where: { id: chitId, status: "READY" },
        data: { status: "SERVED" },
      });
    }
  }
}

// Convenience verb for the station view: mark every line on a chit
// as served in one tap. The chit itself transitions READY → SERVED
// so the open-checks queue can show "Delivered" instead of being
// stuck on "Ready for pickup".
export async function markChitServed(principal: Principal, chitId: string) {
  const chit = await prisma.pOSChit.findUnique({
    where: { id: chitId },
    include: {
      lines: { include: { checkLine: { select: { id: true, status: true } } } },
    },
  });
  if (!chit) throw new NotFoundError("POSChit", chitId);
  assertTenantOwned(chit, principal);
  requirePermission(principal, chit.clubId, "inventory:write");
  if (chit.status !== "READY") {
    throw new ConflictError(
      `Only READY chits can be marked served (this chit is ${chit.status})`
    );
  }
  const checkLineIds = chit.lines
    .map((l) => l.checkLine?.id)
    .filter((id): id is string => !!id);
  const now = new Date();
  await prisma.$transaction(async (tx) => {
    if (checkLineIds.length > 0) {
      await tx.pOSCheckLine.updateMany({
        where: { id: { in: checkLineIds }, status: "READY" },
        data: { status: "SERVED", servedAt: now, servedByUserId: principal.id },
      });
    }
    await tx.pOSChitLine.updateMany({
      where: { chitId: chit.id },
      data: { servedAt: now, servedByUserId: principal.id },
    });
    // Flip the chit itself so the open-checks queue badge moves off
    // "Ready for pickup".
    await tx.pOSChit.update({
      where: { id: chit.id },
      data: { status: "SERVED" },
    });
    await tx.pOSCheckEvent.create({
      data: {
        clubId: chit.clubId, checkId: chit.checkId, type: "CHIT_SERVED",
        payloadJson: JSON.stringify({ chitId: chit.id, lines: checkLineIds.length }),
        byUserId: principal.id,
      },
    });
  });
}

// ---------------------------------------------------------------------------
// Closed-check history.
//
// Lists checks that have been CLOSED (settled) or VOIDED — these are
// no longer in active service but the server still needs to find a
// receipt or confirm the payment status.
// ---------------------------------------------------------------------------
export async function listClosedChecks(
  principal: Principal,
  clubId: string,
  opts: {
    from?: Date;
    to?: Date;
    settlementMethod?: "MEMBER_ACCOUNT" | "QR_PAY";
    search?: string;
    limit?: number;
  } = {}
) {
  requirePermission(principal, clubId, "inventory:read");
  const limit = Math.min(opts.limit ?? 100, 500);
  return prisma.pOSCheck.findMany({
    where: {
      ...tenantWhere(principal, clubId),
      status: { in: ["CLOSED", "VOIDED"] },
      ...(opts.from || opts.to
        ? {
            closedAt: {
              gte: opts.from,
              lt: opts.to,
            },
          }
        : {}),
      ...(opts.settlementMethod ? { settlementMethod: opts.settlementMethod } : {}),
      ...(opts.search
        ? {
            OR: [
              { checkNumber: { contains: opts.search } },
              { member: { firstName: { contains: opts.search } } },
              { member: { lastName: { contains: opts.search } } },
            ],
          }
        : {}),
    },
    include: {
      member: { select: { firstName: true, lastName: true, memberNumber: true } },
      posSale: { select: { id: true, saleNumber: true, grandTotal: true, chargeMode: true } },
      // Per-group settle context for split-bill checks. The history
      // page surfaces each group's payer + total + receipt-email
      // status below the parent check row when there is more than
      // one group. Single-group merge-all settles also have one row
      // here but the UI suppresses the breakdown (POSCheck row carries
      // the canonical status).
      settlementGroups: {
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          label: true,
          status: true,
          settlementMethod: true,
          posSaleId: true,
          grandTotal: true,
          receiptEmailStatus: true,
          receiptEmailAddress: true,
          receiptEmailFailure: true,
          // email is included so the per-group Resend button can
          // render with a "no email on file" disabled state without
          // having to round-trip the action.
          member: { select: { firstName: true, lastName: true, memberNumber: true, email: true } },
        },
      },
    },
    orderBy: { closedAt: "desc" },
    take: limit,
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// Compute live totals from a check (no DB writes). The UI reads this
// to render the running cart. Modifiers (no onions / add bacon / sub
// fries→salad) contribute a per-unit priceDelta that gets multiplied
// by line quantity and folded into the line's raw subtotal — so GST
// and discounts both compute on the modified price the same way as
// they do on the base price.
export function priceCheckLines(lines: Array<{
  status: string;
  quantity: unknown;
  unitPrice: unknown;
  discountPct: unknown;
  taxable: boolean;
  modifiers?: ReadonlyArray<{ priceDelta: unknown }>;
}>, chitDiscountPct: number) {
  const chitPct = Math.max(0, Math.min(100, chitDiscountPct));
  const chitOverrides = chitPct > 0;
  let subtotal = 0;
  let compTotal = 0;
  let chitAppliedTotal = 0;
  let regularLineTotal = 0;
  let taxableNet = 0;
  let modifierTotal = 0;
  for (const l of lines) {
    if (l.status === "VOIDED") continue;
    const quantity = Number(String(l.quantity));
    const unitPrice = Number(String(l.unitPrice));
    const linePct = Number(String(l.discountPct));
    // Per-unit modifier delta — sum across REMOVE/ADD/SUBSTITUTE.
    // ALLERGY and NOTE are display-only (priceDelta = 0).
    const modDeltaPerUnit = (l.modifiers ?? []).reduce(
      (s, m) => s + Number(String(m.priceDelta)),
      0
    );
    const modLineTotal = round2(quantity * modDeltaPerUnit);
    const raw = round2(quantity * unitPrice + modLineTotal);
    const isComp = l.status === "COMPED" || linePct >= 100;
    const effectivePct = isComp ? 100 : chitOverrides ? chitPct : linePct;
    const lineDisc = round2(raw * (effectivePct / 100));
    const net = round2(raw - lineDisc);
    subtotal = round2(subtotal + raw);
    modifierTotal = round2(modifierTotal + modLineTotal);
    if (isComp) compTotal = round2(compTotal + lineDisc);
    else if (chitOverrides) chitAppliedTotal = round2(chitAppliedTotal + lineDisc);
    else if (lineDisc > 0) regularLineTotal = round2(regularLineTotal + lineDisc);
    if (l.taxable) taxableNet = round2(taxableNet + net);
  }
  const totalDiscount = round2(compTotal + chitAppliedTotal + regularLineTotal);
  const taxTotal = round2(taxableNet * GST_RATE);
  const grandTotal = round2(subtotal + taxTotal - totalDiscount);
  return { subtotal, compTotal, chitAppliedTotal, regularLineTotal, modifierTotal, taxTotal, grandTotal, chitOverrides };
}
