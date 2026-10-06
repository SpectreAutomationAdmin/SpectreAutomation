"use client";

// COA-MAP-2B (2026-10-06) — the drawer that opens when a Controller
// drops an account onto a Financial Statement Group HEADER from the
// Chart of Accounts Account List.  It:
//
//   1. fetches the shared /api/admin/coa-mapping/preview endpoint,
//   2. mounts the canonical <MappingPreviewPanel>,
//   3. on Apply, calls the shared
//      /api/admin/coa-mapping/accounts/{id}/reassign endpoint.
//
// There is one canonical mapping backend; this drawer is only a UI
// shell around the same preview + reassign calls the Mapping Studio
// uses.  No new validation.  No new effective-date model.  No new
// audit trail.

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  MappingPreviewPanel,
  type MappingPreviewResult,
} from "@/components/coa-mapping/MappingPreviewPanel";

type Props = {
  clubId: string;
  accountId: string;
  targetFsGroupId: string;
  onClose: () => void;
};

export function AccountListMappingDrawer({ clubId, accountId, targetFsGroupId, onClose }: Props) {
  const router = useRouter();
  const [preview, setPreview] = useState<MappingPreviewResult | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "applying" | "error">("loading");
  const [errorText, setErrorText] = useState<string | null>(null);
  const [confirmWarnings, setConfirmWarnings] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setState("loading");
      setErrorText(null);
      try {
        const res = await fetch("/api/admin/coa-mapping/preview", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ clubId, accountId, targetFsGroupId }),
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
  }, [clubId, accountId, targetFsGroupId]);

  async function onApply(effectiveFromISO: string) {
    setState("applying");
    setErrorText(null);
    try {
      const res = await fetch(`/api/admin/coa-mapping/accounts/${accountId}/reassign`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clubId,
          targetFsGroupId,
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
      aria-label="Reporting impact preview"
      data-testid="coa-mapping-drawer"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      {/* Scrim */}
      <div className="absolute inset-0 bg-stone-900/20 pointer-events-none" aria-hidden />
      {/* Drawer */}
      <div className="relative z-10 w-full max-w-md" onClick={(e) => e.stopPropagation()}>
        {state === "loading" && (
          <section className="card" data-testid="coa-mapping-drawer-loading">
            <div className="card-body text-sm text-stone-500">Loading reporting impact…</div>
          </section>
        )}
        {state === "error" && !preview && (
          <section className="card">
            <div className="card-body space-y-2">
              <div className="text-sm text-rose-700" data-testid="coa-mapping-drawer-error">
                {errorText ?? "Preview failed."}
              </div>
              <button type="button" className="btn-secondary" onClick={onClose}>Close</button>
            </div>
          </section>
        )}
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
            testid="coa-mapping-drawer-preview"
          />
        )}
      </div>
    </div>
  );
}
