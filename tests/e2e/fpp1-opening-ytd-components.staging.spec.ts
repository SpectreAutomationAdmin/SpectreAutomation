// FPP-1 (2026-09-20) §2 — full modal Payroll Component YTD write flow
// on the synthetic Slice-C tenant (MID_YEAR_MIGRATION mode applied via
// scripts/fpp1-synthetic-midyear-fixture.mjs).
//
// Chris + Marc are NEVER touched — the spec targets only the synthetic
// employee id (`SliceC BenefitsFixture` under
// `SLICE C BENEFITS TEST — Synthetic Club`).
//
// The synthetic Club is currently the ACTIVE club on the founder's
// account so direct-URL nav resolves without a club-switch. All
// navigations use absolute staging URLs to sidestep the Playwright
// default `baseURL` (`http://localhost:3000`) which would otherwise
// bounce the session to a login page on the localhost origin.

import { test, expect } from "@playwright/test";
import { loginAs, loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

const STAGING = "https://staging.spectreautomation.com";
const OUT_DIR = "test-results/fpp1-opening-ytd";
const SYNTHETIC_EMPLOYEE_ID = "cmu7yra83000ypdvdytfjvexl"; // SliceC BenefitsFixture
const CHRIS_ID = "cmu0fiaod000187prcy9ufo2d";
// FPP-1 §2 — use the synthetic Club's own admin so the founder default
// active club (Coulee Ridge) never intersects with this spec's writes.
const SYNTH_ADMIN_EMAIL = "slice-c-benefits-test-admin@fixture.spectre.test";
const SYNTH_ADMIN_PASSWORD =
  process.env.SPECTRE_FIXTURE_ADMIN_PASSWORD ?? "SliceC-Benefits-Fixture-2026!";

test.describe.configure({ mode: "serial" });

test.describe("FPP-1 §2 — full Payroll Component YTD modal write flow", () => {
  const consoleErrors: string[] = [];

  test.beforeAll(() => {
    const { ready, reason } = stagingCredsAvailable();
    test.skip(!ready, reason ?? "staging creds unavailable");
  });

  test("A–Z: synthetic employee → set opening YTD → add components → duplicate → remove → re-add → validate/activate → detail", async ({ context }) => {
    // §2 uses the synthetic Club's own admin so the active club is the
    // synthetic tenant by construction (no founder-side switch needed).
    const page = await loginAs(context, SYNTH_ADMIN_EMAIL, SYNTH_ADMIN_PASSWORD, { landing: "/app/admin" });
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    await page.setViewportSize({ width: 1440, height: 900 });

    // A. Synthetic Employee → Payroll loads.
    await page.goto(
      `${STAGING}/app/admin/people/employees/${SYNTHETIC_EMPLOYEE_ID}?tab=payroll`,
      { waitUntil: "domcontentloaded" },
    );
    await page.getByTestId("employee-payroll-grid").waitFor({ state: "visible", timeout: 30_000 });
    await page.screenshot({ path: `${OUT_DIR}/A-synth-payroll-tab.png`, fullPage: false });

    // B. Click Set Opening YTD.
    const openBtn = page.locator('[data-testid="opening-ytd-open-editor"]').first();
    await openBtn.waitFor({ state: "visible", timeout: 15_000 });
    await openBtn.click();

    // C. Modal opens in-profile.
    await page.locator('[data-testid="opening-ytd-modal"]').waitFor({ state: "visible", timeout: 10_000 });
    await page.screenshot({ path: `${OUT_DIR}/B-C-modal-open.png`, fullPage: false });

    // D. Aggregate opening fields visible.
    for (const name of [
      "ytdGrossEarnings", "ytdTaxableEarnings", "ytdPensionableEarnings", "ytdInsurableEarnings",
      "ytdCppEE", "ytdCpp2EE", "ytdEiEE", "ytdFederalTax", "ytdProvincialTax",
      "ytdCppER", "ytdCpp2ER", "ytdEiER",
    ]) {
      await expect(page.locator(`[data-testid="opening-ytd-${name}"]`)).toBeVisible();
    }

    // E. throughPayDate guidance mentions "BEFORE Spectre's first payroll".
    const modalBody = (await page.getByTestId("opening-ytd-modal").textContent()) ?? "";
    expect(modalBody, "modal copy should state 'BEFORE Spectre's first payroll'").toMatch(/before spectre.?s first payroll/i);

    // F. Enter a valid throughPayDate preceding firstSpectrePayDate (Oct 15 → Sep 30 works).
    const throughInput = page.locator('[data-testid="opening-ytd-through-pay-date"]');
    await throughInput.fill("2026-09-30");

    // G. Save the DRAFT successfully. The server action returns a
    // redirect back to the payroll tab; the modal is unmounted on
    // re-render. Force a hard nav to make the state deterministic.
    await page.locator('[data-testid="opening-ytd-save-draft"]').click();
    await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});
    await page.goto(
      `${STAGING}/app/admin/people/employees/${SYNTHETIC_EMPLOYEE_ID}?tab=payroll`,
      { waitUntil: "domcontentloaded" },
    );
    await page.getByTestId("employee-payroll-grid").waitFor({ state: "visible", timeout: 15_000 });
    // Reopen the editor.
    await page.locator('[data-testid="opening-ytd-open-editor"]').first().click();
    await page.locator('[data-testid="opening-ytd-modal"]').waitFor({ state: "visible", timeout: 10_000 });

    // H. Payroll Component YTD section visible.
    await expect(page.getByTestId("opening-ytd-components")).toBeVisible();
    await page.screenshot({ path: `${OUT_DIR}/H-components-section.png`, fullPage: true });

    // I / J. + Add form uses human-readable component labels.
    const picker = page.locator('[data-testid="opening-ytd-component-picker"]');
    await expect(picker).toBeVisible();
    const optionLabels = await picker.locator("option").allTextContents();
    // Options are shaped "DisplayName (CODE) — EE|ER".
    const humanReadable = optionLabels.filter((o) => /\(.+\) — (EE|ER)/.test(o));
    expect(humanReadable.length, "picker options should be human-readable").toBeGreaterThan(0);

    // K–O. Add component openings using whichever components exist on the tenant.
    // The synthetic Slice-C fixture provisions RRSP EE + RRSP ER + LTD +
    // HEALTH_DENTAL + CELL_PHONE-family components; the picker labels reflect
    // the club's own catalogue.
    async function reopenEditor() {
      await page.goto(
        `${STAGING}/app/admin/people/employees/${SYNTHETIC_EMPLOYEE_ID}?tab=payroll`,
        { waitUntil: "domcontentloaded" },
      );
      await page.getByTestId("employee-payroll-grid").waitFor({ state: "visible", timeout: 15_000 });
      const editOrView =
        (await page.locator('[data-testid="opening-ytd-open-editor"]').count().catch(() => 0)) > 0
          ? '[data-testid="opening-ytd-open-editor"]'
          : '[data-testid="opening-ytd-view-values"]';
      await page.locator(editOrView).first().click();
      await page.locator('[data-testid="opening-ytd-modal"]').waitFor({ state: "visible", timeout: 10_000 });
    }

    async function pickAndAdd(match: RegExp, amount: string, label: string) {
      const options = await page
        .locator('[data-testid="opening-ytd-component-picker"] option')
        .allTextContents();
      const values = await page
        .locator('[data-testid="opening-ytd-component-picker"] option')
        .evaluateAll((els) => els.map((e) => (e as HTMLOptionElement).value));
      const idx = options.findIndex((t) => match.test(t));
      if (idx < 0) return { addedCode: null as string | null, label };
      const value = values[idx];
      await page.locator('[data-testid="opening-ytd-component-picker"]').selectOption(value);
      await page.locator('[data-testid="opening-ytd-component-amount"]').fill(amount);
      await page.locator('[data-testid="opening-ytd-component-add"]').click();
      await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});
      await reopenEditor();
      // Read back which code got added by finding the last row.
      const rows = await page.locator('[data-testid^="opening-ytd-component-row-"]').all();
      let addedCode: string | null = null;
      for (const r of rows) {
        const testid = await r.getAttribute("data-testid");
        if (!testid) continue;
        addedCode = testid.replace("opening-ytd-component-row-", "");
      }
      return { addedCode, label };
    }

    const cell   = await pickAndAdd(/cell.?phone|allowance/i,  "500.00", "Cell Phone");
    const rrspEE = await pickAndAdd(/RRSP.*(EE|Employee)/i,    "2000.00", "RRSP Employee");
    const rrspER = await pickAndAdd(/RRSP.*(ER|Employer|Match)/i, "1200.00", "RRSP Employer");
    const ltd    = await pickAndAdd(/LTD/i,                    "540.00",  "LTD");
    const health = await pickAndAdd(/health|dental/i,          "990.00",  "Health & Dental");
    await page.screenshot({ path: `${OUT_DIR}/KLMNO-five-components-added.png`, fullPage: true });

    // P. RRSP EE and RRSP ER render as separate rows with correct classification.
    if (rrspEE.addedCode && rrspER.addedCode) {
      expect(rrspEE.addedCode).not.toBe(rrspER.addedCode);
      // Classification column shows "Employee · …" vs "Employer · …".
      const rowEE = page.locator(`[data-testid="opening-ytd-component-row-${rrspEE.addedCode}"]`);
      const rowER = page.locator(`[data-testid="opening-ytd-component-row-${rrspER.addedCode}"]`);
      await expect(rowEE).toContainText(/Employee/);
      await expect(rowER).toContainText(/Employer/);
    }

    // Q. Duplicate prevention. After adding Cell Phone above, the picker should
    // no longer expose it — the UI's understandable duplicate-prevention.
    if (cell.addedCode) {
      const remainingOptions = await page
        .locator('[data-testid="opening-ytd-component-picker"] option')
        .allTextContents();
      const cellStillListed = remainingOptions.some((o) => new RegExp(cell.addedCode!).test(o));
      expect(cellStillListed, `already-used component ${cell.addedCode} should NOT be in the picker (duplicate prevention)`).toBe(false);
    }

    // R. Remove one component while DRAFT.
    if (ltd.addedCode) {
      page.once("dialog", (d) => d.accept().catch(() => {}));
      await page.locator(`[data-testid="opening-ytd-component-remove-${ltd.addedCode}"]`).click();
      await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});
      await reopenEditor();
      await expect(page.locator(`[data-testid="opening-ytd-component-row-${ltd.addedCode}"]`)).toHaveCount(0);
      await page.screenshot({ path: `${OUT_DIR}/R-ltd-removed.png`, fullPage: true });

      // S. Re-add it.
      const reAdd = await pickAndAdd(/LTD/i, "540.00", "LTD (re-add)");
      expect(reAdd.addedCode, "re-adding LTD should succeed").toBeTruthy();
    }

    // T. Validate/activate the synthetic opening balance through the real UI.
    const validateBtn = page.locator('[data-testid="opening-ytd-validate"]');
    if (await validateBtn.count().catch(() => 0)) {
      await validateBtn.click();
      await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});
      await reopenEditor();
    }
    // Activate if the button is present.
    const activateBtn = page.locator('[data-testid="opening-ytd-activate"]');
    if (await activateBtn.count().catch(() => 0)) {
      page.once("dialog", (d) => d.accept().catch(() => {}));
      await activateBtn.click();
      await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});
      await reopenEditor();
    }

    // U. After ACTIVE, mutation controls disappear (no Add + no Remove).
    const addAfterActive = await page.locator('[data-testid="opening-ytd-component-add"]').count().catch(() => 0);
    const removeAfterActive = await page.locator('[data-testid^="opening-ytd-component-remove-"]').count().catch(() => 0);
    expect(addAfterActive + removeAfterActive, "no Add/Remove controls should be present once ACTIVE").toBe(0);
    await page.screenshot({ path: `${OUT_DIR}/U-active-immutable.png`, fullPage: true });

    // V. Close + reload the Payroll tab and prove the opening balance remains.
    await page.locator('[data-testid="opening-ytd-close"]').click().catch(() => {});
    await page.goto(
      `${STAGING}/app/admin/people/employees/${SYNTHETIC_EMPLOYEE_ID}?tab=payroll`,
      { waitUntil: "domcontentloaded" },
    );
    await page.getByTestId("employee-payroll-grid").waitFor({ state: "visible", timeout: 15_000 });
    const statusPill = page.locator('[data-testid="opening-ytd-status-pill"]').first();
    await expect(statusPill).toBeVisible();
    await page.screenshot({ path: `${OUT_DIR}/V-persisted-after-reload.png`, fullPage: false });

    // W. View Full Details — component YTD groups render.
    const detailLink = page.locator('[data-testid="grid-view-ytd-details"]');
    const detailHref = await detailLink.getAttribute("href");
    expect(detailHref).toContain("/ytd-detail");
    const detailUrl = detailHref!.startsWith("http") ? detailHref! : `${STAGING}${detailHref}`;
    await page.goto(detailUrl, { waitUntil: "domcontentloaded" });
    await page.getByTestId("employee-ytd-detail-page").waitFor({ state: "visible", timeout: 15_000 });
    for (const g of [
      "ytd-detail-aggregate",
      "ytd-detail-recurring",
      "ytd-detail-other-earnings",
      "ytd-detail-ee-deductions",
      "ytd-detail-er-contributions",
    ]) {
      await expect(page.getByTestId(g)).toBeVisible();
    }
    await page.screenshot({ path: `${OUT_DIR}/W-ytd-detail-groups.png`, fullPage: true });

    // X. No anchor to the old opening-balances 404.
    await page.goto(
      `${STAGING}/app/admin/people/employees/${SYNTHETIC_EMPLOYEE_ID}?tab=payroll`,
      { waitUntil: "domcontentloaded" },
    );
    const broken = await page
      .locator('a[href*="/app/admin/payroll/opening-balances?employeeId="]')
      .count();
    expect(broken).toBe(0);

    // Y. Every navigation above returned a rendered page (not 404) — verified by
    //    the presence of testids checked at each step.

    // Z. No console errors attributable to FPP-1 (allow ambient errors emitted
    //    by unrelated integrations by filtering on well-known unrelated noise).
    const relevantErrors = consoleErrors.filter(
      (e) => /opening.?ytd|ytd-detail|payroll-grid|component-picker/i.test(e),
    );
    if (relevantErrors.length > 0) {
      console.error("FPP-1-attributable console errors:", relevantErrors);
    }
    expect(relevantErrors, "no FPP-1-attributable console errors").toEqual([]);

    // Read-only invariant on Chris: verify via the founder account since
    // the synthetic-admin session cannot see Coulee Ridge. Use a fresh
    // context to keep the two sessions independent.
    const founderContext = await context.browser()!.newContext();
    try {
      const fpage = await loginAsFounder(founderContext, { landing: "/app/admin" });
      await fpage.goto(`${STAGING}/app/admin/people/employees/${CHRIS_ID}?tab=payroll`, { waitUntil: "domcontentloaded" });
      await fpage.getByTestId("employee-payroll-grid").waitFor({ state: "visible", timeout: 15_000 });
      // Chris's Opening YTD status pill should be present but the
      // components section should not (no opening balance = no components).
      const chrisComponents = await fpage.locator('[data-testid="opening-ytd-components"]').count();
      expect(chrisComponents, "Chris must have zero components — no writes touched him").toBe(0);
    } finally {
      await founderContext.close();
    }
  });
});
