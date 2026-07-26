import { test, expect, type Page } from "@playwright/test";

// Regression guard for the 2026-06-17 removal of the legacy
// "XVI Capital / Projects" chapter. After the cleanup:
//   - the left rail lists Capital Projects EXACTLY ONCE (at VI,
//     pointing to capital-projects)
//   - no `<section id="capital-projects">` renders in the body
//   - no "Approved capital plan" content remains
//   - clicking VI Capital Projects scrolls to the canonical
//     capital-projects section

const ADMIN = "admin@silversprings.club";
const PASSWORD = "password";

async function login(page: Page) {
  await page.goto("/login");
  await page.fill('input[name="email"]', ADMIN);
  await page.fill('input[name="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/app(\/|$)/, { timeout: 30_000 });
}

test("Capital Projects appears EXACTLY ONCE in the rail + the body", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  await page.goto("/app/admin/reporting/monthly");
  await page.waitForLoadState("networkidle");
  await page.getByTestId("reporting-chapter-capital-projects").waitFor({ timeout: 20_000 });

  // Canonical Financial Performance entry — present.
  await expect(
    page.getByTestId("reporting-chapter-capital-projects"),
  ).toBeVisible();

  // Legacy id MUST NOT appear anywhere in the rail.
  await expect(
    page.getByTestId("reporting-chapter-capital-projects"),
  ).toHaveCount(0);

  // De-duped rail entry list — Capital Projects rail label appears
  // exactly once (the canonical Financial Performance entry).
  const capitalProjectsLabels = await page.evaluate(() => {
    const rails = Array.from(
      document.querySelectorAll("[data-testid^='reporting-chapter-']"),
    );
    // De-dupe by testid (mobile + desktop sidebars can interleave).
    const seen = new Set<string>();
    let count = 0;
    for (const el of rails) {
      const id = el.getAttribute("data-testid")!;
      if (seen.has(id)) continue;
      seen.add(id);
      if (el.textContent?.toLowerCase().includes("capital projects")) {
        count++;
      }
    }
    return count;
  });
  expect(capitalProjectsLabels).toBe(1);

  // Body has no legacy section anchor and no `capital-projects-lead`
  // testid. (The phrase "Approved capital projects on track" still
  // appears as Stewardship KPI copy — different content, kept.)
  await expect(page.locator("#capital-projects")).toHaveCount(0);
  await expect(page.getByTestId("capital-projects-lead")).toHaveCount(0);
});

test("Clicking VI Capital Projects scrolls to the canonical Capital Project Tracker section", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  await page.goto("/app/admin/reporting/monthly");
  await page.waitForLoadState("networkidle");
  const railEntry = page.getByTestId("reporting-chapter-capital-projects");
  await railEntry.waitFor({ timeout: 20_000 });
  await railEntry.click();
  await page.getByTestId("capital-projects").waitFor({ timeout: 20_000 });
  await expect(page.getByTestId("capital-projects")).toBeInViewport();
  await expect(railEntry).toBeInViewport();

  await page.screenshot({
    path: "test-results/capital-projects-single-section-1440.png",
    fullPage: false,
  });
});
