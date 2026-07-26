import { test, expect, type Page } from "@playwright/test";

// 2026-06-19 — the legacy "F&B / Hospitality" chapter (rail id
// "fb-hospitality") was removed because it duplicated the canonical
// chapter XIII "F&B Statistics" (rail id "f-and-b-statistics").
// This spec is the regression guard: any future re-introduction of
// a second F&B-themed rail entry must fail loudly.

const ADMIN = "admin@silversprings.club";
const PASSWORD = "password";

async function login(page: Page) {
  await page.goto("/login");
  await page.fill('input[name="email"]', ADMIN);
  await page.fill('input[name="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/app(\/|$)/, { timeout: 15_000 });
}

test("the rail contains exactly ONE F&B-themed chapter — Food & Beverage Statistics", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  await page.goto("/app/admin/reporting/monthly");
  await page.waitForLoadState("networkidle");
  await page.getByTestId("reporting-chapter-f-and-b-statistics").waitFor({ timeout: 20_000 });

  // Legacy rail id MUST be gone.
  await expect(
    page.getByTestId("reporting-chapter-fb-hospitality"),
    "legacy 'fb-hospitality' rail entry must NOT render",
  ).toHaveCount(0);

  // Legacy body anchor MUST be gone.
  await expect(
    page.locator("#fb-hospitality"),
    "legacy '#fb-hospitality' section anchor must NOT render",
  ).toHaveCount(0);

  // Canonical chapter XIII is the single F&B surface.
  await expect(
    page.getByTestId("reporting-chapter-f-and-b-statistics"),
    "canonical F&B Statistics rail entry must render",
  ).toHaveCount(1);

  // De-duped count: any rail entry whose label contains "f&b" or
  // "food" must reduce to exactly ONE.
  const fbLabels = await page.evaluate(() => {
    const nodes = Array.from(document.querySelectorAll('[data-testid^="reporting-chapter-"]'));
    return nodes
      .map((n) => (n.textContent ?? "").toLowerCase())
      .filter((t) => t.includes("f&b") || t.includes("food"));
  });
  expect(fbLabels.length, `expected exactly 1 F&B-themed rail entry, found ${fbLabels.length}: ${fbLabels.join(" | ")}`).toBe(1);

  await page.screenshot({ path: "test-results/fb-statistics-uniqueness-rail.png", fullPage: false });
});
