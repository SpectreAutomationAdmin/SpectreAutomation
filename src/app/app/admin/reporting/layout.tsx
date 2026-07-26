// Reporting layout.
//
// Applies to every route under /app/admin/reporting/**. AdminShell
// detects this path and strips its own sidebar + topbar; this layout
// then provides the dedicated board-package shell.
//
// Auth + role gating still run in the parent admin layout. Per-page
// permission gating (e.g. reports:board for monthly) still runs in
// each page.tsx — this layout is purely chrome.
//
// For now the only reporting route is /monthly. Chapter list is
// hardcoded for monthly until additional reporting routes are added,
// at which point the layout can resolve chapters by pathname.

import { getActiveBranding } from "@/lib/branding";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { prisma } from "@/lib/prisma";
import { ReportingShell } from "@/components/reporting/ReportingShell";
import { MONTHLY_REPORTING_CHAPTERS } from "@/lib/reporting/monthly-package-chapters";

// Roman-numeral chapter markers reinforce the document feel — this
// is a board package, not a SaaS sub-nav. The labels mirror the
// section ids the monthly page renders, so the anchor links resolve.
//
// Step / reading-order pass:
//   1. Cover (anchored at the document top)
//   2. Board narrative comes BEFORE the at-a-glance KPIs so directors
//      consume the package the way the standard says: narrative first,
//      detailed data second.
//   3. Operating + Capital stewardship merge into a single chapter
//      (the rail still leaves room for sub-headings inside).
//   4. Capital Projects + AR Aging promoted out of Financial Statements
//      into their own top-level chapters since boards review them as
//      separate concerns, not as financial-statement appendices.
// Saguaro-style grouped table of contents. Three section groups in
// reading order: MEMBER OVERVIEW → FINANCIAL STATEMENTS (the five
// Saguaro-style statements) → OPERATIONS & ANALYTICS.
// Chapter source-order is the rail render-order; group headings
// appear once at the start of each group run.
//
// 2026-06-19 naming-convention enforcement: chapter entries declare
// ONLY `number`, `label`, and `group`. There is no separate `id`
// field. The section id is derived everywhere from
// `chapterIdFor(label)` (in `src/components/reporting/ReportingShell.tsx`)
// so a manually entered id cannot diverge from what the reader sees
// in the rail. The visible label is the single source of truth.
//
// 2026-06-16 chapter additions / removals:
//   - The legacy pillar-panel block (Operations / Financial Health /
//     Capital / Membership Health / Experience Health), the Board
//     Financial Briefing, the At-a-Glance KPIs, the legacy Financial
//     Statements block, and the legacy AR / Collections block were
//     superseded by the five Saguaro chapters and removed.
//   - Operating Statistics & Focus Areas was added as chapter IX
//     (first chapter of the Operations & Analytics group), so every
//     chapter downstream shifts up by +1 (Operations & Analytics
//     IX → X, Payroll X → XI, F&B / Hospitality XI → XII,
//     Capital / Projects XII → XIII, Membership Stewardship
//     XIII → XIV, Experience Stewardship XIV → XV).
// Chapter registry moved to `src/lib/reporting/monthly-package-chapters.ts`
// 2026-06-30 so the PDF export's auto-generated TOC and the two
// reporting shells (admin + board) consume the same source. Reference
// the shared constant below as `MONTHLY_REPORTING_CHAPTERS`.
//
// (The historical chapter-by-chapter add/remove ledger that previously
//  lived inline is preserved in the shared module's header comment
//  for the lock-step in/out audit trail.)

export default async function ReportingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Resolve the club identity for the shell header. The board package
  // is the *club's* document; the running header should carry the club
  // name, not the platform wordmark. Resolution order:
  //   1. White-label branding wordmark when the request is on a club host.
  //   2. The signed-in user's active club name (so the demo on the
  //      platform host still reads as "Silver Springs", not "Spectre").
  //   3. Fall back to the platform wordmark only when nothing else
  //      resolves (e.g. SUPER_ADMIN with no active club).
  const branding = await getActiveBranding();
  let clubName: string;
  if (branding.mode === "club") {
    clubName = branding.wordmark;
  } else {
    try {
      const principal = await getCurrentPrincipal();
      const clubId = principal
        ? await getActiveClubId({ clubId: principal.activeClubId ?? null, role: "" })
        : null;
      const club = clubId
        ? await prisma.club.findUnique({ where: { id: clubId }, select: { name: true } })
        : null;
      clubName = club?.name ?? "Spectre Automation";
    } catch {
      clubName = "Spectre Automation";
    }
  }

  // Period + report title are hardcoded here for monthly. When more
  // routes land they can be resolved by pathname in a small router
  // helper (or moved into each route's own segment-level layout).
  return (
    <ReportingShell
      clubName={clubName}
      reportTitle="Monthly Board Reporting Package"
      periodLabel="May 2026"
      preparedFor="Finance Committee · Board of Directors"
      chapters={MONTHLY_REPORTING_CHAPTERS}
    >
      {children}
    </ReportingShell>
  );
}
