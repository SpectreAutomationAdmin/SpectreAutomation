"use client";

// Action panel for a single reservation. Buttons surface only the
// actions valid for the current status.

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  seatReservationAction,
  departReservationAction,
  noShowReservationAction,
  cancelReservationAction,
  assignTableAction,
  openCheckAction,
  confirmReservationAction,
} from "../_actions";

type Area = {
  id: string;
  name: string;
  tables: Array<{ id: string; tableNumber: string; displayName: string | null; capacity: number }>;
};

export function ReservationActions({
  reservationId,
  status,
  tableId,
  hasMember,
  hasOpenCheck,
  areas,
}: {
  reservationId: string;
  status: string;
  tableId: string | null;
  hasMember: boolean;
  hasOpenCheck: boolean;
  areas: Area[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [selectedTable, setSelectedTable] = useState<string>(tableId ?? "");
  const [noShowReason, setNoShowReason] = useState("");
  const [cancelReason, setCancelReason] = useState("");

  function run(fn: () => Promise<{ ok: true; data: unknown } | { ok: false; error: string }>, successMessage?: string) {
    setError(null);
    setInfo(null);
    startTransition(async () => {
      const r = await fn();
      if (!r.ok) { setError(r.error); return; }
      if (successMessage) setInfo(successMessage);
      router.refresh();
    });
  }

  const allTables = areas.flatMap((a) => a.tables.map((t) => ({ ...t, areaName: a.name })));
  const canSeat = status === "CONFIRMED" || status === "REQUESTED";
  const canConfirm = status === "REQUESTED";
  const canDepart = status === "SEATED";
  const canNoShow = status === "CONFIRMED" || status === "REQUESTED";
  const canCancel = status === "CONFIRMED" || status === "REQUESTED";
  const canOpenCheck = status === "SEATED" && hasMember && !hasOpenCheck;

  return (
    <div className="card card-body space-y-4">
      <h3 className="section-title text-lg">Actions</h3>

      {error && <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
      {info && <div className="rounded-md border border-club-green-300 bg-club-green-50 px-3 py-2 text-sm text-club-green-800">{info}</div>}

      {canConfirm && (
        <button disabled={pending} onClick={() => run(() => confirmReservationAction(reservationId), "Confirmed and confirmation email queued.")} className="btn btn-primary btn-sm w-full">
          Confirm reservation
        </button>
      )}

      {/* Table assignment */}
      {(status === "CONFIRMED" || status === "REQUESTED" || status === "SEATED") && (
        <div>
          <label className="label">Table</label>
          <select
            className="select text-sm"
            value={selectedTable}
            onChange={(e) => setSelectedTable(e.target.value)}
          >
            <option value="">— Unassigned —</option>
            {allTables.map((t) => (
              <option key={t.id} value={t.id}>
                {t.areaName} · {t.displayName ?? `Table ${t.tableNumber}`} (seats {t.capacity})
              </option>
            ))}
          </select>
          {selectedTable !== (tableId ?? "") && (
            <button
              disabled={pending}
              onClick={() => run(() => assignTableAction(reservationId, selectedTable || null), "Table updated.")}
              className="btn btn-secondary btn-sm mt-2 w-full"
            >
              Save table
            </button>
          )}
        </div>
      )}

      {canSeat && (
        <button
          disabled={pending}
          onClick={() => run(() => seatReservationAction(reservationId, selectedTable || tableId), "Party seated.")}
          className="btn btn-primary btn-sm w-full"
        >
          Seat party
        </button>
      )}

      {canOpenCheck && (
        <button
          disabled={pending}
          onClick={() => run(async () => {
            const r = await openCheckAction(reservationId);
            if (r.ok) return { ok: true as const, data: r.data };
            return r;
          }, "POS check opened.")}
          className="btn btn-primary btn-sm w-full"
        >
          Open POS check
        </button>
      )}

      {canDepart && (
        <button disabled={pending} onClick={() => run(() => departReservationAction(reservationId), "Marked departed.")} className="btn btn-secondary btn-sm w-full">
          Mark departed
        </button>
      )}

      {canNoShow && (
        <div className="rounded-md border border-stone-200 p-3 space-y-2">
          <div className="text-xs uppercase tracking-wide text-stone-500">Mark no-show</div>
          <textarea
            className="input text-xs"
            rows={2}
            maxLength={500}
            placeholder="Reason / note (required)"
            value={noShowReason}
            onChange={(e) => setNoShowReason(e.target.value)}
          />
          <button
            disabled={pending || !noShowReason.trim()}
            onClick={() => {
              if (!confirm("Mark this reservation as a no-show? If the no-show fee is enabled and a member is linked, the fee will be charged to their account.")) return;
              run(async () => {
                const r = await noShowReservationAction(reservationId, noShowReason);
                if (r.ok) {
                  return {
                    ok: true as const,
                    data: r.data,
                  };
                }
                return r;
              }, "Marked no-show. The audit log records who and when.");
            }}
            className="btn btn-secondary btn-sm w-full"
          >
            Mark no-show
          </button>
        </div>
      )}

      {canCancel && (
        <div className="rounded-md border border-stone-200 p-3 space-y-2">
          <div className="text-xs uppercase tracking-wide text-stone-500">Cancel</div>
          <input
            className="input text-xs"
            maxLength={500}
            placeholder="Reason (optional)"
            value={cancelReason}
            onChange={(e) => setCancelReason(e.target.value)}
          />
          <button
            disabled={pending}
            onClick={() => {
              if (!confirm("Cancel this reservation?")) return;
              run(() => cancelReservationAction(reservationId, cancelReason), "Cancelled.");
            }}
            className="btn btn-secondary btn-sm w-full"
          >
            Cancel reservation
          </button>
        </div>
      )}
    </div>
  );
}
