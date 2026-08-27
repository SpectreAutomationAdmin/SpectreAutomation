// HR-2B.5 §32-38, §7-8, §41-42 (2026-08-19) — Employee Portal shell.
//
// Runs on a distinct principal kind (EmployeePortalPrincipal via
// spectre_employee_session). The Spectre admin cookie CANNOT
// authenticate this surface — the layout only accepts the employee
// cookie. Similarly the employee cookie cannot enter /app/admin/**
// because that layout gates on User + ADMIN_ROLES.
//
// Brand discipline: uses the Club's white-label branding
// (`getActiveBranding()`). The word "Spectre" never appears on any
// portal surface — per the founder memory
// [[feedback_member_brand_shielding]] the product is white-labelled
// per club.

import type { ReactNode } from "react";
import { Suspense } from "react";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { getEmployeePortalPrincipal } from "@/lib/employee-portal-session";
import { getActiveBranding } from "@/lib/branding";
import EmployeePortalSidebar from "@/components/employee/EmployeePortalSidebar";
import EmployeePortalTopBar from "@/components/employee/EmployeePortalTopBar";
import EmployeePortalMobileNav from "@/components/employee/EmployeePortalMobileNav";
import MobileBottomNav from "@/components/employee/mobile/MobileBottomNav";
import ViewportDebugOverlay from "@/components/employee/ViewportDebugOverlay";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function EmployeeLayout({ children }: { children: ReactNode }) {
  const principal = await getEmployeePortalPrincipal();
  if (!principal) redirect("/employee/login");

  const [employee, club] = await Promise.all([
    prisma.employee.findFirst({
      where: { id: principal.employeeId, clubId: principal.clubId },
      select: {
        id: true,
        firstName: true,
        preferredName: true,
        lastName: true,
        employeeNumber: true,
        employeeLifecycle: true,
        status: true,
        // HR-2C Shell Refinement (2026-08-24) — powers the top-right
        // circular avatar in the workspace-style header.
        profilePhotoDocumentId: true,
      },
    }),
    prisma.club.findFirst({
      where: { id: principal.clubId },
      select: { name: true, primaryColor: true },
    }),
  ]);

  // Absent employee = stale cookie — the employee row got deleted
  // (very rare). Clear + kick to login.
  if (!employee || !club) redirect("/employee/login");

  // Terminated / revoked employees: no portal access. This is the
  // policy hook for §42's "archived/terminated handling"; the
  // enforcement is here because it must run on every navigation.
  if (employee.status === "TERMINATED" || employee.employeeLifecycle === "TERMINATED") {
    redirect("/employee/login?err=Your%20account%20is%20no%20longer%20active.");
  }

  const branding = await getActiveBranding();
  // Prefer the resolved-club name, falling back to branding (which is
  // host-driven) then to a neutral label. NEVER "Spectre".
  const clubName = club.name ?? branding.wordmark ?? "Employee Portal";

  // HR mobile-hotfix fidelity pass (2026-08-26) — the accepted
  // desktop reference shows the employee's FORMAL first name in the
  // top-right chrome (e.g. "Christopher", not "Chris"). Prefer the
  // canonical `firstName` field over `preferredName`. If a Club still
  // wants a short form to appear elsewhere, the preferred value
  // remains available downstream — but the shell identity is formal.
  const givenName = employee.firstName?.trim().length
    ? employee.firstName.trim()
    : (employee.preferredName?.trim() ?? "");
  const displayName = employee.lastName?.trim().length
    ? `${givenName} ${employee.lastName.trim()}`
    : givenName;

  const hasPhoto = employee.profilePhotoDocumentId != null;
  // Cache-buster on the photo URL keyed on the document id so a
  // replaced photo re-fetches inside the browser without needing a
  // full reload.
  const photoVersion = employee.profilePhotoDocumentId ?? null;

  const releaseMarker =
    process.env.SPECTRE_RELEASE_MARKER
      ?? process.env.FLY_MACHINE_VERSION
      ?? process.env.FLY_IMAGE_REF
      ?? "unknown";

  return (
    <>
      {/* ============================================================
          DESKTOP SHELL (md+ only) — HR mobile-hotfix continuation
          (2026-08-28) rebuilt to the accepted desktop reference:
          dark green Spectre chrome (sidebar + top header form one
          continuous band), full-bleed hero + main content region
          against a warm-cream background. No max-width cap — the
          page.tsx desktop branch supplies its own content-column
          proportions. `min-w-0` on the flex column so children can
          shrink correctly at narrower tablet widths.
          ============================================================ */}
      <div className="hidden md:flex min-h-screen bg-club-cream" data-testid="portal-desktop-shell">
        <EmployeePortalSidebar />
        <div className="flex-1 flex flex-col min-w-0">
          <EmployeePortalTopBar
            clubName={clubName}
            displayName={displayName}
            givenName={givenName}
            employeeNumber={employee.employeeNumber}
            hasPhoto={hasPhoto}
            photoVersion={photoVersion}
          />
          {/* Footer-anchor pass (2026-08-26) — main is a flex column
             so the desktop `portal-desktop-home` wrapper can push
             the footer to the bottom of the viewport via `mt-auto`
             on the footer itself. Mobile shell is untouched. */}
          <main className="flex-1 min-w-0 flex flex-col">
            {children}
          </main>
        </div>
      </div>

      {/* ============================================================
          MOBILE APP SHELL (<md only) — HR mobile-hotfix (2026-08-28).
          Full-viewport CSS grid: [ topbar ] · [ scrollable middle ]
          · [ bottom nav ]. The topbar + bottom nav are NORMAL grid
          rows, NOT fixed-position, so they always sit exactly at the
          top and bottom of the visual viewport with no reserved-
          space padding tricks.

          Height contract:
            height:    100dvh   (dynamic viewport — shrinks with
                                 Safari's URL bar so the shell never
                                 overflows off-screen)
            min-height:100svh   (small viewport fallback for engines
                                 that don't ship dvh; also stabilises
                                 the shell if Safari's URL bar collapses)

          Middle row is minmax(0,1fr) with overflow:auto so that when
          the content genuinely can't fit at a very short accessibility
          viewport (~570 dvh px) the middle scrolls WITHIN the shell —
          the topbar and bottom nav stay put and Quick Links never
          gets hidden behind the bottom nav.

          The mobile drawer (opened from the topbar hamburger) still
          renders itself as position:fixed inset-0 z-50 so it covers
          the shell correctly.
          ============================================================ */}
      <div
        className="md:hidden bg-stone-50 flex flex-col"
        style={{ height: "100dvh", minHeight: "100svh" }}
        data-testid="portal-mobile-shell"
      >
        <div className="flex-none">
          <EmployeePortalMobileNav
            clubName={clubName}
            displayName={displayName}
            employeeNumber={employee.employeeNumber}
            hasPhoto={hasPhoto}
            photoVersion={photoVersion}
          />
        </div>
        <main
          // HR mobile-hotfix (2026-08-28) — flexbox is more
          // predictable than grid+h-full for a viewport-bound shell.
          // `flex-1` claims the remaining vertical space between the
          // top bar and the bottom nav. `min-h-0` lets the child
          // flex-column shrink correctly (otherwise the intrinsic
          // content height dominates). `overflow-y-auto` scrolls
          // WITHIN this area on very short accessibility viewports.
          className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden flex flex-col"
          data-testid="portal-mobile-main"
        >
          {children}
        </main>
        <div className="flex-none">
          <MobileBottomNav />
        </div>
      </div>

      {/* HR mobile-hotfix (2026-08-27) — real-device viewport
          diagnostic. Renders ONLY when ?viewportDebug=1. Placed at
          the top level so it can attach fixed positioning outside
          either shell. */}
      <Suspense fallback={null}>
        <ViewportDebugOverlay releaseMarker={releaseMarker} />
      </Suspense>
    </>
  );
}
