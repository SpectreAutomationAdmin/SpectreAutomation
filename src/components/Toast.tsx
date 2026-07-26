"use client";

import { useEffect, useState } from "react";
import { useSearchParams, useRouter, usePathname } from "next/navigation";

// URL-driven toast. Server actions redirect with ?error=… or ?ok=…; this
// component reads the param, renders a dismissible toast, and strips the
// param from the URL so a refresh doesn't re-show it.
export function Toast() {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const [visible, setVisible] = useState(true);

  const error = params.get("error");
  const ok = params.get("ok");

  useEffect(() => {
    if (!error && !ok) return;
    setVisible(true);
    const t = setTimeout(() => {
      setVisible(false);
      // Strip params from URL without a new history entry.
      const next = new URLSearchParams(params.toString());
      next.delete("error");
      next.delete("ok");
      router.replace(pathname + (next.toString() ? `?${next.toString()}` : ""), { scroll: false });
    }, 6000);
    return () => clearTimeout(t);
  }, [error, ok, params, pathname, router]);

  if (!visible) return null;
  if (!error && !ok) return null;

  const isError = !!error;
  return (
    <div className="fixed bottom-6 right-6 z-50 max-w-sm">
      <div
        role="status"
        className={
          "rounded-md border px-4 py-3 text-sm shadow-elevated " +
          (isError
            ? "bg-red-50 border-red-200 text-red-800"
            : "bg-club-green-50 border-club-green-200 text-club-green-800")
        }
      >
        {isError ? error : ok}
      </div>
    </div>
  );
}
