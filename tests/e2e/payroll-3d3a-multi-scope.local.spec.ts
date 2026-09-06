// Payroll-3D-3A (2026-09-05) — Multi-scope routing + configuration-gap
// remediation acceptance.
//
// Covers §5-§7 (multi-scope browser proof) and §19 (config-gap remediation
// Playwright) of the 3D-3A brief.
//
// Preconditions:
//   • dev server on http://localhost:3000
//   • `npm run fixture:payroll-3d1-taylor-hourly` then
//     `npm run fixture:payroll-3d3` — both are idempotent

import { test, expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const OUT = path.resolve("test-results/payroll-3d3a");
fs.mkdirSync(OUT, { recursive: true });

const TAYLOR       = "taylor.hourly@preview.spectre.test";
const GROUNDS_MGR  = "grounds.manager@preview.spectre.test";
const BANQUETS_MGR = "banquets.manager@preview.spectre.test";
const ALEX_TA      = "alex.preview@preview.spectre.test";
const PASSWORD     = "TA1C-Preview-99";

function runFixture(script: string) {
  execFileSync("npm", ["run", script], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], shell: true,
  });
}

function resetAll(): {
  payPeriodId: string;
  groundsDepartmentId: string;
  banquetsDepartmentId: string;
} {
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

// ==================================================================
// Multi-scope routing proof (§5 / §7)
// ==================================================================
test.describe.serial("Payroll-3D-3A · multi-scope routing @1440x900", () => {
  test("§7 Taylor picks Banquets at Clock In → Banquets manager sees it, Grounds manager does not", async ({ browser }) => {
    const { payPeriodId, groundsDepartmentId, banquetsDepartmentId } = resetAll();

    // ---- Taylor: Clock In → pick Banquets (SECONDARY) → Clock Out ----
    const ctxT = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const pT = await ctxT.newPage();
    await portalSignIn(pT, TAYLOR);
    await pT.goto("/employee/time");
    await expect(pT.locator('[data-testid="portal-time-clock"]:visible').first()).toBeVisible({ timeout: 30_000 });

    // Picker must appear because Taylor has 2 active assignments.
    const picker = pT.locator('[data-testid="portal-time-assignment-picker"]:visible').first();
    await expect(picker).toBeVisible({ timeout: 15_000 });
    await pT.screenshot({ path: path.join(OUT, "01-taylor-picker-visible.png"), fullPage: true });

    // Pick the Banquets option by finding the option whose text matches.
    const banquetsOpt = picker.locator('option', { hasText: "Banquets" }).first();
    const banquetsVal = await banquetsOpt.getAttribute("value");
    await picker.selectOption(banquetsVal!);
    await pT.locator('[data-testid="portal-time-clock-in"]:visible').first().click();
    await expect(pT.locator('[data-testid="portal-time-state"]:visible').first())
      .toHaveAttribute("data-clock-state", "WORKING", { timeout: 10_000 });
    await pT.locator('[data-testid="portal-time-clock-out"]:visible').first().click();
    await expect(pT.locator('[data-testid="portal-time-state"]:visible').first())
      .toHaveAttribute("data-clock-state", "OFF_CLOCK", { timeout: 10_000 });
    await ctxT.close();

    // ---- Grounds manager: Banquets session must NOT appear ----
    const ctxG = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const pG = await ctxG.newPage();
    await adminSignIn(pG, GROUNDS_MGR);
    await pG.goto(`/app/admin/payroll/time?payPeriodId=${payPeriodId}&departmentId=${groundsDepartmentId}&scope=timesheet`);
    await expect(pG.locator('[data-testid="timesheet-approval-workspace"]').first()).toBeVisible({ timeout: 30_000 });
    // Grounds scope has no reviewable time — employee list empty.
    await expect(pG.locator('[data-testid^="scope-employee-row:"]')).toHaveCount(0, { timeout: 10_000 });
    await pG.screenshot({ path: path.join(OUT, "02-grounds-manager-no-taylor.png"), fullPage: true });
    await ctxG.close();

    // ---- Banquets manager: sees Taylor and can approve ----
    const ctxB = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const pB = await ctxB.newPage();
    await adminSignIn(pB, BANQUETS_MGR);
    await pB.goto(`/app/admin/payroll/time?payPeriodId=${payPeriodId}&departmentId=${banquetsDepartmentId}&scope=timesheet`);
    await expect(pB.locator('[data-testid="timesheet-approval-workspace"]').first()).toBeVisible({ timeout: 30_000 });
    await expect(pB.locator('[data-testid^="scope-employee-row:"]').first()).toBeVisible({ timeout: 15_000 });
    await pB.screenshot({ path: path.join(OUT, "03-banquets-manager-sees-taylor.png"), fullPage: true });
    await expect(pB.locator('[data-testid="scope-status-ready"]').first()).toBeVisible();
    await pB.locator('[data-testid="approve-scope-btn"]').first().click();
    await expect(pB.locator('[data-testid="scope-status-approved"]').first()).toBeVisible({ timeout: 20_000 });
    await pB.screenshot({ path: path.join(OUT, "04-banquets-manager-approved.png"), fullPage: true });
    await ctxB.close();
  });
});

// ==================================================================
// Config-gap remediation (§19)
// ==================================================================
test.describe.serial("Payroll-3D-3A · config-gap remediation @1440x900", () => {
  test("§19 Tenant Admin lands on remediation UI and assigns approver; gap card resolves", async ({ browser }) => {
    resetAll();

    // Delete the Grounds DepartmentResponsibility to simulate an unconfigured gap.
    // We do this via a one-shot script so the test doesn't depend on Prisma from the runner.
    const { PrismaClient } = await import("@prisma/client");
    const prisma = new PrismaClient();
    try {
      const club = await prisma.club.findFirstOrThrow({ where: { slug: "coulee-ridge" } });
      const grounds = await prisma.department.findFirstOrThrow({ where: { clubId: club.id, code: "GROUNDS" } });
      await prisma.departmentResponsibility.deleteMany({
        where: { clubId: club.id, departmentId: grounds.id, responsibilityKey: "DEPARTMENT_TIME_APPROVAL" },
      });
      // Seed a clean session for Taylor in Grounds so the scope has reviewable time.
      const taylor = await prisma.employee.findFirstOrThrow({ where: { clubId: club.id, email: TAYLOR } });
      const primary = await prisma.employeeEmploymentAssignment.findFirstOrThrow({
        where: { clubId: club.id, employeeId: taylor.id, role: "PRIMARY", effectiveTo: null },
      });
      await prisma.timeClockEvent.deleteMany({ where: { clubId: club.id, employeeId: taylor.id } });
      const now = new Date();
      const earlier = new Date(now.getTime() - 2 * 60 * 60 * 1000);
      await prisma.timeClockEvent.create({
        data: {
          clubId: club.id, employeeId: taylor.id, kind: "CLOCK_IN",
          occurredAt: earlier, source: "EMPLOYEE_PORTAL",
          employmentAssignmentId: primary.id,
        },
      });
      await prisma.timeClockEvent.create({
        data: {
          clubId: club.id, employeeId: taylor.id, kind: "CLOCK_OUT",
          occurredAt: now, source: "EMPLOYEE_PORTAL",
          employmentAssignmentId: primary.id,
        },
      });
    } finally {
      await prisma.$disconnect();
    }

    // Sign in as Tenant Admin (Alex Preview) and land on the remediation surface.
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const p = await ctx.newPage();
    await adminSignIn(p, ALEX_TA);
    await p.goto("/app/admin/settings/time-approvers");
    await expect(p.locator('[data-testid="time-approvers-workspace"]').first()).toBeVisible({ timeout: 30_000 });
    await p.screenshot({ path: path.join(OUT, "05-remediation-ui.png"), fullPage: true });

    // Grounds row should exist. Click the "Assign" / "Change" button.
    const groundsRow = p.locator('[data-testid="time-approver-row:GROUNDS"]').first();
    await expect(groundsRow).toBeVisible();
    await groundsRow.locator('[data-testid="time-approver-edit:GROUNDS"]').first().click();

    // Pick Grounds Manager from the dropdown.
    const picker = groundsRow.locator('[data-testid="time-approver-user-picker:GROUNDS"]').first();
    await expect(picker).toBeVisible({ timeout: 10_000 });
    // The Grounds manager user's display name in the fixture is "Sam Grounds".
    const mgrOpt = picker.locator('option', { hasText: "Sam Grounds" }).first();
    const mgrVal = await mgrOpt.getAttribute("value");
    await picker.selectOption(mgrVal!);

    // Save.
    await groundsRow.locator('[data-testid="time-approver-save:GROUNDS"]').first().click();
    await expect(p.locator('[data-testid="time-approvers-success"]').first()).toBeVisible({ timeout: 15_000 });
    await p.screenshot({ path: path.join(OUT, "06-remediation-saved.png"), fullPage: true });
    await ctx.close();

    // Verify persisted state directly.
    const { PrismaClient: P2 } = await import("@prisma/client");
    const p2 = new P2();
    try {
      const club = await p2.club.findFirstOrThrow({ where: { slug: "coulee-ridge" } });
      const grounds = await p2.department.findFirstOrThrow({ where: { clubId: club.id, code: "GROUNDS" } });
      const row = await p2.departmentResponsibility.findFirstOrThrow({
        where: { clubId: club.id, departmentId: grounds.id, responsibilityKey: "DEPARTMENT_TIME_APPROVAL" },
        include: { user: true },
      });
      expect(row.user.email).toBe(GROUNDS_MGR);
    } finally {
      await p2.$disconnect();
    }
  });
});
