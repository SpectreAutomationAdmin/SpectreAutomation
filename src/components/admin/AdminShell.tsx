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

// Phase 4R rev-4 (2026-08-15) — canonical shell.
//
// Prior state (Phase 1 opt-in): only `/app/admin`, `/app/admin/coa`,
// `/app/admin/settings`, `/app/admin/design-system[/…]` rendered the
// Spectre chrome; every other admin route used the LEGACY sidebar +
// topbar. The founder identified this as the root cause of an
// inconsistent left navigation between Mission Control and every
// deeper admin route (vendors, members, AP invoices, etc.).
//
// Rev-4 (2026-08-15) — Spectre chrome is the DEFAULT for every admin
// route. Only surfaces with a compelling product reason for a
// genuinely different shell opt out:
//
//   • `/app/admin/ops/pos/lounge[/…]` — POS mode (edge-to-edge
//     touch workflow behind a bar); stripped-chrome layout.
//   • `/app/admin/reporting[/…]` — Monthly Board Reporting Package
//     surfaces have a founder-approved standalone "boardroom
//     document" chrome (chapter rail + back-to-admin link) that
//     replaces the general application shell. See
//     `REPORTING_MODE_PREFIXES` above.
//
// Everything else — Members, People (HR), AP Vendors, Vendor Timeline,
// AP Invoices, Capture Inbox, Approvals, Governance, Analytics,
// Employee Directory, Onboarding, etc. — renders on the same
// `SpectreShell` as Mission Control, so sidebar identity, navigation,
// and chrome remain stable while page content changes.
//
// HR-2A.2 / HR-2A.4 / HR-2B modules automatically inherit the
// canonical Spectre shell because they are `/app/admin/*` routes and
// no opt-out is declared for them.
//
// If a future genuine exception is needed, add it as a
// `LEGACY_CHROME_PREFIXES` opt-OUT list here with a documented reason.

function isPOSPath(pathname: string): boolean {
  return POS_MODE_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + "/"));
}

function isReportingPath(pathname: string): boolean {
  return REPORTING_MODE_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + "/"));
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
  // Rev-4 (2026-08-15): all three are optional in the type but the
  // admin layout always supplies them. When present, the Spectre
  // shell renders by default for every /app/admin/* route (except
  // the two opt-outs above). The legacy sidebar/topbar remain
  // wired as an emergency fallback only.
  spectreSidebar?: ReactNode;
  spectreTopbar?: ReactNode;
  spectreClubAccentStyle?: CSSProperties;
  children: ReactNode;
}) {
  const pathname = usePathname() ?? "";
  const pos = isPOSPath(pathname);
  const reporting = isReportingPath(pathname);
  // Phase 4R rev-4 (2026-08-15) — Spectre chrome is the default for
  // every non-POS, non-reporting admin route. The legacy chrome is
  // only used as a fallback if the layout omitted the Spectre slots.
  const spectre =
    !pos &&
    !reporting &&
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
