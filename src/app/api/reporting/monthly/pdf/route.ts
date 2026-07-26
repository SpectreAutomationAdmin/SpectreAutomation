// Monthly Reporting Package — PDF export endpoint.
//
// GET /api/reporting/monthly/pdf?id=<MonthlyPackage id>
// GET /api/reporting/monthly/pdf?period=YYYY-MM
//
// Auth: cookie-based, same gate as the print route the API drives.
// The endpoint hands authz to the print page itself — Playwright
// arrives carrying the requesting user's session cookie, the print
// route runs its standard checks (board view authz for `id`,
// reports:board for `period`), and any failure surfaces here as
// the PDF generation timing out / returning a non-OK page.
//
// Output: application/pdf, Content-Disposition: attachment, with a
// descriptive filename derived from the package's reporting period
// (e.g. `Monthly-Board-Reporting-Package-June-2026.pdf`).
//
// Implementation: server-side Playwright launches a headless
// Chromium instance, navigates to /app/print/monthly-package with
// the same query string the API received, then issues `page.pdf()`
// with a Spectre-styled header/footer template (period + page
// number). The print page renders WITHOUT the ReportingShell so
// what Playwright captures is the document, not the application.
//
// Production note: shipping Chromium with the app on serverless
// hosts (Vercel, Netlify) is non-trivial. For local dev + a
// dedicated server / container deployment the playwright runtime
// works as-is. A future slice may extract this into a small PDF
// microservice on a longer-running runtime; the API surface
// (request shape + response Content-Disposition) is the contract
// to preserve in that move.

import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { prisma } from "@/lib/prisma";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { hasPermission } from "@/lib/rbac";
import { MONTHLY_REPORTING_CHAPTERS } from "@/lib/reporting/monthly-package-chapters";
import { chapterIdFor } from "@/lib/reporting/chapter-id";

// Force Node.js runtime — Playwright cannot run in the Edge runtime.
export const runtime = "nodejs";
// Disable static optimization; this route always runs per-request.
export const dynamic = "force-dynamic";

const MONTH_LONG = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

type ResolvedPackage = {
  period: string;            // "June 2026" for the filename
  filenameSafe: string;      // "June-2026"
  clubName: string;
};

/**
 * Resolve the package identity from the request before we spend the
 * time launching Chromium. Authz is enforced here for fast 4xx
 * responses without burning Chromium startup time on a doomed
 * request.
 */
async function resolveRequest(
  req: NextRequest,
): Promise<{ ok: true; pkg: ResolvedPackage } | { ok: false; status: number; message: string }> {
  const principal = await getCurrentPrincipal();
  if (!principal) return { ok: false, status: 401, message: "Not authenticated" };

  const id = req.nextUrl.searchParams.get("id");
  const period = req.nextUrl.searchParams.get("period");
  if (!id && !period) {
    return { ok: false, status: 400, message: "Must supply ?id or ?period" };
  }

  if (id) {
    // Board / member path. We don't re-run the full visibility
    // check here (the print route does it); we just need the
    // metadata for the filename + a fast 404 if the id is bogus.
    const row = await prisma.monthlyPackage.findUnique({
      where: { id },
      select: {
        reportingYear: true,
        reportingMonth: true,
        club: { select: { name: true } },
      },
    });
    if (!row) return { ok: false, status: 404, message: "Package not found" };
    const periodLabel = `${MONTH_LONG[row.reportingMonth - 1]} ${row.reportingYear}`;
    const filenameSafe = `${MONTH_LONG[row.reportingMonth - 1]}-${row.reportingYear}`;
    return {
      ok: true,
      pkg: { period: periodLabel, filenameSafe, clubName: row.club.name },
    };
  }

  // Admin path: validate ?period=YYYY-MM and check the gate.
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(period!);
  if (!m) return { ok: false, status: 400, message: "Invalid period format" };
  const clubId = await getActiveClubId({
    clubId: principal.activeClubId ?? null,
    role: "",
  });
  if (!hasPermission(principal, clubId, "reports:board")) {
    return { ok: false, status: 403, message: "Missing reports:board" };
  }
  const year = Number(m[1]);
  const month = Number(m[2]);
  const club = await prisma.club.findUnique({
    where: { id: clubId },
    select: { name: true },
  });
  const periodLabel = `${MONTH_LONG[month - 1]} ${year}`;
  const filenameSafe = `${MONTH_LONG[month - 1]}-${year}`;
  return {
    ok: true,
    pkg: {
      period: periodLabel,
      filenameSafe,
      clubName: club?.name ?? "Spectre",
    },
  };
}

function headerTemplate(periodLabel: string, clubName: string): string {
  // Playwright accepts an HTML template for header/footer. Inline
  // styles are required (no external stylesheets reach the header
  // band). Keep the typography close to the Spectre report shell:
  // small caps + wide letter spacing + ivory on a deep-green strip.
  // Total height is tuned (~28px) so it fits inside the 0.75in top
  // margin we set on the print page.
  const safeClub = clubName.replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const safePeriod = periodLabel.replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `
    <div style="
      width: 100%;
      padding: 0 0.6in;
      font-family: Inter, system-ui, sans-serif;
      font-size: 7.5pt;
      letter-spacing: 0.18em;
      text-transform: uppercase;
      color: #6b6552;
      display: flex;
      justify-content: space-between;
      align-items: center;
    ">
      <span>${safeClub}</span>
      <span>Monthly Board Reporting Package &middot; ${safePeriod}</span>
    </div>
  `;
}

function footerTemplate(): string {
  // Playwright substitutes <span class="pageNumber"> + ".totalPages"
  // at render time. The footer band sits inside the 0.85in bottom
  // margin we set on the print page.
  return `
    <div style="
      width: 100%;
      padding: 0 0.6in;
      font-family: Inter, system-ui, sans-serif;
      font-size: 7.5pt;
      letter-spacing: 0.18em;
      text-transform: uppercase;
      color: #6b6552;
      display: flex;
      justify-content: space-between;
      align-items: center;
    ">
      <span>Confidential &middot; For Board distribution only</span>
      <span>
        Page <span class="pageNumber"></span> of <span class="totalPages"></span>
      </span>
    </div>
  `;
}

async function handle(req: NextRequest) {
  const resolved = await resolveRequest(req);
  if (!resolved.ok) {
    return NextResponse.json({ error: resolved.message }, { status: resolved.status });
  }

  // Forward the user's session cookie to the headless browser so
  // the print page authenticates as them and runs the same authz
  // checks the user already passed at this endpoint.
  const cookieHeader = req.headers.get("cookie") ?? "";

  // Build the absolute URL the headless browser should fetch. We
  // talk to ourselves through the user-visible host so any tenant
  // host resolution (white-label club domains) and middleware
  // rewrites still apply. The path strips the API segment and
  // points at the print route.
  const reqUrl = new URL(req.url);
  const printUrl = new URL("/app/print/monthly-package", reqUrl);
  const id = req.nextUrl.searchParams.get("id");
  const period = req.nextUrl.searchParams.get("period");
  if (id) printUrl.searchParams.set("id", id);
  if (period) printUrl.searchParams.set("period", period);

  // Dynamic import so the playwright dependency doesn't load on
  // routes that don't use it (smaller cold-start, no surprise dev
  // failures for engineers without Chromium installed).
  const { chromium } = await import("playwright");

  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  try {
    const context = await browser.newContext();
    // Replay the user's cookie into the headless browser so the
    // print page is rendered AS the authenticated requester.
    if (cookieHeader) {
      // Parse the cookie header into individual cookies the
      // playwright API expects. Skip empty / malformed entries.
      const parsed = cookieHeader
        .split(";")
        .map((s) => s.trim())
        .filter(Boolean)
        .map((entry) => {
          const ix = entry.indexOf("=");
          if (ix < 0) return null;
          return {
            name: entry.slice(0, ix).trim(),
            value: entry.slice(ix + 1).trim(),
            domain: reqUrl.hostname,
            path: "/",
          };
        })
        .filter(Boolean) as Array<{ name: string; value: string; domain: string; path: string }>;
      if (parsed.length > 0) await context.addCookies(parsed);
    }

    const page = await context.newPage();

    // Viewport tuned so the body's Tailwind `lg:` breakpoint
    // (≥1024px) activates — that's what unlocks multi-column KPI /
    // chart grids in chapter components. The PDF is then rendered
    // with `scale: 0.825` so 1280px of layout fits the 1056-px
    // landscape Letter content area cleanly.
    const VIEWPORT_WIDTH = 1280;
    const VIEWPORT_HEIGHT = 990;
    await page.setViewportSize({
      width: VIEWPORT_WIDTH,
      height: VIEWPORT_HEIGHT,
    });

    const navResp = await page.goto(printUrl.toString(), {
      waitUntil: "networkidle",
      timeout: 60_000,
    });
    if (!navResp || !navResp.ok()) {
      const status = navResp?.status() ?? 500;
      const body = navResp ? await navResp.text() : "";
      return NextResponse.json(
        { error: `Print page returned ${status}`, body: body.slice(0, 200) },
        { status: 502 },
      );
    }
    // Print emulation so the inline @media-print styles in the
    // print route apply during the measurement pass below.
    await page.emulateMedia({ media: "print" });
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(250);

    // ─── Two-pass TOC: measure → inject → render ────────────────
    //
    // Chromium's headless PDF engine does not reliably implement
    // CSS Paged Media's `target-counter()`, so we compute each
    // chapter's starting page in JavaScript, then mutate the TOC's
    // `.page-ref` placeholders before calling page.pdf(). Math:
    //
    //   • Landscape Letter content area at scale 0.825:
    //       width  = (11in − 0.7in − 0.7in) × 96dpi    = ~921 px
    //       height = (8.5in − 0.55in − 0.7in) × 96dpi  = ~696 px
    //     Scaled to fit at our viewport (1280px wide), the per-page
    //     CONTENT HEIGHT in CSS pixels becomes:
    //       contentHeightCSSpx = 696 / 0.825             = ~844 px
    //
    //   • Each chapter section has `break-before: page`, so it
    //     starts on a fresh PDF page. We walk sections in document
    //     order, summing the prior chapter heights / per-page
    //     content height to derive each section's starting page.
    //
    //   • +2 offset accounts for the title page + TOC page that
    //     precede the body. So the cover chapter (Executive
    //     Opening) is PDF page 3.
    const PER_PAGE_CONTENT_HEIGHT_CSS_PX = 844;
    const TITLE_PLUS_TOC_OFFSET = 2;
    // Enumerate chapter ids from the shared registry rather than
    // querying `section[id]` — the first chapter (Executive
    // Opening) renders as a <div id="executive-opening">, not a
    // <section>, so a strict section[id] selector misses it.
    const chapterIds = MONTHLY_REPORTING_CHAPTERS.map((c) => chapterIdFor(c.label));
    const tocPages: Record<string, number> = await page.evaluate(
      ({ perPage, offset, ids }) => {
        const root = document.querySelector<HTMLElement>(
          "[data-testid='print-monthly-package']",
        );
        if (!root) return {} as Record<string, number>;
        const result: Record<string, number> = {};
        let bodyPage = 1;
        for (const id of ids) {
          const el = root.querySelector<HTMLElement>(`#${CSS.escape(id)}`);
          if (!el) continue;
          result[id] = bodyPage + offset;
          const h = el.offsetHeight || 1;
          const pagesUsed = Math.max(1, Math.ceil(h / perPage));
          bodyPage += pagesUsed;
        }
        return result;
      },
      { perPage: PER_PAGE_CONTENT_HEIGHT_CSS_PX, offset: TITLE_PLUS_TOC_OFFSET, ids: chapterIds },
    );

    // Inject the computed page numbers into the TOC's `.page-ref`
    // placeholders. Each TOC anchor carries `data-page-ref="<id>"`
    // matching the chapter section's anchor id.
    await page.evaluate((mapping) => {
      document
        .querySelectorAll<HTMLElement>("[data-page-ref]")
        .forEach((slot) => {
          const id = slot.getAttribute("data-page-ref");
          if (id && mapping[id] != null) {
            slot.textContent = String(mapping[id]);
          }
        });
    }, tocPages);

    const pdf = await page.pdf({
      format: "Letter",
      landscape: true,
      // 1056 / 1280 ≈ 0.825 — shrinks the 1280-px-wide layout to
      // fit the landscape Letter content area, so Tailwind `lg:`
      // multi-column grids stay multi-column in the printed PDF.
      scale: 0.825,
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate: headerTemplate(resolved.pkg.period, resolved.pkg.clubName),
      footerTemplate: footerTemplate(),
      margin: {
        top: "0.55in",
        bottom: "0.7in",
        left: "0.7in",
        right: "0.7in",
      },
      preferCSSPageSize: true,
    });

    const filename = `Monthly-Board-Reporting-Package-${resolved.pkg.filenameSafe}.pdf`;
    return new NextResponse(new Uint8Array(pdf), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "private, no-store",
      },
    });
  } finally {
    await browser.close();
  }
}

export async function GET(req: NextRequest) {
  return handle(req);
}
