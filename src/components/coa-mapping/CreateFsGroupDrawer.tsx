"use client";

// COA-MAP-3 (2026-10-07) — shared Create-Financial-Statement-Group
// drawer.  Replaces the Mapping Studio's inline CreateGroupPanel
// so the Chart of Accounts page can offer the same canonical
// creation workflow without a mode switch.
//
// Everything about this component is a shell around the canonical
// POST /api/admin/coa-mapping/groups.  Validation, uniqueness
// constraints, tenant isolation, audit, reporting-role mapping,
// and the humanized option labels (labelForReportingRole /
// labelForStatement) are shared with the retiring Mapping Studio.

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  labelForReportingRole,
  labelForStatement,
  REPORTING_ROLES,
  statementForReportingRole,
  isReportingRole,
  type ReportingRole,
} from "@/lib/coa-mapping/reporting-role";

export function CreateFsGroupDrawer({
  clubId,
  initialStatement,
  onClose,
  onCreated,
}: {
  clubId: string;
  /** Pre-select a statement if the caller knows which section the
   *  Controller is working in (e.g. opened from an "ASSETS" header). */
  initialStatement?: "INCOME_STATEMENT" | "BALANCE_SHEET" | "CASH_FLOW";
  onClose: () => void;
  /** Called after a successful create.  The caller refreshes the
   *  page so the new group appears in the hierarchy. */
  onCreated?: (group: { id: string; name: string; statement: string }) => void;
}) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [statement, setStatement] = useState<"INCOME_STATEMENT" | "BALANCE_SHEET" | "CASH_FLOW">(
    initialStatement ?? "INCOME_STATEMENT",
  );
  const [role, setRole] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Picking a Reporting Purpose infers the Financial Statement
  // (parity with Mapping Studio's createGroup behaviour).
  useEffect(() => {
    if (!role || !isReportingRole(role)) return;
    const inferred = statementForReportingRole(role);
    if (inferred === "INCOME_STATEMENT" || inferred === "BALANCE_SHEET") {
      setStatement(inferred);
    }
  }, [role]);

  const roleOptions = useMemo(() => {
    return REPORTING_ROLES.filter((r) => {
      const owning = statementForReportingRole(r);
      if (owning === "ANY") return true;
      return owning === statement;
    });
  }, [statement]);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/coa-mapping/groups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clubId, name, statement, reportingRole: role || null }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body.error ?? "Create failed");
        return;
      }
      onCreated?.(body.group);
      router.refresh();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Create failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-end p-6"
      role="dialog"
      aria-modal="true"
      aria-label="Create Financial Statement Group"
      data-testid="coa-create-fs-group-drawer"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="absolute inset-0 bg-stone-900/20 pointer-events-none" aria-hidden />
      <div className="relative z-10 w-full max-w-md" onClick={(e) => e.stopPropagation()}>
        <section className="card" data-testid="coa-mapping-create-group-form">
          <div className="card-body space-y-3">
            <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-stone-500">
              Create Financial Statement Group
            </h2>
            <label className="block text-xs text-stone-600">
              Name
              <input
                data-testid="coa-mapping-create-group-name"
                className="mt-1 block w-full rounded border border-stone-200 bg-white px-2 py-1 text-sm"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Investment Income"
                autoFocus
              />
            </label>
            <label className="block text-xs text-stone-600">
              Financial Statement
              <select
                data-testid="coa-mapping-create-group-statement"
                className="mt-1 block w-full rounded border border-stone-200 bg-white px-2 py-1 text-sm"
                value={statement}
                onChange={(e) => setStatement(e.target.value as typeof statement)}
              >
                <option value="INCOME_STATEMENT">{labelForStatement("INCOME_STATEMENT")}</option>
                <option value="BALANCE_SHEET">{labelForStatement("BALANCE_SHEET")}</option>
                <option value="CASH_FLOW">{labelForStatement("CASH_FLOW")}</option>
              </select>
            </label>
            <label className="block text-xs text-stone-600">
              Reporting Purpose
              <select
                data-testid="coa-mapping-create-group-role"
                className="mt-1 block w-full rounded border border-stone-200 bg-white px-2 py-1 text-sm"
                value={role}
                onChange={(e) => setRole(e.target.value)}
              >
                <option value="">— choose a reporting purpose —</option>
                {roleOptions.map((r) => (
                  <option key={r} value={r}>
                    {labelForReportingRole(r as ReportingRole)}
                  </option>
                ))}
              </select>
            </label>
            {error && <div className="text-xs text-rose-700">{error}</div>}
            <div className="flex gap-2">
              <button
                type="button"
                className="btn-primary"
                onClick={submit}
                disabled={busy || !name.trim()}
                data-testid="coa-mapping-create-group-submit"
              >
                {busy ? "Creating…" : "Create group"}
              </button>
              <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
