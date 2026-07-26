import { test, type Page } from "@playwright/test";

// 2026-06-19 — pilot screenshots for the canonical chart system
// migration. Captures Chapter XI (Weather & Utilization) at every
// supported admin viewport so the founder can verify the migrated
// charts visually match the Financial Performance chapter's chart
// styling.

const ADMIN = "admin@silversprings.club";
const PASSWORD = "password";

const VIEWPORTS = [
  { label: "1366x768",  width: 1366, height: 768  },
  { label: "1440x900",  width: 1440, height: 900  },
  { label: "1600x900",  width: 1600, height: 900  },
  { label: "1920x1080", width: 1920, height: 1080 },
  { label: "2560x1440", width: 2560, height: 1440 },
] as const;

async function login(page: Page) {
  await page.goto("/login");
  await page.fill('input[name="email"]', ADMIN);
  await page.fill('input[name="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/app(\/|$)/, { timeout: 15_000 });
}

for (const vp of VIEWPORTS) {
  test(`chart system pilot — Chapter XI Weather charts at ${vp.label}`, async ({ page }) => {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await login(page);
    await page.goto("/app/admin/reporting/monthly");
    await page.waitForLoadState("networkidle");
    await page.getByTestId("reporting-chapter-weather-and-utilization").click();
    await page.getByTestId("mws-charts-grid").waitFor({ timeout: 20_000 });
    await page.getByTestId("mws-charts-grid").scrollIntoViewIfNeeded();
    await page.waitForTimeout(400);

    await page.screenshot({
      path: `test-results/chart-system-xi-${vp.label}-rest.png`,
      fullPage: false,
    });

    // Hover state — donut sunny slice + bar sunny.
    await page.locator("[data-testid='mws-pattern-slice-sunny-clear']").evaluate((el) => {
      const rect = (el as SVGElement).getBoundingClientRect();
      const clientX = rect.left + rect.width / 2 + 70;
      const clientY = rect.top + rect.height / 2;
      el.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true, clientX, clientY }));
      el.dispatchEvent(new MouseEvent("mousemove",  { bubbles: true, clientX, clientY }));
    });
    await page.waitForTimeout(300);
    await page.screenshot({
      path: `test-results/chart-system-xi-${vp.label}-donut-hover.png`,
      fullPage: false,
    });
  });
}
