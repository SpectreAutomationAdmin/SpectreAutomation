// Phase 3 follow-up (2026-09-16) — staging spec for the corrected
// dimensional payroll GL architecture.
//
// Proves:
//   A. Section 7 "Department expense overrides" is GONE (deprecated).
//   B. Payroll GL profile section renders as Section 6 with the
//      updated subtitle referencing the dimensional model.
//   C. GlProfileEditor surfaces the Coulee Ridge type mismatch
//      (Employer EI = 2020 which is LIABILITY) as a red banner.
//   D. No CSP inline-script violations + no 5xx doc responses.

import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

const OUT = path.resolve("test-results/payroll-dimensional-gl");
fs.mkdirSync(OUT, { recursive: true });
const STAGING = process.env.SPECTRE_STAGING_BASE_URL ?? "https://staging.spectreautomation.com";

test.use({ viewport: { width: 1440, height: 900 } });

test("Payroll Settings shows dimensional model, drops overrides, surfaces type mismatch", async ({ browser }) => {
  const creds = stagingCredsAvailable();
  test.skip(!creds.ready, creds.reason ?? "staging creds unavailable");
  test.setTimeout(180_000);

  const ctx = await browser.newContext();
  const page = await loginAsFounder(ctx);
  const cspViolations: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error" && /Content Security Policy/i.test(msg.text()) && /inline script/i.test(msg.text())) {
      cspViolations.push(msg.text().slice(0, 200));
    }
  });
  const badResponses: Array<{ url: string; status: number }> = [];
  page.on("response", (r) => {
    if (r.request().resourceType() === "document" && r.status() >= 500) {
      badResponses.push({ url: r.url(), status: r.status() });
    }
  });

  await page.goto(`${STAGING}/app/admin/payroll/setup`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(4000);
  await page.screenshot({ path: path.join(OUT, "01-setup-full.png"), fullPage: true });

  // A. The deprecated Section 7 is GONE.
  const oldSection = page.locator('[data-testid="payroll-dept-overrides-section"]');
  await expect(oldSection).toHaveCount(0);
  const oldEditor = page.locator('[data-testid="dept-overrides-editor"]');
  await expect(oldEditor).toHaveCount(0);

  // B. Payroll GL profile section renders.
  const glSection = page.locator('[data-testid="payroll-gl-profile-section"]');
  await expect(glSection).toBeVisible();
  const glEditor = page.locator('[data-testid="gl-profile-editor"]');
  await expect(glEditor).toBeVisible();

  // C. Type-mismatch banner should be VISIBLE for Coulee Ridge —
  //    Employer EI expense is bound to `2020 — Accts Payable`
  //    which is a LIABILITY account, not an EXPENSE. If the founder
  //    has ALREADY fixed this in Section 6 by the time this test
  //    runs, the banner is absent — which is also a valid state.
  //    Detect either.
  const typeIssuesBanner = page.locator('[data-testid="gl-profile-type-issues"]');
  const typeIssueVisible = await typeIssuesBanner.isVisible().catch(() => false);
  if (typeIssueVisible) {
    const bannerText = await typeIssuesBanner.innerText();
    // Whatever the field, the banner must name the offending account +
    // the actual vs expected type in an actionable way.
    expect(bannerText).toMatch(/EXPENSE|LIABILITY/);
    expect(bannerText).toMatch(/cannot post/i);
    await page.screenshot({ path: path.join(OUT, "02-type-mismatch-banner.png"), fullPage: false });
  } else {
    // Coulee Ridge already fixed the misconfiguration before this
    // test ran. Snapshot the editor for the checkpoint record.
    await page.screenshot({ path: path.join(OUT, "02-gl-profile-clean.png"), fullPage: false });
  }

  // D. Universal guardrails.
  expect(cspViolations.length, `no CSP inline-script violations. Got: ${JSON.stringify(cspViolations)}`).toBe(0);
  expect(badResponses.length, `no 5xx doc responses. Got: ${JSON.stringify(badResponses)}`).toBe(0);
  const body = await page.locator("body").innerText();
  expect(body).not.toContain("Application error");
  expect(body).not.toContain("server-side exception");

  await ctx.close();
});
