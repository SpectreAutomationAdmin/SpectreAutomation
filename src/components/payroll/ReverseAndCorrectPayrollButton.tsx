"use client";

// FPP-9B (2026-09-22) — Reverse & Correct Payroll action.
//
// Appears on the POSTED payroll banner alongside "Reverse Posted Payroll".
// Opens a modal that explains the three-transaction chain:
//   ORIGINAL (preserved) → REVERSAL (approved + posted) → CORRECTION (edited + posted)
// Requires a persisted correction reason. After confirmation, calls the
// initiate API which creates both the reversal and the seeded correction.

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

export default function ReverseAndCorrectPayrollButton({ batchId }: { batchId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<null | { text: string; tone: "info" | "error" }>(null);
  const [pending, startTransition] = useTransition();

  async function onSubmit() {
    if (busy || pending) return;
    const trimmed = reason.trim();
    if (!trimmed) {
      setMessage({ text: "Please describe why the payroll is being corrected.", tone: "error" });
      return;
    }
    setBusy(true);
    setMessage(null);
    startTransition(async () => {
      try {
        const res = await fetch("/api/mission-control/payroll-correction/initiate", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ originalBatchId: batchId, reason: trimmed }),
        });
        const body = await res.json().catch(() => ({}));
        if (res.ok && body.ok) {
          setOpen(false);
          setReason("");
          router.refresh();
        } else {
          setMessage({
            text: body.message ?? `Reverse & Correct initiation refused (${res.status}).`,
            tone: "error",
          });
        }
      } finally {
        setBusy(false);
      }
    });
  }

  return (
    <>
      <button
        type="button"
        onClick={() => { setOpen(true); setMessage(null); }}
        data-testid="payroll-admin-reverse-and-correct"
        className="inline-flex items-center gap-1 rounded-md border border-stone-400 px-3 py-1.5 text-[12px] font-semibold text-stone-100 hover:bg-stone-800"
      >
        Reverse &amp; Correct Payroll
      </button>
      {open && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="payroll-admin-correct-title"
          data-testid="payroll-admin-correct-dialog"
          style={{
            position: "fixed", inset: 0, background: "rgba(15, 23, 42, 0.42)",
            display: "flex", alignItems: "center", justifyContent: "center", zIndex: 60,
          }}
          onClick={(e) => { if (e.target === e.currentTarget && !busy) { setOpen(false); setMessage(null); } }}
        >
          <div style={{
            background: "#ffffff", borderRadius: 10, width: "100%", maxWidth: 560,
            margin: "0 16px", padding: 22, boxShadow: "0 24px 44px rgba(15,23,42,0.18)",
            maxHeight: "88vh", overflowY: "auto",
          }}>
            <h2 id="payroll-admin-correct-title"
              style={{ margin: 0, fontSize: 17, fontWeight: 700, color: "#1c1917", letterSpacing: -0.005 }}>
              Reverse &amp; Correct payroll
            </h2>
            <p style={{ margin: "10px 0 12px 0", fontSize: 13, lineHeight: 1.55, color: "#44403c" }}>
              Spectre will <strong>preserve the original payroll</strong>, create a full reversal after Controller
              approval, and then create a separate corrected payroll for review and approval.
              The three transactions — <em>original, reversal, correction</em> — remain independently auditable.
            </p>
            <p style={{ margin: "0 0 12px 0", fontSize: 12.5, lineHeight: 1.55, color: "#57534e" }}>
              A Controller must approve BOTH the reversal AND the correction separately. Reverse &amp; Correct
              does not transmit money or recall employee payments — payment transmission remains external and manual.
            </p>
            <label htmlFor="payroll-admin-correct-reason"
              style={{ display: "block", marginTop: 8, fontSize: 11.5, fontWeight: 700,
                color: "#78716c", textTransform: "uppercase", letterSpacing: 0.06 }}>
              Correction reason
            </label>
            <textarea
              id="payroll-admin-correct-reason"
              data-testid="payroll-admin-correct-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              disabled={busy}
              rows={3}
              maxLength={1000}
              placeholder="e.g. Incorrect salary · missed earning · wrong allowance · employee inclusion error"
              style={{ width: "100%", marginTop: 4, padding: "8px 10px",
                borderRadius: 6, border: "1px solid #e7e5e4",
                fontSize: 13, fontFamily: "inherit", resize: "vertical" }}
            />
            {message ? (
              <p data-testid="payroll-admin-correct-message"
                style={{ margin: "10px 0 0 0", padding: "8px 10px", borderRadius: 6, fontSize: 12.5,
                  background: message.tone === "error" ? "#fef2f2" : "#eff6ff",
                  color: message.tone === "error" ? "#b91c1c" : "#1e40af" }}>
                {message.text}
              </p>
            ) : null}
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 }}>
              <button type="button"
                onClick={() => { setOpen(false); setMessage(null); }}
                disabled={busy}
                data-testid="payroll-admin-correct-cancel"
                style={{ padding: "8px 16px", fontSize: 13, border: "1px solid #d0c9bd",
                  background: "transparent", borderRadius: 6, cursor: busy ? "wait" : "pointer" }}>
                Cancel
              </button>
              <button type="button"
                onClick={onSubmit}
                disabled={busy || !reason.trim()}
                data-testid="payroll-admin-correct-submit"
                style={{ padding: "8px 16px", fontSize: 13, fontWeight: 600, border: 0,
                  background: busy || !reason.trim() ? "rgba(15,95,63,0.6)" : "#0f5f3f",
                  color: "#fff", borderRadius: 6,
                  cursor: busy || !reason.trim() ? "not-allowed" : "pointer" }}>
                {busy ? "Initiating…" : "Initiate Reverse & Correct"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
