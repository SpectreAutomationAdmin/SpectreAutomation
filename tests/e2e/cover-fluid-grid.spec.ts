import { test, type Page } from "@playwright/test";

const ADMIN = "admin@silversprings.club";
const PASSWORD = "password";
const PHASE = process.env.COVER_FLUID_PHASE ?? "after";

async function login(page: Page) {
  await page.goto("/login");
  await page.fill('input[name="email"]', ADMIN);
  await page.fill('input[name="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/app(\/|$)/, { timeout: 15_000 });
}

for (const vp of [
  { w: 1366, h: 768 },
  { w: 1440, h: 900 },
  { w: 1920, h: 1080 },
  { w: 1024, h: 768 },
] as const) {
  test(`@ ${vp.w}x${vp.h} — cover fluid-grid measurements (${PHASE})`, async ({ page }) => {
    await login(page);
    await page.setViewportSize({ width: vp.w, height: vp.h });
    await page.goto("/app/admin/reporting/monthly");
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(400);

    const measure = async (testid: string) => {
      const loc = page.getByTestId(testid);
      if ((await loc.count()) === 0) return null;
      return loc.first().evaluate((el) => {
        const r = el.getBoundingClientRect();
        return { left: r.left, right: r.right, width: r.width };
      });
    };

    const identity = await measure("monthly-cover-identity");
    const briefing = await measure("monthly-cover-briefing");
    const atGlance = await measure("monthly-cover-at-a-glance");
    const clubName = await measure("monthly-cover-club-name");
    const dash = await measure("financial-performance");

    const deadBand =
      identity && briefing
        ? Math.max(0, briefing.left - identity.right)
        : null;

    const clubNameLines = await page.getByTestId("monthly-cover-club-name")
      .evaluate((el) => {
        const computedLineHeight = parseFloat(getComputedStyle(el).lineHeight);
        const totalH = el.getBoundingClientRect().height;
        return Math.round(totalH / computedLineHeight);
      });

    // eslint-disable-next-line no-console
    console.log(
      `[fluid-${PHASE} ${vp.w}x${vp.h}]\n` +
      `  identity=${identity ? `${identity.left.toFixed(0)}..${identity.right.toFixed(0)} (${identity.width.toFixed(0)}px)` : "n/a"}\n` +
      `  briefing=${briefing ? `${briefing.left.toFixed(0)}..${briefing.right.toFixed(0)} (${briefing.width.toFixed(0)}px)` : "n/a"}\n` +
      `  dead band between =${deadBand !== null ? `${deadBand.toFixed(0)}px` : "n/a"}\n` +
      `  at-a-glance width=${atGlance ? `${atGlance.width.toFixed(0)}px` : "n/a"}\n` +
      `  club name width=${clubName ? `${clubName.width.toFixed(0)}px` : "n/a"} lines=${clubNameLines}\n` +
      `  financial-performance top=${dash ? dash.left.toFixed(0) : "n/a"} (vp.h=${vp.h})`,
    );

    await page.screenshot({
      path: `test-results/cover-fluid-${PHASE}-${vp.w}x${vp.h}.png`,
      fullPage: false,
    });
  });
}
