"use client";

// HR-2C §9 (2026-08-20) — Employee Portal Help menu (tour replay).
//
// Restrained "Help" dropdown in the top bar that opens the guided
// tour on demand (§9). Never resets the persisted completion
// timestamp — the tour re-launches simply by mounting with
// openOnMount=true.
//
// Not building a full support centre in this slice (§9 explicit).
// Single menu item today; the shell exists so future help entries
// (contact HR, keyboard shortcuts, changelog) can slot in cleanly.

import { useState, useEffect, useRef } from "react";
import EmployeeTourOnFirstLogin from "./EmployeeTourOnFirstLogin";

export default function EmployeePortalHelpMenu() {
  const [menuOpen, setMenuOpen] = useState(false);
  const [tourOpen, setTourOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!menuOpen) return;
    function onOutside(e: MouseEvent) {
      if (!wrapperRef.current) return;
      if (!wrapperRef.current.contains(e.target as Node)) setMenuOpen(false);
    }
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") setMenuOpen(false); }
    window.addEventListener("mousedown", onOutside);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onOutside);
      window.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  function replayTour() {
    setMenuOpen(false);
    setTourOpen(true);
  }

  return (
    <div ref={wrapperRef} className="relative" data-testid="portal-help">
      <button
        type="button"
        onClick={() => setMenuOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        className="rounded-md border border-stone-200 px-3 py-1.5 text-xs text-stone-600 hover:bg-stone-50 hover:text-club-ink"
        data-testid="portal-help-trigger"
      >
        Help
      </button>
      {menuOpen && (
        <div
          role="menu"
          className="absolute right-0 mt-2 w-56 rounded-md border border-stone-200 bg-white shadow-lg z-30"
          data-testid="portal-help-menu"
        >
          <button
            type="button"
            role="menuitem"
            onClick={replayTour}
            className="block w-full text-left px-4 py-2 text-sm text-club-ink hover:bg-stone-50"
            data-testid="portal-help-take-tour"
          >
            Take the portal tour
          </button>
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
