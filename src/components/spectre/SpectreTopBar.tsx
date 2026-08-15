"use client";

// Spectre Design Language — top bar (Phase 1).
//
// 64 px height. Left: tenant + breadcrumbs (via HeaderContextRail).
// Right (in order): global search entry (compact), notifications
// button, theme toggle, user menu. Club selector is a placeholder
// slot for Phase 2 — its DOM position is reserved on the right rail
// between the header rail and search.
//
// Phase 4R UI-refinement rev-2 (2026-08-15) — breadcrumb derivation
// moved to the shared `src/lib/chrome/breadcrumb.ts` module. Tenant
// identity + breadcrumb render together via `HeaderContextRail` so
// any future admin-chrome consumer reads from ONE source of truth.

import Link from "next/link";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import {
  IconBell,
  IconChevronDown,
  IconMoon,
  IconMonitor,
  IconSun,
} from "./icons";
import { useSpectreTheme } from "./ThemeProvider";
import { HeaderContextRail } from "./HeaderContextRail";
import { GlobalSearch } from "./GlobalSearch";
import type { Crumb } from "@/lib/chrome/breadcrumb";

type Props = {
  userName: string;
  userRole: string;
  settingsHref?: string;
  breadcrumbs?: Crumb[];
  /** Active tenant/club name — rendered before the breadcrumb chain
   *  in the header rail so the user first establishes WHICH tenant
   *  they are operating within, then WHERE they are inside it. */
  tenantName?: string | null;
};

export function SpectreTopBar({
  userName,
  userRole,
  settingsHref,
  breadcrumbs,
  tenantName,
}: Props) {
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
      {/* Left — tenant + breadcrumb (shared rail) */}
      <HeaderContextRail tenantName={tenantName} breadcrumbs={breadcrumbs} />

      {/* Right — controls */}
      <div className="flex items-center gap-1 shrink-0">
        {/* Phase 4R rev-4 (2026-08-15) — canonical global-search entry
            point. Collapsed = icon, expanded = inline input +
            predictive grouped dropdown. Replaces the previous dummy
            IconSearch button AND the redundant sidebar search field. */}
        <GlobalSearch />
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
