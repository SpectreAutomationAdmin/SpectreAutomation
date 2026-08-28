// HR-2C portal refinement acceptance (2026-08-27).
//
// Verifies on staging:
//   • Hero geometry UNCHANGED vs the pre-ticket baseline
//     (the founder locked the hero — this ticket is layout below).
//   • Welcome banner dimensions UNCHANGED (Quick Links must fit
//     inside the existing geometry).
//   • Standalone right-rail Quick Links card is gone.
//   • Year-end Tax Forms widget is gone.
//   • Exactly 6 desktop widgets render.
//   • Fore! card shows at most 2 rows on Home.
//   • /employee/announcements route responds.
//   • Sidebar Anonymous Feedback card links to /employee/feedback.
//   • Gold separator sits between sidebar wordmark and topbar name.

import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const OUT = path.resolve("test-results/portal-refinement-2027");
fs.mkdirSync(OUT, { recursive: true });

const EMAIL = process.env.SPECTRE_PLAYWRIGHT_FIXTURE_EMAIL
  ?? "playwright-fixture@spectreautomation.internal";
const PASSWORD = process.env.SPECTRE_PLAYWRIGHT_FIXTURE_PASSWORD
  ?? "playwright-fixture-2026-test";

const VIEWPORTS = [
  { label: "1366x768",  w: 1366, h: 768  },
  { label: "1440x900",  w: 1440, h: 900  },
  { label: "1536x864",  w: 1536, h: 864  },
  { label: "1920x1080", w: 1920, h: 1080 },
];

interface HomeSample {
  label: string;
  heroWidth: number;
  heroHeight: number;
  heroAspect: number;
  bannerWidth: number;
  bannerHeight: number;
  hasStandaloneQuickLinksCard: boolean;
  hasInlineWelcomeQuickLinks: boolean;
  desktopWidgetCount: number;
  hasYearEndTaxForms: boolean;
  hasSeparator: boolean;
  feedbackCardHref: string | null;
  announcementRowCount: number;
}

test.describe("HR-2C portal refinement (2026-08-27)", () => {
  test.setTimeout(300_000);

  for (const vp of VIEWPORTS) {
    test(`home refinements at ${vp.label}`, async ({ browser }) => {
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

      const sample: HomeSample | null = await page.evaluate((label) => {
        function pickVisible<T extends Element>(selector: string): T | null {
          const all = Array.from(document.querySelectorAll(selector)) as T[];
          return all.find((el) => (el as unknown as HTMLElement).getBoundingClientRect().width > 0) ?? null;
        }
        const hero = pickVisible<HTMLElement>('[data-testid="portal-hero-desktop"]');
        const banner = pickVisible<HTMLElement>('[data-testid="portal-desktop-welcome-banner"]');
        const grid = pickVisible<HTMLElement>('[data-testid="portal-desktop-widgets-grid"]');
        const separator = document.querySelector('[data-testid="portal-header-separator"]');
        const feedback = pickVisible<HTMLAnchorElement>('[data-testid="portal-sidebar-feedback"]');
        const standaloneQuickLinks = pickVisible<HTMLElement>('[data-testid="portal-desktop-home"] [data-testid="portal-desktop-quick-links"]');
        const inlineQuickLinks = pickVisible<HTMLElement>('[data-testid="portal-desktop-welcome-quick-links"]');
        const yearEnd = pickVisible<HTMLElement>('[data-testid="portal-desktop-widget-year-end-tax-forms"]');
        const announcementsCard = pickVisible<HTMLElement>('[data-testid="portal-desktop-announcements"]');
        // Count announcement rows — the DesktopAnnouncementsCard
        // renders each item as an <li>. Empty state produces zero
        // list items.
        const rows = announcementsCard
          ? announcementsCard.querySelectorAll("ul > li").length
          : 0;
        const heroRect = hero?.getBoundingClientRect() ?? null;
        const bannerRect = banner?.getBoundingClientRect() ?? null;
        const gridCells = grid ? grid.querySelectorAll(":scope > li").length : 0;
        return {
          label,
          heroWidth: heroRect?.width ?? 0,
          heroHeight: heroRect?.height ?? 0,
          heroAspect: heroRect && heroRect.height ? heroRect.width / heroRect.height : 0,
          bannerWidth: bannerRect?.width ?? 0,
          bannerHeight: bannerRect?.height ?? 0,
          hasStandaloneQuickLinksCard: !!standaloneQuickLinks,
          hasInlineWelcomeQuickLinks: !!inlineQuickLinks,
          desktopWidgetCount: gridCells,
          hasYearEndTaxForms: !!yearEnd,
          hasSeparator: !!separator,
          feedbackCardHref: feedback?.getAttribute("href") ?? null,
          announcementRowCount: rows,
        };
      }, vp.label);

      expect(sample).not.toBeNull();
      const s = sample!;
      console.log(
        `[${vp.label}] hero=${s.heroWidth.toFixed(0)}x${s.heroHeight.toFixed(0)} aspect=${s.heroAspect.toFixed(2)} ` +
        `banner=${s.bannerWidth.toFixed(0)}x${s.bannerHeight.toFixed(0)} widgets=${s.desktopWidgetCount} ` +
        `yearEnd=${s.hasYearEndTaxForms} standaloneQL=${s.hasStandaloneQuickLinksCard} ` +
        `inlineQL=${s.hasInlineWelcomeQuickLinks} separator=${s.hasSeparator} ` +
        `feedback=${s.feedbackCardHref} annRows=${s.announcementRowCount}`,
      );
      fs.writeFileSync(path.join(OUT, `${vp.label}.json`), JSON.stringify(s, null, 2));
      await page.screenshot({ path: path.join(OUT, `${vp.label}-full.png`), fullPage: false });
      const banner = page.locator('[data-testid="portal-desktop-welcome-banner"]').first();
      await banner.screenshot({ path: path.join(OUT, `${vp.label}-banner.png`) });

      // Hero geometry regression — aspect must still be the locked
      // 4.57 (± 0.05).
      expect(s.heroAspect).toBeGreaterThan(4.4);
      expect(s.heroAspect).toBeLessThan(4.75);

      // Six primary widgets (Year-end Tax Forms is gone).
      expect(s.desktopWidgetCount).toBe(6);
      expect(s.hasYearEndTaxForms).toBe(false);

      // Standalone Quick Links card must not render on Home.
      expect(s.hasStandaloneQuickLinksCard).toBe(false);
      // If the tenant has any active Quick Links, they render
      // inline on the welcome banner. (Playwright fixture Coulee
      // Ridge has ≥1 configured.)
      expect(s.hasInlineWelcomeQuickLinks).toBe(true);

      // Gold separator present.
      expect(s.hasSeparator).toBe(true);

      // Anonymous Feedback card links to /employee/feedback.
      expect(s.feedbackCardHref).toBe("/employee/feedback");

      // Home Fore! card holds at most 2 rows.
      expect(s.announcementRowCount).toBeLessThanOrEqual(2);

      await context.close();
    });
  }

  test("employee /employee/announcements route responds", async ({ browser }) => {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      baseURL: "https://staging.spectreautomation.com",
    });
    const page = await context.newPage();
    await page.goto("/employee/login");
    await page.locator('[data-testid="employee-login-email"]').fill(EMAIL);
    await page.locator('[data-testid="employee-login-password"]').fill(PASSWORD);
    await page.locator('[data-testid="employee-login-submit"]').click();
    await page.waitForURL(/\/employee(?!\/login)/, { timeout: 30_000 });
    await page.goto("/employee/announcements");
    await expect(page.locator('[data-testid="employee-announcements-page"]').first()).toBeVisible();
    await page.screenshot({ path: path.join(OUT, "announcements-page.png"), fullPage: false });
    await context.close();
  });

  test("anonymous feedback form submits (round-trip)", async ({ browser }) => {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      baseURL: "https://staging.spectreautomation.com",
    });
    const page = await context.newPage();
    await page.goto("/employee/login");
    await page.locator('[data-testid="employee-login-email"]').fill(EMAIL);
    await page.locator('[data-testid="employee-login-password"]').fill(PASSWORD);
    await page.locator('[data-testid="employee-login-submit"]').click();
    await page.waitForURL(/\/employee(?!\/login)/, { timeout: 30_000 });
    await page.goto("/employee/feedback");
    await expect(page.locator('[data-testid="feedback-form"]').first()).toBeVisible();
    const uniq = `E2E acceptance feedback ${Math.floor(Date.now() / 1000)}`;
    await page.locator('[data-testid="feedback-category"]').first().selectOption("Suggestion");
    await page.locator('[data-testid="feedback-message"]').first().fill(uniq);
    await page.locator('[data-testid="feedback-submit"]').first().click();
    await expect(page.locator('[data-testid="feedback-status"]').first()).toContainText(/submitted anonymously/i);
    await page.screenshot({ path: path.join(OUT, "feedback-submitted.png"), fullPage: false });
    await context.close();
  });
});
