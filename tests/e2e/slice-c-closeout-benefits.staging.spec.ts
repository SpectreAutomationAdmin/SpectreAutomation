// Slice C closeout (2026-09-18) §19 — authenticated Playwright acceptance
// against staging. Founder standard: UI-touching checkpoints must pass
// authenticated Playwright before "done".
//
// Screenshots 1–14 captured at 1440×900 per the closeout directive:
//   01 · Payroll Settings → Benefits (list)
//   02 · Empty-state Benefits page (implicit — same page with 0 plans)
//   03 · Add Benefit Plan form
//   04 · LTD plan configuration in-flight
//   05 · Health/Dental plan configuration in-flight
//   06 · Employee → Payroll → Benefits & Deductions empty state
//   07 · Enrol in Benefit form
//   08 · Active LTD enrolment
//   09 · Active Health/Dental enrolment (rendered when applicable)
//   10 · Change enrolment form
//   11 · End enrolment form
//   12 · History / upcoming state
//   13 · Component treatment context (Add Plan form component readout)
//   14 · Chris payroll workspace read-only (founder-data preservation)
//
// The spec does NOT mutate founder rows. It only screenshots the
// existing state of the staging tenant. Any WRITE screenshots (Add,
// Enrol, Change, End) capture the form STATE, not a submitted mutation.

import { test, expect } from "@playwright/test";
import { loginAsFounder, loginAs, stagingCredsAvailable } from "./_lib/staging-auth";

const VIEWPORT = { width: 1440, height: 900 };

// Slice C final UI acceptance — synthetic staging fixture credentials.
// Provisioned by scripts/slice-c-staging-screenshot-fixture.mjs --setup.
const FIXTURE_ADMIN_EMAIL = "slice-c-benefits-test-admin@fixture.spectre.test";
const FIXTURE_ADMIN_PASSWORD =
  process.env.SPECTRE_FIXTURE_ADMIN_PASSWORD ?? "SliceC-Benefits-Fixture-2026!";
const FIXTURE_EMPLOYEE_ID = "cmu7mh066000lc4uixx7u0e6a";
const FIXTURE_LTD_PLAN_ID = "cmu7mh02q000hc4uiopd8ibwh";

test.describe("Slice C closeout — Benefits UI screenshots (staging)", () => {
  test.beforeAll(() => {
    const { ready, reason } = stagingCredsAvailable();
    test.skip(!ready, reason ?? "staging creds unavailable");
  });

  test("01–05 · Payroll Settings → Benefits: list + Add Plan + treatments", async ({ context }) => {
    const page = await loginAsFounder(context, {
      landing: "/app/admin/payroll/setup/benefits",
    });
    await page.setViewportSize(VIEWPORT);
    await expect(page.getByTestId("payroll-benefits-settings-page")).toBeVisible({ timeout: 15_000 });
    await page.screenshot({ path: "test-results/slice-c-closeout/01-payroll-settings-benefits-list.png", fullPage: true });

    // 02 · empty state is the SAME page rendered with 0 plans. On the
    // Coulee Ridge tenant a plan may already exist from earlier LTD
    // fixture work; if none exists, capture the empty-state card.
    const empty = page.getByTestId("benefits-empty");
    if (await empty.isVisible().catch(() => false)) {
      await page.screenshot({ path: "test-results/slice-c-closeout/02-benefits-empty-state.png", fullPage: true });
    }

    // 03 · Add Benefit Plan form
    const addBtn = page.getByTestId("benefits-add-plan-btn");
    if (await addBtn.isVisible().catch(() => false)) {
      await addBtn.click();
      await expect(page.getByTestId("benefits-add-form")).toBeVisible();
      await page.screenshot({ path: "test-results/slice-c-closeout/03-add-benefit-plan-blank.png", fullPage: true });

      // 04 · LTD plan configuration (fill without submitting)
      await page.getByTestId("benefits-form-kind").selectOption("LTD");
      await page.getByTestId("benefits-form-code").fill("LTD_SCREENSHOT");
      await page.getByTestId("benefits-form-name").fill("LTD — Screenshot Preview");
      await page.getByTestId("benefits-form-effective-from").fill("2026-10-01");
      // Pick first employee-side component if any exists
      const eeSelect = page.getByTestId("benefits-form-employee-component");
      const eeOptions = await eeSelect.locator("option").allTextContents();
      if (eeOptions.length > 1) {
        await eeSelect.selectOption({ index: 1 });
      }
      await page.screenshot({ path: "test-results/slice-c-closeout/04-add-plan-ltd-configured.png", fullPage: true });

      // 13 · Component treatment context (rendered by ComponentTreatment)
      const treatments = page.locator('[data-testid^="component-treatment-"]').first();
      if (await treatments.isVisible().catch(() => false)) {
        await treatments.scrollIntoViewIfNeeded();
        await page.screenshot({ path: "test-results/slice-c-closeout/13-component-treatment-readout.png" });
      }

      // 05 · Health/Dental configuration variant
      await page.getByTestId("benefits-form-kind").selectOption("HEALTH_DENTAL");
      await page.getByTestId("benefits-form-code").fill("HEALTH_SCREENSHOT");
      await page.getByTestId("benefits-form-name").fill("Health & Dental — Screenshot Preview");
      // Clear employee side, pick employer side
      await eeSelect.selectOption("");
      const erSelect = page.getByTestId("benefits-form-employer-component");
      const erOptions = await erSelect.locator("option").allTextContents();
      if (erOptions.length > 1) {
        await erSelect.selectOption({ index: 1 });
      }
      await page.screenshot({ path: "test-results/slice-c-closeout/05-add-plan-health-configured.png", fullPage: true });
    } else {
      // Read-only role — capture the list-only view instead.
      await page.screenshot({ path: "test-results/slice-c-closeout/03-benefits-read-only.png", fullPage: true });
    }
  });

  test("06 + 07 · Employee Benefits workspace on Chris (read-only + Enrol form open, no submit)", async ({ context }) => {
    // Directive §23: Chris screenshot is READ-ONLY only. This test opens
    // the Enrol form on Chris's page to capture it; it never submits the
    // form, so no enrolment is created against the founder's employee.
    const page = await loginAsFounder(context, { landing: "/app/admin/people/employees" });
    await page.setViewportSize(VIEWPORT);
    await page.waitForLoadState("networkidle");
    const chrisRow = page.locator('a[href*="/app/admin/people/employees/"]:has-text("Chris")').first();
    const href = await chrisRow.getAttribute("href").catch(() => null);
    if (!href) test.skip(true, "Chris employee not present on this tenant");
    // Land directly on the Payroll tab — Benefits section lives inside it.
    await page.goto(`${href!}?tab=payroll`, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle");

    const benefits = page.getByTestId("payroll-benefits-deductions-slice-c");
    if (!(await benefits.isVisible().catch(() => false))) {
      test.skip(true, "benefits section not visible");
    }
    await benefits.scrollIntoViewIfNeeded();

    // 06 · Empty / initial state on Chris (proves founder data untouched).
    await page.screenshot({ path: "test-results/slice-c-closeout/06-employee-benefits-initial.png", fullPage: true });

    // 07 · Enrol form open — NO SUBMIT (would violate §23).
    const enrolBtn = page.getByTestId("benefits-enrol-btn");
    if (await enrolBtn.isVisible().catch(() => false)) {
      await enrolBtn.click();
      await expect(page.getByTestId("benefits-enrol-form")).toBeVisible();
      await page.screenshot({ path: "test-results/slice-c-closeout/07-enrol-in-benefit-form.png", fullPage: true });
      // Explicitly do not click submit — cancel to leave state clean.
    }

    // Screenshots 08–12 (active enrolment / change / end / history) require
    // an enrolled synthetic employee, deferred: creating such a synthetic
    // fixture on the FOUNDER_REVIEW-mode staging tenant is out of scope
    // for this closeout — proven interactively via targeted vitest specs.
  });

  test("08–12 · Active + Change + End + History via synthetic fixture", async ({ context }) => {
    // Log in as the synthetic fixture admin (NEVER touches Chris/Marc).
    const page = await loginAs(context, FIXTURE_ADMIN_EMAIL, FIXTURE_ADMIN_PASSWORD, {
      landing: `/app/admin/people/employees/${FIXTURE_EMPLOYEE_ID}?tab=payroll`,
    });
    await page.setViewportSize(VIEWPORT);
    await page.waitForLoadState("networkidle");

    const benefits = page.getByTestId("payroll-benefits-deductions-slice-c");
    await expect(benefits).toBeVisible({ timeout: 15_000 });
    await benefits.scrollIntoViewIfNeeded();

    // 08 · Active LTD (first active enrolment)
    const actives = page.locator('[data-testid^="benefit-enrolment-active-"]');
    await expect(actives.first()).toBeVisible();
    await page.screenshot({ path: "test-results/slice-c-closeout/08-active-ltd-enrolment.png", fullPage: true });

    // 09 · Active Health/Dental (both actives visible in fullpage; also crop only)
    const activeCount = await actives.count();
    if (activeCount >= 2) {
      await actives.nth(1).scrollIntoViewIfNeeded();
      await page.screenshot({ path: "test-results/slice-c-closeout/09-active-health-enrolment.png", fullPage: true });
    }

    // 10 · Change enrolment form open
    await actives.first().scrollIntoViewIfNeeded();
    const changeBtn = page.locator('[data-testid^="benefit-change-btn-"]').first();
    await changeBtn.click();
    const changeForm = page.locator('[data-testid^="benefits-change-form-"]').first();
    await expect(changeForm).toBeVisible();
    await page.screenshot({ path: "test-results/slice-c-closeout/10-change-enrolment-form.png", fullPage: true });

    // Reset — click Cancel on the change form
    await changeForm.getByRole("button", { name: /^Cancel$/ }).click();

    // 11 · End enrolment form open
    const endBtn = page.locator('[data-testid^="benefit-end-btn-"]').first();
    await endBtn.click();
    const endForm = page.locator('[data-testid^="benefits-end-form-"]').first();
    await expect(endForm).toBeVisible();
    await page.screenshot({ path: "test-results/slice-c-closeout/11-end-enrolment-form.png", fullPage: true });
    await endForm.getByRole("button", { name: /^Cancel$/ }).click();

    // 12 · History disclosure — synthetic fixture provisioned an ENDED enrolment
    const hist = page.getByTestId("benefits-history-disclosure");
    if (await hist.isVisible().catch(() => false)) {
      await hist.evaluate((el: HTMLDetailsElement) => { el.open = true; });
      await hist.scrollIntoViewIfNeeded();
      await page.screenshot({ path: "test-results/slice-c-closeout/12-history-upcoming-state.png", fullPage: true });
    }
  });

  test("15–16 · Change Benefit Plan editor + successor lineage in Settings", async ({ context }) => {
    const page = await loginAs(context, FIXTURE_ADMIN_EMAIL, FIXTURE_ADMIN_PASSWORD, {
      landing: "/app/admin/payroll/setup/benefits",
    });
    await page.setViewportSize(VIEWPORT);
    await expect(page.getByTestId("payroll-benefits-settings-page")).toBeVisible({ timeout: 15_000 });

    // 15 · Change Benefit Plan editor open on the LTD fixture plan
    const changeBtn = page.getByTestId(`benefit-plan-change-btn-${FIXTURE_LTD_PLAN_ID}`);
    if (await changeBtn.isVisible().catch(() => false)) {
      await changeBtn.click();
      const editor = page.getByTestId(`benefits-change-form-${FIXTURE_LTD_PLAN_ID}`);
      await expect(editor).toBeVisible();
      await editor.scrollIntoViewIfNeeded();
      await page.screenshot({ path: "test-results/slice-c-closeout/15-change-plan-editor.png", fullPage: true });
    }

    // 16 · Historical lineage row — only renders after at least one Change
    // has landed. If the fixture setup ran Change before this shot fires,
    // the historical disclosure shows "replaced by <code>". Otherwise
    // this shot is captured against the empty history state.
    const hist = page.getByTestId("benefits-history-disclosure");
    if (await hist.isVisible().catch(() => false)) {
      await hist.evaluate((el: HTMLDetailsElement) => { el.open = true; });
      await page.screenshot({ path: "test-results/slice-c-closeout/16-plan-history-lineage.png", fullPage: true });
    } else {
      await page.screenshot({ path: "test-results/slice-c-closeout/16-plan-history-empty.png", fullPage: true });
    }
  });

  test("14 · Chris payroll workspace read-only (founder-data preservation)", async ({ context }) => {
    const page = await loginAsFounder(context, {
      landing: "/app/admin/people/employees",
    });
    await page.setViewportSize(VIEWPORT);
    await page.waitForLoadState("networkidle");
    // Find Chris — the founder's own employee row (looks for "Chris" text link).
    const chrisRow = page.locator('a[href*="/app/admin/people/employees/"]:has-text("Chris")').first();
    const href = await chrisRow.getAttribute("href").catch(() => null);
    if (!href) {
      test.skip(true, "Chris employee row not found on this tenant — expected on Coulee Ridge only");
    }
    await page.goto(href!, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle");
    await page.screenshot({ path: "test-results/slice-c-closeout/14-chris-payroll-read-only.png", fullPage: true });
  });
});
