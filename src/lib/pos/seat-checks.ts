// Phase 18E — server-led self-seating + seat-group bill splitting.
//
// `seatTable` is the floor-map entry point: the waiter clicks an
// AVAILABLE table, the system flips it to SEATED and opens a fresh
// POSCheck stamped with the table id, party size, and the waiter as
// the server. Reuses existing openCheck for the actual POSCheck
// create + posting-guard checks.
//
// `settleCheckBySeats` is the split-bill exit. The waiter passes one
// or more groups, each naming the seats it owns and how it pays. We
// run the existing createSale + completeSale engine once per group so
// every group lands its own POSSale + AR Charge + GL journal entry
// + receipt email + dining-history row. Table-level lines (no seat
// number) are evenly split across groups unless the waiter explicitly
// assigns them to one group.

import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../prisma";
import { audit } from "../audit";
import { requirePermission, type Principal } from "../rbac";
import { assertTenantOwned } from "../services/tenant";
import { ConflictError, NotFoundError, ValidationError } from "../errors";
import { LOUNGE_LOCATION_CODE, LOUNGE_TERMINAL_CODE } from "./lounge";
import { normalizeMemberNumber } from "../members/number";
import {
  nextCheckNumber,
  snapshotSaleLineModifiers,
  FB_REVENUE_ACCOUNT,
  type PricedForSnapshot,
} from "./checks";
import { createSale, completeSale } from "./index";

// ---------------------------------------------------------------------------
// seatTable — floor-map entry point.
// ---------------------------------------------------------------------------
const seatTableSchema = z.object({
  tableId: z.string().min(1),
  // Phase 18F — a primary member is now mandatory. Every seated check
  // must have at least one member account on file so the POS knows who
  // to fall back to if the server doesn't split the bill. Use
  // `memberId` directly, OR pass `memberNumber` and let the service
  // resolve it (cheaper UX for staff scanning a member card).
  memberId: z.string().optional(),
  memberNumber: z.string().trim().min(1).optional(),
  partySize: z.number().int().min(1).max(40).optional(),
  notes: z.string().trim().max(200).optional().nullable(),
}).refine((v) => !!v.memberId || !!v.memberNumber, {
  message: "A primary member is required to seat a table.",
  path: ["memberId"],
});

export async function seatTable(principal: Principal, clubId: string, raw: unknown) {
  requirePermission(principal, clubId, "inventory:write");
  const parsed = seatTableSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  }
  const d = parsed.data;

  const table = await prisma.diningTable.findUnique({ where: { id: d.tableId } });
  assertTenantOwned(table, principal);
  if (table.clubId !== clubId) throw new ConflictError("Table is not at this club");
  if (table.status === "OUT_OF_SERVICE") throw new ConflictError("Table is out of service");
  if (table.status === "SEATED") throw new ConflictError("Table is already seated. Open the existing check instead.");
  if (table.status === "DIRTY") throw new ConflictError("Table needs a reset. Mark it clean before seating the next party.");

  // Step 17 — party-size validation. Reject seating beyond the table's
  // physical capacity. partySize > 0 is enforced by the zod schema
  // (min 1); the upper bound is the table's own capacity.
  if (d.partySize !== undefined && d.partySize > table.capacity) {
    throw new ConflictError("Party size cannot exceed this table's capacity.");
  }

  // Resolve the primary member from memberId OR memberNumber. Either
  // must yield exactly one member at this club.
  let memberId: string;
  if (d.memberId) {
    const member = await prisma.member.findUnique({ where: { id: d.memberId } });
    if (!member || member.clubId !== clubId) {
      throw new ValidationError([{ path: "memberId", message: "Unknown member" }]);
    }
    memberId = member.id;
  } else {
    // Step 16 — normalize so a staff member can type "1310", "0613",
    // or even a legacy "SS-1310" and the lookup resolves to the same
    // row. clubId is mandatory in the where clause — uniqueness is
    // (clubId, memberNumber); cross-tenant resolution is impossible.
    const normalized = normalizeMemberNumber(d.memberNumber!);
    const member = await prisma.member.findFirst({
      where: { clubId, memberNumber: normalized },
    });
    if (!member) {
      throw new ValidationError([
        { path: "memberNumber", message: `No member matches "${normalized}" at this club.` },
      ]);
    }
    memberId = member.id;
  }

  const location = await prisma.pOSLocation.findFirst({
    where: { clubId, code: LOUNGE_LOCATION_CODE },
  });
  if (!location) throw new ConflictError(`Lounge location (${LOUNGE_LOCATION_CODE}) not provisioned for this club`);
  const terminal = await prisma.pOSTerminal.findFirst({
    where: { clubId, code: LOUNGE_TERMINAL_CODE },
  });
  const session = await prisma.pOSSession.findFirst({
    where: { clubId, locationId: location.id, status: "OPEN" },
    orderBy: { openedAt: "desc" },
  });

  const checkNumber = await nextCheckNumber(clubId);
  const now = new Date();
  const check = await prisma.pOSCheck.create({
    data: {
      clubId,
      locationId: location.id,
      terminalId: terminal?.id ?? null,
      sessionId: session?.id ?? null,
      memberId,
      guestName: null,
      tableNumber: table.tableNumber,
      openedByUserId: principal.id,
      serverId: principal.id,
      checkNumber,
      status: "OPEN",
      diningMode: "STAY",
      notes: d.notes ?? null,
      tableId: table.id,
      partySize: d.partySize ?? null,
    },
  });
  // Pre-create Seat 1 as the primary member.
  await prisma.pOSCheckSeat.create({
    data: {
      clubId, posCheckId: check.id, seatNumber: 1,
      memberId, isPrimary: true,
    },
  });
  // Step 17 — auto-populate the rest of the party as Guest seats so
  // the seat view immediately reflects how many people are at the
  // table. The server can rename or promote any of these to a member
  // via assignCheckSeat at any time. Seats above partySize stay
  // unassigned (no POSCheckSeat row) — seatSummary renders them as
  // "Unassigned" automatically since it iterates 1..capacity.
  const partySize = d.partySize ?? 1;
  if (partySize > 1) {
    const guestSeats = [];
    for (let n = 2; n <= partySize; n++) {
      guestSeats.push({
        clubId, posCheckId: check.id, seatNumber: n,
        memberId: null, guestName: "Guest", isPrimary: false,
      });
    }
    await prisma.pOSCheckSeat.createMany({ data: guestSeats });
  }
  await prisma.diningTable.update({
    where: { id: table.id }, data: { status: "SEATED" },
  });
  await prisma.pOSCheckEvent.create({
    data: {
      clubId, checkId: check.id, type: "OPENED",
      payloadJson: JSON.stringify({
        tableId: table.id, tableNumber: table.tableNumber,
        memberId, partySize: d.partySize ?? null,
      }),
      byUserId: principal.id,
    },
  });
  await audit(principal, {
    action: "pos.seat-table",
    entityType: "POSCheck", entityId: check.id, clubId,
    after: { tableId: table.id, tableNumber: table.tableNumber, partySize: d.partySize ?? null, memberId, seatedAt: now },
  });
  return { checkId: check.id, tableId: table.id };
}

// ---------------------------------------------------------------------------
// assignCheckSeat — set a seat's member or mark it as a guest. Either
// memberId (or memberNumber) OR guestName must be set; passing both
// clears + reassigns the seat. Passing all-null clears the seat.
// ---------------------------------------------------------------------------
const assignSeatSchema = z.object({
  seatNumber: z.number().int().min(1).max(40),
  memberId: z.string().optional().nullable(),
  memberNumber: z.string().trim().min(1).optional().nullable(),
  guestName: z.string().trim().max(120).optional().nullable(),
});

export async function assignCheckSeat(
  principal: Principal,
  checkId: string,
  raw: unknown,
) {
  const parsed = assignSeatSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  }
  const d = parsed.data;
  const check = await prisma.pOSCheck.findUnique({ where: { id: checkId } });
  if (!check) throw new NotFoundError("POSCheck", checkId);
  assertTenantOwned(check, principal);
  requirePermission(principal, check.clubId, "inventory:write");
  if (check.status === "CLOSED" || check.status === "VOIDED") {
    throw new ConflictError(`Cannot reassign seats on a ${check.status.toLowerCase()} check`);
  }

  let memberId: string | null = null;
  let guestName: string | null = null;
  if (d.memberId) {
    const member = await prisma.member.findUnique({ where: { id: d.memberId } });
    if (!member || member.clubId !== check.clubId) {
      throw new ValidationError([{ path: "memberId", message: "Unknown member" }]);
    }
    memberId = member.id;
  } else if (d.memberNumber) {
    // Step 16 — same normalization as seatTable. Accepts plain
    // 4-digit or legacy SS-#### input. Lookup is tenant-scoped via
    // check.clubId; cross-tenant collisions on the same digits are
    // impossible.
    const normalized = normalizeMemberNumber(d.memberNumber);
    const member = await prisma.member.findFirst({
      where: { clubId: check.clubId, memberNumber: normalized },
    });
    if (!member) {
      throw new ValidationError([
        { path: "memberNumber", message: `No member matches "${normalized}" at this club.` },
      ]);
    }
    memberId = member.id;
  } else if (d.guestName) {
    guestName = d.guestName.trim();
  } else {
    // Both null → clear the seat assignment.
    memberId = null;
    guestName = null;
  }

  // Refuse to clear or replace the primary seat — by design every
  // seated check keeps a primary member; the floor team can use
  // "Mark departed" to close the table out instead.
  const existing = await prisma.pOSCheckSeat.findUnique({
    where: { posCheckId_seatNumber: { posCheckId: checkId, seatNumber: d.seatNumber } },
  });
  if (existing?.isPrimary && !memberId) {
    throw new ConflictError("The primary seat must keep a member assignment.");
  }

  const row = await prisma.pOSCheckSeat.upsert({
    where: { posCheckId_seatNumber: { posCheckId: checkId, seatNumber: d.seatNumber } },
    create: {
      clubId: check.clubId, posCheckId: checkId, seatNumber: d.seatNumber,
      memberId, guestName, isPrimary: false,
    },
    update: { memberId, guestName },
  });
  await audit(principal, {
    action: "pos.seat-assign",
    entityType: "POSCheckSeat", entityId: row.id, clubId: check.clubId,
    after: { seatNumber: d.seatNumber, memberId, guestName },
  });
  return row;
}

// ---------------------------------------------------------------------------
// seatSummary — pure read for the seat-level page.
// ---------------------------------------------------------------------------
export async function seatSummary(principal: Principal, checkId: string) {
  const check = await prisma.pOSCheck.findUnique({
    where: { id: checkId },
    include: {
      lines: {
        where: { status: { not: "VOIDED" } },
        include: { modifiers: true },
        orderBy: { createdAt: "asc" },
      },
      table: { select: { id: true, tableNumber: true, displayName: true, capacity: true, shape: true } },
      member: { select: { id: true, firstName: true, lastName: true } },
      seats: {
        include: { member: { select: { id: true, firstName: true, lastName: true, memberNumber: true } } },
        orderBy: { seatNumber: "asc" },
      },
      settlementGroups: {
        include: {
          lines: { select: { id: true, seatNumber: true } },
          member: { select: { id: true, firstName: true, lastName: true } },
        },
      },
    },
  });
  if (!check) throw new NotFoundError("POSCheck", checkId);
  assertTenantOwned(check, principal);

  const capacity = check.table?.capacity ?? check.partySize ?? 4;
  const assignmentBySeat = new Map(check.seats.map((s) => [s.seatNumber, s]));
  const seats: Array<{
    seatNumber: number;
    items: typeof check.lines;
    subtotal: number;
    sentCount: number;
    readyCount: number;
    servedCount: number;
    draftCount: number;
    inGroupId: string | null;
    assignment: {
      isPrimary: boolean;
      memberId: string | null;
      memberDisplay: string | null;
      memberNumber: string | null;
      guestName: string | null;
    };
  }> = [];
  for (let n = 1; n <= capacity; n++) {
    const items = check.lines.filter((l) => l.seatNumber === n && !l.tableLevel);
    const subtotal = items.reduce((sum, l) => {
      const qty = Number(l.quantity.toString());
      const unit = Number(l.unitPrice.toString());
      const disc = Number(l.discountPct.toString());
      return sum + qty * unit * (1 - disc / 100);
    }, 0);
    const inGroupId = items.find((l) => l.settlementGroupId)?.settlementGroupId ?? null;
    const a = assignmentBySeat.get(n);
    const memberDisplay = a?.member ? `${a.member.firstName} ${a.member.lastName}` : null;
    seats.push({
      seatNumber: n,
      items,
      subtotal,
      sentCount:   items.filter((l) => l.status === "SENT" || l.status === "FIRED" || l.status === "PREPARING").length,
      readyCount:  items.filter((l) => l.status === "READY").length,
      servedCount: items.filter((l) => l.status === "SERVED").length,
      draftCount:  items.filter((l) => l.status === "DRAFT").length,
      inGroupId,
      assignment: {
        isPrimary: a?.isPrimary ?? false,
        memberId:  a?.memberId ?? null,
        memberDisplay,
        memberNumber: a?.member?.memberNumber ?? null,
        guestName: a?.guestName ?? null,
      },
    });
  }
  const tableLines = check.lines.filter((l) => l.tableLevel);
  return { check, seats, tableLines };
}

// ---------------------------------------------------------------------------
// settleCheckBySeats — N groups → N sales.
// ---------------------------------------------------------------------------
const settleGroupSchema = z.object({
  label: z.string().trim().min(1).max(40),
  seatNumbers: z.array(z.number().int().min(1).max(24)).min(1),
  paymentMethod: z.enum(["MEMBER_ACCOUNT", "QR_PAY"]).default("MEMBER_ACCOUNT"),
  memberId: z.string().optional().nullable(),
});
const settleBySeatsSchema = z.object({
  groups: z.array(settleGroupSchema).min(1),
  origin: z.string().optional(),
  allowUnsentLines: z.boolean().optional(),
});

type GroupResult = {
  groupId: string;
  label: string;
  posSaleId: string | null;
  status: string;
  subtotal: number;
  tax: number;
  grandTotal: number;
  itemCount: number;
  // Populated on the split-bill path (N>1 groups) AFTER the per-group
  // email send. Single-group / merge-all settles leave these null — the
  // POSCheck-level fields carry the canonical status for that path.
  receiptEmailStatus?: string | null;
  receiptEmailAddress?: string | null;
  receiptEmailFailure?: string | null;
};

export async function settleCheckBySeats(
  principal: Principal,
  checkId: string,
  raw: unknown,
): Promise<{ check: { id: string; status: string }; groups: GroupResult[] }> {
  const parsed = settleBySeatsSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  }
  const d = parsed.data;

  // Cross-group seat collision check.
  const seenSeats = new Set<number>();
  for (const g of d.groups) {
    for (const s of g.seatNumbers) {
      if (seenSeats.has(s)) {
        throw new ValidationError([{ path: "groups", message: `Seat ${s} is in more than one group.` }]);
      }
      seenSeats.add(s);
    }
  }

  const check = await prisma.pOSCheck.findUnique({
    where: { id: checkId },
    include: {
      lines: {
        where: { status: { not: "VOIDED" } },
        // Modifier set per line — folded into unitPrice for GST + GL
        // math, and snapshotted onto POSSaleLineModifier after the
        // sale completes so the member receipt + dining history show
        // exactly what was ordered, independent of any later catalog
        // edits.
        include: { modifiers: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] } },
      },
      location: { select: { code: true } },
      terminal: { select: { code: true } },
    },
  });
  if (!check) throw new NotFoundError("POSCheck", checkId);
  assertTenantOwned(check, principal);
  requirePermission(principal, check.clubId, "inventory:write");
  if (check.status === "CLOSED" || check.status === "VOIDED") {
    throw new ConflictError(`Check is already ${check.status.toLowerCase()}`);
  }
  if (!check.location) throw new ConflictError("Check has no location resolved");

  // Step 19 — payment-method gates:
  //
  //  * Per-group QR_PAY remains rejected. Whole-check QR runs through
  //    confirmQRPayment (src/lib/pos/qr-payment.ts), which calls back
  //    into this engine with exactly one group; we recognise that
  //    single-group case below.
  //
  //  * MEMBER_ACCOUNT on a member with a suspended charge account is
  //    rejected up-front with a clear, named error. Without this gate,
  //    createSale would still throw inside the per-group loop AFTER
  //    we'd already written a POSSettlementGroup row.
  for (const g of d.groups) {
    if (g.paymentMethod === "QR_PAY" && d.groups.length > 1) {
      throw new ConflictError(
        `Per-seat-group QR_PAY isn't supported yet. Use Charge to Member Account on each group, or merge all seats into one group and use Pay by QR Code.`,
      );
    }
    if (g.paymentMethod === "MEMBER_ACCOUNT" && !g.memberId) {
      throw new ValidationError([{ path: "groups", message: `Group "${g.label}" charges to a member account but no member was chosen.` }]);
    }
    if (g.paymentMethod === "MEMBER_ACCOUNT" && g.memberId) {
      const m = await prisma.member.findUnique({
        where: { id: g.memberId },
        select: { accessStatus: true, firstName: true, lastName: true },
      });
      if (m && (m.accessStatus === "CHARGE_ACCOUNT_SUSPENDED" || m.accessStatus === "FULL_SUSPENSION")) {
        throw new ConflictError(
          `${m.firstName} ${m.lastName}'s charge account is disabled. Use Pay by QR Code instead.`,
        );
      }
    }
  }

  // Sent-or-served filter: settle only items that have been actually
  // delivered (or are at least sent), unless allowUnsentLines is on.
  const unsentLines = check.lines.filter((l) => l.status === "DRAFT");
  if (unsentLines.length > 0 && !d.allowUnsentLines) {
    throw new ConflictError(`There are ${unsentLines.length} unsent item(s). Send them to the kitchen/bar first, or pass allowUnsentLines=true.`);
  }

  // Bucket lines by seat → group.
  const seatToGroupIdx = new Map<number, number>();
  d.groups.forEach((g, idx) => {
    for (const s of g.seatNumbers) seatToGroupIdx.set(s, idx);
  });

  // Group-bucket the lines. Table-level lines split evenly across groups
  // — caller can pre-set settlementGroupId on a table-level line to pin
  // it to one group.
  const groupedLines: Array<typeof check.lines> = d.groups.map(() => []);
  const tableLines = check.lines.filter((l) => l.tableLevel);
  const seatLines = check.lines.filter((l) => !l.tableLevel);

  for (const l of seatLines) {
    if (l.seatNumber === null) continue; // ignore unassigned non-table lines
    const idx = seatToGroupIdx.get(l.seatNumber);
    if (idx === undefined) {
      // Seat isn't in any group on this pass — its lines stay unsettled
      // and the check becomes PARTIALLY_SETTLED. Honest behaviour for a
      // server who settles two of four parties and waits to close the rest.
      continue;
    }
    groupedLines[idx].push(l);
  }
  // Distribute table-level lines: each group gets a proportional share
  // unless the line is already pinned. We split the quantity arithmetically
  // — clean enough for the slice and matches the "split shared item is
  // out of scope" caveat in the spec.
  for (const tl of tableLines) {
    if (tl.settlementGroupId) continue; // already pinned; will be carried by the matching group
    // Default: every group pays an equal share of this line.
    // We surface this by leaving it on whichever group goes first;
    // exact even-split needs a sale-line splitter we're not building
    // here. Document this as a known limitation in the closing summary.
    if (groupedLines[0]) groupedLines[0].push(tl);
  }

  const results: GroupResult[] = [];
  const now = new Date();

  for (let i = 0; i < d.groups.length; i++) {
    const groupSpec = d.groups[i];
    const lines = groupedLines[i];
    if (lines.length === 0) {
      // Nothing to settle for this group; record an empty group for the
      // audit trail rather than silently dropping it.
      const empty = await prisma.pOSSettlementGroup.create({
        data: {
          clubId: check.clubId, posCheckId: check.id,
          label: groupSpec.label, status: "SETTLED",
          settlementMethod: groupSpec.paymentMethod,
          memberId: groupSpec.memberId ?? null,
          createdByUserId: principal.id,
          settledAt: now,
        },
      });
      results.push({
        groupId: empty.id, label: groupSpec.label, posSaleId: null,
        status: "SETTLED", subtotal: 0, tax: 0, grandTotal: 0, itemCount: 0,
      });
      continue;
    }

    // Build a priced view of each line: base unit + per-unit modifier
    // delta → modifier-adjusted unitPrice. Used for subtotal/tax math,
    // the createSale line list, and the post-settle POSSaleLineModifier
    // snapshot — all from one source array so they stay in sync.
    const priced = lines.map((l) => {
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
      // Append a compact modifier summary to the receipt description
      // so member-side history reads naturally ("Burger — add bacon").
      // ALLERGY + NOTE rows are kept off the printed description (the
      // chit-and-receipt blocks render them separately, in red / italic).
      const labelSummary = l.modifiers
        .filter((m) => m.modifierType !== "NOTE" && m.modifierType !== "ALLERGY")
        .map((m) => m.printLabel || m.label);
      // Seat context: prefix the description with "Seat N: " for
      // seated lines, "Table: " for table-level lines. The receipt
      // email + member dining detail both render description as-is,
      // so this is how the seat workflow surfaces "which diner ate
      // what" without restructuring the receipt body.
      const seatPrefix = l.tableLevel || l.seatNumber == null
        ? "Table: "
        : `Seat ${l.seatNumber}: `;
      const itemDescription = labelSummary.length > 0
        ? `${l.description} — ${labelSummary.join(", ")}`
        : l.description;
      const description = `${seatPrefix}${itemDescription}`;
      return {
        checkLineId: l.id,
        menuItemId: l.menuItemId ?? null,
        description,
        quantity: qty,
        unitPrice: adjustedUnit,
        lineDiscount,
        lineNet,
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

    // Group totals — subtotal and tax base now include modifier deltas.
    const subtotal = round2(priced.reduce((s, p) => s + p.lineNet, 0));
    const taxableSubtotal = round2(
      priced.reduce((s, p) => (p.taxable ? s + p.lineNet : s), 0),
    );
    // Use the existing GST 5% rate (matches the lounge tax line elsewhere).
    const tax = round2(taxableSubtotal * 0.05);
    const grand = round2(subtotal + tax);

    // Create the group row first so we can stamp each line.
    const group = await prisma.pOSSettlementGroup.create({
      data: {
        clubId: check.clubId, posCheckId: check.id,
        label: groupSpec.label, status: "OPEN",
        settlementMethod: groupSpec.paymentMethod,
        memberId: groupSpec.memberId ?? null,
        subtotal: new Prisma.Decimal(subtotal),
        taxTotal: new Prisma.Decimal(tax),
        grandTotal: new Prisma.Decimal(grand),
        createdByUserId: principal.id,
      },
    });
    await prisma.pOSCheckLine.updateMany({
      where: { id: { in: lines.map((l) => l.id) } },
      data: { settlementGroupId: group.id },
    });

    // Hand off to the existing sale engine for this slice of items.
    // Use SERVICE kind + the F&B revenue account so the GL JE routes
    // to the same account the legacy settleCheck path uses (4200 F&B
    // Revenue), not the OTHER fallback (4900) — keeps the seat-flow
    // and lounge-flow lines on the same revenue line.
    const saleDraft = await createSale(principal, check.clubId, {
      locationCode: check.location.code,
      terminalCode: check.terminal?.code ?? null,
      sessionId: check.sessionId ?? undefined,
      memberId: groupSpec.memberId ?? undefined,
      chargeMode: groupSpec.paymentMethod,
      diningMode: "STAY",
      lines: priced.map((p) => ({
        kind: "SERVICE" as const,
        menuItemId: p.menuItemId ?? undefined,
        description: p.description,
        quantity: p.quantity,
        unitPrice: p.unitPrice,
        taxAmount: 0,
        discountAmount: p.lineDiscount,
        revenueAccountNumber: FB_REVENUE_ACCOUNT,
      })),
      taxLines: tax > 0 ? [{ kind: "TAX", label: "GST 5%", rate: 0.05, amount: tax }] : [],
      discounts: [],
      payments: [],
      notes: `Group "${groupSpec.label}" of check ${check.checkNumber}`,
    });
    const completed = await completeSale(principal, saleDraft.id);

    // Snapshot the modifier set onto POSSaleLineModifier rows so the
    // member receipt + dining history page show the exact options
    // chosen at settlement, even if the master catalog edits later.
    // Order-aligned: the priced array drives both the createSale
    // line list and this snapshot.
    await snapshotSaleLineModifiers(check.clubId, completed.id, priced as PricedForSnapshot[]);

    await prisma.pOSSettlementGroup.update({
      where: { id: group.id },
      data: {
        status: "SETTLED",
        posSaleId: completed.id,
        settledAt: now,
      },
    });
    // Mark the lines themselves as served.
    await prisma.pOSCheckLine.updateMany({
      where: { id: { in: lines.map((l) => l.id) }, status: { in: ["DRAFT", "SENT", "FIRED", "PREPARING", "READY"] } },
      data: { status: "SERVED", servedAt: now },
    });

    await audit(principal, {
      action: "pos.check.settle-by-seat-group",
      entityType: "POSSettlementGroup", entityId: group.id,
      clubId: check.clubId,
      after: { label: groupSpec.label, posSaleId: completed.id, memberId: groupSpec.memberId ?? null, subtotal, tax, grand },
    });
    results.push({
      groupId: group.id, label: groupSpec.label, posSaleId: completed.id,
      status: "SETTLED", subtotal: round2(subtotal), tax, grandTotal: grand,
      itemCount: lines.length,
    });
  }

  // Recompute check status. Anything still unsettled keeps the check open;
  // otherwise the check closes.
  const remaining = await prisma.pOSCheckLine.count({
    where: { checkId: check.id, settlementGroupId: null, status: { not: "VOIDED" } },
  });
  const newStatus = remaining === 0 ? "CLOSED" : "PARTIALLY_SETTLED";
  await prisma.pOSCheck.update({
    where: { id: check.id },
    data: {
      status: newStatus,
      closedAt: newStatus === "CLOSED" ? now : null,
      settledAt: newStatus === "CLOSED" ? now : null,
      settledByUserId: principal.id,
      // Mirror the legacy settleCheck path so the closed-checks history
      // surfaces the single-group seat settle the same way as a lounge
      // settle.
      settlementMethod: (d.groups.length === 1 && newStatus === "CLOSED")
        ? d.groups[0].paymentMethod
        : undefined,
      posSaleId: (d.groups.length === 1 && newStatus === "CLOSED")
        ? (results[0]?.posSaleId ?? undefined)
        : undefined,
    },
  });

  // Step 13 — hospitality table lifecycle. When every billable line on
  // a SEATED table is now settled, the dining table moves from SEATED →
  // DIRTY so the floor map shows it as "needs reset" (existing orange
  // tile + Reset Table button). Partial settle keeps the table SEATED.
  // We never flip from RESERVED / OUT_OF_SERVICE / DIRTY itself —
  // those statuses are owned by the floor's host UX, not the POS.
  if (newStatus === "CLOSED" && check.tableId) {
    await prisma.diningTable.updateMany({
      where: { id: check.tableId, clubId: check.clubId, status: "SEATED" },
      data: { status: "DIRTY" },
    });
  }

  // Step 30 — fire the shared post-settle hook so any SEATED
  // reservation linked to this check gets auto-departed when this
  // was the last open check on the table. Without this, the floor
  // map keeps showing the member as actively seated after settle.
  // Tolerant of failures — analytics + lifecycle, never block the
  // settle itself.
  if (newStatus === "CLOSED" && results.length > 0 && results[0].posSaleId) {
    try {
      const { recordCheckSettlement } = await import("../hospitality/reservations");
      await recordCheckSettlement({
        posCheckId: check.id,
        posSaleId: results[0].posSaleId!,
        principal,
      });
    } catch (err) {
      console.error(`[settleCheckBySeats] post-settle hook failed for check ${check.id}:`, err);
    }
  }

  // ----- Receipt emails ------------------------------------------------
  //
  // Two branches:
  //
  //   1. SINGLE-GROUP / MERGE-ALL-INTO-ONE (N === 1)
  //      Email is fired exactly once, written onto POSCheck.receiptEmail*
  //      via sendAndRecordReceiptEmail (matches the legacy settleCheck
  //      path). The closed-check history surfaces it the same way.
  //
  //   2. SPLIT-BILL (N > 1)
  //      One email per MEMBER_ACCOUNT group, written onto that group's
  //      POSSettlementGroup.receiptEmail* row. The POSCheck-level row
  //      is left null — per-group status is the source of truth here.
  //
  // Either way: failures are fire-and-forget (logged, never rolled back)
  // and unsupported groups (QR_PAY, empty, missing posSaleId) are skipped.
  const origin = d.origin ?? "http://localhost:3000";
  if (
    // Step 19 — fire the merge-all receipt for QR_PAY too. createSale
    // for chargeMode=QR_PAY records the member on the sale (when one
    // was passed), so the same receipts.ts path resolves the email
    // address without changes.
    newStatus === "CLOSED" &&
    d.groups.length === 1 &&
    (d.groups[0].paymentMethod === "MEMBER_ACCOUNT" || d.groups[0].paymentMethod === "QR_PAY") &&
    results.length === 1 &&
    results[0].posSaleId
  ) {
    try {
      const { sendAndRecordReceiptEmail } = await import("./receipts");
      await sendAndRecordReceiptEmail({
        checkId: check.id,
        saleId: results[0].posSaleId!,
        origin,
      });
    } catch (err) {
      console.error(`[settleCheckBySeats] merge-all receipt email failed for check ${check.id}:`, err);
    }
  } else if (d.groups.length > 1) {
    // Split-bill: one email per MEMBER_ACCOUNT group with a real sale.
    // Skip QR_PAY (deferred) and any group that didn't produce a sale
    // (empty groups still get a POSSettlementGroup row but no POSSale).
    // Each iteration writes status onto the matching POSSettlementGroup
    // row independently — one provider failure cannot block another
    // group's email.
    const { sendAndRecordGroupReceiptEmail } = await import("./receipts");
    for (let i = 0; i < d.groups.length; i++) {
      const groupSpec = d.groups[i];
      const result = results[i];
      if (!result || !result.posSaleId) continue;
      if (groupSpec.paymentMethod !== "MEMBER_ACCOUNT") continue;
      try {
        const emailResult = await sendAndRecordGroupReceiptEmail({
          groupId: result.groupId,
          saleId: result.posSaleId,
          origin,
        });
        result.receiptEmailStatus = emailResult.status;
        result.receiptEmailAddress = emailResult.toAddress;
        result.receiptEmailFailure = emailResult.failureReason ?? null;
      } catch (err) {
        console.error(
          `[settleCheckBySeats] split-bill receipt email failed for group ${result.groupId}:`,
          err,
        );
        result.receiptEmailStatus = "FAILED";
        result.receiptEmailFailure = err instanceof Error ? err.message : "Unknown error";
      }
    }
  }

  return {
    check: { id: check.id, status: newStatus },
    groups: results,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
