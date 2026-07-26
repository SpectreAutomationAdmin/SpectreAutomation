"use client";

// Founder rule 2026-06-30 v14.4 — client-side flash-cookie sweep.
//
// The imports page reads spectre_import_error + spectre_import_notice
// in its Server Component render (allowed) but cannot delete them
// there (prohibited by Next.js). This component mounts alongside
// the visible notice and, on first mount, fires a POST to
// /app/admin/imports/clear-flash — a Route Handler that CAN
// mutate cookies. Result: the notice displays exactly once, then
// the cookies clear before the next page load.
//
// Renders nothing (returns null); its only job is the side-effect.

import { useEffect } from "react";

export function FlashClear() {
  useEffect(() => {
    // Fire-and-forget. If the request fails (offline, blocked),
    // the flash cookies expire naturally after 30 s so the user
    // never sees a stale notice on the next real navigation.
    void fetch("/app/admin/imports/clear-flash", {
      method: "POST",
      credentials: "include",
    }).catch(() => {
      // Intentionally swallowed. See note above.
    });
  }, []);
  return null;
}
