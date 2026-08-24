"use client";

// HR-2C Shell Refinement (2026-08-24) — Employee Portal top header.
//
// Matches the main Spectre workspace header grammar, simplified for
// the employee audience:
//   - full-width bar, same vertical height and border treatment as
//     the admin shell;
//   - Club name prominently displayed on the left (identifies which
//     Club's portal the employee is viewing — replaces the prior
//     Club-name-in-sidebar treatment);
//   - employee identity block at the far right: circular avatar +
//     display name + employee number (photo comes from the canonical
//     Employee.profilePhotoDocumentId via the same-origin portal
//     self-photo route; initials fallback when no photo exists);
//   - restrained Help + Sign out controls beside identity.
//
// No admin-only controls (no global search, no notifications, no
// Mission Control shortcuts) — this is the employee-simplified
// version of the workspace header.

import EmployeePortalHelpMenu from "./EmployeePortalHelpMenu";

interface Props {
  clubName: string;
  displayName: string;
  employeeNumber: string;
  hasPhoto: boolean;
  photoVersion: string | null;
}

function initialsFor(displayName: string): string {
  const parts = displayName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "·";
  const first = parts[0]![0] ?? "";
  const last = parts.length > 1 ? parts[parts.length - 1]![0] ?? "" : "";
  return (first + last).toUpperCase() || "·";
}

export default function EmployeePortalTopBar({
  clubName, displayName, employeeNumber, hasPhoto, photoVersion,
}: Props) {
  const initials = initialsFor(displayName);
  const photoSrc = hasPhoto
    ? `/api/employee/self/profile-photo${photoVersion ? `?v=${encodeURIComponent(photoVersion)}` : ""}`
    : null;

  return (
    <header
      className="flex items-center justify-between border-b border-stone-200 bg-white px-6 py-3 gap-4"
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

      {/* Employee identity + controls. */}
      <div className="flex items-center gap-3 shrink-0">
        <div className="hidden sm:block text-right leading-tight">
          <div className="text-sm text-club-ink" data-testid="portal-topbar-name">{displayName}</div>
          <div className="font-mono text-[11px] text-stone-500" data-testid="portal-topbar-employee-number">
            {employeeNumber}
          </div>
        </div>
        {photoSrc ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={photoSrc}
            alt=""
            className="h-9 w-9 rounded-full object-cover border border-stone-200"
            data-testid="portal-header-avatar-photo"
          />
        ) : (
          <div
            className="h-9 w-9 rounded-full bg-club-green-100 text-club-green-800 border border-stone-200 flex items-center justify-center text-xs font-medium"
            data-testid="portal-header-avatar-initials"
            aria-label={displayName}
          >
            {initials}
          </div>
        )}
        <EmployeePortalHelpMenu />
        <form action="/employee/logout" method="post">
          <button
            type="submit"
            className="rounded-md border border-stone-200 px-3 py-1.5 text-xs text-stone-600 hover:bg-stone-50 hover:text-club-ink"
            data-testid="portal-signout"
          >
            Sign out
          </button>
        </form>
      </div>
    </header>
  );
}
