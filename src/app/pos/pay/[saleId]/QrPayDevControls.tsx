"use client";

// Dev / training simulator buttons that drive the QR payment
// lifecycle for a sale. Only mounted when NODE_ENV !== "production".
// Posts to a small public endpoint that uses the
// `principalForSaleConfirmation()` helper to attribute the AR/GL
// post to whoever originally opened the sale.

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

export function QrPayDevControls({ saleId }: { saleId: string }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  function send(action: "CONFIRM" | "DECLINE" | "EXPIRE") {
    setError(null);
    startTransition(async () => {
      try {
        const res = await fetch(`/api/pos/pay/${saleId}/${action.toLowerCase()}`, {
          method: "POST",
        });
        if (!res.ok) {
          const j = await res.json().catch(() => ({}));
          setError(j.error ?? `Simulator action failed (${res.status})`);
          return;
        }
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    });
  }

  return (
    <div className="mt-6 rounded-md border-2 border-dashed border-amber-300 bg-amber-50 p-4">
      <div className="text-[10px] uppercase tracking-widest text-amber-700 font-medium text-center">
        Development only · payment simulator
      </div>
      <p className="mt-1 text-[11px] text-stone-600 text-center">
        These buttons aren&rsquo;t shown in production. They drive the gateway lifecycle so the lounge POS flow can be tested without a real processor.
      </p>
      {error && (
        <div className="mt-3 rounded-md border border-red-300 bg-red-50 px-2 py-1.5 text-xs text-red-800">{error}</div>
      )}
      <div className="mt-4 grid grid-cols-1 gap-2">
        <button
          type="button"
          className="btn btn-primary w-full disabled:opacity-50"
          onClick={() => send("CONFIRM")}
          disabled={pending}
        >
          Simulate confirmed payment
        </button>
        <button
          type="button"
          className="btn btn-secondary w-full disabled:opacity-50"
          onClick={() => send("DECLINE")}
          disabled={pending}
        >
          Simulate declined payment
        </button>
        <button
          type="button"
          className="btn btn-secondary w-full disabled:opacity-50"
          onClick={() => send("EXPIRE")}
          disabled={pending}
        >
          Simulate expired window
        </button>
      </div>
    </div>
  );
}
