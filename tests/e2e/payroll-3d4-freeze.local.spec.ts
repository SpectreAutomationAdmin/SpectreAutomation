// Payroll-3D-4 (2026-09-05) — Approved-time freeze Playwright.
//
// §81 clean-freeze acceptance: Taylor records time → Grounds manager
// approves → Payroll Admin visits the processing workspace → sees
// the Time Approval Readiness section, freezes Grounds, sees
// "Frozen · payroll input ready" state, no duplicate on refresh.
//
// Preconditions:
//   • dev server on http://localhost:3000
//   • `npm run fixture:payroll-3d1-taylor-hourly` + `npm run fixture:payroll-3d3`
//   • Founder preview seed has already assigned Alex Preview as
//     PayrollClubConfig.payrollAdminUserId for Coulee Ridge.

import { test, expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const OUT = path.resolve("test-results/payroll-3d4");
fs.mkdirSync(OUT, { recursive: true });

const TAYLOR      = "taylor.hourly@preview.spectre.test";
const GROUNDS_MGR = "grounds.manager@preview.spectre.test";
const ALEX_TA     = "alex.preview@preview.spectre.test";
const PASSWORD    = "TA1C-Preview-99";

function runFixture(script: string) {
  execFileSync("npm", ["run", script], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], shell: true,
  });
}

function resetAll(): { payPeriodId: string; groundsDepartmentId: string } {
  runFixture("fixture:payroll-3d1-taylor-hourly");
  const out = execFileSync("npm", ["run", "fixture:payroll-3d3"], {
    encoding: "utf8", shell: true,
  });
  const lastLine = out.trim().split("\n").filter((l) => l.startsWith("{")).at(-1)!;
  const j = JSON.parse(lastLine);
  return { payPeriodId: j.payPeriodId, groundsDepartmentId: j.grounds.departmentId };
}

async function adminSignIn(page: Page, email: string) {
  await page.goto("/login");
  const mainForm = page.locator("form").first();
  await mainForm.locator('input[type="email"]').fill(email);
  await mainForm.locator('input[type="password"]').fill(PASSWORD);
  await Promise.all([
    page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 30_000 }),
    mainForm.locator('button[type="submit"]').click(),
  ]);
}

async function portalSignIn(page: Page, email: string) {
  await page.goto("/employee/login");
  await page.locator('[data-testid="employee-login-email"]').fill(email);
  await page.locator('[data-testid="employee-login-password"]').fill(PASSWORD);
  await Promise.all([
    page.waitForURL(/\/employee(?!\/login).*/, { timeout: 30_000 }),
    page.locator('[data-testid="employee-login-submit"]').click(),
  ]);
}

test.describe.serial("Payroll-3D-4 · clean freeze via Payroll Admin workspace @1440x900", () => {
  test("§81 Taylor records + Grounds mgr approves + Payroll Admin freezes Grounds scope", async ({ browser }) => {
    const { payPeriodId, groundsDepartmentId } = resetAll();

    // Taylor: clock in + out in Grounds (single active assignment auto-selects).
    // The 3D-3A fixture gives Taylor 2 active assignments — pick Grounds explicitly.
    const ctxT = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const pT = await ctxT.newPage();
    await portalSignIn(pT, TAYLOR);
    await pT.goto("/employee/time");
    await expect(pT.locator('[data-testid="portal-time-clock"]:visible').first()).toBeVisible({ timeout: 30_000 });
    const picker = pT.locator('[data-testid="portal-time-assignment-picker"]:visible').first();
    const pickerVisible = await picker.isVisible().catch(() => false);
    if (pickerVisible) {
      const groundsOpt = picker.locator('option', { hasText: "Grounds" }).first();
      const val = await groundsOpt.getAttribute("value");
      await picker.selectOption(val!);
    }
    await pT.locator('[data-testid="portal-time-clock-in"]:visible').first().click();
    await expect(pT.locator('[data-testid="portal-time-state"]:visible').first())
      .toHaveAttribute("data-clock-state", "WORKING", { timeout: 10_000 });
    await pT.locator('[data-testid="portal-time-clock-out"]:visible').first().click();
    await expect(pT.locator('[data-testid="portal-time-state"]:visible').first())
      .toHaveAttribute("data-clock-state", "OFF_CLOCK", { timeout: 10_000 });
    await ctxT.close();

    // Grounds manager: approves.
    const ctxM = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const pM = await ctxM.newPage();
    await adminSignIn(pM, GROUNDS_MGR);
    await pM.goto(`/app/admin/payroll/time?payPeriodId=${payPeriodId}&departmentId=${groundsDepartmentId}&scope=timesheet`);
    await expect(pM.locator('[data-testid="timesheet-approval-workspace"]').first()).toBeVisible({ timeout: 30_000 });
    await expect(pM.locator('[data-testid="scope-status-ready"]').first()).toBeVisible();
    await pM.locator('[data-testid="approve-scope-btn"]').first().click();
    await expect(pM.locator('[data-testid="scope-status-approved"]').first()).toBeVisible({ timeout: 20_000 });
    await ctxM.close();

    // Payroll Admin (Alex): visits process workspace → sees Time Readiness section → Freeze.
    const ctxA = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const pA = await ctxA.newPage();
    await adminSignIn(pA, ALEX_TA);
    await pA.goto(`/app/admin/payroll/process?payPeriodId=${payPeriodId}`);
    await expect(pA.locator('[data-testid="time-readiness-section"]').first()).toBeVisible({ timeout: 30_000 });
    // Grounds row visible in state APPROVED_NOT_FROZEN → shows Freeze.
    const groundsRow = pA.locator('[data-testid^="time-readiness-row:GROUNDS"]').first();
    await expect(groundsRow).toBeVisible();
    await pA.screenshot({ path: path.join(OUT, "01-payroll-admin-readiness.png"), fullPage: true });

    const freezeBtn = pA.locator('[data-testid^="freeze-scope-btn:GROUNDS"]').first();
    await expect(freezeBtn).toBeVisible({ timeout: 10_000 });
    await freezeBtn.click();
    await expect(pA.locator('[data-testid="time-readiness-success"]').first()).toBeVisible({ timeout: 20_000 });
    await pA.screenshot({ path: path.join(OUT, "02-payroll-admin-frozen.png"), fullPage: true });

    // No duplicate on refresh — reloading should not surface a second Freeze button.
    await pA.reload();
    await expect(pA.locator('[data-testid="time-readiness-section"]').first()).toBeVisible({ timeout: 30_000 });
    // Grounds row state should now be FROZEN_READY — no freeze button.
    await expect(pA.locator('[data-testid^="freeze-scope-btn:GROUNDS"]')).toHaveCount(0);
    await expect(pA.locator('[data-testid^="time-readiness-state:GROUNDS"]').first()).toContainText(/Frozen/i);
    await pA.screenshot({ path: path.join(OUT, "03-payroll-admin-refreshed.png"), fullPage: true });
    await ctxA.close();
  });
});
