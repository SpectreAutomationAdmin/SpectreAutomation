// One-off probe — measure FP Operating Results bar widths at 1440
// and 1920 viewports so the Weather chart's barWidth target can be
// chosen to match.
import { test, type Page } from "@playwright/test";

async function login(page: Page) {
  await page.goto("/login");
  await page.fill('input[name="email"]', "admin@silversprings.club");
  await page.fill('input[name="password"]', "password");
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/app(\/|$)/, { timeout: 15_000 });
}

for (const vp of [
  { label: "1440x900", width: 1440, height: 900 },
  { label: "1920x1080", width: 1920, height: 1080 },
]) {
  test(`probe FP Operating bar widths @ ${vp.label}`, async ({ page }) => {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await login(page);
    await page.goto("/app/admin/reporting/monthly");
    await page.waitForLoadState("networkidle");
    const card = page.getByTestId("stewardship-operating");
    await card.scrollIntoViewIfNeeded();
    await page.waitForTimeout(400);

    const data = await page.evaluate(() => {
      const card = document.querySelector(
        '[data-testid="stewardship-operating"]',
      ) as HTMLElement | null;
      if (!card) return { cardWidth: -1, bars: [] as number[] };
      const rects = Array.from(
        card.querySelectorAll("svg rect"),
      ) as SVGRectElement[];
      const widths = rects
        .map((r) => r.getBoundingClientRect().width)
        .filter((w) => w > 2 && w < 200)
        .sort((a, b) => a - b);
      return {
        cardWidth: card.getBoundingClientRect().width,
        bars: widths,
      };
    });
    // eslint-disable-next-line no-console
    console.log(
      `\n[FP-bar-probe @ ${vp.label}] cardWidth=${data.cardWidth.toFixed(0)} bars(sorted)=[${data.bars
        .map((w) => w.toFixed(1))
        .join(", ")}]`,
    );
  });
}
