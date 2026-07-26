// Screenshot capture for the Sprint 1 CoA Import Modal correction.
//
// Outputs to test-results/data-workspace-production/import-modal/
//   1. state-before-click-1440.png         — CoA page with focus on Import button
//   2. state-modal-empty-1440.png          — empty modal with dropzone
//   3. state-modal-drag-hover-1440.png     — dropzone in drag-active state
//   4. state-modal-selected-xlsx-1440.png  — selected .xlsx file preview
//   5. state-modal-selected-csv-1440.png   — selected .csv file preview
//   6. state-modal-invalid-1440.png        — invalid file error state
//   7. state-generic-imports-page-1440.png — generic /app/admin/imports (unchanged)

import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const BASE = "http://localhost:3000";
const OUT = "test-results/data-workspace-production/import-modal";
fs.mkdirSync(OUT, { recursive: true });

async function login(page) {
  await page.goto(`${BASE}/login`);
  await page.locator(`form:has(input[name="email"][value="super@spectre.app"]) button`).first().click();
  await page.waitForURL(/\/app/, { timeout: 20_000 });
}

const browser = await chromium.launch();
try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  await login(page);

  // 1 — CoA page, focus on Import button
  await page.goto(`${BASE}/app/admin/coa`);
  await page.waitForLoadState("networkidle");
  await page.locator("[data-testid='coa-import-btn']").hover();
  await page.screenshot({ path: path.join(OUT, "state-before-click-1440.png"), fullPage: false });

  // 2 — Modal open, empty dropzone
  await page.goto(`${BASE}/app/admin/coa?modal=import`);
  await page.waitForLoadState("networkidle");
  await page.screenshot({ path: path.join(OUT, "state-modal-empty-1440.png"), fullPage: false });

  // 3 — Drag-hover state (fabricated by adding the `on` class visually
  //     via a data attribute the CSS reads).
  await page.evaluate(() => {
    const el = document.querySelector('[data-testid="coa-import-dropzone"]');
    if (el) {
      el.classList.add("on");
      el.setAttribute("data-drag-active", "true");
    }
  });
  await page.screenshot({ path: path.join(OUT, "state-modal-drag-hover-1440.png"), fullPage: false });
  // Reset for the next capture.
  await page.evaluate(() => {
    const el = document.querySelector('[data-testid="coa-import-dropzone"]');
    if (el) {
      el.classList.remove("on");
      el.setAttribute("data-drag-active", "false");
    }
  });

  // 4 — Selected .xlsx state
  await page.locator("[data-testid='coa-import-file-input']").setInputFiles({
    name: "silver-springs-coa.xlsx",
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer: Buffer.from("PKfake-xlsx-signature-only-for-ui-test"),
  });
  await page.screenshot({ path: path.join(OUT, "state-modal-selected-xlsx-1440.png"), fullPage: false });

  // 5 — Selected .csv state (replace via Replace file button)
  await page.locator("[data-testid='coa-import-remove-file']").click();
  await page.locator("[data-testid='coa-import-file-input']").setInputFiles({
    name: "silver-springs-coa.csv",
    mimeType: "text/csv",
    buffer: Buffer.from("number,name\n1000,Petty Cash\n1001,Bank – General\n"),
  });
  await page.screenshot({ path: path.join(OUT, "state-modal-selected-csv-1440.png"), fullPage: false });

  // 6 — Invalid file state
  await page.locator("[data-testid='coa-import-remove-file']").click();
  await page.locator("[data-testid='coa-import-file-input']").setInputFiles({
    name: "photo.png",
    mimeType: "image/png",
    buffer: Buffer.from("\x89PNG\r\n\x1a\n"),
  });
  await page.screenshot({ path: path.join(OUT, "state-modal-invalid-1440.png"), fullPage: false });

  // 7 — Generic /app/admin/imports page (unchanged)
  await page.goto(`${BASE}/app/admin/imports`);
  await page.waitForLoadState("networkidle");
  await page.screenshot({ path: path.join(OUT, "state-generic-imports-page-1440.png"), fullPage: false });

  await ctx.close();
} finally {
  await browser.close();
}
console.log("done");
