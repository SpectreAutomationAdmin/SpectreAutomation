"use client";

// HR-2C Portal Refinement (2026-08-24) — Employee Portal user menu.
//
// Mirrors the workspace SpectreTopBar user-menu grammar: circular
// avatar + display name + chevron; click opens a dropdown containing
// the caller's account actions. The workspace component is admin-
// coupled (theme toggle, global search, HeaderContextRail); this
// component reuses the SAME visual grammar (avatar / name / menu /
// item spacing / border / focus behavior) without dragging admin
// dependencies into the portal.
//
// Dropdown contents (§3 explicit):
//   - Display name + employee number header
//   - Profile         → /employee/profile
//   - Take portal tour → replays the guided tour (no timestamp reset)
//   - Sign out        → /employee/logout (POST form)
//
// Admin-only surfaces (User Settings for the admin App, /app/**) are
// NOT reachable from this menu. Employee session cannot enter the
// admin layout regardless — this menu simply doesn't advertise it.

import Link from "next/link";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import EmployeeTourOnFirstLogin from "./EmployeeTourOnFirstLogin";

interface Props {
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

export default function EmployeePortalUserMenu({
  displayName, employeeNumber, hasPhoto, photoVersion,
}: Props) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [tourOpen, setTourOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!triggerRef.current?.contains(t) && !menuRef.current?.contains(t)) setMenuOpen(false);
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") {
        setMenuOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  const onMenuKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLElement>("[data-menu-item]") ?? []);
    const idx = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === "ArrowDown") { e.preventDefault(); items[(idx + 1) % items.length]?.focus(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); items[(idx - 1 + items.length) % items.length]?.focus(); }
  };

  const initials = initialsFor(displayName);
  const photoSrc = hasPhoto
    ? `/api/employee/self/profile-photo${photoVersion ? `?v=${encodeURIComponent(photoVersion)}` : ""}`
    : null;

  return (
    <div className="relative" data-testid="portal-user-menu">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setMenuOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-label={`Account menu for ${displayName}`}
        data-testid="portal-user-menu-trigger"
        className="flex items-center gap-3 rounded-md border border-transparent px-1 py-1 hover:bg-stone-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-club-green-700"
      >
        {photoSrc ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={photoSrc}
            alt=""
            className="h-9 w-9 rounded-full object-cover border border-stone-200"
            data-testid="portal-user-menu-photo"
          />
        ) : (
          <div
            className="h-9 w-9 rounded-full bg-club-green-100 text-club-green-800 border border-stone-200 flex items-center justify-center text-xs font-medium"
            data-testid="portal-user-menu-initials"
            aria-hidden="true"
          >
            {initials}
          </div>
        )}
        <div className="hidden sm:block text-right leading-tight">
          <div className="text-sm text-club-ink" data-testid="portal-topbar-name">{displayName}</div>
          <div className="font-mono text-[11px] text-stone-500" data-testid="portal-topbar-employee-number">
            {employeeNumber}
          </div>
        </div>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="text-stone-500">
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {menuOpen && (
        <div
          ref={menuRef}
          role="menu"
          aria-label="Account menu"
          onKeyDown={onMenuKeyDown}
          className="absolute right-0 top-full mt-2 w-64 rounded-md border border-stone-200 bg-white shadow-lg z-30"
          data-testid="portal-user-menu-dropdown"
        >
          <div className="px-3 py-2 border-b border-stone-100">
            <div className="text-sm font-medium text-club-ink">{displayName}</div>
            <div className="text-xs text-stone-500 font-mono">{employeeNumber}</div>
          </div>
          <Link
            href="/employee/profile"
            role="menuitem"
            data-menu-item
            data-testid="portal-user-menu-profile"
            onClick={() => setMenuOpen(false)}
            className="block px-3 py-2 text-sm text-club-ink rounded-md hover:bg-stone-50"
          >
            Profile
          </Link>
          <button
            type="button"
            role="menuitem"
            data-menu-item
            data-testid="portal-user-menu-take-tour"
            onClick={() => {
              setMenuOpen(false);
              setTourOpen(true);
            }}
            className="block w-full text-left px-3 py-2 text-sm text-club-ink rounded-md hover:bg-stone-50"
          >
            Take the portal tour
          </button>
          <div className="my-1 h-px bg-stone-100" />
          <form action="/employee/logout" method="post">
            <button
              type="submit"
              role="menuitem"
              data-menu-item
              data-testid="portal-user-menu-signout"
              className="block w-full text-left px-3 py-2 text-sm text-club-ink rounded-md hover:bg-stone-50"
            >
              Sign out
            </button>
          </form>
        </div>
      )}
      {tourOpen && (
        <EmployeeTourOnFirstLogin
          alreadyDone={false}
          openOnMount
          key={`replay-${Date.now()}`}
        />
      )}
    </div>
  );
}
