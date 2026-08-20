// HR-2B.5 blocker regression (2026-08-20).
//
// Pins the founder-reported staging defect: after Provincial TD1 the
// employee landed on /hr/onboarding/payroll/complete with a disabled
// "Continue (available soon)" button — a dead-end left over from the
// HR-2B.3 boundary. HR-2B.4 already implemented Emergency + Documents
// and HR-2B.5 implemented Portal Password / Review / Submit / Portal,
// so any post-payroll stop that is not the canonical resolver's next
// step is a live regression.
//
// This spec proves:
//   1. A direct visit to /hr/onboarding/payroll/complete FORWARDS via
//      the canonical continuation resolver — it never renders its own
//      terminal card + never contains "available soon".
//   2. The onboarding flow from an "everything up to Portal Password"
//      fixture lands on /portal-password, NOT /payroll/complete.
//   3. Continuing through Portal Password + Review + Submit lands the
//      employee on the /complete handoff and then the Employee Portal.
//
// Uses the shared HR-2B.5 fixture — no invitation-token surface leak.

import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const OUT = path.resolve("test-results/hr-2b5-blocker");
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
}

function primeFixture(email: string): Fixture {
  execFileSync("node", [INVITATION_SCRIPT, "--email", email], {
    cwd: path.resolve("."), stdio: ["ignore", "pipe", "pipe"], timeout: 60_000,
  });
  execFileSync("node", [COMP_SCRIPT, "--cadence", "HOURLY", "--rate", "22.50", "--stage", "portal-password"], {
    cwd: path.resolve("."), stdio: ["ignore", "pipe", "pipe"], timeout: 60_000,
  });
  return JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8")) as Fixture;
}

async function establishSessionCookie(page: Page, fixture: Fixture) {
  // Redeem the invitation. This stamps the onboarding session cookie
  // and forwards through /session to the resolver's next step.
  await page.goto(fixture.redemptionUrl, { waitUntil: "domcontentloaded" });
  const begin = page.locator('[data-testid="hr-onboarding-begin"]');
  if (await begin.count()) {
    await Promise.all([
      page.waitForURL(/\/hr\/onboarding\/(?!\/?$).+/, { timeout: 30_000 }),
      begin.click(),
    ]);
  }
}

test.describe("HR-2B.5 blocker regression · /payroll/complete never strands", () => {
  test.describe.configure({ mode: "serial" });

  test("direct visit to /hr/onboarding/payroll/complete forwards through resolver (never displays 'available soon')", async ({ page }) => {
    const fixture = primeFixture("hr-2b5-blocker-direct@spectre.test");
    await establishSessionCookie(page, fixture);
    // Now the session cookie is stamped. Navigate directly at the
    // obsolete boundary — the page must FORWARD, not render.
    await page.goto("http://localhost:3000/hr/onboarding/payroll/complete", {
      waitUntil: "domcontentloaded",
    });
    // Resolver for stage=portal-password fixture → /portal-password.
    await expect(page).toHaveURL(/\/hr\/onboarding\/(portal-password|emergency|documents|review|complete)/, {
      timeout: 20_000,
    });
    // Negative assertion: no dead-end copy anywhere on the resolved
    // page.
    const bodyText = await page.locator("body").innerText();
    expect(bodyText.toLowerCase()).not.toContain("available soon");
    expect(bodyText.toLowerCase()).not.toContain("available shortly");
    expect(bodyText.toLowerCase()).not.toContain("continue (available");
    // Screenshot the forwarded page for the corrective-checkpoint
    // evidence.
    await page.screenshot({ path: path.join(OUT, "payroll-complete-forwarded.png"), fullPage: true });
  });

  test("continuous journey: post-payroll fixture → portal-password → review → submit → complete → portal", async ({ page }) => {
    const fixture = primeFixture("hr-2b5-blocker-journey@spectre.test");
    await establishSessionCookie(page, fixture);
    // Should land at /portal-password (Payroll + Emergency + Documents
    // pre-completed by the fixture).
    await expect(page).toHaveURL(/\/portal-password/, { timeout: 20_000 });

    // Complete portal password.
    await page.locator('[data-testid="portal-password-input"]').fill(PORTAL_PASSWORD);
    await page.locator('[data-testid="portal-password-confirm"]').fill(PORTAL_PASSWORD);
    await Promise.all([
      page.waitForURL(/\/hr\/onboarding\/review/, { timeout: 20_000 }),
      page.locator('[data-testid="portal-password-submit"]').click(),
    ]);
    // Review page renders.
    await expect(page.locator('[data-testid="review-root"]')).toBeVisible();
    // No "available soon" copy anywhere in the Review page.
    const reviewText = await page.locator("body").innerText();
    expect(reviewText.toLowerCase()).not.toContain("available soon");

    // Attest + Submit.
    await page.locator('[data-testid="review-attestation-checkbox"]').check();
    await Promise.all([
      page.waitForURL(/\/hr\/onboarding\/complete/, { timeout: 20_000 }),
      page.locator('[data-testid="review-submit-button"]').click(),
    ]);
    // /complete renders the real handoff CTA.
    await expect(page.locator('[data-testid="complete-continue-to-portal"]')).toBeVisible();
    const completeText = await page.locator("body").innerText();
    expect(completeText.toLowerCase()).not.toContain("available soon");

    // Handoff → /employee.
    await Promise.all([
      page.waitForURL(/\/employee$/, { timeout: 20_000 }),
      page.locator('[data-testid="complete-continue-to-portal"]').click(),
    ]);
    await expect(page.locator('[data-testid="portal-home"]')).toBeVisible();
    const homeText = await page.locator("body").innerText();
    expect(homeText.toLowerCase()).not.toContain("available soon");
  });
});
