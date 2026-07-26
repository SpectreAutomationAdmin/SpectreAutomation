// Monthly Reporting Package — PDF export contract.
//
// Source-contract tests (matching the repo's convention) confirming
// the founder's 2026-06-30 PDF export rebuild:
//
//   • The "Print Mode" toggle is replaced by a Download PDF button.
//   • The existing printer icon SVG is preserved byte-for-byte.
//   • The button no longer toggles a body data-attribute or invokes
//     window.print() — it fetches /api/reporting/monthly/pdf and
//     triggers a download.
//   • The PDF API route is server-side, returns application/pdf with
//     a descriptive Content-Disposition filename, and never goes
//     through the browser print dialog.
//   • A dedicated print route exists at /app/print/monthly-package
//     with print-mode CSS (page-break rules, no shell chrome).
//   • The live web report (admin route page.tsx + body component)
//     remains visually unchanged.

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const SHELL = fs.readFileSync(
  path.resolve(process.cwd(), "src/components/reporting/ReportingShell.tsx"),
  "utf8",
);
const PRINT_ROUTE = fs.readFileSync(
  path.resolve(process.cwd(), "src/app/app/print/monthly-package/page.tsx"),
  "utf8",
);
const PDF_API = fs.readFileSync(
  path.resolve(process.cwd(), "src/app/api/reporting/monthly/pdf/route.ts"),
  "utf8",
);
const ADMIN_PAGE = fs.readFileSync(
  path.resolve(process.cwd(), "src/app/app/admin/reporting/monthly/page.tsx"),
  "utf8",
);
const BODY = fs.readFileSync(
  path.resolve(
    process.cwd(),
    "src/app/app/admin/reporting/monthly/MonthlyReportingPackageBody.tsx",
  ),
  "utf8",
);

describe("DownloadPdfButton — replaces PrintModeToggle in the shell", () => {
  it("button label reads 'Download PDF' (not 'Print mode' / 'Print Mode')", () => {
    // The label is the static JSX literal "Download PDF" inside
    // the button's <span>. Match the literal exactly (the ternary
    // for the loading state lives next to it).
    expect(SHELL).toContain('"Download PDF"');
    // The legacy toggle labels are gone from CODE. Strip comments
    // first — the rewrite header explains the rename and is
    // allowed to reference the old labels for historical context.
    const codeOnly = SHELL
      .split("\n")
      .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("/*") && !l.trim().startsWith("*"))
      .join("\n");
    expect(codeOnly).not.toContain('"Print mode"');
    expect(codeOnly).not.toContain('"Print Mode"');
    expect(codeOnly).not.toContain('"Exit print"');
  });

  it("printer icon SVG is preserved BYTE-FOR-BYTE (same polyline + path + rect)", () => {
    // The founder's spec is explicit: "retain the existing printer
    // icon" — these three SVG subpaths are the icon shape and must
    // not change.
    expect(SHELL).toContain('<polyline points="6 9 6 2 18 2 18 9" />');
    expect(SHELL).toContain(
      '<path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />',
    );
    expect(SHELL).toContain('<rect x="6" y="14" width="12" height="8" rx="1" />');
    // Same dimensions + viewBox.
    expect(SHELL).toMatch(/width="11"\s+height="11"\s+viewBox="0 0 24 24"/);
  });

  it("button has testid 'download-pdf-button' (new) and NOT 'print-mode-toggle' (gone)", () => {
    expect(SHELL).toContain('data-testid="download-pdf-button"');
    expect(SHELL).not.toContain('data-testid="print-mode-toggle"');
  });

  it("button no longer toggles a body data-print-mode attribute on the shell", () => {
    // Strip comments before assertion — the rewrite header may
    // mention the old behaviour for historical context.
    const codeOnly = SHELL
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n");
    expect(codeOnly).not.toMatch(/data-print-mode/);
    expect(codeOnly).not.toMatch(/setPrintMode/);
    expect(codeOnly).not.toMatch(/printMode\b/);
  });

  it("button NEVER calls window.print() (browser dialog must not appear)", () => {
    expect(SHELL).not.toMatch(/window\.print/);
  });

  it("clicking the button fetches /api/reporting/monthly/pdf and triggers a download via blob URL", () => {
    expect(SHELL).toMatch(/\/api\/reporting\/monthly\/pdf/);
    expect(SHELL).toMatch(/fetch\(apiUrl\.toString\(\)/);
    // The blob-URL → anchor[download] → click pattern is the
    // standard same-origin download trigger. Confirm both halves.
    expect(SHELL).toMatch(/URL\.createObjectURL\(blob\)/);
    expect(SHELL).toMatch(/a\.download = filename/);
    expect(SHELL).toMatch(/URL\.revokeObjectURL\(url\)/);
  });

  it("supplies the package identity to the API: id for board route, period for admin route", () => {
    // The button parses the pathname to detect the board route's
    // dynamic [id] segment + reads ?period from the search params.
    // Either value (or neither — server defaults) becomes the
    // API's only argument.
    expect(SHELL).toContain("/app/reports/monthly-package/");
    expect(SHELL).toMatch(/exec\(pathname\)/);
    expect(SHELL).toMatch(/apiUrl\.searchParams\.set\("id"/);
    expect(SHELL).toMatch(/apiUrl\.searchParams\.set\("period"/);
  });

  it("preparing-state surfaces during the fetch (no double-click submissions)", () => {
    expect(SHELL).toMatch(/setIsDownloading\(true\)/);
    expect(SHELL).toMatch(/setIsDownloading\(false\)/);
    expect(SHELL).toMatch(/disabled=\{isDownloading\}/);
    expect(SHELL).toContain('"Preparing…"');
  });
});

describe("Print route — /app/print/monthly-package", () => {
  it("renders the shared MonthlyReportingPackageBody without ReportingShell or sidebar", () => {
    expect(PRINT_ROUTE).toMatch(/MonthlyReportingPackageBody/);
    // No shell, no sidebar — Playwright captures this page's HTML
    // as the PDF, so any chrome would print on the page.
    expect(PRINT_ROUTE).not.toMatch(/<ReportingShell\b/);
    expect(PRINT_ROUTE).not.toMatch(/<Sidebar\b/);
  });

  it("resolves the package via ?id (board path, frozen snapshot) OR ?period (admin path, live)", () => {
    expect(PRINT_ROUTE).toMatch(/getBoardPackageView\(principal, searchParams\.id\)/);
    expect(PRINT_ROUTE).toMatch(/getMonthlyReportingPackage\(/);
    // Admin path keeps the reports:board gate.
    expect(PRINT_ROUTE).toMatch(/hasPermission\(principal, clubId, "reports:board"\)/);
  });

  it("ships intentional print CSS: page-break rules + Letter @page sizing + no browser headers/footers", () => {
    // @page sets Letter LANDSCAPE with explicit margins (founder
    // 2026-07-01) — Playwright honours these because we pass
    // preferCSSPageSize: true in the PDF call.
    expect(PRINT_ROUTE).toMatch(/@page\s*\{[\s\S]*size:\s*Letter landscape/);
    expect(PRINT_ROUTE).toMatch(/margin:\s*0\.55in 0\.7in 0\.7in 0\.7in/);

    // "Never leave a section heading at the bottom of a page."
    expect(PRINT_ROUTE).toMatch(/break-after:\s*avoid-page/);
    expect(PRINT_ROUTE).toMatch(/page-break-after:\s*avoid/);

    // "Begin major report sections on clean pages where appropriate."
    expect(PRINT_ROUTE).toMatch(/break-before:\s*page/);
    expect(PRINT_ROUTE).toMatch(/page-break-before:\s*always/);

    // "Prevent charts / KPI cards / tables from being split."
    expect(PRINT_ROUTE).toMatch(/break-inside:\s*avoid-page/);
    expect(PRINT_ROUTE).toMatch(/page-break-inside:\s*avoid/);
  });

  it("hides any accidental shell chrome (defensive belt-and-brace)", () => {
    expect(PRINT_ROUTE).toMatch(/reporting-shell-exit/);
    expect(PRINT_ROUTE).toMatch(/print-mode-toggle/);
    expect(PRINT_ROUTE).toMatch(/topbar-user-trigger/);
    expect(PRINT_ROUTE).toMatch(/display:\s*none\s*!important/);
  });
});

describe("PDF API route — /api/reporting/monthly/pdf", () => {
  it("runs on the Node.js runtime (Playwright cannot run in Edge)", () => {
    expect(PDF_API).toMatch(/export const runtime = "nodejs"/);
    expect(PDF_API).toMatch(/export const dynamic = "force-dynamic"/);
  });

  it("validates input + applies authz BEFORE launching Chromium (fast 4xx)", () => {
    expect(PDF_API).toMatch(/Not authenticated/);
    expect(PDF_API).toMatch(/Must supply \?id or \?period/);
    expect(PDF_API).toMatch(/Invalid period format/);
    expect(PDF_API).toMatch(/Missing reports:board/);
    expect(PDF_API).toMatch(/Package not found/);
  });

  it("launches headless Chromium + navigates to the print route + returns PDF binary", () => {
    expect(PDF_API).toMatch(/import\("playwright"\)/);
    expect(PDF_API).toMatch(/chromium\.launch\(\{\s*headless: true/);
    expect(PDF_API).toMatch(/\/app\/print\/monthly-package/);
    expect(PDF_API).toMatch(/page\.pdf\(/);
    expect(PDF_API).toMatch(/"Content-Type":\s*"application\/pdf"/);
  });

  it("forwards the user's session cookie so the print route renders as them", () => {
    expect(PDF_API).toMatch(/req\.headers\.get\("cookie"\)/);
    expect(PDF_API).toMatch(/context\.addCookies/);
  });

  it("ships a Spectre-styled header + footer template with page numbers", () => {
    expect(PDF_API).toMatch(/headerTemplate\(/);
    expect(PDF_API).toMatch(/footerTemplate\(/);
    expect(PDF_API).toMatch(/displayHeaderFooter:\s*true/);
    // Page numbering via Playwright's substitution.
    expect(PDF_API).toMatch(/class="pageNumber"/);
    expect(PDF_API).toMatch(/class="totalPages"/);
  });

  it("returns a descriptive Content-Disposition filename with the reporting period", () => {
    expect(PDF_API).toMatch(/Content-Disposition.*attachment.*filename="\$\{filename\}"/);
    expect(PDF_API).toMatch(/Monthly-Board-Reporting-Package-\$\{resolved\.pkg\.filenameSafe\}\.pdf/);
  });

  it("uses Letter format + CSS page-size honored (so the print route's @page rules apply)", () => {
    expect(PDF_API).toMatch(/format:\s*"Letter"/);
    expect(PDF_API).toMatch(/preferCSSPageSize:\s*true/);
    expect(PDF_API).toMatch(/printBackground:\s*true/);
  });

  it("renders the PDF in LANDSCAPE orientation with a viewport wide enough to activate Tailwind lg: (founder spec 2026-07-01)", () => {
    expect(PDF_API).toMatch(/landscape:\s*true/);
    // Viewport ≥1024px so the body's lg:grid-cols-* multi-column
    // layouts activate during PDF generation.
    expect(PDF_API).toMatch(/VIEWPORT_WIDTH\s*=\s*1280/);
    // Scale shrinks the 1280-px-wide layout to fit landscape
    // Letter's 1056-px content area.
    expect(PDF_API).toMatch(/scale:\s*0\.825/);
    // Landscape-specific margins (tighter top, wider sides).
    expect(PDF_API).toMatch(/top:\s*"0\.55in"/);
    expect(PDF_API).toMatch(/left:\s*"0\.7in"/);
    expect(PDF_API).toMatch(/right:\s*"0\.7in"/);
  });

  it("runs a two-pass measurement to compute TOC page numbers BEFORE generating the PDF", () => {
    // Chromium's headless print engine doesn't reliably implement
    // CSS Paged Media's target-counter(); the API instead measures
    // each chapter section's offsetHeight in the live print-
    // emulated page, walks the chapter list cumulatively (each
    // chapter starts on a new page via break-before: page), then
    // injects the resolved numbers into the TOC's
    // [data-page-ref] placeholders BEFORE page.pdf() runs.
    expect(PDF_API).toMatch(/emulateMedia\(\{\s*media:\s*"print"\s*\}\)/);
    expect(PDF_API).toMatch(/PER_PAGE_CONTENT_HEIGHT_CSS_PX\s*=\s*844/);
    expect(PDF_API).toMatch(/TITLE_PLUS_TOC_OFFSET\s*=\s*2/);
    // Uses the SHARED registry — so adding/renaming a chapter
    // immediately reflects in the TOC measurement.
    expect(PDF_API).toMatch(
      /import \{ MONTHLY_REPORTING_CHAPTERS \} from "@\/lib\/reporting\/monthly-package-chapters"/,
    );
    // Looks up each chapter by id rather than `section[id]` (the
    // first chapter renders as <div id="executive-opening">, not
    // a <section>).
    expect(PDF_API).toMatch(/MONTHLY_REPORTING_CHAPTERS\.map\(\(c\)\s*=>\s*chapterIdFor\(c\.label\)\)/);
    expect(PDF_API).toMatch(/root\.querySelector<HTMLElement>\(`#\$\{CSS\.escape\(id\)\}`\)/);
    // After measurement, inject the numbers into the TOC's
    // [data-page-ref] slots.
    expect(PDF_API).toMatch(/document\s*\.\s*querySelectorAll<HTMLElement>\("\[data-page-ref\]"\)/);
    expect(PDF_API).toMatch(/slot\.textContent = String\(mapping\[id\]\)/);
  });
});

describe("Landscape redesign — title page + TOC use the wider canvas", () => {
  it("@page rule sets Letter landscape orientation", () => {
    expect(PRINT_ROUTE).toMatch(/size:\s*Letter landscape/);
  });

  it("title page is a TWO-COLUMN landscape editorial cover (identity left · doc right · footer band full-width)", () => {
    expect(PRINT_ROUTE).toMatch(/\.pdf-title-page\b[\s\S]+display:\s*grid/);
    expect(PRINT_ROUTE).toMatch(
      /\.pdf-title-page\b[\s\S]+grid-template-columns:\s*0\.95fr 1\.05fr/,
    );
    expect(PRINT_ROUTE).toMatch(/className="identity-col"/);
    expect(PRINT_ROUTE).toMatch(/className="doc-col"/);
    // Footer band spans the full landscape width.
    expect(PRINT_ROUTE).toMatch(/\.footer-block\b[\s\S]+grid-column:\s*1 \/ -1/);
  });

  it("TOC uses a TWO-COLUMN layout via CSS columns so chapter groups balance across the landscape canvas", () => {
    expect(PRINT_ROUTE).toMatch(/\.pdf-toc-cols\b[\s\S]+column-count:\s*2/);
    expect(PRINT_ROUTE).toMatch(/column-rule:\s*0\.5pt solid #e5dfc8/);
    // Groups don't split across columns.
    expect(PRINT_ROUTE).toMatch(/\.pdf-toc-group\b[\s\S]+break-inside:\s*avoid/);
  });
});

describe("TOC page numbers — server-injected, not CSS-counter-based", () => {
  it("each TOC anchor carries a data-page-ref slot for server-side injection", () => {
    expect(PRINT_ROUTE).toMatch(/data-page-ref=\{id\}/);
    expect(PRINT_ROUTE).toMatch(/data-toc-anchor=\{id\}/);
    // Every group iterates the shared registry.
    expect(PRINT_ROUTE).toMatch(/for \(const ch of MONTHLY_REPORTING_CHAPTERS\)/);
  });

  it("CSS leader-dots are rendered via ::before so the JSX stays semantic", () => {
    expect(PRINT_ROUTE).toMatch(/\.pdf-toc-list \.leaders::before[\s\S]+content:\s*"\.{20,}"/);
  });

  it("the now-irrelevant target-counter() CSS RULE is removed from the print route", () => {
    // We previously had a `target-counter(attr(href), page)` rule
    // hoping Chromium's print engine would auto-fill page numbers.
    // It doesn't — the API's two-pass measurement does. Confirm
    // the dead CSS RULE is gone so future readers don't waste
    // time debugging it. (Mentions inside comments — explaining
    // WHY we don't use target-counter — are fine.)
    const codeOnly = PRINT_ROUTE
      .split("\n")
      .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("/*") && !l.trim().startsWith("*"))
      .join("\n");
    // The `content: target-counter(...)` rule specifically must
    // be gone (this was the broken implementation).
    expect(codeOnly).not.toMatch(/content:\s*target-counter\(/);
  });

  it("Chromium is closed in a finally{} block (no leaks on errors)", () => {
    expect(PDF_API).toMatch(/finally\s*\{\s*await browser\.close\(\)/);
  });
});

describe("PDF title page — Page 1 standalone executive cover", () => {
  it("emits a dedicated pdf-title-page section with the founder-spec elements", () => {
    expect(PRINT_ROUTE).toMatch(/data-testid="pdf-title-page"/);
    expect(PRINT_ROUTE).toMatch(/data-pdf-front-matter="title"/);
    // Club identity stack.
    expect(PRINT_ROUTE).toMatch(/className="club-name"/);
    expect(PRINT_ROUTE).toMatch(/\{club\.name\}/);
    expect(PRINT_ROUTE).toMatch(/cityProvinceLine/);
    expect(PRINT_ROUTE).toMatch(/Established \$\{club\.yearFounded\}/);
    // Main title + reporting period + "Period N of Twelve" label.
    expect(PRINT_ROUTE).toContain("Monthly Board Reporting Package");
    expect(PRINT_ROUTE).toMatch(/For the \{periodEndedLabel\.replace/);
    expect(PRINT_ROUTE).toMatch(/Period \$\{ORDINAL_WORDS\[ytdMonthsElapsed\]\} of Twelve/);
    // Prepared-for stack (Finance Committee + Board of Directors).
    expect(PRINT_ROUTE).toContain(">Prepared for<");
    expect(PRINT_ROUTE).toContain("Finance Committee");
    expect(PRINT_ROUTE).toContain("Board of Directors");
    // Confidentiality statement.
    expect(PRINT_ROUTE).toContain(">Confidentiality<");
    expect(PRINT_ROUTE).toMatch(/confidential and intended solely for/);
    // Spectre Framework attribution colophon.
    expect(PRINT_ROUTE).toMatch(/Prepared using the Spectre Framework/);
  });

  it("uses break-after: page so the title page is a standalone PDF page", () => {
    expect(PRINT_ROUTE).toMatch(
      /\.pdf-title-page\b[\s\S]+?break-after:\s*page[\s\S]+?page-break-after:\s*always/,
    );
  });

  it("title-page typography is print-grade (serif display + gold rule + generous whitespace)", () => {
    expect(PRINT_ROUTE).toMatch(/font-family:\s*'Newsreader'/);
    expect(PRINT_ROUTE).toMatch(/\.pdf-title-page \.gold-rule/);
    // Landscape Letter is 8.5in tall; the title page reserves the
    // page height minus its vertical margins so the cover fills
    // intentionally.
    expect(PRINT_ROUTE).toMatch(/min-height:\s*calc\(8\.5in - 1\.25in\)/);
  });

  it("title page contains NO KPI cards / report body content (it's a cover, not a chapter)", () => {
    // Strip the inline style block before scanning JSX for the
    // sentinel testids — the print CSS legitimately mentions
    // hide-rules for these as belt-and-brace.
    const titlePageJsx = PRINT_ROUTE
      .split('data-testid="pdf-title-page"')[1]
      .split('data-testid="pdf-toc-page"')[0];
    expect(titlePageJsx).not.toMatch(/KpiCard|kpi-card|<AtAGlanceBlock|StatementLine/);
    expect(titlePageJsx).not.toMatch(/<MonthlyReportingPackageBody/);
  });
});

describe("PDF table of contents — Page 2 standalone, auto-generated", () => {
  it("emits a dedicated pdf-toc-page section that breaks to its own page", () => {
    expect(PRINT_ROUTE).toMatch(/data-testid="pdf-toc-page"/);
    expect(PRINT_ROUTE).toMatch(/data-pdf-front-matter="toc"/);
    expect(PRINT_ROUTE).toMatch(
      /\.pdf-toc-page\b[\s\S]+?break-after:\s*page[\s\S]+?page-break-after:\s*always/,
    );
  });

  it("TOC is generated from the SHARED registry, not hard-coded chapter literals in the print route", () => {
    // The print route's TOC iterates MONTHLY_REPORTING_CHAPTERS.
    // The chapter labels themselves are NOT typed as string
    // literals in the print route — they come from the registry.
    expect(PRINT_ROUTE).toMatch(
      /import \{ MONTHLY_REPORTING_CHAPTERS \} from "@\/lib\/reporting\/monthly-package-chapters"/,
    );
    expect(PRINT_ROUTE).toMatch(/for \(const ch of MONTHLY_REPORTING_CHAPTERS\)/);
    // Strip the registry import + the inline style block, then
    // confirm the print route does NOT inline any chapter labels
    // — they all flow from `ch.label`.
    const codeOnly = PRINT_ROUTE
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n");
    // The chapter labels do appear in the rendered HTML via
    // `{ch.label}` but not as string literals in JSX. The literal
    // probe below confirms two distinct chapter names are NOT
    // present as string constants in the print route source.
    expect(codeOnly).not.toMatch(/"Statement of Activities"/);
    expect(codeOnly).not.toMatch(/"Capital Projects"/);
    expect(codeOnly).not.toMatch(/"Inventory Analysis"/);
    // The TOC iterator renders ch.label — confirm that wiring.
    expect(PRINT_ROUTE).toMatch(/\{ch\.label\}/);
    expect(PRINT_ROUTE).toMatch(/\{ch\.number\}/);
  });

  it("TOC page numbers are server-injected (NOT CSS target-counter — Chromium's headless print doesn't support it reliably)", () => {
    // 2026-07-01 founder fix: replaced the CSS target-counter()
    // approach with a server-side measurement + injection pass
    // (see the "runs a two-pass measurement" test under the PDF
    // API contract block above). Each TOC entry holds an empty
    // `.page-ref` placeholder that the API populates.
    expect(PRINT_ROUTE).toMatch(/<span className="page-ref"/);
    expect(PRINT_ROUTE).toMatch(/data-page-ref=\{id\}/);
  });

  it("TOC groups chapters by the registry's `group` field (Member Overview / Financial Statements / Operations & Analytics)", () => {
    expect(PRINT_ROUTE).toMatch(/byGroup\.set\(ch\.group/);
    expect(PRINT_ROUTE).toMatch(/className="group-label"/);
    // Group labels come from registry data, not literals.
    expect(PRINT_ROUTE).toMatch(/\{group\}/);
  });

  it("TOC anchors point at the body's chapter section ids (so target-counter resolves)", () => {
    // chapterIdFor() is the canonical slug — must come from the
    // pure helper (not the client ReportingShell re-export, which
    // doesn't work across the server boundary).
    expect(PRINT_ROUTE).toMatch(
      /import \{ chapterIdFor \} from "@\/lib\/reporting\/chapter-id"/,
    );
    expect(PRINT_ROUTE).toMatch(/href=\{`#\$\{id\}`\}/);
  });
});

describe("Body chapters begin on clean pages so TOC page refs are stable", () => {
  it("every section[id] gets break-before: page (cover + 13 body chapters all start on fresh pages)", () => {
    // Before this slice the cover was excluded from the page break
    // (it shared page 1 with the first chapter). Now the title
    // page is page 1 + TOC is page 2, so EVERY body section
    // starts on its own page (the cover is page 3, chapter II is
    // page 4 or later, etc).
    expect(PRINT_ROUTE).toMatch(/section\[id\] \{\s*break-before:\s*page/);
    expect(PRINT_ROUTE).not.toMatch(/section\[id\]:not\(#executive-opening\)/);
  });
});

describe("Shared chapter registry is the single source of truth", () => {
  const REGISTRY = fs.readFileSync(
    path.resolve(process.cwd(), "src/lib/reporting/monthly-package-chapters.ts"),
    "utf8",
  );
  const ADMIN_REPORTING_LAYOUT = fs.readFileSync(
    path.resolve(process.cwd(), "src/app/app/admin/reporting/layout.tsx"),
    "utf8",
  );
  const BOARD_REPORTING_LAYOUT = fs.readFileSync(
    path.resolve(
      process.cwd(),
      "src/app/app/reports/monthly-package/[id]/layout.tsx",
    ),
    "utf8",
  );

  it("registry exports MONTHLY_REPORTING_CHAPTERS with all 14 chapters in 3 groups", () => {
    expect(REGISTRY).toMatch(/export const MONTHLY_REPORTING_CHAPTERS/);
    for (const chapter of [
      "Executive Opening",
      "Financial Performance",
      "Stewardship Dashboard",
      "Statement of Activities",
      "Capital Fund",
      "Capital Projects",
      "Financial Position",
      "AR Aging",
      "Operating Statistics",
      "Departmental P&L",
      "Weather & Utilization",
      "Payroll Analysis",
      "F&B Statistics",
      "Inventory Analysis",
    ]) {
      expect(REGISTRY).toContain(`label: "${chapter}"`);
    }
    for (const group of [
      "Member Overview",
      "Financial Statements",
      "Operations & Analytics",
    ]) {
      expect(REGISTRY).toContain(`group: "${group}"`);
    }
  });

  it("both reporting layouts (admin + board) import from the registry, not from a local literal array", () => {
    expect(ADMIN_REPORTING_LAYOUT).toMatch(
      /import \{ MONTHLY_REPORTING_CHAPTERS \} from "@\/lib\/reporting\/monthly-package-chapters"/,
    );
    expect(BOARD_REPORTING_LAYOUT).toMatch(
      /import \{ MONTHLY_REPORTING_CHAPTERS \} from "@\/lib\/reporting\/monthly-package-chapters"/,
    );
    // Neither layout declares its own MONTHLY_CHAPTERS const.
    expect(ADMIN_REPORTING_LAYOUT).not.toMatch(
      /const MONTHLY_CHAPTERS:\s*ReadonlyArray<ReportingChapter>\s*=\s*\[/,
    );
    expect(BOARD_REPORTING_LAYOUT).not.toMatch(
      /const MONTHLY_CHAPTERS:\s*ReadonlyArray<ReportingChapter>\s*=\s*\[/,
    );
    // Both pass the shared constant to the shell.
    expect(ADMIN_REPORTING_LAYOUT).toMatch(/chapters=\{MONTHLY_REPORTING_CHAPTERS\}/);
    expect(BOARD_REPORTING_LAYOUT).toMatch(/chapters=\{MONTHLY_REPORTING_CHAPTERS\}/);
  });
});

describe("Live web report is NOT visually modified", () => {
  it("admin route still renders the same MonthlyReportingPackageBody with its PublishHeaderButton header", () => {
    expect(ADMIN_PAGE).toMatch(/<MonthlyReportingPackageBody/);
    expect(ADMIN_PAGE).toMatch(/<PublishHeaderButton/);
    // The admin route is unchanged this slice — no new imports
    // for PDF concerns, no inline print CSS leak.
    expect(ADMIN_PAGE).not.toMatch(/@page/);
    expect(ADMIN_PAGE).not.toMatch(/break-after/);
    expect(ADMIN_PAGE).not.toMatch(/page-break/);
  });

  it("shared body component has not gained print-mode coupling", () => {
    // The body renders to BOTH the web route and the print route.
    // Print CSS lives in the print route's inline <style>, not in
    // the body — keeping the web surface visually identical to
    // before this slice.
    const codeOnly = BODY
      .split("\n")
      .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("/*") && !l.trim().startsWith("*"))
      .join("\n");
    expect(codeOnly).not.toMatch(/@page/);
    expect(codeOnly).not.toMatch(/print-mode/);
  });
});
