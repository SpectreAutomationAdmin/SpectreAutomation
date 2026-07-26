"use client";

// Per-group resend control for the closed-check history's split-bill
// sub-rows. Wraps `resendGroupReceiptEmailAction` and renders inline
// status text — disabled with a clear reason when the group cannot be
// resent (no email on file, QR_PAY, no sale, voided check). Suppression
// status is only known after the adapter call, so the click goes
// through and we surface the SUPPRESSED outcome inline.

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { resendGroupReceiptEmailAction } from "../_actions";

export function GroupResendReceiptButton({
  groupId,
  disabledReason,
}: {
  groupId: string;
  // Pre-computed disabled-reason text. When set, the button renders
  // disabled and shows this as the inline status — no click required.
  // null = button is active.
  disabledReason: string | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [inline, setInline] = useState<string | null>(null);

  function onClick() {
    if (disabledReason) return;
    setInline(null);
    startTransition(async () => {
      const r = await resendGroupReceiptEmailAction(groupId);
      if (!r.ok) {
        setInline(`Failed: ${r.error}`);
        return;
      }
      const s = r.data.status;
      const addr = r.data.address ?? "";
      const masked = addr ? maskInline(addr) : "";
      if (s === "SENT") setInline(`Receipt resent to ${masked}.`);
      else if (s === "DEV_LOGGED") setInline(`Logged in dev — ${masked}.`);
      else if (s === "SKIPPED_NO_EMAIL") setInline("Cannot resend: member has no email on file.");
      else if (s === "SUPPRESSED") setInline(`Cannot resend: email address is suppressed.`);
      else if (s === "FAILED") setInline(`Receipt resend failed — ${r.data.failureReason ?? "provider error"}.`);
      router.refresh();
    });
  }

  return (
    <div className="inline-flex flex-col items-end gap-0.5">
      <button
        type="button"
        onClick={onClick}
        disabled={pending || !!disabledReason}
        className="text-[11px] text-club-green-700 hover:underline disabled:text-stone-400 disabled:no-underline"
      >
        {pending ? "Resending…" : "Resend receipt"}
      </button>
      {(inline ?? disabledReason) && (
        <span className="text-[10px] text-stone-500 max-w-[14rem] text-right">
          {inline ?? disabledReason}
        </span>
      )}
    </div>
  );
}

// Local mask helper — kept here so the button component does not reach
// into the receipts service layer.
function maskInline(email: string): string {
  const [name, host] = email.split("@");
  if (!host) return email;
  return `${name.slice(0, 1)}${"*".repeat(Math.max(2, name.length - 1))}@${host}`;
}
