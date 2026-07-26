// Screenshot capture for the Sprint 1 REGRESSION repair — proof that
// every inspector state renders visibly after the layout fix.
//
// Outputs to test-results/data-workspace-production/inspector-repair/
//   1. empty-inspector-1440.png       — no selection; empty state visible
//   2. empty-inspector-crop-1440.png  — tight crop of the right pane
//   3. selected-inspector-1440.png    — ?select=<id>; populated state
//   4. selected-inspector-crop-1440.png
//   5. edit-inspector-1440.png        — ?edit=<id>; editing state
//   6. edit-inspector-crop-1440.png
//   7. checkbox-selected-1440.png     — checkbox click, empty inspector
//   8. review-hidden-1440.png         — no ?_review — panel absent
//   9. review-visible-1440.png        — ?_review=1 — panel visible

import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const BASE = "http://localhost:3000";
const OUT = "test-results/data-workspace-production/inspector-repair";
fs.mkdirSync(OUT, { recursive: true });

async function login(page) {
  await page.goto(`${BASE}/login`);
  await page.locator(`form:has(input[name="email"][value="super@spectre.app"]) button`).first().click();
  await page.waitForURL(/\/app/, { timeout: 20_000 });
}

async function cropRightPane(page, out) {
  const aside = await page.locator(".spectre-dw-inspector-slot").boundingBox();
  if (!aside) throw new Error("no aside");
  await page.screenshot({
    path: out,
    clip: { x: aside.x - 4, y: Math.max(0, aside.y - 4), width: aside.width + 8, height: aside.height + 8 },
  });
}

const browser = await chromium.launch();
try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  await login(page);

  // 1 + 2 — empty inspector state
  await page.goto(`${BASE}/app/admin/coa`);
  await page.waitForLoadState("networkidle");
  await page.screenshot({ path: path.join(OUT, "empty-inspector-1440.png"), fullPage: false });
  await cropRightPane(page, path.join(OUT, "empty-inspector-crop-1440.png"));

  // Pick an account for select/edit flows
  const firstRow = page.locator("tr[data-account-id]").first();
  const accountId = await firstRow.getAttribute("data-account-id");
  if (!accountId) throw new Error("no first account row found");

  // 3 + 4 — populated / reader mode
  await page.goto(`${BASE}/app/admin/coa?select=${accountId}`);
  await page.waitForLoadState("networkidle");
  await page.screenshot({ path: path.join(OUT, "selected-inspector-1440.png"), fullPage: false });
  await cropRightPane(page, path.join(OUT, "selected-inspector-crop-1440.png"));

  // 5 + 6 — edit mode
  await page.goto(`${BASE}/app/admin/coa?edit=${accountId}`);
  await page.waitForLoadState("networkidle");
  await page.screenshot({ path: path.join(OUT, "edit-inspector-1440.png"), fullPage: false });
  await cropRightPane(page, path.join(OUT, "edit-inspector-crop-1440.png"));

  // 7 — checkbox-selected rows, inspector still empty
  await page.goto(`${BASE}/app/admin/coa`);
  await page.waitForLoadState("networkidle");
  await page.locator("tr[data-account-id] input[type='checkbox']").first().click();
  await page.locator("tr[data-account-id] input[type='checkbox']").nth(1).click();
  await page.screenshot({ path: path.join(OUT, "checkbox-selected-1440.png"), fullPage: false });

  // 8 — Review States absent for a normal user
  await page.goto(`${BASE}/app/admin/coa`);
  await page.waitForLoadState("networkidle");
  await page.screenshot({ path: path.join(OUT, "review-hidden-1440.png"), fullPage: false });

  // 9 — Review States present with ?_review=1
  await page.goto(`${BASE}/app/admin/coa?_review=1`);
  await page.waitForLoadState("networkidle");
  await page.screenshot({ path: path.join(OUT, "review-visible-1440.png"), fullPage: false });

  await ctx.close();
} finally {
  await browser.close();
}
console.log("done");
