// HR-2B.2 (2026-08-18) — Local Playwright acceptance for the
// employee-facing onboarding flow.
//
// Runs against a local `npm run dev` server that Playwright auto-
// starts via the `webServer` block in playwright.config.ts. All
// fixtures are primed via `scripts/hr-2b2-fixture-invitation.mjs`,
// which is invoked with a distinct fixture email per test case so
// the flows never contaminate each other.
//
// Coverage:
//   Case A · desktop happy path + persistence + expired resume
//   Case B · desktop employment-correction branch + canonical
//            employment-field invariant
//   Case C · mobile-viewport happy path
//   Case D · authorization-boundary (employee cookie does NOT
//            authenticate admin routes; unauthenticated direct
//            navigation to About You redirects to expired)
//
// Screenshots land under test-results/hr-2b2-onboarding/. The
// fixture JSON is git-ignored (already covered by test-results/).
//
// NOTE: raw invitation tokens live in `test-results/hr-2b2-fixture.
// json` (git-ignored). They are ONLY read by this spec — never
// posted to the DOM, never logged to stdout.

import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";

const OUT = path.resolve("test-results/hr-2b2-onboarding");
fs.mkdirSync(OUT, { recursive: true });

const FIXTURE_PATH_DEFAULT = path.resolve("test-results/hr-2b2-fixture.json");
const FIXTURE_SCRIPT = path.resolve("scripts/hr-2b2-fixture-invitation.mjs");

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
    throw new Error(`[hr-2b2-spec] fixture file missing: ${fixturePath}`);
  }
  return JSON.parse(fs.readFileSync(fixturePath, "utf8")) as Fixture;
}

/** Invoke scripts/hr-2b2-fixture-invitation.mjs for `email` and read the
 *  refreshed fixture file. The script always overwrites the same
 *  JSON file, so callers just re-read it. */
function primeFixture(email: string): Fixture {
  execFileSync("node", [FIXTURE_SCRIPT, "--email", email], {
    cwd: path.resolve("."),
    stdio: ["ignore", "pipe", "pipe"],
    // Long enough for a cold PrismaClient boot on Windows.
    timeout: 60_000,
  });
  return readFixture();
}

// Minimum valid 1x1 PNG — 8-byte magic + IHDR + IDAT + IEND. Playwright's
// setInputFiles reads the buffer directly, so no fixture file needed.
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);

async function assertNoHorizontalOverflow(page: Page, label: string) {
  const [scrollWidth, clientWidth] = await page.evaluate(() => [
    document.documentElement.scrollWidth,
    document.documentElement.clientWidth,
  ]);
  expect(
    scrollWidth,
    `horizontal overflow at ${label} (scrollWidth=${scrollWidth} vs clientWidth=${clientWidth})`,
  ).toBeLessThanOrEqual(clientWidth + 1);
}

async function runHappyPath(
  page: Page,
  fixture: Fixture,
  opts: { screenshotPrefix: string; viewportLabel: string; checkOverflow?: boolean },
) {
  const { screenshotPrefix, viewportLabel, checkOverflow = false } = opts;

  // ---------- Welcome ----------
  await page.goto(fixture.redemptionUrl, { waitUntil: "domcontentloaded" });
  await expect(
    page.locator("h1"),
    "welcome heading names the Club",
  ).toContainText(`Welcome to ${fixture.clubName}`);
  const bodyText = (await page.locator("body").textContent()) ?? "";
  expect(
    /Mission Control/i.test(bodyText),
    "welcome page must NOT show admin Mission Control chrome",
  ).toBeFalsy();
  // The Spectre wordmark itself is masked on member-facing surfaces
  // (client-branded). It's fine if the code string "Spectre" appears
  // in an invisible footer credit — assert no admin sidebar chrome.
  await expect(
    page.locator('[data-testid="nav-section-toggle-people"]'),
    "welcome page must NOT render admin sidebar",
  ).toHaveCount(0);
  await page.screenshot({ path: path.join(OUT, `${screenshotPrefix}01-welcome-${viewportLabel}.png`) });
  if (checkOverflow) await assertNoHorizontalOverflow(page, "welcome");

  // ---------- Begin -> Name ----------
  await Promise.all([
    page.waitForURL(/\/hr\/onboarding\/about-you\/name/, { timeout: 30_000 }),
    page.locator('[data-testid="hr-onboarding-begin"]').click(),
  ]);
  await expect(page.locator('input[name="firstName"]')).toBeVisible();
  await page.locator('input[name="firstName"]').fill(fixture.employeeFirstName);
  await page.locator('input[name="lastName"]').fill(fixture.employeeLastName);
  await page.locator('input[name="preferredName"]').fill("Chris");
  await page.screenshot({ path: path.join(OUT, `${screenshotPrefix}02-name-${viewportLabel}.png`) });
  if (checkOverflow) await assertNoHorizontalOverflow(page, "name");
  await Promise.all([
    page.waitForURL(/\/hr\/onboarding\/about-you\/contact/, { timeout: 20_000 }),
    page.locator('button[type="submit"]').first().click(),
  ]);

  // ---------- Contact ----------
  await expect(page.locator('input[name="personalEmail"]')).toBeVisible();
  await page.locator('input[name="personalEmail"]').fill(`chris-${viewportLabel}@spectre.test`);
  await page.locator('input[name="mobilePhone"]').fill("(403) 555-0111");
  await page.screenshot({ path: path.join(OUT, `${screenshotPrefix}03-contact-${viewportLabel}.png`) });
  if (checkOverflow) await assertNoHorizontalOverflow(page, "contact");
  await Promise.all([
    page.waitForURL(/\/hr\/onboarding\/about-you\/employment/, { timeout: 20_000 }),
    page.locator('button[type="submit"]').first().click(),
  ]);

  // ---------- Employment (correct) ----------
  await expect(page.locator("body"), "position label rendered from Club record").toContainText(
    fixture.positionName,
  );
  await expect(page.locator("body"), "department label rendered from Club record").toContainText(
    fixture.departmentName,
  );
  await page.screenshot({ path: path.join(OUT, `${screenshotPrefix}04-employment-${viewportLabel}.png`) });
  if (checkOverflow) await assertNoHorizontalOverflow(page, "employment");
  // Ensure the "correct" radio is selected (it's defaultChecked on first
  // visit, but click it defensively so submit carries the value on all
  // browsers).
  await page.locator('[data-testid="employment-outcome-correct"]').check();
  await Promise.all([
    page.waitForURL(/\/hr\/onboarding\/about-you\/photo/, { timeout: 20_000 }),
    page.locator('button[type="submit"]').first().click(),
  ]);

  // ---------- Photo ----------
  await expect(page.locator('input[type="file"][name="photo"]')).toBeVisible();
  await page.screenshot({ path: path.join(OUT, `${screenshotPrefix}05-photo-${viewportLabel}-empty.png`) });
  if (checkOverflow) await assertNoHorizontalOverflow(page, "photo-empty");
  await page.setInputFiles('input[type="file"][name="photo"]', {
    name: "me.png",
    mimeType: "image/png",
    buffer: TINY_PNG,
  });
  // Client preview <img> renders as soon as the URL.createObjectURL
  // callback runs. Wait for it before screenshotting so the capture
  // reflects the preview state.
  await expect(page.locator('img[alt="Selected photo preview"]')).toBeVisible();
  await page.screenshot({ path: path.join(OUT, `${screenshotPrefix}06-photo-${viewportLabel}-preview.png`) });
  await Promise.all([
    page.waitForURL(/\/hr\/onboarding\/about-you\/complete/, { timeout: 30_000 }),
    page.locator('button[type="submit"]').first().click(),
  ]);

  // ---------- Complete ----------
  await expect(page.locator("h2")).toContainText(/Thanks,\s*Chris/);
  await page.screenshot({ path: path.join(OUT, `${screenshotPrefix}07-complete-${viewportLabel}.png`) });
  if (checkOverflow) await assertNoHorizontalOverflow(page, "complete");
}

test.describe.serial("HR-2B.2 · Employee onboarding local acceptance", () => {
  test.setTimeout(300_000);

  // ---------------------------------------------------------------------
  // Case A — desktop happy path + persistence + expired-then-resume.
  // ---------------------------------------------------------------------
  test("Case A · desktop happy path with persistence and resume", async ({ browser }) => {
    // Prime a fresh invitation for the default fixture email. The
    // fixture script overwrites test-results/hr-2b2-fixture.json every
    // run so a re-run of just this test starts clean.
    const fixture = primeFixture("hr-2b2-fixture@spectre.test");

    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();

    await runHappyPath(page, fixture, {
      screenshotPrefix: "",
      viewportLabel: "desktop",
    });

    // ---------- Persistence · preferred name ----------
    await page.goto("http://localhost:3000/hr/onboarding/about-you/name", { waitUntil: "domcontentloaded" });
    await expect(page.locator('input[name="preferredName"]')).toHaveValue("Chris");

    // ---------- Persistence · contact fields ----------
    await page.goto("http://localhost:3000/hr/onboarding/about-you/contact", { waitUntil: "domcontentloaded" });
    await expect(page.locator('input[name="personalEmail"]')).toHaveValue("chris-desktop@spectre.test");
    await expect(page.locator('input[name="mobilePhone"]')).toHaveValue("(403) 555-0111");

    // ---------- Persistence · employment acknowledgement ----------
    await page.goto("http://localhost:3000/hr/onboarding/about-you/employment", { waitUntil: "domcontentloaded" });
    await expect(page.locator('[data-testid="employment-outcome-correct"]')).toBeChecked();
    await expect(page.locator('[data-testid="employment-outcome-correction"]')).not.toBeChecked();
    // No correction inputs are pre-filled.
    for (const field of ["positionId", "departmentId", "employmentType", "expectedStartDate"]) {
      await expect(page.locator(`[data-testid="correction-${field}-value"]`)).toHaveValue("");
    }

    // ---------- Expired path after cookie clear ----------
    await ctx.clearCookies();
    await page.goto("http://localhost:3000/hr/onboarding/about-you", { waitUntil: "domcontentloaded" });
    await expect(page).toHaveURL(/\/hr\/onboarding\/expired/);
    await expect(page.locator("h1")).toContainText(/no longer active/i);
    await page.screenshot({ path: path.join(OUT, "08-expired-desktop.png") });

    // ---------- Resume via the same magic link ----------
    // Idempotent redemption: the invitation is already REDEEMED and
    // the session is IN_PROGRESS, so acquireInvitationContext returns
    // wasFirstRedemption=false and the cookie is re-stamped. Because
    // every step is done, /about-you resolves to /complete.
    await page.goto(fixture.redemptionUrl, { waitUntil: "domcontentloaded" });
    await Promise.all([
      page.waitForURL(/\/hr\/onboarding\/about-you(\/|$)/, { timeout: 30_000 }),
      page.locator('[data-testid="hr-onboarding-begin"]').click(),
    ]);
    // /about-you hub redirects to /complete when everything is done.
    await page.waitForURL(/\/hr\/onboarding\/about-you\/complete/, { timeout: 20_000 });
    await expect(page.locator("h2")).toContainText(/Thanks,\s*Chris/);
    await page.screenshot({ path: path.join(OUT, "09-resume-complete-desktop.png") });

    await ctx.close();
  });

  // ---------------------------------------------------------------------
  // Case B — desktop employment-correction branch.
  // Uses a SEPARATE fixture email so Case A's employee row is
  // untouched (Case A's fixture file is overwritten below, so if
  // Case A's specific assertions need to be re-run in isolation the
  // caller should reset with the default email).
  // ---------------------------------------------------------------------
  test("Case B · employment-correction branch + canonical fields untouched", async ({ browser }) => {
    const fixture = primeFixture("hr-2b2-correction-fixture@spectre.test");

    // Snapshot the canonical employment fields BEFORE any employee
    // action, straight from Prisma. These are the values we assert
    // remain untouched after the correction flow.
    const prisma = new PrismaClient();
    const before = await prisma.employee.findFirstOrThrow({
      where: { id: fixture.employeeId },
      select: {
        positionId: true,
        departmentId: true,
        employmentType: true,
        expectedStartDate: true,
      },
    });

    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();

    try {
      await page.goto(fixture.redemptionUrl, { waitUntil: "domcontentloaded" });
      await Promise.all([
        page.waitForURL(/\/hr\/onboarding\/about-you\/name/, { timeout: 30_000 }),
        page.locator('[data-testid="hr-onboarding-begin"]').click(),
      ]);

      // Name
      await page.locator('input[name="firstName"]').fill(fixture.employeeFirstName);
      await page.locator('input[name="lastName"]').fill(fixture.employeeLastName);
      await page.locator('input[name="preferredName"]').fill("CorrectionChris");
      await Promise.all([
        page.waitForURL(/\/hr\/onboarding\/about-you\/contact/, { timeout: 20_000 }),
        page.locator('button[type="submit"]').first().click(),
      ]);

      // Contact
      await page.locator('input[name="personalEmail"]').fill("correction-chris@spectre.test");
      await page.locator('input[name="mobilePhone"]').fill("(403) 555-0222");
      await Promise.all([
        page.waitForURL(/\/hr\/onboarding\/about-you\/employment/, { timeout: 20_000 }),
        page.locator('button[type="submit"]').first().click(),
      ]);

      // Employment — needs_correction
      await page.locator('[data-testid="employment-outcome-correction"]').check();
      await page.locator('[data-testid="correction-positionId-enabled"]').check();
      await page.locator('[data-testid="correction-positionId-value"]').fill("Golf Shop Attendant");
      await page.locator('[data-testid="correction-expectedStartDate-enabled"]').check();
      await page.locator('[data-testid="correction-expectedStartDate-value"]').fill("September 21, 2026");
      await page.screenshot({ path: path.join(OUT, "04b-employment-correction-desktop.png") });
      await Promise.all([
        page.waitForURL(/\/hr\/onboarding\/about-you\/photo/, { timeout: 20_000 }),
        page.locator('button[type="submit"]').first().click(),
      ]);

      // Navigate BACK to /employment and verify correction persistence.
      await page.goto("http://localhost:3000/hr/onboarding/about-you/employment", { waitUntil: "domcontentloaded" });
      await expect(page.locator('[data-testid="employment-outcome-correction"]')).toBeChecked();
      await expect(page.locator('[data-testid="correction-positionId-enabled"]')).toBeChecked();
      await expect(page.locator('[data-testid="correction-positionId-value"]')).toHaveValue("Golf Shop Attendant");
      await expect(page.locator('[data-testid="correction-expectedStartDate-enabled"]')).toBeChecked();
      await expect(page.locator('[data-testid="correction-expectedStartDate-value"]')).toHaveValue("September 21, 2026");
      await page.screenshot({ path: path.join(OUT, "04c-employment-correction-persisted-desktop.png") });

      // Canonical Employee-row fields MUST NOT have moved.
      const after = await prisma.employee.findFirstOrThrow({
        where: { id: fixture.employeeId },
        select: {
          positionId: true,
          departmentId: true,
          employmentType: true,
          expectedStartDate: true,
        },
      });
      // eslint-disable-next-line no-console
      console.log("[hr-2b2-spec] canonical employment fields before:", before);
      // eslint-disable-next-line no-console
      console.log("[hr-2b2-spec] canonical employment fields after:", after);
      expect(after.positionId).toBe(before.positionId);
      expect(after.departmentId).toBe(before.departmentId);
      expect(after.employmentType).toBe(before.employmentType);
      expect(after.expectedStartDate?.getTime()).toBe(before.expectedStartDate?.getTime());

      // The correction ROWS the flow just wrote should be present.
      const corrections = await prisma.employeeOnboardingCorrection.findMany({
        where: { employeeId: fixture.employeeId },
        select: { field: true, employeeStatedValue: true },
      });
      const byField = Object.fromEntries(
        corrections.map((c) => [c.field, c.employeeStatedValue]),
      );
      expect(byField.positionId).toBe("Golf Shop Attendant");
      expect(byField.expectedStartDate).toBe("September 21, 2026");
    } finally {
      await ctx.close();
      await prisma.$disconnect();
    }
  });

  // ---------------------------------------------------------------------
  // Case C — mobile viewport 390x844 happy path.
  // ---------------------------------------------------------------------
  test("Case C · mobile happy path with no horizontal overflow", async ({ browser }) => {
    const fixture = primeFixture("hr-2b2-mobile-fixture@spectre.test");

    const ctx = await browser.newContext({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
      deviceScaleFactor: 2,
    });
    const page = await ctx.newPage();

    await runHappyPath(page, fixture, {
      screenshotPrefix: "1", // yields 101-*, 102-*, ... to keep alpha-sorted.
      viewportLabel: "mobile",
      checkOverflow: true,
    });

    await ctx.close();
  });

  // ---------------------------------------------------------------------
  // Case D — authorization boundary.
  // ---------------------------------------------------------------------
  test("Case D · employee cookie cannot reach admin; no cookie -> expired", async ({ browser }) => {
    // The default fixture email may be in any state after Case A. We
    // don't need a full happy path here — just an authenticated
    // employee cookie. Re-prime the default fixture so the cookie
    // stamp works, then click Begin.
    const fixture = primeFixture("hr-2b2-fixture@spectre.test");

    const ctxWithCookie = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const employeePage = await ctxWithCookie.newPage();
    await employeePage.goto(fixture.redemptionUrl, { waitUntil: "domcontentloaded" });
    await Promise.all([
      employeePage.waitForURL(/\/hr\/onboarding\/about-you/, { timeout: 30_000 }),
      employeePage.locator('[data-testid="hr-onboarding-begin"]').click(),
    ]);

    // Attempt to reach an admin route with the employee cookie present.
    // Middleware requires `spectre_session` (admin cookie name) — the
    // employee's `spectre_hr_onboarding` cookie is a DIFFERENT name
    // and cannot satisfy the admin gate.
    await employeePage.goto("http://localhost:3000/app/admin", { waitUntil: "domcontentloaded" });
    // Expected: redirect to /login (or a 4xx page). Assert the URL
    // moved off the admin path.
    const finalUrl = new URL(employeePage.url());
    expect(
      finalUrl.pathname,
      "employee cookie must NOT reach /app/admin (must redirect to /login or block)",
    ).not.toMatch(/^\/app\/admin/);
    // If we redirected to /login, the login form should be visible.
    // If a page blocked outright with a 4xx, the assertion above still
    // proves the boundary held.
    await employeePage.screenshot({ path: path.join(OUT, "20-admin-blocked-desktop.png") });
    await ctxWithCookie.close();

    // Fresh context with no cookies should be bounced from
    // /hr/onboarding/about-you/name to /expired.
    const ctxNoCookie = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const bouncedPage = await ctxNoCookie.newPage();
    await bouncedPage.goto("http://localhost:3000/hr/onboarding/about-you/name", { waitUntil: "domcontentloaded" });
    await expect(bouncedPage).toHaveURL(/\/hr\/onboarding\/expired/);
    await expect(bouncedPage.locator("h1")).toContainText(/no longer active/i);
    await ctxNoCookie.close();
  });
});
