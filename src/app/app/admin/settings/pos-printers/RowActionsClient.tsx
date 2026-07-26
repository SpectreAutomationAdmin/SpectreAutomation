"use client";

// Per-row Edit + Delete + activate-toggle for the printer table.
// Lives in its own client component so the table can stay server-
// rendered and just pass props.

import { useState, useTransition } from "react";
import { updatePrinterAction, deletePrinterAction, type PrinterInput } from "./_actions";
import { PRINTER_ROLES, PRINTER_KINDS, type PrinterRole, type PrinterKind } from "@/lib/pos/printers-shared";

export function RowActionsClient(props: {
  id: string;
  name: string;
  role: string;
  kind: string;
  location: string | null;
  driverHint: string | null;
  isDefault: boolean;
  isActive: boolean;
}) {
  const [editOpen, setEditOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  // Edit form draft state.
  const [name, setName] = useState(props.name);
  const [role, setRole] = useState<PrinterRole>(props.role as PrinterRole);
  const [kind, setKind] = useState<PrinterKind>(props.kind as PrinterKind);
  const [location, setLocation] = useState(props.location ?? "");
  const [driverHint, setDriverHint] = useState(props.driverHint ?? "");
  const [isDefault, setIsDefault] = useState(props.isDefault);
  const [isActive, setIsActive] = useState(props.isActive);

  function save() {
    setError(null);
    const patch: Partial<PrinterInput> = {
      name: name.trim(),
      role,
      kind,
      location: location.trim() || null,
      driverHint: driverHint.trim() || null,
      isDefault,
      isActive,
    };
    startTransition(async () => {
      const r = await updatePrinterAction(props.id, patch);
      if (r.ok) setEditOpen(false);
      else setError(r.error);
    });
  }
  function remove() {
    if (!confirm(`Delete "${props.name}"? This can't be undone.`)) return;
    setError(null);
    startTransition(async () => {
      const r = await deletePrinterAction(props.id);
      if (!r.ok) setError(r.error);
    });
  }

  return (
    <>
      <div className="inline-flex gap-2">
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          disabled={pending}
          onClick={() => setEditOpen(true)}
        >
          Edit
        </button>
        <button
          type="button"
          className="btn btn-sm border border-red-200 bg-white text-red-700 hover:bg-red-50"
          disabled={pending}
          onClick={remove}
        >
          Delete
        </button>
      </div>

      {editOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-stone-900/40 px-4"
          role="dialog"
          aria-modal="true"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setEditOpen(false);
          }}
        >
          <div className="bg-white rounded-xl shadow-elevated w-full max-w-lg p-6 text-left">
            <h2 className="font-serif text-xl text-club-ink">Edit printer</h2>

            {error && (
              <div className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>
            )}

            <div className="mt-4 space-y-3">
              <div>
                <label className="block text-[10px] uppercase tracking-wide text-stone-500 mb-1">Name</label>
                <input type="text" className="input text-sm" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[10px] uppercase tracking-wide text-stone-500 mb-1">Role</label>
                  <select className="input text-sm" value={role} onChange={(e) => setRole(e.target.value as PrinterRole)}>
                    {PRINTER_ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-[10px] uppercase tracking-wide text-stone-500 mb-1">Kind</label>
                  <select className="input text-sm" value={kind} onChange={(e) => setKind(e.target.value as PrinterKind)}>
                    {PRINTER_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
                  </select>
                </div>
              </div>
              <div>
                <label className="block text-[10px] uppercase tracking-wide text-stone-500 mb-1">Location (optional)</label>
                <input type="text" className="input text-sm" value={location} onChange={(e) => setLocation(e.target.value)} placeholder="e.g. Kitchen counter" maxLength={120} />
              </div>
              <div>
                <label className="block text-[10px] uppercase tracking-wide text-stone-500 mb-1">Driver / address hint (optional)</label>
                <input type="text" className="input text-sm font-mono" value={driverHint} onChange={(e) => setDriverHint(e.target.value)} placeholder="ipp://192.168.1.50/ipp/print" maxLength={200} />
              </div>
              <div className="flex items-center gap-5 text-sm">
                <label className="inline-flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" className="h-4 w-4" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} />
                  Default for this role
                </label>
                <label className="inline-flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" className="h-4 w-4" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
                  Active
                </label>
              </div>
            </div>

            <div className="mt-6 flex justify-end gap-2">
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => setEditOpen(false)} disabled={pending}>Cancel</button>
              <button type="button" className="btn btn-primary btn-sm" onClick={save} disabled={pending || !name.trim()}>Save changes</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
