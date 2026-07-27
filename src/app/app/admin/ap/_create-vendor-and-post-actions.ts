// Sprint 3 · Checkpoint 15O (2026-07-27) — RETIRED.
//
// The 15M single-transaction path (create vendor AND post AP in one
// go) is rejected by the founder. The two-step replacements live in:
//
//   • ./_create-vendor-actions.ts    — Step 1: create/select vendor
//   • ./_post-ap-invoice-actions.ts  — Step 2: post AP invoice + resolve WI
//
// Kept as a stub so a stale import from a client bundle raises a
// clear compile-time error rather than silently importing an empty
// module. Remove this file once all callers have migrated.

"use server";

export async function createVendorAndPostAction(): Promise<never> {
  throw new Error(
    "createVendorAndPostAction was retired in Checkpoint 15O — call createVendorAction (Step 1) then postApInvoiceAction (Step 2).",
  );
}
