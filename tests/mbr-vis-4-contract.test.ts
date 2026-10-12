// MBR-VIS-4 (2026-10-11) — Draft PDF & Publication State Integrity.
//
// Source-contract tests that verify the four-state publication
// architecture at the file level without hitting the DB or
// launching Playwright:
//
//   §A  PDF API route accepts explicit mode=draft|published.
//   §B  PDF API route pre-flights mode=published and 404s when no
//       `packagePayloadJson` snapshot exists for the period — never
//       silently substitutes a live rebuild.
//   §C  PDF API route forwards `mode` to the print page URL.
//   §D  PDF API route emits a DRAFT · NOT FOR BOARD DISTRIBUTION
//       footer when mode=draft, and the standard confidentiality
//       footer when mode=published.
//   §E  Print page branches on `mode`: published → `packagePayloadJson`
//       verbatim (financial immutability), draft → live reporting
//       service + draft visibility.
//   §F  Shell DownloadPdfButton selects mode from `?preview=` in URL
//       and labels the button Download Draft PDF vs Download
//       Published PDF accordingly.
//   §G  Publication-state banners carry the matching download
//       affordance (Draft Preview → Download Draft PDF; Published
//       State → Download Published PDF when a snapshot exists).
//   §H  Published state preservation — the publish lifecycle
//       continues to freeze `packagePayloadJson` with both financial
//       data AND visibility.
//
// All assertions read source files as text (via readFileSync) so
// nothing hits the DB.  No real Coulee Ridge data is touched.

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO = path.resolve(__dirname, "..");
const PDF_ROUTE = path.join(REPO, "src/app/api/reporting/monthly/pdf/route.ts");
const PRINT_PAGE = path.join(REPO, "src/app/app/print/monthly-package/page.tsx");
const SHELL = path.join(REPO, "src/components/reporting/ReportingShell.tsx");
const BANNER = path.join(REPO, "src/components/reporting/PublicationStateBanner.tsx");
const ADMIN_PAGE = path.join(REPO, "src/app/app/admin/reporting/monthly/page.tsx");
const LIFECYCLE = path.join(REPO, "src/lib/reporting/monthly-package-lifecycle.ts");

function src(p: string): string {
  return readFileSync(p, "utf8");
}

describe("MBR-VIS-4 §A — PDF API route accepts explicit mode=draft|published", () => {
  const code = src(PDF_ROUTE);

  it("defines a PdfMode type gating draft vs published", () => {
    expect(code).toMatch(/type\s+PdfMode\s*=\s*"draft"\s*\|\s*"published"/);
  });

  it("defines parseMode and reads searchParams.mode", () => {
    expect(code).toMatch(/function\s+parseMode\s*\(/);
    expect(code).toMatch(/req\.nextUrl\.searchParams\.get\("mode"\)/);
  });

  it("defaults missing mode to draft (never silently serves live data as 'published')", () => {
    // The default lives in resolveRequest, picking "draft" when
    // parseMode returns null. Match the resolution line.  Nested
    // parens inside the arg make `[^)]*` wrong — use non-greedy
    // `[\s\S]*?` so the inner call is swallowed.
    expect(code).toMatch(/parseMode\([\s\S]*?\)\s*\?\?\s*"draft"/);
  });
});

describe("MBR-VIS-4 §B — mode=published 404s when no snapshot exists", () => {
  const code = src(PDF_ROUTE);

  it("pre-flights a MonthlyPackage lookup before launching Chromium", () => {
    expect(code).toMatch(/requestedMode\s*===\s*"published"/);
    expect(code).toMatch(/prisma\.monthlyPackage\.findUnique/);
  });

  it("returns 404 with a clear 'no published snapshot' message", () => {
    expect(code).toMatch(/No published snapshot available/);
    expect(code).toMatch(/status:\s*404/);
  });

  it("treats DRAFT status as 'no snapshot' even if packagePayloadJson is set", () => {
    // The guard checks row.status === "DRAFT" OR missing payload.
    expect(code).toMatch(/row\.status\s*===\s*"DRAFT"/);
  });
});

describe("MBR-VIS-4 §C — PDF API route forwards mode to the print page", () => {
  const code = src(PDF_ROUTE);

  it("passes mode=<resolved> into the print URL searchParams", () => {
    expect(code).toMatch(/printUrl\.searchParams\.set\("mode",\s*resolved\.pkg\.mode\)/);
  });
});

describe("MBR-VIS-4 §D — DRAFT footer appears only in mode=draft", () => {
  const code = src(PDF_ROUTE);

  it("headerTemplate takes a mode arg", () => {
    expect(code).toMatch(/function\s+headerTemplate\s*\([^)]*mode:\s*PdfMode/);
  });

  it("header template emits a prominent DRAFT marker when mode=draft", () => {
    expect(code).toMatch(/mode\s*===\s*"draft"[\s\S]{0,200}DRAFT/);
  });

  it("footerTemplate takes a mode arg and swaps the left text when drafting", () => {
    expect(code).toMatch(/function\s+footerTemplate\s*\(\s*mode:\s*PdfMode/);
    // The actual footer uses a literal "·" between DRAFT and the
    // disclaimer, not the HTML entity "&middot;".
    expect(code).toMatch(/DRAFT\s*·\s*NOT FOR BOARD DISTRIBUTION/);
  });

  it("non-draft footer keeps the standard confidentiality marker", () => {
    expect(code).toMatch(/Confidential\s*&middot;\s*For Board distribution only/);
  });

  it("filename picks up a -DRAFT suffix for mode=draft", () => {
    expect(code).toMatch(/mode\s*===\s*"draft"\s*\?\s*"-DRAFT"\s*:\s*""/);
  });
});

describe("MBR-VIS-4 §E — print page branches on mode", () => {
  const code = src(PRINT_PAGE);

  it("accepts a mode query param alongside id / period", () => {
    expect(code).toMatch(/searchParams\?:\s*\{[^}]*mode\?:\s*string/);
  });

  it("parses mode via a typed PdfMode helper", () => {
    expect(code).toMatch(/type\s+PdfMode\s*=\s*"draft"\s*\|\s*"published"/);
    expect(code).toMatch(/function\s+parseMode\s*\(/);
  });

  it("mode=published renders packagePayloadJson VERBATIM (never a live rebuild)", () => {
    // Look for the published branch body — it must JSON.parse the
    // frozen payload and NOT call getMonthlyReportingPackage.
    const pubBranch = code.slice(code.indexOf("requestedMode === \"published\""));
    expect(pubBranch).toMatch(/JSON\.parse\(\s*row[^)]*\.packagePayloadJson/);
  });

  it("mode=published 404s when no packagePayloadJson is present", () => {
    // Guards: !row, !row.packagePayloadJson, or row.status === "DRAFT".
    const pubBranch = code.slice(code.indexOf("requestedMode === \"published\""));
    expect(pubBranch).toMatch(/row\.packagePayloadJson/);
    expect(pubBranch).toMatch(/status\s*===\s*"DRAFT"/);
    expect(pubBranch).toMatch(/notFound\(\)/);
  });

  it("mode=draft uses live getMonthlyReportingPackage + resolveDraftVisibility", () => {
    const draftBranch = code.slice(code.lastIndexOf("Draft PDF path"));
    expect(draftBranch).toMatch(/getMonthlyReportingPackage/);
    expect(draftBranch).toMatch(/resolveDraftVisibility/);
  });

  it("renders a DRAFT in-page banner only when effectiveMode === 'draft'", () => {
    expect(code).toMatch(/effectiveMode\s*===\s*"draft"\s*&&/);
    expect(code).toMatch(/data-testid="pdf-draft-banner"/);
    // The in-page banner uses title-case "Draft" (CSS text-transform
    // uppercases it visually in the PDF).
    expect(code).toMatch(/Draft\s*·\s*Not for Board Distribution/i);
  });

  it("stamps the <main> element with data-pdf-mode so Playwright can key off it", () => {
    expect(code).toMatch(/data-pdf-mode=\{effectiveMode\}/);
  });
});

describe("MBR-VIS-4 §F — Shell DownloadPdfButton is mode-aware", () => {
  const code = src(SHELL);

  it("reads preview from URL searchParams and resolves to a PdfMode", () => {
    expect(code).toMatch(/searchParams\?\.get\("preview"\)/);
    expect(code).toMatch(/mode:\s*"draft"\s*\|\s*"published"/);
  });

  it("labels the button Download Published PDF vs Download Draft PDF", () => {
    expect(code).toMatch(/"Download Published PDF"/);
    expect(code).toMatch(/"Download Draft PDF"/);
  });

  it("forwards mode to the PDF API URL", () => {
    expect(code).toMatch(/apiUrl\.searchParams\.set\("mode",\s*mode\)/);
  });

  it("friendly-alerts on 404 when Published PDF is unavailable", () => {
    expect(code).toMatch(/No published snapshot exists/);
  });

  it("board-view URL always resolves to mode=published", () => {
    // The board route is /app/reports/monthly-package/<id>; the
    // ternary assigns mode='published' when boardMatch is truthy.
    expect(code).toMatch(/boardMatch\s*\?\s*"published"/);
  });
});

describe("MBR-VIS-4 §G — publication-state banners carry the matching download link", () => {
  const banner = src(BANNER);
  const admin = src(ADMIN_PAGE);

  it("banner component accepts an optional downloadPdfHref prop", () => {
    expect(banner).toMatch(/downloadPdfHref\?:\s*string/);
  });

  it("draft-mode banner renders 'Download Draft PDF' when the href is present", () => {
    expect(banner).toMatch(/"publication-state-draft-download-pdf"/);
    expect(banner).toMatch(/Download Draft PDF/);
  });

  it("published-mode banner renders 'Download Published PDF' when the href is present", () => {
    expect(banner).toMatch(/"publication-state-published-download-pdf"/);
    expect(banner).toMatch(/Download Published PDF/);
  });

  it("admin page composes a mode=draft PDF href for the Draft Preview banner", () => {
    expect(admin).toMatch(/`\/api\/reporting\/monthly\/pdf\?period=\$\{periodForPdf\}&mode=draft`/);
  });

  it("admin page composes a mode=published PDF href ONLY when a snapshot exists", () => {
    expect(admin).toMatch(/hasPublishedSnapshot/);
    expect(admin).toMatch(/`\/api\/reporting\/monthly\/pdf\?period=\$\{periodForPdf\}&mode=published`/);
  });

  it("admin page emits a publication-status-chip for Editing mode", () => {
    expect(admin).toMatch(/data-testid="publication-status-chip"/);
    // Three tones map to the three states.
    expect(admin).toMatch(/tone:\s*"draft"/);
    expect(admin).toMatch(/tone:\s*"pending"/);
    expect(admin).toMatch(/tone:\s*"published"/);
  });

  it("Editing-mode chip surfaces an unpublished-changes label when the draft diverges", () => {
    expect(admin).toMatch(/Unpublished changes/);
  });
});

describe("MBR-VIS-4 §H — publish lifecycle freezes BOTH financials and visibility", () => {
  const code = src(LIFECYCLE);

  it("publishMonthlyPackage captures packagePayload with visibility: visibilitySnapshot", () => {
    expect(code).toMatch(/snapshotVisibilityForPublish/);
    expect(code).toMatch(/visibility:\s*visibilitySnapshot/);
  });

  it("packagePayloadJson is the full report + visibility (not a partial)", () => {
    expect(code).toMatch(/\.\.\.liveReport/);
    expect(code).toMatch(/packagePayloadJson:\s*JSON\.stringify\(packagePayload\)/);
  });
});
