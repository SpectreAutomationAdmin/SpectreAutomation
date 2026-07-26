import { test, type Page } from "@playwright/test";
import { writeFileSync, mkdirSync } from "fs";

// Page-composition audit. Walks both pages from viewport edge inward,
// capturing the actual page structure — left navigation, content
// canvas, two-card grid, card geometry, plot region — so we can see
// which level of the layout makes Spectre's cards "feel smaller" than
// Saguaro's.
//
// Also captures cropped screenshots of JUST the two-card grid on each
// page, so the side-by-side visual comparison reflects only the chart
// region, with the surrounding chrome stripped.

const VIEWPORT = { width: 1440, height: 900 };
const ADMIN = "admin@silversprings.club";
const PASSWORD = "password";

async function login(page: Page) {
  await page.goto("/login");
  await page.fill('input[name="email"]', ADMIN);
  await page.fill('input[name="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/app(\/|$)/, { timeout: 15_000 });
}

function round(n: number) { return Math.round(n * 100) / 100; }

test("composition — Saguaro", async ({ page }) => {
  await page.setViewportSize(VIEWPORT);
  await page.goto("https://sample-club.netlify.app/", { waitUntil: "networkidle" });
  await page.waitForTimeout(1500);

  const data = await page.evaluate(() => {
    function round(n: number) { return Math.round(n * 100) / 100; }
    function rectOf(el: Element) {
      const r = (el as HTMLElement).getBoundingClientRect();
      return { x: round(r.x), y: round(r.y), w: round(r.width), h: round(r.height) };
    }

    // Saguaro structural elements
    const html = document.documentElement;
    const body = document.body;
    // The site uses .layout > .nav (sidebar) + .pages (content stack)
    const layout = document.querySelector(".layout");
    const nav = document.querySelector(".nav, nav, aside");
    const pages = document.querySelector(".pages, .pages-stack, .content");
    // Each page is a .page
    const currentPage = document.querySelector(".page");
    // The two-card row that holds Equity Value Over Time + Operating
    // Results — find by walking to a common ancestor of the two panels.
    const allPanels = Array.from(document.querySelectorAll(".panel"));
    const equityPanel = allPanels.find(
      (p) => (p.querySelector(".panel-header")?.textContent ?? "").trim().startsWith("Equity Value Over Time"),
    );
    const operatingPanel = allPanels.find(
      (p) => (p.querySelector(".panel-header")?.textContent ?? "").trim().startsWith("Operating Results"),
    );
    // Common ancestor (the row containing both)
    let row: Element | null = null;
    if (equityPanel && operatingPanel) {
      let cur = equityPanel.parentElement;
      while (cur && !cur.contains(operatingPanel)) cur = cur.parentElement;
      row = cur;
    }

    return {
      viewport: { w: window.innerWidth, h: window.innerHeight },
      html: rectOf(html),
      body: rectOf(body),
      layout: layout ? rectOf(layout) : null,
      nav: nav ? rectOf(nav) : null,
      pages: pages ? rectOf(pages) : null,
      currentPage: currentPage ? rectOf(currentPage) : null,
      twoCardRow: row ? { ...rectOf(row), tag: row.tagName.toLowerCase(), classes: (row as HTMLElement).className?.toString?.().slice(0, 80) ?? "" } : null,
      equity: equityPanel ? rectOf(equityPanel) : null,
      operating: operatingPanel ? rectOf(operatingPanel) : null,
    };
  });

  mkdirSync("test-results", { recursive: true });
  writeFileSync("test-results/composition-saguaro.json", JSON.stringify(data, null, 2), "utf8");

  // Scroll to the two-card row and capture a cropped screenshot.
  if (data.twoCardRow) {
    await page.evaluate((y) => window.scrollTo({ top: y - 30, behavior: "instant" as ScrollBehavior }), data.twoCardRow.y);
    await page.waitForTimeout(400);
    await page.screenshot({
      path: "test-results/composition-saguaro-two-card-crop.png",
      clip: {
        x: 0,
        y: 0,
        width: VIEWPORT.width,
        height: Math.min(VIEWPORT.height, data.twoCardRow.h + 60),
      },
    });
  }
  // Full-viewport context shot too.
  await page.evaluate((y) => window.scrollTo({ top: y - 30, behavior: "instant" as ScrollBehavior }), data.twoCardRow?.y ?? 0);
  await page.waitForTimeout(300);
  await page.screenshot({ path: "test-results/composition-saguaro-full.png", fullPage: false });
});

test("composition — Spectre", async ({ page }) => {
  await login(page);
  await page.setViewportSize(VIEWPORT);
  await page.goto("/app/admin/reporting/monthly");
  await page.waitForLoadState("networkidle");
  await page.getByTestId("reporting-chapter-financial-performance").click();
  await page.waitForTimeout(600);

  const data = await page.evaluate(() => {
    function round(n: number) { return Math.round(n * 100) / 100; }
    function rectOf(el: Element) {
      const r = (el as HTMLElement).getBoundingClientRect();
      return { x: round(r.x), y: round(r.y), w: round(r.width), h: round(r.height) };
    }

    const html = document.documentElement;
    const body = document.body;
    // Spectre ReportingShell uses: header + (nav.chapter-rail + main.reading-column)
    const shellHeader = document.querySelector("header[data-testid='reporting-shell-header'], header");
    const chapterRail = document.querySelector("[data-testid='reporting-shell-chapters'], aside, nav[aria-label]");
    const readingColumn = document.querySelector("[data-testid='reporting-shell-body'], main");
    const stewardship = document.querySelector("[data-testid='stewardship-dashboard']");
    const equity = document.querySelector("[data-testid='stewardship-equity']");
    const operating = document.querySelector("[data-testid='stewardship-operating']");
    // The parent of the two-card grid is the dashboard wrapper itself.
    // The parent of THAT (the chapter content section) is what
    // determines max width.
    const chapterContent = stewardship?.parentElement ?? null;

    return {
      viewport: { w: window.innerWidth, h: window.innerHeight },
      html: rectOf(html),
      body: rectOf(body),
      shellHeader: shellHeader ? rectOf(shellHeader) : null,
      chapterRail: chapterRail ? rectOf(chapterRail) : null,
      readingColumn: readingColumn ? rectOf(readingColumn) : null,
      chapterContent: chapterContent ? rectOf(chapterContent) : null,
      twoCardRow: stewardship ? { ...rectOf(stewardship), tag: stewardship.tagName.toLowerCase(), classes: (stewardship as HTMLElement).className?.toString?.().slice(0, 80) ?? "" } : null,
      equity: equity ? rectOf(equity) : null,
      operating: operating ? rectOf(operating) : null,
    };
  });

  mkdirSync("test-results", { recursive: true });
  writeFileSync("test-results/composition-spectre.json", JSON.stringify(data, null, 2), "utf8");

  // Full-viewport screenshot at the current scroll position (chapter
  // II has just been navigated to via the chapter-rail click).
  await page.screenshot({ path: "test-results/composition-spectre-full.png", fullPage: false });

  // Clip-screenshot the two-card row at its CURRENT viewport position
  // (do NOT scrollTo — Spectre's chapter-rail click already positions
  // the chapter at the top of the body; reading data.twoCardRow.y as
  // a viewport-relative coord and clipping there yields the correct
  // crop).
  if (data.twoCardRow) {
    await page.screenshot({
      path: "test-results/composition-spectre-two-card-crop.png",
      clip: {
        x: 0,
        y: Math.max(0, data.twoCardRow.y - 30),
        width: VIEWPORT.width,
        height: Math.min(VIEWPORT.height - Math.max(0, data.twoCardRow.y - 30), data.twoCardRow.h + 60),
      },
    });
  }
});
