"use client";

// HR-2C Shell Refinement (2026-08-24) — Employee Portal top header.
// HR-2C Portal Refinement (2026-08-24) — single account entry point.
//
// Matches the main Spectre workspace header grammar, simplified for
// the employee audience:
//   - full-width bar, same vertical height and border treatment as
//     the admin shell;
//   - Club name prominently displayed on the left (identifies which
//     Club's portal the employee is viewing);
//   - right side is a single account entry point (PortalUserMenu):
//     circular avatar + display name + employee number, click opens
//     a dropdown with Profile / Take portal tour / Sign out.
//
// The previous standalone Help + Sign out buttons have been removed
// — the dropdown is the one place employees find both actions,
// mirroring the workspace grammar the founder called out.

import EmployeePortalUserMenu from "./EmployeePortalUserMenu";

interface Props {
  clubName: string;
  displayName: string;
  employeeNumber: string;
  hasPhoto: boolean;
  photoVersion: string | null;
}

export default function EmployeePortalTopBar({
  clubName, displayName, employeeNumber, hasPhoto, photoVersion,
}: Props) {
  return (
    <header
      className="h-16 flex items-center justify-between border-b border-stone-200 bg-white px-6 gap-4"
      data-testid="portal-header"
    >
      {/* Club identity — canonical current-Club name, above the hero. */}
      <div className="min-w-0 flex-1">
        <div
          className="font-serif text-base md:text-lg leading-tight text-club-ink truncate"
          data-testid="portal-header-club-name"
          title={clubName}
        >
          {clubName}
        </div>
      </div>

      {/* Single account entry point — mirrors the workspace pattern. */}
      <div className="shrink-0">
        <EmployeePortalUserMenu
          displayName={displayName}
          employeeNumber={employeeNumber}
          hasPhoto={hasPhoto}
          photoVersion={photoVersion}
        />
      </div>
    </header>
  );
}
