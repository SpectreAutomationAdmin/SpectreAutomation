// HR mobile-hotfix (2026-08-28) — mobile vertical geometry gate.
// Signs into staging with the synthetic Playwright fixture employee
// (NOT Chris) at 3 representative iPhone viewports and:
//   * captures bounding boxes of hero / welcome / grid / quick links /
//     bottom nav
//   * asserts the vertical order: each element ends at or before the
//     next begins
//   * asserts nothing extends past the visual viewport bottom
//   * measures the "unused gap" between quickLinks.bottom and
//     bottomNav.top and asserts it stays within a bounded range
//   * captures a full-page screenshot at each viewport
//
// Also re-asserts scrollWidth === clientWidth so the vertical rebuild
// hasn't reintroduced horizontal overflow.

import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const OUT = path.resolve("test-results/portal-mobile-vertical");
fs.mkdirSync(OUT, { recursive: true });

// Synthetic fixture created on staging so Chris is no longer a
// mutable automation fixture. Credentials come from env vars with
// safe defaults matching the seeded staging value.
const EMAIL = process.env.SPECTRE_PLAYWRIGHT_FIXTURE_EMAIL
  ?? "playwright-fixture@spectreautomation.internal";
const PASSWORD = process.env.SPECTRE_PLAYWRIGHT_FIXTURE_PASSWORD
  ?? "playwright-fixture-2026-test";

interface Sample {
  label: string;
  width: number; height: number;
  scrollWidth: number; clientWidth: number;
  vvHeight: number | null;
  hero: DOMRect | null;
  welcome: DOMRect | null;
  gridRegion: DOMRect | null;
  quickLinks: DOMRect | null;
  bottomNav: DOMRect | null;
  gapQuickToNav: number | null;
}

const VIEWPORTS: Array<{ label: string; width: number; height: number }> = [
  { label: "short-iphone-se",     width: 375, height: 667 },
  { label: "medium-iphone-14",    width: 390, height: 844 },
  { label: "tall-iphone-14-pro",  width: 393, height: 852 },
  { label: "large-iphone-14-pro-max", width: 430, height: 932 },
];

test.describe("Mobile portal — vertical geometry gate", () => {
  test.setTimeout(300_000);

  for (const vp of VIEWPORTS) {
    test(`${vp.label} — ${vp.width}×${vp.height} vertical order + no horiz overflow`, async ({ browser }) => {
      const context = await browser.newContext({
        viewport: { width: vp.width, height: vp.height },
        isMobile: true, hasTouch: true,
        baseURL: "https://staging.spectreautomation.com",
      });
      const page = await context.newPage();
      await page.goto("/employee/login");
      await page.locator('[data-testid="employee-login-email"]').fill(EMAIL);
      await page.locator('[data-testid="employee-login-password"]').fill(PASSWORD);
      await page.locator('[data-testid="employee-login-submit"]').click();
      await page.waitForURL(/\/employee(?!\/login)/, { timeout: 30_000 });
      // Dismiss the first-login guided tour if it opens. Persists to
      // `portalTourCompletedAt` on the fixture so subsequent runs land
      // straight on portal-home.
      await page.evaluate(async () => {
        try { await fetch("/api/employee/tour-completed", { method: "POST" }); } catch {}
      });
      // Reload so the SSR check sees portalTourCompletedAt != null.
      await page.reload({ waitUntil: "domcontentloaded" });
      await expect(page.locator('[data-testid="portal-mobile-shell"] [data-testid="portal-home"]')).toBeVisible({ timeout: 15_000 });
      await page.waitForTimeout(1500);

      const s: Sample = await page.evaluate((label) => {
        // All selectors are scoped to the mobile shell — the layout
        // renders both mobile and desktop shells side-by-side, with
        // desktop hidden via display:none on <md widths. Without the
        // scope, querySelector picks the display:none copy (rect
        // 0×0), producing bogus geometry measurements.
        const shell = document.querySelector('[data-testid="portal-mobile-shell"]');
        function rectIn(sel: string): DOMRect | null {
          const el = (shell ?? document).querySelector(sel) as HTMLElement | null;
          return el ? el.getBoundingClientRect() : null;
        }
        const hero = rectIn('[data-testid="portal-hero"]');
        const welcome = rectIn('[data-testid="portal-mobile-welcome-banner"]');
        const gridRegion = rectIn('[data-testid="portal-mobile-widgets-region"]');
        const quickLinks = rectIn('[data-testid="portal-mobile-quick-links"]');
        const bottomNav = rectIn('[data-testid="portal-mobile-bottom-nav"]');
        return {
          label,
          width: window.innerWidth,
          height: window.innerHeight,
          scrollWidth: document.documentElement.scrollWidth,
          clientWidth: document.documentElement.clientWidth,
          vvHeight: window.visualViewport?.height ?? null,
          hero, welcome, gridRegion, quickLinks, bottomNav,
          gapQuickToNav: quickLinks && bottomNav ? Math.round(bottomNav.top - quickLinks.bottom) : null,
        };
      }, vp.label);

      console.log(`[${vp.label} ${vp.width}×${vp.height}]`);
      console.log(`  window: ${s.width}×${s.height}  vvH=${s.vvHeight}  scrollW=${s.scrollWidth} clientW=${s.clientWidth}`);
      console.log(`  hero:       ${s.hero ? `${Math.round(s.hero.top)}→${Math.round(s.hero.bottom)}  h=${Math.round(s.hero.height)}` : "n/a"}`);
      console.log(`  welcome:    ${s.welcome ? `${Math.round(s.welcome.top)}→${Math.round(s.welcome.bottom)}  h=${Math.round(s.welcome.height)}` : "n/a"}`);
      console.log(`  gridReg:    ${s.gridRegion ? `${Math.round(s.gridRegion.top)}→${Math.round(s.gridRegion.bottom)}  h=${Math.round(s.gridRegion.height)}` : "n/a"}`);
      console.log(`  quickLinks: ${s.quickLinks ? `${Math.round(s.quickLinks.top)}→${Math.round(s.quickLinks.bottom)}  h=${Math.round(s.quickLinks.height)}` : "n/a"}`);
      console.log(`  bottomNav:  ${s.bottomNav ? `${Math.round(s.bottomNav.top)}→${Math.round(s.bottomNav.bottom)}  h=${Math.round(s.bottomNav.height)}` : "n/a"}`);
      console.log(`  gapQuickToNav=${s.gapQuickToNav}px`);

      // Horizontal regression check.
      expect(s.scrollWidth).toBe(s.clientWidth);

      // All primary regions must be present.
      expect(s.hero).not.toBeNull();
      expect(s.welcome).not.toBeNull();
      expect(s.gridRegion).not.toBeNull();
      expect(s.quickLinks).not.toBeNull();
      expect(s.bottomNav).not.toBeNull();

      // Vertical order: each region ends at or before the next begins
      // (small overlap tolerance for anti-aliasing).
      const TOL = 2;
      expect(s.hero!.bottom).toBeLessThanOrEqual(s.welcome!.top + TOL);
      expect(s.welcome!.bottom).toBeLessThanOrEqual(s.gridRegion!.top + TOL);
      expect(s.gridRegion!.bottom).toBeLessThanOrEqual(s.quickLinks!.top + TOL);
      expect(s.quickLinks!.bottom).toBeLessThanOrEqual(s.bottomNav!.top + TOL);

      // Bottom nav sits on the viewport bottom (± safe-area).
      expect(s.bottomNav!.bottom).toBeLessThanOrEqual(vp.height + TOL);

      // Unused gap between Quick Links and bottom nav — the whole
      // point of the dvh grid rebuild. Bounded to a reasonable range
      // even on tall phones.
      expect(s.gapQuickToNav).not.toBeNull();
      expect(s.gapQuickToNav!).toBeGreaterThanOrEqual(0);
      // Founder standard: not "hundreds of pixels" — cap at ~80 even
      // on 430×932 large phones.
      expect(s.gapQuickToNav!).toBeLessThanOrEqual(80);

      await page.screenshot({ path: path.join(OUT, `${vp.label}-${vp.width}x${vp.height}.png`), fullPage: false });
      await context.close();
    });
  }
});
