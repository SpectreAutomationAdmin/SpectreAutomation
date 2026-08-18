"use client";

// Client-side chrome chooser for the admin layout.
//
// When the user opens any POS route, the lounge / kitchen / bar
// surfaces benefit from edge-to-edge real estate — the sidebar +
// top bar are noise on a touch screen wedged behind a bar. In "POS
// mode" we strip the chrome down to a thin header with a single back
// arrow that takes the operator back to Operations.
//
// Why a client component: the parent admin layout is server-rendered
// (auth, branding, support-session lookup) and doesn't know the
// pathname. This shell receives the pre-built chrome (sidebar, topbar,
// optional support banner) as slots and decides per-route which to
// render. The rest of the layout stays server-rendered.

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { CSSProperties, ReactNode } from "react";
import { SpectreShell } from "@/components/spectre/SpectreShell";

// Paths that enter POS mode. Anything starting with one of these
// gets the stripped chrome. Only operator-facing POS UIs belong here
// — review surfaces like the sales-history index keep the normal
// admin sidebar so managers can navigate around the rest of the app.
const POS_MODE_PREFIXES = ["/app/admin/ops/pos/lounge"];

// Paths that enter REPORTING mode. The board package surfaces want
// the report itself to be the dominant screen element — admin
// sidebar + topbar would compete with the document. The reporting
// layout provides its own quiet chrome (chapter rail + back-to-admin
// link). See docs/monthly-reporting-design-audit.md for the standard
// this implements.
const REPORTING_MODE_PREFIXES = ["/app/admin/reporting"];

// Founder rule 2026-07-14 (Phase 1 UI Architecture) — Spectre Design
// Language opt-in.
//
// PREFIX match: only routes under `/app/admin/design-system` enter
// the new Spectre application shell. The Admin Dashboard (`/app/admin`)
// is explicitly out of scope during Phase 1 per the founder's brief
// and is now back on the legacy shell (this list previously carried
// `/app/admin` under Slice 1a; that entry was removed when the
// dashboard flagship migration was reverted).
//
// Every OTHER route continues to render UNCHANGED:
//   • /app/admin                                → legacy shell (dashboard is out of scope)
//   • /app/admin/reporting/**                   → reporting-mode (untouched)
//   • /app/admin/governance/monthly-package[/…] → default legacy shell (pixel-identical)
//   • /app/admin/governance/packages[/…]        → default legacy shell
//   • /app/admin/ops/pos/lounge[/…]             → POS-mode (untouched)
//   • every other /app/admin/* route            → default legacy shell
const SPECTRE_MODE_PREFIXES: ReadonlyArray<string> = [
  "/app/admin/design-system",
  // Phase 2 — Settings workspace proof. The sub-routes
  // (`/app/admin/settings/domains`, `/app/admin/settings/pos-printers`)
  // are OUT OF SCOPE for Phase 2 and must continue to render through
  // the legacy chrome; the AdminShell prefix match therefore uses an
  // EXACT-URL test for this entry, not a substring prefix. See
  // `isSpectreModePath` below for the matching rule.
  "/app/admin/settings",
  // Foundation v1.0 (2026-07-18) — Mission Control. Founder-approved
  // Professional Instrument design lives at exactly `/app/admin`. Every
  // sub-route (`/app/admin/members`, `/app/admin/coa`, `/app/admin/ap/*`,
  // etc.) MUST continue to render on the legacy chrome, so this entry
  // is EXACT-URL matched — see `SPECTRE_MODE_EXACT_URLS` below.
  "/app/admin",
  // Data Workspace Foundation v1.0 (2026-07-18) — Chart of Accounts.
  // Founder-approved concept lives at `public/design-concepts/data-workspace/`.
  // The production integration renders on the Spectre chrome; child
  // routes under `/app/admin/coa/**` (like the legacy `/coa/new`
  // full-page form) remain on legacy chrome. Exact-URL matched.
  "/app/admin/coa",
  // HR-2A.2 (2026-08-17) — People module. Founder feedback identified
  // that People pages were rendering through the legacy chrome while
  // Mission Control uses the canonical Spectre chrome. `/app/admin/people`
  // is a PREFIX match (not exact) so all sub-routes — Employee Directory,
  // Add Employee, Employee Profile, Onboarding — render through
  // SpectreSidebar + SpectreTopBar. Employee Profile's INTERNAL
  // composition mirrors the Member profile visual language separately.
  "/app/admin/people",
  // HR-2A.4 (2026-08-17) — Members recovered Phase 20 profile
  // implementation renders on the same canonical Spectre shell. Prefix
  // match covers `/app/admin/members`, `/app/admin/members/[id]`, and
  // any future admin sub-routes (invites, etc). Member and Employee
  // profiles now share both the shell chrome AND the `.spectre-person-*`
  // profile grammar — two implementations of the same Spectre Person
  // Profile system.
  "/app/admin/members",
];

/** URLs in `SPECTRE_MODE_PREFIXES` that should EXACT-match (i.e. not
 *  cascade to sub-routes). Phase 2 needs this for
 *  `/app/admin/settings` so `/app/admin/settings/domains` and
 *  `/app/admin/settings/pos-printers` continue to render on the
 *  legacy chrome. Foundation v1.0 needs the same for `/app/admin` so
 *  Mission Control is scoped to the exact route and every existing
 *  admin sub-page keeps its current chrome untouched. */
const SPECTRE_MODE_EXACT_URLS: ReadonlyArray<string> = [
  "/app/admin/settings",
  "/app/admin",
  "/app/admin/coa",
];

function isPOSPath(pathname: string): boolean {
  return POS_MODE_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + "/"));
}

function isReportingPath(pathname: string): boolean {
  return REPORTING_MODE_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + "/"));
}

function isSpectreModePath(pathname: string): boolean {
  // Two-tier match:
  //   1. Entries listed in SPECTRE_MODE_EXACT_URLS match ONLY the
  //      exact URL; sub-routes fall through to the legacy chrome.
  //   2. Every other entry in SPECTRE_MODE_PREFIXES uses a substring
  //      prefix match, matching the entry itself + any nested route.
  for (const p of SPECTRE_MODE_PREFIXES) {
    if (SPECTRE_MODE_EXACT_URLS.includes(p)) {
      if (pathname === p) return true;
      continue;
    }
    if (pathname === p || pathname.startsWith(p + "/")) return true;
  }
  return false;
}

export function AdminShell({
  sidebar,
  topbar,
  supportBanner,
  toast,
  spectreSidebar,
  spectreTopbar,
  spectreClubAccentStyle,
  children,
}: {
  sidebar: ReactNode;
  topbar: ReactNode;
  supportBanner?: ReactNode | null;
  toast?: ReactNode;
  // Slice 1 additions. All three are optional — an admin layout that
  // omits them still gets the legacy shell for every route. When
  // provided, the SpectreShell branch only fires for routes in
  // SPECTRE_MODE_EXACT_PATHS, so passing them does NOT change the
  // rendering of any un-migrated route.
  spectreSidebar?: ReactNode;
  spectreTopbar?: ReactNode;
  spectreClubAccentStyle?: CSSProperties;
  children: ReactNode;
}) {
  const pathname = usePathname() ?? "";
  const pos = isPOSPath(pathname);
  const reporting = isReportingPath(pathname);
  const spectre =
    !pos &&
    !reporting &&
    isSpectreModePath(pathname) &&
    !!spectreSidebar &&
    !!spectreTopbar;

  if (reporting) {
    // Reporting mode: admin sidebar + topbar are stripped. The
    // reporting layout (src/app/app/admin/reporting/layout.tsx)
    // provides its own quiet chrome. We still render the support
    // banner if any so impersonation stays visible. Auth +
    // permission resolution already ran in the parent admin layout,
    // so dropping the chrome does not weaken access control.
    return (
      <div data-testid="reporting-mode-shell" className="min-h-screen bg-club-cream">
        {supportBanner}
        {children}
        {toast}
      </div>
    );
  }

  if (pos) {
    const isLoungePOS = pathname.startsWith("/app/admin/ops/pos/lounge");
    return (
      // h-screen + overflow-hidden on the outer container locks the
      // page to exactly the viewport — children can never push the
      // document below the fold. `<main>` then takes flex-1 of the
      // remaining height and clips its own overflow.
      <div className="h-screen flex flex-col bg-stone-50 overflow-hidden">
        {/* Thin POS-mode header. Back arrow on the left, surface
            label + sibling-surface nav in the middle, mode indicator
            on the right. Consolidating these here lets the page body
            use the full remaining height for actual POS workflow. */}
        <header className="shrink-0 flex items-center gap-3 border-b border-stone-200 bg-white px-4 py-2">
          <Link
            href="/app/admin/ops"
            className="inline-flex items-center gap-2 rounded-md px-2 py-1 text-sm text-stone-700 hover:bg-stone-100 focus:outline-none focus:ring-2 focus:ring-club-green-400/40"
            aria-label="Exit POS mode"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M19 12H5" />
              <path d="M12 19l-7-7 7-7" />
            </svg>
            <span>Exit POS</span>
          </Link>
          {isLoungePOS && (
            <>
              <span className="text-stone-300" aria-hidden="true">·</span>
              <span className="text-sm font-medium text-club-ink whitespace-nowrap">
                Clubhouse Lounge
              </span>
              <nav className="ml-2 flex items-center gap-1" aria-label="Lounge POS surfaces">
                {/* "Quick sale" pill points at the legacy tableless
                    ringup. The primary seated-dining entry is the floor
                    map, reached from the sidebar "Point of Sale" link
                    or from the link below. */}
                <PosNavPill href="/app/admin/ops/pos/lounge" label="Quick sale" pathname={pathname} exact />
                <PosNavPill href="/app/admin/ops/pos/lounge/kitchen" label="Kitchen" pathname={pathname} />
                <PosNavPill href="/app/admin/ops/pos/lounge/bar" label="Bar" pathname={pathname} />
                <PosNavPill href="/app/admin/ops/pos/lounge/history" label="History" pathname={pathname} />
                <span className="text-stone-300 mx-1" aria-hidden="true">|</span>
                <Link
                  href="/app/admin/hospitality/reservations/floor"
                  className="inline-flex items-center rounded-md px-2.5 py-1 text-xs whitespace-nowrap bg-club-green-600 text-white hover:bg-club-green-700 focus:outline-none focus:ring-2 focus:ring-club-green-400/40"
                >
                  Floor Map POS →
                </Link>
              </nav>
            </>
          )}
          <div className="ml-auto inline-flex items-center gap-2 text-[10px] uppercase tracking-widest text-stone-400 shrink-0">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-club-green-500" aria-hidden="true" />
            POS mode
          </div>
        </header>
        {supportBanner}
        <main className="flex-1 min-h-0 px-4 py-3 overflow-hidden flex flex-col">{children}</main>
        {toast}
      </div>
    );
  }

  if (spectre) {
    return (
      <>
        <SpectreShell
          sidebar={spectreSidebar}
          topbar={spectreTopbar}
          supportBanner={supportBanner}
          clubAccentStyle={spectreClubAccentStyle}
        >
          {children}
        </SpectreShell>
        {toast}
      </>
    );
  }

  return (
    <div className="min-h-screen flex bg-stone-50">
      {sidebar}
      <div className="flex-1 flex flex-col min-w-0">
        {topbar}
        {supportBanner}
        <main className="flex-1 px-8 py-8 overflow-x-auto">{children}</main>
        {toast}
      </div>
    </div>
  );
}

// Sibling-surface pill in the POS-mode header. The currently-active
// surface renders as a non-link span so a server doesn't waste a tap
// reloading the page they're already on.
function PosNavPill({
  href,
  label,
  pathname,
  exact,
}: {
  href: string;
  label: string;
  pathname: string;
  exact?: boolean;
}) {
  const active = exact ? pathname === href : pathname === href || pathname.startsWith(href + "/");
  const base = "inline-flex items-center rounded-md px-2.5 py-1 text-xs whitespace-nowrap";
  if (active) {
    return (
      <span className={`${base} bg-club-green-50 text-club-green-800 font-medium`} aria-current="page">
        {label}
      </span>
    );
  }
  return (
    <Link
      href={href}
      className={`${base} text-stone-600 hover:bg-stone-100 hover:text-club-ink focus:outline-none focus:ring-2 focus:ring-club-green-400/40`}
    >
      {label}
    </Link>
  );
}
