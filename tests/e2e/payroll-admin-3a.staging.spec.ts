// Payroll Admin 3A — staging acceptance.
//
// Verifies against the deployed staging release that:
//   - /api/health = 200
//   - /app/admin/payroll renders the approved surface driven by real
//     Coulee Ridge Payroll data (not the fixture strings).
//   - Change Period control renders.
//   - Filter controls render (with URL-echoed values where the domain
//     has data to populate them).
//   - Mission Control still renders (non-Payroll regression).
//
// Coulee Ridge staging is where the founder's mental model of "the
// test tenant" lives; this spec runs the founder acceptance walk.

import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { loginAsFounder } from "./_lib/staging-auth";

const OUT = path.resolve("test-results/payroll-admin-3a-staging");
fs.mkdirSync(OUT, { recursive: true });

const STAGING = process.env.SPECTRE_STAGING_BASE_URL ?? "https://staging.spectreautomation.com";

test.use({ viewport: { width: 1440, height: 900 } });

test.describe.serial("Payroll Admin 3A — staging", () => {
  test.setTimeout(240_000);

  test("A. /api/health = 200", async ({ request }) => {
    const r = await request.get(`${STAGING}/api/health`);
    expect(r.status()).toBe(200);
  });

  test("B. /app/admin/payroll renders the real surface", async ({ context }) => {
    const page = await loginAsFounder(context);
    await page.goto(`${STAGING}/app/admin/payroll`, { waitUntil: "networkidle" });
    await expect(page.getByTestId("spectre-sidebar")).toBeVisible();
    await expect(page.getByTestId("payroll-admin-surface")).toBeVisible();
    await expect(page.getByTestId("payroll-admin-header")).toBeVisible();
    await expect(page.getByTestId("payroll-admin-workflow")).toBeVisible();
    await expect(page.getByTestId("payroll-admin-kpi-strip")).toBeVisible();
    await expect(page.getByTestId("payroll-admin-workspace")).toBeVisible();
    await expect(page.getByTestId("payroll-admin-actions")).toBeVisible();
    await expect(page.getByTestId("payroll-admin-checklist")).toBeVisible();
    await expect(page.getByTestId("payroll-admin-pay-period")).toBeVisible();
    await expect(page.getByTestId("payroll-admin-footer")).toBeVisible();
    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(scrollWidth).toBeLessThanOrEqual(1440);
    await page.screenshot({ path: path.join(OUT, "staging-payroll-1440x900.png"), fullPage: false });
  });

  test("C. Fixture-data leak check on staging", async ({ context }) => {
    const page = await loginAsFounder(context);
    await page.goto(`${STAGING}/app/admin/payroll`, { waitUntil: "networkidle" });
    const html = await page.content();
    const forbidden = [
      "Taylor Hourly", "Riley Preview", "Casey Preview", "Devon Preview",
      "Lise Montsion", "Alex Chen", "Jordan Keller", "Morgan West", "Jamie Park",
      // Chris Turcato is the real founder account; do NOT flag his name here.
      "$32,487.62", "1,248.50", "42 hourly · 6 salary",
      "5% vs. previous period", "3% vs. previous period",
      "5 of 6 complete",
    ];
    const leaked = forbidden.filter((s) => html.includes(s));
    expect(leaked, `forbidden fixtures leaked: ${leaked.join(", ")}`).toEqual([]);
  });

  test("D. Change Period + Export disabled + Payroll Actions disabled", async ({ context }) => {
    const page = await loginAsFounder(context);
    await page.goto(`${STAGING}/app/admin/payroll`, { waitUntil: "networkidle" });
    await expect(page.getByTestId("payroll-admin-change-period")).toBeVisible();
    await expect(page.getByTestId("payroll-admin-export")).toBeDisabled();
    const disabledActionCount = await page.getByTestId("payroll-admin-actions").locator("button[disabled]").count();
    expect(disabledActionCount).toBeGreaterThanOrEqual(5);
  });

  test("E. Filter bar + search URL echo", async ({ context }) => {
    const page = await loginAsFounder(context);
    await page.goto(`${STAGING}/app/admin/payroll?q=Chris`, { waitUntil: "networkidle" });
    await expect(page.getByTestId("payroll-admin-search")).toHaveValue("Chris");
    await expect(page.getByTestId("payroll-admin-filter-department")).toBeVisible();
    await expect(page.getByTestId("payroll-admin-filter-employment")).toBeVisible();
    await expect(page.getByTestId("payroll-admin-filter-status")).toBeVisible();
  });

  test("F. Mission Control still renders (non-Payroll regression)", async ({ context }) => {
    const page = await loginAsFounder(context);
    await page.goto(`${STAGING}/app/admin`, { waitUntil: "networkidle" });
    await expect(page.getByTestId("spectre-sidebar")).toBeVisible();
    const err = await page.locator("text=/Application error/i").count();
    expect(err).toBe(0);
    await page.screenshot({ path: path.join(OUT, "staging-mission-control-1440x900.png"), fullPage: false });
  });
});
