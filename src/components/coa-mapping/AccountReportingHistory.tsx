"use client";

// COA-MAP-3 (2026-10-07) — Reporting-history timeline rendered inside
// the COA Account Inspector.  Fetches the canonical
// `/api/admin/coa-mapping/accounts/{id}/history` endpoint and
// renders every effective-dated AccountFinancialStatementAssignment
// row as a line: "<FS Group name> · <date range> · <reporting role>".
//
// This replaces the Mapping-Studio-side "Reporting history" block so
// Controllers do not lose the view when the Mapping Studio is
// retired in Phase B.

import { useEffect, useState } from "react";
import {
  labelForReportingRole,
  isReportingRole,
} from "@/lib/coa-mapping/reporting-role";

type HistoryRow = {
  fsGroupId: string;
  fsGroupName: string;
  statement: string;
  reportingRole: string | null;
  effectiveFrom: string;
  effectiveTo: string | null;
};

export function AccountReportingHistory({
  clubId,
  accountId,
}: {
  clubId: string;
  accountId: string;
}) {
  const [history, setHistory] = useState<ReadonlyArray<HistoryRow>>([]);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    let cancelled = false;
    setState("loading");
    setHistory([]);
    fetch(`/api/admin/coa-mapping/accounts/${accountId}/history?clubId=${encodeURIComponent(clubId)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("history fetch failed"))))
      .then((data) => {
        if (!cancelled) {
          setHistory((data.history as HistoryRow[]) ?? []);
          setState("ready");
        }
      })
      .catch(() => { if (!cancelled) setState("error"); });
    return () => { cancelled = true; };
  }, [clubId, accountId]);

  if (state === "loading") {
    return (
      <p
        style={{ fontSize: 12.5, color: "var(--spectre-text-muted)", lineHeight: "18px" }}
        data-testid="coa-inspector-mapping-history-loading"
      >
        Loading mapping history…
      </p>
    );
  }
  if (state === "error") {
    return (
      <p
        style={{ fontSize: 12.5, color: "var(--spectre-status-error)", lineHeight: "18px" }}
        data-testid="coa-inspector-mapping-history-error"
      >
        Mapping history could not be loaded.
      </p>
    );
  }
  if (history.length === 0) {
    return (
      <p
        style={{ fontSize: 12.5, color: "var(--spectre-text-secondary)", lineHeight: "18px" }}
        data-testid="coa-inspector-mapping-history-empty"
      >
        No historical mapping has been recorded for this account yet.
      </p>
    );
  }

  return (
    <section
      data-testid="coa-inspector-mapping-history"
      style={{ display: "flex", flexDirection: "column", gap: 10 }}
    >
      <h4
        style={{
          fontSize: 10.5, letterSpacing: "0.12em", textTransform: "uppercase",
          color: "var(--spectre-text-muted)", fontWeight: 700, margin: 0,
        }}
      >
        Reporting history
      </h4>
      <ol
        style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 8 }}
      >
        {history.map((h, i) => (
          <li
            key={`${h.fsGroupId}-${h.effectiveFrom}-${i}`}
            data-testid="coa-inspector-mapping-history-row"
            style={{
              padding: "8px 10px",
              borderRadius: 4,
              background: "var(--spectre-surface-hover)",
              border: "1px solid var(--spectre-border-hairline)",
              fontSize: 12.5,
              color: "var(--spectre-text-primary)",
              lineHeight: 1.3,
            }}
          >
            <div style={{ fontWeight: 600 }}>{h.fsGroupName}</div>
            <div style={{ fontSize: 11, color: "var(--spectre-text-secondary)" }}>
              {formatRange(h.effectiveFrom, h.effectiveTo)}
              {h.reportingRole && isReportingRole(h.reportingRole) && (
                <> · {labelForReportingRole(h.reportingRole)}</>
              )}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

function formatRange(fromISO: string, toISO: string | null): string {
  const pretty = (iso: string) => {
    const [y, m, d] = iso.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(undefined, {
      year: "numeric", month: "short", day: "numeric", timeZone: "UTC",
    });
  };
  return `${pretty(fromISO)} – ${toISO ? pretty(toISO) : "Present"}`;
}
