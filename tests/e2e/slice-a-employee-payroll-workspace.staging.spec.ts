// Slice A (2026-09-18) — Employee Payroll workspace + Implementation
// section browser acceptance at 1440×900 on the live staging tenant.
//
// Read-only. Does NOT save founder data.

import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

const OUT = path.resolve("test-results/slice-a-employee-payroll-workspace");
fs.mkdirSync(OUT, { recursive: true });

const STAGING = process.env.SPECTRE_STAGING_BASE_URL ?? "https://staging.spectreautomation.com";

test.use({ viewport: { width: 1440, height: 900 } });

test.describe("Slice A — Employee Payroll workspace", () => {
  test.beforeAll(() => {
    const status = stagingCredsAvailable();
    if (!status.ready) test.skip(true, status.reason ?? "staging creds not set");
  });

  test("Chris → Payroll shows 8-section IA including Implementation & YTD", async ({ context }) => {
    const page = await loginAsFounder(context, { landing: "/app/admin/people/employees" });
    await page.waitForLoadState("networkidle");

    // Land on Chris's profile via search of the directory.
    const chrisLink = page.locator("a", { hasText: /Chris/i }).first();
    await chrisLink.click({ timeout: 20_000 });
    await page.waitForLoadState("networkidle");
    // Click the Payroll tab.
    await page.locator("button, a", { hasText: /^Payroll$/i }).first().click({ timeout: 10_000 });
    await page.waitForLoadState("networkidle");
    await page.screenshot({ path: path.join(OUT, "1-chris-payroll-overview.png"), fullPage: false });
    await page.screenshot({ path: path.join(OUT, "1b-chris-payroll-full.png"), fullPage: true });

    const bodyText = await page.locator("body").innerText();
    // All eight canonical section headings must appear. Slice A
    // closeout §9 removed the legacy "Compensation & Benefits" nested
    // heading; Recurring Earnings is the only accepted label.
    const requiredHeadings = [
      /Payroll Status/i,
      /Tax\s*&\s*Payment/i,
      /Base Compensation/i,
      /Recurring Earnings/i,
      /One-Time Earnings/i,
      /Benefits\s*&\s*Deductions/i,
      /Retirement/i,
      /Implementation\s*&\s*YTD/i,
    ];
    // Nested legacy heading must NOT appear anywhere on the page.
    expect(bodyText, "legacy 'Compensation & Benefits' heading must be removed").not.toMatch(
      /Compensation\s*&\s*Benefits/i,
    );
    for (const h of requiredHeadings) {
      expect(bodyText, `Expected heading ${h}`).toMatch(h);
    }

    // Original Hire Date + Spectre Activation are labelled distinctly.
    expect(bodyText).toMatch(/Original Hire Date/i);
    expect(bodyText).toMatch(/Spectre Activation/i);

    // No unsafe RRSP workaround exposed.
    expect(bodyText).toMatch(/RRSP/i);
    expect(bodyText).toMatch(/Not enrolled/i);

    // Implementation Declaration is currently Not configured.
    expect(bodyText).toMatch(/Not configured|Configure Payroll Implementation/i);
  });

  test("Payroll Settings → Payroll Implementation uses plain-language labels", async ({ context }) => {
    const page = await loginAsFounder(context, { landing: "/app/admin/payroll/setup" });
    await page.waitForLoadState("networkidle");
    await page.screenshot({ path: path.join(OUT, "2-payroll-settings-implementation.png"), fullPage: false });

    const bodyText = await page.locator("body").innerText();
    expect(bodyText, "expected Payroll implementation section heading").toMatch(/Payroll implementation/i);
    // The two founder-approved options must appear in plain language.
    expect(bodyText).toMatch(/Beginning-of-year/i);
    expect(bodyText).toMatch(/Mid-year migration/i);
    // The internal enum labels must NOT be exposed to the founder.
    expect(bodyText).not.toMatch(/ZERO_OPENING_YTD/);
    expect(bodyText).not.toMatch(/MID_YEAR_MIGRATION\b/);
  });

  test("Employment tab no longer exposes Recurring Allowances editor", async ({ context }) => {
    const page = await loginAsFounder(context, { landing: "/app/admin/people/employees" });
    await page.waitForLoadState("networkidle");
    const chrisLink = page.locator("a", { hasText: /Chris/i }).first();
    await chrisLink.click({ timeout: 20_000 });
    await page.waitForLoadState("networkidle");
    await page.locator("button, a", { hasText: /^Employment$/i }).first().click({ timeout: 10_000 });
    await page.waitForLoadState("networkidle");
    await page.screenshot({ path: path.join(OUT, "3-chris-employment-no-recurring-allowances.png"), fullPage: false });

    const bodyText = await page.locator("body").innerText();
    expect(bodyText, "Employment tab must NOT show Recurring allowances editor").not.toMatch(/Recurring allowances/i);
  });
});
