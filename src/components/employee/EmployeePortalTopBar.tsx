"use client";

// HR mobile-hotfix continuation (2026-08-28) — desktop top header
// rebuilt to the accepted desktop reference.
//
// EP-UX-1 (2026-11-01) — the tenant-name section + newly-relocated
// breadcrumb trail now render through the SHARED
// `src/components/spectre/HeaderContextRail` component — the same
// primitive the Admin SpectreTopBar uses — so tenant typography
// (14 px / 18 px / 600 / 0.002 em letter-spacing, sans-serif,
// no-wrap, ellipsis @ 44ch) matches Admin exactly.  The surrounding
// green chrome, h-20, notification bell, and user menu are
// preserved per the EP-UX-1 scope-protection rule.
//
// Dark forest-green bar that spans from the right edge of the
// sidebar to the right edge of the viewport. Composition:
//
//   [ TENANT NAME ·  Crumb > Crumb > Current ] ... [ 🔔 ] [ avatar + name + ⌄ ]
//
// The Spectre / Automation wordmark lives in the sidebar (matching
// the accepted reference) so the header itself carries only the
// tenant identity + breadcrumb + right-side employee controls.

import type { CSSProperties } from "react";
import EmployeePortalUserMenu from "./EmployeePortalUserMenu";
import { HeaderContextRail } from "@/components/spectre/HeaderContextRail";

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

// EP-UX-1 (2026-11-01) — scope the Spectre palette tokens the shared
// `HeaderContextRail` reads so the identical typography + layout
// render in white-on-green inside the Employee Portal's existing
// green chrome.  Only the four tokens the rail's CSS uses are
// overridden; nothing cascades beyond the rail wrapper.
const emeraldChromeRailStyle: CSSProperties = {
  // tenant name + aria-current + link:hover
  ["--spectre-text-primary" as string]: "rgba(255, 255, 255, 0.98)",
  // base crumb colour + non-current link
  ["--spectre-text-muted" as string]: "rgba(255, 255, 255, 0.72)",
  // chevron separator between crumbs
  ["--spectre-text-subtle" as string]: "rgba(255, 255, 255, 0.5)",
  // 1 px vertical hairline between tenant and first crumb
  ["--spectre-border-hairline" as string]: "rgba(255, 255, 255, 0.28)",
};

export default function EmployeePortalTopBar({
  clubName, displayName, givenName, employeeNumber, hasPhoto, photoVersion,
  unreadNotificationCount = null,
}: Props) {
  const badge = unreadNotificationCount != null && unreadNotificationCount > 0;
  return (
    // Density rebalance (2026-08-26) — header trimmed h-24 → h-20 to
    // recover vertical space for the one-screen-fit target. Branding
    // sizes retained; only the vertical padding is smaller.
    <header
      className="relative h-20 flex items-stretch bg-club-green-800 text-white pl-0 pr-8 gap-8 sticky top-0 z-20"
      data-testid="portal-header"
    >
      {/* Gold vertical separator — anchored to the topbar's LEFT EDGE
         (x=0 inside the header, which visually joins the sidebar's
         right edge at the 256 px sidebar/main-area boundary). The
         line reinforces the structural boundary between the left nav
         column and the main content region. ~40 px tall inset. */}
      <div
        aria-hidden="true"
        className="absolute left-0 top-1/2 -translate-y-1/2 w-px h-10 bg-club-gold/55"
        data-testid="portal-header-separator"
      />
      {/* EP-UX-1 (2026-11-01) — tenant identity + breadcrumb trail,
         rendered through the shared `HeaderContextRail`.  Admin uses
         the identical component on `SpectreTopBar`.  The CSS-variable
         overrides on this wrapper translate the dark-Spectre palette
         to white-on-green without introducing a new typography path. */}
      <div
        className="flex items-center min-w-0 flex-1 pl-8"
        style={emeraldChromeRailStyle}
      >
        <HeaderContextRail tenantName={clubName} />
      </div>

      {/* Right-side controls — notification bell + account menu. */}
      <div className="flex items-center gap-6">
        <button
          type="button"
          className="relative flex items-center justify-center h-12 w-12 rounded-full text-white/85 hover:text-white hover:bg-white/[0.06] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-club-gold"
          aria-label={badge ? `${unreadNotificationCount} unread notifications` : "Notifications"}
          data-testid="portal-header-notifications"
        >
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M6 8a6 6 0 1 1 12 0v5l2 3H4l2-3V8z" />
            <path d="M10 20a2 2 0 0 0 4 0" />
          </svg>
          {badge && (
            <span
              className="absolute top-1 right-1 min-w-[18px] h-[18px] px-1 rounded-full bg-club-gold text-club-green-900 text-[10.5px] font-semibold flex items-center justify-center leading-none"
              data-testid="portal-header-notifications-badge"
              aria-hidden="true"
            >
              {unreadNotificationCount! > 99 ? "99+" : unreadNotificationCount}
            </span>
          )}
        </button>

        {/* Account menu — reuses the existing dropdown component. The
           accepted desktop reference does NOT wrap the trigger in a
           prominent gold pill; the fidelity pass strips the ring and
           the trigger's own pill background so what remains is:
           circular avatar (with a subtle photo ring) + preferred name
           + chevron. Employee number is deliberately hidden per the
           accepted design. */}
        <div
          className="
            [&_[data-testid='portal-user-menu-trigger']]:!ring-0
            [&_[data-testid='portal-user-menu-trigger']]:!bg-transparent
            [&_[data-testid='portal-user-menu-trigger']]:!border-transparent
            [&_[data-testid='portal-user-menu-trigger']]:rounded-full
            [&_[data-testid='portal-user-menu-trigger']]:!py-1
            [&_[data-testid='portal-user-menu-trigger']]:!px-1
            [&_[data-testid='portal-user-menu-trigger']_svg]:text-white/85
            [&_[data-testid='portal-user-menu-photo']]:!h-[46px]
            [&_[data-testid='portal-user-menu-photo']]:!w-[46px]
            [&_[data-testid='portal-user-menu-initials']]:!h-[46px]
            [&_[data-testid='portal-user-menu-initials']]:!w-[46px]
            [&_[data-testid='portal-user-menu-initials']]:!text-base
            [&_[data-testid='portal-user-menu-photo']]:!border-white/25
            [&_[data-testid='portal-user-menu-initials']]:!border-white/25
            [&_[data-testid='portal-topbar-name']]:!text-white
            [&_[data-testid='portal-topbar-name']]:!text-[17px]
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
