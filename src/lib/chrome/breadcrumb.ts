// Shared breadcrumb derivation for Spectre application chrome.
//
// Phase 4R UI-refinement rev-2 (2026-08-15) — this module is the ONE
// source of truth for turning a `pathname` into a breadcrumb chain.
// Both the Spectre-chrome topbar and any future consumer (e.g. a
// migrated legacy admin topbar) MUST read from here so the chrome
// cannot develop competing concepts of breadcrumb text.
//
// Previous state:
//   - `deriveCrumbsFromPath` lived inline in
//     `src/components/spectre/SpectreTopBar.tsx`.
//   - The legacy `src/components/TopBar.tsx` rendered no breadcrumb
//     at all, so no competing derivation existed — but as soon as a
//     second chrome consumer wants to render crumbs it would be
//     tempted to duplicate the same map.
//
// Contract:
//   • `deriveBreadcrumbs(pathname)` returns an ordered chain of
//     `{label, href?}` for the given pathname. The final crumb has
//     no href (it is the current page).
//   • `PATH_LEAF_LABEL_OVERRIDES` translates a full path to a
//     friendlier LEAF label, ONLY when that path is the final crumb
//     (so `/app/admin` renders "Mission Control" but /app/admin/members
//     still renders "App > Admin > Members").
//   • Segment prettification is generic (kebab → Title Case).

export interface Crumb {
  label: string;
  href?: string;
}

/**
 * Path-scoped leaf label overrides. Extend this map for every route
 * whose exact URL should render a friendlier final crumb than the
 * generic segment prettifier would produce. Sub-routes of an
 * overridden path are UNAFFECTED — they get the standard
 * prettification applied to every segment.
 */
export const PATH_LEAF_LABEL_OVERRIDES: Record<string, string> = {
  "/app/admin": "Mission Control",
  "/app/member": "Member Portal",
};

function prettify(seg: string): string {
  return seg.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export function deriveBreadcrumbs(pathname: string): Crumb[] {
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
