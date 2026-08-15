// Shared breadcrumb derivation for Spectre application chrome.
//
// Phase 4R UI-refinement rev-2 (2026-08-15) — ONE source of truth for
// turning a `pathname` into a breadcrumb chain. Both the Spectre-chrome
// topbar and any future consumer MUST read from here.
//
// Rev-5 (2026-08-15) — dynamic entity labels + segment suppression +
// acronym overrides + full-path leaf overrides. The founder's rule:
//
//   Sidebar = primary navigation taxonomy
//   Breadcrumb = location within that taxonomy
//   NOT: Breadcrumb = prettified URL path
//
// Concretely:
//   • `/app/admin/ap/vendors` renders `App > AP > Vendors`
//     (not `App > Admin > Ap > Vendors`).
//   • Dynamic entity segments (vendor cuid, invoice id, member id)
//     resolve to their display name when the page provides one via
//     the `dynamicLabels` map (see the client-side
//     `BreadcrumbLabelsProvider` for the wiring path).
//   • The URL-namespace segment `admin` is SUPPRESSED — it is a
//     route namespace, not a user-facing navigation level. Mission
//     Control already reads `App > Mission Control` (never
//     `App > Admin > Mission Control`); rev-5 makes that consistent
//     across every non-Mission-Control admin route.

export interface Crumb {
  label: string;
  href?: string;
}

/**
 * Full-path leaf overrides. When the FINAL crumb's path matches an
 * entry here, the leaf label is replaced. Sub-routes are unaffected.
 * Used sparingly — most polish should flow through
 * `SEGMENT_LABEL_OVERRIDES` (per-segment) so the same word renders
 * consistently at every depth.
 */
export const PATH_LEAF_LABEL_OVERRIDES: Record<string, string> = {
  "/app/admin": "Mission Control",
  "/app/member": "Member Portal",
};

/**
 * Segments that never appear as breadcrumb crumbs. `admin` is a
 * URL namespace, not a user-facing navigation concept — Mission
 * Control's `App > Mission Control` breadcrumb already reflects this;
 * rev-5 extends the same convention to every sub-route.
 *
 * NEVER suppress a segment that actually represents a real navigation
 * concept — the sidebar taxonomy is the guide.
 */
export const SEGMENT_SUPPRESS: ReadonlySet<string> = new Set(["admin"]);

/**
 * Per-segment label overrides. Applies to any segment with that
 * exact slug at ANY depth (contrast with the full-path map). Use
 * for acronyms whose generic Title-Case prettification is wrong
 * (`ap` → `AP`, `coa` → `COA`) or for a route slug that has a
 * canonical business word (`ops` → `Operations`).
 *
 * Not a general "prettify every word" mechanism — only the entries
 * listed here are overridden; every other segment continues to be
 * rendered by the generic kebab → Title-Case prettifier.
 */
export const SEGMENT_LABEL_OVERRIDES: Record<string, string> = {
  ap: "AP",
  ar: "AR",
  coa: "COA",
  gl: "GL",
  hr: "HR",
  it: "IT",
  mfa: "MFA",
  ops: "Operations",
  pos: "POS",
  ui: "UI",
};

function prettify(seg: string): string {
  return seg.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function looksLikeCuid(seg: string): boolean {
  // Prisma's default cuid starts with `c` + 24+ alnum chars.
  // Case-insensitive to catch fixtures / mixed-case tests too — a
  // real cuid is lowercase, but the guard's purpose is "no raw id
  // leaks to the user", so err on the side of catching more.
  if (/^c[a-z0-9]{20,}$/i.test(seg)) return true;
  // UUID-shaped ids too — defence for tenants that migrate id
  // strategies in the future.
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)) return true;
  return false;
}

export interface DeriveBreadcrumbsOptions {
  /**
   * Map of dynamic entity segments (a vendor cuid, an invoice id,
   * a member id) → the human display name the page wants the
   * breadcrumb to show. Populated on the client via
   * `<RegisterBreadcrumbLabel id label />` inside the page/layout
   * that owns the entity. Missing entries fall back to a generic
   * "Detail" placeholder rather than leaking the cuid.
   */
  dynamicLabels?: Record<string, string>;
}

/**
 * Convert a URL pathname into a breadcrumb chain.
 *
 * Applied in this order per segment:
 *   1. `SEGMENT_SUPPRESS` — skip entirely (`admin`)
 *   2. `dynamicLabels[segment]` — page-supplied entity name
 *   3. cuid/UUID shape — fall back to `Detail` (never leak the id)
 *   4. `PATH_LEAF_LABEL_OVERRIDES[currentPath]` (leaf only)
 *   5. `SEGMENT_LABEL_OVERRIDES[segment]` — canonical acronyms
 *   6. generic kebab → Title-Case prettifier
 */
export function deriveBreadcrumbs(
  pathname: string,
  opts: DeriveBreadcrumbsOptions = {},
): Crumb[] {
  const dyn = opts.dynamicLabels ?? {};
  const parts = pathname.split("/").filter(Boolean);
  // Build the crumb chain with the surviving segments only. The href
  // for each crumb is the URL up-to-and-including its ORIGINAL
  // segment index — suppression must not break navigation links.
  const chain: Crumb[] = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const currentPath = "/" + parts.slice(0, i + 1).join("/");
    const isLast = i === parts.length - 1;
    // Leaf overrides (like `/app/admin` → "Mission Control") trump
    // segment suppression — otherwise `/app/admin` would collapse
    // to just `App` because `admin` is suppressed. When the leaf
    // has an override, we render that override AS the crumb even
    // if the segment slug is on the suppress list.
    const leafOverride = isLast ? PATH_LEAF_LABEL_OVERRIDES[currentPath] : undefined;
    if (!leafOverride && SEGMENT_SUPPRESS.has(part.toLowerCase())) continue;
    let label: string;
    if (leafOverride) {
      label = leafOverride;
    } else if (dyn[part]) {
      label = dyn[part];
    } else if (looksLikeCuid(part)) {
      label = "Detail";
    } else if (SEGMENT_LABEL_OVERRIDES[part.toLowerCase()]) {
      label = SEGMENT_LABEL_OVERRIDES[part.toLowerCase()];
    } else {
      label = prettify(part);
    }
    chain.push({
      label,
      href: isLast ? undefined : currentPath,
    });
  }
  return chain;
}
