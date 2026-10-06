"use client";

// GOLF-HIST-1 (2026-10-05) — commit button for a Golf Activity batch.

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function GolfActivityCommitForm(props: {
  batchId: string;
  clubId: string;
  disabled: boolean;
  committed: boolean;
  reasonBlocked: string | null;
}) {
  const router = useRouter();
  const [state, setState] = useState<"idle" | "working" | "ok" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  async function onCommit() {
    const confirmed = window.confirm(
      "Commit will write authoritative GolfActivityDay rows and activate the Weather × Golf cards in Section XI. Proceed?",
    );
    if (!confirmed) return;
    setState("working");
    setError(null);
    try {
      const form = new FormData();
      form.append("clubId", props.clubId);
      form.append("action", "commit");
      form.append("batchId", props.batchId);
      const res = await fetch("/api/admin/golf-activity-import", { method: "POST", body: form });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(body.error ?? "Commit failed.");
      }
      setState("ok");
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Commit failed.");
      setState("error");
    }
  }

  if (props.committed) {
    return (
      <div className="text-sm text-emerald-700" data-testid="golf-batch-committed-state">
        Committed. Section XI consumes this batch for the covered period.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <button
        onClick={onCommit}
        className="btn-primary"
        disabled={props.disabled || state === "working"}
        data-testid="golf-batch-commit-button"
      >
        {state === "working" ? "Committing…" : "Commit batch"}
      </button>
      {props.reasonBlocked && (
        <div className="text-xs text-stone-500" data-testid="golf-batch-commit-blocked-reason">
          Blocked: {props.reasonBlocked}
        </div>
      )}
      {error && (
        <div className="text-xs text-rose-600" data-testid="golf-batch-commit-error">
          {error}
        </div>
      )}
    </div>
  );
}
