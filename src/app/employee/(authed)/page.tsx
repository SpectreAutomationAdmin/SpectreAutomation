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
import HomeNotificationBar from "./_home/HomeNotificationBar";
import HomeWidgetGrid, { type WidgetDef } from "./_home/HomeWidgetGrid";
import { dismissHomeNotificationAction } from "./_home/_actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// --- Widget icon set (monoline, currentColor, restrained) ------------------

function IconCalendar() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
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
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 3h10l3 3v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" />
      <path d="M16 3v3h3" />
      <line x1="8" y1="12" x2="16" y2="12" />
      <line x1="8" y1="16" x2="13" y2="16" />
    </svg>
  );
}

function IconTimeOff() {
  // Simple sun over horizon — reads as "away from work".
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="4" />
      <line x1="12" y1="4" x2="12" y2="5.5" />
      <line x1="12" y1="18.5" x2="12" y2="20" />
      <line x1="4" y1="12" x2="5.5" y2="12" />
      <line x1="18.5" y1="12" x2="20" y2="12" />
      <line x1="6" y1="6" x2="7" y2="7" />
      <line x1="17" y1="17" x2="18" y2="18" />
      <line x1="6" y1="18" x2="7" y2="17" />
      <line x1="17" y1="7" x2="18" y2="6" />
    </svg>
  );
}

function IconForms() {
  // Clipboard / form.
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="5" y="4" width="14" height="17" rx="2" />
      <path d="M9 3h6a1 1 0 0 1 1 1v2H8V4a1 1 0 0 1 1-1z" />
      <line x1="8.5" y1="11" x2="15.5" y2="11" />
      <line x1="8.5" y1="15" x2="15.5" y2="15" />
    </svg>
  );
}

function IconTraining() {
  // Shield with tick — Safety-first tone consistent with the
  // Safety & Training surface.
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3l7.5 3v6c0 4.5-3.2 8.4-7.5 9-4.3-.6-7.5-4.5-7.5-9V6L12 3z" />
      <polyline points="9 12 11.2 14.2 15 10.5" />
    </svg>
  );
}

// ---------------------------------------------------------------------------

export default async function EmployeePortalHome() {
  const principal = await getEmployeePortalPrincipal();
  if (!principal) redirect("/employee/login");

  const [employee, heroMedia, club, notifications] = await Promise.all([
    prisma.employee.findFirst({
      where: { id: principal.employeeId, clubId: principal.clubId },
      select: {
        id: true,
        firstName: true,
        preferredName: true,
        position: { select: { name: true } },
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
    },
    {
      key: "paystubs",
      label: "Paystubs",
      href: "/employee/pay",
      icon: <IconPaystub />,
    },
    {
      key: "time-off-requests",
      label: "Time Off Requests",
      href: null,
      icon: <IconTimeOff />,
      unavailableNote: "This surface will open when your Club enables time-off requests.",
    },
    {
      key: "forms",
      label: "Forms",
      href: null,
      icon: <IconForms />,
      unavailableNote: "Forms will appear here as your Club adds them.",
    },
    {
      key: "training",
      label: "Training",
      href: "/employee/safety-training",
      icon: <IconTraining />,
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
        positionName={employee.position?.name ?? null}
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
