// Sprint 3 · Checkpoint 15P-5 — RETIRED.
//
// The preview logic moved to a plain POST API route at
// `/api/mission-control/ap-preview` (src/app/api/mission-control/
// ap-preview/route.ts). Server actions rehash their id on every
// deploy, which produced the founder-observed "Preview unavailable"
// state whenever the browser session predated the current deploy.
// The API route uses a stable URL and does not suffer from
// hash-versioning.
//
// This file remains as an explicit throw so any stale client bundle
// that still targets the retired action gets a loud, actionable
// server error rather than an "undefined" pointer that produces
// "Cannot read properties of undefined (reading 'ok')".

"use server";

export async function previewApEntryAction(): Promise<never> {
  throw new Error(
    "previewApEntryAction was retired in Sprint 3 · Checkpoint 15P-5. " +
    "The preview now uses POST /api/mission-control/ap-preview. " +
    "Refresh the page to load the current client bundle.",
  );
}
