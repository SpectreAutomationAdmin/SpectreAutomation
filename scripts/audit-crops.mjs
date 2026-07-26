// Tight crops of the specific regions the founder asked about.
import { chromium } from "playwright";
import { pathToFileURL } from "node:url";
import path from "node:path";
import fs from "node:fs";

const BASE = "http://localhost:3000";
const OUT = "test-results/data-workspace-production/audit/crops";
fs.mkdirSync(OUT, { recursive: true });

async function login(page, email) {
  await page.goto(`${BASE}/login`);
  await page.locator(`form:has(input[name="email"][value="${email}"]) button`).first().click();
  await page.waitForURL(/\/app/, { timeout: 20_000 });
}

const conceptUrl = pathToFileURL(path.resolve("public/design-concepts/data-workspace/chart-of-accounts.html")).toString();

async function cropAround(page, selector, out, pad = 8) {
  const rect = await page.locator(selector).first().boundingBox();
  if (!rect) throw new Error(`No selector: ${selector}`);
  await page.screenshot({
    path: out,
    clip: {
      x: Math.max(0, rect.x - pad),
      y: Math.max(0, rect.y - pad),
      width: rect.width + pad * 2,
      height: rect.height + pad * 2,
    },
  });
}

async function cropRegion(page, x, y, width, height, out) {
  await page.screenshot({ path: out, clip: { x, y, width, height } });
}

const browser = await chromium.launch();
try {
  // Concept
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    await page.goto(conceptUrl);
    await page.waitForLoadState("networkidle");
    // Header select-all crop
    await cropAround(page, "table.dw thead th.select", `${OUT}/concept-header-select.png`, 12);
    // Three consecutive row checkboxes
    const rects = await page.locator("tr[data-account-id] td.select").evaluateAll((els) => els.slice(0, 3).map((el) => el.getBoundingClientRect()).map((r) => ({ x: r.x, y: r.y, w: r.width, h: r.height })));
    if (rects.length >= 3) {
      const minX = Math.min(...rects.map((r) => r.x));
      const minY = rects[0].y;
      const maxY = rects[2].y + rects[2].h;
      const maxW = Math.max(...rects.map((r) => r.w));
      await cropRegion(page, Math.max(0, minX - 12), Math.max(0, minY - 12), maxW + 24, (maxY - minY) + 24, `${OUT}/concept-row-checkboxes.png`);
    }
    // Inspector crop
    await cropAround(page, ".inspector", `${OUT}/concept-inspector-empty.png`, 0);
    // Table + inspector boundary
    await cropRegion(page, 900, 200, 200, 500, `${OUT}/concept-table-inspector-boundary.png`);
    await ctx.close();
  }

  // Production
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    await login(page, "super@spectre.app");
    await page.goto(`${BASE}/app/admin/coa`);
    await page.waitForLoadState("networkidle");
    await cropAround(page, "table.spectre-dw-table thead th.spectre-dw-select-cell", `${OUT}/production-header-select.png`, 12);
    const rects = await page.locator("tr[data-account-id] td.spectre-dw-select-cell").evaluateAll((els) => els.slice(0, 3).map((el) => el.getBoundingClientRect()).map((r) => ({ x: r.x, y: r.y, w: r.width, h: r.height })));
    if (rects.length >= 3) {
      const minX = Math.min(...rects.map((r) => r.x));
      const minY = rects[0].y;
      const maxY = rects[2].y + rects[2].h;
      const maxW = Math.max(...rects.map((r) => r.w));
      await cropRegion(page, Math.max(0, minX - 12), Math.max(0, minY - 12), maxW + 24, (maxY - minY) + 24, `${OUT}/production-row-checkboxes.png`);
    }
    await cropAround(page, ".spectre-dw-inspector-slot", `${OUT}/production-inspector-empty.png`, 0);
    // Table + inspector boundary — right edge of table meets left edge of aside
    const asideBox = await page.locator(".spectre-dw-inspector-slot").boundingBox();
    if (asideBox) {
      await cropRegion(page, Math.max(0, asideBox.x - 100), 240, 220, 500, `${OUT}/production-table-inspector-boundary.png`);
    }
    // Selected inspector state
    const id = await page.locator("tr[data-account-id]").first().getAttribute("data-account-id");
    await page.goto(`${BASE}/app/admin/coa?select=${id}`);
    await page.waitForLoadState("networkidle");
    await cropAround(page, ".spectre-dw-inspector-slot", `${OUT}/production-inspector-selected.png`, 0);
    await ctx.close();
  }
} finally { await browser.close(); }

console.log("done");
