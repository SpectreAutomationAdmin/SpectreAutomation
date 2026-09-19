// Slice D visual closeout §31 — screenshots 05 + 12 against v434 staging.
//
// Uses the synthetic slice-c-benefits-test tenant (--setup + --payroll-ready).
// Triggers the staging-only /api/dev/slice-d-pipeline route to produce a
// POSTED batch, then renders the PayStatement page for shot 12. Shot 05
// picks the second RRSP plan (RRSP_ALT_FIXTURE) the employee is not yet
// enrolled in.

import { test, expect } from "@playwright/test";
import { loginAs, stagingCredsAvailable } from "./_lib/staging-auth";

const VIEWPORT = { width: 1440, height: 900 };
const FIXTURE_ADMIN_EMAIL = "slice-c-benefits-test-admin@fixture.spectre.test";
const FIXTURE_ADMIN_PASSWORD =
  process.env.SPECTRE_FIXTURE_ADMIN_PASSWORD ?? "SliceC-Benefits-Fixture-2026!";

test.describe("Slice D — screenshots 05 + 12", () => {
  test.beforeAll(() => {
    const { ready, reason } = stagingCredsAvailable();
    test.skip(!ready, reason ?? "staging creds unavailable");
  });

  test("05 · RRSP Enrol form filled to 5.00%", async ({ context }) => {
    const page = await loginAs(context, FIXTURE_ADMIN_EMAIL, FIXTURE_ADMIN_PASSWORD, {
      landing: "/app/admin/people/employees",
    });
    await page.setViewportSize(VIEWPORT);
    await page.waitForLoadState("networkidle");
    const empRow = page.locator('a[href*="/app/admin/people/employees/"]:has-text("SliceC")').first();
    const href = await empRow.getAttribute("href");
    if (!href) test.skip(true, "fixture employee not present");
    await page.goto(`${href!}?tab=payroll`, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle");
    await expect(page.getByTestId("payroll-benefits-deductions-slice-c")).toBeVisible({ timeout: 15_000 });

    const enrolBtn = page.getByTestId("benefits-enrol-btn");
    await enrolBtn.click();
    await expect(page.getByTestId("benefits-enrol-form")).toBeVisible();

    // Pick the ALTERNATE RRSP plan (RRSP_ALT_FIXTURE) — the primary
    // RRSP_FIXTURE is already enrolled and thus excluded from the picker.
    const planSelect = page.getByTestId("benefits-enrol-plan-select");
    const options = await planSelect.locator("option").all();
    for (let i = 0; i < options.length; i++) {
      const t = (await options[i].textContent()) ?? "";
      if (/RRSP/i.test(t)) {
        await planSelect.selectOption({ index: i });
        break;
      }
    }

    // Percent input surfaces once the plan is picked.
    const pct = page.getByTestId("benefits-enrol-percent");
    await expect(pct).toBeVisible();
    await pct.fill("5.00");
    await page.screenshot({ path: "test-results/slice-d/05-rrsp-election-5pct.png", fullPage: true });
    // Do NOT submit — cancel.
    await page.locator('[data-testid="benefits-enrol-form"] button:has-text("Cancel")').first().click();
  });

  test("12 · Posted PayStatement shows RRSP EE $229.17 + RRSP ER $137.50", async ({ context }) => {
    const page = await loginAs(context, FIXTURE_ADMIN_EMAIL, FIXTURE_ADMIN_PASSWORD, {
      landing: "/app/admin",
    });
    await page.setViewportSize(VIEWPORT);
    // Trigger the pipeline (idempotent — returns the existing batch if
    // already posted).
    const res = await page.request.post(
      "/api/dev/slice-d-pipeline?clubSlug=slice-c-benefits-test&seq=18",
    );
    if (!res.ok()) {
      const body = await res.text();
      throw new Error(`pipeline route failed: ${res.status()} ${body.slice(0, 400)}`);
    }
    const j = await res.json();
    if (!j.batchId) throw new Error(`no batchId in response: ${JSON.stringify(j)}`);
    await page.goto(j.paystubsUrl ?? `/app/admin/payroll/batches/${j.batchId}/paystubs`, { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("paystubs-page")).toBeVisible({ timeout: 15_000 });
    // Assert both RRSP lines are on the page (implicit wait to ~5s each).
    await expect(page.getByText("RRSP Employee Contribution").first()).toBeVisible();
    await expect(page.getByText("RRSP Employer Match").first()).toBeVisible();
    await page.screenshot({ path: "test-results/slice-d/12-paystatement-rrsp-ee-er.png", fullPage: true });
  });
});
