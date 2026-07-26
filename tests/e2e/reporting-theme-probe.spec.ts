import { test, expect, type Page } from "@playwright/test";

// One-off probe: log the computed colors of the reporting shell
// header, body backdrop, and chapter-numeral so we can confirm the
// board-package livery rendered.

const ADMIN = "admin@silversprings.club";
const PASSWORD = "password";

async function login(page: Page) {
  await page.goto("/login");
  await page.fill('input[name="email"]', ADMIN);
  await page.fill('input[name="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/app(\/|$)/, { timeout: 15_000 });
}

test("reporting shell rendered colors match the board-package theme", async ({ page }) => {
  await login(page);
  await page.goto("/app/admin/reporting/monthly");

  const headerBg = await page
    .getByTestId("reporting-shell-header")
    .evaluate((el) => getComputedStyle(el).backgroundColor);
  const shellBg = await page
    .getByTestId("reporting-shell")
    .evaluate((el) => getComputedStyle(el).backgroundColor);
  const chapterNumeral = await page
    .getByTestId("reporting-chapter-executive")
    .locator("span.font-mono")
    .first()
    .evaluate((el) => getComputedStyle(el).color);
  const periodChipColor = await page
    .getByTestId("reporting-shell-period")
    .evaluate((el) => getComputedStyle(el).color);

  test.info().annotations.push({
    type: "reporting-theme-probe",
    description: `headerBg=${headerBg} shellBg=${shellBg} chapterNumeral=${chapterNumeral} periodChip=${periodChipColor}`,
  });

  // Deep green header (club-green-900 = #0f2410 → rgb(15, 36, 16)).
  expect(headerBg).toBe("rgb(15, 36, 16)");
  // Cream parchment body (club-cream = #f8f5ef → rgb(248, 245, 239)).
  expect(shellBg).toBe("rgb(248, 245, 239)");
  // Gold accent on chapter numerals (club-gold @ 85% opacity reads
  // as the same rgb — opacity is on the alpha channel).
  expect(chapterNumeral).toContain("176, 138, 74");
  // Period chip uses muted gold.
  expect(periodChipColor).toContain("176, 138, 74");

  await page.screenshot({
    path: "test-results/reporting-theme-applied.png",
    fullPage: true,
  });
});
