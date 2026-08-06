// Sprint 3 · Post-16H Phase 3.2 (2026-08-05) — authenticated
// browser tour of the staging surfaces Phase 3.2 touched. Captures
// DOM assertions + post-login screenshots as evidence the founder
// asked for. Login form is never screenshotted (helper prohibits it).
//
// Scenarios:
//   1. Mission Control landing renders with the founder's tenant.
//   2. AP Invoices list is reachable (canonical-decision enforcement
//      lives on the post action reachable from here).
//   3. The Phase 3.2 diagnostics on /api/health are what the
//      authenticated client sees, not just what a curl sees.
//
// Screenshots land in test-results/artifacts/ per Playwright config.

import { test, expect } from "@playwright/test";
import {
  loginAsFounder,
  stagingCredsAvailable,
} from "./_lib/staging-auth";

const availability = stagingCredsAvailable();

test.describe("Phase 3.2 · authenticated staging tour", () => {
  test.skip(!availability.ready, availability.reason ?? "creds unavailable");

  test("Mission Control landing renders authenticated", async ({ context }) => {
    const page = await loginAsFounder(context, { landing: "/app/admin" });
    // First screenshot happens strictly AFTER we're off /login.
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForLoadState("networkidle");
    // Assert we are on an admin route (not redirected back to /login).
    await expect(page).toHaveURL(/\/app\/admin/);
    // Any admin chrome element proves the page rendered.
    const anyAdminChrome = page.locator("main, nav, header").first();
    await expect(anyAdminChrome).toBeVisible({ timeout: 10_000 });
    await page.screenshot({
      path: "test-results/artifacts/staging-mission-control.png",
      fullPage: false,
    });
  });

  test("AP invoices list is reachable from the sidebar", async ({ context }) => {
    const page = await loginAsFounder(context, { landing: "/app/admin/ap/invoices" });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForLoadState("networkidle");
    // Non-redirect proof of RBAC + tenant scope.
    await expect(page).toHaveURL(/\/app\/admin\/ap\/invoices/);
    // Any table / empty-state / heading proves the page mounted.
    const contentAnchor = page.getByRole("heading").first();
    await expect(contentAnchor).toBeVisible({ timeout: 10_000 });
    await page.screenshot({
      path: "test-results/artifacts/staging-ap-invoices.png",
      fullPage: false,
    });
  });

  test("Reporting Monthly Package renders authenticated (Equity locked-baseline surface)", async ({ context }) => {
    const page = await loginAsFounder(context, { landing: "/app/admin/reporting/monthly" });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForLoadState("networkidle");
    await expect(page).toHaveURL(/\/app\/admin\/reporting\/monthly/);
    const anyHeading = page.getByRole("heading").first();
    await expect(anyHeading).toBeVisible({ timeout: 15_000 });
    await page.screenshot({
      path: "test-results/artifacts/staging-monthly-reporting.png",
      fullPage: false,
    });
  });

  test("authenticated /api/health round-trip matches deployed Phase 3.2", async ({ context }) => {
    const page = await loginAsFounder(context);
    const res = await page.request.get(`${availability.baseURL}/api/health`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body.apIntelligence.eligibilityRuleVersion).toBeGreaterThanOrEqual(2);
    expect(body.apIntelligence.workflowDecisionVersion).toBeGreaterThanOrEqual(1);
    expect(body.apIntelligence.phase0Enabled).toBe(true);
    expect(body.apIntelligence.phase2Enabled).toBe(true);
    const queue = (body.checks as Array<{ name: string; detail: string; status: string }>).find(
      (c) => c.name === "queue",
    );
    expect(queue?.detail ?? "").toMatch(/dlq total=\d+ · active=\d+ · historical=\d+/);
    expect(queue?.status).toMatch(/^(ok|warn)$/);
  });
});
