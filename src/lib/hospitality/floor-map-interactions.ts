// Step 31 — floor-map double-click drilldown.
//
// Decision predicate for whether a server's double-click on a table
// tile should navigate to the seat-level POS view. Pure function so
// it can be unit-tested without importing the React FloorMap
// component (which carries JSX and would require @vitejs/plugin-react
// in vitest).
//
// Eligibility:
//   1. Table must currently be SEATED.
//   2. `openCheckId` must be present. The floor-map loader's Prisma
//      `posChecks` join already filters to non-CLOSED / non-VOIDED
//      statuses, so a populated `openCheckId` is by definition an
//      active check (OPEN / SENT / READY / PARTIALLY_SETTLED /
//      PAYMENT_PENDING / PAYMENT_FAILED).
//
// Stale-state guard: a SEATED table with NO openCheckId means the
// reservation lifecycle is stale (auto-depart from step 30 should
// have repaired it). We refuse to navigate so the side panel can
// surface the repair path instead of pushing the server into a
// route that wouldn't render.

export function canOpenSeatViewOnDoubleClick(
  t: { status: string; openCheckId: string | null },
): string | null {
  if (t.status !== "SEATED") return null;
  if (!t.openCheckId) return null;
  return `/app/admin/ops/pos/lounge/table/${t.openCheckId}`;
}
