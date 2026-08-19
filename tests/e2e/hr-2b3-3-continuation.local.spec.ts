// HR-2B.3.3 (2026-08-18) — Founder-regression pin.
//
// Founder reported on staging: after completing About You they
// landed on /hr/onboarding/about-you/complete, clicked
// "Continue to payroll", and were sent BACKWARD into the About
// You section. Root cause: the resolver treated the optional
// `Employee.preferredName` field as mandatory. Fix: introduced
// two durable `about_you_name_confirmation` +
// `about_you_contact_confirmation` acknowledgement rows written
// by saveNameAction / saveContactAction. Resolver + layout now
// consume the acks — single source of truth.
//
// This spec walks the founder path end to end and asserts:
//   • URL never rewinds into /about-you/* after leaving /complete
//   • Continue-to-payroll lands directly on /payroll/sin
//   • Progress rail marks "About you" as complete + "Payroll" as current
//   • SIN entry proceeds through to /direct-deposit (unchanged)

import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const OUT = path.resolve("test-results/hr-2b3-3-continuation");
fs.mkdirSync(OUT, { recursive: true });

const FIXTURE_PATH_DEFAULT = path.resolve("test-results/hr-2b2-fixture.json");
const FIXTURE_SCRIPT = path.resolve("scripts/hr-2b2-fixture-invitation.mjs");

// Synthetic Luhn-valid SIN, same pinned test value as HR-2B.3.
const SIN_PRIMARY = "046 454 286";
const SIN_PRIMARY_LASTTHREE = "286";

// Minimum valid 1×1 PNG for the photo step.
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);

interface Fixture {
  employeeFirstName: string;
  employeeLastName: string;
  redemptionUrl: string;
}

function primeFixture(email: string): Fixture {
  execFileSync("node", [FIXTURE_SCRIPT, "--email", email], {
    cwd: path.resolve("."),
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60_000,
  });
  return JSON.parse(fs.readFileSync(FIXTURE_PATH_DEFAULT, "utf8")) as Fixture;
}

/** Walk About You WITHOUT filling any optional preferredName field.
 *  This is the FOUNDER'S EXACT PATH — the field that triggered the
 *  regression is left blank. */
async function walkAboutYouWithoutPreferredName(page: Page, fixture: Fixture) {
  await page.goto(fixture.redemptionUrl, { waitUntil: "domcontentloaded" });
  await Promise.all([
    page.waitForURL(/\/hr\/onboarding\/about-you\/name/, { timeout: 30_000 }),
    page.locator('[data-testid="hr-onboarding-begin"]').click(),
  ]);
  // Fill only firstName + lastName. preferredName intentionally blank.
  await page.locator('input[name="firstName"]').fill(fixture.employeeFirstName);
  await page.locator('input[name="lastName"]').fill(fixture.employeeLastName);
  await Promise.all([
    page.waitForURL(/\/hr\/onboarding\/about-you\/contact/, { timeout: 20_000 }),
    page.locator('button[type="submit"]').first().click(),
  ]);
  await page.locator('input[name="personalEmail"]').fill("hr-2b33-continuation@spectre.test");
  await page.locator('input[name="mobilePhone"]').fill("(403) 555-0111");
  await Promise.all([
    page.waitForURL(/\/hr\/onboarding\/about-you\/employment/, { timeout: 20_000 }),
    page.locator('button[type="submit"]').first().click(),
  ]);
  await page.locator('[data-testid="employment-outcome-correct"]').check();
  await Promise.all([
    page.waitForURL(/\/hr\/onboarding\/about-you\/photo/, { timeout: 20_000 }),
    page.locator('button[type="submit"]').first().click(),
  ]);
  await page.setInputFiles(
    '[data-testid="photo-choose-input"]',
    { name: "me.png", mimeType: "image/png", buffer: TINY_PNG },
  );
  await expect(page.locator('img[alt="Selected photo preview"]')).toBeVisible();
  await Promise.all([
    page.waitForURL(/\/hr\/onboarding\/about-you\/complete/, { timeout: 30_000 }),
    page.locator('button[type="submit"]').first().click(),
  ]);
}

test.describe.serial("HR-2B.3.3 · Continue-to-payroll must never rewind (founder regression)", () => {
  test.setTimeout(300_000);

  test("§7 · complete About You (preferredName blank) → Continue advances directly to /payroll/sin, never revisits /about-you/*", async ({ browser }) => {
    const fixture = primeFixture("hr-2b33-continue-regression@spectre.test");
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();

    // Record every URL Playwright navigates to so we can prove the
    // NEGATIVE assertion: the browser never returns to any
    // /about-you/* step after leaving /complete.
    const visited: string[] = [];
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) visited.push(frame.url());
    });

    try {
      await walkAboutYouWithoutPreferredName(page, fixture);
      // We're now on /about-you/complete. Snapshot the length so we
      // can slice the "post-complete" tail out of `visited`.
      const idxComplete = visited.findIndex((u) => u.includes("/about-you/complete"));
      expect(idxComplete).toBeGreaterThanOrEqual(0);

      // Click "Continue to payroll". BEFORE the fix, this landed on
      // /about-you/name (backward). AFTER: /payroll/sin.
      await Promise.all([
        page.waitForURL(/\/hr\/onboarding\/payroll\/sin$/, { timeout: 20_000 }),
        page.locator('[data-testid="continue-to-payroll"]').click(),
      ]);

      // POST-COMPLETE URL TAIL — must NOT contain any /about-you/* step.
      const postComplete = visited.slice(idxComplete + 1);
      const aboutYouRewinds = postComplete.filter((u) => /\/hr\/onboarding\/about-you\//.test(u));
      expect(
        aboutYouRewinds,
        `expected no rewind into /about-you/* after /complete, saw: ${JSON.stringify(aboutYouRewinds)}`,
      ).toEqual([]);

      // Progress-rail assertions (payroll layout is now rendering):
      //   • "About you" parent row is COMPLETE (emerald dot)
      //   • "Payroll" parent row is CURRENT (bold + darker dot)
      // The rail marks completion with .bg-emerald-700 on the dot;
      // current-not-done stages use .bg-stone-900 on the dot. Use the
      // aria-current="step" attribute the OnboardingProgressRail sets.
      const rail = page.getByRole("navigation", { name: /onboarding progress/i });
      await expect(rail).toBeVisible();
      // About you row: find the <li> whose text contains "About you"
      // AND has a completed indicator. sr-only "completed" span is
      // present when done=true.
      const aboutYouRow = rail.locator("li").filter({ hasText: /^About you$/ }).first();
      await expect(aboutYouRow.locator(".sr-only")).toContainText(/completed/i);
      // Payroll row: aria-current="step" identifies current stage.
      const payrollRow = rail.locator('[aria-current="step"]').filter({ hasText: /Payroll/ });
      await expect(payrollRow).toBeVisible();

      await page.screenshot({
        path: path.join(OUT, "post-continue-rail-desktop.png"),
        fullPage: true,
      });

      // Continue: SIN entry should still work end-to-end.
      await page.locator('[data-testid="sin-input"]').fill(SIN_PRIMARY);
      await Promise.all([
        page.waitForURL(/\/hr\/onboarding\/payroll\/direct-deposit/, { timeout: 30_000 }),
        page.locator('button[type="submit"]').first().click(),
      ]);

      // Revisit SIN → masked state.
      await page.goto("http://localhost:3000/hr/onboarding/payroll/sin", { waitUntil: "domcontentloaded" });
      await expect(page.locator('[data-testid="sin-masked"]')).toContainText(`XXX XXX ${SIN_PRIMARY_LASTTHREE}`);
    } finally {
      await ctx.close();
    }
  });
});
