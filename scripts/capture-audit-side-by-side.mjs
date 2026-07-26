// Sprint 1 reopen — capture concept and production at IDENTICAL
// viewport dimensions for side-by-side visual audit. No measurements;
// only pixels.

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

const shots = [
  { name: "1440-empty",  w: 1440, h: 900,  density: "standard", conceptHash: "",         prodPath: "/app/admin/coa" },
  { name: "1920-empty",  w: 1920, h: 1080, density: "standard", conceptHash: "",         prodPath: "/app/admin/coa" },
  { name: "1440-selected", w: 1440, h: 900, density: "standard", conceptHash: "#select=1010", prodPath: "/app/admin/coa" },
  { name: "1440-comfy",  w: 1440, h: 900,  density: "comfortable", conceptHash: "#density=comfortable", prodPath: "/app/admin/coa" },
  { name: "1440-compact",w: 1440, h: 900,  density: "compact",     conceptHash: "#density=compact",     prodPath: "/app/admin/coa" },
];

const browser = await chromium.launch();
try {
  for (const shot of shots) {
    // Concept
    const cCtx = await browser.newContext({ viewport: { width: shot.w, height: shot.h }, deviceScaleFactor: 2 });
    const cPage = await cCtx.newPage();
    await cPage.goto(conceptUrl + shot.conceptHash);
    await cPage.waitForLoadState("networkidle");
    await cPage.waitForTimeout(150);
    const cOut = `${OUT}/concept-${shot.name}.png`;
    await cPage.screenshot({ path: cOut, fullPage: false });
    console.log(`captured ${cOut}`);
    await cCtx.close();

    // Production
    const pCtx = await browser.newContext({ viewport: { width: shot.w, height: shot.h }, deviceScaleFactor: 2 });
    const pPage = await pCtx.newPage();
    await pPage.addInitScript((d) => { try { window.localStorage.setItem("spectre-dw-coa-density", d); } catch {} }, shot.density);
    await login(pPage, "super@spectre.app");
    // For "selected" state, we need to first find an account id, then re-navigate.
    if (shot.name.includes("selected")) {
      await pPage.goto(`${BASE}${shot.prodPath}`);
      await pPage.waitForLoadState("networkidle");
      const id = await pPage.locator("tr[data-account-id]").first().getAttribute("data-account-id");
      await pPage.goto(`${BASE}${shot.prodPath}?select=${id}`);
    } else {
      await pPage.goto(`${BASE}${shot.prodPath}`);
    }
    await pPage.waitForLoadState("networkidle");
    await pPage.waitForTimeout(200);
    const pOut = `${OUT}/production-${shot.name}.png`;
    await pPage.screenshot({ path: pOut, fullPage: false });
    console.log(`captured ${pOut}`);
    await pCtx.close();
  }
} finally { await browser.close(); }
