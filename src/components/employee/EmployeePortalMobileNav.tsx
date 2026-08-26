"use client";

// HR-2C B3.1 (2026-08-20) — Employee Portal mobile navigation.
//
// Fixes the pre-existing mobile-layout defect where the fixed-width
// sidebar (w-60) caused document-level horizontal overflow at 390 px.
//
// Pattern:
//   - On viewports < md the desktop sidebar is hidden and this
//     component becomes the primary nav.
//   - A fixed compact top bar renders across the top: hamburger
//     button on the left, Club name centred, and Help/Sign out on
//     the right.
//   - Tapping the hamburger opens a slide-in drawer from the left
//     with the same EMPLOYEE_NAV items (Home, Schedule, Availability,
//     Pay, Safety & Training, Documents, Profile). Each drawer link
//     carries the identical `data-tour-target` slug the desktop
//     sidebar uses so the anchored guided tour keeps working.
//
// Guided tour integration (§tour anchor on mobile):
//   The tour dispatches `spectre:portal:mobile-nav:open` on mount so
//   its sidebar-anchored steps have a real anchor to attach to; it
//   dispatches `spectre:portal:mobile-nav:close` on finish/skip. On
//   viewports ≥ md these events are ignored (the sidebar is already
//   visible so opening the drawer would be redundant).
//
// Accessibility:
//   - Backdrop click closes.
//   - Escape closes.
//   - When open, `body` scroll is locked so the drawer doesn't fight
//     the main scroller.
//   - Hamburger + drawer close buttons are real <button>s with
//     aria-labels.
//
// Brand discipline: reuses the resolved Club name; NEVER emits the
// "Spectre" wordmark on the mobile surface — same shielding as the
// desktop sidebar (§ [[feedback_member_brand_shielding]]).

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { cn } from "@/lib/ui";
import { EMPLOYEE_NAV } from "@/components/sidebar-nav-data";
import EmployeePortalUserMenu from "./EmployeePortalUserMenu";

interface Props {
  clubName: string;
  displayName: string;
  employeeNumber: string;
  hasPhoto: boolean;
  photoVersion: string | null;
}

/** Break a club name into two lines the way the reference does —
 *  first word (or the first two if it's a two-word club) on line 1,
 *  the rest on line 2. Falls back to a single line for very short
 *  names ("The Club"). */
function formatClubNameTwoLines(name: string): React.ReactNode {
  const parts = name.trim().split(/\s+/);
  if (parts.length <= 2) return name;
  // "Coulee Ridge Golf & Country Club" → "Coulee Ridge" / "Golf & Country Club"
  const head = parts.slice(0, 2).join(" ");
  const tail = parts.slice(2).join(" ");
  return (
    <>
      <div className="truncate">{head}</div>
      <div className="truncate">{tail}</div>
    </>
  );
}

export default function EmployeePortalMobileNav({
  clubName,
  displayName,
  employeeNumber,
  hasPhoto,
  photoVersion,
}: Props) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  // Tour integration: open on tour mount so anchored coach-marks
  // targeting sidebar nav items have a real element to attach to.
  // Ignore on ≥ md — the desktop sidebar is already visible there.
  useEffect(() => {
    const isMobile = () => window.matchMedia("(max-width: 767px)").matches;
    const openHandler = () => {
      if (isMobile()) setOpen(true);
    };
    const closeHandler = () => setOpen(false);
    document.addEventListener("spectre:portal:mobile-nav:open", openHandler);
    document.addEventListener("spectre:portal:mobile-nav:close", closeHandler);
    return () => {
      document.removeEventListener("spectre:portal:mobile-nav:open", openHandler);
      document.removeEventListener("spectre:portal:mobile-nav:close", closeHandler);
    };
  }, []);

  // Escape closes; body scroll locked while open.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open]);

  // HR mobile-hotfix (2026-08-30) — broadcast drawer state so the
  // guided tour can temporarily hide its popover while the drawer
  // covers the widget the popover is anchored to. When the drawer
  // closes the tour resumes at the same step. Prevents the founder-
  // reported illusion that the tour "restarts" when a popover
  // reappears from behind the drawer.
  useEffect(() => {
    if (typeof document === "undefined") return;
    document.dispatchEvent(new CustomEvent(
      open ? "spectre:portal:mobile-drawer:opened"
           : "spectre:portal:mobile-drawer:closed",
    ));
  }, [open]);

  // Close drawer whenever the route changes so a nav-item tap doesn't
  // leave the panel covering the new page.
  useEffect(() => { setOpen(false); }, [pathname]);

  return (
    <>
      {/* Fixed mobile top bar — dark forest green, per the founder-
          accepted mobile reference (2026-08-27). Composition:
             hamburger · SPECTRE/AUTOMATION wordmark · | · Club name
             (two lines) · avatar chevron
          Height ~64 px; the layout compensates with pt-16 on <md.
          The wordmark IS shown on the Employee Portal (employees are
          Club staff, not external members — the Spectre brand
          shielding memory applies to member-facing surfaces only). */}
      <header
        className="md:hidden fixed inset-x-0 top-0 z-40 flex items-stretch bg-club-green-800 text-white shadow-sm"
        data-testid="portal-mobile-topbar"
        style={{ paddingTop: "env(safe-area-inset-top, 0px)" }}
      >
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="flex items-center justify-center px-3 text-white/85 hover:text-white active:bg-club-green-900/40"
          aria-label="Open navigation menu"
          data-testid="portal-mobile-menu-open"
          data-tour-target="mobile-menu"
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <line x1="4" y1="6" x2="20" y2="6" />
            <line x1="4" y1="12" x2="20" y2="12" />
            <line x1="4" y1="18" x2="20" y2="18" />
          </svg>
        </button>
        <div className="flex items-center min-w-0 flex-1 py-2">
          <div className="flex flex-col leading-tight px-1" data-testid="portal-mobile-brand-wordmark">
            <span className="font-serif text-[15px] font-semibold tracking-[0.18em]">SPECTRE</span>
            <span className="font-sans text-[9px] tracking-[0.28em] text-white/75">AUTOMATION</span>
          </div>
          <div aria-hidden="true" className="mx-3 h-8 w-px bg-white/25" />
          <div
            className="min-w-0 flex-1 font-serif text-[13px] leading-[1.15] text-white/95"
            data-testid="portal-mobile-club-name"
          >
            {formatClubNameTwoLines(clubName)}
          </div>
        </div>
        {/* Account menu — trigger button lives inside the header, but the
            EmployeePortalUserMenu component styles it as a circular
            avatar. Restrained gold ring (ring-1 at 40% opacity) so the
            avatar reads as a subtle framed photo, not a gold pill.
            The user-menu component's own text (display name +
            employee number) is hidden on mobile — only the circular
            photo + chevron remain. */}
        <div className="flex items-center pr-2 [&_[data-testid='portal-user-menu-trigger']]:!ring-1 [&_[data-testid='portal-user-menu-trigger']]:!ring-club-gold/40 [&_[data-testid='portal-user-menu-trigger']]:rounded-full [&_[data-testid='portal-user-menu-trigger']_svg]:text-white/85 [&_[data-testid='portal-topbar-name']]:hidden [&_[data-testid='portal-topbar-employee-number']]:hidden [&_[data-testid='portal-user-menu-photo']]:!h-8 [&_[data-testid='portal-user-menu-photo']]:!w-8 [&_[data-testid='portal-user-menu-initials']]:!h-8 [&_[data-testid='portal-user-menu-initials']]:!w-8">
          <EmployeePortalUserMenu
            displayName={displayName}
            employeeNumber={employeeNumber}
            hasPhoto={hasPhoto}
            photoVersion={photoVersion}
          />
        </div>
      </header>

      {/* Drawer + backdrop — only rendered when open, so it never
          intercepts touches on desktop. */}
      {open && (
        <div className="md:hidden fixed inset-0 z-50" data-testid="portal-mobile-drawer">
          <button
            type="button"
            aria-label="Close navigation menu"
            className="absolute inset-0 bg-black/40"
            onClick={() => setOpen(false)}
            data-testid="portal-mobile-drawer-backdrop"
          />
          <aside
            className="absolute inset-y-0 left-0 w-72 max-w-[86vw] bg-white border-r border-stone-200 shadow-xl flex flex-col"
            role="dialog"
            aria-modal="true"
            aria-label="Portal navigation"
          >
            <div className="flex items-start justify-between px-5 py-4 border-b border-stone-200">
              <div className="min-w-0">
                <div className="font-serif text-base leading-tight text-club-ink" data-testid="portal-mobile-drawer-club-name">
                  {clubName}
                </div>
                <div className="mt-1 text-[10px] uppercase tracking-[0.2em] text-stone-500">
                  Employee Portal
                </div>
                <div className="mt-3 text-sm text-club-ink" data-testid="portal-mobile-drawer-name">
                  {displayName}
                </div>
                <div className="font-mono text-[11px] text-stone-500" data-testid="portal-mobile-drawer-employee-number">
                  {employeeNumber}
                </div>
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded-md p-1.5 text-stone-500 hover:bg-stone-50 hover:text-club-ink"
                aria-label="Close navigation menu"
                data-testid="portal-mobile-menu-close"
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" aria-hidden="true">
                  <line x1="6" y1="6" x2="18" y2="18" />
                  <line x1="18" y1="6" x2="6" y2="18" />
                </svg>
              </button>
            </div>
            <nav className="px-3 py-3 space-y-0.5 flex-1 overflow-y-auto" data-testid="portal-mobile-nav">
              {EMPLOYEE_NAV.map((item) => {
                const active = item.href === "/employee"
                  ? pathname === "/employee"
                  : pathname === item.href || pathname.startsWith(item.href + "/");
                const testid = `portal-mobile-nav-${item.label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={cn(
                      "block rounded-md px-3 py-2 text-sm",
                      active
                        ? "bg-club-green-50 text-club-green-800 font-medium"
                        : "text-stone-700 hover:bg-stone-50 hover:text-club-ink",
                    )}
                    data-testid={testid}
                    // Duplicated tour anchor so the CoachMark can attach
                    // to whichever nav layer is currently in the DOM.
                    data-tour-target={item.tourTarget}
                  >
                    {item.label}
                  </Link>
                );
              })}
            </nav>
          </aside>
        </div>
      )}
    </>
  );
}
