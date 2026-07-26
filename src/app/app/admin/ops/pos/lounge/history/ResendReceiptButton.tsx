"use client";

// Resend a receipt email from the closed-check history. Calls the
// server action and surfaces the new status inline — the page itself
// is server-rendered, so we don't auto-refresh; a router.refresh()
// after the action picks up the updated POSCheck.receiptEmailStatus.

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { resendReceiptEmailAction } from "../_actions";

export function ResendReceiptButton({
  checkId,
  disabled,
}: {
  checkId: string;
  disabled?: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [inline, setInline] = useState<string | null>(null);

  function onClick() {
    setInline(null);
    startTransition(async () => {
      const r = await resendReceiptEmailAction(checkId);
      if (!r.ok) {
        setInline(`Failed: ${r.error}`);
        return;
      }
      const s = r.data.status;
      if (s === "SENT") setInline(`Sent → ${r.data.address ?? ""}`);
      else if (s === "DEV_LOGGED") setInline(`Logged in dev → ${r.data.address ?? ""}`);
      else if (s === "SKIPPED_NO_EMAIL") setInline("No email on file");
      else if (s === "SUPPRESSED") setInline(`Suppressed: ${r.data.failureReason ?? ""}`);
      else if (s === "FAILED") setInline(`Failed: ${r.data.failureReason ?? ""}`);
      router.refresh();
    });
  }

  return (
    <div className="inline-flex flex-col items-end gap-0.5">
      <button
        type="button"
        onClick={onClick}
        disabled={disabled || pending}
        className="text-[11px] text-club-green-700 hover:underline disabled:text-stone-400 disabled:no-underline"
      >
        {pending ? "Resending…" : "Resend receipt"}
      </button>
      {inline && (
        <span className="text-[10px] text-stone-500">{inline}</span>
      )}
    </div>
  );
}
