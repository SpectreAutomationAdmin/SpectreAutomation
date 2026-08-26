"use client";

// HR mobile-hotfix continuation (2026-08-28) — desktop top header
// rebuilt to the accepted desktop reference.
//
// Dark forest-green bar that spans from the right edge of the
// sidebar to the right edge of the viewport. Composition:
//
//   [ TENANT NAME on 2 lines ] ............ [ 🔔 badge ] [ avatar + given name + chevron ]
//
// The Spectre / Automation wordmark lives in the sidebar (matching
// the accepted reference) so the header itself carries only the
// tenant identity + right-side employee controls.

import EmployeePortalUserMenu from "./EmployeePortalUserMenu";

interface Props {
  clubName: string;
  displayName: string;         // full name (retained for a11y label)
  givenName: string;           // preferred or first — what the header displays
  employeeNumber: string;
  hasPhoto: boolean;
  photoVersion: string | null;
  /** Optional unread notification count. When null the bell shows
   *  no badge; when > 0 the brass-toned badge overlays the bell.
   *  Wired from the shell so the topbar doesn't fetch data of its
   *  own. */
  unreadNotificationCount?: number | null;
}

function formatClubNameTwoLines(name: string): React.ReactNode {
  const parts = name.trim().split(/\s+/);
  if (parts.length <= 2) return name;
  const head = parts.slice(0, 2).join(" ");
  const tail = parts.slice(2).join(" ");
  return (
    <>
      <div className="truncate">{head}</div>
      <div className="truncate">{tail}</div>
    </>
  );
}

export default function EmployeePortalTopBar({
  clubName, displayName, givenName, employeeNumber, hasPhoto, photoVersion,
  unreadNotificationCount = null,
}: Props) {
  const badge = unreadNotificationCount != null && unreadNotificationCount > 0;
  return (
    <header
      className="h-16 flex items-stretch bg-club-green-800 text-white px-6 gap-6"
      data-testid="portal-header"
    >
      {/* Tenant identity — canonical current-Club name in two lines. */}
      <div className="flex items-center min-w-0 flex-1">
        <div
          className="font-serif text-[14px] leading-[1.15] text-white/95 min-w-0"
          data-testid="portal-header-club-name"
          title={clubName}
        >
          {formatClubNameTwoLines(clubName)}
        </div>
      </div>

      {/* Right-side controls — notification bell + account menu. */}
      <div className="flex items-center gap-4">
        <button
          type="button"
          className="relative flex items-center justify-center h-9 w-9 rounded-full text-white/85 hover:text-white hover:bg-white/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-club-gold"
          aria-label={badge ? `${unreadNotificationCount} unread notifications` : "Notifications"}
          data-testid="portal-header-notifications"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M6 8a6 6 0 1 1 12 0v5l2 3H4l2-3V8z" />
            <path d="M10 20a2 2 0 0 0 4 0" />
          </svg>
          {badge && (
            <span
              className="absolute -top-0.5 -right-0.5 min-w-[16px] h-[16px] px-1 rounded-full bg-club-gold text-club-green-900 text-[10px] font-semibold flex items-center justify-center leading-none"
              data-testid="portal-header-notifications-badge"
              aria-hidden="true"
            >
              {unreadNotificationCount! > 99 ? "99+" : unreadNotificationCount}
            </span>
          )}
        </button>

        {/* Account menu — reuses the existing dropdown component but
           the trigger's visual affordance is skinned dark-green:
           circular avatar + given name + chevron. Employee number
           is deliberately NOT shown here (per the accepted design). */}
        <div
          className="
            [&_[data-testid='portal-user-menu-trigger']]:!ring-1
            [&_[data-testid='portal-user-menu-trigger']]:!ring-club-gold/40
            [&_[data-testid='portal-user-menu-trigger']]:rounded-full
            [&_[data-testid='portal-user-menu-trigger']_svg]:text-white/85
            [&_[data-testid='portal-topbar-name']]:!text-white
            [&_[data-testid='portal-topbar-employee-number']]:hidden
          "
        >
          <EmployeePortalUserMenu
            displayName={givenName}
            employeeNumber={employeeNumber}
            hasPhoto={hasPhoto}
            photoVersion={photoVersion}
          />
        </div>
      </div>
    </header>
  );
}
