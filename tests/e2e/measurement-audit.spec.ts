import { test, type Page } from "@playwright/test";
import { writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";

// Empirical measurement audit. Captures DOM geometry, typography, and
// SVG stroke metrics for BOTH the Saguaro reference and the Spectre
// Stewardship Dashboard, at the same viewport. Writes a JSON report
// the operator (and the next agent) reads BEFORE making any visual
// changes. Measure first, edit later.

const ADMIN = "admin@silversprings.club";
const PASSWORD = "password";
const VIEWPORT = { width: 1440, height: 900 };

const SAGUARO = {
  // Saguaro Sample Club has multiple pages; p03 ("Executive Summary")
  // is the analogue of Spectre's Stewardship Dashboard (Chapter IV),
  // p05 is the financial-KPI page. We capture both.
  execSummary: "https://sample-club.netlify.app/#p03",
  financialKpi: "https://sample-club.netlify.app/#p05",
};

async function login(page: Page) {
  await page.goto("/login");
  await page.fill('input[name="email"]', ADMIN);
  await page.fill('input[name="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/app(\/|$)/, { timeout: 15_000 });
}

function writeJson(path: string, data: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2), "utf8");
}

/* -------------------------------------------------------------------
 * In-page measurement helper. We invoke this twice — once on the
 * Saguaro page, once on Spectre — and produce a comparable report.
 *
 * The function takes a list of "card" selectors and reports, for each
 * card found, the things that matter for the comparison:
 *   - bounding rect (w, h)
 *   - computed padding, border, border-radius, background-color
 *   - inner chart (first SVG) bounding rect + path strokes
 *   - text nodes inside the card with font-size, line-height, color
 *   - first ~25 short text fragments (KPI / labels / title candidates)
 * ----------------------------------------------------------------- */
async function measureCards(page: Page, selectors: string[]) {
  return await page.evaluate((sels) => {
    const round = (n: number) => Math.round(n * 100) / 100;
    const pickStyles = (el: Element) => {
      const s = window.getComputedStyle(el as HTMLElement);
      return {
        padTop: parseFloat(s.paddingTop),
        padRight: parseFloat(s.paddingRight),
        padBottom: parseFloat(s.paddingBottom),
        padLeft: parseFloat(s.paddingLeft),
        borderTop: s.borderTopWidth,
        borderColor: s.borderTopColor,
        borderRadius: s.borderTopLeftRadius,
        background: s.backgroundColor,
        boxShadow: s.boxShadow,
      };
    };
    const rectOf = (el: Element) => {
      const r = (el as HTMLElement).getBoundingClientRect();
      return { x: round(r.x), y: round(r.y), w: round(r.width), h: round(r.height) };
    };

    const out: any[] = [];
    for (const sel of sels) {
      const nodes = Array.from(document.querySelectorAll(sel));
      for (const node of nodes) {
        const rect = rectOf(node);
        if (rect.w < 60 || rect.h < 60) continue; // skip non-cards
        const styles = pickStyles(node);

        // Find the largest SVG inside the card (likely THE chart).
        const svgs = Array.from(node.querySelectorAll("svg"));
        let chartSvg: SVGSVGElement | null = null;
        for (const svg of svgs) {
          const r = (svg as SVGSVGElement).getBoundingClientRect();
          if (!chartSvg || r.width * r.height > (chartSvg.getBoundingClientRect().width * chartSvg.getBoundingClientRect().height)) {
            chartSvg = svg as SVGSVGElement;
          }
        }
        const chart = chartSvg ? rectOf(chartSvg) : null;

        // SVG path strokes (line weights) — top 6 paths by length.
        const paths: any[] = [];
        if (chartSvg) {
          const allPaths = Array.from(chartSvg.querySelectorAll("path, line"));
          for (const p of allPaths.slice(0, 12)) {
            const s = window.getComputedStyle(p as Element);
            paths.push({
              tag: p.tagName.toLowerCase(),
              stroke: s.stroke,
              strokeWidth: s.strokeWidth,
              strokeDasharray: s.strokeDasharray === "none" ? null : s.strokeDasharray,
              opacity: s.opacity,
            });
          }
        }

        // Sample text nodes inside the card. Walk text content with
        // their computed font properties.
        const texts: any[] = [];
        const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT, null);
        let textNode: Node | null;
        let count = 0;
        while ((textNode = walker.nextNode()) && count < 40) {
          const t = (textNode.textContent || "").trim();
          if (!t) continue;
          const parent = textNode.parentElement;
          if (!parent) continue;
          const ts = window.getComputedStyle(parent);
          texts.push({
            text: t.length > 80 ? t.slice(0, 80) + "…" : t,
            fontSize: ts.fontSize,
            lineHeight: ts.lineHeight,
            fontWeight: ts.fontWeight,
            fontFamily: ts.fontFamily.split(",")[0].replace(/"/g, ""),
            color: ts.color,
            opacity: ts.opacity,
            letterSpacing: ts.letterSpacing,
            textTransform: ts.textTransform,
          });
          count++;
        }

        out.push({
          selectorMatched: sel,
          tag: node.tagName.toLowerCase(),
          classes: (node as HTMLElement).className?.toString?.().slice(0, 200) ?? "",
          rect,
          styles,
          chart,
          chartToCardRatio: chart ? round(chart.h / rect.h) : null,
          paths,
          texts,
        });
      }
    }
    return out;
  }, selectors);
}

/* -------------------------------------------------------------------
 * Discovery — list every "card-like" element on a Saguaro page so we
 * know what to measure. (Saguaro doesn't expose stable testids; we
 * discover by class signatures.)
 * ----------------------------------------------------------------- */
async function discoverSaguaroCards(page: Page) {
  return await page.evaluate(() => {
    const round = (n: number) => Math.round(n * 100) / 100;
    const visited = new Set<string>();
    const out: any[] = [];
    // Look for divs whose computed style has a border + padding +
    // moderate size. Saguaro uses pure HTML/CSS cards (no SVG), so
    // we DO NOT require an SVG child here.
    document.querySelectorAll("div, section, article").forEach((el) => {
      const s = window.getComputedStyle(el);
      const hasBorder = parseFloat(s.borderTopWidth) > 0 || parseFloat(s.borderBottomWidth) > 0;
      const hasPad = parseFloat(s.paddingTop) > 4 && parseFloat(s.paddingLeft) > 4;
      const hasBg = s.backgroundColor !== "rgba(0, 0, 0, 0)" && s.backgroundColor !== "transparent";
      const r = (el as HTMLElement).getBoundingClientRect();
      if (r.width < 180 || r.height < 80) return;
      if (r.width > 1100 || r.height > 1000) return; // skip page wrappers
      // Card-like: must have at least 2 of (border, padding, background).
      const cardSignals = (hasBorder ? 1 : 0) + (hasPad ? 1 : 0) + (hasBg ? 1 : 0);
      if (cardSignals < 2) return;
      const sig = `${el.tagName}.${(el.className?.toString?.() ?? "").slice(0, 60)}_${Math.round(r.width)}x${Math.round(r.height)}`;
      if (visited.has(sig)) return;
      visited.add(sig);
      out.push({
        tag: el.tagName.toLowerCase(),
        classes: (el as HTMLElement).className?.toString?.().slice(0, 200) ?? "",
        rect: { w: round(r.width), h: round(r.height) },
        hasBorder, hasPad, hasBg,
        background: s.backgroundColor,
        borderTop: s.borderTopWidth,
        borderColor: s.borderTopColor,
        borderRadius: s.borderTopLeftRadius,
        padding: `${s.paddingTop} ${s.paddingRight} ${s.paddingBottom} ${s.paddingLeft}`,
        boxShadow: s.boxShadow,
      });
    });
    return out;
  });
}

/* -------------------------------------------------------------------
 * Measure cards by class signature (Saguaro doesn't have testids).
 * Returns full geometry + text inventory for each match.
 * ----------------------------------------------------------------- */
async function measureSaguaroCardsByClass(page: Page, classFragment: string) {
  return await page.evaluate((frag) => {
    const round = (n: number) => Math.round(n * 100) / 100;
    const matches: Element[] = [];
    document.querySelectorAll("div, section, article").forEach((el) => {
      const cls = (el as HTMLElement).className?.toString?.() ?? "";
      if (cls.includes(frag)) matches.push(el);
    });
    const out: any[] = [];
    for (const el of matches) {
      const r = (el as HTMLElement).getBoundingClientRect();
      if (r.width < 60 || r.height < 60) continue;
      const s = window.getComputedStyle(el);

      // Text inventory inside this card.
      const texts: any[] = [];
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
      let textNode: Node | null;
      let count = 0;
      while ((textNode = walker.nextNode()) && count < 30) {
        const t = (textNode.textContent || "").trim();
        if (!t) continue;
        const parent = textNode.parentElement;
        if (!parent) continue;
        const ts = window.getComputedStyle(parent);
        texts.push({
          text: t.length > 80 ? t.slice(0, 80) + "…" : t,
          fontSize: ts.fontSize,
          lineHeight: ts.lineHeight,
          fontWeight: ts.fontWeight,
          fontFamily: ts.fontFamily.split(",")[0].replace(/"/g, ""),
          color: ts.color,
          letterSpacing: ts.letterSpacing,
          textTransform: ts.textTransform,
        });
        count++;
      }

      out.push({
        classes: (el as HTMLElement).className?.toString?.().slice(0, 160) ?? "",
        rect: { x: round(r.x), y: round(r.y), w: round(r.width), h: round(r.height) },
        padding: { top: parseFloat(s.paddingTop), right: parseFloat(s.paddingRight), bottom: parseFloat(s.paddingBottom), left: parseFloat(s.paddingLeft) },
        borderTop: s.borderTopWidth,
        borderColor: s.borderTopColor,
        borderRadius: s.borderTopLeftRadius,
        background: s.backgroundColor,
        boxShadow: s.boxShadow,
        texts,
      });
    }
    return out;
  }, classFragment);
}

/* -------------------------------------------------------------------
 * Tests
 * ----------------------------------------------------------------- */

test("audit — Saguaro p03 (Stewardship KPI Dashboard)", async ({ page }) => {
  await page.setViewportSize(VIEWPORT);
  await page.goto(SAGUARO.execSummary, { waitUntil: "networkidle" });
  await page.waitForTimeout(1200);
  await page.screenshot({ path: "test-results/audit-saguaro-p03.png", fullPage: false });

  const discovery = await discoverSaguaroCards(page);
  // Saguaro p03 uses class names like "kpi", "card", "ratio-card", "panel".
  // Discover all candidates and measure detailed for each common signature.
  const tiles = await measureSaguaroCardsByClass(page, "kpi");
  const cards = await measureSaguaroCardsByClass(page, "card");
  const ratios = await measureSaguaroCardsByClass(page, "ratio");
  const panels = await measureSaguaroCardsByClass(page, "panel");

  writeJson("test-results/audit-saguaro-p03.json", {
    viewport: VIEWPORT,
    discovery: discovery.slice(0, 40),
    cardsByClass: { kpi: tiles, card: cards, ratio: ratios, panel: panels },
  });
});

test("audit — Saguaro p05 (Capital Fund Statement)", async ({ page }) => {
  await page.setViewportSize(VIEWPORT);
  await page.goto(SAGUARO.financialKpi, { waitUntil: "networkidle" });
  await page.waitForTimeout(1200);
  await page.screenshot({ path: "test-results/audit-saguaro-p05.png", fullPage: false });

  const discovery = await discoverSaguaroCards(page);
  const tiles = await measureSaguaroCardsByClass(page, "kpi");
  const cards = await measureSaguaroCardsByClass(page, "card");
  const ratios = await measureSaguaroCardsByClass(page, "ratio");
  const panels = await measureSaguaroCardsByClass(page, "panel");

  writeJson("test-results/audit-saguaro-p05.json", {
    viewport: VIEWPORT,
    discovery: discovery.slice(0, 40),
    cardsByClass: { kpi: tiles, card: cards, ratio: ratios, panel: panels },
  });
});

test("audit — Spectre Chair's Dashboard (Section II — equity/operating charts)", async ({ page }) => {
  await login(page);
  await page.setViewportSize(VIEWPORT);
  await page.goto("/app/admin/reporting/monthly");
  await page.waitForLoadState("networkidle");
  await page.getByTestId("reporting-chapter-financial-performance").click();
  await page.waitForTimeout(600);
  await page.screenshot({ path: "test-results/audit-spectre-financial-performance.png", fullPage: false });

  const measurements = await measureCards(page, [
    "[data-testid='stewardship-equity']",
    "[data-testid='stewardship-operating']",
  ]);
  writeJson("test-results/audit-spectre-financial-performance.json", { viewport: VIEWPORT, cards: measurements });
});

test("audit — Spectre Stewardship Dashboard (Section X — policy ratios)", async ({ page }) => {
  await login(page);
  await page.setViewportSize(VIEWPORT);
  await page.goto("/app/admin/reporting/monthly");
  await page.waitForLoadState("networkidle");
  await page.getByTestId("reporting-chapter-stewardship").click();
  await page.waitForTimeout(600);
  await page.screenshot({ path: "test-results/audit-spectre-stewardship.png", fullPage: false });

  const measurements = await measureCards(page, [
    "[data-testid='stewardship-dashboard'] article",
    "[data-testid='stewardship-dashboard'] [class*='card']",
  ]);
  writeJson("test-results/audit-spectre-stewardship.json", { viewport: VIEWPORT, cards: measurements });
});
