// Reservation detail — host actions live here.

import Link from "next/link";
import { redirect, notFound } from "next/navigation";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { hasPermission } from "@/lib/rbac";
import { getReservation, listDiningAreas, getReservationSettings } from "@/lib/hospitality/reservations";
import { formatCurrency, formatDateTime } from "@/lib/finance";
import { ReservationActions } from "./ReservationActions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function ReservationDetailPage({ params }: { params: { id: string } }) {
  const principal = await getCurrentPrincipal();
  if (!principal) redirect("/login");
  const clubId = await getActiveClubId({ clubId: principal.activeClubId ?? null, role: "" });
  if (!hasPermission(principal, clubId, "reservations:read")) redirect("/app/admin");

  let r: Awaited<ReturnType<typeof getReservation>>;
  try { r = await getReservation(principal, params.id); }
  catch { notFound(); }
  if (!r) notFound();

  const [areas, settings] = await Promise.all([
    listDiningAreas(principal, clubId),
    getReservationSettings(clubId),
  ]);

  const guestName = r.member ? `${r.member.firstName} ${r.member.lastName}` : r.guestName ?? "Guest";
  const link = r.checkLinks[0];
  const linkedSpend = r.checkLinks.reduce(
    (sum, l) => sum + (l.posSale?.grandTotal ? Number(l.posSale.grandTotal.toString()) : 0),
    0,
  );
  const durationMin =
    r.actualSeatedAt && r.actualDepartedAt
      ? Math.round((r.actualDepartedAt.getTime() - r.actualSeatedAt.getTime()) / 60_000)
      : null;
  const elapsedMin = r.actualSeatedAt && !r.actualDepartedAt
    ? Math.round((Date.now() - r.actualSeatedAt.getTime()) / 60_000)
    : null;

  return (
    <div>
      <Link href="/app/admin/hospitality/reservations" className="text-sm text-stone-500 hover:text-club-ink">← Reservations</Link>

      <div className="mt-3 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="page-title">{guestName}</h1>
          <p className="mt-1 text-sm text-stone-500">
            {r.reservationType === "WALK_IN" ? "Walk-in" : r.reservationType === "GUEST" ? "Guest reservation" : "Member reservation"}
            {" · "}
            {formatDateTime(r.startTime)}
            {" · "}
            party of {r.partySize}
          </p>
        </div>
        <span className={`inline-flex rounded-md border px-3 py-1 text-xs uppercase tracking-wide ${badgeTone(r.status)}`}>{r.status.replace("_", " ")}</span>
      </div>

      <div className="mt-6 grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Details column */}
        <div className="card card-body lg:col-span-2 space-y-4">
          <h3 className="section-title text-lg">Details</h3>
          <dl className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
            <DT label="Dining area">{r.diningArea.name}</DT>
            <DT label="Table">{r.table ? (r.table.displayName ?? `Table ${r.table.tableNumber}`) : "— not assigned —"}</DT>
            <DT label="Member email">{r.member?.email ?? "—"}</DT>
            <DT label="Guest contact">
              {[r.guestEmail, r.guestPhone].filter(Boolean).join(" · ") || "—"}
            </DT>
            <DT label="Occasion">{r.occasion ?? "—"}</DT>
            <DT label="Special requests">{r.specialRequests ?? "—"}</DT>
            <DT label="Confirmation email">
              {r.confirmationEmailStatus
                ? `${r.confirmationEmailStatus}${r.confirmationEmailAddress ? ` → ${r.confirmationEmailAddress}` : ""}${r.confirmationEmailFailure ? ` · ${r.confirmationEmailFailure}` : ""}`
                : settings.confirmationEmailEnabled ? "Pending" : "Disabled at club level"}
            </DT>
            <DT label="Host notes">{r.hostNotes ?? "—"}</DT>
          </dl>

          <div className="pt-3 border-t border-stone-100">
            <h4 className="text-xs uppercase tracking-wide text-stone-500">Visit timeline</h4>
            <dl className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
              <DT label="Seated at">{r.actualSeatedAt ? formatDateTime(r.actualSeatedAt) : "—"}</DT>
              <DT label="Departed at">{r.actualDepartedAt ? formatDateTime(r.actualDepartedAt) : "—"}</DT>
              <DT label="Duration">{durationMin !== null ? `${durationMin} min` : elapsedMin !== null ? `${elapsedMin} min · in progress` : "—"}</DT>
              <DT label="Linked spend">{linkedSpend > 0 ? formatCurrency(linkedSpend) : "—"}</DT>
            </dl>
          </div>

          {r.status === "NO_SHOW" && (
            <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
              <div className="font-medium">No-show</div>
              <div className="mt-1 text-xs">
                Marked {r.noShowMarkedAt ? formatDateTime(r.noShowMarkedAt) : "—"}
                {r.noShowReason ? ` · "${r.noShowReason}"` : ""}
              </div>
              {r.noShowFeeChargedAt
                ? <div className="mt-1 text-xs">Fee charged to member account ({formatCurrency(Number(settings.noShowFeeAmount.toString()))}).</div>
                : settings.noShowFeeEnabled
                  ? <div className="mt-1 text-xs">No fee was posted (no member account linked, or charge failed — check the audit log).</div>
                  : <div className="mt-1 text-xs">No-show fee is currently disabled at the club level.</div>
              }
            </div>
          )}

          {link && (
            <div className="rounded-md border border-stone-200 bg-stone-50 px-3 py-2 text-xs">
              <div className="font-medium text-stone-700">POS check linked</div>
              <div className="mt-1">
                Check {link.posCheck.checkNumber} · status {link.posCheck.status}
                {link.posSale && <> · sale {link.posSale.saleNumber} · {formatCurrency(Number(link.posSale.grandTotal.toString()))}</>}
              </div>
              <Link href="/app/admin/ops/pos/lounge" className="mt-2 inline-block text-club-green-700 hover:underline">Open POS →</Link>
            </div>
          )}
        </div>

        {/* Actions column */}
        <ReservationActions
          reservationId={r.id}
          status={r.status}
          tableId={r.tableId}
          hasMember={!!r.memberId}
          hasOpenCheck={!!link}
          areas={areas.map((a) => ({
            id: a.id,
            name: a.name,
            tables: a.tables.map((t) => ({ id: t.id, tableNumber: t.tableNumber, displayName: t.displayName, capacity: t.capacity })),
          }))}
        />
      </div>
    </div>
  );
}

function DT({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-stone-500">{label}</dt>
      <dd className="mt-1 text-club-ink">{children}</dd>
    </div>
  );
}

function badgeTone(status: string): string {
  const m: Record<string, string> = {
    REQUESTED: "bg-stone-100 text-stone-700 border-stone-300",
    CONFIRMED: "bg-blue-50 text-blue-800 border-blue-300",
    SEATED: "bg-club-green-50 text-club-green-800 border-club-green-300",
    COMPLETED: "bg-stone-100 text-stone-600 border-stone-300",
    CANCELLED: "bg-stone-100 text-stone-500 border-stone-300",
    NO_SHOW: "bg-red-50 text-red-800 border-red-300",
  };
  return m[status] ?? "bg-stone-100 text-stone-700 border-stone-300";
}
