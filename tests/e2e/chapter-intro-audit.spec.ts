import { test, type Page } from "@playwright/test";
import { writeFileSync, mkdirSync } from "fs";

// Chapter-intro composition audit.
//
// Goal: identify the elements between the top of the page and the
// top of the Equity Value Over Time panel on BOTH Saguaro and
// Spectre. This is the "chapter introduction" the founder wants to
// re-build:
//   1. Chapter identifier
//   2. Report title
//   3. Reporting period
//   4. Short narrative description
//   5. Chapter navigation cards
//   6. (charts)
//
// For each surface, walk the DOM above the Equity panel, capture
// every direct heading / paragraph / card-like block + its rendered
// rectangle + typography. Then take cropped screenshots of the
// chapter intro region so the side-by-side is fair.

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

test("intro audit — Saguaro elements above Equity panel", async ({ page }) => {
  await page.setViewportSize(VIEWPORT);
  await page.goto("https://sample-club.netlify.app/", { waitUntil: "networkidle" });
  await page.waitForTimeout(1500);

  const data = await page.evaluate(() => {
    function round(n: number) { return Math.round(n * 100) / 100; }
    function rectOf(el: Element) {
      const r = (el as HTMLElement).getBoundingClientRect();
      return { x: round(r.x), y: round(r.y), w: round(r.width), h: round(r.height) };
    }
    function styleOf(el: Element) {
      const s = window.getComputedStyle(el as HTMLElement);
      return {
        fontSize: s.fontSize,
        fontFamily: s.fontFamily.split(",")[0].replace(/['"]/g, ""),
        fontWeight: s.fontWeight,
        textTransform: s.textTransform,
        letterSpacing: s.letterSpacing,
        color: s.color,
        lineHeight: s.lineHeight,
        marginTop: s.marginTop,
        marginBottom: s.marginBottom,
      };
    }

    const equityPanel = Array.from(document.querySelectorAll(".panel"))
      .find((p) => (p.querySelector(".panel-header")?.textContent ?? "").trim().startsWith("Equity Value Over Time"));
    if (!equityPanel) return { error: "Equity panel not found" } as const;
    const equityRect = (equityPanel as HTMLElement).getBoundingClientRect();
    const equityDocY = equityRect.top + window.scrollY;

    // Walk the document and collect every visible element whose
    // bottom edge is above the equity panel's top, and whose font-
    // size or class indicates it's part of the chapter intro
    // (h1/h2/h3/h4, .section-title, .page-title, .sec-note, .nav-card,
    // .cover-stat-cell, .cover-stats-grid, etc.).
    const candidates: any[] = [];
    const interesting = new Set([
      "h1","h2","h3","h4","h5",
    ]);
    document.querySelectorAll("*").forEach((el) => {
      const r = (el as HTMLElement).getBoundingClientRect();
      const docY = r.top + window.scrollY;
      const docBot = docY + r.height;
      if (docBot <= 0 || docY >= equityDocY) return; // not in intro region
      if (r.width < 50 || r.height < 8) return;
      const tag = el.tagName.toLowerCase();
      const cls = (el as HTMLElement).className?.toString?.() ?? "";
      const isHeading = interesting.has(tag);
      const isSectionish = /(\b)(section-title|page-title|page-eyebrow|nav-card|nav-cards|cover-stats-grid|cover-stat-cell|sec-note|trend-note|page-meta|page-intro)(\b)/.test(cls);
      if (!isHeading && !isSectionish) return;
      const text = (el.textContent || "").trim().slice(0, 120);
      candidates.push({
        tag,
        classes: cls.slice(0, 100),
        rect: { docX: round(r.x), docY: round(docY), w: round(r.width), h: round(r.height) },
        styles: styleOf(el),
        text,
      });
    });

    // Sort by document y
    candidates.sort((a, b) => a.rect.docY - b.rect.docY);

    return {
      equityDocY: round(equityDocY),
      candidates,
    };
  });

  mkdirSync("test-results", { recursive: true });
  writeFileSync("test-results/intro-saguaro.json", JSON.stringify(data, null, 2), "utf8");

  // Scroll so the area immediately ABOVE the Equity panel is visible
  // at the bottom of the viewport. We want the chapter intro to fill
  // the screenshot.
  if ("equityDocY" in data && typeof data.equityDocY === "number") {
    const scrollTarget = Math.max(0, data.equityDocY - VIEWPORT.height + 100);
    await page.evaluate((y) => window.scrollTo({ top: y, behavior: "instant" as ScrollBehavior }), scrollTarget);
    await page.waitForTimeout(400);
    await page.screenshot({ path: "test-results/intro-saguaro-crop.png", fullPage: false });
  }
});

test("intro audit — Spectre elements above Equity card", async ({ page }) => {
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
    function styleOf(el: Element) {
      const s = window.getComputedStyle(el as HTMLElement);
      return {
        fontSize: s.fontSize,
        fontFamily: s.fontFamily.split(",")[0].replace(/['"]/g, ""),
        fontWeight: s.fontWeight,
        textTransform: s.textTransform,
        letterSpacing: s.letterSpacing,
        color: s.color,
        lineHeight: s.lineHeight,
        marginTop: s.marginTop,
        marginBottom: s.marginBottom,
      };
    }

    const equityCard = document.querySelector("[data-testid='stewardship-equity']");
    if (!equityCard) return { error: "Equity card not found" } as const;
    const equityRect = (equityCard as HTMLElement).getBoundingClientRect();
    const equityDocY = equityRect.top + window.scrollY;

    // Find the chapter container (section id="financial-performance") and
    // walk its content above the equity card.
    const chapter = document.querySelector("#financial-performance");
    if (!chapter) return { error: "financial-performance section not found", equityDocY } as const;

    const candidates: any[] = [];
    const interesting = new Set(["h1","h2","h3","h4","h5","p"]);
    chapter.querySelectorAll("*").forEach((el) => {
      const r = (el as HTMLElement).getBoundingClientRect();
      const docY = r.top + window.scrollY;
      const docBot = docY + r.height;
      if (docBot <= 0 || docY >= equityDocY) return;
      if (r.width < 50 || r.height < 8) return;
      const tag = el.tagName.toLowerCase();
      const cls = (el as HTMLElement).className?.toString?.() ?? "";
      if (!interesting.has(tag) && !cls.includes("card") && !cls.includes("eyebrow")) return;
      const text = (el.textContent || "").trim().slice(0, 120);
      candidates.push({
        tag,
        classes: cls.slice(0, 100),
        rect: { docX: round(r.x), docY: round(docY), w: round(r.width), h: round(r.height) },
        styles: styleOf(el),
        text,
      });
    });
    candidates.sort((a, b) => a.rect.docY - b.rect.docY);

    return {
      equityDocY: round(equityDocY),
      chapterStartDocY: round((chapter as HTMLElement).getBoundingClientRect().top + window.scrollY),
      candidates,
    };
  });

  mkdirSync("test-results", { recursive: true });
  writeFileSync("test-results/intro-spectre.json", JSON.stringify(data, null, 2), "utf8");

  // Don't re-scroll; capture at current scroll which is the top of chapter II.
  await page.screenshot({ path: "test-results/intro-spectre-crop.png", fullPage: false });
});
