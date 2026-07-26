"use client";

// Admin + member portal sidebar.
//
// Admin sidebar: items are grouped into collapsible sections and each
// item is gated by a permission key (or set of keys). The admin layout
// resolves the current user's permission set and passes it in; items
// the user can't access never render. Sections that have no visible
// items are hidden entirely.
//
// Founder rule 2026-07-10: the section list behaves as a single-open
// accordion — only ONE section can be expanded at a time. Opening a
// section immediately collapses any other open section. Clicking the
// currently-open section's header collapses it (no section open).
// Navigation auto-opens the section that contains the new active
// route, so the user always lands with the relevant siblings visible.
// The section header carries a subtle "you are here" dot when the
// active route lives inside it, so the affordance is still visible
// when the user has collapsed everything.
//
// Member sidebar is a fixed flat list — members never see the engine.

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { cn } from "@/lib/ui";

// Nav data lives in a sibling .ts module so server code + vitest
// tests can import the route configuration without dragging the
// React/JSX in this client component through the bundler. See
// `./sidebar-nav-data.ts`.
import {
  ADMIN_TOP_LEVEL,
  ADMIN_SECTIONS,
  ADMIN_PERSONAL,
  MEMBER_NAV,
  type NavItem,
  type NavSection,
  type PermCheck,
} from "./sidebar-nav-data";

function canSee(perm: PermCheck | undefined, perms: Set<string>, isSuper: boolean): boolean {
  if (!perm) return true;
  if (perm === "SUPER_ONLY") return isSuper;
  if (Array.isArray(perm)) return isSuper || perm.some((p) => perms.has(p));
  return isSuper || perms.has(perm);
}

// Resolve the single nav href that should be highlighted for `pathname`.
// Rule: exact match wins, else the longest href that is a path-boundary
// prefix of `pathname`. This stops Overview items (e.g. /app/admin/ops)
// from staying highlighted when a more specific sibling (/app/admin/ops/pos)
// matches.
function resolveActiveHref(items: NavItem[], pathname: string): string | null {
  let best: { href: string; len: number } | null = null;
  for (const item of items) {
    if (pathname === item.href) return item.href;
    // The two index hrefs ("/app/admin" and "/app/member") only match
    // their exact path — every admin/member sub-route would otherwise
    // be a startsWith match.
    if (item.href === "/app/admin" || item.href === "/app/member") continue;
    if (pathname.startsWith(item.href + "/")) {
      if (!best || item.href.length > best.len) {
        best = { href: item.href, len: item.href.length };
      }
    }
  }
  return best?.href ?? null;
}

/**
 * Find the section that owns the given href (if any). Used to
 * auto-open the section containing the active route, and to render
 * the "you are here" dot on the matching section header.
 */
function findSectionForHref(
  href: string | null,
  visibleSections: NavSection[],
): string | null {
  if (!href) return null;
  for (const s of visibleSections) {
    if (s.items.some((it) => it.href === href)) return s.id;
  }
  return null;
}

export function Sidebar({
  kind,
  clubName,
  permissions = [],
  isSuperAdmin = false,
}: {
  kind: "admin" | "member";
  clubName: string;
  permissions?: string[];
  isSuperAdmin?: boolean;
}) {
  const pathname = usePathname();
  const perms = new Set(permissions);

  // Collect every nav item the user can see, then resolve the single
  // active href from the entire pool. This way the most specific
  // matching item wins across sections + top-level + personal.
  const allVisible: NavItem[] =
    kind === "member"
      ? MEMBER_NAV
      : [
          ...ADMIN_TOP_LEVEL.filter((it) => canSee(it.perm, perms, isSuperAdmin)),
          ...ADMIN_SECTIONS.flatMap((s) =>
            s.items.filter((it) => canSee(it.perm, perms, isSuperAdmin))
          ),
          ...ADMIN_PERSONAL,
        ];
  const activeHref = resolveActiveHref(allVisible, pathname);

  // The list of admin sections the current user can see — same
  // visibility rules the render uses. Memoised so the section-
  // lookup helper below is stable and the effect doesn't refire.
  const visibleSections = useMemo<NavSection[]>(
    () =>
      ADMIN_SECTIONS.map((s) => ({
        ...s,
        items: s.items.filter((it) => canSee(it.perm, perms, isSuperAdmin)),
      })).filter((s) => s.items.length > 0),
    // perms / isSuperAdmin only change when the principal changes;
    // recomputing on every render is cheap but useMemo keeps the
    // identity stable for the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [permissions.join("|"), isSuperAdmin],
  );

  // Section that contains the currently-active route, if any.
  // Drives both the auto-open behavior + the "you are here" dot
  // on the section header (so the user has a visual cue even
  // when they've collapsed the section).
  const activeSectionId = findSectionForHref(activeHref, visibleSections);

  // Single-open accordion state. The effect below auto-aligns it
  // with the active route on navigation, but a user click on a
  // section header (handled by `toggleSection`) is authoritative
  // for that click — they can collapse a section even when it
  // contains the active route.
  const [openSectionId, setOpenSectionId] = useState<string | null>(activeSectionId);
  useEffect(() => {
    // Only auto-open when there IS an active section. If the
    // active route is a top-level item (not inside any section),
    // leave the user's last manual choice alone.
    if (activeSectionId !== null) setOpenSectionId(activeSectionId);
  }, [activeSectionId]);

  function toggleSection(id: string) {
    setOpenSectionId((prev) => (prev === id ? null : id));
  }

  const renderItem = (item: NavItem) => {
    const active = item.href === activeHref;
    return (
      <Link
        key={item.href}
        href={item.href}
        className={cn(
          "block rounded-md px-3 py-2 text-sm",
          active
            ? "bg-club-green-50 text-club-green-800 font-medium"
            : "text-stone-600 hover:bg-stone-50 hover:text-club-ink"
        )}
      >
        {item.label}
      </Link>
    );
  };

  if (kind === "member") {
    // Sign Out is no longer rendered in the sidebar — it lives in
    // the top-right account dropdown (see src/components/TopBar.tsx).
    // The founder's 2026-06-30 spec: "Top-right dropdown should be
    // the only place where Sign Out appears." This prevents the
    // duplicate affordance from drifting out of sync (and matches
    // the admin sidebar treatment below).
    return (
      <aside className="w-64 shrink-0 border-r border-stone-200 bg-white min-h-screen">
        <div className="px-6 py-6 border-b border-stone-200">
          <div className="font-serif text-lg leading-tight text-club-ink">{clubName}</div>
          <div className="mt-2 text-xs text-stone-500">Member Portal</div>
        </div>
        <nav className="px-3 py-4 space-y-0.5">{MEMBER_NAV.map(renderItem)}</nav>
      </aside>
    );
  }

  // ---------- Admin ----------
  const visibleTopLevel = ADMIN_TOP_LEVEL.filter((it) => canSee(it.perm, perms, isSuperAdmin));

  return (
    <aside className="w-64 shrink-0 border-r border-stone-200 bg-white min-h-screen">
      <div className="px-6 py-6 border-b border-stone-200">
        {/* The "Spectre" wordmark is internal — club staff (admin) can
            see who powers the platform, but members should be shielded
            from the engine and just see their own club's identity. */}
        <div className="text-xs uppercase tracking-widest text-stone-400">Spectre</div>
        <div className="mt-1 font-serif text-lg leading-tight text-club-ink">{clubName}</div>
        <div className="mt-2 text-xs text-stone-500">Administration</div>
      </div>
      <nav className="px-3 py-4 space-y-0.5">
        {visibleTopLevel.map(renderItem)}

        {visibleSections.map((section) => {
          // Single-open accordion: section is expanded iff its id
          // matches the one openSectionId. Every other section
          // collapses automatically when one opens.
          const isOpen = openSectionId === section.id;
          const containsActive = activeSectionId === section.id;
          return (
            <div key={section.id} className="pt-3">
              <button
                type="button"
                onClick={() => toggleSection(section.id)}
                aria-expanded={isOpen}
                aria-controls={`nav-section-${section.id}`}
                data-testid={`nav-section-toggle-${section.id}`}
                data-open={isOpen ? "true" : "false"}
                data-contains-active={containsActive ? "true" : "false"}
                className="w-full flex items-center justify-between text-[10px] uppercase tracking-wide text-stone-400 px-3 py-1 hover:text-stone-600"
              >
                <span className="inline-flex items-center gap-1.5">
                  {/* "You are here" dot — the active route's
                      section keeps this affordance even when the
                      user has collapsed it. Subtle club-green
                      dot to match the active-item highlight. */}
                  {containsActive && (
                    <span
                      aria-hidden="true"
                      className="inline-block h-1.5 w-1.5 rounded-full bg-club-green-600"
                      data-testid={`nav-section-active-dot-${section.id}`}
                    />
                  )}
                  <span>{section.label}</span>
                </span>
                <svg
                  width="10"
                  height="10"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className={cn("transition-transform", isOpen ? "rotate-90" : "")}
                  aria-hidden="true"
                >
                  <path d="M9 6l6 6-6 6" />
                </svg>
              </button>
              {isOpen && (
                <div
                  id={`nav-section-${section.id}`}
                  className="mt-1 space-y-0.5"
                  data-testid={`nav-section-body-${section.id}`}
                >
                  {section.items.map(renderItem)}
                </div>
              )}
            </div>
          );
        })}

        <div className="pt-3 mt-2 border-t border-stone-100">
          {ADMIN_PERSONAL.map(renderItem)}
        </div>
      </nav>
      {/* Sign Out lives in the top-right account dropdown — see
          src/components/TopBar.tsx. Removed from the sidebar
          2026-06-30 per founder spec ("Top-right dropdown should be
          the only place where Sign Out appears"). */}
    </aside>
  );
}
