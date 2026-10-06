"use client";

// GOLF-HIST-1 (2026-10-05) — Golf Activity importer client form.
//
// Upload → preview → reconcile → wait for founder commit. The commit
// action is INTENTIONALLY NOT exposed on this form — the founder
// performs the first real commit after reviewing the preview page.

import { useState } from "react";
import { useRouter } from "next/navigation";

type PreviewResponse = {
  batch: {
    id: string;
    status: string;
    reportingPeriodStart: string;
    reportingPeriodEnd: string;
    rowCount: number;
    activeDays: number;
    realZeroDays: number;
    conflictCount: number;
    warningCount: number;
    reconciliationStatus: string;
    sourceTotals: {
      guests: number | null;
      greenFees: number | null;
      members: number | null;
      total: number | null;
      juniors: number | null;
      women: number | null;
    };
    parsedTotals: {
      guests: number;
      greenFees: number;
      members: number;
      total: number;
      juniors: number;
      women: number;
    };
  };
};

export default function GolfActivityImportForm({ clubId }: { clubId: string }) {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [state, setState] = useState<"idle" | "uploading" | "ok" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<PreviewResponse | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!file) {
      setError("Choose a file first.");
      setState("error");
      return;
    }
    setState("uploading");
    setError(null);
    try {
      const form = new FormData();
      form.append("clubId", clubId);
      form.append("action", "preview");
      form.append("file", file);
      const res = await fetch("/api/admin/golf-activity-import", { method: "POST", body: form });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(body.error ?? "Upload failed.");
      }
      const data = (await res.json()) as PreviewResponse;
      setResult(data);
      setState("ok");
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed.");
      setState("error");
    }
  }

  return (
    <section className="card" data-testid="golf-activity-import-form">
      <div className="card-body space-y-3">
        <h2 className="section-title text-lg">Upload monthly source</h2>
        <p className="text-xs text-stone-500">
          Supported source today: GGGolf Daily Report PDF (one calendar month per file).
          Spectre never commits uploaded data automatically; preview the parsed rows
          and reconciliation on the next screen, then ask the founder to commit.
        </p>
        <form onSubmit={onSubmit} className="flex flex-col gap-3" data-testid="golf-activity-import-upload">
          <input
            type="file"
            accept=".pdf,application/pdf"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            data-testid="golf-activity-import-file"
            className="text-sm"
          />
          <div>
            <button
              type="submit"
              className="btn-primary"
              disabled={!file || state === "uploading"}
              data-testid="golf-activity-import-submit"
            >
              {state === "uploading" ? "Parsing…" : "Preview"}
            </button>
          </div>
        </form>
        {error && (
          <div className="text-sm text-rose-600" data-testid="golf-activity-import-error">
            {error}
          </div>
        )}
        {result && (
          <div className="mt-4 border-t pt-4 space-y-2" data-testid="golf-activity-import-result">
            <div className="text-sm">
              Batch{" "}
              <a
                className="link"
                href={`/app/admin/imports/golf-activity/${result.batch.id}`}
                data-testid="golf-activity-import-preview-link"
              >
                {result.batch.id}
              </a>{" "}
              ready for review.
            </div>
            <div className="text-xs text-stone-500">
              Period {result.batch.reportingPeriodStart} → {result.batch.reportingPeriodEnd} ·{" "}
              {result.batch.rowCount} daily rows ·{" "}
              {result.batch.activeDays} active · {result.batch.realZeroDays} zero ·{" "}
              reconciliation: <strong>{result.batch.reconciliationStatus}</strong>
              {result.batch.conflictCount > 0 && (
                <span className="text-rose-600"> · {result.batch.conflictCount} conflict(s)</span>
              )}
              {result.batch.warningCount > 0 && (
                <span className="text-amber-700"> · {result.batch.warningCount} warning(s)</span>
              )}
            </div>
            <table className="table-base w-full text-xs" data-testid="golf-activity-import-totals">
              <thead>
                <tr>
                  <th className="text-left">Metric</th>
                  <th className="text-right">Source</th>
                  <th className="text-right">Parsed</th>
                  <th className="text-right">Δ</th>
                </tr>
              </thead>
              <tbody>
                {(
                  [
                    { key: "guests",    label: "Guests" },
                    { key: "greenFees", label: "Green Fees" },
                    { key: "members",   label: "Members" },
                    { key: "total",     label: "Total" },
                    { key: "juniors",   label: "Juniors" },
                    { key: "women",     label: "Women" },
                  ] as const
                ).map((row) => {
                  const src = result.batch.sourceTotals[row.key];
                  const parsed = result.batch.parsedTotals[row.key];
                  const delta = src == null ? null : parsed - src;
                  return (
                    <tr key={row.key} data-testid={`golf-reconcile-${row.key}`}>
                      <td className="text-left">{row.label}</td>
                      <td className="text-right tabular-nums">{src ?? "—"}</td>
                      <td className="text-right tabular-nums">{parsed}</td>
                      <td className={`text-right tabular-nums ${delta !== 0 && delta != null ? "text-rose-600" : ""}`}>
                        {delta == null ? "—" : delta === 0 ? "0" : delta > 0 ? `+${delta}` : `${delta}`}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}
