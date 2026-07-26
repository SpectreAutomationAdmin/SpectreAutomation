"use client";

// Spectre Executive Reporting Shell.
//
// Replaces the admin sidebar + topbar with quiet board-package
// chrome for all routes under /app/admin/reporting/**. AdminShell
// detects the reporting path and strips its own chrome; this shell
// then renders inside that space and owns:
//
//   - a thin top header with a close glyph, club / spectre
//     identity, the report title, period chip, and a Print Mode
//     toggle
//   - a left chapter rail styled as a print TOC (serif, restrained)
//   - a centered reading column for the actual report content
//
// Step / Print Mode:
//   Toggling Print Mode sets `data-print-mode="true"` on the shell
//   root. globals.css matches that attribute (and `@media print`)
//   to strip non-essential chrome, widen the reading column, and
//   prevent card / chart break-across-page. There is no PDF export
//   pipeline yet — the toggle exists so the screen previews the
//   printable layout AND so File → Print → Save as PDF produces
//   the same board-readable document.

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { chapterIdFor } from "@/lib/reporting/chapter-id";
export { chapterIdFor };

export type ReportingChapter = {
  /** Roman numeral marker (e.g. "I", "II"). Set by the caller; the
   *  rail prints it as the chapter index. */
  number: string;
  /** Visible label rendered in the rail AND used as the source of
   *  truth for the chapter's section id (via `chapterIdFor(label)`).
   *  Per the naming-convention rule 2026-06-19, there is no separate
   *  `id` field — the id is always derived from the label so manually
   *  entered ids cannot diverge from what the reader sees. */
  label: string;
  /** Section group heading rendered above this chapter in the rail
   *  (Saguaro-style grouping). Consecutive chapters with the same
   *  group label render under a single heading; the heading itself
   *  appears once at the start of the run. */
  group: string;
};

// `chapterIdFor` is the single canonical slugify used by:
//   - this shell's rail render loop
//   - tests/reporting-chapter-id-convention.test.ts (invariant guards)
// Defined in src/lib/reporting/chapter-id.ts so server-side code and
// vitest can import it without dragging React/JSX through the build.

const MONTH_LONG = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
] as const;

/**
 * Format a "YYYY-MM" period (as supplied via the report URL's
 * `?period=` searchParam) into a display string like "May 2026".
 * Falls back to null for missing / malformed values so the
 * layout-supplied default takes over.
 */
function formatPeriodLabel(periodParam: string | null): string | null {
  if (!periodParam) return null;
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(periodParam);
  if (!match) return null;
  const year = match[1];
  const month = Number(match[2]);
  return `${MONTH_LONG[month - 1]} ${year}`;
}

export function ReportingShell({
  clubName,
  reportTitle,
  periodLabel,
  preparedFor,
  chapters,
  children,
  closeHrefOverride,
}: {
  clubName: string;
  reportTitle: string;
  /** Default period label rendered when no `?period=YYYY-MM` is in
   *  the URL (e.g. the legacy direct route). When the launcher sends
   *  a period, the shell derives the label from the URL and the
   *  layout default is ignored. */
  periodLabel: string;
  preparedFor: string;
  chapters: ReadonlyArray<ReportingChapter>;
  children: ReactNode;
  /** Override the close-button target. The admin context defaults to
   *  the Monthly Package launcher (and forwards the active period as
   *  ?month=X&year=Y). The Board read-only context at
   *  /app/reports/monthly-package/[id] passes "/app/member" so
   *  closing the report returns the Board member to their dashboard
   *  instead of the controller launcher. */
  closeHrefOverride?: string;
}) {
  const pathname = usePathname() ?? "";
  const searchParams = useSearchParams();

  // Period label derivation: the report URL's `?period=YYYY-MM` is
  // the single source of truth when present. The layout-supplied
  // `periodLabel` prop only fires as a fallback for the legacy
  // direct route at /app/admin/reporting/monthly (no query string).
  const periodParam = searchParams?.get("period") ?? null;
  const urlPeriodLabel = formatPeriodLabel(periodParam);
  const effectivePeriodLabel = urlPeriodLabel ?? periodLabel;

  // Close-button target. Closing a Monthly Reporting Package returns
  // the controller to the Monthly Package LAUNCHER (not the main
  // admin dashboard) so they land back on the period-selection
  // screen they came from. If the current URL carries a period
  // param, forward it as `?month=X&year=Y` so the launcher pre-
  // selects the same month/year. Without a param the launcher
  // falls back to its default (most-recently-completed month).
  const periodMatch = periodParam ? /^(\d{4})-(0[1-9]|1[0-2])$/.exec(periodParam) : null;
  // closeHrefOverride wins when set (board/member context). Otherwise
  // the admin launcher default applies, preserving the existing
  // controller flow.
  const closeHref = closeHrefOverride ??
    (periodMatch
      ? `/app/admin/governance/monthly-package?year=${periodMatch[1]}&month=${Number(periodMatch[2])}`
      : "/app/admin/governance/monthly-package");

  // ─────────────────────────────────────────────────────────────
  // Active-chapter tracking for the left rail.
  //
  // The rail highlights whichever section the reader is currently
  // viewing. Two triggers update the active item:
  //   1. Click — onClickChapter() sets `activeId` eagerly and starts
  //      a smooth scroll to the section anchor.
  //   2. Scroll — IntersectionObserver watches all section anchors
  //      and promotes whichever is at the top of the reading area.
  //
  // The click handler also briefly suppresses the observer (via the
  // navUntilRef latch) so the highlight doesn't jitter through
  // intermediate sections while the smooth scroll is animating.
  // ─────────────────────────────────────────────────────────────
  const [activeId, setActiveId] = useState<string>(() =>
    chapters[0] ? chapterIdFor(chapters[0].label) : "",
  );
  const navUntilRef = useRef<{ id: string; until: number } | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    // Deterministic majority-visible scrollspy (replaces the prior
    // reading-line algorithm 2026-06-19 — that algorithm activated
    // the next section only once its heading crossed a fixed 140-px
    // line below the header, which felt laggy: by then the next
    // section already dominated the screen).
    //
    // Algorithm — for each section measure its visible pixel height
    // inside the USABLE viewport (viewport minus the sticky header).
    // Define:
    //   visibleRatio = visiblePixels / usableViewportHeight
    //
    // Activation rule (with hysteresis to prevent flicker):
    //   1. CHALLENGER. A non-active section with visibleRatio > 0.60
    //      AND a greater visible-pixel count than the current active
    //      wins. Among multiple challengers, the one with the
    //      greatest visible count wins; ties resolve to source order
    //      (preserved by iterating `elements` in source order).
    //   2. RELEASE. If no challenger qualifies AND the current
    //      active's visibleRatio has dropped below 0.10
    //      ("meaningfully visible" floor), fall back to the
    //      largest-visible section. This handles the case where the
    //      reader scrolls fast through a thin section that never
    //      exceeded 60 % itself.
    //   3. HOLD. Otherwise keep the current active. This is the
    //      hysteresis: once a section owns the screen, it doesn't
    //      release just because another section is creeping in.
    //
    // The handler is throttled to one update per animation frame
    // via a pending-rAF flag; the listeners are `passive` so they
    // never block scrolling.
    //
    // Reads `prev` inside the setActiveId updater function so the
    // algorithm always sees the latest active value without needing
    // a ref — and only triggers a React re-render when the value
    // actually changes.
    const HEADER_HEIGHT = 80;
    const ACTIVATE_THRESHOLD = 0.60;
    const RELEASE_THRESHOLD = 0.10;
    let rafId: number | null = null;
    let mountRaf: number | null = null;

    const elements: Array<{ id: string; el: HTMLElement }> = [];

    function recompute() {
      rafId = null;
      // Honor the click-guard latch: while a click-driven smooth
      // scroll is animating, leave the active state on the user's
      // chosen target rather than flickering through intermediate
      // sections the scroll passes over.
      const guard = navUntilRef.current;
      if (guard && Date.now() < guard.until) return;
      if (guard && Date.now() >= guard.until) navUntilRef.current = null;

      if (elements.length === 0) return;

      setActiveId((prev) => {
        const viewportBottom = window.innerHeight;
        const usable = viewportBottom - HEADER_HEIGHT;
        if (usable <= 0) return prev;

        // Measure every section's live visible pixel count inside
        // the usable viewport (header-bottom → viewport-bottom).
        const measures: Array<{ id: string; visible: number; ratio: number }> = [];
        for (const { id, el } of elements) {
          const rect = el.getBoundingClientRect();
          const visibleTop = Math.max(rect.top, HEADER_HEIGHT);
          const visibleBottom = Math.min(rect.bottom, viewportBottom);
          const visible = Math.max(0, visibleBottom - visibleTop);
          measures.push({ id, visible, ratio: visible / usable });
        }

        const currentMeasure = measures.find((m) => m.id === prev);

        // (1) CHALLENGER — a non-current section that exceeds the
        // activation threshold AND has more visible pixels than the
        // current active. Greatest-visible wins; ties → source order.
        let challenger: { id: string; visible: number; ratio: number } | null = null;
        for (const m of measures) {
          if (m.id === prev) continue;
          if (m.ratio <= ACTIVATE_THRESHOLD) continue;
          if (currentMeasure && m.visible <= currentMeasure.visible) continue;
          if (!challenger || m.visible > challenger.visible) challenger = m;
        }
        if (challenger) return challenger.id;

        // (2) RELEASE — current dropped below "meaningfully visible".
        // Fall back to whichever section currently has the largest
        // visible area (handles fast scrolls through thin sections
        // that never themselves exceeded 60%).
        if (!currentMeasure || currentMeasure.ratio < RELEASE_THRESHOLD) {
          let best = measures[0];
          for (const m of measures) {
            if (m.visible > best.visible) best = m;
          }
          return best ? best.id : prev;
        }

        // (3) HOLD — current still meaningfully visible and no
        // challenger has taken over.
        return prev;
      });
    }

    function onScrollOrResize() {
      if (rafId !== null) return;
      rafId = requestAnimationFrame(recompute);
    }

    mountRaf = requestAnimationFrame(() => {
      // Resolve elements once after mount; the section anchors are
      // rendered by the children, so wait one frame for hydration.
      for (const c of chapters) {
        const id = chapterIdFor(c.label);
        const el = document.getElementById(id);
        if (el) elements.push({ id, el });
      }
      if (elements.length === 0) return;
      window.addEventListener("scroll", onScrollOrResize, { passive: true });
      window.addEventListener("resize", onScrollOrResize, { passive: true });
      // Initial paint — set active from the current scroll position
      // (handles hash navigation + page reload at non-zero scroll).
      recompute();
    });

    return () => {
      if (mountRaf !== null) cancelAnimationFrame(mountRaf);
      if (rafId !== null) cancelAnimationFrame(rafId);
      window.removeEventListener("scroll", onScrollOrResize);
      window.removeEventListener("resize", onScrollOrResize);
    };
  }, [chapters]);

  function onClickChapter(e: React.MouseEvent<HTMLAnchorElement>, id: string) {
    if (typeof window === "undefined") return;
    e.preventDefault();
    const el = document.getElementById(id);
    if (!el) return;
    // Account for the sticky header so the section's heading isn't
    // hidden behind the green band.
    const header = document.querySelector(
      "[data-testid='reporting-shell-header']",
    ) as HTMLElement | null;
    const headerOffset = (header?.offsetHeight ?? 0) + 16;
    const top = el.getBoundingClientRect().top + window.scrollY - headerOffset;

    // Respect the user's reduced-motion preference. If they have it
    // on, do a plain instant jump — no animated scroll.
    const reducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    window.scrollTo({ top, behavior: reducedMotion ? "auto" : "smooth" });

    // Set the active id eagerly + latch the observer for ~900 ms so
    // it doesn't flicker through intermediate sections during the
    // smooth-scroll animation. The browser doesn't fire a reliable
    // "scroll-finished" event, so a timed latch is the pragmatic
    // approach.
    navUntilRef.current = { id, until: Date.now() + 900 };
    setActiveId(id);

    // Update the URL hash without re-triggering a native anchor jump
    // (which would compete with our smooth scroll).
    history.replaceState(null, "", `#${id}`);
  }

  // Executive Reporting Theme.
  //
  // The reporting shell is the root of the Executive Reporting Theme —
  // a scoped visual treatment applied ONLY under /app/admin/reporting/**.
  // The theme uses three palette tokens, all from the design system's
  // primary palette, and no SaaS chrome:
  //
  //   - deep green   (`club-green-700/800/900`) — shell header, prose
  //                  body, hero KPI numbers, status dot fills
  //   - ivory        (`club-cream` + `club-sand`) — body background,
  //                  paper-on-paper chip backgrounds, hairline dividers
  //   - muted gold   (`club-gold`) — chapter numerals, period chip,
  //                  ornament rules, partial chip ring; the AA-compliant
  //                  text variant `club-gold-700` is reserved for chip
  //                  labels that sit on cream
  //
  // Scope guarantee:
  //   - This component is only rendered when AdminShell's
  //     REPORTING_MODE_PREFIXES detects `/app/admin/reporting`.
  //   - The theme's color helpers (dotForTone, toneHeadlineClass,
  //     ToneChip, DataSourceChip) are defined in
  //     `src/app/app/admin/reporting/monthly/page.tsx` — local to the
  //     reporting surface; they do not leak to operational screens.
  //   - The `club-gold-700` Tailwind token is purely additive — no
  //     other code consumes it today.
  //
  // Operational screens (admin sidebar, POS, member portal, all
  // non-reporting admin routes) continue to ship the original
  // operational palette: stone-50/100/200 neutrals, default green
  // for buttons, the existing `btn` / `card` / `Badge` primitives.
  // None of those tokens are touched by this theme.
  //
  // Suppress unused-pathname warning while the active-chapter detector
  // is intentionally best-effort (anchor changes are client-only and
  // usePathname won't observe them).
  void pathname;
  return (
    <div
      data-testid="reporting-shell"
      data-report-theme="executive"
      className="min-h-screen bg-club-cream text-club-ink"
    >
      {/* Sticky top header — the document spine. Deep club green with
          ivory copy and a thin muted-gold pinstripe at the bottom edge.
          Anatomy (left → right):
            - identity stack (club name · report title) — quiet smallcaps
            - period chip
            - inline Print Mode toggle (no fixed pill any more)
            - close glyph (no "admin" language)
          The old admin-language text-link is gone; the close icon at the
          far right is the document-viewer affordance a board reader
          expects. The Print Mode toggle moved inline so the spine reads
          as one strip, not "app bar + floating widget". */}
      <header
        data-testid="reporting-shell-header"
        className="sticky top-0 z-30 bg-club-green-900 text-club-cream shadow-[0_1px_0_0_rgba(176,138,74,0.35)]"
      >
        <div className="border-b border-club-gold/30">
          <div className="mx-auto flex max-w-[1680px] 2xl:max-w-[1840px] items-center gap-5 px-8 py-3.5">
            {/* Identity stack — quiet smallcaps, takes available space.
                The cover already carries the prestige club name in
                60-px serif, so this band stays subdued.

                2026-06-27: the reporting period was promoted into this
                identity stack so the header reads as one continuous
                editorial line:
                   CLUB · MONTHLY BOARD REPORTING PACKAGE · MAY 2026
                The previous gold pill that sat on the right of the
                header has been removed. Period uses the same
                typography as the report title (10px uppercase,
                0.22em tracking, cream-65 color) so the three
                segments read as peers. */}
            <div className="flex flex-1 items-baseline gap-3 min-w-0">
              <span className="truncate text-[11px] uppercase tracking-[0.22em] text-club-cream">
                {clubName}
              </span>
              <span className="hidden text-club-gold/50 sm:inline" aria-hidden="true">·</span>
              <span
                className="hidden truncate text-[10px] uppercase tracking-[0.22em] text-club-cream/65 sm:inline"
                data-testid="reporting-shell-title"
              >
                {reportTitle}
              </span>
              <span className="hidden text-club-gold/50 sm:inline" aria-hidden="true">·</span>
              <span
                className="hidden truncate text-[10px] uppercase tracking-[0.22em] text-club-cream/65 sm:inline"
                data-testid="reporting-shell-period"
              >
                {effectivePeriodLabel}
              </span>
            </div>

            {/* Right controls cluster — [action slot] · print · close.
                The action slot is a stable portal target. Server pages
                (e.g. the monthly route) render a client-side
                <PublishHeaderButton> that uses createPortal to inject
                a status indicator HERE, keeping the publish control
                visually inside the existing dark green header — no
                extra white header band. The slot stays empty (zero
                width via the empty span) when no portaled action
                exists. */}
            <div className="inline-flex shrink-0 items-center gap-3">
              <span
                id="reporting-shell-header-action-slot"
                data-testid="reporting-shell-header-action-slot"
                className="inline-flex items-center"
              />
              <DownloadPdfButton />
              <Link
                href={closeHref}
                data-testid="reporting-shell-exit"
                aria-label={
                  closeHrefOverride
                    ? "Close report — return to dashboard"
                    : "Close report — return to Monthly Package launcher"
                }
                title="Close report"
                className="inline-flex h-7 w-7 items-center justify-center rounded-md text-club-cream/65 hover:text-club-gold focus:outline-none focus:ring-2 focus:ring-club-gold/50"
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M18 6L6 18" />
                  <path d="M6 6l12 12" />
                </svg>
              </Link>
            </div>
          </div>
        </div>
      </header>

      {/* Body: chapter rail + reading column. The rail is hidden on
          narrow screens — the page's own section headings still let
          a phone reader scroll the document.
          Container widened to 1480px and the rail tightened to 200px
          so the report area maximizes; the reading column gains
          ~170 px vs the prior 1280-cap layout.
          2026-06-19 — top padding `pt-10` was reduced to `pt-6` to
          align the rail's natural-flow start with what was then a
          sticky-positioned nav. The nav has since been promoted to
          `position: fixed` (deterministic across viewports), so the
          alignment is now achieved by anchoring the nav directly to
          the viewport rather than by coordinating padding with
          sticky offsets. The `pt-6` value persists because it still
          governs the READING COLUMN's top breathing room. */}
      <div className="mx-auto grid max-w-[1680px] 2xl:max-w-[1840px] grid-cols-1 gap-10 px-8 pt-6 pb-10 lg:grid-cols-[200px_minmax(0,1fr)] lg:gap-12">
        <aside
          data-testid="reporting-shell-chapters"
          className="hidden lg:block lg:border-r lg:border-club-sand/50"
        >
          {/* `position: fixed` rail. The nav anchors to the viewport
              at `top: 80px` (below the sticky header). Its `left`
              tracks the grid container's content edge via a CSS calc
              that mirrors `mx-auto max-w-[1680px] 2xl:max-w-[1840px]
              px-8`:
                lg:  max(2rem, calc(50vw - 808px))  — MW=1680, padding-x=2rem
                2xl: max(2rem, calc(50vw - 888px))  — MW=1840, padding-x=2rem
              808 = 1680/2 - 32; 888 = 1840/2 - 32.
              Width is locked to 200px (the grid column width); the
              right gutter `pr-6` leaves visual breathing room before
              the aside's border so the rail's content doesn't crowd
              the divider.
              NO `max-h`, NO `overflow-y` — the rail renders at its
              natural content height (~580 px) which fits comfortably
              within every supported admin viewport's available space
              (viewport height − 80 px ≥ 688 px at 768-tall). Adding
              an internal scrollbar to gate against an imaginary
              taller-than-viewport case was a 2026-06-19 over-fix
              that clipped Inventory Analysis on the rail; reverted
              per founder direction.
              Why fixed instead of sticky: sticky inherits the natural-
              flow start position of the element, which depends on
              parent padding + header height. Across viewports + sub-
              pixel rounding, that produced a deterministic 1-px drift
              between scroll=0 and scroll>0. Fixed positioning is
              viewport-anchored — drift is mathematically zero.
              Why this is safe: AdminShell (reporting mode), the
              admin layout, the app layout, and the root layout chain
              were audited for `transform`, `filter`, `perspective`,
              `contain`, and `overflow-hidden`/`auto` — none are
              present on any ancestor, so `position: fixed` correctly
              anchors to the viewport. */}
          <nav
            className={
              "fixed top-20 z-20 " +
              // 200 px nav width; `pr-3` gives every child (active
              // chapter bg, eyebrow border-b, divider, footer text)
              // a 12 px right gutter so nothing kisses the aside's
              // border-r line. The group headings ("Member Overview",
              // "Financial Performance", "Operations & Analytics") fit
              // in the remaining 188 px at text-[11px] tracking-[0.18em]
              // — the longest measures ~180 px with `whitespace-nowrap`
              // as a defensive guard. Tightening to `pr-3` (rather than
              // the prior `pr-6` which wrapped headings, or no padding
              // which spilled backgrounds) is the single shared gutter
              // for every inner element. `box-sizing: border-box` is
              // Tailwind's default — `w-[200px] pr-3` evaluates to
              // 188 px of content width.
              "w-[200px] pr-3 " +
              "lg:left-[max(2rem,calc(50vw-808px))] " +
              "2xl:left-[max(2rem,calc(50vw-888px))]"
            }
            aria-label="Report chapters"
          >
            <div className="border-b border-club-sand pb-3 text-[11px] uppercase tracking-[0.22em] text-club-green-800/75">
              In this package
            </div>
            <ol className="mt-4 space-y-2">
              {chapters.map((c, i) => {
                // Derive the chapter's section id from its visible
                // label (single source of truth — 2026-06-19 naming
                // convention). The id flows into the anchor `href`,
                // the rail-row data-testid, the active comparison,
                // and the click handler — there is no separate id
                // field on the chapter that could diverge.
                const id = chapterIdFor(c.label);
                // Group heading appears only at the start of a new
                // group run — chapters with the same group as the
                // previous chapter inherit the heading silently.
                const isFirstOfGroup = i === 0 || chapters[i - 1].group !== c.group;
                return (
                  <li key={id}>
                    {isFirstOfGroup ? (
                      <h3
                        data-testid={`reporting-chapter-group-${chapterIdFor(c.group)}`}
                        // `whitespace-nowrap` is a defensive guarantee:
                        // the group labels ("Member Overview", "Financial
                        // Statements", "Operations & Analytics") are
                        // chosen to fit within the 200px rail at
                        // text-[11px] tracking-[0.18em], but any future
                        // edit that introduces a longer label (or a
                        // browser font-metric change) MUST NOT silently
                        // wrap to two lines — the rail is print-TOC
                        // formal and wrapped headings read as broken.
                        className={`${i === 0 ? "" : "mt-6"} mb-2 whitespace-nowrap text-[11px] font-medium uppercase tracking-[0.18em] text-club-gold-700/80`}
                      >
                        {c.group}
                      </h3>
                    ) : null}
                    {/* Typeset two-column grid: fixed-width numeral
                        column (2.25rem, room for "XVIII") + flush-left
                        label column. The numeral is centered inside
                        its column so the gold smallcaps roman numerals
                        read as a tabular margin index — and every
                        chapter title starts at exactly the same
                        x-position.
                        Active state: muted sand-tinted background +
                        deepened serif label. Saguaro-style — quiet
                        shading, no harsh SaaS highlight. */}
                    <a
                      href={`#${id}`}
                      data-testid={`reporting-chapter-${id}`}
                      data-active={activeId === id ? "true" : undefined}
                      onClick={(e) => onClickChapter(e, id)}
                      className={
                        "group grid grid-cols-[2.25rem_minmax(0,1fr)] items-baseline gap-2 " +
                        "rounded px-1.5 py-1 text-[14px] leading-snug transition-colors duration-150 " +
                        (activeId === id
                          ? "bg-club-sand/60 text-club-green-900"
                          : "text-club-green-900/85 hover:bg-club-sand/30 hover:text-club-green-900")
                      }
                    >
                      <span
                        data-testid={`reporting-chapter-${id}-numeral`}
                        className={
                          "text-center font-mono text-[11px] uppercase tracking-wide tabular-nums " +
                          (activeId === id
                            ? "text-club-gold"
                            : "text-club-gold/85 group-hover:text-club-gold")
                        }
                      >
                        {c.number}
                      </span>
                      <span
                        className={
                          "font-serif " +
                          (activeId === id ? "font-medium" : "")
                        }
                      >
                        {c.label}
                      </span>
                    </a>
                  </li>
                );
              })}
            </ol>
            <div className="mt-6 border-t border-club-sand pt-3 font-serif text-[12px] italic leading-relaxed text-club-green-800/70">
              Prepared for the {preparedFor}.
            </div>
          </nav>
        </aside>

        {/* Reading column. min-w-0 lets the column shrink properly
            inside the grid. The page content itself decides on
            internal max-widths and rhythm. */}
        <div data-testid="reporting-shell-body" className="min-w-0">
          {children}
        </div>
      </div>
    </div>
  );
}

// Download PDF button. Replaces the previous Print Mode toggle
// (2026-06-30 founder fix). Behaviour:
//
//   • Visual identity is unchanged from the prior toggle: same pill
//     footprint inside the shell's right-controls cluster, same
//     printer icon SVG. Only the text label flips from "Print mode"
//     → "Download PDF" and the click action switches from toggling
//     a body data-attribute to fetching a server-generated PDF.
//   • Click → fetch /api/reporting/monthly/pdf with the package
//     identity derived from the current URL (?id=<MonthlyPackage>
//     for the board view, ?period=YYYY-MM for the admin view). The
//     server-side handler launches headless Chromium against the
//     /app/print/monthly-package route, snapshots a PDF, returns it
//     with a descriptive Content-Disposition filename.
//   • The browser Print dialog is NEVER invoked.
function DownloadPdfButton() {
  // Both URL bits are read inside the component so any caller that
  // mounts the shell on a Monthly Reporting Package route gets the
  // right export wiring without prop threading. The board route is
  // /app/reports/monthly-package/<id> — match it for the id. The
  // admin route uses ?period=YYYY-MM.
  const pathname = usePathname() ?? "";
  const searchParams = useSearchParams();
  const [isDownloading, setIsDownloading] = useState(false);

  const boardMatch = /\/app\/reports\/monthly-package\/([^/?#]+)/.exec(pathname);
  const periodParam = searchParams?.get("period") ?? null;

  const onClick = async () => {
    setIsDownloading(true);
    try {
      const apiUrl = new URL("/api/reporting/monthly/pdf", window.location.origin);
      if (boardMatch) {
        apiUrl.searchParams.set("id", boardMatch[1]);
      } else if (periodParam) {
        apiUrl.searchParams.set("period", periodParam);
      }
      const res = await fetch(apiUrl.toString(), { credentials: "same-origin" });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        // eslint-disable-next-line no-console
        console.error("Download PDF failed", res.status, body);
        return;
      }
      // The server sets a descriptive Content-Disposition; surface
      // it to the browser via a transient anchor + click. The blob
      // URL is revoked immediately after to free memory.
      const disposition = res.headers.get("content-disposition") ?? "";
      const nameMatch = /filename="([^"]+)"/.exec(disposition);
      const filename = nameMatch?.[1] ?? "Monthly-Reporting-Package.pdf";
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } finally {
      setIsDownloading(false);
    }
  };

  return (
    <button
      type="button"
      data-testid="download-pdf-button"
      onClick={onClick}
      disabled={isDownloading}
      aria-busy={isDownloading || undefined}
      title="Download a PDF of this Monthly Reporting Package"
      className={
        `inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-3 py-0.5 text-[10px] uppercase tracking-[0.18em] focus:outline-none focus:ring-2 focus:ring-club-gold/50 ` +
        "border-club-gold/45 bg-club-green-900/40 text-club-gold hover:text-club-cream " +
        "disabled:opacity-60 disabled:cursor-wait"
      }
    >
      {/* Printer icon — IDENTICAL to the prior PrintModeToggle. The
          founder's spec is explicit: "retain the existing printer
          icon ... only the text label should change." */}
      <svg
        width="11"
        height="11"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <polyline points="6 9 6 2 18 2 18 9" />
        <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
        <rect x="6" y="14" width="12" height="8" rx="1" />
      </svg>
      <span>{isDownloading ? "Preparing…" : "Download PDF"}</span>
    </button>
  );
}
