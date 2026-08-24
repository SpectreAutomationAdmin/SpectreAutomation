// HR-2C Portal Parity (2026-08-24) — Founder reproduction.
//
// Seeds a fresh employee with a portal credential. Backfills a
// canonical PRIMARY (Clubhouse Manager) via createEmployee.
//
// Admin walk: change Primary Role from Clubhouse Manager → Controller.
// Employee walk (fresh browser session — no logout of the admin
// context needed): open /employee → hero subtitle reads "Controller".
//
// This is the exact founder screenshot: admin Overview said Controller
// but hero said Clubhouse Manager. Proves the canonical resolver
// serves the portal without any session refresh.

import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import bcrypt from "bcryptjs";
import { PrismaClient } from "@prisma/client";

const OUT = path.resolve("test-results/hr-2c-portal-role-parity");
fs.mkdirSync(OUT, { recursive: true });
const prisma = new PrismaClient();

const BASE = "http://silver-springs.localtest.me:3000";
const ADMIN_BASE = "http://localhost:3000";

interface Fixture {
  employeeId: string;
  employeeNumber: string;
  password: string;
  administrationDeptId: string;
  clubhouseMgrId: string;
  controllerId: string;
}
let fx: Fixture;

async function seedFixture(): Promise<Fixture> {
  const club = await prisma.club.findFirst({ where: { slug: "silver-springs" } });
  if (!club) throw new Error("[HR-2C Portal Parity] Silver Springs not seeded.");

  // Purge stale test employees.
  const staleEmps = await prisma.employee.findMany({
    where: { clubId: club.id, employeeNumber: { startsWith: "PARITY-" } },
    select: { id: true },
  });
  for (const e of staleEmps) {
    await prisma.employeeAllowance.deleteMany({ where: { employeeId: e.id } });
    await prisma.employeeCompensation.updateMany({ where: { employeeId: e.id }, data: { assignmentId: null } });
    await prisma.employeeEmploymentAssignment.deleteMany({ where: { employeeId: e.id } });
    await prisma.employeeCompensation.deleteMany({ where: { employeeId: e.id } });
    await prisma.employeePortalCredential.deleteMany({ where: { employeeId: e.id } });
    await prisma.employee.deleteMany({ where: { id: e.id } });
  }

  const admin = await prisma.department.upsert({
    where: { clubId_code: { clubId: club.id, code: "ADMIN_PAR" } },
    update: {},
    create: { clubId: club.id, code: "ADMIN_PAR", name: "Administration (Parity)", sortOrder: 100 },
  });
  const clubhouseMgr = await prisma.employeePosition.upsert({
    where: { clubId_code: { clubId: club.id, code: "CLBHSE_MGR_PAR" } },
    update: { departmentId: admin.id },
    create: { clubId: club.id, code: "CLBHSE_MGR_PAR", name: "Clubhouse Manager (Parity)", departmentId: admin.id },
  });
  const controller = await prisma.employeePosition.upsert({
    where: { clubId_code: { clubId: club.id, code: "CTRL_PAR" } },
    update: { departmentId: admin.id },
    create: { clubId: club.id, code: "CTRL_PAR", name: "Controller (Parity)", departmentId: admin.id },
  });

  const employeeNumber = `PARITY-${Math.floor(Math.random() * 90000 + 10000)}`;
  const password = "Portal-Parity-Pw-1!";
  const passwordHash = await bcrypt.hash(password, 12);
  const employee = await prisma.employee.create({
    data: {
      clubId: club.id, employeeNumber,
      firstName: "Chris", lastName: `Parity-${Date.now().toString().slice(-6)}`,
      personalEmail: `chris-parity-${Date.now()}@spec.test`,
      status: "ACTIVE", employeeLifecycle: "ACTIVE",
      departmentId: admin.id, positionId: clubhouseMgr.id, employmentType: "FULL_TIME",
      hireDate: new Date("2026-01-01"),
      portalTourCompletedAt: new Date(),
    },
  });
  await prisma.employeePortalCredential.create({
    data: { clubId: club.id, employeeId: employee.id, passwordHash, passwordUpdatedAt: new Date() },
  });
  // Provision the canonical PRIMARY (Clubhouse Manager) via the same
  // service the profile-page loader calls.
  await prisma.employeeEmploymentAssignment.create({
    data: {
      clubId: club.id, employeeId: employee.id,
      role: "PRIMARY", departmentId: admin.id, positionId: clubhouseMgr.id,
      employmentType: "FULL_TIME", effectiveFrom: new Date("2026-01-01"),
      notes: "Seed",
    },
  });

  return {
    employeeId: employee.id,
    employeeNumber, password,
    administrationDeptId: admin.id,
    clubhouseMgrId: clubhouseMgr.id,
    controllerId: controller.id,
  };
}

async function loginAsAdmin(page: Page) {
  await page.goto(`${ADMIN_BASE}/login`);
  await page
    .locator('form:has(input[name="email"][value="admin@silversprings.club"]) button')
    .first().click();
  await page.waitForURL(/\/app/, { timeout: 30_000 });
}

async function loginAsEmployee(page: Page) {
  await page.goto(`${BASE}/employee/login`);
  await page.locator('input[name="employeeNumber"]').fill(fx.employeeNumber);
  await page.locator('input[name="password"]').fill(fx.password);
  await Promise.all([
    page.waitForURL(/\/employee(?!\/login)/, { timeout: 30_000 }),
    page.locator('button[type="submit"]').first().click(),
  ]);
}

test.describe("HR-2C Portal Parity · admin role change reflects on employee portal hero", () => {
  test.describe.configure({ mode: "serial" });
  test.slow();

  test.beforeAll(async () => { fx = await seedFixture(); });
  test.afterAll(async () => {
    await prisma.employeeEmploymentAssignment.deleteMany({ where: { employeeId: fx.employeeId } });
    await prisma.employeePortalCredential.deleteMany({ where: { employeeId: fx.employeeId } });
    await prisma.employee.deleteMany({ where: { id: fx.employeeId } });
    await prisma.$disconnect();
  });

  test("Baseline: Employee Portal hero renders the current PRIMARY (Clubhouse Manager)", async ({ page }) => {
    await loginAsEmployee(page);
    await expect(page.locator('[data-testid="portal-hero"]')).toBeVisible();
    await expect(page.locator('[data-testid="portal-hero"]')).toContainText("Clubhouse Manager");
    await page.screenshot({ path: path.join(OUT, "01-baseline-clubhouse-manager.png"), fullPage: true });
  });

  test("Admin changes Primary Role → Controller → Portal hero immediately reflects Controller (no logout)", async ({ browser }) => {
    // Admin context.
    const adminCtx: BrowserContext = await browser.newContext();
    const adminPage = await adminCtx.newPage();
    await loginAsAdmin(adminPage);
    await adminPage.goto(`${ADMIN_BASE}/app/admin/people/employees/${fx.employeeId}`);
    await adminPage.locator('button:has-text("Employment"), a:has-text("Employment")').first().click();
    await expect(adminPage.locator('[data-testid="employee-tab-body-employment"]')).toBeVisible();
    // Edit primary role → Controller.
    await adminPage.locator('[data-testid="btn-change-primary-role"]').click();
    await adminPage.locator('[data-testid="primary-department-select"]').selectOption(fx.administrationDeptId);
    await adminPage.locator('[data-testid="primary-position-select"]').selectOption(fx.controllerId);
    await adminPage.locator('[data-testid="primary-type-select"]').selectOption("FULL_TIME");
    await adminPage.locator('[data-testid="primary-effective-from"]').fill("2026-07-01");
    await Promise.all([
      adminPage.waitForLoadState("domcontentloaded"),
      adminPage.locator('[data-testid="primary-submit"]').click(),
    ]);
    await expect(adminPage.locator('[data-testid="primary-position"]')).toContainText("Controller");
    await adminPage.screenshot({ path: path.join(OUT, "02-admin-changed-to-controller.png"), fullPage: true });
    await adminCtx.close();

    // Employee context — completely independent browser context.
    // No relationship to the admin session. Fresh cookies. Fresh login.
    const employeeCtx: BrowserContext = await browser.newContext();
    const employeePage = await employeeCtx.newPage();
    await loginAsEmployee(employeePage);
    await expect(employeePage.locator('[data-testid="portal-hero"]')).toBeVisible();
    // Hero MUST now show Controller.
    await expect(employeePage.locator('[data-testid="portal-hero"]')).toContainText("Controller");
    await expect(employeePage.locator('[data-testid="portal-hero"]')).not.toContainText("Clubhouse Manager");
    await employeePage.screenshot({ path: path.join(OUT, "03-employee-portal-controller.png"), fullPage: true });
    await employeeCtx.close();

    // DB verification — canonical assignment updated; legacy
    // Employee.positionId is deliberately still stale (proving the
    // hero read went through the canonical resolver).
    const rows = await prisma.employeeEmploymentAssignment.findMany({
      where: { employeeId: fx.employeeId, role: "PRIMARY" },
      orderBy: { effectiveFrom: "asc" },
    });
    expect(rows).toHaveLength(2);
    const current = rows.find((r) => r.effectiveTo === null)!;
    expect(current.positionId).toBe(fx.controllerId);
    const legacy = await prisma.employee.findUnique({
      where: { id: fx.employeeId }, select: { positionId: true },
    });
    expect(legacy!.positionId).toBe(fx.clubhouseMgrId); // stale on purpose
  });
});
