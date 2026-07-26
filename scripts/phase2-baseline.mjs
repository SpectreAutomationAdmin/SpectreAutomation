// Phase 2 — capture BEFORE state of /app/admin/settings + confirm the
// protected surfaces still match the Phase-1 baseline. This runs
// against the current tree (before we modify page.tsx).

import { chromium } from "playwright";
import fs from "node:fs/promises";
import { createHash } from "node:crypto";

const BASE = "http://localhost:3000";
const OUT = "test-results/phase2-settings";
const P1_BASELINE = "test-results/spectre-design-system/baseline";

async function login(page, email) {
  await page.goto(`${BASE}/login`);
  await page.locator(`form:has(input[name="email"][value="${email}"]) button`).first().click();
  await page.waitForURL(/\/app/, { timeout: 20_000 });
}

async function hashFile(p) {
  try { const buf = await fs.readFile(p); return createHash("sha256").update(buf).digest("hex"); }
  catch { return null; }
}

const SETTINGS_VIEWPORTS = [
  { name: "1440x900", w: 1440, h: 900 },
  { name: "1920x1080", w: 1920, h: 1080 },
  { name: "1024x768", w: 1024, h: 768 },
  { name: "768x1024", w: 768, h: 1024 },
  { name: "390x844", w: 390, h: 844 },
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
  await fs.mkdir(`${OUT}/before`, { recursive: true });
  const browser = await chromium.launch({ headless: true });

  // 1. /app/admin/settings — every viewport, before-state
  for (const vp of SETTINGS_VIEWPORTS) {
    const ctx = await browser.newContext({ viewport: { width: vp.w, height: vp.h }, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    await login(page, "admin@silversprings.club");
    await page.goto(`${BASE}/app/admin/settings`);
    await page.waitForLoadState("networkidle", { timeout: 30_000 });
    await page.waitForTimeout(300);
    const out = `${OUT}/before/settings-${vp.name}.png`;
    await page.screenshot({ path: out, fullPage: true });
    console.log(`  before: ${out}`);
    await ctx.close();
  }

  // 2. protected surfaces — must still match Phase 1 baseline
  const results = [];
  const size = { name: "1440x900", w: 1440, h: 900 };
  const adminCtx = await browser.newContext({ viewport: { width: size.w, height: size.h } });
  const adminPage = await adminCtx.newPage();
  await login(adminPage, "admin@silversprings.club");
  for (const s of PROTECTED.filter((p) => p.who === "admin")) {
    await adminPage.goto(`${BASE}${s.url}`);
    await adminPage.waitForLoadState("networkidle", { timeout: 30_000 });
    await adminPage.waitForTimeout(300);
    const outPath = `${OUT}/before/protected-${size.name}-${s.name}.png`;
    await adminPage.screenshot({ path: outPath, fullPage: true });
    const p1Hash = await hashFile(`${P1_BASELINE}/${size.name}-${s.name}.png`);
    const nowHash = await hashFile(outPath);
    const identical = p1Hash && nowHash && p1Hash === nowHash;
    results.push({ surface: s.name, identical, p1: p1Hash?.slice(0, 12) ?? "MISS", now: nowHash?.slice(0, 12) ?? "?" });
  }
  await adminCtx.close();
  const mCtx = await browser.newContext({ viewport: { width: size.w, height: size.h } });
  const mPage = await mCtx.newPage();
  await login(mPage, "member@silversprings.club");
  for (const s of PROTECTED.filter((p) => p.who === "member")) {
    await mPage.goto(`${BASE}${s.url}`);
    await mPage.waitForLoadState("networkidle", { timeout: 30_000 });
    await mPage.waitForTimeout(300);
    const outPath = `${OUT}/before/protected-${size.name}-${s.name}.png`;
    await mPage.screenshot({ path: outPath, fullPage: true });
    const p1Hash = await hashFile(`${P1_BASELINE}/${size.name}-${s.name}.png`);
    const nowHash = await hashFile(outPath);
    const identical = p1Hash && nowHash && p1Hash === nowHash;
    results.push({ surface: s.name, identical, p1: p1Hash?.slice(0, 12) ?? "MISS", now: nowHash?.slice(0, 12) ?? "?" });
  }
  await mCtx.close();

  await browser.close();

  console.log("\n=== Protected surfaces vs Phase-1 baseline (must be identical) ===");
  for (const r of results) console.log(`  ${r.identical ? "OK  " : "DIFF"}  ${r.surface.padEnd(24)}  p1=${r.p1}  now=${r.now}`);
  const failed = results.filter((r) => !r.identical);
  if (failed.length > 0) {
    console.error(`${failed.length} protected surface(s) drifted since Phase 1.`);
    process.exit(1);
  }
  console.log("\nAll protected surfaces still identical to Phase 1 baseline.");
}

main().catch((e) => { console.error(e); process.exit(1); });
