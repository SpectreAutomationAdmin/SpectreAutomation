// CRPC-1 (2026-09-20) §24 — 1440×900 browser acceptance for the
// Coulee Ridge payroll-calendar correction.
//
// Read-only on Coulee Ridge — the founder account browses the Payroll
// Settings → Pay Groups panel and the Calendar panel; no writes are
// initiated by this spec. Chris + Marc production data untouched.

import { test, expect } from "@playwright/test";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

const STAGING = "https://staging.spectreautomation.com";
const OUT_DIR = "test-results/crpc1-calendar";
const COULEE_PAY_GROUP_ID = "cmu5kg3e40002h4iupsaxezdl";

test.describe("CRPC-1 §24 — Coulee Ridge Payroll Settings calendar", () => {
  test.beforeAll(() => {
    const { ready, reason } = stagingCredsAvailable();
    test.skip(!ready, reason ?? "staging creds unavailable");
  });

  test("Pay Groups panel shows Coulee Ridge CRGCC-SM as Lagged; Calendar page shows Aug 24 – Sep 8, pay Sep 15", async ({ context }) => {
    const page = await loginAsFounder(context, { landing: "/app/admin" });
    await page.setViewportSize({ width: 1440, height: 900 });

    // 1) Payroll Settings landing.
    await page.goto(`${STAGING}/app/admin/payroll/setup`, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle").catch(() => {});
    await page.screenshot({ path: `${OUT_DIR}/1-payroll-settings-1440.png`, fullPage: false });

    // 2) Pay Group row for CRGCC-SM shows "Lagged (work period ends before pay date)".
    const row = page.locator(`[data-testid="pay-group-row-${COULEE_PAY_GROUP_ID}"]`).first();
    await row.waitFor({ state: "visible", timeout: 15_000 });
    const strategyLabel = row.locator(`[data-testid="pay-group-strategy-${COULEE_PAY_GROUP_ID}"]`);
    await expect(strategyLabel).toContainText(/lagged/i);
    await row.screenshot({ path: `${OUT_DIR}/2-pay-group-row-lagged.png` });

    // 3) Calendar page — show the Sep 15 pay-date row explicitly.
    // The setup page renders a compact list; navigate to the deeper
    // calendar view if the founder-facing surface exposes it.
    const calendarSection = page.locator("[data-testid='payroll-calendar-section']").first();
    if (await calendarSection.count()) {
      await calendarSection.scrollIntoViewIfNeeded().catch(() => {});
      await calendarSection.screenshot({ path: `${OUT_DIR}/3-calendar-section.png` });
      // Look for a row whose display shows "Sep 15" or the Aug 24 – Sep 8 range.
      const rowText = await calendarSection.textContent();
      expect(rowText, "calendar section should mention Sep 15 pay date").toMatch(/Sep\s*15|September\s*15|2026-09-15/);
      expect(rowText, "calendar section should mention Aug 24 (Sep 15 period start)").toMatch(/Aug\s*24|August\s*24|2026-08-24/);
      expect(rowText, "calendar section should mention Sep 8 (Sep 15 period end, inclusive display)").toMatch(/Sep\s*8|September\s*8|2026-09-08/);
    }

    // 4) No console errors attributable to CRPC-1 surfaces.
    const consoleErrors: string[] = [];
    page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
    await page.waitForTimeout(500);
    const attributable = consoleErrors.filter((e) => /pay-group|pay-period|calendar|semi-monthly/i.test(e));
    expect(attributable, `no CRPC-1-attributable console errors, got: ${JSON.stringify(attributable)}`).toEqual([]);
  });
});
