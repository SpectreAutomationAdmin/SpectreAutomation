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
//   Clocking In / Out  → unavailable (no route yet — TimeClockEvent
//                        model exists but no consumer service or UI;
//                        §9 explicitly forbids inventing one)

import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { getEmployeePortalPrincipal } from "@/lib/employee-portal-session";
import EmployeeTourOnFirstLogin from "@/components/employee/EmployeeTourOnFirstLogin";
import EmployeePortalHero from "@/components/employee/EmployeePortalHero";
import { getCurrentWeather } from "@/lib/reporting/weather";
import { getClubMedia } from "@/lib/club/media";
import { buildHomeNotifications } from "@/lib/hr/home-notifications";
import { getCurrentPrimaryRoleDisplay } from "@/lib/hr/employment-assignments";
import HomeNotificationBar from "./_home/HomeNotificationBar";
import HomeWidgetGrid, { type WidgetDef } from "./_home/HomeWidgetGrid";
import { dismissHomeNotificationAction } from "./_home/_actions";
// HR mobile-hotfix (2026-08-27) — accepted mobile reference components.
// Rendered under <md only; desktop presentation is unchanged.
import MobileWelcomeBanner from "@/components/employee/mobile/MobileWelcomeBanner";
import MobileWidgetGrid, { type MobileWidget } from "@/components/employee/mobile/MobileWidgetGrid";
import MobileQuickLinks from "@/components/employee/mobile/MobileQuickLinks";
// HR mobile-hotfix continuation (2026-08-28) — accepted desktop
// reference components. Rendered under md+ only; the mobile shell
// takes over at <md.
import DesktopWidgetGrid, { type DesktopWidget } from "@/components/employee/desktop/DesktopWidgetGrid";
import DesktopAnnouncementsCard from "@/components/employee/desktop/DesktopAnnouncementsCard";
import DesktopQuickLinksCard from "@/components/employee/desktop/DesktopQuickLinksCard";
import DesktopFooter from "@/components/employee/desktop/DesktopFooter";
import DesktopWelcomeBanner from "@/components/employee/desktop/DesktopWelcomeBanner";

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
  // HR-2C Portal Refinement (2026-08-28) — Suitcase, per founder
  // direction §6 (Time Off Requests). Simple recognisable outline
  // suitcase / travel bag. No airplane, no beach umbrella, no sun.
  return (
    <svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {/* Handle */}
      <path d="M9 6V4.5A1.5 1.5 0 0 1 10.5 3h3A1.5 1.5 0 0 1 15 4.5V6" />
      {/* Body of the case */}
      <rect x="3.5" y="6" width="17" height="14" rx="2" />
      {/* Divider running horizontally to read distinctly as a bag */}
      <line x1="3.5" y1="12.5" x2="20.5" y2="12.5" />
      {/* Vertical tick on the divider — clasp / centre latch */}
      <line x1="12" y1="11.5" x2="12" y2="13.5" />
    </svg>
  );
}

function IconClock() {
  // HR-2C Portal Refinement (2026-08-28) — Clock face, per founder
  // direction §6 (Clocking In / Out). Distinct from the Scheduling
  // calendar so the two widgets read as different concepts.
  return (
    <svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="8.5" />
      {/* Hour hand pointing up-and-right, minute hand pointing right */}
      <polyline points="12 7.5 12 12 16 14" />
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
        // HR mobile-hotfix (2026-08-30) §4 — Home banner reads
        // employeeLifecycle so the "reviewing" message vanishes the
        // instant the admin runs Approve & Activate.
        employeeLifecycle: true,
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
      // HR mobile-hotfix (2026-08-26) — added name / slug / address /
      // region so `getCurrentWeather` can resolve tenant coordinates
      // through the canonical `resolveClubLocation` helper.
      select: {
        name: true,
        slug: true,
        address: true,
        region: true,
        primaryColor: true,
        timezone: true,
      },
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

  // Resolve the tenant's current weather through the canonical shared
  // weather service (src/lib/reporting/weather) — the same source the
  // Monthly Reporting Package consumes. Falls back to the seed provider
  // when Open-Meteo is unreachable, so this never blocks portal render.
  const weatherResult = club
    ? await getCurrentWeather({
        club: {
          name: club.name,
          slug: club.slug,
          address: club.address,
          region: club.region,
        },
      }).catch(() => null)
    : null;
  const weather = weatherResult?.observation ?? null;

  const displayName = employee.preferredName?.trim().length
    ? employee.preferredName
    : employee.firstName;
  const tourAlreadyDone = employee.portalTourCompletedAt !== null;
  const sessionState = employee.onboardingSessions[0]?.state ?? null;
  // HR mobile-hotfix (2026-08-30) §4 — Once the admin runs
  // approveAndActivateEmployee, the session moves to APPROVED AND the
  // employee's lifecycle flips to ACTIVE. Either signal alone suppresses
  // the "reviewing your onboarding" banner; requiring both would let a
  // late-arriving session write (or a manual lifecycle flip) leave the
  // banner stranded. `awaitingReview` is the single source of truth
  // that both the banner and its guards read from.
  const awaitingReview = sessionState === "SUBMITTED"
    && employee.employeeLifecycle !== "ACTIVE";

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
      // HR mobile-hotfix (2026-08-30) — founder terminology
      // correction: widget label is "Safety & Training" (aligns
      // with the admin catalogue + destination page title).
      label: "Safety & Training",
      href: "/employee/safety-training",
      icon: <IconTraining />,
      tourTarget: "training",
    },
    {
      key: "clocking-in-out",
      // HR mobile-hotfix (2026-08-30) — "Clock In / Out" per
      // founder terminology.
      label: "Clock In / Out",
      href: null,
      icon: <IconClock />,
      // HR mobile-hotfix (2026-08-30) — widget participates in
      // the guided tour so employees see the affordance.
      tourTarget: "clocking-in-out",
    },
  ];

  // HR mobile-hotfix (2026-08-27) — accepted mobile reference card
  // labels + descriptions. Note "Time Off" (not "Time Off Requests")
  // on mobile per the reference. Routes are the same as the desktop
  // widget grid; unavailable destinations render as non-nav cards.
  const mobileWidgets: MobileWidget[] = [
    { key: "scheduling", title: "Scheduling", description: "View your shifts and availability", href: "/employee/schedule", icon: <IconCalendar />, tourTarget: "scheduling" },
    { key: "paystubs", title: "Paystubs", description: "Access your pay information", href: "/employee/pay", icon: <IconPaystub />, tourTarget: "paystubs" },
    { key: "time-off", title: "Time Off", description: "Request time off and view balances", href: null, icon: <IconClock />, tourTarget: "time-off" },
    { key: "forms", title: "Forms", description: "Complete and manage forms", href: null, icon: <IconForms />, tourTarget: "forms" },
    { key: "training", title: "Safety & Training", description: "Resources and mandatory training", href: "/employee/safety-training", icon: <IconTraining />, tourTarget: "training" },
    { key: "clocking-in-out", title: "Clock In / Out", description: "Record your work hours", href: null, icon: <IconClockInOut />, tourTarget: "clocking-in-out" },
  ];

  // HR mobile-hotfix continuation (2026-08-28) — desktop 3×2 grid.
  // Order per the accepted desktop reference: row 1 (Scheduling /
  // Paystubs / Time Off), row 2 (Forms / Safety & Training /
  // Clock In / Out). Same routes + labels as mobile.
  const desktopWidgets: DesktopWidget[] = [
    { key: "scheduling", title: "Scheduling", description: "View your shifts and availability", href: "/employee/schedule", icon: <IconCalendar />, tourTarget: "scheduling" },
    { key: "paystubs", title: "Paystubs", description: "Access your pay information", href: "/employee/pay", icon: <IconPaystub />, tourTarget: "paystubs" },
    { key: "time-off", title: "Time Off", description: "Request time off and view balances", href: null, icon: <IconClock />, tourTarget: "time-off" },
    { key: "forms", title: "Forms", description: "Complete and manage forms", href: null, icon: <IconForms />, tourTarget: "forms" },
    { key: "training", title: "Safety & Training", description: "Resources and mandatory training", href: "/employee/safety-training", icon: <IconTraining />, tourTarget: "training" },
    { key: "clocking-in-out", title: "Clock In / Out", description: "Record your work hours", href: null, icon: <IconClockInOut />, tourTarget: "clocking-in-out" },
  ];

  // Club-name for the mobile welcome banner. Uses the same resolved
  // Club row the hero uses — never hard-coded to Coulee Ridge.
  const clubName = await prisma.club.findFirst({
    where: { id: principal.clubId },
    select: { name: true },
  }).then((c) => c?.name ?? "your Club");

  return (
    <div data-testid="portal-home" className="flex-1 min-h-0 flex flex-col md:block md:flex-none md:min-h-full">
      <EmployeeTourOnFirstLogin alreadyDone={tourAlreadyDone} />

      {/* ==================== MOBILE PRESENTATION (<md) ====================
         HR mobile-hotfix (2026-08-28) — flex-column vertical shell.
         The parent layout supplies a flex-column shell (topbar +
         main + bottom-nav). Inside main (which is also flex-col
         min-h-0), this column claims flex-1 with its own flex-col so
         the widget-region row can be `flex-1 min-h-0` and consume
         the remaining vertical space between hero/banner and Quick
         Links. */}
      <div
        className="md:hidden flex flex-col flex-1 min-h-0"
        data-testid="portal-mobile-column"
      >
        {/* Hero (auto). */}
        <div className="flex-none">
          <EmployeePortalHero
            clubId={principal.clubId}
            version={heroMedia?.sha256.slice(0, 12) ?? null}
            hasImage={heroMedia !== null}
            primaryColor={club?.primaryColor ?? null}
            greetingName={displayName ?? "there"}
            positionName={primaryRole.positionName}
            clubTimezone={club?.timezone ?? null}
            weather={weather}
          />
        </div>
        {/* Welcome banner (auto). */}
        <div className="flex-none px-4 pt-3">
          <MobileWelcomeBanner clubName={clubName} />
        </div>
        {/* Notifications when present (auto). */}
        {activeNotifications.length > 0 && (
          <section
            className="flex-none space-y-2 px-4 pt-2"
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
        {/* Widget region — FLEXIBLE. Claims the remaining height
           between the top stack (hero/banner/notif) and the bottom
           stack (quick-links/awaiting). `flex-1 min-h-0` is the
           canonical flex-column pattern that lets its own child
           (MobileWidgetGrid.section) fill via `h-full`. */}
        <div className="flex-1 min-h-0 px-4 pt-3" data-testid="portal-mobile-widgets-region">
          <MobileWidgetGrid widgets={mobileWidgets} />
        </div>
        {/* Quick Links (auto). */}
        <div className="flex-none px-4 pt-3">
          <MobileQuickLinks />
        </div>
        {/* Optional awaiting-review banner. Rare (SUBMITTED-not-
           ACTIVE only). Restrained bottom padding so it never
           collides with the bottom nav. */}
        <div className="flex-none px-4 pt-3 pb-3">
          {awaitingReview && (
            <section
              className="rounded-lg border border-emerald-200 bg-emerald-50/60 px-4 py-3"
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
      </div>

      {/* ==================== DESKTOP PRESENTATION (md+) ====================
         HR mobile-hotfix continuation (2026-08-28) — rebuilt to the
         accepted desktop reference. Full-bleed hero + two-column
         dashboard (main + right rail) + subtle footer. Old
         icon-centric grid replaced with the 3×2 card layout that
         mirrors the accepted mobile card language. */}
      <div className="hidden md:block" data-testid="portal-desktop-home">
        <EmployeePortalHero
          clubId={principal.clubId}
          version={heroMedia?.sha256.slice(0, 12) ?? null}
          hasImage={heroMedia !== null}
          primaryColor={club?.primaryColor ?? null}
          greetingName={displayName ?? "there"}
          positionName={primaryRole.positionName}
          clubTimezone={club?.timezone ?? null}
            weather={weather}
        />
        {/* Density rebalance (2026-08-26) — outer padding trimmed
           (`px-8 py-5`) and inter-block row-gap tightened (`space-y-4`
           / `gap-6`) so the welcome banner + notifications + 3×2 grid
           column fits vertically alongside the right rail in the
           one-screen-fit target (1536×864). Column ratio held at
           3fr/1fr (~75/25). */}
        <div
          className="px-8 py-5 grid gap-6 min-w-0"
          style={{ gridTemplateColumns: "minmax(0, 3fr) minmax(0, 1fr)" }}
        >
          {/* MAIN COLUMN — welcome banner + notifications + 3x2 grid + optional awaiting-review */}
          <div className="min-w-0 space-y-4">
            <div data-testid="portal-desktop-welcome-banner-slot">
              <DesktopWelcomeBanner clubName={clubName} />
            </div>
            {activeNotifications.length > 0 && (
              <section
                className="space-y-2"
                data-testid="portal-home-notifications-desktop"
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
            <DesktopWidgetGrid widgets={desktopWidgets} />
            {awaitingReview && (
              <section
                className="rounded-lg border border-emerald-200 bg-emerald-50/60 px-6 py-4"
                data-testid="portal-home-awaiting-review-desktop"
              >
                <p className="text-sm text-emerald-900">
                  <strong>Your Club is reviewing your onboarding.</strong> You can use
                  the portal in the meantime — pay statements and schedule details
                  will appear once you&rsquo;ve been fully activated.
                </p>
              </section>
            )}
          </div>
          {/* RIGHT RAIL — announcements + quick links. Row-gap
             tightened for density rebalance; panels themselves keep
             their compact-desktop treatment. */}
          <div className="min-w-0 space-y-4">
            <DesktopAnnouncementsCard
              items={[]}
            />
            <DesktopQuickLinksCard />
          </div>
        </div>
        <DesktopFooter clubName={clubName} year={2026} />
      </div>
    </div>
  );
}

// HR mobile-hotfix (2026-08-27) — Clock In / Out icon used by the
// mobile widget grid. The desktop grid keeps its own version of this
// icon (defined above) because they use different stroke weights /
// sizes — the mobile card renders a compact icon at ~28px while the
// desktop icon-centric tile uses 56px.
function IconClockInOut() {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {/* Directional / timekeeping — signpost style, matches the
         reference's mobile Clock In / Out card. */}
      <path d="M4 5h12l3 2.5L16 10H4z" />
      <path d="M4 14h14l3 2.5L18 19H4z" />
      <line x1="8" y1="10" x2="8" y2="14" />
      <line x1="8" y1="19" x2="8" y2="21" />
      <line x1="8" y1="3" x2="8" y2="5" />
    </svg>
  );
}
