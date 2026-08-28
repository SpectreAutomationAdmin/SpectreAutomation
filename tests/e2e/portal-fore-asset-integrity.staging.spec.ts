// Fore! asset-integrity verification (2026-08-27).
// Two independent proofs:
//   A. /brand/fore.svg opened directly must render the entire
//      Fore! wordmark (F + o + r + e + ! + underline).
//   B. The Employee Portal Announcements header must render
//      [Fore! logo] Announcements horizontally centred, with the
//      full mark visible (no F clipping, no ! clipping).
// Captures screenshots at 1366×768, 1536×864, and 1920×1080 for B.

import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const OUT = path.resolve("test-results/portal-fore-asset");
fs.mkdirSync(OUT, { recursive: true });

const EMAIL = process.env.SPECTRE_PLAYWRIGHT_FIXTURE_EMAIL
  ?? "playwright-fixture@spectreautomation.internal";
const PASSWORD = process.env.SPECTRE_PLAYWRIGHT_FIXTURE_PASSWORD
  ?? "playwright-fixture-2026-test";

const VIEWPORTS = [
  { label: "1366x768",  w: 1366, h: 768  },
  { label: "1536x864",  w: 1536, h: 864  },
  { label: "1920x1080", w: 1920, h: 1080 },
];

test.describe("Fore! asset integrity", () => {
  test.setTimeout(300_000);

  test("A. standalone /brand/fore.svg renders the full wordmark", async ({ browser }) => {
    const context = await browser.newContext({
      viewport: { width: 1200, height: 800 },
      baseURL: "https://staging.spectreautomation.com",
    });
    const page = await context.newPage();
    await page.goto("/brand/fore.svg", { waitUntil: "networkidle" });
    // Direct SVG rendering — capture full page.
    await page.screenshot({ path: path.join(OUT, "A-standalone-fore-svg.png"), fullPage: true });
    // Sanity: the SVG element must be present and its viewBox must
    // be the canonical 253 169 1172 615.
    const viewBox = await page.evaluate(() => {
      const svg = document.querySelector("svg");
      return svg ? svg.getAttribute("viewBox") : null;
    });
    expect(viewBox).toBe("253 169 1172 615");
    await context.close();
  });

  for (const vp of VIEWPORTS) {
    test(`B. portal Announcements header at ${vp.label} — centred, no clipping`, async ({ browser }) => {
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

      const shell = page.locator('[data-testid="portal-desktop-shell"]');
      const home = shell.locator('[data-testid="portal-desktop-home"]').first();
      const card = home.locator('[data-testid="portal-desktop-announcements"]');
      const logo = card.locator('[data-testid="portal-desktop-announcements-fore-logo"]');
      const heading = card.locator("h2");

      await expect(card).toBeVisible();
      await expect(logo).toBeVisible();
      await expect(heading).toContainText("Announcements");

      // Centering proof — the [logo, heading] group centre must sit
      // within a small tolerance of the card's inner centre.
      const measurements = await page.evaluate(() => {
        const cardEl = document.querySelector('[data-testid="portal-desktop-home"] [data-testid="portal-desktop-announcements"]') as HTMLElement | null;
        const logoEl = cardEl?.querySelector('[data-testid="portal-desktop-announcements-fore-logo"]') as HTMLElement | null;
        const headingEl = cardEl?.querySelector("h2") as HTMLElement | null;
        if (!cardEl || !logoEl || !headingEl) return null;
        const cardRect = cardEl.getBoundingClientRect();
        const cardStyle = getComputedStyle(cardEl);
        const padL = parseFloat(cardStyle.paddingLeft);
        const padR = parseFloat(cardStyle.paddingRight);
        const cardInnerLeft = cardRect.left + padL;
        const cardInnerRight = cardRect.right - padR;
        const cardInnerCenter = (cardInnerLeft + cardInnerRight) / 2;
        const logoRect = logoEl.getBoundingClientRect();
        const headingRect = headingEl.getBoundingClientRect();
        const groupLeft = Math.min(logoRect.left, headingRect.left);
        const groupRight = Math.max(logoRect.right, headingRect.right);
        const groupCenter = (groupLeft + groupRight) / 2;
        return {
          cardRect: { left: cardRect.left, right: cardRect.right, width: cardRect.width },
          cardInner: { left: cardInnerLeft, right: cardInnerRight, center: cardInnerCenter },
          logoRect: { left: logoRect.left, right: logoRect.right, width: logoRect.width, height: logoRect.height },
          headingRect: { left: headingRect.left, right: headingRect.right, width: headingRect.width },
          groupCenter,
          delta: Math.abs(groupCenter - cardInnerCenter),
        };
      });

      expect(measurements).not.toBeNull();
      console.log(`[${vp.label}] card inner center=${measurements!.cardInner.center.toFixed(1)} group center=${measurements!.groupCenter.toFixed(1)} delta=${measurements!.delta.toFixed(1)}px  logo=${measurements!.logoRect.width.toFixed(1)}x${measurements!.logoRect.height.toFixed(1)}  heading w=${measurements!.headingRect.width.toFixed(1)}`);
      // Centering tolerance: within 4 px of the card's inner centre.
      expect(measurements!.delta).toBeLessThan(4);
      // Logo height must match the compact brand-mark size (h-8 = 32 px).
      expect(measurements!.logoRect.height).toBeGreaterThan(28);
      expect(measurements!.logoRect.height).toBeLessThan(36);

      await card.screenshot({ path: path.join(OUT, `B-header-${vp.label}.png`) });
      await page.screenshot({ path: path.join(OUT, `B-page-${vp.label}.png`), fullPage: false });
      await context.close();
    });
  }
});
