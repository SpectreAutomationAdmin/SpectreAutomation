"use client";

// Spectre Design Language — top bar (Phase 1).
//
// 64 px height. Left: breadcrumbs. Right (in order): global search
// entry (compact), notifications button, theme toggle, user menu.
// Club selector is a placeholder slot for Phase 2 — its DOM position
// is reserved on the right rail between breadcrumbs and search.

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import {
  IconBell,
  IconChevronRight,
  IconChevronDown,
  IconMoon,
  IconMonitor,
  IconSearch,
  IconSun,
} from "./icons";
import { useSpectreTheme } from "./ThemeProvider";

type Crumb = { label: string; href?: string };

type Props = {
  userName: string;
  userRole: string;
  settingsHref?: string;
  breadcrumbs?: Crumb[];
};

// Auto-derive crumbs from the current pathname when the caller does
// not supply them. Segments in the pathname map to titlecase words;
// `/app/admin/design-system/foo` → App · Admin · Design System · Foo.
//
// Phase 4R UI-refinement (2026-08-15) — path-scoped label overrides.
// The prior derivation prettified `admin` uniformly, so the exact
// Mission Control route `/app/admin` rendered `App > Admin` even
// though Mission Control is the actual page. Overrides let a specific
// full path (or a segment at a specific depth) render a friendlier
// leaf label without regressing sub-routes like /app/admin/members
// (still `App > Admin > Members`).
const PATH_LEAF_LABEL_OVERRIDES: Record<string, string> = {
  "/app/admin": "Mission Control",
  "/app/member": "Member Portal",
};
function deriveCrumbsFromPath(pathname: string): Crumb[] {
  const parts = pathname.split("/").filter(Boolean);
  const seen: string[] = [];
  return parts.map((part, i) => {
    seen.push(part);
    const currentPath = "/" + seen.join("/");
    const isLast = i === parts.length - 1;
    const override = isLast ? PATH_LEAF_LABEL_OVERRIDES[currentPath] : undefined;
    return {
      label: override ?? prettify(part),
      href: isLast ? undefined : currentPath,
    };
  });
}
function prettify(seg: string): string {
  return seg
    .replace(/-/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export function SpectreTopBar({ userName, userRole, settingsHref, breadcrumbs }: Props) {
  const pathname = usePathname() ?? "";
  const derivedCrumbs = useMemo(() => deriveCrumbsFromPath(pathname), [pathname]);
  const crumbs = breadcrumbs ?? derivedCrumbs;

  const friendlyRole = userRole.replace(/_/g, " ").toLowerCase();
  const initials = userName.split(" ").filter(Boolean).slice(0, 2).map((s) => s[0]?.toUpperCase() ?? "").join("") || "?";

  const [menuOpen, setMenuOpen] = useState(false);
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

  const { theme, setTheme, resolvedTheme } = useSpectreTheme();
  const cycleTheme = () => {
    // light → dark → system → light
    if (theme === "light") setTheme("dark");
    else if (theme === "dark") setTheme("system");
    else setTheme("light");
  };
  const ThemeIcon = theme === "system" ? IconMonitor : resolvedTheme === "dark" ? IconMoon : IconSun;
  const themeLabel = theme === "system" ? "Theme: system" : theme === "dark" ? "Theme: dark" : "Theme: light";

  const onMenuKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLElement>("[data-menu-item]") ?? []);
    const idx = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === "ArrowDown") { e.preventDefault(); items[(idx + 1) % items.length]?.focus(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); items[(idx - 1 + items.length) % items.length]?.focus(); }
  };

  return (
    <header
      data-testid="spectre-topbar"
      className="spectre-topbar"
    >
      {/* Left — breadcrumbs */}
      <nav aria-label="Breadcrumb" className="spectre-crumbs min-w-0 flex-1">
        {crumbs.map((c, i) => (
          <span key={`${c.label}-${i}`} className="flex items-center gap-1.5 truncate">
            {c.href ? (
              <Link href={c.href}>{c.label}</Link>
            ) : (
              <span aria-current={i === crumbs.length - 1 ? "page" : undefined}>{c.label}</span>
            )}
            {i < crumbs.length - 1 && <span className="sep"><IconChevronRight size={12} /></span>}
          </span>
        ))}
      </nav>

      {/* Right — controls */}
      <div className="flex items-center gap-1 shrink-0">
        <button
          type="button"
          aria-label="Search (⌘K)"
          className="spectre-btn spectre-btn--ghost spectre-btn--icon"
        >
          <IconSearch size={16} />
        </button>
        <button
          type="button"
          aria-label="Notifications"
          className="spectre-btn spectre-btn--ghost spectre-btn--icon relative"
        >
          <IconBell size={16} />
          <span
            aria-hidden="true"
            className="absolute top-1.5 right-1.5 h-1.5 w-1.5 rounded-full"
            style={{ background: "var(--spectre-accent)" }}
          />
        </button>
        <button
          type="button"
          onClick={cycleTheme}
          aria-label={themeLabel}
          title={themeLabel}
          className="spectre-btn spectre-btn--ghost spectre-btn--icon"
          data-testid="spectre-theme-toggle"
        >
          <ThemeIcon size={16} />
        </button>
        <div className="w-px h-6 mx-1" style={{ background: "var(--spectre-border-hairline)" }} />
        <div className="relative">
          <button
            ref={triggerRef}
            type="button"
            onClick={() => setMenuOpen((v) => !v)}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label={`Account menu for ${userName}`}
            className="spectre-btn spectre-btn--ghost gap-2 pr-2"
          >
            <div
              aria-hidden="true"
              className="h-6 w-6 rounded-full flex items-center justify-center text-[10px] font-semibold"
              style={{ background: "var(--spectre-accent)", color: "var(--spectre-text-inverse)" }}
            >
              {initials}
            </div>
            <span className="text-[13px] font-medium">{userName}</span>
            <IconChevronDown size={12} />
          </button>
          {menuOpen && (
            <div
              ref={menuRef}
              role="menu"
              aria-label="Account menu"
              onKeyDown={onMenuKeyDown}
              className="absolute right-0 top-full mt-2 w-56 spectre-popover z-50"
            >
              <div className="px-3 py-2">
                <div className="text-[13px] font-medium" style={{ color: "var(--spectre-text-primary)" }}>{userName}</div>
                <div className="text-[11px] capitalize" style={{ color: "var(--spectre-text-muted)" }}>{friendlyRole}</div>
              </div>
              <div className="my-1 h-px" style={{ background: "var(--spectre-border-hairline)" }} />
              {settingsHref && (
                <Link
                  href={settingsHref}
                  role="menuitem"
                  data-menu-item
                  onClick={() => setMenuOpen(false)}
                  className="block px-3 py-2 text-[13px] rounded-md hover:bg-[color:var(--spectre-surface-hover)] transition-colors duration-spectre-fast"
                  style={{ color: "var(--spectre-text-primary)" }}
                >
                  User Settings
                </Link>
              )}
              <Link
                href="/api/logout"
                role="menuitem"
                data-menu-item
                onClick={() => setMenuOpen(false)}
                prefetch={false}
                className="block px-3 py-2 text-[13px] rounded-md hover:bg-[color:var(--spectre-surface-hover)] transition-colors duration-spectre-fast"
                style={{ color: "var(--spectre-text-primary)" }}
              >
                Sign Out
              </Link>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
