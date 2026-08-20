"use client";

// HR-2B.5 §31 — Auto-submit the handoff form so most employees don't
// even see the intermediate page. If JS is disabled the submit
// button remains as a visible fallback.

import { useEffect, useRef } from "react";

export default function HandoffAutoSubmit() {
  const ref = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    const btn = ref.current?.form?.querySelector<HTMLButtonElement>('button[type="submit"]');
    if (btn) btn.click();
  }, []);
  return <input ref={ref} type="hidden" name="auto" value="1" />;
}
