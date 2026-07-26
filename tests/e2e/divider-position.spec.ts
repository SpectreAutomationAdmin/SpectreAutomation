import { test, type Page } from "@playwright/test";

const ADMIN = "admin@silversprings.club";
const PASSWORD = "password";

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
] as const) {
  test(`@ ${vp.w}x${vp.h} — divider near DEPRECIATION end + identity pixel-stable`, async ({ page }) => {
    await login(page);
    await page.setViewportSize({ width: vp.w, height: vp.h });
    await page.goto("/app/admin/reporting/monthly");
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(400);

    // Identity column rect (must be UNCHANGED across this prompt).
    const identity = await page.getByTestId("monthly-cover-identity")
      .evaluate((el) => {
        const r = el.getBoundingClientRect();
        return { left: r.left, right: r.right, width: r.width };
      });

    // Briefing column rect = divider position is at briefing.left.
    const briefing = await page.getByTestId("monthly-cover-briefing")
      .evaluate((el) => el.getBoundingClientRect());

    // NOI label TEXT rect — Range over the text node finds where the
    // glyphs actually end (not the dt's column-width box).
    const noiLabel = await page.getByTestId("monthly-cover-at-a-glance-noi-label")
      .evaluate((el) => {
        const r = document.createRange();
        r.selectNodeContents(el);
        const rect = r.getBoundingClientRect();
        return { left: rect.left, right: rect.right };
      });

    // EB masthead label rect — should track briefing column horizontally.
    const ebLabel = await page.locator(":text('Executive briefing')").first()
      .evaluate((el) => el.getBoundingClientRect());

    // eslint-disable-next-line no-console
    console.log(
      `[divider ${vp.w}x${vp.h}]\n` +
      `  identity = ${identity.left.toFixed(0)}..${identity.right.toFixed(0)} (${identity.width.toFixed(0)}px wide)\n` +
      `  NOI label = ${noiLabel.left.toFixed(0)}..${noiLabel.right.toFixed(0)} (DEPRECIATION ends at ${noiLabel.right.toFixed(0)})\n` +
      `  briefing/divider = left ${briefing.left.toFixed(0)}\n` +
      `  Δ divider − DEPRECIATION end = ${(briefing.left - noiLabel.right).toFixed(0)}px  (positive = divider right of DEPRECIATION)\n` +
      `  EB masthead label left = ${ebLabel.left.toFixed(0)}  (should align with briefing column body)`,
    );

    await page.screenshot({
      path: `test-results/divider-pos-${vp.w}x${vp.h}.png`,
      fullPage: false,
    });
  });
}
