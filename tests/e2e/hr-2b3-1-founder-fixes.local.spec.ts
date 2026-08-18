// HR-2B.3.1 (2026-08-18) — Local Playwright acceptance for the
// founder-fix bundle:
//   §10 SIN regression  — SIN entry must not crash the onboarding
//                          page (previously 500'd from a server-
//                          component cookie mutation).
//   §11 Selfie contract  — Photo step offers TWO explicit paths
//                          ("Take a selfie" with capture="user";
//                          "Choose a photo" with no capture attr)
//                          both submitting under name="photo".
//
// Runs against a local `npm run dev` server that Playwright auto-
// starts via the `webServer` block in playwright.config.ts. All
// fixtures are primed via `scripts/hr-2b2-fixture-invitation.mjs`
// with distinct emails per case.
//
// Screenshots land under test-results/hr-2b3-1-founder-fixes/.

import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const OUT = path.resolve("test-results/hr-2b3-1-founder-fixes");
fs.mkdirSync(OUT, { recursive: true });

const FIXTURE_PATH_DEFAULT = path.resolve("test-results/hr-2b2-fixture.json");
const FIXTURE_SCRIPT = path.resolve("scripts/hr-2b2-fixture-invitation.mjs");

// Synthetic Luhn-valid SIN — pinned per HR-2B.3 test values.
const SIN_PRIMARY = "046 454 286";
const SIN_PRIMARY_DIGITS = "046454286";
const SIN_PRIMARY_LASTTHREE = "286";

interface Fixture {
  clubId: string;
  clubName: string;
  employeeId: string;
  employeeFirstName: string;
  employeeLastName: string;
  employeePreferredName: string | null;
  departmentId: string;
  departmentName: string;
  positionId: string;
  positionName: string;
  employmentType: string;
  expectedStartDate: string | null;
  sessionId: string;
  invitationId: string;
  rawToken: string;
  expiresAt: string;
  redemptionUrl: string;
}

function readFixture(fixturePath = FIXTURE_PATH_DEFAULT): Fixture {
  if (!fs.existsSync(fixturePath)) {
    throw new Error(`[hr-2b3-1-spec] fixture file missing: ${fixturePath}`);
  }
  return JSON.parse(fs.readFileSync(fixturePath, "utf8")) as Fixture;
}

function primeFixture(email: string): Fixture {
  execFileSync("node", [FIXTURE_SCRIPT, "--email", email], {
    cwd: path.resolve("."),
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60_000,
  });
  return readFixture();
}

// Minimum valid 1x1 PNG.
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);

/** Terse About-You walk that stops at the photo step (used by §11
 *  where the photo step is the assertion target). Skips submitting
 *  the photo — the caller decides which of the two paths to exercise. */
async function walkAboutYouUntilPhoto(page: Page, fixture: Fixture) {
  await page.goto(fixture.redemptionUrl, { waitUntil: "domcontentloaded" });
  await Promise.all([
    page.waitForURL(/\/hr\/onboarding\/about-you\/name/, { timeout: 30_000 }),
    page.locator('[data-testid="hr-onboarding-begin"]').click(),
  ]);
  await page.locator('input[name="firstName"]').fill(fixture.employeeFirstName);
  await page.locator('input[name="lastName"]').fill(fixture.employeeLastName);
  await Promise.all([
    page.waitForURL(/\/hr\/onboarding\/about-you\/contact/, { timeout: 20_000 }),
    page.locator('button[type="submit"]').first().click(),
  ]);
  await page.locator('input[name="personalEmail"]').fill("founder-fixes@spectre.test");
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
}

/** Full About-You walk including a photo upload, so the payroll step
 *  is reachable. Uses the "Choose a photo" input to exercise the new
 *  path. */
async function walkAboutYouWithPhoto(page: Page, fixture: Fixture) {
  await walkAboutYouUntilPhoto(page, fixture);
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

test.describe.serial("HR-2B.3.1 · founder-fixes local acceptance", () => {
  test.setTimeout(300_000);

  // ---------------------------------------------------------------------
  // §10 · SIN regression — no crash on submit; masked on revisit; no
  // full SIN in the URL or DOM after submission.
  // ---------------------------------------------------------------------
  test("§10 · SIN entry does not crash the page (regression)", async ({ browser }) => {
    const fixture = primeFixture("hr-2b3-1-sin-regression@spectre.test");
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();

    // Fail hard on any 5xx during this case — pre-fix we saw a 500
    // page.render error from the server-component cookie mutation.
    const serverErrors: string[] = [];
    page.on("response", (resp) => {
      const url = resp.url();
      const status = resp.status();
      if (status >= 500 && url.includes("/hr/onboarding/")) {
        serverErrors.push(`${status} ${url}`);
      }
    });

    try {
      await walkAboutYouWithPhoto(page, fixture);
      // Continue to payroll.
      await Promise.all([
        page.waitForURL(/\/hr\/onboarding\/payroll/, { timeout: 20_000 }),
        page.locator('[data-testid="continue-to-payroll"]').click(),
      ]);
      await page.waitForURL(/\/hr\/onboarding\/payroll\/sin$/, { timeout: 20_000 });

      // ---------- Submit SIN ----------
      await page.locator('[data-testid="sin-input"]').fill(SIN_PRIMARY);
      const [urlAfterSubmit] = await Promise.all([
        page.waitForURL(/\/hr\/onboarding\/payroll\/direct-deposit/, { timeout: 30_000 }).then(() => page.url()),
        page.locator('button[type="submit"]').first().click(),
      ]);
      // §10 — the URL must not carry the SIN.
      expect(urlAfterSubmit).not.toContain(SIN_PRIMARY_DIGITS);
      expect(urlAfterSubmit).not.toMatch(/[?&]sin=/i);

      // ---------- Revisit SIN — masked ----------
      await page.goto("http://localhost:3000/hr/onboarding/payroll/sin", { waitUntil: "domcontentloaded" });
      await expect(page.locator('[data-testid="sin-masked"]')).toContainText(`XXX XXX ${SIN_PRIMARY_LASTTHREE}`);
      // §10 — the rendered HTML must not carry the full plaintext SIN.
      const html = await page.content();
      expect(html.includes(SIN_PRIMARY_DIGITS)).toBeFalsy();
      await page.screenshot({ path: path.join(OUT, "sin-masked-after-submit-desktop.png"), fullPage: true });

      // §10 — zero server errors observed during the entire case.
      expect(
        serverErrors,
        `expected no 5xx on /hr/onboarding/* during SIN entry, saw: ${JSON.stringify(serverErrors)}`,
      ).toEqual([]);
    } finally {
      await ctx.close();
    }
  });

  // ---------------------------------------------------------------------
  // §11 · Selfie contract — mobile viewport renders BOTH buttons;
  // hidden inputs have the correct capture attribute; both paths
  // populate the preview.
  // ---------------------------------------------------------------------
  test("§11 · photo step offers Take a selfie + Choose a photo (mobile)", async ({ browser }) => {
    const fixture = primeFixture("hr-2b3-1-selfie-fixture@spectre.test");
    const ctx = await browser.newContext({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
      deviceScaleFactor: 2,
    });
    const page = await ctx.newPage();

    try {
      await walkAboutYouUntilPhoto(page, fixture);

      // Both buttons render.
      const selfieBtn = page.locator('[data-testid="photo-selfie-button"]');
      const chooseBtn = page.locator('[data-testid="photo-choose-button"]');
      await expect(selfieBtn).toBeVisible();
      await expect(selfieBtn).toHaveText(/Take a selfie/);
      await expect(chooseBtn).toBeVisible();
      await expect(chooseBtn).toHaveText(/Choose a photo/);

      // Hidden inputs have the correct capture attributes.
      const selfieInput = page.locator('[data-testid="photo-selfie-input"]');
      const chooseInput = page.locator('[data-testid="photo-choose-input"]');
      await expect(selfieInput).toHaveAttribute("capture", "user");
      // Choose input has no capture attribute (null).
      const chooseCapture = await chooseInput.getAttribute("capture");
      expect(
        chooseCapture,
        "choose input must NOT carry a capture attribute so it opens the device picker",
      ).toBeNull();
      // Both share name="photo" so the server action's contract holds.
      await expect(selfieInput).toHaveAttribute("name", "photo");
      await expect(chooseInput).toHaveAttribute("name", "photo");

      await page.screenshot({ path: path.join(OUT, "photo-step-mobile.png"), fullPage: true });

      // Exercise the CHOOSE path — the selfie path requires a device
      // camera prompt which Playwright cannot simulate, but the choose
      // path uses the standard file-picker.
      await page.setInputFiles(
        '[data-testid="photo-choose-input"]',
        { name: "me.png", mimeType: "image/png", buffer: TINY_PNG },
      );
      await expect(page.locator('img[alt="Selected photo preview"]')).toBeVisible();

      // Now switch: reset + populate via the SELFIE input directly. The
      // client component clears the "other" input when one is picked
      // so the form always submits ONE file.
      await page.locator('button:has-text("Choose a different photo")').click();
      await page.setInputFiles(
        '[data-testid="photo-selfie-input"]',
        { name: "me2.png", mimeType: "image/png", buffer: TINY_PNG },
      );
      await expect(page.locator('img[alt="Selected photo preview"]')).toBeVisible();
      // The choose-input's files array is now empty (mutual exclusion
      // enforced by the client component).
      const chooseFilesLength = await chooseInput.evaluate(
        (el) => (el as HTMLInputElement).files?.length ?? 0,
      );
      expect(chooseFilesLength).toBe(0);
    } finally {
      await ctx.close();
    }
  });
});
