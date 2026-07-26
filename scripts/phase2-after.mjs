// Phase 2 — after-migration capture of /app/admin/settings.
//
// Captures at every required viewport in BOTH light + dark themes, and
// re-checks the protected surfaces against the Phase 1 baseline (with
// the governance-packages `today`-driven date field known-drift
// tolerance).

import { chromium } from "playwright";
import fs from "node:fs/promises";
import { createHash } from "node:crypto";

const BASE = "http://localhost:3000";
const OUT = "test-results/phase2-settings";
const P1_BASELINE = "test-results/spectre-design-system/baseline";
const P2_BEFORE = "test-results/phase2-settings/before";

async function login(page, email) {
  await page.goto(`${BASE}/login`);
  await page.locator(`form:has(input[name="email"][value="${email}"]) button`).first().click();
  await page.waitForURL(/\/app/, { timeout: 20_000 });
}

async function setTheme(page, choice) {
  const target = choice === "dark" ? "dark" : "";
  for (let i = 0; i < 4; i++) {
    const current = await page.evaluate(() => document.documentElement.getAttribute("data-theme") ?? "");
    if (current === target) return;
    await page.locator('[data-testid="spectre-theme-toggle"]').click();
    await page.waitForTimeout(300);
  }
}

async function hashFile(p) {
  try { const buf = await fs.readFile(p); return createHash("sha256").update(buf).digest("hex"); }
  catch { return null; }
}

const VIEWPORTS = [
  { name: "1440x900", w: 1440, h: 900 },
  { name: "1920x1080", w: 1920, h: 1080 },
  { name: "1024x768", w: 1024, h: 768 },
  { name: "768x1024", w: 768, h: 1024 },
  { name: "390x844", w: 390, h: 844 },
];

const PROTECTED = [
  { name: "admin-home", url: "/app/admin", who: "admin", knownDrift: false },
  { name: "mrp-body-may-2026", url: "/app/admin/reporting/monthly?period=2026-05", who: "admin", knownDrift: false },
  { name: "mrp-launcher", url: "/app/admin/governance/monthly-package", who: "admin", knownDrift: false },
  { name: "mrp-archive", url: "/app/admin/governance/monthly-package/archive", who: "admin", knownDrift: false },
  { name: "governance-packages", url: "/app/admin/governance/packages", who: "admin", knownDrift: true },
  { name: "pos-lounge", url: "/app/admin/ops/pos/lounge", who: "admin", knownDrift: false },
  { name: "member-home", url: "/app/member", who: "member", knownDrift: false },
  // Sub-routes of /app/admin/settings — must remain on the LEGACY
  // chrome because they were declared out of scope for Phase 2. The
  // AdminShell exact-URL entry enforces this.
  { name: "settings-domains", url: "/app/admin/settings/domains", who: "admin", knownDrift: false },
  { name: "settings-pos-printers", url: "/app/admin/settings/pos-printers", who: "admin", knownDrift: false },
];

async function main() {
  await fs.mkdir(`${OUT}/after`, { recursive: true });
  const browser = await chromium.launch({ headless: true });

  // 1. Settings — every viewport × both themes
  for (const vp of VIEWPORTS) {
    for (const theme of ["light", "dark"]) {
      const ctx = await browser.newContext({ viewport: { width: vp.w, height: vp.h }, deviceScaleFactor: 2 });
      const page = await ctx.newPage();
      await login(page, "admin@silversprings.club");
      await page.goto(`${BASE}/app/admin/settings`);
      await page.waitForLoadState("networkidle", { timeout: 30_000 });
      await setTheme(page, theme);
      await page.evaluate(async () => { if ("fonts" in document) await document.fonts.ready; });
      await page.waitForTimeout(400);
      const out = `${OUT}/after/settings-${theme}-${vp.name}.png`;
      await page.screenshot({ path: out, fullPage: true });
      console.log(`  after: ${out}`);
      await ctx.close();
    }
  }

  // 2. Protected surfaces
  const results = [];
  const size = { name: "1440x900", w: 1440, h: 900 };
  const adminCtx = await browser.newContext({ viewport: { width: size.w, height: size.h } });
  const adminPage = await adminCtx.newPage();
  await login(adminPage, "admin@silversprings.club");
  for (const s of PROTECTED.filter((p) => p.who === "admin")) {
    await adminPage.goto(`${BASE}${s.url}`);
    await adminPage.waitForLoadState("networkidle", { timeout: 30_000 });
    await adminPage.waitForTimeout(300);
    const outPath = `${OUT}/after/protected-${size.name}-${s.name}.png`;
    await adminPage.screenshot({ path: outPath, fullPage: true });
    // Prefer Phase-2 BEFORE baseline (fresh today) over Phase-1
    // baseline for surfaces with known clock drift.
    const beforePath = `${P2_BEFORE}/protected-${size.name}-${s.name}.png`;
    const p1Path = `${P1_BASELINE}/${size.name}-${s.name}.png`;
    const preferredBase = await hashFile(beforePath) ? beforePath : p1Path;
    const baseHash = await hashFile(preferredBase);
    const nowHash = await hashFile(outPath);
    const identical = baseHash && nowHash && baseHash === nowHash;
    results.push({ surface: s.name, identical, base: baseHash?.slice(0, 12) ?? "MISS", now: nowHash?.slice(0, 12) ?? "?", from: preferredBase });
  }
  await adminCtx.close();

  const mCtx = await browser.newContext({ viewport: { width: size.w, height: size.h } });
  const mPage = await mCtx.newPage();
  await login(mPage, "member@silversprings.club");
  for (const s of PROTECTED.filter((p) => p.who === "member")) {
    await mPage.goto(`${BASE}${s.url}`);
    await mPage.waitForLoadState("networkidle", { timeout: 30_000 });
    await mPage.waitForTimeout(300);
    const outPath = `${OUT}/after/protected-${size.name}-${s.name}.png`;
    await mPage.screenshot({ path: outPath, fullPage: true });
    const beforePath = `${P2_BEFORE}/protected-${size.name}-${s.name}.png`;
    const p1Path = `${P1_BASELINE}/${size.name}-${s.name}.png`;
    const preferredBase = await hashFile(beforePath) ? beforePath : p1Path;
    const baseHash = await hashFile(preferredBase);
    const nowHash = await hashFile(outPath);
    const identical = baseHash && nowHash && baseHash === nowHash;
    results.push({ surface: s.name, identical, base: baseHash?.slice(0, 12) ?? "MISS", now: nowHash?.slice(0, 12) ?? "?", from: preferredBase });
  }
  await mCtx.close();

  await browser.close();

  console.log("\n=== Protected surfaces vs baseline ===");
  for (const r of results) console.log(`  ${r.identical ? "OK  " : "DIFF"}  ${r.surface.padEnd(24)}  base=${r.base}  now=${r.now}`);
  const failed = results.filter((r) => !r.identical);
  if (failed.length > 0) {
    console.error(`${failed.length} protected surface(s) drifted.`);
    process.exit(1);
  }
  console.log("\nAll protected surfaces pixel-identical vs the pre-migration baseline.");
}

main().catch((e) => { console.error(e); process.exit(1); });
