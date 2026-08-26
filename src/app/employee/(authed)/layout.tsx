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

  return (
    <div className="min-h-screen bg-stone-50 flex">
      {/* Desktop sidebar — Home + Profile only. Club identity now
          lives in the top header per HR-2C Shell Refinement §3-4. */}
      <EmployeePortalSidebar />
      {/* Mobile fixed top bar + drawer (has its own `md:hidden` — hidden on
          desktop). Club name remains in the mobile compact top bar. */}
      <EmployeePortalMobileNav
        clubName={clubName}
        displayName={displayName}
        employeeNumber={employee.employeeNumber}
        hasPhoto={hasPhoto}
        photoVersion={photoVersion}
      />
      <div className="flex-1 flex flex-col min-w-0">
        {/* Desktop top header — Club name on the left, employee
            avatar/name/# + Help + Sign out on the right. */}
        <div className="hidden md:block">
          <EmployeePortalTopBar
            clubName={clubName}
            displayName={displayName}
            employeeNumber={employee.employeeNumber}
            hasPhoto={hasPhoto}
            photoVersion={photoVersion}
          />
        </div>
        {/* pt-16 on mobile leaves room for the fixed dark-green mobile
            top bar (accepted reference 2026-08-27). pb-20 leaves room
            for the fixed mobile bottom navigation + iOS safe-area. On
            md+ the desktop chrome takes over; those paddings collapse. */}
        <main
          className="flex-1 pt-16 md:pt-0 pb-20 md:pb-0 px-0 md:px-10 py-0 md:py-10 max-w-6xl w-full"
          style={{ paddingBottom: `calc(env(safe-area-inset-bottom, 0px) + 5rem)` }}
        >
          {children}
        </main>
      </div>
      {/* Mobile bottom navigation — fixed at the bottom on <md.
          Absent on desktop where the sidebar carries navigation. */}
      <MobileBottomNav />
      {/* HR mobile-hotfix (2026-08-27) — real-device viewport
          diagnostic. Renders ONLY when the URL carries
          `?viewportDebug=1`. Founder opens the staging portal with
          the flag on iPhone; the overlay shows live viewport metrics
          + a build marker so the screenshot is dated. Nothing
          renders in normal traffic. */}
      <Suspense fallback={null}>
        <ViewportDebugOverlay
          releaseMarker={
            process.env.SPECTRE_RELEASE_MARKER
              ?? process.env.FLY_MACHINE_VERSION
              ?? process.env.FLY_IMAGE_REF
              ?? "unknown"
          }
        />
      </Suspense>
    </div>
  );
}
