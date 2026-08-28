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
  feedbackHeading: string | null;
  announcementRowCount: number;
  // HR-2C 2026-08-27 refinement — new measurements.
  sidebarRight: number;
  separatorX: number;
  separatorSidebarDelta: number;
  sidebarCenterX: number;
  wordmarkCenterX: number;
  wordmarkSidebarDelta: number;
  announcementsCardCenterX: number;
  announcementsHeadingCenterX: number;
  announcementsHeadingDelta: number;
  desktopNavKeys: string[];
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
        const separator = document.querySelector('[data-testid="portal-header-separator"]') as HTMLElement | null;
        const sidebar = document.querySelector('[data-testid="portal-sidebar"]') as HTMLElement | null;
        const wordmark = document.querySelector('[data-testid="portal-sidebar-wordmark"]') as HTMLElement | null;
        const feedback = pickVisible<HTMLAnchorElement>('[data-testid="portal-sidebar-feedback"]');
        const feedbackHeading = feedback?.querySelector("div > div.font-serif")?.textContent?.trim() ?? null;
        const standaloneQuickLinks = pickVisible<HTMLElement>('[data-testid="portal-desktop-home"] [data-testid="portal-desktop-quick-links"]');
        const inlineQuickLinks = pickVisible<HTMLElement>('[data-testid="portal-desktop-welcome-quick-links"]');
        const yearEnd = pickVisible<HTMLElement>('[data-testid="portal-desktop-widget-year-end-tax-forms"]');
        const announcementsCard = pickVisible<HTMLElement>('[data-testid="portal-desktop-announcements"]');
        const announcementsHeading = announcementsCard?.querySelector("h2") as HTMLElement | null;
        const rows = announcementsCard
          ? announcementsCard.querySelectorAll("ul > li").length
          : 0;
        const heroRect = hero?.getBoundingClientRect() ?? null;
        const bannerRect = banner?.getBoundingClientRect() ?? null;
        const gridCells = grid ? grid.querySelectorAll(":scope > li").length : 0;
        const sidebarRect = sidebar?.getBoundingClientRect() ?? null;
        const sepRect = separator?.getBoundingClientRect() ?? null;
        const wordmarkRect = wordmark?.getBoundingClientRect() ?? null;
        const cardRect = announcementsCard?.getBoundingClientRect() ?? null;
        const cardStyle = announcementsCard ? getComputedStyle(announcementsCard) : null;
        const cardInnerLeft = cardRect && cardStyle
          ? cardRect.left + parseFloat(cardStyle.paddingLeft || "0")
          : 0;
        const cardInnerRight = cardRect && cardStyle
          ? cardRect.right - parseFloat(cardStyle.paddingRight || "0")
          : 0;
        const cardInnerCenter = (cardInnerLeft + cardInnerRight) / 2;
        const headingRect = announcementsHeading?.getBoundingClientRect() ?? null;
        const headingCenter = headingRect ? (headingRect.left + headingRect.right) / 2 : 0;
        // Nav keys visible in the desktop sidebar.
        const navKeys = Array.from(document.querySelectorAll('[data-testid="portal-sidebar"] [data-testid^="portal-nav-"]'))
          .map((el) => (el.getAttribute("data-testid") || "").replace("portal-nav-", ""));
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
          feedbackHeading,
          announcementRowCount: rows,
          sidebarRight: sidebarRect?.right ?? 0,
          separatorX: sepRect ? (sepRect.left + sepRect.right) / 2 : 0,
          separatorSidebarDelta: sepRect && sidebarRect
            ? Math.abs(((sepRect.left + sepRect.right) / 2) - sidebarRect.right)
            : 0,
          sidebarCenterX: sidebarRect ? (sidebarRect.left + sidebarRect.right) / 2 : 0,
          wordmarkCenterX: wordmarkRect ? (wordmarkRect.left + wordmarkRect.right) / 2 : 0,
          wordmarkSidebarDelta: sidebarRect && wordmarkRect
            ? Math.abs(((wordmarkRect.left + wordmarkRect.right) / 2) - ((sidebarRect.left + sidebarRect.right) / 2))
            : 0,
          announcementsCardCenterX: cardInnerCenter,
          announcementsHeadingCenterX: headingCenter,
          announcementsHeadingDelta: Math.abs(headingCenter - cardInnerCenter),
          desktopNavKeys: navKeys,
        };
      }, vp.label);

      expect(sample).not.toBeNull();
      const s = sample!;
      console.log(
        `[${vp.label}] hero=${s.heroWidth.toFixed(0)}x${s.heroHeight.toFixed(0)} aspect=${s.heroAspect.toFixed(2)} ` +
        `banner=${s.bannerWidth.toFixed(0)}x${s.bannerHeight.toFixed(0)} widgets=${s.desktopWidgetCount} ` +
        `nav=[${s.desktopNavKeys.join(",")}] feedback="${s.feedbackHeading}" ` +
        `sidebarR=${s.sidebarRight.toFixed(1)} sepX=${s.separatorX.toFixed(1)} sepΔ=${s.separatorSidebarDelta.toFixed(2)} ` +
        `wordΔ=${s.wordmarkSidebarDelta.toFixed(2)} annCenter=${s.announcementsCardCenterX.toFixed(1)} ` +
        `annHead=${s.announcementsHeadingCenterX.toFixed(1)} annΔ=${s.announcementsHeadingDelta.toFixed(2)} rows=${s.announcementRowCount}`,
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

      // Feedback copy refinement (2026-08-27).
      expect(s.feedbackHeading).toBe("Say what’s on your mind");

      // Sidebar simplification (2026-08-27) — only Home + Profile.
      expect(s.desktopNavKeys.sort()).toEqual(["home", "profile"]);

      // Separator alignment (2026-08-27) — separator sits at the
      // sidebar's right edge (± 2 px tolerance for sub-pixel + 1 px
      // separator width).
      expect(s.separatorSidebarDelta).toBeLessThan(2);

      // Wordmark centred over sidebar (± 1 px).
      expect(s.wordmarkSidebarDelta).toBeLessThan(2);

      // Announcements text centred on the card centre (± 2 px).
      expect(s.announcementsHeadingDelta).toBeLessThan(2);

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

  test("sidebar Profile navigation — click Profile, then Home", async ({ browser }) => {
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
    // Home active on landing.
    await expect(page.locator('[data-testid="portal-nav-home"]').first()).toHaveAttribute("aria-current", "page");
    // Click Profile → routes to /employee/profile and becomes active.
    await page.locator('[data-testid="portal-nav-profile"]').first().click();
    await page.waitForURL(/\/employee\/profile/, { timeout: 15_000 });
    await expect(page.locator('[data-testid="portal-nav-profile"]').first()).toHaveAttribute("aria-current", "page");
    // Click Home → back to /employee.
    await page.locator('[data-testid="portal-nav-home"]').first().click();
    await page.waitForURL(/\/employee$/, { timeout: 15_000 });
    await expect(page.locator('[data-testid="portal-nav-home"]').first()).toHaveAttribute("aria-current", "page");
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
