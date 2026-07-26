// Spectre Design Language — capture the gallery + shell in both
// themes and at multiple viewports, plus every protected surface to
// prove pixel-identity vs baseline.

import { chromium } from "playwright";
import fs from "node:fs/promises";
import { createHash } from "node:crypto";

const BASE = "http://localhost:3000";
const OUT = "test-results/spectre-design-language";
const BASELINE = "test-results/spectre-design-system/baseline";

async function login(page, email) {
  await page.goto(`${BASE}/login`);
  await page.locator(`form:has(input[name="email"][value="${email}"]) button`).first().click();
  await page.waitForURL(/\/app/, { timeout: 20_000 });
}

async function setTheme(page, choice) {
  // Click the actual theme toggle button (cycles light → dark → system).
  // Reads the current React state via `data-testid`, then clicks until
  // `document.documentElement.dataset.theme` matches the target OR the
  // absence-of-attribute (light).
  const target = choice === "dark" ? "dark" : ""; // "" = attribute absent (light)
  for (let i = 0; i < 4; i++) {
    const current = await page.evaluate(() => document.documentElement.getAttribute("data-theme") ?? "");
    if (current === target) return;
    await page.locator('[data-testid="spectre-theme-toggle"]').click();
    await page.waitForTimeout(300);
  }
}

async function hashFile(p) {
  try {
    const buf = await fs.readFile(p);
    return createHash("sha256").update(buf).digest("hex");
  } catch {
    return null;
  }
}

const GALLERY_VIEWPORTS = [
  { name: "1440", w: 1440, h: 900 },
  { name: "1920", w: 1920, h: 1080 },
  { name: "768", w: 768, h: 1024 },
  { name: "375", w: 375, h: 812 },
];

const PROTECTED = [
  { name: "admin-home", url: "/app/admin", who: "admin" },
  { name: "mrp-body-may-2026", url: "/app/admin/reporting/monthly?period=2026-05", who: "admin" },
  { name: "mrp-launcher", url: "/app/admin/governance/monthly-package", who: "admin" },
  { name: "mrp-archive", url: "/app/admin/governance/monthly-package/archive", who: "admin" },
  { name: "governance-packages", url: "/app/admin/governance/packages", who: "admin" },
  { name: "pos-lounge", url: "/app/admin/ops/pos/lounge", who: "admin" },
  { name: "member-home", url: "/app/member", who: "member" },
];

async function main() {
  await fs.mkdir(OUT, { recursive: true });
  const browser = await chromium.launch({ headless: true });

  // ------------------------------------------------------------------
  // 1. Gallery — every viewport × both themes
  // ------------------------------------------------------------------
  for (const vp of GALLERY_VIEWPORTS) {
    for (const theme of ["light", "dark"]) {
      const ctx = await browser.newContext({ viewport: { width: vp.w, height: vp.h }, deviceScaleFactor: 2 });
      const page = await ctx.newPage();
      await login(page, "admin@silversprings.club");
      await page.goto(`${BASE}/app/admin/design-system`);
      await page.waitForLoadState("networkidle", { timeout: 30_000 });
      await setTheme(page, theme);
      await page.evaluate(async () => { if ("fonts" in document) await document.fonts.ready; });
      await page.waitForTimeout(400);
      const path = `${OUT}/gallery-${theme}-${vp.name}.png`;
      await page.screenshot({ path, fullPage: true });
      console.log(`  gallery ${theme} ${vp.name}: ${path}`);
      await ctx.close();
    }
  }

  // ------------------------------------------------------------------
  // 2. Shell — light + dark, 1440 only (shell shape doesn't change per viewport)
  // ------------------------------------------------------------------
  for (const theme of ["light", "dark"]) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    await login(page, "admin@silversprings.club");
    await page.goto(`${BASE}/app/admin/design-system`);
    await page.waitForLoadState("networkidle", { timeout: 30_000 });
    await setTheme(page, theme);
    await page.evaluate(async () => { if ("fonts" in document) await document.fonts.ready; });
    await page.waitForTimeout(400);
    // Above-the-fold only for shell showcase
    const path = `${OUT}/shell-${theme}.png`;
    await page.screenshot({ path, fullPage: false });
    console.log(`  shell ${theme}: ${path}`);
    await ctx.close();
  }

  // ------------------------------------------------------------------
  // 3. Protected surfaces — must remain identical to baseline
  // ------------------------------------------------------------------
  const results = [];
  const size = { name: "1440x900", w: 1440, h: 900 };

  const adminCtx = await browser.newContext({ viewport: { width: size.w, height: size.h } });
  const adminPage = await adminCtx.newPage();
  await login(adminPage, "admin@silversprings.club");
  for (const s of PROTECTED.filter((p) => p.who === "admin")) {
    await adminPage.goto(`${BASE}${s.url}`);
    await adminPage.waitForLoadState("networkidle", { timeout: 30_000 });
    await adminPage.waitForTimeout(300);
    const outPath = `${OUT}/protected-${size.name}-${s.name}.png`;
    await adminPage.screenshot({ path: outPath, fullPage: true });
    const baseHash = await hashFile(`${BASELINE}/${size.name}-${s.name}.png`);
    const nowHash = await hashFile(outPath);
    const identical = baseHash && nowHash && baseHash === nowHash;
    results.push({ surface: s.name, identical, baselineHash: baseHash?.slice(0, 12) ?? "MISSING", nowHash: nowHash?.slice(0, 12) ?? "?" });
  }
  await adminCtx.close();

  const memberCtx = await browser.newContext({ viewport: { width: size.w, height: size.h } });
  const memberPage = await memberCtx.newPage();
  await login(memberPage, "member@silversprings.club");
  for (const s of PROTECTED.filter((p) => p.who === "member")) {
    await memberPage.goto(`${BASE}${s.url}`);
    await memberPage.waitForLoadState("networkidle", { timeout: 30_000 });
    await memberPage.waitForTimeout(300);
    const outPath = `${OUT}/protected-${size.name}-${s.name}.png`;
    await memberPage.screenshot({ path: outPath, fullPage: true });
    const baseHash = await hashFile(`${BASELINE}/${size.name}-${s.name}.png`);
    const nowHash = await hashFile(outPath);
    const identical = baseHash && nowHash && baseHash === nowHash;
    results.push({ surface: s.name, identical, baselineHash: baseHash?.slice(0, 12) ?? "MISSING", nowHash: nowHash?.slice(0, 12) ?? "?" });
  }
  await memberCtx.close();

  await browser.close();

  console.log("\n=== Protected-surface pixel comparison ===");
  for (const r of results) {
    console.log(`  ${r.identical ? "OK  " : "DIFF"}  ${r.surface.padEnd(24)}  base=${r.baselineHash}  now=${r.nowHash}`);
  }
  const failed = results.filter((r) => !r.identical);
  if (failed.length > 0) {
    console.log(`\n${failed.length} protected surface(s) differ from baseline.`);
    process.exit(1);
  }
  console.log("\nAll protected surfaces pixel-identical vs baseline.");
}

main().catch((e) => { console.error(e); process.exit(1); });
