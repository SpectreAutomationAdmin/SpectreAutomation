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
  test(`@ ${vp.w}x${vp.h} — briefing stack stretches + divider visible + link removed`, async ({ page }) => {
    await login(page);
    await page.setViewportSize({ width: vp.w, height: vp.h });
    await page.goto("/app/admin/reporting/monthly");
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(400);

    // 1) Link removed.
    const linkCount = await page.getByTestId("monthly-cover-briefing-link").count();

    // 2) Divider — read computed border-left on the briefing column.
    const div = await page.getByTestId("monthly-cover-briefing")
      .evaluate((el) => {
        const cs = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return {
          borderLeftWidth: cs.borderLeftWidth,
          borderLeftStyle: cs.borderLeftStyle,
          borderLeftColor: cs.borderLeftColor,
          left: r.left,
          right: r.right,
          height: r.height,
        };
      });

    // 3) Stack bottom vs at-a-glance bottom (the "0.17x ABOVE FLOOR" line).
    const capCard = await page.getByTestId("cover-briefing-capital-program")
      .evaluate((el) => el.getBoundingClientRect().bottom);
    const aag = await page.getByTestId("monthly-cover-at-a-glance")
      .evaluate((el) => el.getBoundingClientRect().bottom);

    // 4) Identity column right edge vs divider position to confirm
    //    the briefing column was pulled left of its original 1fr start.
    const identityRight = await page.getByTestId("monthly-cover-identity")
      .evaluate((el) => el.getBoundingClientRect().right);

    // eslint-disable-next-line no-console
    console.log(
      `[stretch ${vp.w}x${vp.h}]\n` +
      `  read-full-memos link count = ${linkCount}\n` +
      `  briefing.borderLeft = ${div.borderLeftWidth} ${div.borderLeftStyle} ${div.borderLeftColor}\n` +
      `  identity.right = ${identityRight.toFixed(1)}  | briefing.left = ${div.left.toFixed(1)}  | gap = ${(div.left - identityRight).toFixed(1)}\n` +
      `  briefing.height = ${div.height.toFixed(1)}\n` +
      `  CapitalProgram card bottom = ${capCard.toFixed(1)}\n` +
      `  At-a-glance bottom         = ${aag.toFixed(1)}\n` +
      `  Δ = ${(capCard - aag).toFixed(1)}px (positive = card stack ends BELOW at-a-glance)`,
    );

    await page.screenshot({
      path: `test-results/briefing-stretch-${vp.w}x${vp.h}.png`,
      fullPage: false,
    });
  });
}
