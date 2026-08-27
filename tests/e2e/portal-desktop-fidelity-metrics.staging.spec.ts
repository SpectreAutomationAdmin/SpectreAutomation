// HR mobile-hotfix fidelity pass (2026-08-26) — measures the
// staging desktop portal's key visual dimensions so the closeout can
// quantify the before/after deltas requested in the founder brief.
// This is a diagnostic spec — it never fails; it prints one line per
// measurement per viewport into stdout for the closeout.

import { test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const SCREENSHOT_DIR = path.resolve("test-results/portal-desktop-fidelity");
fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

const WIDGET_KEYS = [
  "scheduling",
  "paystubs",
  "time-off",
  "documents",
  "training",
  "clocking-in-out",
  "year-end-tax-forms",
] as const;

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

      const m = await page.evaluate((keys: readonly string[]) => {
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
        // Per-widget bounding boxes + icon SVG bounding boxes.
        const perWidget = keys.map((k) => {
          const card = document.querySelector(`${shell} [data-testid="portal-desktop-widget-${k}"]`) as HTMLElement | null;
          const iconWrap = document.querySelector(`${shell} [data-testid="portal-desktop-widget-icon-${k}"]`) as HTMLElement | null;
          const iconSvg = iconWrap?.querySelector("svg") as SVGElement | null;
          const cardR = card?.getBoundingClientRect();
          const iconR = iconSvg?.getBoundingClientRect();
          return {
            key: k,
            cardW: cardR ? Math.round(cardR.width * 10) / 10 : null,
            cardH: cardR ? Math.round(cardR.height * 10) / 10 : null,
            iconW: iconR ? Math.round(iconR.width * 10) / 10 : null,
            iconH: iconR ? Math.round(iconR.height * 10) / 10 : null,
          };
        });
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
          // Footer-anchor proof: at one-screen fit, footer.bottom
          // should sit within a few px of the viewport height.
          footerBottom: footer?.bottom ?? null,
          footerTop: footer?.top ?? null,
          gridBottom: grid?.bottom ?? null,
          footerAtViewportBottom:
            footer != null && Math.abs((footer.bottom ?? 0) - window.innerHeight) <= 4,
          perWidget,
        };
      }, WIDGET_KEYS);
      console.log(`\n[${vp.label}] METRICS`);
      for (const [k, v] of Object.entries(m)) {
        if (k === "perWidget") continue;
        const rounded = typeof v === "number" ? Math.round(v * 10) / 10 : v;
        console.log(`  ${k.padEnd(24)} ${rounded}`);
      }
      console.log(`  perWidget cards + icons:`);
      for (const w of m.perWidget) {
        console.log(`    ${w.key.padEnd(22)} card ${w.cardW}×${w.cardH}  icon ${w.iconW}×${w.iconH}`);
      }
      // Full-page screenshot for visual acceptance.
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, `${vp.label}.png`), fullPage: false });
      await context.close();
    });
  }
});
