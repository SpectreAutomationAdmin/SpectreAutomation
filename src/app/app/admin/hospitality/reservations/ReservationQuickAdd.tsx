"use client";

// Inline quick-add for new reservations + walk-ins. Two toggleable
// forms; both submit to a server action and refresh the page on success.

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createReservationAction, createWalkInAction } from "./_actions";

type Area = {
  id: string;
  name: string;
  tables: Array<{ id: string; tableNumber: string; displayName: string | null; capacity: number }>;
};
type Member = { id: string; firstName: string; lastName: string; memberNumber: string };

export function ReservationQuickAdd({
  areas,
  members,
  defaultDurationMin,
  dateStr,
}: {
  areas: Area[];
  members: Member[];
  defaultDurationMin: number;
  dateStr: string;
}) {
  const router = useRouter();
  const [mode, setMode] = useState<"hidden" | "reservation" | "walkin">("hidden");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit(form: HTMLFormElement, kind: "reservation" | "walkin") {
    setError(null);
    const data = new FormData(form);
    const time = String(data.get("time") ?? "12:00");
    const dateInput = String(data.get("date") ?? dateStr);
    const startIso = `${dateInput}T${time}:00`;
    const payload = {
      memberId: (String(data.get("memberId") ?? "") || null),
      reservationType: (kind === "walkin" ? "WALK_IN" : (String(data.get("memberId") ?? "") ? "MEMBER" : "GUEST")) as "MEMBER" | "WALK_IN" | "GUEST",
      guestName: String(data.get("guestName") ?? ""),
      guestEmail: String(data.get("guestEmail") ?? ""),
      guestPhone: String(data.get("guestPhone") ?? ""),
      startTime: startIso,
      durationMinutes: defaultDurationMin,
      partySize: Number(data.get("partySize") ?? 2),
      diningAreaId: String(data.get("diningAreaId") ?? ""),
      tableId: String(data.get("tableId") ?? "") || null,
      specialRequests: String(data.get("specialRequests") ?? ""),
      occasion: String(data.get("occasion") ?? ""),
      // Host bookings: acknowledgements are recorded as TRUE on the
      // member's behalf because the host informed them verbally.
      dressCodeAcknowledged: true,
      noShowFeeAcknowledged: true,
    };
    startTransition(async () => {
      const action = kind === "walkin" ? createWalkInAction : createReservationAction;
      const r = await action(payload);
      if (!r.ok) {
        setError(r.error);
        return;
      }
      router.refresh();
      setMode("hidden");
      form.reset();
    });
  }

  if (mode === "hidden") {
    return (
      <div className="mt-4 flex gap-2">
        <button onClick={() => setMode("reservation")} className="btn btn-primary btn-sm">+ New reservation</button>
        <button onClick={() => setMode("walkin")} className="btn btn-secondary btn-sm">+ Walk-in</button>
      </div>
    );
  }

  const allTables = areas.flatMap((a) => a.tables);
  const isWalkin = mode === "walkin";

  return (
    <form
      className="mt-4 card card-body space-y-4"
      onSubmit={(e) => { e.preventDefault(); submit(e.currentTarget, isWalkin ? "walkin" : "reservation"); }}
    >
      <div className="flex items-center justify-between">
        <h2 className="section-title text-base">{isWalkin ? "Add walk-in" : "New reservation"}</h2>
        <button type="button" onClick={() => setMode("hidden")} className="text-xs text-stone-500 hover:text-stone-700">Cancel</button>
      </div>

      {error && <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}

      <div className="grid grid-cols-1 md:grid-cols-4 gap-3 text-sm">
        <div>
          <label className="label">Member (optional)</label>
          <select name="memberId" className="select text-xs" defaultValue="">
            <option value="">— Guest / no member —</option>
            {members.map((m) => (
              <option key={m.id} value={m.id}>{m.lastName}, {m.firstName} · {m.memberNumber}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="label">Guest name (if no member)</label>
          <input name="guestName" className="input text-sm" maxLength={120} />
        </div>
        <div>
          <label className="label">Guest email</label>
          <input name="guestEmail" type="email" className="input text-sm" maxLength={254} />
        </div>
        <div>
          <label className="label">Guest phone</label>
          <input name="guestPhone" className="input text-sm" maxLength={40} />
        </div>
        {!isWalkin && (
          <div>
            <label className="label">Date</label>
            <input type="date" name="date" className="input text-sm" defaultValue={dateStr} required />
          </div>
        )}
        {isWalkin && <input type="hidden" name="date" value={new Date().toISOString().slice(0, 10)} />}
        <div>
          <label className="label">Time</label>
          <input
            type="time"
            name="time"
            className="input text-sm"
            defaultValue={isWalkin ? new Date().toISOString().slice(11, 16) : "18:00"}
            required
          />
        </div>
        <div>
          <label className="label">Party size</label>
          <input type="number" name="partySize" className="input text-sm" min={1} max={40} defaultValue={2} required />
        </div>
        <div>
          <label className="label">Dining area</label>
          <select name="diningAreaId" className="select text-sm" required defaultValue={areas[0]?.id ?? ""}>
            {areas.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </div>
        <div>
          <label className="label">Table {isWalkin ? "(required)" : "(optional — host can assign later)"}</label>
          <select name="tableId" className="select text-sm" defaultValue="" required={isWalkin}>
            <option value="">{isWalkin ? "— pick a table —" : "— no table yet —"}</option>
            {allTables.map((t) => (
              <option key={t.id} value={t.id}>{t.displayName ?? `Table ${t.tableNumber}`} · seats {t.capacity}</option>
            ))}
          </select>
        </div>
        <div className="md:col-span-2">
          <label className="label">Occasion</label>
          <input name="occasion" className="input text-sm" maxLength={120} placeholder="Birthday, anniversary, business, etc." />
        </div>
        <div className="md:col-span-4">
          <label className="label">Special requests</label>
          <textarea name="specialRequests" className="input text-sm" rows={2} maxLength={2000} />
        </div>
      </div>

      <div className="flex justify-end">
        <button type="submit" disabled={pending} className="btn btn-primary btn-sm">
          {pending ? "Saving…" : isWalkin ? "Seat walk-in" : "Create reservation"}
        </button>
      </div>
    </form>
  );
}
