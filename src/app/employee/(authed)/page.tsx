// HR-2C Home refinement (2026-08-24) — Employee Portal Home.
//
// Final hierarchy (§11):
//   1. Club hero photograph        (unchanged — Club-configurable)
//   2. Thin dismissible notification bars — rendered ONLY when there
//      is something to show. When empty, the widgets rise naturally.
//   3. Five navigation widgets: Scheduling / Paystubs / Time Off
//      Requests / Forms / Training.
//
// Removed:
//   - "Welcome to your employee portal, X." heading.
//   - The employee-number / position / department / lifecycle summary
//     panel. That information lives in Profile now.
//
// Preserved:
//   - EmployeePortalHero (photo + greeting + position overlay).
//   - EmployeeTourOnFirstLogin (Welcome step still anchors to
//     `[data-testid="portal-hero"]`, no code change needed).
//   - The B4 SUBMITTED-onboarding banner remains — an employee whose
//     onboarding was just submitted deserves a Home confirmation.
//
// Widget destination truth:
//   Scheduling         → /employee/schedule            (real)
//   Paystubs           → /employee/pay                 (real; page currently truthful-empty)
//   Time Off Requests  → unavailable (no route yet)
//   Forms              → unavailable (no dedicated Forms surface;
//                        Documents is a separate viewer, not Forms)
//   Training           → /employee/safety-training     (real)

import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { getEmployeePortalPrincipal } from "@/lib/employee-portal-session";
import EmployeeTourOnFirstLogin from "@/components/employee/EmployeeTourOnFirstLogin";
import EmployeePortalHero from "@/components/employee/EmployeePortalHero";
import { getClubMedia } from "@/lib/club/media";
import { buildHomeNotifications } from "@/lib/hr/home-notifications";
import { getCurrentPrimaryRoleDisplay } from "@/lib/hr/employment-assignments";
import HomeNotificationBar from "./_home/HomeNotificationBar";
import HomeWidgetGrid, { type WidgetDef } from "./_home/HomeWidgetGrid";
import { dismissHomeNotificationAction } from "./_home/_actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// --- Widget icon set (monoline, currentColor, restrained) ------------------

function IconCalendar() {
  return (
    <svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3.5" y="5" width="17" height="15" rx="2" />
      <line x1="3.5" y1="10" x2="20.5" y2="10" />
      <line x1="8" y1="3" x2="8" y2="7" />
      <line x1="16" y1="3" x2="16" y2="7" />
    </svg>
  );
}

function IconPaystub() {
  // Receipt-like rectangle with two ledger lines.
  return (
    <svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 3h10l3 3v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" />
      <path d="M16 3v3h3" />
      <line x1="8" y1="12" x2="16" y2="12" />
      <line x1="8" y1="16" x2="13" y2="16" />
    </svg>
  );
}

function IconTimeOff() {
  // HR-2C Portal Refinement (2026-08-24) — Airplane taking off,
  // side-profile silhouette to match the founder reference. Nose
  // up-and-right, tail down-and-left, wings clearly visible,
  // runway horizon beneath. Uses the same 1.7 stroke weight as
  // the other four widget icons.
  //
  // Drawn as one polygonal fuselage with a wing dropping back from
  // its underside; wingtip visible; short runway ground line.
  return (
    <svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {/* Fuselage — cursive shape with nose at upper right and tail cutout at lower left. */}
      <path d="M2.8 12.5 L4.2 11.9 L8.2 13.3 L11.1 10.5 L7.4 5.4 L9.1 4.9 L14.5 9.5 L20 8.4 A1.8 1.8 0 0 1 22 10.4 A1.8 1.8 0 0 1 20.4 12.1 L13.6 13.9 L9.6 17.9 L7.9 17.4 L9.1 14.3 L4.6 14.6 Z" />
      {/* Runway / horizon line beneath the plane. */}
      <line x1="3" y1="20.5" x2="21" y2="20.5" />
    </svg>
  );
}

function IconForms() {
  // Clipboard / form.
  return (
    <svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="5" y="4" width="14" height="17" rx="2" />
      <path d="M9 3h6a1 1 0 0 1 1 1v2H8V4a1 1 0 0 1 1-1z" />
      <line x1="8.5" y1="11" x2="15.5" y2="11" />
      <line x1="8.5" y1="15" x2="15.5" y2="15" />
    </svg>
  );
}

function IconTraining() {
  // HR-2C Shell Refinement (2026-08-24) — Graduation cap. Restrained
  // monoline; reads as Training / learning.
  return (
    <svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2.5 9.5 12 5l9.5 4.5L12 14 2.5 9.5z" />
      <path d="M6.5 11.5v4c0 1 2.5 2.5 5.5 2.5s5.5-1.5 5.5-2.5v-4" />
      <line x1="21.5" y1="9.5" x2="21.5" y2="14" />
    </svg>
  );
}

// ---------------------------------------------------------------------------

export default async function EmployeePortalHome() {
  const principal = await getEmployeePortalPrincipal();
  if (!principal) redirect("/employee/login");

  const [employee, heroMedia, club, notifications, primaryRole] = await Promise.all([
    prisma.employee.findFirst({
      where: { id: principal.employeeId, clubId: principal.clubId },
      select: {
        id: true,
        firstName: true,
        preferredName: true,
        portalTourCompletedAt: true,
        onboardingSessions: {
          orderBy: { startedAt: "desc" },
          take: 1,
          select: { state: true },
        },
      },
    }),
    getClubMedia(principal.clubId, "employee_portal_hero"),
    prisma.club.findFirst({
      where: { id: principal.clubId },
      select: { primaryColor: true },
    }),
    buildHomeNotifications(principal),
    // HR-2C Portal Parity (2026-08-24) — hero subtitle now derives
    // from the canonical CURRENT primary assignment. Legacy
    // Employee.position was the stale source; the assignment write
    // path never updates that column, so a role change from
    // Clubhouse Manager → Controller left the portal hero showing
    // the prior title indefinitely.
    getCurrentPrimaryRoleDisplay(principal.employeeId),
  ]);
  if (!employee) redirect("/employee/login");

  const displayName = employee.preferredName?.trim().length
    ? employee.preferredName
    : employee.firstName;
  const tourAlreadyDone = employee.portalTourCompletedAt !== null;
  const sessionState = employee.onboardingSessions[0]?.state ?? null;

  // Show only notifications the employee has not dismissed for the
  // current underlying obligation state.
  const activeNotifications = notifications.filter((n) => !n.dismissed);

  const widgets: WidgetDef[] = [
    {
      key: "scheduling",
      label: "Scheduling",
      href: "/employee/schedule",
      icon: <IconCalendar />,
      tourTarget: "scheduling",
    },
    {
      key: "paystubs",
      label: "Paystubs",
      href: "/employee/pay",
      icon: <IconPaystub />,
      tourTarget: "paystubs",
    },
    {
      key: "time-off-requests",
      label: "Time Off Requests",
      href: null,
      icon: <IconTimeOff />,
      tourTarget: "time-off",
    },
    {
      key: "forms",
      label: "Forms",
      href: null,
      icon: <IconForms />,
      tourTarget: "forms",
    },
    {
      key: "training",
      label: "Training",
      href: "/employee/safety-training",
      icon: <IconTraining />,
      tourTarget: "training",
    },
  ];

  return (
    <div className="space-y-4" data-testid="portal-home">
      <EmployeeTourOnFirstLogin alreadyDone={tourAlreadyDone} />

      <EmployeePortalHero
        clubId={principal.clubId}
        version={heroMedia?.sha256.slice(0, 12) ?? null}
        hasImage={heroMedia !== null}
        primaryColor={club?.primaryColor ?? null}
        greetingName={displayName ?? "there"}
        positionName={primaryRole.positionName}
      />

      {activeNotifications.length > 0 && (
        <section
          className="space-y-2"
          data-testid="portal-home-notifications"
          aria-label="Notifications"
        >
          {activeNotifications.map((n) => (
            <HomeNotificationBar
              key={n.key}
              notificationKey={n.key}
              tone={n.tone}
              message={n.message}
              actionLabel={n.actionLabel}
              actionHref={n.actionHref}
              dismissAction={dismissHomeNotificationAction}
            />
          ))}
        </section>
      )}

      <div className="pt-2">
        <HomeWidgetGrid widgets={widgets} />
      </div>

      {sessionState === "SUBMITTED" && (
        <section
          className="rounded-lg border border-emerald-200 bg-emerald-50/60 px-6 py-4"
          data-testid="portal-home-awaiting-review"
        >
          <p className="text-sm text-emerald-900">
            <strong>Your Club is reviewing your onboarding.</strong> You can use
            the portal in the meantime — pay statements and schedule details
            will appear once you&rsquo;ve been fully activated.
          </p>
        </section>
      )}
    </div>
  );
}
