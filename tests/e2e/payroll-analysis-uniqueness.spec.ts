import { test, expect, type Page } from "@playwright/test";

// Regression guard for the 2026-06-19 removal of the legacy "Payroll"
// chapter. After the cleanup:
//   - the left rail contains a payroll entry EXACTLY ONCE (at XII,
//     labelled "Payroll Analysis", pointing to
//     payroll-analysis)
//   - no `<section id="payroll">` renders in the body
//   - no `data-testid="payroll-analysis"` (the legacy panel's testid)
//     remains
//   - clicking XII Payroll Analysis scrolls to the canonical
//     payroll-analysis section

const ADMIN = "admin@silversprings.club";
const PASSWORD = "password";

async function login(page: Page) {
  await page.goto("/login");
  await page.fill('input[name="email"]', ADMIN);
  await page.fill('input[name="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/app(\/|$)/, { timeout: 30_000 });
}

test("Payroll appears EXACTLY ONCE in the rail + the body", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  await page.goto("/app/admin/reporting/monthly");
  await page.waitForLoadState("networkidle");
  await page.getByTestId("reporting-chapter-payroll-analysis").waitFor({ timeout: 20_000 });

  // Canonical entry — present.
  await expect(
    page.getByTestId("reporting-chapter-payroll-analysis"),
  ).toBeVisible();

  // Legacy id MUST NOT appear in the rail.
  await expect(
    page.getByTestId("reporting-chapter-payroll"),
  ).toHaveCount(0);

  // De-duped rail entry list — Payroll rail label appears exactly
  // once (the canonical Payroll Analysis entry).
  const payrollLabelCount = await page.evaluate(() => {
    const rails = Array.from(
      document.querySelectorAll("[data-testid^='reporting-chapter-']"),
    );
    const seen = new Set<string>();
    let count = 0;
    for (const el of rails) {
      const id = el.getAttribute("data-testid")!;
      if (seen.has(id)) continue;
      seen.add(id);
      const text = el.textContent?.toLowerCase() ?? "";
      if (text.includes("payroll")) count++;
    }
    return count;
  });
  expect(payrollLabelCount).toBe(1);

  // Body has no legacy section anchor.
  await expect(page.locator("#payroll")).toHaveCount(0);
  // Legacy panel's data-testid is gone.
  await expect(page.locator("[data-testid='payroll-analysis']")).toHaveCount(0);
});

test("Clicking XII Payroll Analysis scrolls to the canonical Payroll Analysis section", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  await page.goto("/app/admin/reporting/monthly");
  await page.waitForLoadState("networkidle");
  const railEntry = page.getByTestId("reporting-chapter-payroll-analysis");
  await railEntry.waitFor({ timeout: 20_000 });
  await railEntry.click();
  await page.getByTestId("payroll-analysis").waitFor({ timeout: 20_000 });
  await expect(page.getByTestId("payroll-analysis")).toBeInViewport();
  await expect(railEntry).toBeInViewport();

  await page.screenshot({
    path: "test-results/payroll-single-section-1440.png",
    fullPage: false,
  });
});
