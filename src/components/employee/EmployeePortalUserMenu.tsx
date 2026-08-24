"use client";

// HR-2C Portal Refinement (2026-08-24 / expanded 2026-08-28) — Employee
// Portal user menu.
//
// Mirrors the workspace SpectreTopBar user-menu grammar: circular
// avatar + display name + chevron; click opens a dropdown containing
// employee-appropriate account actions. The workspace component itself
// is admin-coupled (theme cycle, global search, HeaderContextRail,
// admin User role text); this component reuses the SAME visual grammar
// (avatar / name / menu / item spacing / border / focus behaviour)
// without dragging admin dependencies into the portal.
//
// Dropdown contents (§3 explicit — Help + Sign out only, plus the
// portal-tour replay which is real functional employee preference):
//   - Display name + employee number header
//   - Help              → opens the employee-facing help modal
//   - Take portal tour  → replays the guided tour (portal-only,
//                          appropriate for an employee)
//   - Sign out          → /employee/logout (POST form)
//
// Profile is deliberately NOT in the dropdown — the left rail already
// carries Profile as a top-level nav item, so exposing it in two
// places is redundant.
//
// Admin-only surfaces (User Settings for the admin App, /app/**) are
// NOT reachable from this menu. Employee session cannot enter the
// admin layout regardless — this menu simply does not advertise it.

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
  const [helpOpen, setHelpOpen] = useState(false);
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

  useEffect(() => {
    if (!helpOpen) return;
    const onKey = (e: globalThis.KeyboardEvent) => { if (e.key === "Escape") setHelpOpen(false); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [helpOpen]);

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
          <button
            type="button"
            role="menuitem"
            data-menu-item
            data-testid="portal-user-menu-help"
            onClick={() => { setMenuOpen(false); setHelpOpen(true); }}
            className="block w-full text-left px-3 py-2 text-sm text-club-ink rounded-md hover:bg-stone-50"
          >
            Help
          </button>
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
      {helpOpen && (
        <div
          className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4"
          data-testid="portal-help-modal"
          role="dialog"
          aria-modal="true"
          aria-labelledby="portal-help-title"
          onClick={(e) => { if (e.target === e.currentTarget) setHelpOpen(false); }}
        >
          <div className="w-full max-w-md rounded-lg bg-white shadow-xl p-6 space-y-3">
            <h2 id="portal-help-title" className="font-serif text-xl text-club-ink">
              Need help?
            </h2>
            <p className="text-sm text-stone-600">
              Your Club administrator or manager is the fastest path for
              questions about your schedule, pay, training, or personal
              information. If something in the portal isn&rsquo;t working,
              let them know and they can escalate on your behalf.
            </p>
            <div className="pt-2 flex justify-end">
              <button
                type="button"
                onClick={() => setHelpOpen(false)}
                className="btn btn-primary btn-sm"
                data-testid="portal-help-modal-close"
              >
                Got it
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
