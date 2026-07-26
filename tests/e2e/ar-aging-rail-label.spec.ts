import { test, expect, type Page } from "@playwright/test";

// Confirms the rail nav label is the concise "AR Aging" while the
// on-page chapter title remains the formal "Accounts Receivable
// Aging" — and the rail link still scrolls + activates correctly.

const ADMIN = "admin@silversprings.club";
const PASSWORD = "password";

async function login(page: Page) {
  await page.goto("/login");
  await page.fill('input[name="email"]', ADMIN);
  await page.fill('input[name="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/app(\/|$)/, { timeout: 15_000 });
}

test("rail label is 'AR Aging' but the section title remains 'Accounts Receivable Aging'", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  await page.goto("/app/admin/reporting/monthly");
  await page.waitForLoadState("networkidle");

  const railEntry = page.getByTestId("reporting-chapter-ar-aging");
  await railEntry.waitFor({ timeout: 20_000 });

  // Rail label = "AR Aging" (concise form), and explicitly NOT the
  // formal "Accounts Receivable Aging" title.
  await expect(railEntry).toContainText("AR Aging");
  await expect(railEntry).not.toContainText("Accounts Receivable Aging");

  // Capture the five Financial Performance entries to pin ordering.
  const railLabels = await page
    .locator("[data-testid^='reporting-chapter-']")
    .allInnerTexts();
  const financialPerformanceOrder = [
    "Statement of Activities",
    "Capital Fund",
    "Capital Projects",
    "Financial Position",
    "AR Aging",
  ];
  let lastIdx = -1;
  for (const label of financialPerformanceOrder) {
    const idx = railLabels.findIndex((t) => t.includes(label));
    expect(idx, `rail must contain "${label}"`).toBeGreaterThan(-1);
    expect(idx, `"${label}" must appear after the previous entry`).toBeGreaterThan(lastIdx);
    lastIdx = idx;
  }

  // The rail link still scrolls to the section + activates.
  await railEntry.click();
  await page.waitForTimeout(600);
  const panel = page.getByTestId("ar-aging");
  await expect(panel).toBeInViewport();

  // The CHAPTER TITLE on the page remains the formal long form.
  await expect(page.getByTestId("ara-title")).toHaveText("Accounts Receivable Aging");
});
