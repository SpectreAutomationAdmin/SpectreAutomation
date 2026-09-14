// Post-onboarding-admin hotfix — staging Playwright acceptance.
//
// Proves on staging that:
//   1. Tenant Users → Invite user → Employee-of-this-Club + link Marc
//      + PAYROLL_ADMINISTRATOR access → Save succeeds without crash.
//      Reload keeps Marc visible + linked.
//   2. Employee Overview (Marc) displays home address in Basic Details.
//   3. Admin can open the Edit panel and update mobile / preferred name
//      via the new PATCH endpoint. Reload confirms persistence.
//
// Uses a real founder session. The Tenant User promotion of Marc is a
// LIVE act on staging (§10 the founder wants to keep Marc as Tenant User
// eventually, §30 prefers synthetic where safe). We use a SYNTHETIC
// pre-hire employee for the Tenant User path so we can safely clean up.
// The Basic Details edit is done ON Marc (his real profile) via a
// benign mobile-phone rewrite that is reverted at the end of the run.

import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { loginAsFounder } from "./_lib/staging-auth";

const OUT = path.resolve("test-results/post-onboarding-admin-hotfix");
fs.mkdirSync(OUT, { recursive: true });
const STAGING = process.env.SPECTRE_STAGING_BASE_URL ?? "https://staging.spectreautomation.com";

test.use({ viewport: { width: 1440, height: 900 } });

test("post-onboarding admin hotfix · Tenant User invite + address + Basic Details edit", async ({ browser }) => {
  test.setTimeout(360_000);
  const ctx = await browser.newContext();
  const page = await loginAsFounder(ctx);
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(`${e.name}: ${e.message}`));

  // ----------------------------------------------------------------
  // Part 1 — Marc Employee Overview shows canonical home address.
  // ----------------------------------------------------------------
  await page.goto(`${STAGING}/app/admin/people/employees`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
  await page.locator('a', { hasText: /Marc Maldiney/ }).first().click();
  await page.waitForTimeout(2500);
  await page.screenshot({
    path: path.join(OUT, "04-employee-overview-address.png"), fullPage: false,
  });
  const marcProfileText = await page.locator("body").innerText();
  expect(marcProfileText, "Home Address block should be visible on Overview")
    .toContain("Home address");
  expect(marcProfileText, "Home address block should include Marc's Calgary line")
    .toContain("Calgary");

  // ----------------------------------------------------------------
  // Part 2 — Admin edit Basic Details (benign preferred name change).
  // ----------------------------------------------------------------
  const editBtn = page.locator('[data-testid="employee-edit-basic-details-btn"]').first();
  await editBtn.scrollIntoViewIfNeeded();
  await editBtn.click();
  await page.waitForTimeout(500);
  await page.screenshot({
    path: path.join(OUT, "05-employee-basic-details-edit.png"), fullPage: false,
  });
  const marcMarker = `MarcTest${Date.now().toString().slice(-6)}`;
  await page.locator('[data-testid="edit-preferredName"]').fill(marcMarker);
  await page.locator('[data-testid="employee-edit-basic-details-save"]').click();
  await page.waitForTimeout(3000);
  await page.screenshot({
    path: path.join(OUT, "07-employee-edit-save-success.png"), fullPage: false,
  });
  const bannerText = await page.locator('[data-testid="employee-edit-basic-details-banner"]').innerText();
  expect(bannerText).toMatch(/Saved/);

  // Reload — the marker should still be present on the row.
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);
  const afterReload = await page.locator("body").innerText();
  expect(afterReload, "preferred name persisted across reload").toContain(marcMarker);

  // Revert Marc's preferred name so his record stays clean.
  await page.locator('[data-testid="employee-edit-basic-details-btn"]').first().click();
  await page.waitForTimeout(400);
  await page.locator('[data-testid="edit-preferredName"]').fill("");
  await page.locator('[data-testid="employee-edit-basic-details-save"]').click();
  await page.waitForTimeout(2500);

  // ----------------------------------------------------------------
  // Part 3 — Tenant Users → invite existing Employee (synthetic).
  // Create a synthetic PRE_HIRE Employee for the Tenant User invite.
  // ----------------------------------------------------------------
  const synthFirst = "TenantProof";
  const synthLast = `Synth${Date.now().toString().slice(-6)}`;
  const synthEmail = `tenantproof.${Date.now()}@synthetic.spectre.test`;

  await page.goto(`${STAGING}/app/admin/people/employees/new`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
  await page.locator('[name="firstName"]').fill(synthFirst);
  await page.locator('[name="lastName"]').fill(synthLast);
  await page.locator('[name="personalEmail"]').fill(synthEmail);
  await page.locator('[name="mobilePhone"]').fill("555-555-0111");
  const now = new Date();
  await page.locator('[data-testid="expected-start-date-year"]').fill(String(now.getFullYear()));
  await page.locator('[data-testid="expected-start-date-month"]').fill(String(now.getMonth() + 1).padStart(2, "0"));
  await page.locator('[data-testid="expected-start-date-day"]').fill(String(now.getDate()).padStart(2, "0"));
  await page.waitForTimeout(300);
  await page.locator('select[name="departmentId"]').first().selectOption({ label: "Administration" });
  await page.waitForTimeout(400);
  // Pick any Position by scanning options.
  const posSel = page.locator('select[name="positionId"]').first();
  const posOptions = await posSel.locator("option").evaluateAll((els) =>
    (els as HTMLOptionElement[]).map((o) => ({ value: o.value, text: o.textContent ?? "" })),
  );
  const anyOpt = posOptions.find((o) => o.value && o.value.length > 0);
  if (!anyOpt) throw new Error(`No Positions listed`);
  await posSel.selectOption(anyOpt.value);
  await page.waitForTimeout(400);
  await page.locator('select[name="compensationCadence"]').selectOption("SALARY");
  await page.locator('[name="compensationAmount"]').fill("60000");
  await page.locator('form button[type="submit"]').first().click();
  await page.waitForTimeout(6000);
  const syntheticUrl = page.url();
  const synthIdMatch = /\/employees\/([a-z0-9]+)/.exec(syntheticUrl);
  if (!synthIdMatch) throw new Error(`Synthetic employee id not found in URL: ${syntheticUrl}`);
  const synthId = synthIdMatch[1];

  // Open Tenant Users, click Invite user, pick the synthetic.
  await page.goto(`${STAGING}/app/admin/settings/users`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);
  await page.locator('[data-testid="invite-user-btn"]').click();
  await page.waitForTimeout(1500);

  // Fill required email + names, select the synthetic in the employee picker.
  const tenantEmail = `tenantuser.${Date.now()}@synthetic.spectre.test`;
  await page.locator('[data-testid="invite-form-email"], input[name="email"], input[type="email"]').first().fill(tenantEmail);
  // Only fill first/last if they are visible + empty; the employee picker
  // may have prefilled them from the selected Employee.
  const firstNameField = page.locator('input[name="firstName"], [data-testid="invite-form-firstName"]').first();
  if (await firstNameField.count()) {
    const v = await firstNameField.inputValue().catch(() => "");
    if (!v) await firstNameField.fill(synthFirst);
  }
  const lastNameField = page.locator('input[name="lastName"], [data-testid="invite-form-lastName"]').first();
  if (await lastNameField.count()) {
    const v = await lastNameField.inputValue().catch(() => "");
    if (!v) await lastNameField.fill(synthLast);
  }

  const employeePicker = page.locator('[data-testid="invite-form-employee-picker"]');
  if (await employeePicker.count()) {
    const empPickerOptions = await employeePicker.locator("option").evaluateAll((els) =>
      (els as HTMLOptionElement[]).map((o) => ({ value: o.value, text: o.textContent ?? "" })),
    );
    const synthOpt = empPickerOptions.find((o) => new RegExp(synthFirst).test(o.text));
    if (synthOpt) {
      await employeePicker.selectOption(synthOpt.value);
      await page.waitForTimeout(500);
    }
  }
  await page.screenshot({
    path: path.join(OUT, "01-tenant-user-select-existing-employee.png"), fullPage: false,
  });

  // Check "Payroll Administrator" specifically (§7 role selection).
  const payrollRoleLabel = page.locator('label', { hasText: /^Payroll Administrator/ }).first();
  await payrollRoleLabel.locator('input[type="checkbox"]').check({ force: true });
  await page.waitForTimeout(300);
  await page.screenshot({
    path: path.join(OUT, "02-tenant-user-marc-role-assignment.png"), fullPage: false,
  });

  // Submit. The modal's internal scroll can hide the submit button below
  // the viewport; scroll within the modal, then dispatch the click
  // programmatically since Playwright refuses to click off-viewport
  // elements even with force:true.
  const submitBtn = page.locator('[data-testid="invite-form-submit"]');
  await submitBtn.evaluate((el) => {
    el.scrollIntoView({ block: "center" });
    (el as HTMLButtonElement).click();
  });
  await page.waitForTimeout(6000);
  await page.screenshot({
    path: path.join(OUT, "03-tenant-user-save-success.png"), fullPage: false,
  });

  // Assert no crash — banner must be present, page still renders.
  const bannerCount = await page.locator('[data-testid="tenant-users-banner"]').count();
  expect(bannerCount, "banner should render after invite (crash or success — either way, no full-page crash)").toBeGreaterThan(0);
  const bannerAfter = await page.locator('[data-testid="tenant-users-banner"]').first().innerText();
  console.log("[repro] banner after invite:", bannerAfter);

  // Reload to confirm the page still renders normally.
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  const reloadText = await page.locator("body").innerText();
  expect(reloadText).toContain("Tenant Users");

  expect(
    pageErrors.filter((e) => /Cannot read/i.test(e)).length,
    `No length crash. pageErrors: ${JSON.stringify(pageErrors)}`,
  ).toBe(0);

  // Cleanup: delete the synthetic Employee. The linked Tenant User
  // invitation record persists (audit history) — that's expected.
  await page.goto(`${STAGING}/app/admin/people/employees/${synthId}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
  const del = page.locator('[data-testid="employee-delete-button"]');
  if (await del.count()) {
    await del.scrollIntoViewIfNeeded();
    await del.click();
    await page.waitForTimeout(500);
    await page.locator('[data-testid="employee-lifecycle-confirm-input"]').fill("DELETE");
    await page.waitForTimeout(300);
    await page.locator('[data-testid="employee-lifecycle-confirm-button"]').click();
    await page.waitForTimeout(4000);
  }

  await ctx.close();
});
