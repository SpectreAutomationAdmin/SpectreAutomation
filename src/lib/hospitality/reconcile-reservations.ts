// Step 30 — reservation lifecycle reconciler.
//
// Finds DiningReservations stuck in SEATED status whose linked
// POSCheck(s) are all CLOSED/VOIDED, and auto-departs them (the
// same flip step 30 now performs at settle time, but for rows
// that pre-date the fix or were missed by a transient failure).
//
// Dry-run by default; pass `apply: true` to mutate. Mirrors the
// shape of src/lib/pos/reconcile-tables.ts so the two reconcilers
// compose cleanly into a future "post-shift sweep" job.

import { prisma } from "../prisma";
import { audit } from "../audit";
import { requirePermission, type Principal } from "../rbac";
import { tenantWhere } from "../services/tenant";

export type ReconcileReservationsResult = {
  scanned: number;
  candidates: Array<{
    reservationId: string;
    tableId: string | null;
    tableNumber: string | null;
    memberName: string | null;
    seatedAtIso: string | null;
    reason: string;
  }>;
  applied: number;
};

export async function reconcileStaleSeatedReservations(
  principal: Principal,
  opts: { clubId: string; apply?: boolean },
): Promise<ReconcileReservationsResult> {
  requirePermission(principal, opts.clubId, "settings:write");

  // Pull all SEATED reservations for the club. The set is naturally
  // small (typical club has ≤ a few dozen tables seated at once),
  // so an in-memory pass is cheaper than a complex join.
  const seated = await prisma.diningReservation.findMany({
    where: { ...tenantWhere(principal, opts.clubId), status: "SEATED" },
    select: {
      id: true, clubId: true, tableId: true, memberId: true,
      actualSeatedAt: true,
      member: { select: { firstName: true, lastName: true } },
      table: { select: { tableNumber: true } },
    },
  });

  const candidates: ReconcileReservationsResult["candidates"] = [];
  let applied = 0;

  for (const r of seated) {
    if (!r.tableId) continue; // can't reconcile without a table

    // Are any non-CLOSED/VOIDED checks still on this table?
    const openCheck = await prisma.pOSCheck.findFirst({
      where: {
        tableId: r.tableId,
        clubId: r.clubId,
        status: { notIn: ["CLOSED", "VOIDED"] },
      },
      select: { id: true },
    });
    if (openCheck) continue; // genuinely still in service

    // Was the reservation ever actually linked to a settled check?
    // We don't want to mass-depart stale walk-ins that were never
    // billed. Require at least one CLOSED check on the table tied
    // to this reservation (via POSCheck.reservationId OR via a
    // DiningReservationCheckLink).
    const closedCheckCount = await prisma.pOSCheck.count({
      where: {
        clubId: r.clubId,
        status: "CLOSED",
        OR: [
          { reservationId: r.id },
          { reservationLinks: { some: { reservationId: r.id } } },
        ],
      },
    });
    if (closedCheckCount === 0) continue;

    candidates.push({
      reservationId: r.id,
      tableId: r.tableId,
      tableNumber: r.table?.tableNumber ?? null,
      memberName: r.member ? `${r.member.firstName} ${r.member.lastName}` : null,
      seatedAtIso: r.actualSeatedAt?.toISOString() ?? null,
      reason: "All linked checks are CLOSED but reservation status is still SEATED.",
    });

    if (opts.apply) {
      const now = new Date();
      await prisma.diningReservation.update({
        where: { id: r.id },
        data: { status: "COMPLETED", actualDepartedAt: now },
      });
      // Defensive — make sure the table is DIRTY too.
      await prisma.diningTable.updateMany({
        where: { id: r.tableId, clubId: r.clubId, status: "SEATED" },
        data: { status: "DIRTY" },
      });
      await audit(principal, {
        action: "reservation.reconcile.auto-depart",
        entityType: "DiningReservation",
        entityId: r.id,
        clubId: r.clubId,
        after: {
          actualDepartedAt: now,
          durationMinutes: r.actualSeatedAt
            ? Math.round((now.getTime() - r.actualSeatedAt.getTime()) / 60_000)
            : null,
          reason: "reconcile-stale-seated",
        },
      });
      applied++;
    }
  }

  return { scanned: seated.length, candidates, applied };
}
