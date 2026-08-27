// HR mobile-hotfix fidelity pass (2026-08-26) — measures the
// staging desktop portal's key visual dimensions so the closeout can
// quantify the before/after deltas requested in the founder brief.
// This is a diagnostic spec — it never fails; it prints one line per
// measurement per viewport into stdout for the closeout.

import { test } from "@playwright/test";

const EMAIL = process.env.SPECTRE_PLAYWRIGHT_FIXTURE_EMAIL
  ?? "playwright-fixture@spectreautomation.internal";
const PASSWORD = process.env.SPECTRE_PLAYWRIGHT_FIXTURE_PASSWORD
  ?? "playwright-fixture-2026-test";

const VIEWPORTS = [
  { label: "1366x768",  w: 1366, h: 768 },
  { label: "1440x900",  w: 1440, h: 900 },
  { label: "1536x864",  w: 1536, h: 864 },
  { label: "1536x1024", w: 1536, h: 1024 },
  { label: "1920x1080", w: 1920, h: 1080 },
];

test.describe("Portal desktop — fidelity metrics", () => {
  test.setTimeout(180_000);

  for (const vp of VIEWPORTS) {
    test(`${vp.label} — measure`, async ({ browser }) => {
      const context = await browser.newContext({
        viewport: { width: vp.w, height: vp.h },
        baseURL: "https://staging.spectreautomation.com",
      });
      const page = await context.newPage();
      await page.goto("/employee/login");
      await page.locator('[data-testid="employee-login-email"]').fill(EMAIL);
      await page.locator('[data-testid="employee-login-password"]').fill(PASSWORD);
      await page.locator('[data-testid="employee-login-submit"]').click();
      await page.waitForURL(/\/employee(?!\/login)/, { timeout: 30_000 });
      await page.evaluate(async () => {
        try { await fetch("/api/employee/tour-completed", { method: "POST" }); } catch {}
      });
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForTimeout(1500);

      const m = await page.evaluate(() => {
        const q = (sel: string) => document.querySelector(sel) as HTMLElement | null;
        const box = (sel: string) => {
          const el = q(sel);
          return el ? el.getBoundingClientRect() : null;
        };
        const scoped = (root: string, sel: string) => {
          const r = document.querySelector(root);
          if (!r) return null;
          const el = r.querySelector(sel) as HTMLElement | null;
          return el ? el.getBoundingClientRect() : null;
        };
        const header = box('[data-testid="portal-header"]');
        const sidebar = box('[data-testid="portal-sidebar"]');
        const wordmark = box('[data-testid="portal-sidebar-wordmark"]');
        const clubName = box('[data-testid="portal-header-club-name"]');
        const helpCard = box('[data-testid="portal-sidebar-help"]');
        const shell = '[data-testid="portal-desktop-shell"] [data-testid="portal-desktop-home"]';
        const hero = scoped(shell, '[data-testid="portal-hero-desktop"]');
        const banner = scoped(shell, '[data-testid="portal-desktop-welcome-banner"]');
        const grid = scoped(shell, '[data-testid="portal-desktop-widgets-grid"]');
        const anno = scoped(shell, '[data-testid="portal-desktop-announcements"]');
        const quick = scoped(shell, '[data-testid="portal-desktop-quick-links"]');
        const footer = scoped(shell, '[data-testid="portal-desktop-footer"]');
        const firstCard = document.querySelector(`${shell} [data-testid="portal-desktop-widget-scheduling"]`) as HTMLElement | null;
        const cardRect = firstCard ? firstCard.getBoundingClientRect() : null;
        // Live weather proof — capture provenance + rendered text.
        const weatherEl = document.querySelector(`${shell} [data-testid="portal-hero-weather-desktop"]`) as HTMLElement | null;
        const weatherRect = weatherEl?.getBoundingClientRect() ?? null;
        const weatherText = weatherEl?.textContent?.trim() ?? null;
        const weatherSource = weatherEl?.getAttribute("data-weather-source") ?? null;
        return {
          headerHeight: header?.height ?? null,
          sidebarWidth: sidebar?.width ?? null,
          sidebarBottom: sidebar?.bottom ?? null,
          wordmarkHeight: wordmark?.height ?? null,
          clubNameHeight: clubName?.height ?? null,
          helpCardBottom: helpCard?.bottom ?? null,
          helpCardVisible: helpCard ? helpCard.bottom <= window.innerHeight : null,
          heroHeight: hero?.height ?? null,
          bannerHeight: banner?.height ?? null,
          gridHeight: grid?.height ?? null,
          gridWidth: grid?.width ?? null,
          annoHeight: anno?.height ?? null,
          annoWidth: anno?.width ?? null,
          quickHeight: quick?.height ?? null,
          quickWidth: quick?.width ?? null,
          footerVisible: footer !== null,
          firstCardHeight: cardRect?.height ?? null,
          firstCardWidth: cardRect?.width ?? null,
          weatherHeight: weatherRect?.height ?? null,
          weatherWidth: weatherRect?.width ?? null,
          weatherText,
          weatherSource,
          viewportH: window.innerHeight,
          viewportW: window.innerWidth,
          docScrollW: document.documentElement.scrollWidth,
          docScrollH: document.documentElement.scrollHeight,
          docClientH: document.documentElement.clientHeight,
          fitsOneScreen:
            document.documentElement.scrollHeight <= document.documentElement.clientHeight + 2,
        };
      });
      console.log(`\n[${vp.label}] METRICS`);
      for (const [k, v] of Object.entries(m)) {
        const rounded = typeof v === "number" ? Math.round(v * 10) / 10 : v;
        console.log(`  ${k.padEnd(20)} ${rounded}`);
      }
      await context.close();
    });
  }
});
