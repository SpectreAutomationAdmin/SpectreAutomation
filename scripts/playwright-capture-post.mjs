// Slice 1 post-change capture + protected-surface pixel comparison.
// Every protected surface is captured post-change, then Node's crypto
// hashes the PNG bytes against the baseline. Non-flagship surfaces
// MUST hash identically. The flagship /app/admin is expected to
// differ (baseline: legacy shell, post: SpectreShell).

import { chromium } from "playwright";
import fs from "node:fs/promises";
import { createHash } from "node:crypto";

const BASE = "http://localhost:3000";
const BASELINE_DIR = "test-results/spectre-design-system/baseline";
const OUT_DIR = "test-results/spectre-design-system/post";

const VIEWPORTS = [
  { name: "1440x900", width: 1440, height: 900 },
  { name: "1920x1080", width: 1920, height: 1080 },
];

const SURFACES = [
  { name: "admin-home", url: "/app/admin", who: "admin", expectIdentical: false },
  { name: "mrp-body-may-2026", url: "/app/admin/reporting/monthly?period=2026-05", who: "admin", expectIdentical: true },
  { name: "mrp-launcher", url: "/app/admin/governance/monthly-package", who: "admin", expectIdentical: true },
  { name: "mrp-archive", url: "/app/admin/governance/monthly-package/archive", who: "admin", expectIdentical: true },
  { name: "governance-packages", url: "/app/admin/governance/packages", who: "admin", expectIdentical: true },
  { name: "pos-lounge", url: "/app/admin/ops/pos/lounge", who: "admin", expectIdentical: true },
  { name: "member-home", url: "/app/member", who: "member", expectIdentical: true },
];

async function login(page, email) {
  await page.goto(`${BASE}/login`);
  await page.locator(`form:has(input[name="email"][value="${email}"]) button`).first().click();
  await page.waitForURL(/\/app/, { timeout: 20_000 });
}

async function hashFile(p) {
  const buf = await fs.readFile(p);
  return createHash("sha256").update(buf).digest("hex");
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  const browser = await chromium.launch({ headless: true });

  const results = [];

  for (const vp of VIEWPORTS) {
    const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
    const page = await context.newPage();
    await login(page, "admin@silversprings.club");

    for (const s of SURFACES.filter((x) => x.who === "admin")) {
      await page.goto(`${BASE}${s.url}`);
      await page.waitForLoadState("networkidle", { timeout: 30_000 });
      await page.waitForTimeout(300);
      const outPath = `${OUT_DIR}/${vp.name}-${s.name}.png`;
      await page.screenshot({ path: outPath, fullPage: true });
      const baselinePath = `${BASELINE_DIR}/${vp.name}-${s.name}.png`;
      const [baseHash, postHash] = await Promise.all([hashFile(baselinePath), hashFile(outPath)]);
      const identical = baseHash === postHash;
      results.push({
        viewport: vp.name,
        surface: s.name,
        url: s.url,
        identical,
        expectIdentical: s.expectIdentical,
        pass: identical === s.expectIdentical,
        baselineHash: baseHash.slice(0, 12),
        postHash: postHash.slice(0, 12),
      });
    }
    await context.close();

    const mCtx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
    const mPage = await mCtx.newPage();
    await login(mPage, "member@silversprings.club");
    for (const s of SURFACES.filter((x) => x.who === "member")) {
      await mPage.goto(`${BASE}${s.url}`);
      await mPage.waitForLoadState("networkidle", { timeout: 30_000 });
      await mPage.waitForTimeout(300);
      const outPath = `${OUT_DIR}/${vp.name}-${s.name}.png`;
      await mPage.screenshot({ path: outPath, fullPage: true });
      const baselinePath = `${BASELINE_DIR}/${vp.name}-${s.name}.png`;
      const [baseHash, postHash] = await Promise.all([hashFile(baselinePath), hashFile(outPath)]);
      const identical = baseHash === postHash;
      results.push({
        viewport: vp.name,
        surface: s.name,
        url: s.url,
        identical,
        expectIdentical: s.expectIdentical,
        pass: identical === s.expectIdentical,
        baselineHash: baseHash.slice(0, 12),
        postHash: postHash.slice(0, 12),
      });
    }
    await mCtx.close();
  }

  // Flagship interior check — enumerate KPI tiles, applications table,
  // quick actions on the new admin home.
  const flagshipCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const flagship = await flagshipCtx.newPage();
  await login(flagship, "admin@silversprings.club");
  await flagship.goto(`${BASE}/app/admin`);
  await flagship.waitForLoadState("networkidle", { timeout: 30_000 });
  const shellPresent = await flagship.locator('[data-testid="spectre-shell"]').count();
  const kpiCount = await flagship.locator('[data-testid="spectre-kpi-tile"]').count();
  const identityPresent = await flagship.locator('[data-testid="spectre-club-identity-panel"]').count();
  const pageHeaderPresent = await flagship.locator('[data-testid="spectre-page-header"]').count();
  const recentAppsPresent = await flagship.locator('[data-testid="admin-dashboard-recent-applications"]').count();
  const sidebar = await flagship.locator('[data-testid="spectre-sidebar"]').count();
  const topbar = await flagship.locator('[data-testid="spectre-topbar"]').count();
  // Read all KPI tile labels + values for the report block.
  const kpiRead = [];
  const kpiTiles = flagship.locator('[data-testid="spectre-kpi-tile"]');
  const kn = await kpiTiles.count();
  for (let i = 0; i < kn; i++) {
    const el = kpiTiles.nth(i);
    kpiRead.push((await el.innerText()).replace(/\n/g, " | "));
  }
  await flagshipCtx.close();

  await browser.close();

  console.log("\n=== Slice 1 verification ===\n");
  for (const r of results) {
    const tag = r.pass ? "  OK  " : " FAIL ";
    const dir = r.expectIdentical ? "must be IDENTICAL to baseline" : "MUST DIFFER from baseline (flagship migration)";
    console.log(`${tag} ${r.viewport}  ${r.surface.padEnd(24)}  ${r.identical ? "identical" : "differs"}  (${dir})  ${r.url}`);
  }

  console.log("\n=== Flagship interior structure ===");
  console.log(`  SpectreShell mounted:             ${shellPresent === 1 ? "YES" : "NO"}`);
  console.log(`  SpectreSidebar mounted:           ${sidebar === 1 ? "YES" : "NO"}`);
  console.log(`  SpectreTopBar mounted:            ${topbar === 1 ? "YES" : "NO"}`);
  console.log(`  ClubIdentityPanel present:        ${identityPresent === 1 ? "YES" : "NO"}`);
  console.log(`  PageHeader present:               ${pageHeaderPresent === 1 ? "YES" : "NO"}`);
  console.log(`  Recent applications table:        ${recentAppsPresent === 1 ? "YES" : "NO"}`);
  console.log(`  KPI tile count:                   ${kpiCount} (expected 8)`);
  console.log("\n  KPI tiles read:");
  kpiRead.forEach((t, i) => console.log(`    ${i + 1}. ${t}`));

  const failed = results.filter((r) => !r.pass);
  if (failed.length > 0) {
    console.log("\nFAILED:", failed.map((r) => `${r.viewport}/${r.surface}`).join(", "));
    process.exit(1);
  }
  console.log("\nAll surfaces verified.");
}

main().catch((e) => { console.error(e); process.exit(1); });
