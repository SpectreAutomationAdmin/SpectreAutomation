"use client";

// COA-MAP-3A (2026-10-07) — reassign an account's Financial
// Statement Group from the Chart of Accounts Account Inspector.
//
// This drawer is the CANONICAL path — it fetches /api/admin/coa-
// mapping/preview and renders the shared `MappingPreviewPanel`
// (with effective-date radios, historical-consequence note,
// VALID/WARNING/BLOCKED semantics, Review & Apply retry).  Apply
// goes through POST /api/admin/coa-mapping/accounts/{id}/reassign
// which writes to AccountFinancialStatementAssignment and the
// audit log — not a direct `Account.fsGroupId` update.
//
// This replaces the previous Inspector <select> that direct-wrote
// `Account.fsGroupId` via updateAccountInspectorAction and bypassed
// effective dating + reporting impact.  Per COA-MAP-3A §7: "Do not
// implement a separate direct-write shortcut."

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  MappingPreviewPanel,
  type MappingPreviewResult,
} from "@/components/coa-mapping/MappingPreviewPanel";
import { labelForStatement } from "@/lib/coa-mapping/reporting-role";

type GroupOption = {
  id: string;
  key: string;
  name: string;
  statement: string;
};

type Props = {
  clubId: string;
  accountId: string;
  accountNumber: string;
  accountName: string;
  currentFsGroupLabel: string | null;
  availableGroups: ReadonlyArray<GroupOption>;
  onClose: () => void;
};

export function InspectorReassignFsGroupDrawer({
  clubId,
  accountId,
  accountNumber,
  accountName,
  currentFsGroupLabel,
  availableGroups,
  onClose,
}: Props) {
  const router = useRouter();
  const [targetId, setTargetId] = useState<string>("");
  const [preview, setPreview] = useState<MappingPreviewResult | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "ready" | "applying" | "error">("idle");
  const [errorText, setErrorText] = useState<string | null>(null);
  const [confirmWarnings, setConfirmWarnings] = useState(false);

  const grouped = useMemo(() => {
    const g: Record<string, GroupOption[]> = { INCOME_STATEMENT: [], BALANCE_SHEET: [], CASH_FLOW: [] };
    for (const opt of availableGroups) {
      (g[opt.statement] ?? (g[opt.statement] = [])).push(opt);
    }
    return g;
  }, [availableGroups]);

  useEffect(() => {
    if (!targetId) {
      setPreview(null);
      setState("idle");
      return;
    }
    let cancelled = false;
    setState("loading");
    setErrorText(null);
    setConfirmWarnings(false);
    (async () => {
      try {
        const res = await fetch("/api/admin/coa-mapping/preview", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ clubId, accountId, targetFsGroupId: targetId }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({ error: res.statusText }));
          throw new Error(body.error ?? "Preview failed");
        }
        const data = (await res.json()) as MappingPreviewResult;
        if (!cancelled) {
          setPreview(data);
          setState("ready");
        }
      } catch (e) {
        if (!cancelled) {
          setErrorText(e instanceof Error ? e.message : "Preview failed");
          setState("error");
        }
      }
    })();
    return () => { cancelled = true; };
  }, [targetId, clubId, accountId]);

  async function onApply(effectiveFromISO: string) {
    setState("applying");
    setErrorText(null);
    try {
      const res = await fetch(`/api/admin/coa-mapping/accounts/${accountId}/reassign`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clubId,
          targetFsGroupId: targetId,
          effectiveFrom: effectiveFromISO,
          acknowledgeWarnings: confirmWarnings,
        }),
      });
      const body = await res.json().catch(() => ({ error: res.statusText }));
      if (res.status === 409) {
        setErrorText("BLOCKED: " + (body.validation?.reasons?.[0]?.message ?? body.error ?? "Reassignment blocked."));
        setState("error");
        return;
      }
      if (res.status === 422) {
        setErrorText("WARNING: " + (body.validation?.reasons?.[0]?.message ?? "Review the warning and confirm to proceed."));
        setConfirmWarnings(true);
        setState("ready");
        return;
      }
      if (!res.ok) {
        setErrorText(body.error ?? "Reassignment failed");
        setState("error");
        return;
      }
      router.refresh();
      onClose();
    } catch (e) {
      setErrorText(e instanceof Error ? e.message : "Reassignment failed");
      setState("error");
    }
  }

  const today = new Date();
  const currentPeriodStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
  const fiscalYearStart = new Date(Date.UTC(today.getUTCFullYear(), 0, 1));
  const currentPeriodIso = currentPeriodStart.toISOString().slice(0, 10);
  const fiscalYearIso = fiscalYearStart.toISOString().slice(0, 10);
  const todayIso = today.toISOString().slice(0, 10);

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-end p-6"
      role="dialog"
      aria-modal="true"
      aria-label="Reassign Financial Statement Group"
      data-testid="coa-inspector-reassign-fsgroup-drawer"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="absolute inset-0 bg-stone-900/20 pointer-events-none" aria-hidden />
      <div className="relative z-10 w-full max-w-md space-y-3" onClick={(e) => e.stopPropagation()}>
        {/* Group picker — top */}
        <section className="card" data-testid="coa-inspector-reassign-picker">
          <div className="card-body space-y-3">
            <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-stone-500">
              Reassign Financial Statement Group
            </h2>
            <div className="text-xs text-stone-500">
              <span className="font-mono tabular-nums">{accountNumber}</span>
              {" · "}
              {accountName}
            </div>
            <div className="text-xs">
              <span className="text-stone-500">Current:</span>{" "}
              <span className="text-stone-900">{currentFsGroupLabel ?? "Unmapped"}</span>
            </div>
            <label className="block text-xs text-stone-600">
              Move to
              <select
                className="mt-1 block w-full rounded border border-stone-200 bg-white px-2 py-1 text-sm"
                value={targetId}
                onChange={(e) => setTargetId(e.target.value)}
                data-testid="coa-inspector-reassign-target"
              >
                <option value="">— pick a group —</option>
                {(["INCOME_STATEMENT", "BALANCE_SHEET", "CASH_FLOW"] as const).map((stmt) => {
                  const list = grouped[stmt] ?? [];
                  if (list.length === 0) return null;
                  return (
                    <optgroup key={stmt} label={labelForStatement(stmt)}>
                      {list.map((g) => (
                        <option key={g.id} value={g.id}>{g.name}</option>
                      ))}
                    </optgroup>
                  );
                })}
              </select>
            </label>
            {state === "loading" && (
              <p className="text-xs text-stone-500">Loading reporting impact…</p>
            )}
            {state === "error" && !preview && (
              <p className="text-xs text-rose-700" data-testid="coa-inspector-reassign-error">
                {errorText ?? "Preview failed."}
              </p>
            )}
          </div>
        </section>

        {/* Shared canonical preview — bottom */}
        {preview && (
          <MappingPreviewPanel
            preview={preview}
            errorText={errorText}
            confirmWarnings={confirmWarnings}
            applying={state === "applying"}
            currentPeriodIso={currentPeriodIso}
            fiscalYearIso={fiscalYearIso}
            todayIso={todayIso}
            onApply={onApply}
            onCancel={onClose}
            testid="coa-inspector-reassign-preview"
          />
        )}

        {!preview && (
          <div className="flex justify-end">
            <button
              type="button"
              className="btn-secondary"
              onClick={onClose}
              data-testid="coa-inspector-reassign-close"
            >
              Close
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
