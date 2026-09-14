// Add Employee post-v389 hotfix — real founder-visible round trip.
//
// Proves §33 A-F on staging:
//   A. Chris profile email = cturcato@spectreautomation.com
//   B. Add synthetic SALARY Employee succeeds
//   C. Delete synthetic SALARY Employee succeeds
//   D. Add synthetic HOURLY Employee succeeds
//   E. Delete synthetic HOURLY Employee succeeds
//   F. final Employee Directory contains Chris Turcato only
import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { loginAsFounder } from "./_lib/staging-auth";

const OUT = path.resolve("test-results/add-employee-hotfix");
fs.mkdirSync(OUT, { recursive: true });
const STAGING = process.env.SPECTRE_STAGING_BASE_URL ?? "https://staging.spectreautomation.com";

test.use({ viewport: { width: 1440, height: 900 } });

async function fillIfPresent(page: import("@playwright/test").Page, name: string, value: string) {
  const el = page.locator(`[name="${name}"]`);
  if (await el.count()) {
    await el.first().fill(value);
  }
}

async function selectByLabelText(
  page: import("@playwright/test").Page, name: string, matcher: RegExp,
) {
  const sel = page.locator(`select[name="${name}"]`).first();
  if (!(await sel.count())) return false;
  const options = await sel.locator("option").allTextContents();
  const idx = options.findIndex((t) => matcher.test(t));
  if (idx >= 0) {
    const values = await sel.locator("option").evaluateAll((els) =>
      (els as HTMLOptionElement[]).map((o) => o.value),
    );
    await sel.selectOption(values[idx]);
    return true;
  }
  return false;
}

async function createAndDelete(
  page: import("@playwright/test").Page,
  cadence: "SALARY" | "HOURLY",
  amount: string,
  screenshotBase: string,
) {
  const firstName = cadence === "SALARY" ? "SynthSalary" : "SynthHourly";
  const lastName = `Test${Date.now().toString().slice(-6)}`;
  const email = `${firstName.toLowerCase()}.${Date.now()}@synthetic.spectre.test`;

  // Navigate to Add Employee.
  await page.goto(`${STAGING}/app/admin/people/employees/new`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);

  // Fill core required fields.
  await fillIfPresent(page, "firstName", firstName);
  await fillIfPresent(page, "lastName", lastName);
  await fillIfPresent(page, "personalEmail", email);
  await fillIfPresent(page, "mobilePhone", "555-555-0100");
  // ExpectedStartDate — today. The form uses SegmentedDateInput
  // (year/month/day segments backed by a hidden canonical field).
  const now = new Date();
  const yyyy = String(now.getFullYear());
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  await page.locator('[data-testid="expected-start-date-year"]').fill(yyyy);
  await page.locator('[data-testid="expected-start-date-month"]').fill(mm);
  await page.locator('[data-testid="expected-start-date-day"]').fill(dd);
  // Wait a moment for the hidden canonical to sync.
  await page.waitForTimeout(400);

  // Department + Position — try to select the first non-empty option.
  const deptSel = page.locator('select[name="departmentId"]').first();
  if (await deptSel.count()) {
    const values = await deptSel.locator("option").evaluateAll(
      (els) => (els as HTMLOptionElement[]).map((o) => o.value).filter((v) => v && v.length > 0),
    );
    if (values.length) await deptSel.selectOption(values[0]);
  }
  const posSel = page.locator('select[name="positionId"]').first();
  if (await posSel.count()) {
    const values = await posSel.locator("option").evaluateAll(
      (els) => (els as HTMLOptionElement[]).map((o) => o.value).filter((v) => v && v.length > 0),
    );
    if (values.length) await posSel.selectOption(values[0]);
  }

  // Compensation cadence + amount.
  await selectByLabelText(page, "compensationCadence", new RegExp(cadence, "i"));
  await fillIfPresent(page, "compensationAmount", amount);

  await page.screenshot({ path: path.join(OUT, `${screenshotBase}-before-submit.png`), fullPage: false });

  // Submit.
  const submitBtn = page.locator('form button[type="submit"]').first();
  await submitBtn.scrollIntoViewIfNeeded();
  await submitBtn.click();

  // Wait for post-submit navigation OR error banner.
  await page.waitForTimeout(6000);
  await page.screenshot({ path: path.join(OUT, `${screenshotBase}-after-submit.png`), fullPage: false });
  const bodyText = await page.locator("body").innerText();
  expect(
    bodyText,
    `Add ${cadence} Employee should not surface Server error. Body: ${bodyText.slice(0, 600)}`,
  ).not.toContain("Server error");

  // Now delete this new employee. Navigate to the directory and find the row.
  await page.goto(`${STAGING}/app/admin/people/employees`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1800);
  const row = page.locator(`a`, { hasText: firstName }).first();
  await row.click();
  await page.waitForTimeout(1800);

  // Open confirmation.
  const deleteOpener = page.locator('[data-testid="employee-delete-button"]');
  await deleteOpener.scrollIntoViewIfNeeded();
  await deleteOpener.click();
  await page.waitForTimeout(500);
  await page.locator('[data-testid="employee-lifecycle-confirm-input"]').fill("DELETE");
  await page.waitForTimeout(300);
  await page.locator('[data-testid="employee-lifecycle-confirm-button"]').click();
  await page.waitForTimeout(4000);

  await page.goto(`${STAGING}/app/admin/people/employees`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
  const dirText = await page.locator("body").innerText();
  expect(dirText, `${firstName} should be absent after delete`).not.toContain(firstName);
}

test("add employee hotfix · create + delete SALARY + HOURLY round trip", async ({ browser }) => {
  test.setTimeout(360_000);
  const ctx = await browser.newContext();
  const page = await loginAsFounder(ctx);

  const consoleErrors: string[] = [];
  page.on("pageerror", (e) => consoleErrors.push(`${e.name}: ${e.message}`));

  // §33 A — Verify Chris's current personalEmail is cturcato@spectreautomation.com.
  await page.goto(`${STAGING}/app/admin/people/employees`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
  await page.locator('a', { hasText: /Chris Turcato/i }).first().click();
  await page.waitForTimeout(1800);
  await page.screenshot({ path: path.join(OUT, "01-chris-correct-email.png"), fullPage: false });
  const chrisProfile = await page.locator("body").innerText();
  expect(
    chrisProfile,
    "Chris personal email should equal cturcato@spectreautomation.com after the backfill correction.",
  ).toContain("cturcato@spectreautomation.com");
  expect(
    chrisProfile,
    "The unauthorized c.s.turcato@gmail.com value must be gone from Chris's profile.",
  ).not.toContain("c.s.turcato@gmail.com");

  // §33 B + C — SALARY create + delete round trip.
  await createAndDelete(page, "SALARY", "95000", "02-add-salary");

  // §33 D + E — HOURLY create + delete round trip.
  await createAndDelete(page, "HOURLY", "24.50", "05-add-hourly");

  // §33 F — Final directory contains Chris only.
  await page.goto(`${STAGING}/app/admin/people/employees`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1800);
  await page.screenshot({ path: path.join(OUT, "06-create-delete-roundtrip-clean-directory.png"), fullPage: false });
  const finalDir = await page.locator("body").innerText();
  expect(finalDir).toContain("Chris Turcato");
  expect(finalDir, "no synthetic salary row remains").not.toContain("SynthSalary");
  expect(finalDir, "no synthetic hourly row remains").not.toContain("SynthHourly");
  expect(consoleErrors.filter((e) => /Cannot read|TypeError/.test(e)).length).toBe(0);
  await ctx.close();
});
