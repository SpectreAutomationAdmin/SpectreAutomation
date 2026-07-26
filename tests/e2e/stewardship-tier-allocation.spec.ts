import { test } from "@playwright/test";

const ADMIN = "admin@silversprings.club";
const PASSWORD = "password";

test("stewardship dashboard tier % allocation at 1920x1080", async ({ page }) => {
  await page.goto("/login");
  await page.fill('input[name="email"]', ADMIN);
  await page.fill('input[name="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/app(\/|$)/, { timeout: 15_000 });
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/app/admin/reporting/monthly");
  await page.waitForLoadState("networkidle");
  await page.locator("#financial-performance").scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);

  for (const card of ["stewardship-equity", "stewardship-operating"]) {
    const data = await page.getByTestId(card).evaluate((el) => {
      const cardRect = el.getBoundingClientRect();
      const header = el.querySelector("header");
      const ribbon = el.querySelector(":scope > div:nth-of-type(1)"); // KPI ribbon
      // We need the chart container — it's the next div after the ribbon.
      const divs = Array.from(el.querySelectorAll(":scope > div"));
      const chartContainer = divs[1] ?? null;
      const footer = el.querySelector("p:last-of-type");

      const h = (e: Element | null) => (e ? e.getBoundingClientRect().height : 0);

      return {
        cardH: cardRect.height,
        headerH: h(header),
        ribbonH: h(ribbon),
        chartH: h(chartContainer),
        footerH: h(footer),
      };
    });

    const pct = (n: number) => ((n / data.cardH) * 100).toFixed(1) + "%";
    // eslint-disable-next-line no-console
    console.log(
      `[tier ${card}]\n` +
      `  card height        = ${data.cardH.toFixed(0)} px\n` +
      `  header             = ${data.headerH.toFixed(0)} px (${pct(data.headerH)})\n` +
      `  KPI ribbon         = ${data.ribbonH.toFixed(0)} px (${pct(data.ribbonH)})\n` +
      `  chart container    = ${data.chartH.toFixed(0)} px (${pct(data.chartH)})\n` +
      `  interpretation     = ${data.footerH.toFixed(0)} px (${pct(data.footerH)})`,
    );
  }

  await page.screenshot({
    path: "test-results/stewardship-tier-allocation-1920x1080.png",
    fullPage: false,
  });
});
