// Board Monthly Package — read-only layout.
//
// Mirrors `src/app/app/admin/reporting/layout.tsx` (the controller's
// reporting shell) for the BOARD read-only view at
// /app/reports/monthly-package/[id]. Both surfaces share:
//
//   • The dark green ReportingShell header
//   • The Roman-numeral chapter rail on the left
//   • The print-mode toggle
//   • The IntersectionObserver-driven scrollspy
//
// Board-specific differences:
//
//   • The close button (top-right X) returns to /app/member instead
//     of the controller's Monthly Package launcher. Wired via the
//     `closeHrefOverride` prop the founder spec-named.
//   • No PublishHeaderButton portals into the shell's action slot
//     (the board page doesn't render one).
//   • No "Overwrite Package" dialog, no Published / Archived pills,
//     no admin chrome — the shared body component receives no
//     `adminHeader`, so the slot stays empty.
//
// Auth gating happens in the page (`getBoardPackageView` resolves
// the package + verifies the caller is a board member or recipient).
// This layout is purely chrome.

import { getActiveBranding } from "@/lib/branding";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { prisma } from "@/lib/prisma";
import { ReportingShell } from "@/components/reporting/ReportingShell";
import { MONTHLY_REPORTING_CHAPTERS } from "@/lib/reporting/monthly-package-chapters";

// Chapter registry is shared with the admin reporting layout AND
// the PDF export's auto-generated TOC — single source in
// `src/lib/reporting/monthly-package-chapters.ts`.

export default async function BoardMonthlyPackageLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  // Next.js App Router passes dynamic-segment params to layouts
  // sitting alongside the segment they belong to. Our layout lives
  // in /app/app/reports/monthly-package/[id]/layout.tsx, so we get
  // `params.id` here and can resolve the package's reporting
  // period for the header without depending on the URL query string
  // the admin route uses.
  params: { id: string };
}) {
  // Resolve the club name for the running header. Identical fallback
  // ladder to the admin reporting layout so the board user sees the
  // same brand identity the controller sees.
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
      clubName = club?.name ?? "Monthly Reporting Package";
    } catch {
      clubName = "Monthly Reporting Package";
    }
  }

  // Resolve the package's reporting period for the header's third
  // segment ("MAY 2026" etc.). The admin route gets this via the
  // URL's `?period=YYYY-MM` query and ReportingShell formats it; the
  // board route's URL carries the package id instead, so we look the
  // period up here in the layout and pass it as the `periodLabel`
  // prop. The shell's URL-period derivation is null on this route
  // (no ?period param), so the prop wins — same display path as the
  // admin route, just sourced from the DB row instead of the URL.
  //
  // findUnique on the PK is cheap and runs on the same request that
  // the page below already issues a getBoardPackageView for. We
  // intentionally do NOT authz-gate this lookup: the package id is
  // already in the URL, and the period label leaks nothing the URL
  // itself doesn't. The page below still returns 404 for unauthorized
  // viewers via getBoardPackageView.
  const MONTH_LONG = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];
  const FALLBACK_PERIOD_LABEL = "Monthly Reporting Package";
  let periodLabel: string = FALLBACK_PERIOD_LABEL;
  try {
    const row = await prisma.monthlyPackage.findUnique({
      where: { id: params.id },
      select: { reportingYear: true, reportingMonth: true },
    });
    if (row) {
      periodLabel = `${MONTH_LONG[row.reportingMonth - 1]} ${row.reportingYear}`;
    }
  } catch {
    // Lookup failure (bad id, DB hiccup) → keep the neutral fallback
    // label so the shell still renders. The page below will 404
    // the unauthorized / not-found case.
  }

  return (
    <ReportingShell
      clubName={clubName}
      reportTitle="Monthly Board Reporting Package"
      periodLabel={periodLabel}
      preparedFor="Board of Directors"
      chapters={MONTHLY_REPORTING_CHAPTERS}
      closeHrefOverride="/app/member"
    >
      {children}
    </ReportingShell>
  );
}
