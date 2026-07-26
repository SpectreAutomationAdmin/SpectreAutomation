// Slice 1 pre-change baseline capture. Every protected surface at
// two admin viewports so Slice 1 can prove pixel identity after.

import { chromium } from "playwright";
import fs from "node:fs/promises";

const BASE = "http://localhost:3000";
const OUT_DIR = "test-results/spectre-design-system/baseline";

const VIEWPORTS = [
  { name: "1440x900", width: 1440, height: 900 },
  { name: "1920x1080", width: 1920, height: 1080 },
];

const SURFACES = [
  // The flagship — captured for BEFORE comparison.
  { name: "admin-home", url: "/app/admin", who: "admin" },
  // Protected: MRP body.
  { name: "mrp-body-may-2026", url: "/app/admin/reporting/monthly?period=2026-05", who: "admin" },
  // Protected: MRP launcher.
  { name: "mrp-launcher", url: "/app/admin/governance/monthly-package", who: "admin" },
  // Protected: MRP archive.
  { name: "mrp-archive", url: "/app/admin/governance/monthly-package/archive", who: "admin" },
  // Protected: governance packages hub.
  { name: "governance-packages", url: "/app/admin/governance/packages", who: "admin" },
  // Protected: POS lounge.
  { name: "pos-lounge", url: "/app/admin/ops/pos/lounge", who: "admin" },
  // Protected: Member home + a member sub-page.
  { name: "member-home", url: "/app/member", who: "member" },
];

async function login(page, email) {
  await page.goto(`${BASE}/login`);
  await page.locator(`form:has(input[name="email"][value="${email}"]) button`).first().click();
  await page.waitForURL(/\/app/, { timeout: 20_000 });
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  const browser = await chromium.launch({ headless: true });

  for (const vp of VIEWPORTS) {
    const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
    const page = await context.newPage();

    // One admin login covers every admin surface.
    await login(page, "admin@silversprings.club");

    for (const s of SURFACES.filter((x) => x.who === "admin")) {
      try {
        await page.goto(`${BASE}${s.url}`);
        await page.waitForLoadState("networkidle", { timeout: 30_000 });
        await page.waitForTimeout(300);
        const path = `${OUT_DIR}/${vp.name}-${s.name}.png`;
        await page.screenshot({ path, fullPage: true });
        console.log(`  captured ${path}`);
      } catch (e) {
        console.error(`  FAILED ${s.name}:`, String(e).slice(0, 200));
      }
    }
    await context.close();

    // Member surfaces via a fresh member session.
    const mCtx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
    const mPage = await mCtx.newPage();
    await login(mPage, "member@silversprings.club");
    for (const s of SURFACES.filter((x) => x.who === "member")) {
      try {
        await mPage.goto(`${BASE}${s.url}`);
        await mPage.waitForLoadState("networkidle", { timeout: 30_000 });
        await mPage.waitForTimeout(300);
        const path = `${OUT_DIR}/${vp.name}-${s.name}.png`;
        await mPage.screenshot({ path, fullPage: true });
        console.log(`  captured ${path}`);
      } catch (e) {
        console.error(`  FAILED ${s.name}:`, String(e).slice(0, 200));
      }
    }
    await mCtx.close();
  }

  await browser.close();
  console.log(`\nDONE — baselines saved to ${OUT_DIR}/`);
}

main().catch((e) => { console.error(e); process.exit(1); });
