// Zoom in tight on a single checkbox to reveal what's actually rendering.
// Also read computed styles for the checkbox + its cell + its parent.

import { chromium } from "playwright";
import { pathToFileURL } from "node:url";
import path from "node:path";
import fs from "node:fs";

const BASE = "http://localhost:3000";
const OUT = "test-results/data-workspace-production/audit";
fs.mkdirSync(OUT, { recursive: true });

async function login(page, email) {
  await page.goto(`${BASE}/login`);
  await page.locator(`form:has(input[name="email"][value="${email}"]) button`).first().click();
  await page.waitForURL(/\/app/, { timeout: 20_000 });
}

const conceptUrl = pathToFileURL(path.resolve("public/design-concepts/data-workspace/chart-of-accounts.html")).toString();

const browser = await chromium.launch();
try {
  // Production
  const pCtx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 3 });
  const pPage = await pCtx.newPage();
  await login(pPage, "super@spectre.app");
  await pPage.goto(`${BASE}/app/admin/coa`);
  await pPage.waitForLoadState("networkidle");
  const pMeasure = await pPage.evaluate(() => {
    const el = document.querySelector("tr[data-account-id] input[type='checkbox']");
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const s = window.getComputedStyle(el);
    const parent = el.parentElement;
    const ps = parent ? window.getComputedStyle(parent) : null;
    return {
      rect: { x: r.x, y: r.y, w: r.width, h: r.height },
      appearance: s.appearance || s.webkitAppearance,
      display: s.display,
      backgroundColor: s.backgroundColor,
      background: s.background,
      border: `${s.borderTopWidth} ${s.borderTopStyle} ${s.borderTopColor}`,
      borderRadius: s.borderRadius,
      boxShadow: s.boxShadow,
      outline: s.outline,
      padding: s.padding,
      margin: s.margin,
      parentBg: ps?.backgroundColor,
      parentPadding: ps?.padding,
      parentBorder: ps?.border,
      parentBorderRadius: ps?.borderRadius,
      classNames: el.className,
      matchedRules: null, // Not accessible from evaluate
    };
  });
  await pPage.screenshot({ path: `${OUT}/production-1440-empty-fullshot.png`, fullPage: false });
  // Tight crop on the first checkbox at 3x DPR — clip in raw device pixels
  await pPage.screenshot({
    path: `${OUT}/production-checkbox-zoom.png`,
    clip: { x: 335, y: 380, width: 90, height: 170 },
  });
  console.log("PRODUCTION checkbox styles:", JSON.stringify(pMeasure, null, 2));
  await pCtx.close();

  // Concept
  const cCtx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 3 });
  const cPage = await cCtx.newPage();
  await cPage.goto(conceptUrl);
  await cPage.waitForLoadState("networkidle");
  const cMeasure = await cPage.evaluate(() => {
    const el = document.querySelector("tr[data-account-id] input[type='checkbox']");
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const s = window.getComputedStyle(el);
    return {
      rect: { x: r.x, y: r.y, w: r.width, h: r.height },
      appearance: s.appearance || s.webkitAppearance,
      display: s.display,
      backgroundColor: s.backgroundColor,
      border: `${s.borderTopWidth} ${s.borderTopStyle} ${s.borderTopColor}`,
      borderRadius: s.borderRadius,
      boxShadow: s.boxShadow,
      padding: s.padding,
      classNames: el.className,
    };
  });
  await cPage.screenshot({
    path: `${OUT}/concept-checkbox-zoom.png`,
    clip: { x: 335, y: 380, width: 90, height: 170 },
  });
  console.log("CONCEPT checkbox styles:", JSON.stringify(cMeasure, null, 2));
  await cCtx.close();
} finally { await browser.close(); }
