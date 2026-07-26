import { test, type Page } from "@playwright/test";

// Visual evidence spec: at every supported admin viewport, capture
// the rail beside the visible report content at three reading
// depths so the founder can confirm the active highlight matches
// what they're actually reading.

const ADMIN = "admin@silversprings.club";
const PASSWORD = "password";

async function login(page: Page) {
  await page.goto("/login");
  await page.fill('input[name="email"]', ADMIN);
  await page.fill('input[name="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/app(\/|$)/, { timeout: 15_000 });
}

const VIEWPORTS = [
  { label: "1366x768",  width: 1366, height: 768  },
  { label: "1440x900",  width: 1440, height: 900  },
  { label: "1600x900",  width: 1600, height: 900  },
  { label: "1920x1080", width: 1920, height: 1080 },
  { label: "2560x1440", width: 2560, height: 1440 },
] as const;

const READING_DEPTHS = [
  { label: "top",                  sectionId: "executive-opening" },
  { label: "financial-performance", sectionId: "financial-performance" },
  { label: "weather",              sectionId: "weather-and-utilization" },
] as const;

for (const vp of VIEWPORTS) {
  for (const depth of READING_DEPTHS) {
    test(`visual evidence — ${vp.label} reading ${depth.label}`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await login(page);
      await page.goto("/app/admin/reporting/monthly");
      await page.waitForLoadState("networkidle");
      await page.getByTestId("reporting-shell-chapters").waitFor({ timeout: 20_000 });
      await page.waitForTimeout(400);

      if (depth.sectionId !== "executive-opening") {
        await page.evaluate((id) => {
          const el = document.getElementById(id);
          if (el) {
            // Land the section heading 50 px below the reading line so
            // the heading is unambiguously in the reading band.
            window.scrollTo({ top: el.offsetTop + 200, behavior: "instant" as ScrollBehavior });
          }
        }, depth.sectionId);
        await page.waitForTimeout(400);
      }

      await page.screenshot({
        path: `test-results/scrollspy-visual-${vp.label}-${depth.label}.png`,
        fullPage: false,
      });
    });
  }
}
