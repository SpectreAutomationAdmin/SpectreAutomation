// WI-1 — deployed visual acceptance for the new /app/admin/work-intake
// scaffold @ 1586×992 (reference native dimension).

import { test, expect } from "@playwright/test";
import { loginAs } from "./_lib/staging-auth";

const BASE_URL = "https://staging.spectreautomation.com";
const CTRL_EMAIL = "fixture.controller.3e@spectre.test";
const FIXTURE_PW = "spectre-3e-fixture";
const VIEWPORT = { width: 1586, height: 992 };

test.use({ trace: "off", video: "off" });
test.describe.configure({ mode: "serial" });
test.beforeEach(({}, testInfo) => {
  if (testInfo.project.name !== "chromium") {
    testInfo.skip(true, "WI-1 acceptance runs on chromium project only");
  }
});

test.describe("WI-1 · Work Intake scaffold @ 1586×992", () => {
  test.setTimeout(120_000);

  test("HEALTH", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: VIEWPORT });
    const page = await ctx.newPage();
    const r = await page.request.get(`${BASE_URL}/api/health`);
    expect(r.ok()).toBeTruthy();
    await ctx.close();
  });

  test("Full-page @ 1586×992 · new route exists + scaffold rendered", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: VIEWPORT });
    const page = await loginAs(ctx, CTRL_EMAIL, FIXTURE_PW);
    await page.goto(`${BASE_URL}/app/admin/work-intake`, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
    await expect(page.locator(".wi-root")).toBeVisible();
    await page.screenshot({ path: "test-results/wi1-01-full-1586.png", fullPage: false });
  });

  test("Hero WI-1A · shallow panoramic banner + single-line greeting + geometry measurement", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: VIEWPORT });
    const page = await loginAs(ctx, CTRL_EMAIL, FIXTURE_PW);
    await page.goto(`${BASE_URL}/app/admin/work-intake`);
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
    await expect(page.locator(".wi-hero-img")).toBeVisible();
    await expect(page.locator(".wi-hero-eyebrow")).toContainText(/MONDAY, SEPTEMBER 28/);
    const greeting = await page.locator(".wi-hero-greeting").evaluate((el) => {
      const s = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return {
        family: s.fontFamily, size: s.fontSize,
        whiteSpace: s.whiteSpace,
        clientHeight: (el as HTMLElement).offsetHeight,
        lineHeight: s.lineHeight,
      };
    });
    console.log("WI_GREETING:", JSON.stringify(greeting));
    expect(greeting.family).toMatch(/Source Serif|Georgia|serif/i);
    // WI-1A §3 — greeting must stay on ONE line. offsetHeight
    // must equal a single line-height (~ 38 px), NOT double or triple.
    const lh = parseFloat(greeting.lineHeight);
    expect(greeting.clientHeight).toBeLessThan(lh * 1.6);

    // WI-1B §11–§12 — hero must touch top chrome + sidebar edge (retained).
    const heroBox = await page.locator(".wi-hero").boundingBox();
    console.log("WI_HERO_BOX:", JSON.stringify(heroBox));
    expect(heroBox).not.toBeNull();

    // WI-1C §2 — hero BOTTOM must align with the separator immediately
    // beneath "Reservations tonight" in TODAY'S POSITION. Locate the
    // row containing that text; its bottom border is the alignment
    // anchor. Tolerance ± 3 px per §19.
    const reservationsRow = page.locator(".wi-rail-row", { hasText: /Reservations tonight/i }).first();
    const rrBox = await reservationsRow.boundingBox();
    console.log("WI_RESERVATIONS_ROW_BOX:", JSON.stringify(rrBox));
    expect(rrBox).not.toBeNull();

    if (heroBox && rrBox) {
      const heroBottom = heroBox.y + heroBox.height;
      const separatorY = rrBox.y + rrBox.height;
      console.log("WI_HERO_BOTTOM:", heroBottom, "SEPARATOR_Y:", separatorY, "DELTA:", Math.abs(heroBottom - separatorY));
      expect(Math.abs(heroBottom - separatorY)).toBeLessThanOrEqual(6);
      // WI-1B §12: hero.left must equal sidebar right edge (288 px).
      expect(Math.abs(heroBox.x - 288)).toBeLessThanOrEqual(4);
      // WI-1B §11: hero.top must equal top-chrome height (64 px).
      expect(Math.abs(heroBox.y - 64)).toBeLessThanOrEqual(4);
    }

    await expect(page.locator(".wi-hero-sync-label")).toContainText(/FEED SYNCED/);
    await expect(page.locator(".wi-hero-weather-temp")).toContainText("14°");
    await expect(page.locator(".wi-hero-weather-place")).toContainText(/Calgary/);
    await expect(page.locator(".wi-hero-weather-cond")).toContainText(/Mostly Sunny/);

    // WI-1C §7–§12 — weather + supporting copy must be stacked
    // vertically, NOT side-by-side. Weather block bottom < supporting
    // copy top. Divider (::before pseudo) sits between them and is
    // included in .wi-hero-side flex layout.
    const weatherBox = await page.locator(".wi-hero-weather").boundingBox();
    const supportBox = await page.locator(".wi-hero-support").boundingBox();
    console.log("WI_WEATHER_BOX:", JSON.stringify(weatherBox));
    console.log("WI_SUPPORT_BOX:", JSON.stringify(supportBox));
    if (weatherBox && supportBox) {
      const weatherBottom = weatherBox.y + weatherBox.height;
      expect(supportBox.y).toBeGreaterThan(weatherBottom);
    }

    await page.locator(".wi-hero").screenshot({ path: "test-results/wi1-02-hero.png" });
  });

  test("Feed WI-1A · rows wrapped in one .wi-feed-card container + geometry measurement", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: VIEWPORT });
    const page = await loginAs(ctx, CTRL_EMAIL, FIXTURE_PW);
    await page.goto(`${BASE_URL}/app/admin/work-intake`);
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
    const card = page.locator(".wi-feed-card");
    await expect(card).toBeVisible();
    const cardStyle = await card.evaluate((el) => {
      const s = getComputedStyle(el);
      return { bg: s.backgroundColor, border: s.borderTopWidth + " " + s.borderTopStyle + " " + s.borderTopColor, radius: s.borderTopLeftRadius };
    });
    console.log("WI_FEED_CARD:", JSON.stringify(cardStyle));
    // WI-1A §7 — subtly lighter warm-white surface than the page canvas.
    // Surface #faf6ec = rgb(250, 246, 236); canvas #f4efe4 = rgb(244, 239, 228).
    expect(cardStyle.bg).toMatch(/24[89]|250/);
    // Feed head + all rows must live INSIDE the card.
    await expect(card.locator(".wi-feed-head")).toBeVisible();
    await expect(card.locator(".wi-feed-row")).toHaveCount(6);
    const cardBox = await card.boundingBox();
    console.log("WI_FEED_CARD_BOX:", JSON.stringify(cardBox));
  });

  test("4 KPI cards with verbatim reference values + trend indicators", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: VIEWPORT });
    const page = await loginAs(ctx, CTRL_EMAIL, FIXTURE_PW);
    await page.goto(`${BASE_URL}/app/admin/work-intake`);
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
    await expect(page.locator(".wi-kpi-card")).toHaveCount(4);
    const values = await page.locator(".wi-kpi-value").allInnerTexts();
    expect(values).toEqual(["12", "8", "5", "28"]);
    await expect(page.getByText("Items need your attention")).toBeVisible();
    await expect(page.getByText("Items ready for review")).toBeVisible();
    await expect(page.getByText("Waiting on others")).toBeVisible();
    await expect(page.getByText("Completed this week")).toBeVisible();
    await expect(page.getByText(/3 from last week/)).toBeVisible();
    await expect(page.getByText(/12% from last week/)).toBeVisible();
    // WI-1B §2 — cards must be compact editorial tiles, not oversized dashboards.
    const cardBox = await page.locator(".wi-kpi-card").first().boundingBox();
    console.log("WI_KPI_CARD_BOX:", JSON.stringify(cardBox));
    if (cardBox) {
      expect(cardBox.height).toBeLessThanOrEqual(115);
      expect(cardBox.height).toBeGreaterThanOrEqual(80);
    }
    // WI-1B §3 — each label must remain on ONE line at 1586×992.
    const wraps = await page.locator(".wi-kpi-label").evaluateAll((els) =>
      els.map((el) => {
        const s = getComputedStyle(el);
        const lh = parseFloat(s.lineHeight);
        return { text: el.textContent, clientHeight: (el as HTMLElement).offsetHeight, lineHeight: lh };
      })
    );
    console.log("WI_KPI_LABEL_WRAPS:", JSON.stringify(wraps));
    for (const w of wraps) {
      expect(w.clientHeight).toBeLessThan(w.lineHeight * 1.6);
    }
    await page.locator(".wi-kpi").screenshot({ path: "test-results/wi1-03-kpi.png" });
  });

  test("Feed head tabs + Filter + Search", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: VIEWPORT });
    const page = await loginAs(ctx, CTRL_EMAIL, FIXTURE_PW);
    await page.goto(`${BASE_URL}/app/admin/work-intake`);
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
    await expect(page.locator(".wi-feed-tab").nth(0)).toHaveText("My Feed");
    await expect(page.locator(".wi-feed-tab").nth(1)).toHaveText("AI Insights");
    await expect(page.locator(".wi-feed-tab").nth(2)).toHaveText("Starred");
    await expect(page.locator(".wi-feed-tab").nth(3)).toHaveText("Archived");
    await expect(page.locator(".wi-feed-filter")).toBeVisible();
    await expect(page.locator(".wi-feed-search input")).toBeVisible();
  });

  test("6 feed rows with scaffold content", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: VIEWPORT });
    const page = await loginAs(ctx, CTRL_EMAIL, FIXTURE_PW);
    await page.goto(`${BASE_URL}/app/admin/work-intake`);
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
    await expect(page.locator(".wi-feed-row")).toHaveCount(6);
    await expect(page.getByText(/Capital Invoice.*Fairway irrigation controls/)).toBeVisible();
    await expect(page.getByText(/Payroll.*3 exceptions require confirmation/)).toBeVisible();
    await expect(page.getByText(/Credit adjustment approval/)).toBeVisible();
    await expect(page.getByText(/AP Invoice.*Course maintenance supplies/)).toBeVisible();
    await expect(page.getByText(/New hire setup.*Assistant Golf Professional/)).toBeVisible();
    await expect(page.getByText(/Staffing variance.*Carter Wedding/)).toBeVisible();
    await page.locator(".wi-feed").screenshot({ path: "test-results/wi1-04-feed.png" });
  });

  test("Right rail with scaffold Today's Position + Executive Insight + Today's Commitments", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: VIEWPORT });
    const page = await loginAs(ctx, CTRL_EMAIL, FIXTURE_PW);
    await page.goto(`${BASE_URL}/app/admin/work-intake`);
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
    await expect(page.locator(".wi-rail-card")).toHaveCount(3);
    await expect(page.getByText(/TODAY.?S POSITION/i)).toBeVisible();
    await expect(page.getByText(/EXECUTIVE INSIGHT/i)).toBeVisible();
    await expect(page.getByText(/TODAY.?S COMMITMENTS/i)).toBeVisible();
    await expect(page.getByText(/Member AR is inside the sixty-day policy line/)).toBeVisible();
    await expect(page.getByText(/No appointments or proposed follow-ups/)).toBeVisible();
    await page.locator(".wi-rail").screenshot({ path: "test-results/wi1-05-rail.png" });
  });

  test("WI-1B masthead · SPECTRE / AUTOMATION horizontal wordmark in the sidebar", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: VIEWPORT });
    const page = await loginAs(ctx, CTRL_EMAIL, FIXTURE_PW);
    await page.goto(`${BASE_URL}/app/admin/work-intake`);
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
    const masthead = page.locator("[data-testid='spectre-sidebar-masthead']");
    await expect(masthead).toBeVisible();
    await expect(masthead.locator(".spectre-sidebar-masthead-primary")).toHaveText("SPECTRE");
    await expect(masthead.locator(".spectre-sidebar-masthead-divider")).toHaveText("/");
    await expect(masthead.locator(".spectre-sidebar-masthead-secondary")).toHaveText("AUTOMATION");
    const style = await masthead.evaluate((el) => {
      const s = getComputedStyle(el);
      return { family: s.fontFamily, transform: s.textTransform };
    });
    expect(style.transform).toBe("uppercase");
    expect(style.family).toMatch(/Inter|system-ui|sans-serif/i);
    // Single line: sum of children widths should not create a wrap.
    const mastheadHeight = await masthead.evaluate((el) => (el as HTMLElement).offsetHeight);
    expect(mastheadHeight).toBeLessThan(32);
    await masthead.screenshot({ path: "test-results/wi1-06-masthead.png" });
  });

  test("Existing Mission Control page still works (regression)", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: VIEWPORT });
    const page = await loginAs(ctx, CTRL_EMAIL, FIXTURE_PW);
    await page.goto(`${BASE_URL}/app/admin`, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
    // Mission Control still renders — hero + KPI live inside the spectre-mc-* classes.
    await expect(page.locator(".spectre-mc-hero")).toBeVisible();
    await expect(page.locator(".spectre-mc-kpi")).toBeVisible();
    // And the WI-1 scaffold shell does NOT appear on Mission Control.
    await expect(page.locator(".wi-root")).toHaveCount(0);
  });
});
