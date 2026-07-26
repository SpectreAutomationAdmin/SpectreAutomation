"use client";

// Top-right user identity area with a click-to-open account menu.
//
// The TopBar is the persistent header rendered by the admin and
// member layouts. The right-hand identity block (name + role/member
// number + avatar) is the trigger for an account dropdown with two
// items:
//
//   • User Settings — context-aware target supplied by each layout
//     (admin: /app/admin/settings — club profile + branding;
//      member: /app/member/profile — personal profile + household
//      + preferences). The layout that mounts the TopBar tells it
//     which page is "yours" via the `settingsHref` prop.
//
//   • Sign Out — navigates to /api/logout. The route handler clears
//     the session cookie and 303-redirects to /login (or the club's
//     public home for members). We use a navigation Link (not a
//     form POST) because:
//       • This is the same pattern the prior sidebar Sign Out link
//         used — it works in production today.
//       • A form POST with an onClick that closes the menu had a
//         React 18 batching race where setOpen(false) re-rendered
//         and unmounted the form BEFORE the browser's form-submit
//         default action fired, so the navigation never happened
//         (visible in the dev-server log as a missing POST). Using
//         Link routes around the race: setOpen(false) and the
//         browser navigation are both synchronous outcomes of the
//         click and Next.js Link handles the order correctly.
//       • /api/logout accepts both GET and POST so it remains a
//         drop-in. Next.js Link does NOT prefetch API routes, so
//         no hover-preload risk.
//
// Interaction rules:
//   • Click the entire identity area (name, role line, avatar) to
//     toggle the menu.
//   • Click outside / Esc / select an item closes the menu.
//   • Enter / Space activate the trigger; arrow keys + Tab move
//     focus through items inside the menu.
//   • Hover/focus states match the existing Spectre admin chrome.

import Link from "next/link";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";

type Props = {
  userName: string;
  userRole: string;
  // When the signed-in user is a member, this is their assigned member
  // number. It replaces the generic role line so the top-right reads
  // e.g. "James Whitfield / Member 9078" — their identity inside the
  // club, not the abstract role.
  memberNumber?: string | null;
  /**
   * Where the User Settings menu item routes. Each layout supplies
   * the context-appropriate page:
   *   • admin layouts → "/app/admin/settings" (club profile + branding)
   *   • member layouts → "/app/member/profile" (personal profile)
   * If omitted, the item is hidden — a defensive guardrail rather
   * than a default we'd be wrong about for some surface.
   */
  settingsHref?: string;
};

export function TopBar({
  userName,
  userRole,
  memberNumber,
  settingsHref,
}: Props) {
  const friendlyRole = userRole.replace(/_/g, " ").toLowerCase();
  // Member numbers carry a club-code prefix (e.g. "SS-1042" for Silver
  // Springs) so they're unambiguous in cross-club admin contexts. In the
  // member's own portal that prefix is redundant — the member already
  // knows which club they belong to — so we display only the numeric
  // tail. Strip leading letters + dash; pass any value through if it
  // doesn't match (e.g. legacy plain-numeric numbers).
  const displayNumber = memberNumber?.replace(/^[A-Z]+-/i, "") ?? null;
  const subline = displayNumber ? `Member ${displayNumber}` : friendlyRole;
  const initials = userName
    .split(" ")
    .map((n) => n[0])
    .join("")
    .slice(0, 2);

  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  // ── Outside-click + Escape close ───────────────────────────────
  //
  // While the menu is open, listen globally. The trigger button's
  // own click toggles state inside its onClick — its target is
  // contained inside `triggerRef.current` so the outside-click
  // check correctly ignores it.
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        triggerRef.current?.contains(target) ||
        menuRef.current?.contains(target)
      ) {
        return;
      }
      setOpen(false);
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // ── Move focus to the first menu item on open ──────────────────
  //
  // Standard menu-button pattern: Enter / Space / Down on the
  // trigger should open the menu AND focus the first item so
  // keyboard users can scan + select without a second tab.
  useEffect(() => {
    if (!open) return;
    const first = menuRef.current?.querySelector<HTMLElement>("[data-menu-item]");
    first?.focus();
  }, [open]);

  const onTriggerKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      setOpen(true);
    }
  };

  const onMenuKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      // handled in the document-level listener too, but keep this
      // local handler so the event doesn't bubble unexpectedly
      setOpen(false);
      triggerRef.current?.focus();
      return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLElement>("[data-menu-item]") ?? [],
    );
    if (items.length === 0) return;
    const idx = items.indexOf(document.activeElement as HTMLElement);
    const next =
      e.key === "ArrowDown"
        ? items[(idx + 1) % items.length]
        : items[(idx - 1 + items.length) % items.length];
    e.preventDefault();
    next?.focus();
  };

  return (
    <header
      data-testid="topbar"
      className="h-14 border-b border-stone-200 bg-white px-6 flex items-center justify-end gap-4 relative"
    >
      <div className="relative">
        <button
          ref={triggerRef}
          type="button"
          onClick={() => setOpen((v) => !v)}
          onKeyDown={onTriggerKeyDown}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={`Account menu for ${userName}`}
          data-testid="topbar-user-trigger"
          // Whole identity area is the click target: name, subline,
          // and avatar. Hover + focus mirror existing nav affordances
          // (subtle stone background, gold focus ring).
          className="flex items-center gap-3 rounded-md px-2 py-1 -mx-2 hover:bg-stone-50 focus:outline-none focus:ring-2 focus:ring-club-gold/50"
        >
          <div className="text-right">
            <div className="text-sm font-medium text-club-ink leading-tight">
              {userName}
            </div>
            <div
              className={`text-xs text-stone-500 leading-tight ${memberNumber ? "" : "capitalize"}`}
            >
              {subline}
            </div>
          </div>
          <div
            aria-hidden="true"
            className="h-8 w-8 rounded-full bg-club-green-700 text-white flex items-center justify-center text-xs font-semibold"
          >
            {initials}
          </div>
        </button>

        {open && (
          <div
            ref={menuRef}
            role="menu"
            aria-label="Account menu"
            data-testid="topbar-user-menu"
            onKeyDown={onMenuKeyDown}
            className="absolute right-0 top-full mt-2 w-56 z-40 rounded-md border border-stone-200 bg-white shadow-lg py-1"
          >
            {settingsHref && (
              <Link
                href={settingsHref}
                role="menuitem"
                data-menu-item
                data-testid="topbar-user-menu-settings"
                onClick={() => setOpen(false)}
                className="block px-4 py-2 text-sm text-stone-700 hover:bg-stone-50 focus:bg-stone-50 focus:outline-none"
              >
                User Settings
              </Link>
            )}
            {/* Sign Out — navigates to /api/logout. The route handler
                clears the session cookie + redirects to /login (or
                the club's public home for members). Plain Link
                navigation (NOT a form POST) so the menu's onClick
                close doesn't race the browser navigation and unmount
                the trigger before submission fires. See the header
                comment in this file for the full rationale. */}
            <Link
              href="/api/logout"
              role="menuitem"
              data-menu-item
              data-testid="topbar-user-menu-signout"
              onClick={() => setOpen(false)}
              className="block px-4 py-2 text-sm text-stone-700 hover:bg-stone-50 focus:bg-stone-50 focus:outline-none"
              prefetch={false}
            >
              Sign Out
            </Link>
          </div>
        )}
      </div>
    </header>
  );
}
