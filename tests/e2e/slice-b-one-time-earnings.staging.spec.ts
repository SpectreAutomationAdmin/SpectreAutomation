// Slice B (2026-09-18) — Employee Payroll One-Time Earnings section
// acceptance at 1440×900 on the live staging tenant.
//
// Read-only. Does NOT save one-time earnings against Chris or Marc.

import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

const OUT = path.resolve("test-results/slice-b-one-time-earnings");
fs.mkdirSync(OUT, { recursive: true });

test.use({ viewport: { width: 1440, height: 900 } });

test.describe("Slice B — One-Time Earnings on Employee Payroll", () => {
  test.beforeAll(() => {
    const status = stagingCredsAvailable();
    if (!status.ready) test.skip(true, status.reason ?? "staging creds not set");
  });

  test("Chris → Payroll → One-Time Earnings section renders with the new IA + empty state", async ({ context }) => {
    const page = await loginAsFounder(context, { landing: "/app/admin/people/employees" });
    await page.waitForLoadState("networkidle");
    const chrisLink = page.locator("a", { hasText: /Chris/i }).first();
    await chrisLink.click({ timeout: 20_000 });
    await page.waitForLoadState("networkidle");
    await page.locator("button, a", { hasText: /^Payroll$/i }).first().click({ timeout: 10_000 });
    await page.waitForLoadState("networkidle");
    await page.screenshot({ path: path.join(OUT, "1-chris-payroll-full.png"), fullPage: true });
    await page.screenshot({ path: path.join(OUT, "1b-chris-payroll-viewport.png"), fullPage: false });

    const bodyText = await page.locator("body").innerText();
    // The Slice-B section replaces the Slice-A empty-state placeholder.
    expect(bodyText).toMatch(/One-Time Earnings/i);
    expect(bodyText).toMatch(/No one-time earnings scheduled\./i);
    // Slice-A heading rename still in place.
    expect(bodyText).toMatch(/Recurring Earnings/i);
    expect(bodyText, "legacy 'Compensation & Benefits' heading must remain removed").not.toMatch(
      /Compensation\s*&\s*Benefits/i,
    );
    // We are read-only on Chris — the Add button may be present but must not be clicked.
    // The section container should exist.
    const section = page.locator('[data-testid="payroll-one-time-earnings-slice-b"]');
    await expect(section).toHaveCount(1);
    await section.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(OUT, "2-one-time-earnings-empty-state.png"), fullPage: false });
  });
});
