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

test("@ 1440x900 — rail divider visible", async ({ page }) => {
  await login(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/app/admin/reporting/monthly");
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(400);

  // Read the computed border-right style on the aside.
  const border = await page.getByTestId("reporting-shell-chapters")
    .evaluate((el) => {
      const cs = getComputedStyle(el);
      return {
        borderRightWidth: cs.borderRightWidth,
        borderRightStyle: cs.borderRightStyle,
        borderRightColor: cs.borderRightColor,
      };
    });
  // eslint-disable-next-line no-console
  console.log("[rail-divider]", JSON.stringify(border));

  await page.screenshot({
    path: `test-results/rail-divider-1440x900.png`,
    fullPage: false,
  });
});
