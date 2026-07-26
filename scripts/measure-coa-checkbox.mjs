import { chromium } from "playwright";

const BASE = "http://localhost:3000";
const browser = await chromium.launch();
try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/login`);
  await page.locator('form:has(input[name="email"][value="super@spectre.app"]) button').first().click();
  await page.waitForURL(/\/app/, { timeout: 20_000 });
  await page.goto(`${BASE}/app/admin/coa`);
  await page.waitForLoadState("networkidle");

  const info = await page.evaluate(() => {
    const headerCell = document.querySelector("table.spectre-dw-table thead th:first-child");
    const headerCheck = headerCell?.querySelector("input[type='checkbox']");
    const firstRow = document.querySelector("table.spectre-dw-table tbody tr[data-account-id]");
    const rowCell = firstRow?.querySelector("td:first-child");
    const rowCheck = rowCell?.querySelector("input[type='checkbox']");
    const gc = (el) => {
      if (!el) return null;
      const s = window.getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return {
        rect: { x: r.x.toFixed(1), y: r.y.toFixed(1), w: r.width.toFixed(1), h: r.height.toFixed(1) },
        padding: `${s.paddingTop} / ${s.paddingRight} / ${s.paddingBottom} / ${s.paddingLeft}`,
        background: s.backgroundColor,
        width: s.width,
        boxSizing: s.boxSizing,
      };
    };
    return {
      headerCell: gc(headerCell),
      headerCheck: gc(headerCheck),
      rowCell: gc(rowCell),
      rowCheck: gc(rowCheck),
    };
  });
  console.log(JSON.stringify(info, null, 2));
} finally { await browser.close(); }
