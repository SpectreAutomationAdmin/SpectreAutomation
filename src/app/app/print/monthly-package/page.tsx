// Print-optimized Monthly Reporting Package — the page Playwright
// renders into a PDF.
//
// Route: /app/print/monthly-package
// Modes (mutually exclusive query params):
//   ?id=<MonthlyPackage id>                 → board path. Renders the FROZEN
//                                             snapshot stored at publish time.
//                                             Same authz as the board view.
//   ?period=YYYY-MM&mode=published          → admin path, PUBLISHED mode.
//                                             Renders `packagePayloadJson`
//                                             VERBATIM — a complete financial
//                                             + visibility snapshot captured
//                                             at publish time. Never rebuilds
//                                             from live ledger data, so the
//                                             Published PDF is byte-identical
//                                             to Published State and immune
//                                             to subsequent TB imports /
//                                             budget revisions / COA edits.
//                                             404 if no snapshot exists.
//   ?period=YYYY-MM&mode=draft              → admin path, DRAFT mode.
//                                             Renders LIVE reporting service
//                                             output + current draft
//                                             visibility. Watermarked DRAFT
//                                             on every page via the PDF route's
//                                             header/footer template. Never
//                                             creates or alters a publication
//                                             record.
//   ?period=YYYY-MM                         → legacy fallback: defaults to
//                                             DRAFT mode (matches the
//                                             behaviour the Shell button
//                                             produces from an editing URL).
// All admin paths require `reports:board` on the active club.
//
// Layout: stripped to the bone. NO ReportingShell, NO sidebar, NO
// header chip, NO close button — Playwright captures THIS page's
// HTML as a PDF, so any chrome would show up as chrome on the
// printed page. The Cover (chapter I) carries the document
// identity (club name + reporting period + prepared-for) so the
// PDF reads as a self-contained document.
//
// Print CSS lives inline in this file via a <style> tag so it
// ships only with this route and never affects the live web
// report. CSS-only @page rules drive page numbering, margins,
// headers, footers; @page break rules give us "no orphan headings"
// and "no chart-split" without any DOM gymnastics.

import { notFound, redirect } from "next/navigation";

import { hasPermission } from "@/lib/rbac";
import {
  getMonthlyReportingPackage,
  type MonthlyReportingPackage,
} from "@/lib/reporting/monthly-package";
import { getBoardPackageView } from "@/lib/reporting/monthly-package-lifecycle";
import { getActiveClubId } from "@/lib/active-club";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { prisma as prismaImport } from "@/lib/prisma";
import { MonthlyReportingPackageBody } from "@/app/app/admin/reporting/monthly/MonthlyReportingPackageBody";
import { MONTHLY_REPORTING_CHAPTERS } from "@/lib/reporting/monthly-package-chapters";
import { chapterIdFor } from "@/lib/reporting/chapter-id";

// English ordinals — used by the title page to render the period
// label ("Period Six of Twelve" — the founder's spec). Values 1..12
// are sufficient for a monthly reporting package.
const ORDINAL_WORDS: Record<number, string> = {
  1: "One", 2: "Two", 3: "Three", 4: "Four", 5: "Five", 6: "Six",
  7: "Seven", 8: "Eight", 9: "Nine", 10: "Ten", 11: "Eleven", 12: "Twelve",
};

type Props = {
  searchParams?: { id?: string; period?: string; mode?: string };
};

type PdfMode = "draft" | "published";

function parseMode(mode: string | undefined): PdfMode | null {
  if (mode === "draft" || mode === "published") return mode;
  return null;
}

function parsePeriodQuery(period: string | undefined): { start: Date; end: Date } | null {
  if (!period) return null;
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(period);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  return {
    start: new Date(Date.UTC(year, month - 1, 1)),
    end: new Date(Date.UTC(year, month, 0)),
  };
}

export default async function PrintMonthlyPackagePage({ searchParams }: Props) {
  const principal = await getCurrentPrincipal();
  if (!principal) redirect("/login");

  // ── Resolve the payload via one of two paths ───────────────────
  let pkg: MonthlyReportingPackage | null = null;
  let clubName = "";
  let effectiveMode: PdfMode = "published";
  // MBR-VIS-4 — visibility applied to the body.  Set by whichever
  // branch resolves pkg (published / draft / board snapshot).
  let visibilityForBody: {
    source: "draft" | "published";
    entries: Record<string, boolean>;
  } | undefined;
  // MBR-VIS-4 — when mode=draft and we had to resolve draft rows,
  // we need the (clubId, year, month) for the body's visibility
  // props so toggles are rendered correctly (they aren't in print,
  // but the body gates them on `editing=false`).
  let generatedAt: string = new Date().toISOString();

  if (searchParams?.id) {
    // Board / member path: read the frozen snapshot. Authz lives
    // inside `getBoardPackageView` — returns null for users who
    // are neither board-perm holders, active BoardRole members,
    // nor recipients of this package.
    const view = await getBoardPackageView(principal, searchParams.id);
    if (!view) notFound();
    if (!view.fullPayload) notFound();
    pkg = view.fullPayload as unknown as MonthlyReportingPackage;
    clubName = (pkg.club?.name as string | undefined) ?? "";
    effectiveMode = "published";
    // Frozen snapshot — the published payload's visibility rides
    // along verbatim in the pkg object we just loaded.
    const frozen = (pkg as unknown as {
      visibility?: { entries?: Record<string, boolean> };
    }).visibility;
    if (frozen?.entries) {
      visibilityForBody = { source: "published", entries: frozen.entries };
    }
  } else {
    // Admin path: live reporting service. Requires reports:board
    // on the active club — same gate the admin route uses.
    const clubId = await getActiveClubId({
      clubId: principal.activeClubId ?? null,
      role: "",
    });
    if (!hasPermission(principal, clubId, "reports:board")) notFound();
    const periodOpt = parsePeriodQuery(searchParams?.period);

    // MBR-VIS-4 §2 (2026-10-11) — mode selection.
    //
    // The admin PDF path now takes an explicit `mode` param:
    //
    //   mode=published — Published PDF. Serve `packagePayloadJson`
    //                    VERBATIM.  Financial values + visibility
    //                    are both frozen; the PDF must match the
    //                    Published State HTML byte-for-byte. 404
    //                    when no snapshot exists (the UI gates the
    //                    button, so a direct URL hit is the only
    //                    way to reach this branch — fail loudly
    //                    rather than silently substituting live
    //                    data as the pre-VIS-4 code did).
    //
    //   mode=draft     — Draft PDF.  Live reporting service output
    //                    (today's ledger state) + current draft
    //                    visibility.  Never creates or modifies a
    //                    publication record.  The PDF API route
    //                    paints a DRAFT · NOT FOR BOARD DISTRIBUTION
    //                    footer on every page.
    //
    //   mode absent    — legacy fallback.  Treated as DRAFT so the
    //                    existing Shell `Download PDF` button
    //                    (which does NOT yet pass `mode`) still
    //                    produces a correctly-watermarked DRAFT
    //                    PDF rather than silently serving an
    //                    all-visible report dressed up as "published".
    const requestedMode = parseMode(searchParams?.mode) ?? "draft";
    effectiveMode = requestedMode;

    if (requestedMode === "published") {
      // ─── Published PDF path ─────────────────────────────────
      //
      // Serve the frozen packagePayloadJson as the full pkg.  This
      // is the data-integrity fix for MBR-VIS-4 §5: a Published
      // PDF must reproduce the frozen snapshot — never a live
      // rebuild — so subsequent ledger changes cannot silently
      // alter a previously published PDF.
      if (!periodOpt) notFound();
      const periodEnd = periodOpt.end;
      const row = await prismaImport.monthlyPackage.findUnique({
        where: {
          clubId_reportingYear_reportingMonth: {
            clubId,
            reportingYear: periodEnd.getUTCFullYear(),
            reportingMonth: periodEnd.getUTCMonth() + 1,
          },
        },
        select: {
          status: true,
          packagePayloadJson: true,
          publishedAt: true,
        },
      });
      if (!row || !row.packagePayloadJson || row.status === "DRAFT") {
        // No frozen snapshot available.  The UI gates the Download
        // Published PDF button on this same condition; a direct URL
        // hit lands here with a 404 so we never silently substitute
        // a live rebuild for a missing publication.
        notFound();
      }
      try {
        const parsed = JSON.parse(row!.packagePayloadJson!) as MonthlyReportingPackage & {
          visibility?: { entries?: Record<string, boolean> };
        };
        pkg = parsed as MonthlyReportingPackage;
        clubName = pkg.club?.name ?? "";
        const frozen = parsed.visibility;
        if (frozen?.entries) {
          visibilityForBody = { source: "published", entries: frozen.entries };
        }
      } catch {
        // Corrupted snapshot JSON — the only safe action is to
        // refuse publication of a broken payload.
        notFound();
      }
    } else {
      // ─── Draft PDF path ─────────────────────────────────────
      //
      // Live reporting service output + current draft visibility
      // + DRAFT watermark (applied by the PDF route's header /
      // footer template, driven by this page's `data-pdf-mode`).
      pkg = periodOpt
        ? await getMonthlyReportingPackage(clubId, { period: periodOpt, viewerCanDrillDown: false })
        : await getMonthlyReportingPackage(clubId, { viewerCanDrillDown: false });
      clubName = pkg.club?.name ?? "";

      if (periodOpt) {
        const periodEnd = periodOpt.end;
        const { resolveDraftVisibility } = await import(
          "@/lib/reporting/monthly-package-visibility"
        );
        try {
          const draft = await resolveDraftVisibility(
            clubId,
            periodEnd.getUTCFullYear(),
            periodEnd.getUTCMonth() + 1,
          );
          visibilityForBody = { source: "draft", entries: draft.entries };
        } catch {
          // No draft config available — fall back to default-visible.
        }
      }
    }
  }

  if (!pkg) notFound();

  // Display period for the running-header data attribute (the PDF
  // header template reads this via Playwright's page evaluation).
  // The reporting payload already exposes `period.label` as
  // "MonthLong YYYY" (e.g. "June 2026") — use it directly so the
  // PDF header band matches the cover chapter byte-for-byte.
  const periodLabel = pkg.period?.label ?? "";
  const periodEndedLabel = pkg.period?.periodEndedLabel ?? "";
  const fiscalYearLabel = pkg.period?.fiscalYearLabel ?? "";
  const ytdMonthsElapsed = pkg.period?.ytdMonthsElapsed ?? 0;
  const periodOfTwelve =
    ytdMonthsElapsed >= 1 && ytdMonthsElapsed <= 12
      ? `Period ${ORDINAL_WORDS[ytdMonthsElapsed]} of Twelve`
      : "";
  const club = pkg.club ?? { name: "", city: null, provinceState: null, yearFounded: null };
  const cityProvinceLine = [club.city, club.provinceState]
    .filter(Boolean)
    .join(", ");
  const establishedLine = club.yearFounded ? `Established ${club.yearFounded}` : "";
  const preparedFor = pkg.preparedFor || "Finance Committee · Board of Directors";

  return (
    <>
      {/* Inline print-mode <style> — ships ONLY with this route, so
          the live web report at /app/admin/reporting/monthly is
          unaffected. Encodes the founder's print invariants:
            • "Never leave a section heading at the bottom of a
              page" → break-after: avoid on every heading.
            • "Prevent charts from being cut across pages" →
              break-inside: avoid on chart/card/kpi/statement rows.
            • Title page + TOC each get their own page (break-after).
            • TOC page-number column auto-fills via target-counter()
              against the body chapter section anchors. */}
      <style
        // eslint-disable-next-line react/no-danger
        dangerouslySetInnerHTML={{
          __html: `
            /* ─── Landscape Letter @page ───────────────────────
               Founder spec 2026-07-01: the Monthly Reporting
               Package PDF is a LANDSCAPE board book. Landscape
               Letter is 11in × 8.5in. Margins are tighter on the
               sides than portrait was — we want the wider canvas
               to carry side-by-side cards / charts.

               The Playwright pdf() call also passes
               landscape: true + scale: 0.825 so Chromium lays the
               content out at a viewport wide enough for Tailwind's
               lg: breakpoint (≥1024px) to activate — which is what
               unlocks the body chapters' multi-column grids. The
               output is then shrunk to fit the printed landscape
               canvas. */
            @page {
              size: Letter landscape;
              margin: 0.55in 0.7in 0.7in 0.7in;
            }
            html, body {
              background: #ffffff !important;
              color: #1f1d18 !important;
              font-family: 'Inter', system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
              -webkit-print-color-adjust: exact !important;
              print-color-adjust: exact !important;
            }

            /* ─── Title page (PDF page 1) — LANDSCAPE ───────────
               Two-column editorial cover: identity on the left,
               document title + period on the right, footer band
               (Prepared for + Confidentiality + Spectre Framework
               attribution) spans the full width below. Uses the
               wider canvas instead of a portrait cover stretched
               across landscape. */
            .pdf-title-page {
              display: grid;
              grid-template-columns: 0.95fr 1.05fr;
              grid-template-rows: 1fr auto;
              column-gap: 0.7in;
              row-gap: 0.45in;
              min-height: calc(8.5in - 1.25in);
              padding: 0.15in 0 0.15in;
              break-after: page;
              page-break-after: always;
            }
            .pdf-title-page .eyebrow {
              font-size: 9pt;
              letter-spacing: 0.32em;
              text-transform: uppercase;
              color: #6b6552;
            }
            .pdf-title-page .identity-col {
              border-right: 0.5pt solid #e5dfc8;
              padding-right: 0.7in;
              display: flex;
              flex-direction: column;
              justify-content: center;
            }
            .pdf-title-page .doc-col {
              padding-left: 0in;
              display: flex;
              flex-direction: column;
              justify-content: center;
            }
            .pdf-title-page .club-name {
              margin-top: 18pt;
              font-family: 'Newsreader', Georgia, 'Times New Roman', serif;
              font-size: 32pt;
              line-height: 1.05;
              color: #1f1d18;
              font-weight: 500;
              letter-spacing: -0.005em;
            }
            .pdf-title-page .club-meta {
              margin-top: 12pt;
              font-size: 10pt;
              color: #5b5544;
              letter-spacing: 0.04em;
            }
            .pdf-title-page .club-meta .sep { color: #c9c3b3; padding: 0 6pt; }
            .pdf-title-page .gold-rule {
              width: 1.2in; height: 1.5pt;
              margin: 22pt 0 18pt;
              background: #b08a3e;
            }
            .pdf-title-page .doc-title {
              font-family: 'Newsreader', Georgia, 'Times New Roman', serif;
              font-size: 28pt; line-height: 1.1; color: #1f1d18;
              font-weight: 500;
            }
            .pdf-title-page .doc-period {
              margin-top: 14pt;
              font-style: italic;
              font-size: 13pt;
              color: #2f5832;
            }
            .pdf-title-page .doc-period-of {
              margin-top: 5pt;
              font-size: 10pt;
              letter-spacing: 0.22em;
              text-transform: uppercase;
              color: #6b6552;
            }
            .pdf-title-page .footer-block {
              grid-column: 1 / -1;
              display: grid;
              grid-template-columns: 1fr 1.4fr 1fr;
              gap: 0.5in;
              padding-top: 14pt;
              border-top: 0.5pt solid #e5dfc8;
            }
            .pdf-title-page .footer-block dt {
              font-size: 8pt;
              letter-spacing: 0.22em;
              text-transform: uppercase;
              color: #8a8474;
              margin-bottom: 5pt;
            }
            .pdf-title-page .footer-block dd {
              margin: 0;
              font-size: 9.5pt;
              color: #1f1d18;
              line-height: 1.45;
            }
            .pdf-title-page .colophon {
              font-size: 8pt;
              color: #8a8474;
              letter-spacing: 0.06em;
              line-height: 1.4;
            }

            /* ─── Table of contents (PDF page 2) — LANDSCAPE ────
               Landscape canvas is wide enough for a two-column TOC
               layout. The three chapter groups (Member Overview ·
               Financial Statements · Operations & Analytics) flow
               column-first via CSS columns so the page balances
               nicely AND every page-numbered line is left-justified
               with its leaders. */
            .pdf-toc-page {
              break-after: page;
              page-break-after: always;
              padding-top: 0.15in;
            }
            .pdf-toc-page .eyebrow {
              font-size: 9pt;
              letter-spacing: 0.32em;
              text-transform: uppercase;
              color: #6b6552;
            }
            .pdf-toc-page .toc-title {
              margin-top: 5pt;
              font-family: 'Newsreader', Georgia, serif;
              font-size: 26pt;
              color: #1f1d18;
              font-weight: 500;
            }
            .pdf-toc-page .gold-rule {
              width: 0.9in; height: 1pt;
              margin: 14pt 0 18pt;
              background: #b08a3e;
            }
            .pdf-toc-cols {
              column-count: 2;
              column-gap: 0.7in;
              column-rule: 0.5pt solid #e5dfc8;
            }
            .pdf-toc-group {
              break-inside: avoid;
              page-break-inside: avoid;
              margin-bottom: 14pt;
            }
            .pdf-toc-group .group-label {
              font-size: 8pt;
              letter-spacing: 0.32em;
              text-transform: uppercase;
              color: #8a8474;
              padding-bottom: 4pt;
              border-bottom: 0.5pt solid #e5dfc8;
              margin-bottom: 6pt;
            }
            .pdf-toc-list { list-style: none; margin: 0; padding: 0; }
            .pdf-toc-list li {
              padding: 5pt 0;
              border-bottom: 0.25pt dotted #d8d2c0;
              font-size: 10.5pt;
              color: #1f1d18;
            }
            .pdf-toc-list a {
              color: inherit;
              text-decoration: none;
              display: flex;
              align-items: baseline;
            }
            .pdf-toc-list .roman {
              flex: 0 0 32pt;
              font-size: 9pt;
              letter-spacing: 0.18em;
              color: #b08a3e;
              text-transform: uppercase;
            }
            .pdf-toc-list .label { flex: 0 0 auto; }
            .pdf-toc-list .leaders {
              flex: 1 1 auto;
              color: #c9c3b3;
              padding: 0 6pt;
              overflow: hidden;
              white-space: nowrap;
              letter-spacing: 0.25em;
              align-self: end;
              line-height: 1;
              transform: translateY(-2pt);
            }
            /* Generate the leader dots in CSS so the JSX stays a
               semantic empty span. The repeat string is long enough
               to fill any chapter label up to the page-number gutter
               at landscape width; CSS overflow: hidden hides the
               tail past the page-number column. */
            .pdf-toc-list .leaders::before {
              content: "............................................................";
            }
            .pdf-toc-list .page-ref {
              flex: 0 0 28pt;
              text-align: right;
              font-variant-numeric: tabular-nums;
              color: #5b5544;
              /* Empty until the PDF API route runs its measurement
                 pass and injects the actual page number for each
                 chapter anchor. Chromium's headless print engine
                 doesn't reliably implement CSS Paged Media's
                 target-counter(), so we measure + inject from the
                 server-side Playwright pipeline instead. */
            }

            /* ─── Body chapter pagination ──────────────────────── */
            /* Each of the 14 chapters opens on a clean page so the
               TOC page references the measurement pass computes
               stay stable: chapter 1 starts at body-page 1 (PDF
               page 3 after title + TOC), chapter 2 starts on the
               next available page, etc. */
            section[id] {
              break-before: page;
              page-break-before: always;
            }

            /* No orphan headings. */
            h1, h2, h3, h4,
            .section-title,
            .chapter-title {
              break-after: avoid-page;
              page-break-after: avoid;
            }

            /* Atomic visual units — keep together where practical. */
            .kpi-card,
            [data-kpi-card],
            .chart,
            [data-chart],
            svg,
            .card,
            .statement-line,
            [data-board-consideration] {
              break-inside: avoid-page;
              page-break-inside: avoid;
            }

            /* Tables: try not to split rows; allow tables to flow
               across pages but keep header + first row together. */
            table { break-inside: auto; }
            tr, td, th { break-inside: avoid-page; }
            thead { display: table-header-group; }

            /* Defensive: hide any shell chrome that might leak in. */
            [data-testid="reporting-shell-exit"],
            [data-testid="print-mode-toggle"],
            [data-testid="download-pdf-button"],
            [data-testid="reporting-shell-header-action-slot"],
            [data-testid="topbar-user-trigger"] {
              display: none !important;
            }
          `,
        }}
      />

      {/* ═══ PAGE 1 — Executive Title Page ═══════════════════════════
          Landscape editorial cover. Two columns: club identity on
          the left, document title + period on the right. Footer
          band (Prepared for · Confidentiality · Spectre Framework
          colophon) spans the full landscape canvas below. */}
      <section
        data-testid="pdf-title-page"
        data-pdf-front-matter="title"
        className="pdf-title-page"
        aria-label="Title page"
      >
        <div className="identity-col">
          <div className="eyebrow">Spectre Executive Reporting</div>
          <h1 className="club-name">{club.name}</h1>
          {(cityProvinceLine || establishedLine) && (
            <div className="club-meta">
              {cityProvinceLine}
              {cityProvinceLine && establishedLine && <span className="sep">·</span>}
              {establishedLine}
            </div>
          )}
        </div>

        <div className="doc-col">
          <div className="eyebrow">Reporting Period</div>
          <div className="gold-rule" />
          <div className="doc-title">Monthly Board Reporting Package</div>
          {periodEndedLabel && (
            <div className="doc-period">For the {periodEndedLabel.replace(/^For the /, "")}</div>
          )}
          {periodOfTwelve && (
            <div className="doc-period-of">
              {periodOfTwelve}
              {fiscalYearLabel ? ` · ${fiscalYearLabel}` : ""}
            </div>
          )}
        </div>

        <dl className="footer-block">
          <div>
            <dt>Prepared for</dt>
            <dd>
              Finance Committee
              <br />
              Board of Directors
            </dd>
          </div>
          <div>
            <dt>Confidentiality</dt>
            <dd>
              This document is confidential and intended solely for
              the named recipients. Do not distribute outside the
              Board without written approval from the Finance
              Committee.
            </dd>
          </div>
          <div>
            <dt>Framework</dt>
            <dd className="colophon">
              Prepared using the Spectre Framework for executive
              reporting — five stewardship pillars, four governance
              questions, one source of truth.
            </dd>
          </div>
        </dl>
      </section>

      {/* ═══ PAGE 2 — Auto-Generated Table of Contents ═══════════════
          Two-column landscape TOC. Entries are built from
          `MONTHLY_REPORTING_CHAPTERS` (the shared registry the
          chapter rail also consumes). The `.page-ref` span is
          populated by the PDF API route's measurement pass — see
          src/app/api/reporting/monthly/pdf/route.ts for the
          page.evaluate() that walks each chapter section, computes
          its starting page in the paginated PDF, and injects the
          number into the matching anchor before page.pdf() runs.
          (Chromium's headless print engine doesn't reliably support
          CSS Paged Media's target-counter(); the two-pass JS
          measurement is the reliable substitute.) */}
      <section
        data-testid="pdf-toc-page"
        data-pdf-front-matter="toc"
        className="pdf-toc-page"
        aria-label="Table of contents"
      >
        <div className="eyebrow">Front Matter</div>
        <h2 className="toc-title">Table of Contents</h2>
        <div className="gold-rule" />
        <div className="pdf-toc-cols">
          {(() => {
            // Group chapters by their `group` field so the TOC
            // mirrors the rail's three-group structure (Member
            // Overview · Financial Statements · Operations &
            // Analytics).
            const byGroup = new Map<string, typeof MONTHLY_REPORTING_CHAPTERS[number][]>();
            for (const ch of MONTHLY_REPORTING_CHAPTERS) {
              if (!byGroup.has(ch.group)) byGroup.set(ch.group, []);
              byGroup.get(ch.group)!.push(ch);
            }
            return Array.from(byGroup.entries()).map(([group, items]) => (
              <div key={group} className="pdf-toc-group">
                <div className="group-label">{group}</div>
                <ol className="pdf-toc-list">
                  {items.map((ch) => {
                    const id = chapterIdFor(ch.label);
                    return (
                      <li key={id} data-testid={`pdf-toc-entry-${id}`}>
                        <a href={`#${id}`} data-toc-anchor={id}>
                          <span className="roman">{ch.number}</span>
                          <span className="label">{ch.label}</span>
                          <span className="leaders" aria-hidden="true" />
                          <span className="page-ref" data-page-ref={id} />
                        </a>
                      </li>
                    );
                  })}
                </ol>
              </div>
            ));
          })()}
        </div>
      </section>

      {/* ═══ PAGES 3+ — Report body (unchanged from web) ═════════════
          The shared MonthlyReportingPackageBody renders the same 14
          chapters as the web route. Print CSS above adds the
          per-chapter break-before: page so each chapter (starting
          with Executive Opening on page 3) opens on a clean page. */}
      <main
        data-testid="print-monthly-package"
        data-period-label={periodLabel}
        data-club-name={clubName}
        data-pdf-mode={effectiveMode}
        data-generated-at={generatedAt}
        className="bg-white text-club-ink"
      >
        {/* MBR-VIS-4 §3 (2026-10-11) — DRAFT in-page banner.
            Rendered only when `effectiveMode === "draft"`.  The PDF
            API route also stamps a DRAFT marker in the running
            footer via Playwright's footerTemplate so the DRAFT
            designation appears on every PDF page; this in-page
            banner ensures the first page (title) also carries it
            even though Playwright's running footer sits in the
            page margins. */}
        {effectiveMode === "draft" && (
          <div
            data-testid="pdf-draft-banner"
            style={{
              background: "#7c2d12",
              color: "#fef3c7",
              textAlign: "center",
              padding: "6pt 12pt",
              fontSize: "9pt",
              letterSpacing: "0.32em",
              textTransform: "uppercase",
              fontWeight: 600,
              borderBottom: "0.5pt solid #431407",
            }}
          >
            Draft · Not for Board Distribution · Generated {generatedAt}
          </div>
        )}
        <MonthlyReportingPackageBody
          pkg={pkg}
          /* MBR-VIS-4 — the PDF body renders through the resolved
             visibility config.  Published mode: frozen snapshot
             from `packagePayloadJson.visibility`.  Draft mode:
             live `MonthlyPackageVisibility` rows.  Both honor the
             same parent-child cascade in the body component. */
          visibility={visibilityForBody}
          editing={false}
        />
      </main>
    </>
  );
}
