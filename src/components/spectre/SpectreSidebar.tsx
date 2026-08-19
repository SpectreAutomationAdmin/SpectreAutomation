"use client";

// Spectre Design Language — sidebar (Phase 1).
//
// 248 px expanded, 72 px collapsed. Smooth width transition on collapse.
// Section headings, per-item icons, clean active state (accent-soft
// background + 2-px accent bar on the left edge — NO glow). Reads
// the same nav data catalogue as the legacy Sidebar so permission
// gating + section grouping + active-route resolution are identical.
//
// A search entry sits at the top of the sidebar with a ⌘K hint. It's
// wired to a no-op in Phase 1; the actual command palette is a
// future slice.

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { cn } from "@/lib/ui";
import {
  ADMIN_TOP_LEVEL,
  ADMIN_SECTIONS,
  ADMIN_PERSONAL,
  type NavItem,
  type NavSection,
  type PermCheck,
} from "@/components/sidebar-nav-data";
import {
  IconChevronRight,
  IconHome,
  IconInbox,
  IconCog,
  IconFileText,
  IconPanelLeft,
  IconUser,
} from "./icons";
import SidebarIcon, { type NavigationIconKey } from "./SidebarIcon";

function canSee(perm: PermCheck | undefined, perms: Set<string>, isSuper: boolean): boolean {
  if (!perm) return true;
  if (perm === "SUPER_ONLY") return isSuper;
  if (Array.isArray(perm)) return isSuper || perm.some((p) => perms.has(p));
  return isSuper || perms.has(perm);
}

function resolveActiveHref(items: NavItem[], pathname: string): string | null {
  let best: { href: string; len: number } | null = null;
  for (const item of items) {
    if (pathname === item.href) return item.href;
    if (item.href === "/app/admin" || item.href === "/app/member") continue;
    if (pathname.startsWith(item.href + "/")) {
      if (!best || item.href.length > best.len) best = { href: item.href, len: item.href.length };
    }
  }
  return best?.href ?? null;
}

function findSectionForHref(href: string | null, sections: NavSection[]): string | null {
  if (!href) return null;
  for (const s of sections) if (s.items.some((it) => it.href === href)) return s.id;
  return null;
}

// Sprint 3 · Checkpoint 15N — Variant D icon resolution.
//
// Every nav item / section / personal item carries a typed `icon`
// key on its data-catalog entry (see sidebar-nav-data.ts). This
// helper prefers that explicit key and falls back to a best-effort
// URL-shape lookup so any nav entry the founder adds without an
// icon key still gets a sensible glyph until it's assigned one.
//
// The fallback uses the legacy Spectre icon set (IconHome, IconInbox,
// IconCog, IconFileText, IconUser). Only nav items that pre-date the
// 15N migration and haven't been assigned an explicit `icon` key
// hit this branch — the audit-covered items in sidebar-nav-data.ts
// all resolve through the typed path.
function renderNavIcon(item: { href: string; icon?: NavigationIconKey }): React.ReactNode {
  if (item.icon) return <SidebarIcon name={item.icon} className="spectre-nav-icon" />;
  if (item.href === "/app/admin") return <IconHome className="spectre-nav-icon" />;
  if (item.href.includes("/notifications")) return <IconInbox className="spectre-nav-icon" />;
  if (item.href.includes("/settings") || item.href.includes("/mfa")) return <IconCog className="spectre-nav-icon" />;
  if (item.href.includes("/design-system")) return <IconFileText className="spectre-nav-icon" />;
  return <IconUser className="spectre-nav-icon" />;
}

export function SpectreSidebar({
  clubName,
  permissions,
  isSuperAdmin,
}: {
  clubName: string;
  permissions: string[];
  isSuperAdmin: boolean;
}) {
  const pathname = usePathname() ?? "";
  const [collapsed, setCollapsed] = useState(false);
  const perms = useMemo(() => new Set(permissions), [permissions]);

  const visibleTopLevel = useMemo(
    () => ADMIN_TOP_LEVEL.filter((it) => canSee(it.perm, perms, isSuperAdmin)),
    [perms, isSuperAdmin],
  );
  const visibleSections = useMemo(
    () =>
      ADMIN_SECTIONS.map((section) => ({
        ...section,
        items: section.items.filter((it) => canSee(it.perm, perms, isSuperAdmin)),
      })).filter((s) => s.items.length > 0),
    [perms, isSuperAdmin],
  );

  const allItems = useMemo(
    () => [
      ...visibleTopLevel,
      ...visibleSections.flatMap((s) => s.items),
      ...ADMIN_PERSONAL.filter((it) => canSee(it.perm, perms, isSuperAdmin)),
    ],
    [visibleTopLevel, visibleSections, perms, isSuperAdmin],
  );
  const activeHref = useMemo(() => resolveActiveHref(allItems, pathname), [allItems, pathname]);
  const activeSectionId = useMemo(
    () => findSectionForHref(activeHref, visibleSections),
    [activeHref, visibleSections],
  );

  const [openSectionId, setOpenSectionId] = useState<string | null>(activeSectionId);
  useEffect(() => {
    if (activeSectionId !== null) setOpenSectionId(activeSectionId);
  }, [activeSectionId]);

  return (
    <aside
      className="spectre-sidebar"
      data-testid="spectre-sidebar"
      data-collapsed={collapsed ? "true" : "false"}
    >
      {/* Identity block.
          Phase 4R rev-6 (2026-08-15) — pinned to the same vertical
          height as the topbar via `.spectre-sidebar-identity` so
          the divider beneath it aligns with the topbar's bottom
          border. Combined with the nav's rev-6 padding-top token
          (see `.spectre-sidebar-nav-scroll`), the first nav item
          baseline lines up with the greeting baseline in the
          workspace on the same horizontal band. */}
      <div
        className={cn(
          "spectre-sidebar-identity flex items-center gap-3 px-4 border-b border-[color:var(--spectre-border-hairline)]",
          collapsed && "justify-center px-2",
        )}
      >
        <div
          aria-hidden="true"
          className="h-8 w-8 rounded-md flex items-center justify-center text-xs font-semibold shrink-0"
          style={{
            background: "var(--spectre-accent)",
            color: "var(--spectre-text-inverse)",
          }}
        >
          S
        </div>
        {!collapsed && (
          <div className="min-w-0">
            {/* Phase 4R UI-refinement rev-2 (2026-08-15) — the
                persistent sidebar identifies the PRODUCT (Spectre
                Automation), not the current tenant. Both words share
                the previously-approved eyebrow treatment (uppercase,
                small, letter-spaced, muted) and stack on two lines
                so `AUTOMATION` sits directly beneath `SPECTRE`. This
                intentionally preserves the pre-rev-2 eyebrow
                elegance while stating the full product name. Tenant
                identity now lives in the application header rail
                (see src/components/spectre/HeaderContextRail.tsx).
                No third line — never "SPECTRE Spectre Automation",
                never a repeated wordmark. */}
            <div
              className="spectre-sidebar-product-name"
              data-testid="spectre-sidebar-product-name"
              title="Spectre Automation"
            >
              <div
                className="text-[10px] uppercase tracking-[0.14em] font-semibold leading-[1.2]"
                style={{ color: "var(--spectre-text-muted)" }}
                data-testid="spectre-sidebar-product-name-line-1"
              >
                SPECTRE
              </div>
              <div
                className="text-[10px] uppercase tracking-[0.14em] font-semibold leading-[1.2]"
                style={{ color: "var(--spectre-text-muted)" }}
                data-testid="spectre-sidebar-product-name-line-2"
              >
                AUTOMATION
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Phase 4R rev-4 (2026-08-15) — the sidebar-scoped search
          field was retired here. The canonical global search now
          lives in the top-right of `SpectreTopBar` via
          `<GlobalSearch>` so there is ONE search entry point for
          the whole application. The sidebar begins with the product
          identity and dives straight into navigation. */}

      {/* Nav */}
      <nav className="spectre-sidebar-nav-scroll flex-1 overflow-y-auto pb-3">
        <div className="space-y-0.5">
          {visibleTopLevel.map((item) => {
            const active = item.href === activeHref;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  "spectre-nav-item",
                  active && "spectre-nav-item--active",
                )}
                title={collapsed ? item.label : undefined}
                aria-current={active ? "page" : undefined}
              >
                {renderNavIcon(item)}
                {!collapsed && <span className="truncate">{item.label}</span>}
              </Link>
            );
          })}
        </div>

        {visibleSections.map((section) => {
          const isOpen = openSectionId === section.id;
          const containsActive = activeSectionId === section.id;
          if (collapsed) {
            // Collapsed: render section as a list of icon buttons, no header.
            return (
              <div key={section.id} className="pt-2">
                {section.items.map((item) => {
                  const active = item.href === activeHref;
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      className={cn("spectre-nav-item", active && "spectre-nav-item--active")}
                      title={item.label}
                    >
                      {/* Sprint 3 · Checkpoint 15N — in collapsed mode
                          each section item is icon-only. The item itself
                          rarely carries its own icon key (children stay
                          text-only in expanded mode), so fall back to
                          the section's icon so the operator still sees
                          a coherent glyph per row. */}
                      {renderNavIcon({ href: item.href, icon: item.icon ?? section.icon })}
                    </Link>
                  );
                })}
              </div>
            );
          }
          return (
            <div key={section.id} className="pt-3">
              <button
                type="button"
                onClick={() => setOpenSectionId((prev) => (prev === section.id ? null : section.id))}
                aria-expanded={isOpen}
                aria-controls={`spectre-nav-section-${section.id}`}
                data-testid={`nav-section-toggle-${section.id}`}
                data-open={isOpen ? "true" : "false"}
                data-contains-active={containsActive ? "true" : "false"}
                className={cn(
                  "spectre-nav-section-header w-full flex items-center justify-between",
                  "hover:text-[color:var(--spectre-text-primary)] transition-colors duration-spectre-fast ease-spectre",
                )}
              >
                {/* Sprint 3 · Checkpoint 15N — section header carries
                    the Variant D icon. Icon left, label centre,
                    chevron right — the alignment matches the reference
                    and stays consistent whether the section is open or
                    closed (chevron rotates, icon does not shift). */}
                <span className="spectre-nav-section-header-lede">
                  {section.icon ? (
                    <SidebarIcon
                      name={section.icon}
                      className="spectre-nav-icon spectre-nav-section-icon"
                    />
                  ) : null}
                  <span>{section.label}</span>
                </span>
                <span
                  className="transition-transform duration-spectre-fast ease-spectre"
                  style={{ transform: isOpen ? "rotate(90deg)" : "rotate(0deg)" }}
                >
                  <IconChevronRight size={12} />
                </span>
              </button>
              {isOpen && (
                <div id={`spectre-nav-section-${section.id}`} className="mt-1 space-y-0.5">
                  {section.items.map((item) => {
                    const active = item.href === activeHref;
                    return (
                      <Link
                        key={item.href}
                        href={item.href}
                        className={cn("spectre-nav-item", active && "spectre-nav-item--active")}
                        aria-current={active ? "page" : undefined}
                      >
                        <span
                          className="spectre-nav-icon"
                          aria-hidden="true"
                          style={{ width: 16, height: 16 }}
                        />
                        <span className="truncate">{item.label}</span>
                      </Link>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}

        {!collapsed && (
          <div className="mt-3 pt-3 border-t border-[color:var(--spectre-border-hairline)] space-y-0.5">
            {ADMIN_PERSONAL.filter((it) => canSee(it.perm, perms, isSuperAdmin)).map((item) => {
              const active = item.href === activeHref;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={cn("spectre-nav-item", active && "spectre-nav-item--active")}
                  aria-current={active ? "page" : undefined}
                >
                  {renderNavIcon(item)}
                  <span className="truncate">{item.label}</span>
                </Link>
              );
            })}
          </div>
        )}
      </nav>

      {/* Collapse toggle */}
      <div className={cn("border-t border-[color:var(--spectre-border-hairline)] p-2 flex", collapsed ? "justify-center" : "justify-end")}>
        <button
          type="button"
          onClick={() => setCollapsed((v) => !v)}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          className="spectre-btn spectre-btn--ghost spectre-btn--sm"
        >
          {collapsed ? <IconChevronRight size={14} /> : <IconPanelLeft size={14} />}
        </button>
      </div>
    </aside>
  );
}
