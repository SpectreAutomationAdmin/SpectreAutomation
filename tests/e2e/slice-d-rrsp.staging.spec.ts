// Slice D (2026-09-19) §35 — authenticated Playwright acceptance for RRSP
// against v430 staging. Runs under the synthetic fixture admin
// (slice-c-staging-screenshot-fixture.mjs --setup); NEVER touches
// Chris/Marc/Coulee Ridge.
//
// 12 captures at 1440×900:
//   01 · Add RRSP Plan (form open)
//   02 · RRSP Plan configured (form filled, not submitted)
//   03 · RRSP component treatment context
//   04 · Employee Enrol in RRSP form open
//   05 · RRSP election 5%
//   06 · Active RRSP card on employee workspace
//   07 · Change RRSP enrolment form open
//   08 · End RRSP enrolment form open
//   09 · RRSP History (ENDED disclosure)
//   10 · Change RRSP Plan (Payroll Settings Change editor on RRSP plan)
//   11 · Match 100% / cap 3% presentation on plans list
//   12 · PayStatement showing employee RRSP + employer match — deferred:
//        requires a Prepare → Post cycle against the fixture tenant. Not
//        available via UI-only clicks. Covered end-to-end by the vitest
//        Slice D full-pipeline test (§10).

import { test, expect } from "@playwright/test";
import { loginAs, stagingCredsAvailable } from "./_lib/staging-auth";

const VIEWPORT = { width: 1440, height: 900 };
const FIXTURE_ADMIN_EMAIL = "slice-c-benefits-test-admin@fixture.spectre.test";
const FIXTURE_ADMIN_PASSWORD =
  process.env.SPECTRE_FIXTURE_ADMIN_PASSWORD ?? "SliceC-Benefits-Fixture-2026!";

test.describe("Slice D — RRSP UI screenshots (staging)", () => {
  test.beforeAll(() => {
    const { ready, reason } = stagingCredsAvailable();
    test.skip(!ready, reason ?? "staging creds unavailable");
  });

  test("01–03 + 10–11 · Payroll Settings → Benefits RRSP surfaces", async ({ context }) => {
    const page = await loginAs(context, FIXTURE_ADMIN_EMAIL, FIXTURE_ADMIN_PASSWORD, {
      landing: "/app/admin/payroll/setup/benefits",
    });
    await page.setViewportSize(VIEWPORT);
    await expect(page.getByTestId("payroll-benefits-settings-page")).toBeVisible({ timeout: 15_000 });

    // 11 · Plans list showing RRSP row with Match / Cap summary
    await page.screenshot({ path: "test-results/slice-d/11-plans-list-with-match-cap.png", fullPage: true });

    // 01 + 02 · Add Benefit Plan → RRSP
    const addBtn = page.getByTestId("benefits-add-plan-btn");
    await addBtn.click();
    await expect(page.getByTestId("benefits-add-form")).toBeVisible();
    await page.getByTestId("benefits-form-kind").selectOption("RRSP");
    await page.getByTestId("benefits-form-code").fill("RRSP_STANDARD");
    await page.getByTestId("benefits-form-name").fill("RRSP — Standard Group Plan");
    await page.getByTestId("benefits-form-effective-from").fill("2026-10-01");
    await page.getByTestId("benefits-form-employer-match").fill("100.00");
    await page.getByTestId("benefits-form-employer-cap").fill("3.00");
    // 01 · RRSP form open with match/cap
    await page.screenshot({ path: "test-results/slice-d/01-add-rrsp-plan-open.png", fullPage: true });

    // Pick the RRSP components
    const eeSelect = page.getByTestId("benefits-form-employee-component");
    const eeOptions = await eeSelect.locator("option").allTextContents();
    const eeRrspIdx = eeOptions.findIndex((t) => /RRSP Employee/i.test(t));
    if (eeRrspIdx > 0) await eeSelect.selectOption({ index: eeRrspIdx });
    const erSelect = page.getByTestId("benefits-form-employer-component");
    const erOptions = await erSelect.locator("option").allTextContents();
    const erRrspIdx = erOptions.findIndex((t) => /RRSP Employer/i.test(t));
    if (erRrspIdx > 0) await erSelect.selectOption({ index: erRrspIdx });
    // 02 · RRSP plan configured
    await page.screenshot({ path: "test-results/slice-d/02-rrsp-plan-configured.png", fullPage: true });

    // 03 · Component treatment context (visible for the selected components)
    const treatment = page.locator('[data-testid^="component-treatment-"]').first();
    if (await treatment.isVisible().catch(() => false)) {
      await treatment.scrollIntoViewIfNeeded();
      await page.screenshot({ path: "test-results/slice-d/03-rrsp-component-treatment.png" });
    }

    // Cancel — do not submit; fixture plan already exists.
    const cancelBtn = page.locator('button:has-text("Cancel")').first();
    if (await cancelBtn.isVisible().catch(() => false)) await cancelBtn.click();

    // 10 · Change RRSP Plan (open the Change editor on the fixture RRSP plan row)
    const rrspRow = page.locator('tr[data-testid^="benefit-plan-row-"]').filter({ hasText: /RRSP/ }).first();
    const rowId = (await rrspRow.getAttribute("data-testid"))?.replace("benefit-plan-row-", "") ?? "";
    if (rowId) {
      const changeBtn = page.getByTestId(`benefit-plan-change-btn-${rowId}`);
      if (await changeBtn.isVisible().catch(() => false)) {
        await changeBtn.click();
        const editor = page.getByTestId(`benefits-change-form-${rowId}`);
        await expect(editor).toBeVisible();
        await editor.scrollIntoViewIfNeeded();
        await page.screenshot({ path: "test-results/slice-d/10-change-rrsp-plan-editor.png", fullPage: true });
      }
    }
  });

  test("04–09 · Employee RRSP enrolment workflow (open forms, no submits)", async ({ context }) => {
    // Land on the employees list, find the synthetic fixture employee
    // (SliceC BenefitsFixture) via text link.
    const page = await loginAs(context, FIXTURE_ADMIN_EMAIL, FIXTURE_ADMIN_PASSWORD, {
      landing: "/app/admin/people/employees",
    });
    await page.setViewportSize(VIEWPORT);
    await page.waitForLoadState("networkidle");
    const empRow = page.locator('a[href*="/app/admin/people/employees/"]:has-text("SliceC")').first();
    const href = await empRow.getAttribute("href").catch(() => null);
    if (!href) test.skip(true, "fixture employee not present — did --setup succeed?");
    await page.goto(`${href!}?tab=payroll`, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle");

    const benefits = page.getByTestId("payroll-benefits-deductions-slice-c");
    await expect(benefits).toBeVisible({ timeout: 15_000 });
    await benefits.scrollIntoViewIfNeeded();

    // 06 · Active RRSP card — should render alongside LTD + Health
    await page.screenshot({ path: "test-results/slice-d/06-active-rrsp-card.png", fullPage: true });

    // 04 · Enrol form open (with the RRSP-tagged plan choice available if
    // we choose a plan the employee is not enrolled in — fixture has RRSP
    // already enrolled, so the Enrol form list may exclude it; capture
    // regardless to prove the form works)
    const enrolBtn = page.getByTestId("benefits-enrol-btn");
    if (await enrolBtn.isVisible().catch(() => false)) {
      await enrolBtn.click();
      await expect(page.getByTestId("benefits-enrol-form")).toBeVisible();
      await page.screenshot({ path: "test-results/slice-d/04-enrol-in-rrsp-form.png", fullPage: true });

      // 05 · RRSP election 5% — if a percent-input surfaces for the
      // default plan, fill 5.00; capture the form-state either way.
      const percentInput = page.getByTestId("benefits-enrol-percent");
      if (await percentInput.isVisible().catch(() => false)) {
        await percentInput.fill("5.00");
        await page.screenshot({ path: "test-results/slice-d/05-rrsp-election-5pct.png", fullPage: true });
      }
      const cancel = page.locator('[data-testid="benefits-enrol-form"] button:has-text("Cancel")').first();
      if (await cancel.isVisible().catch(() => false)) await cancel.click();
    }

    // Now interact with the ACTIVE RRSP card specifically for Change/End.
    // Find the RRSP active enrolment card by its "Long-Term …" or "RRSP" text.
    const rrspCard = page.locator('[data-testid^="benefit-enrolment-active-"]').filter({ hasText: /RRSP/ }).first();
    if (await rrspCard.isVisible().catch(() => false)) {
      await rrspCard.scrollIntoViewIfNeeded();
      const cardId = (await rrspCard.getAttribute("data-testid"))?.replace("benefit-enrolment-active-", "") ?? "";
      // 07 · Change form
      const chBtn = page.getByTestId(`benefit-change-btn-${cardId}`);
      if (await chBtn.isVisible().catch(() => false)) {
        await chBtn.click();
        await expect(page.getByTestId(`benefits-change-form-${cardId}`)).toBeVisible();
        await page.screenshot({ path: "test-results/slice-d/07-change-rrsp-election-form.png", fullPage: true });
        const cancel = page.locator(`[data-testid="benefits-change-form-${cardId}"] button:has-text("Cancel")`).first();
        if (await cancel.isVisible().catch(() => false)) await cancel.click();
      }
      // 08 · End form
      const endBtn = page.getByTestId(`benefit-end-btn-${cardId}`);
      if (await endBtn.isVisible().catch(() => false)) {
        await endBtn.click();
        await expect(page.getByTestId(`benefits-end-form-${cardId}`)).toBeVisible();
        await page.screenshot({ path: "test-results/slice-d/08-end-rrsp-enrolment-form.png", fullPage: true });
        const cancel = page.locator(`[data-testid="benefits-end-form-${cardId}"] button:has-text("Cancel")`).first();
        if (await cancel.isVisible().catch(() => false)) await cancel.click();
      }
    }

    // 09 · History disclosure (fixture has ENDED historical LTD; add RRSP
    // history if any) — open and screenshot.
    const hist = page.getByTestId("benefits-history-disclosure");
    if (await hist.isVisible().catch(() => false)) {
      await hist.evaluate((el: HTMLDetailsElement) => { el.open = true; });
      await hist.scrollIntoViewIfNeeded();
      await page.screenshot({ path: "test-results/slice-d/09-rrsp-history-disclosure.png", fullPage: true });
    }
  });
});
