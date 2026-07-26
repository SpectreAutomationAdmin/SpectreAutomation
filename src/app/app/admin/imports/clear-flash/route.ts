// Founder rule 2026-06-30 v14.4 — flash-cookie cleanup route.
//
// The `/app/admin/imports` page renders in a Server Component,
// and Next.js prohibits `cookies().delete(...)` in that context.
// The FlashClear client component POSTs to this route after
// mount, which IS a valid cookie-mutation context — Route
// Handlers may set / delete cookies freely.
//
// Both flash cookies expire after 30 s regardless (they're set
// with `maxAge: 30` in the server action), so this handler is
// belt-and-suspenders: it clears them immediately after the
// user sees the notice, and the natural expiry catches any case
// where the client couldn't reach this route (offline, etc.).

import { cookies } from "next/headers";
import { NextResponse } from "next/server";

// Founder rule 2026-07-01 v14.20 — the batch-detail page also
// reads `spectre_import_success` (set by commitAction and by the
// COA-replacement flow). It used to delete that cookie in its own
// Server Component render, which Next.js rejects with "Cookies
// can only be modified in a Server Action or Route Handler." The
// safe pattern is to let this route clear it too — same
// belt-and-suspenders posture as the other flash cookies, and
// same 30 s natural expiry backup.
const FLASH_COOKIES = [
  "spectre_import_error",
  "spectre_import_notice",
  "spectre_import_success",
] as const;

export async function POST() {
  const jar = cookies();
  for (const name of FLASH_COOKIES) {
    jar.delete(name);
  }
  return NextResponse.json({ cleared: FLASH_COOKIES.length });
}
