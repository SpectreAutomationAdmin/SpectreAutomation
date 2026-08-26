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

  // Full account identity for the top-right account control:
  // "Chris Turcato", not just "Chris". Preferred-name preferences that
  // exist elsewhere (Hero greeting) are unaffected — the account
  // control identifies the employee at the full-name level so the
  // shell matches the workspace user-menu grammar the founder called
  // out.
  const givenName = employee.preferredName?.trim().length
    ? employee.preferredName.trim()
    : employee.firstName;
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
          DESKTOP SHELL (md+ only) — UNCHANGED from the pre-hotfix
          layout. Sidebar + main content column with the workspace
          top bar. Renders normal document flow.
          ============================================================ */}
      <div className="hidden md:flex min-h-screen bg-stone-50">
        <EmployeePortalSidebar />
        <div className="flex-1 flex flex-col min-w-0">
          <EmployeePortalTopBar
            clubName={clubName}
            displayName={displayName}
            employeeNumber={employee.employeeNumber}
            hasPhoto={hasPhoto}
            photoVersion={photoVersion}
          />
          <main className="flex-1 px-10 py-10 max-w-6xl w-full">
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
        className="md:hidden bg-stone-50 grid"
        style={{
          height: "100dvh",
          minHeight: "100svh",
          gridTemplateRows: "auto minmax(0, 1fr) auto",
        }}
        data-testid="portal-mobile-shell"
      >
        <EmployeePortalMobileNav
          clubName={clubName}
          displayName={displayName}
          employeeNumber={employee.employeeNumber}
          hasPhoto={hasPhoto}
          photoVersion={photoVersion}
        />
        <main
          // HR mobile-hotfix (2026-08-28) — main is itself a grid so
          // that a single-child (portal-home) can take a 1fr row and
          // `h-full` propagates correctly. Without display:grid, a
          // `h-full` child inside an overflow-y-auto container does
          // NOT stretch to the container's grid-track height — the
          // widget region collapses to intrinsic content and the
          // remaining space piles up as unused whitespace above the
          // bottom nav (measured at 430×932 as a 869 px gap).
          className="min-h-0 overflow-y-auto overflow-x-hidden grid"
          style={{ minHeight: 0, gridTemplateRows: "1fr" }}
          data-testid="portal-mobile-main"
        >
          {children}
        </main>
        <MobileBottomNav />
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
