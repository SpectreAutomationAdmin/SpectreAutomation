"use client";

// Phase 4R UI-refinement rev-2 (2026-08-15) — the shared header
// context rail. Renders "Tenant · Breadcrumb" as a single
// application-header layer so tenant identity is always established
// BEFORE the user reads where they are inside that tenant.
//
// Consumers:
//   • src/components/spectre/SpectreTopBar.tsx — Spectre-chrome routes
//
// Any future consumer (e.g. a legacy TopBar migration) MUST render
// this component rather than reimplementing tenant + crumb layout.

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useMemo } from "react";
import { IconChevronRight } from "./icons";
import { deriveBreadcrumbs, type Crumb } from "@/lib/chrome/breadcrumb";
import { useBreadcrumbLabels } from "./breadcrumb-labels";

type Props = {
  tenantName?: string | null;
  breadcrumbs?: Crumb[];
};

export function HeaderContextRail({ tenantName, breadcrumbs }: Props) {
  const pathname = usePathname() ?? "";
  // Phase 4R rev-5 (2026-08-15) — dynamic entity labels (vendor.legalName,
  // invoice.number, etc.) are supplied by the owning page via
  // <RegisterBreadcrumbLabel/> and read here through the shared
  // provider. Missing labels fall back to the "Detail" placeholder
  // in `deriveBreadcrumbs` — a cuid is NEVER shown to the user.
  const dynamicLabels = useBreadcrumbLabels();
  const derivedCrumbs = useMemo(
    () => deriveBreadcrumbs(pathname, { dynamicLabels }),
    [pathname, dynamicLabels],
  );
  const crumbs = breadcrumbs ?? derivedCrumbs;

  return (
    <nav
      aria-label="Tenant and breadcrumb"
      className="spectre-header-rail min-w-0 flex-1"
      data-testid="spectre-header-rail"
    >
      {tenantName ? (
        <>
          <span
            className="spectre-header-rail-tenant"
            data-testid="spectre-header-rail-tenant"
            title={tenantName}
          >
            {tenantName}
          </span>
          <span className="spectre-header-rail-sep" aria-hidden="true" />
        </>
      ) : null}
      <div
        className="spectre-crumbs min-w-0"
        data-testid="spectre-header-rail-crumbs"
      >
        {crumbs.map((c, i) => (
          <span key={`${c.label}-${i}`} className="flex items-center gap-1.5 truncate">
            {c.href ? (
              <Link href={c.href}>{c.label}</Link>
            ) : (
              <span aria-current={i === crumbs.length - 1 ? "page" : undefined}>{c.label}</span>
            )}
            {i < crumbs.length - 1 && (
              <span className="sep">
                <IconChevronRight size={12} />
              </span>
            )}
          </span>
        ))}
      </div>
    </nav>
  );
}
