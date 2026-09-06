// Payroll-3D-3 (2026-09-05) — Manager Timesheet Approval Playwright.
//
// Covers §98-§101 of the 3D-3 brief.
//   • deep-link into the manager workspace + approve a clean scope
//   • correction: employee submits → manager approves → timesheet
//     updates and the previously-blocking exception disappears
//   • wrong-manager (Banquets) cannot approve Grounds
//
// Preconditions:
//   • dev server on http://localhost:3000
//   • fixture: `npm run fixture:payroll-3d1-taylor-hourly` then
//     `npm run fixture:payroll-3d3`.

import { test, expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const OUT = path.resolve("test-results/payroll-3d3");
fs.mkdirSync(OUT, { recursive: true });

const TAYLOR       = "taylor.hourly@preview.spectre.test";
const GROUNDS_MGR  = "grounds.manager@preview.spectre.test";
const BANQUETS_MGR = "banquets.manager@preview.spectre.test";
const PASSWORD     = "TA1C-Preview-99";

function runFixture(script: string) {
  execFileSync("npm", ["run", script], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], shell: true,
  });
}

function resetAll(): { payPeriodId: string; groundsDepartmentId: string; banquetsDepartmentId: string } {
  runFixture("fixture:payroll-3d1-taylor-hourly");
  const out = execFileSync("npm", ["run", "fixture:payroll-3d3"], {
    encoding: "utf8", shell: true,
  });
  const lastLine = out.trim().split("\n").filter((l) => l.startsWith("{")).at(-1)!;
  const j = JSON.parse(lastLine);
  return {
    payPeriodId: j.payPeriodId,
    groundsDepartmentId: j.grounds.departmentId,
    banquetsDepartmentId: j.banquets.departmentId,
  };
}

async function adminSignIn(page: Page, email: string) {
  await page.goto("/login");
  // Scope selectors to the main sign-in form (first form) to avoid
  // the demo quick-access forms below it.
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

async function taylorClockInOut(page: Page) {
  await page.goto("/employee/time");
  await expect(page.locator('[data-testid="portal-time-clock"]:visible').first()).toBeVisible({ timeout: 30_000 });
  await page.locator('[data-testid="portal-time-clock-in"]:visible').first().click();
  await expect(page.locator('[data-testid="portal-time-state"]:visible').first()).toHaveAttribute("data-clock-state", "WORKING", { timeout: 10_000 });
  await page.locator('[data-testid="portal-time-clock-out"]:visible').first().click();
  await expect(page.locator('[data-testid="portal-time-state"]:visible').first()).toHaveAttribute("data-clock-state", "OFF_CLOCK", { timeout: 10_000 });
}

test.describe.serial("Payroll-3D-3 · clean approval @1440x900", () => {
  test("§99 Grounds manager approves clean Grounds time", async ({ browser }) => {
    const { payPeriodId, groundsDepartmentId } = resetAll();
    const ctxTaylor = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const p1 = await ctxTaylor.newPage();
    await portalSignIn(p1, TAYLOR);
    await taylorClockInOut(p1);
    await ctxTaylor.close();

    // Manager reviews via deep-link URL (proves §98 deep-link works).
    const ctxMgr = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const p2 = await ctxMgr.newPage();
    await adminSignIn(p2, GROUNDS_MGR);
    await p2.goto(`/app/admin/payroll/time?payPeriodId=${payPeriodId}&departmentId=${groundsDepartmentId}&scope=timesheet`);
    await expect(p2.locator('[data-testid="timesheet-approval-workspace"]').first()).toBeVisible({ timeout: 30_000 });
    await p2.screenshot({ path: path.join(OUT, "01-manager-scope-ready.png"), fullPage: true });

    // Ready banner.
    await expect(p2.locator('[data-testid="scope-status-ready"]').first()).toBeVisible();

    // Approve.
    await p2.locator('[data-testid="approve-scope-btn"]').first().click();
    await expect(p2.locator('[data-testid="scope-status-approved"]').first()).toBeVisible({ timeout: 20_000 });
    await p2.screenshot({ path: path.join(OUT, "02-manager-approved.png"), fullPage: true });

    await ctxMgr.close();
  });
});

test.describe.serial("Payroll-3D-3 · correction flow @1440x900", () => {
  test("§100 Taylor requests missing clock-out; Grounds mgr approves the correction and the scope becomes ready", async ({ browser }) => {
    const { payPeriodId, groundsDepartmentId } = resetAll();

    // Taylor: Clock In only (leaves an open session → MISSING_CLOCK_OUT).
    const ctxTaylor = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const p1 = await ctxTaylor.newPage();
    await portalSignIn(p1, TAYLOR);
    await p1.goto("/employee/time");
    await expect(p1.locator('[data-testid="portal-time-clock"]:visible').first()).toBeVisible({ timeout: 30_000 });
    await p1.locator('[data-testid="portal-time-clock-in"]:visible').first().click();
    await expect(p1.locator('[data-testid="portal-time-state"]:visible').first()).toHaveAttribute("data-clock-state", "WORKING", { timeout: 10_000 });

    // Taylor: Timesheets → Request correction.
    await p1.goto("/employee/timesheets");
    await expect(p1.locator('[data-testid="portal-timesheet"]:visible').first()).toBeVisible({ timeout: 30_000 });
    await p1.locator('[data-testid="portal-timesheet-request-correction"]:visible').first().click();
    await expect(p1.locator('[data-testid="portal-correction-dialog"]:visible').first()).toBeVisible({ timeout: 10_000 });
    // Set an explicit proposed CLOCK_OUT well AFTER the CLOCK_IN so the
    // (default = now-floored-to-minute) value doesn't accidentally sit
    // BEFORE the just-created CLOCK_IN when the test races the clock.
    const timeInput = p1.locator('[data-testid="portal-correction-time"]:visible').first();
    const now = new Date();
    const later = new Date(now.getTime() + 4 * 60 * 60 * 1000); // +4h
    const pad = (n: number) => n.toString().padStart(2, "0");
    const laterIso = `${later.getFullYear()}-${pad(later.getMonth() + 1)}-${pad(later.getDate())}T${pad(later.getHours())}:${pad(later.getMinutes())}`;
    await timeInput.fill(laterIso);
    await p1.locator('[data-testid="portal-correction-reason"]:visible').first().fill("Forgot to clock out.");
    await p1.locator('[data-testid="portal-correction-submit"]:visible').first().click();
    await expect(p1.locator('[data-testid="portal-correction-dialog"]:visible')).toHaveCount(0, { timeout: 15_000 });
    await ctxTaylor.close();

    // Grounds Manager: sees blocked scope + pending correction; approves correction; scope becomes ready.
    const ctxMgr = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const p2 = await ctxMgr.newPage();
    await adminSignIn(p2, GROUNDS_MGR);
    await p2.goto(`/app/admin/payroll/time?payPeriodId=${payPeriodId}&departmentId=${groundsDepartmentId}&scope=timesheet`);
    await expect(p2.locator('[data-testid="timesheet-approval-workspace"]').first()).toBeVisible({ timeout: 30_000 });
    await expect(p2.locator('[data-testid="scope-status-blocked"]').first()).toBeVisible();
    const correctionRow = p2.locator('[data-testid^="correction-row:"]').first();
    await expect(correctionRow).toBeVisible({ timeout: 15_000 });
    await p2.screenshot({ path: path.join(OUT, "03-manager-correction-visible.png"), fullPage: true });

    await p2.locator('[data-testid^="correction-approve-btn:"]').first().click();
    // After router.refresh, scope should be ready (approve button enabled).
    await expect(p2.locator('[data-testid="scope-status-ready"]').first()).toBeVisible({ timeout: 30_000 });
    await p2.screenshot({ path: path.join(OUT, "04-manager-correction-approved.png"), fullPage: true });

    // Approve scope.
    await p2.locator('[data-testid="approve-scope-btn"]').first().click();
    await expect(p2.locator('[data-testid="scope-status-approved"]').first()).toBeVisible({ timeout: 20_000 });
    await ctxMgr.close();
  });
});

test.describe.serial("Payroll-3D-3 · wrong-manager denial @1440x900", () => {
  test("§101 Banquets manager cannot approve Grounds scope", async ({ browser }) => {
    const { payPeriodId, groundsDepartmentId } = resetAll();
    // Taylor clocks a clean session in Grounds.
    const ctxT = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const p1 = await ctxT.newPage();
    await portalSignIn(p1, TAYLOR);
    await taylorClockInOut(p1);
    await ctxT.close();

    // Banquets manager visits the Grounds deep-link. UI renders (read
    // is scoped by payroll:timesheets:read which they hold) BUT server
    // rejects any approve attempt.
    const ctxB = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const p2 = await ctxB.newPage();
    await adminSignIn(p2, BANQUETS_MGR);
    await p2.goto(`/app/admin/payroll/time?payPeriodId=${payPeriodId}&departmentId=${groundsDepartmentId}&scope=timesheet`);
    await expect(p2.locator('[data-testid="timesheet-approval-workspace"]').first()).toBeVisible({ timeout: 30_000 });
    await p2.locator('[data-testid="approve-scope-btn"]').first().click();
    // Should surface an error via the workspace error banner.
    await expect(p2.locator('[data-testid="scope-error"]').first()).toBeVisible({ timeout: 15_000 });
    await p2.screenshot({ path: path.join(OUT, "05-wrong-manager-denied.png"), fullPage: true });
    await ctxB.close();
  });
});
