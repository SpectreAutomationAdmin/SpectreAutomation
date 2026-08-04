// 16F cleanup — public-page evidence.
// Captures the login page + health endpoint at staging.
// Authenticated Mission Control screenshots require founder
// credentials; those are covered by server-log evidence in
// the checkpoint report.

import { test, expect } from "@playwright/test";

const STAGING = "https://staging.spectreautomation.com";

test.use({ baseURL: STAGING });

test("16F — staging login page renders", async ({ page }) => {
  await page.goto("/login");
  await page.waitForLoadState("networkidle");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.screenshot({ path: "test-results/c16f-staging-login.png", fullPage: true });
  await expect(page.locator("body")).toBeVisible();
});

test("16F — staging /api/health is 200 + healthy JSON", async ({ page }) => {
  const res = await page.request.get("/api/health");
  expect(res.status()).toBe(200);
  const json = await res.json();
  expect(json.status).toBe("ok");
  const dbCheck = json.checks?.find((c: { name: string; status: string }) => c.name === "database");
  expect(dbCheck?.status).toBe("ok");
});
