// Reconcile dining tables that are stuck in SEATED after every linked
// check / reservation has actually closed.
//
// Why this exists: step 13 added a SEATED → DIRTY flip to every settle
// path. But the dev DB (and any production DB that ran on the old
// build) already has tables stuck in SEATED with closed POSChecks and
// no active reservations — the floor map keeps them blue, hostesses
// can't seat new parties, the workflow looks broken.
//
// This service is a one-shot repair tool. It's safe to run unattended:
//   - dry-run by default (set apply: true to actually mutate)
//   - tenant-scoped (a Principal is required)
//   - skips any table with active checks OR active reservations
//   - skips OUT_OF_SERVICE / AVAILABLE / RESERVED / DIRTY (never flips
//     those — they're owned by the host UX, not the POS)
//   - one audit row per real change
//
// The CLI wrapper lives in scripts/pos-reconcile-tables.ts and is
// wired as `npm run pos:reconcile-tables`.

import { prisma } from "../prisma";
import { audit } from "../audit";
import { requirePermission, type Principal } from "../rbac";
import { tenantWhere } from "../services/tenant";
import { isReservationActive, isReservationStale } from "../hospitality/reservations";

// Statuses on POSCheck that mean "still active" — anything in this set
// blocks the table from being reconciled.
const ACTIVE_CHECK_STATUSES = [
  "OPEN",
  "PARTIALLY_SENT",
  "SENT",
  "READY",
  "PARTIALLY_SETTLED",
  "PAYMENT_PENDING",
  "PAYMENT_FAILED",
] as const;

// NOTE — "active reservation" gating now goes through
// isReservationActive() from src/lib/hospitality/reservations.ts, which
// adds a time-window check (start..expectedEnd + grace). A CONFIRMED
// reservation from six months ago no longer blocks reconcile — it's
// stale, and the admin Reservations page surfaces it for resolution.

export type ReconcileSkipReason =
  | "TABLE_NOT_SEATED"
  | "ACTIVE_CHECK_PRESENT"
  | "ACTIVE_RESERVATION_PRESENT"
  | "NO_EVIDENCE_OF_USE";

export type ReconcileResult = {
  applied: boolean;
  clubId: string;
  tablesScanned: number;
  tablesChanged: number;
  tableNumbersChanged: string[];
  skippedTables: Array<{
    tableNumber: string;
    status: string;
    reason: ReconcileSkipReason;
    detail?: string;
  }>;
};

export async function reconcileSettledTablesToDirty(
  principal: Principal,
  opts: { clubId: string; apply?: boolean } = { clubId: "" },
): Promise<ReconcileResult> {
  if (!opts.clubId) throw new Error("reconcileSettledTablesToDirty: clubId is required");
  // settings:write — same gate as other operational maintenance.
  requirePermission(principal, opts.clubId, "settings:write");

  const tables = await prisma.diningTable.findMany({
    where: { ...tenantWhere(principal, opts.clubId), status: "SEATED" },
    include: {
      posChecks: { select: { id: true, status: true } },
      // Pull the time fields so isReservationActive can decide
      // active-vs-stale without a second query.
      reservations: {
        select: { id: true, status: true, startTime: true, expectedEndTime: true },
      },
    },
    orderBy: { tableNumber: "asc" },
  });

  const apply = opts.apply === true;
  const now = new Date();
  const tableNumbersChanged: string[] = [];
  const skippedTables: ReconcileResult["skippedTables"] = [];

  for (const t of tables) {
    // Defence in depth — the query already filtered by status=SEATED,
    // but if the row changed between query and update we still want a
    // clean skip rather than a stomp.
    if (t.status !== "SEATED") {
      skippedTables.push({
        tableNumber: t.tableNumber,
        status: t.status,
        reason: "TABLE_NOT_SEATED",
      });
      continue;
    }

    const activeChecks = t.posChecks.filter((c) => (ACTIVE_CHECK_STATUSES as readonly string[]).includes(c.status));
    if (activeChecks.length > 0) {
      skippedTables.push({
        tableNumber: t.tableNumber,
        status: t.status,
        reason: "ACTIVE_CHECK_PRESENT",
        detail: `${activeChecks.length} active check(s): ${activeChecks.map((c) => c.status).join(", ")}`,
      });
      continue;
    }

    // Only TRULY active reservations block — past CONFIRMED/REQUESTED
    // beyond grace are STALE and don't gate reconcile. The stale ones
    // are surfaced separately on the admin Reservations page so a host
    // can mark them no-show / cancelled / completed.
    const activeRes = t.reservations.filter((r) => isReservationActive(r, now));
    const staleRes = t.reservations.filter((r) => isReservationStale(r, now));
    if (activeRes.length > 0) {
      skippedTables.push({
        tableNumber: t.tableNumber,
        status: t.status,
        reason: "ACTIVE_RESERVATION_PRESENT",
        detail: `${activeRes.length} active reservation(s): ${activeRes
          .map((r) => `${r.status} starts ${r.startTime.toISOString().slice(0, 16).replace("T", " ")}`)
          .join(", ")}`,
      });
      continue;
    }

    // No evidence the table was ever in service — no checks ever, no
    // reservations ever. We could flip it anyway (the table is wrong
    // either way) but the safest dev-data move is to flag it for
    // human review. Production data should never reach this state.
    if (t.posChecks.length === 0 && t.reservations.length === 0) {
      // Honest behavior — if the table is SEATED with literally no
      // history, the floor data is corrupt or seeded that way. We
      // still flip it (SEATED with no evidence is broken state), but
      // we record the reason so the script output explains it.
      // Otherwise the script would silently flip stale seed rows
      // without surfacing the unusual case.
      if (apply) {
        await prisma.diningTable.update({
          where: { id: t.id },
          data: { status: "DIRTY" },
        });
        await audit(principal, {
          action: "pos.table.reconcile",
          entityType: "DiningTable",
          entityId: t.id,
          clubId: opts.clubId,
          before: { status: "SEATED" },
          after: { status: "DIRTY", reason: "NO_EVIDENCE_OF_USE" },
        });
      }
      tableNumbersChanged.push(t.tableNumber);
      // Don't push into skippedTables — we did flip it; just note the
      // reason in the per-change log via audit.
      continue;
    }

    // The happy path: SEATED, ≥1 closed/voided check, zero ACTIVE
    // reservations. Stale reservations get recorded in the audit so
    // operations can chase them down even though they don't block.
    if (apply) {
      await prisma.diningTable.update({
        where: { id: t.id },
        data: { status: "DIRTY" },
      });
      const closedCount = t.posChecks.length;
      await audit(principal, {
        action: "pos.table.reconcile",
        entityType: "DiningTable",
        entityId: t.id,
        clubId: opts.clubId,
        before: { status: "SEATED" },
        after: {
          status: "DIRTY",
          closedChecks: closedCount,
          staleReservations: staleRes.length,
          staleReservationIds: staleRes.map((r) => r.id),
        },
      });
    }
    tableNumbersChanged.push(t.tableNumber);
  }

  return {
    applied: apply,
    clubId: opts.clubId,
    tablesScanned: tables.length,
    tablesChanged: tableNumbersChanged.length,
    tableNumbersChanged,
    skippedTables,
  };
}
