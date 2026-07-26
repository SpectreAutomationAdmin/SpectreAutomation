"use client";

// Add-a-printer form. Kept as its own panel below the registered-
// printer table so it doesn't crowd the row layout.

import { useState, useTransition } from "react";
import { createPrinterAction, type PrinterInput } from "./_actions";
import { PRINTER_ROLES, PRINTER_KINDS, type PrinterRole, type PrinterKind } from "@/lib/pos/printers-shared";

export function PrinterAdminPanel() {
  const [name, setName] = useState("");
  const [role, setRole] = useState<PrinterRole>("ANY");
  const [kind, setKind] = useState<PrinterKind>("NETWORK");
  const [location, setLocation] = useState("");
  const [driverHint, setDriverHint] = useState("");
  const [isDefault, setIsDefault] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  function submit() {
    setError(null);
    setSuccess(null);
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Name is required.");
      return;
    }
    const input: PrinterInput = {
      name: trimmed,
      role,
      kind,
      location: location.trim() || null,
      driverHint: driverHint.trim() || null,
      isDefault,
      isActive: true,
    };
    startTransition(async () => {
      const r = await createPrinterAction(input);
      if (r.ok) {
        setSuccess(`Added “${trimmed}”.`);
        setName("");
        setLocation("");
        setDriverHint("");
        setIsDefault(false);
      } else {
        setError(r.error);
      }
    });
  }

  return (
    <div className="card card-body">
      <div className="text-xs uppercase tracking-wide text-stone-500 font-medium">Add a printer</div>
      <p className="mt-1 text-xs text-stone-500">
        Spectre dispatches print jobs via the browser&rsquo;s print dialog, which routes to whatever printer the operating system has registered. Naming a printer here makes it pickable in the lounge POS &mdash; the admin can also set role-specific defaults.
      </p>

      {error && (
        <div className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>
      )}
      {success && (
        <div className="mt-3 rounded-md border border-club-green-200 bg-club-green-50 px-3 py-2 text-sm text-club-green-800">{success}</div>
      )}

      <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-3">
        <div>
          <label className="block text-[10px] uppercase tracking-wide text-stone-500 mb-1">Name</label>
          <input type="text" className="input text-sm" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Kitchen HP LaserJet" maxLength={80} />
        </div>
        <div>
          <label className="block text-[10px] uppercase tracking-wide text-stone-500 mb-1">Location (optional)</label>
          <input type="text" className="input text-sm" value={location} onChange={(e) => setLocation(e.target.value)} placeholder="e.g. Kitchen counter" maxLength={120} />
        </div>
        <div>
          <label className="block text-[10px] uppercase tracking-wide text-stone-500 mb-1">Role</label>
          <select className="input text-sm" value={role} onChange={(e) => setRole(e.target.value as PrinterRole)}>
            {PRINTER_ROLES.map((r) => <option key={r} value={r}>{labelForRole(r)}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-[10px] uppercase tracking-wide text-stone-500 mb-1">Kind</label>
          <select className="input text-sm" value={kind} onChange={(e) => setKind(e.target.value as PrinterKind)}>
            {PRINTER_KINDS.map((k) => <option key={k} value={k}>{labelForKind(k)}</option>)}
          </select>
        </div>
        <div className="md:col-span-2">
          <label className="block text-[10px] uppercase tracking-wide text-stone-500 mb-1">Driver / address hint (optional)</label>
          <input type="text" className="input text-sm font-mono" value={driverHint} onChange={(e) => setDriverHint(e.target.value)} placeholder="ipp://192.168.1.50/ipp/print  or  the OS printer share name" maxLength={200} />
          <p className="mt-1 text-[11px] text-stone-400">
            Stored for reference. Spectre&rsquo;s current print path routes via the browser dialog &mdash; this field becomes load-bearing when a driver layer is added.
          </p>
        </div>
        <div className="md:col-span-2">
          <label className="inline-flex items-center gap-2 text-sm cursor-pointer">
            <input type="checkbox" className="h-4 w-4" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} />
            Make this the default for its role
          </label>
        </div>
      </div>

      <div className="mt-4 flex justify-end">
        <button type="button" className="btn btn-primary btn-sm disabled:opacity-60" onClick={submit} disabled={pending || !name.trim()}>
          Add printer
        </button>
      </div>
    </div>
  );
}

function labelForRole(r: PrinterRole): string {
  if (r === "KITCHEN") return "Kitchen chits";
  if (r === "BAR") return "Bar chits";
  if (r === "SIGNATURE") return "Signature / member receipt";
  if (r === "RECEIPT") return "Receipt printer (generic)";
  return "Any role";
}
function labelForKind(k: PrinterKind): string {
  if (k === "NETWORK") return "Network (IPP / LPR)";
  if (k === "USB") return "USB-attached";
  if (k === "RECEIPT_PRINTER") return "Thermal receipt printer";
  return "PDF (browser print)";
}
