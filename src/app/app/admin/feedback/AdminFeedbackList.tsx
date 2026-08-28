"use client";

import { useState } from "react";
import type { AnonymousFeedbackView, FeedbackStatus } from "@/lib/anonymous-feedback";

interface Props {
  clubId: string;
  initial: AnonymousFeedbackView[];
}

export default function AdminFeedbackList({ clubId, initial }: Props) {
  const [rows, setRows] = useState<AnonymousFeedbackView[]>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const setStatus = async (id: string, status: FeedbackStatus) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/clubs/${clubId}/anonymous-feedback/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      if (!res.ok) throw new Error(await res.text());
      const body = (await res.json()) as { feedback: AnonymousFeedbackView };
      setRows((prev) => prev.map((r) => (r.id === id ? body.feedback : r)));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (rows.length === 0) {
    return (
      <div className="text-sm text-stone-600" data-testid="admin-feedback-empty">
        No employee feedback yet. When an employee submits anonymous feedback it will appear here.
      </div>
    );
  }

  return (
    <div data-testid="admin-feedback-list">
      {error && (
        <p role="alert" className="text-sm text-red-700 mb-3">{error}</p>
      )}
      <ul className="divide-y divide-stone-200/70">
        {rows.map((r) => (
          <li key={r.id} className="py-4" data-testid={`admin-feedback-row-${r.id}`}>
            <div className="flex items-baseline gap-3 flex-wrap">
              <StatusPill status={r.status} />
              {r.category && (
                <span className="text-[10px] uppercase tracking-widest text-stone-500 border border-stone-300 rounded px-1.5 py-0.5">
                  {r.category}
                </span>
              )}
              <span className="text-[11.5px] text-stone-500">
                {formatDateTime(r.createdAt)}
                {r.reviewedAt && ` · reviewed ${formatDateTime(r.reviewedAt)}`}
              </span>
            </div>
            <p className="text-[14px] text-stone-800 whitespace-pre-wrap mt-2">
              {r.message}
            </p>
            <div className="mt-2 flex items-center gap-2 flex-wrap">
              {r.status !== "REVIEWED" && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setStatus(r.id, "REVIEWED")}
                  className="spectre-btn spectre-btn--secondary"
                  data-testid={`admin-feedback-review-${r.id}`}
                >
                  Mark reviewed
                </button>
              )}
              {r.status !== "ARCHIVED" && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setStatus(r.id, "ARCHIVED")}
                  className="text-sm text-stone-600 hover:underline"
                  data-testid={`admin-feedback-archive-${r.id}`}
                >
                  Archive
                </button>
              )}
              {r.status === "ARCHIVED" && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setStatus(r.id, "NEW")}
                  className="text-sm text-stone-600 hover:underline"
                  data-testid={`admin-feedback-unarchive-${r.id}`}
                >
                  Restore
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function StatusPill({ status }: { status: FeedbackStatus }) {
  const cls = status === "NEW"
    ? "bg-amber-50 text-amber-800 border-amber-300"
    : status === "REVIEWED"
      ? "bg-emerald-50 text-emerald-800 border-emerald-300"
      : "bg-stone-100 text-stone-500 border-stone-300";
  return (
    <span className={`text-[10px] uppercase tracking-widest rounded px-1.5 py-0.5 border ${cls}`}>
      {status}
    </span>
  );
}

function formatDateTime(d: Date | string) {
  return new Date(d).toLocaleString(undefined, {
    year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
}
