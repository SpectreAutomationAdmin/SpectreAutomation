// HR-2B.5 §47-49 founder journey (local Playwright acceptance).
//
// Strategy: the fixture augment script pre-completes About You /
// Payroll / Emergency / Documents (§10 explicitly permits reusing
// accepted HR-2B.2-2B.4 flows — don't redesign them). This spec
// walks only the HR-2B.5-new surfaces:
//
//   invitation redemption → resolver drops us at /portal-password →
//   Portal password step → Real Review → Submit → /complete →
//   handoff → Employee Portal Home + Pay + Schedule + Availability +
//   Documents + Profile + first-login tour + mobile home
//
// Also covers the employment-review no-correction / correction
// branches (§17-18) using a separate fixture at stage=employment.
//
// Captures §54 items 3-15 (13 screenshots). Items 1-2 (admin
// compensation) come from hr-2b5-admin-compensation.local.spec.ts.

import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const OUT = path.resolve("test-results/hr-2b5");
fs.mkdirSync(OUT, { recursive: true });

const INVITATION_SCRIPT = path.resolve("scripts/hr-2b2-fixture-invitation.mjs");
const COMP_SCRIPT = path.resolve("scripts/hr-2b5-fixture-augment.mjs");
const FIXTURE_PATH = path.resolve("test-results/hr-2b5-fixture.json");

const PORTAL_PASSWORD = "correct-horse-battery-staple-2026";

interface Fixture {
  employeeId: string;
  employeeFirstName: string;
  employeeLastName: string;
  redemptionUrl: string;
  hr2b5: { cadence: string; rate: string; stage: string };
}

function primeFixture(
  email: string,
  stage: "employment" | "portal-password" = "portal-password",
  cadence: "HOURLY" | "SALARY" = "HOURLY",
  rate = "22.50",
): Fixture {
  execFileSync("node", [INVITATION_SCRIPT, "--email", email], {
    cwd: path.resolve("."), stdio: ["ignore", "pipe", "pipe"], timeout: 60_000,
  });
  execFileSync("node", [COMP_SCRIPT, "--cadence", cadence, "--rate", rate, "--stage", stage], {
    cwd: path.resolve("."), stdio: ["ignore", "pipe", "pipe"], timeout: 60_000,
  });
  return JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8")) as Fixture;
}

async function beginOnboarding(page: Page, fixture: Fixture) {
  await page.goto(fixture.redemptionUrl, { waitUntil: "domcontentloaded" });
  // Redemption drops us on the token landing page; click Begin.
  const begin = page.locator('[data-testid="hr-onboarding-begin"]');
  if (await begin.count()) {
    await Promise.all([
      page.waitForURL(/\/hr\/onboarding\//, { timeout: 30_000 }),
      begin.click(),
    ]);
  }
}

test.describe("HR-2B.5 · Founder journey", () => {
  test.describe.configure({ mode: "serial" });

  test("employment review — 'Yes, everything looks right' hides correction inputs (§17)", async ({ page }) => {
    const fixture = primeFixture("hr-2b5-nocorr@spectre.test", "employment", "SALARY", "72000");
    await beginOnboarding(page, fixture);
    // Redemption may land us at /about-you/name (stage=employment
    // means nothing is acked yet). Walk to /employment.
    // Name step:
    if (/\/about-you\/name/.test(page.url())) {
      await page.locator('input[name="firstName"]').fill(fixture.employeeFirstName);
      await page.locator('input[name="lastName"]').fill(fixture.employeeLastName);
      await Promise.all([
        page.waitForURL(/\/about-you\/contact/, { timeout: 20_000 }),
        page.locator('button[type="submit"]').first().click(),
      ]);
    }
    if (/\/about-you\/contact/.test(page.url())) {
      await page.locator('input[name="personalEmail"]').fill("hr-2b5-nocorr@spectre.test");
      await page.locator('input[name="mobilePhone"]').fill("(403) 555-0170");
      await Promise.all([
        page.waitForURL(/\/about-you\/employment/, { timeout: 20_000 }),
        page.locator('button[type="submit"]').first().click(),
      ]);
    }
    // On /employment. "Yes" is default. Verify correction section
    // stays hidden (§17).
    await expect(page.locator('[data-testid="employment-outcome-correct"]')).toBeChecked();
    await expect(page.locator('[data-testid="correction-section"]')).toHaveCount(0);
    await page.screenshot({ path: path.join(OUT, "03-employment-review-no-correction.png"), fullPage: true });
  });

  test("employment review — correction branch reveals ONLY selected field (§18)", async ({ page }) => {
    const fixture = primeFixture("hr-2b5-corr@spectre.test", "employment", "HOURLY", "22.50");
    await beginOnboarding(page, fixture);
    if (/\/about-you\/name/.test(page.url())) {
      await page.locator('input[name="firstName"]').fill(fixture.employeeFirstName);
      await page.locator('input[name="lastName"]').fill(fixture.employeeLastName);
      await Promise.all([
        page.waitForURL(/\/about-you\/contact/, { timeout: 20_000 }),
        page.locator('button[type="submit"]').first().click(),
      ]);
    }
    if (/\/about-you\/contact/.test(page.url())) {
      await page.locator('input[name="personalEmail"]').fill("hr-2b5-corr@spectre.test");
      await page.locator('input[name="mobilePhone"]').fill("(403) 555-0170");
      await Promise.all([
        page.waitForURL(/\/about-you\/employment/, { timeout: 20_000 }),
        page.locator('button[type="submit"]').first().click(),
      ]);
    }
    // Flip to correction.
    await page.locator('[data-testid="employment-outcome-correction"]').check();
    await expect(page.locator('[data-testid="correction-section"]')).toBeVisible();
    // Before ticking anything, all per-field text wrappers hidden.
    await expect(page.locator('[data-testid="correction-value-wrapper-positionId"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="correction-value-wrapper-expectedStartDate"]')).toHaveCount(0);
    // Tick expectedStartDate → its wrapper appears, others stay absent.
    await page.locator('[data-testid="correction-expectedStartDate-enabled"]').check();
    await expect(page.locator('[data-testid="correction-value-wrapper-expectedStartDate"]')).toBeVisible();
    await expect(page.locator('[data-testid="correction-value-wrapper-positionId"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="correction-value-wrapper-departmentId"]')).toHaveCount(0);
    await page.locator('[data-testid="correction-expectedStartDate-value"]').fill("September 21, 2026");
    await page.screenshot({ path: path.join(OUT, "04-employment-review-correction-expanded.png"), fullPage: true });
  });

  test("portal-password → review → submit → complete → portal + tour + mobile", async ({ page }) => {
    const fixture = primeFixture("hr-2b5-full@spectre.test", "portal-password", "HOURLY", "22.50");
    await beginOnboarding(page, fixture);
    // The resolver drops us at /portal-password (fixture pre-completed
    // every prior stage).
    await page.waitForURL(/\/portal-password/, { timeout: 30_000 });

    // === Portal password step (§5) ===
    await expect(page.locator('[data-testid="portal-employee-number"]')).toBeVisible();
    await page.screenshot({ path: path.join(OUT, "05-portal-password-setup.png"), fullPage: true });

    await page.locator('[data-testid="portal-password-input"]').fill(PORTAL_PASSWORD);
    await page.locator('[data-testid="portal-password-confirm"]').fill(PORTAL_PASSWORD);
    await Promise.all([
      page.waitForURL(/\/hr\/onboarding\/review/, { timeout: 20_000 }),
      page.locator('[data-testid="portal-password-submit"]').click(),
    ]);

    // === Review (§20-26) ===
    await expect(page.locator('[data-testid="review-root"]')).toBeVisible();
    await expect(page.locator('[data-testid="review-section-payroll"]')).toContainText("XXX XXX");
    await expect(page.locator('[data-testid="review-portal-username"]')).toBeVisible();
    await expect(page.locator('[data-testid="review-portal-password-mask"]')).toContainText("•");
    await page.screenshot({ path: path.join(OUT, "06-final-review.png"), fullPage: true });

    // Attest + Submit.
    await page.locator('[data-testid="review-attestation-checkbox"]').check();
    await Promise.all([
      page.waitForURL(/\/hr\/onboarding\/complete/, { timeout: 20_000 }),
      page.locator('[data-testid="review-submit-button"]').click(),
    ]);

    // === Submitted / handoff (§29-31) ===
    await expect(page.locator('[data-testid="complete-continue-to-portal"]')).toBeVisible();
    await expect(page.locator('[data-testid="complete-employee-number"]')).toBeVisible();
    await page.screenshot({ path: path.join(OUT, "07-submitted-handoff.png"), fullPage: true });

    // === Idempotence check (§46): re-visit /review should route to /complete ===
    await page.goto("http://localhost:3000/hr/onboarding/review");
    await page.waitForURL(/\/hr\/onboarding\/complete/, { timeout: 15_000 });

    // === Portal handoff → /employee ===
    await Promise.all([
      page.waitForURL(/\/employee$/, { timeout: 20_000 }),
      page.locator('[data-testid="complete-continue-to-portal"]').click(),
    ]);
    await expect(page.locator('[data-testid="portal-home"]')).toBeVisible();

    // === Home + tour ===
    await expect(page.locator('[data-testid="portal-tour"]')).toBeVisible();
    await page.screenshot({ path: path.join(OUT, "08-portal-home.png"), fullPage: true });
    await page.locator('[data-testid="portal-tour-next"]').click();
    await expect(page.locator('[data-testid="portal-tour-title"]')).toContainText("Pay");
    await page.screenshot({ path: path.join(OUT, "14-guided-tour.png"), fullPage: true });
    await page.locator('[data-testid="portal-tour-skip"]').click();
    // After skip the tour should stop rendering.
    await expect(page.locator('[data-testid="portal-tour"]')).toHaveCount(0);

    // === Portal routes (§34-38) ===
    await page.goto("http://localhost:3000/employee/pay");
    await expect(page.locator('[data-testid="portal-pay-empty"]')).toBeVisible();
    await page.screenshot({ path: path.join(OUT, "09-portal-pay.png"), fullPage: true });

    await page.goto("http://localhost:3000/employee/schedule");
    await expect(page.locator('[data-testid="portal-schedule-empty"]')).toBeVisible();
    await page.screenshot({ path: path.join(OUT, "10-portal-schedule.png"), fullPage: true });

    await page.goto("http://localhost:3000/employee/availability");
    await expect(page.locator('[data-testid="portal-availability-empty"]')).toBeVisible();
    await page.screenshot({ path: path.join(OUT, "11-portal-availability.png"), fullPage: true });

    await page.goto("http://localhost:3000/employee/documents");
    await expect(page.locator('[data-testid="portal-documents"]')).toBeVisible();
    await page.screenshot({ path: path.join(OUT, "12-portal-documents.png"), fullPage: true });

    await page.goto("http://localhost:3000/employee/profile");
    await expect(page.locator('[data-testid="portal-profile"]')).toBeVisible();
    // No compensation surface (§14, §38).
    await expect(page.locator('body')).not.toContainText("Hourly rate");
    await expect(page.locator('body')).not.toContainText("Annual salary");
    await page.screenshot({ path: path.join(OUT, "13-portal-profile.png"), fullPage: true });

    // === Mobile (§18, §49) ===
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("http://localhost:3000/employee");
    await expect(page.locator('[data-testid="portal-home"]')).toBeVisible();
    // No horizontal overflow.
    const hasHOverflow = await page.evaluate(() => {
      const html = document.documentElement;
      return html.scrollWidth > html.clientWidth + 1;
    });
    expect(hasHOverflow).toBe(false);
    await page.screenshot({ path: path.join(OUT, "15-mobile-portal-home.png"), fullPage: true });
  });
});
