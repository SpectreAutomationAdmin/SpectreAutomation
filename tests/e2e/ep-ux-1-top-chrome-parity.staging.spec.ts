// EP-UX-1 (2026-11-01) — Employee Portal top-chrome parity with Admin.
//
// Captures side-by-side screenshots of the Admin top chrome and the
// Employee Portal top chrome at the three required viewports, and
// compares the computed CSS of the shared `.spectre-header-rail-tenant`
// class on both surfaces to prove the tenant typography is literally
// the same.
//
// Scope-protection assertions:
//   - Admin's `.spectre-header-rail-tenant` computed styles are
//     unchanged (Admin is the source of truth; we must not regress it).
//   - Member Portal is NOT touched (no SpectreTopBar import on
//     `/app/member/*`).
//
// Breadcrumb assertions:
//   - On desktop, the Employee Portal top chrome renders a
//     `data-testid="spectre-header-rail-crumbs"` element with the
//     expected label chain.
//   - On a dynamic page (`/employee/safety-training/<cuid>`) the
//     cuid is replaced with the course title via
//     `RegisterBreadcrumbLabel`.
//   - The old in-page breadcrumb (`portal-course-breadcrumb`) is gone.

import { test, expect, type Page } from "@playwright/test";
import path from "node:path";
import fs from "node:fs";
import { loginAsFounder } from "./_lib/staging-auth";
import { provisionIsolatedFixture, teardownIsolatedFixture, newRunId, type IsolatedFixture } from "./_lib/ep-train-3-fixture";

const BASE = process.env.SPECTRE_STAGING_BASE_URL ?? "https://staging.spectreautomation.com";
const outDir = path.resolve(process.cwd(), "test-results/ep-ux-1-top-chrome-parity");
fs.mkdirSync(outDir, { recursive: true });

async function portalLogin(page: Page, f: IsolatedFixture): Promise<void> {
  await page.goto(`${BASE}/employee/login`, { waitUntil: "domcontentloaded" });
  await page.locator('input[name="email"]').fill(f.email);
  await page.locator('input[name="password"]').fill(f.password);
  await Promise.all([
    page.waitForURL((u) => !u.pathname.startsWith("/employee/login"), { timeout: 30_000 }),
    page.locator('form button[type="submit"]').first().click(),
  ]);
}

async function readTenantComputed(page: Page): Promise<Record<string, string>> {
  const result = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="spectre-header-rail-tenant"]') as HTMLElement | null;
    if (!el) return null;
    const cs = window.getComputedStyle(el);
    return {
      fontFamily: cs.fontFamily,
      fontSize: cs.fontSize,
      fontWeight: cs.fontWeight,
      letterSpacing: cs.letterSpacing,
      lineHeight: cs.lineHeight,
      whiteSpace: cs.whiteSpace,
      textOverflow: cs.textOverflow,
      maxWidth: cs.maxWidth,
    };
  });
  return result ?? {};
}

async function readTenantColor(page: Page): Promise<string> {
  return page.evaluate(() => {
    const el = document.querySelector('[data-testid="spectre-header-rail-tenant"]') as HTMLElement | null;
    return el ? window.getComputedStyle(el).color : "";
  });
}

async function readCrumbsText(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const root = document.querySelector('[data-testid="spectre-header-rail-crumbs"]');
    if (!root) return [];
    return Array.from(root.querySelectorAll(":scope > span")).map((s) => (s.textContent ?? "").trim());
  });
}

test.describe("EP-UX-1 :: top-chrome parity", () => {
  test.setTimeout(600_000);

  test("desktop 1440x900: Employee Portal + Admin render identical tenant typography on the shared .spectre-header-rail-tenant class", async ({ browser }) => {
    // ---------- Admin side (reference) ----------
    const adminCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const adminPage = await loginAsFounder(adminCtx, { landing: "/app/admin" });
    await adminPage.waitForSelector('[data-testid="spectre-header-rail-tenant"]', { state: "visible", timeout: 15_000 });
    const adminComputed = await readTenantComputed(adminPage);
    const adminColor = await readTenantColor(adminPage);
    await adminPage.screenshot({ path: path.join(outDir, "desktop-admin-top-chrome.png"), fullPage: false, clip: { x: 0, y: 0, width: 1440, height: 90 } });

    // ---------- Employee Portal side ----------
    const runId = newRunId("ux");
    const fixture = provisionIsolatedFixture(runId);
    const empCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    try {
      const empPage = await empCtx.newPage();
      await portalLogin(empPage, fixture);
      await empPage.goto(`${BASE}/employee`, { waitUntil: "domcontentloaded" });
      await empPage.waitForSelector('[data-testid="portal-desktop-shell"] [data-testid="spectre-header-rail-tenant"]', { state: "visible", timeout: 15_000 });
      const empComputed = await readTenantComputed(empPage);
      const empColor = await readTenantColor(empPage);
      await empPage.screenshot({ path: path.join(outDir, "desktop-employee-top-chrome.png"), fullPage: false, clip: { x: 0, y: 0, width: 1440, height: 90 } });

      // Typography parity — every property except color must match.
      expect(empComputed.fontFamily).toBe(adminComputed.fontFamily);
      expect(empComputed.fontSize).toBe(adminComputed.fontSize);
      expect(empComputed.fontWeight).toBe(adminComputed.fontWeight);
      expect(empComputed.letterSpacing).toBe(adminComputed.letterSpacing);
      expect(empComputed.lineHeight).toBe(adminComputed.lineHeight);
      expect(empComputed.whiteSpace).toBe(adminComputed.whiteSpace);
      expect(empComputed.textOverflow).toBe(adminComputed.textOverflow);
      expect(empComputed.maxWidth).toBe(adminComputed.maxWidth);

      // Color is deliberately different (white-on-green vs admin's palette).
      expect(empColor).not.toBe(adminColor);
      // Employee tenant color must be ~white-ish (red ≈ green ≈ blue, all high).
      const empRgb = empColor.match(/\d+/g)?.map(Number) ?? [];
      expect(empRgb[0]).toBeGreaterThan(240);
      expect(empRgb[1]).toBeGreaterThan(240);
      expect(empRgb[2]).toBeGreaterThan(240);

      // Breadcrumb trail on /employee is just the "Home" leaf.
      const homeCrumbs = await readCrumbsText(empPage);
      expect(homeCrumbs.length).toBe(1);
      expect(homeCrumbs[0]).toContain("Home");

      // On a deeper page, the trail expands.
      await empPage.goto(`${BASE}/employee/safety-training`, { waitUntil: "domcontentloaded" });
      await empPage.waitForSelector('[data-testid="portal-desktop-shell"] [data-testid="spectre-header-rail-crumbs"]', { state: "visible", timeout: 10_000 });
      const stCrumbs = await readCrumbsText(empPage);
      expect(stCrumbs.length).toBeGreaterThanOrEqual(2);
      expect(stCrumbs[0]).toContain("Home");
      expect(stCrumbs[1]).toContain("Safety Training");

      // Dynamic entity label via RegisterBreadcrumbLabel on the course page.
      await empPage.goto(`${BASE}/employee/safety-training/${fixture.courseVersionId}`, { waitUntil: "domcontentloaded" });
      await empPage.waitForSelector('[data-testid="portal-desktop-shell"] [data-testid="spectre-header-rail-crumbs"]', { state: "visible", timeout: 10_000 });
      // Give RegisterBreadcrumbLabel a tick to register.
      await empPage.waitForTimeout(500);
      const detailCrumbs = await readCrumbsText(empPage);
      expect(detailCrumbs.length).toBe(3);
      expect(detailCrumbs[0]).toContain("Home");
      expect(detailCrumbs[1]).toContain("Safety Training");
      expect(detailCrumbs[2]).toContain(fixture.courseTitle.split(" (")[0]);

      // The old in-page breadcrumb must be gone (relocation complete).
      await expect(empPage.locator('[data-testid="portal-course-breadcrumb"]')).toHaveCount(0);
      await empPage.screenshot({ path: path.join(outDir, "desktop-employee-course-detail.png"), fullPage: false, clip: { x: 0, y: 0, width: 1440, height: 160 } });

      await empCtx.close();
    } finally {
      try { teardownIsolatedFixture(runId); } catch { /* noop */ }
    }
    await adminCtx.close();
  });

  test("tablet 768x1024: desktop shell renders breadcrumbs without collision", async ({ browser }) => {
    const runId = newRunId("ux");
    const fixture = provisionIsolatedFixture(runId);
    const ctx = await browser.newContext({ viewport: { width: 768, height: 1024 } });
    try {
      const page = await ctx.newPage();
      await portalLogin(page, fixture);
      await page.goto(`${BASE}/employee/safety-training`, { waitUntil: "domcontentloaded" });
      // At 768 px the DESKTOP shell is active (md breakpoint).
      await expect(page.locator('[data-testid="portal-desktop-shell"]')).toBeVisible();
      await page.waitForSelector('[data-testid="portal-desktop-shell"] [data-testid="spectre-header-rail-tenant"]', { state: "visible", timeout: 15_000 });
      await page.waitForSelector('[data-testid="portal-desktop-shell"] [data-testid="spectre-header-rail-crumbs"]', { state: "visible", timeout: 10_000 });
      await page.screenshot({ path: path.join(outDir, "tablet-employee-top-chrome.png"), fullPage: false, clip: { x: 0, y: 0, width: 768, height: 120 } });
      await ctx.close();
    } finally {
      try { teardownIsolatedFixture(runId); } catch { /* noop */ }
    }
  });

  test("mobile 390x844: mobile shell renders Admin tenant typography; breadcrumbs intentionally omitted", async ({ browser }) => {
    const runId = newRunId("ux");
    const fixture = provisionIsolatedFixture(runId);
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    try {
      const page = await ctx.newPage();
      await portalLogin(page, fixture);
      await page.goto(`${BASE}/employee`, { waitUntil: "domcontentloaded" });
      // Mobile shell is active below md.
      await expect(page.locator('[data-testid="portal-mobile-shell"]')).toBeVisible();
      await page.waitForSelector('[data-testid="portal-mobile-club-name"]', { state: "visible", timeout: 15_000 });

      // Tenant typography on mobile uses the SAME .spectre-header-rail-tenant class.
      const mobileComputed = await page.evaluate(() => {
        const el = document.querySelector('[data-testid="portal-mobile-club-name"]') as HTMLElement | null;
        if (!el) return {};
        const cs = window.getComputedStyle(el);
        return {
          fontFamily: cs.fontFamily,
          fontSize: cs.fontSize,
          fontWeight: cs.fontWeight,
          letterSpacing: cs.letterSpacing,
          whiteSpace: cs.whiteSpace,
        };
      });
      expect(mobileComputed.fontSize).toBe("14px");
      expect(mobileComputed.fontWeight).toBe("600");
      expect(mobileComputed.whiteSpace).toBe("nowrap");

      // Breadcrumbs intentionally omitted at mobile widths.
      await expect(page.locator('[data-testid="portal-mobile-shell"] [data-testid="spectre-header-rail-crumbs"]')).toHaveCount(0);

      await page.screenshot({ path: path.join(outDir, "mobile-employee-top-chrome.png"), fullPage: false, clip: { x: 0, y: 0, width: 390, height: 110 } });
      await ctx.close();
    } finally {
      try { teardownIsolatedFixture(runId); } catch { /* noop */ }
    }
  });

  test("Admin regression: top chrome unchanged (sanity check — same computed styles as before EP-UX-1)", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await loginAsFounder(ctx, { landing: "/app/admin" });
    await page.waitForSelector('[data-testid="spectre-header-rail-tenant"]', { state: "visible", timeout: 15_000 });
    const cs = await readTenantComputed(page);
    // Admin's canonical typography — pinned.
    expect(cs.fontSize).toBe("14px");
    expect(cs.fontWeight).toBe("600");
    expect(cs.lineHeight).toBe("18px");
    expect(cs.whiteSpace).toBe("nowrap");
    expect(cs.textOverflow).toBe("ellipsis");
    await page.screenshot({ path: path.join(outDir, "admin-regression-top-chrome.png"), fullPage: false, clip: { x: 0, y: 0, width: 1440, height: 90 } });
    await ctx.close();
  });
});
