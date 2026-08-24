// HR-2C Employment Corrections (2026-08-24) — Founder acceptance walk.
//
// Reproduces the founder's fixture (a "legacy" employee whose
// Overview shows Position/Department but Employment previously
// reported "No primary role assigned yet"), then walks the corrected
// experience:
//   1. Open Profile → Employment → PRIMARY ROLE already shows the
//      canonical role (backfilled on read).
//   2. Edit role → in-place Add Position under a new Department →
//      auto-selected in the picker → Save.
//   3. Change compensation → Salary → new amount → effective date →
//      Compensation History shows old + new records.
//   4. + Add another role → new Department + inline Add Position →
//      Hourly rate → Save → both roles display.

import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";

const OUT = path.resolve("test-results/hr-2c-employment-corrections");
fs.mkdirSync(OUT, { recursive: true });
const prisma = new PrismaClient();

interface Fixture {
  employeeId: string;
  administrationDeptId: string;
  clubhouseMgrId: string;
  fbDeptId: string;
  hospitalityDeptId: string;
}
let fx: Fixture;

async function seedFixture(): Promise<Fixture> {
  const club = await prisma.club.findFirst({ where: { slug: "silver-springs" } });
  if (!club) throw new Error("[HR-2C Corr] Silver Springs not seeded — run `npm run db:seed`.");

  // Purge stale test-only employees + fixture depts/positions.
  const staleEmps = await prisma.employee.findMany({
    where: { clubId: club.id, employeeNumber: { startsWith: "CORR-" } },
    select: { id: true },
  });
  for (const e of staleEmps) {
    await prisma.employeeAllowance.deleteMany({ where: { employeeId: e.id } });
    await prisma.employeeCompensation.updateMany({ where: { employeeId: e.id }, data: { assignmentId: null } });
    await prisma.employeeEmploymentAssignment.deleteMany({ where: { employeeId: e.id } });
    await prisma.employeeCompensation.deleteMany({ where: { employeeId: e.id } });
    await prisma.employee.deleteMany({ where: { id: e.id } });
  }

  const admin = await prisma.department.upsert({
    where: { clubId_code: { clubId: club.id, code: "ADMIN_CORR" } },
    update: {}, create: { clubId: club.id, code: "ADMIN_CORR", name: "Administration (Corr)", sortOrder: 100 },
  });
  const fb = await prisma.department.upsert({
    where: { clubId_code: { clubId: club.id, code: "FB_CORR" } },
    update: {}, create: { clubId: club.id, code: "FB_CORR", name: "Food & Beverage (Corr)", sortOrder: 101 },
  });
  const hospitality = await prisma.department.upsert({
    where: { clubId_code: { clubId: club.id, code: "HOSP_CORR" } },
    update: {}, create: { clubId: club.id, code: "HOSP_CORR", name: "Hospitality (Corr)", sortOrder: 102 },
  });
  const clubhouseMgr = await prisma.employeePosition.upsert({
    where: { clubId_code: { clubId: club.id, code: "CLBHSE_MGR_CORR" } },
    update: { departmentId: admin.id },
    create: { clubId: club.id, code: "CLBHSE_MGR_CORR", name: "Clubhouse Manager (Corr)", departmentId: admin.id },
  });

  // Legacy employee: populated dept + position + type, ZERO assignments.
  const employee = await prisma.employee.create({
    data: {
      clubId: club.id,
      employeeNumber: `CORR-${Math.floor(Math.random() * 90000 + 10000)}`,
      firstName: "Chris",
      lastName: `Legacy-${Date.now().toString().slice(-6)}`,
      personalEmail: `chris-legacy-${Date.now()}@spec.test`,
      status: "ACTIVE",
      employeeLifecycle: "ACTIVE",
      departmentId: admin.id,
      positionId: clubhouseMgr.id,
      employmentType: "FULL_TIME",
      hireDate: new Date("2026-01-15"),
    },
  });
  return {
    employeeId: employee.id,
    administrationDeptId: admin.id,
    clubhouseMgrId: clubhouseMgr.id,
    fbDeptId: fb.id,
    hospitalityDeptId: hospitality.id,
  };
}

async function loginAsAdmin(page: Page): Promise<void> {
  await page.goto("http://localhost:3000/login");
  await page
    .locator('form:has(input[name="email"][value="admin@silversprings.club"]) button')
    .first().click();
  await page.waitForURL(/\/app/, { timeout: 30_000 });
}

test.describe("HR-2C Employment Corrections · founder walk", () => {
  test.describe.configure({ mode: "serial" });
  test.slow();

  test.beforeAll(async () => { fx = await seedFixture(); });
  test.afterAll(async () => {
    await prisma.employeeAllowance.deleteMany({ where: { employeeId: fx.employeeId } });
    await prisma.employeeCompensation.updateMany({ where: { employeeId: fx.employeeId }, data: { assignmentId: null } });
    await prisma.employeeEmploymentAssignment.deleteMany({ where: { employeeId: fx.employeeId } });
    await prisma.employeeCompensation.deleteMany({ where: { employeeId: fx.employeeId } });
    await prisma.employee.deleteMany({ where: { id: fx.employeeId } });
    await prisma.$disconnect();
  });

  test("Legacy employee opens with canonical PRIMARY populated (backfill on read)", async ({ page }) => {
    // Confirm the seed state — no assignments before the page opens.
    const beforeRows = await prisma.employeeEmploymentAssignment.findMany({ where: { employeeId: fx.employeeId } });
    expect(beforeRows).toHaveLength(0);

    await loginAsAdmin(page);
    await page.goto(`http://localhost:3000/app/admin/people/employees/${fx.employeeId}`);
    // Click Employment tab.
    await page.locator('button:has-text("Employment"), a:has-text("Employment")').first().click();
    await expect(page.locator('[data-testid="employee-tab-body-employment"]')).toBeVisible();

    // Primary role is populated — NOT "No primary role assigned yet".
    await expect(page.locator('[data-testid="employment-primary-empty"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="primary-position"]')).toContainText("Clubhouse Manager");
    await expect(page.locator('[data-testid="primary-department"]')).toContainText("Administration");

    await page.screenshot({ path: path.join(OUT, "01-primary-populated-from-backfill.png"), fullPage: true });

    // Backfill row now exists in the DB.
    const afterRows = await prisma.employeeEmploymentAssignment.findMany({ where: { employeeId: fx.employeeId } });
    expect(afterRows).toHaveLength(1);
    expect(afterRows[0]!.role).toBe("PRIMARY");
    expect(afterRows[0]!.departmentId).toBe(fx.administrationDeptId);
    expect(afterRows[0]!.positionId).toBe(fx.clubhouseMgrId);
  });

  test("Change compensation Salary $125,000 → Hourly $32 saves + Compensation History shows both", async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto(`http://localhost:3000/app/admin/people/employees/${fx.employeeId}`);
    await page.locator('button:has-text("Employment"), a:has-text("Employment")').first().click();

    // Seed baseline compensation ($125,000 salary).
    await page.locator('[data-testid="btn-change-compensation"]').click();
    await page.locator('[data-testid="comp-cadence-select"]').selectOption("SALARY");
    await page.locator('[data-testid="comp-amount"]').fill("125000");
    await page.locator('[data-testid="comp-effective-from"]').fill("2026-01-15");
    await Promise.all([
      page.waitForLoadState("domcontentloaded"),
      page.locator('[data-testid="comp-submit"]').click(),
    ]);
    await expect(page.locator('[data-testid="primary-compensation"]')).toContainText(/125,000|125000/);

    // Change to Hourly $32 effective 2027-01-01.
    await page.locator('[data-testid="btn-change-compensation"]').click();
    await page.locator('[data-testid="comp-cadence-select"]').selectOption("HOURLY");
    await page.locator('[data-testid="comp-amount"]').fill("32.00");
    await page.locator('[data-testid="comp-effective-from"]').fill("2027-01-01");
    await Promise.all([
      page.waitForLoadState("domcontentloaded"),
      page.locator('[data-testid="comp-submit"]').click(),
    ]);
    // Compensation History shows two rows.
    await expect(page.locator('[data-testid^="comp-history-"]')).toHaveCount(2);
    await page.screenshot({ path: path.join(OUT, "02-compensation-history.png"), fullPage: true });

    // DB assertion.
    const rows = await prisma.employeeCompensation.findMany({
      where: { employeeId: fx.employeeId, assignmentId: null },
      orderBy: { effectiveFrom: "asc" },
    });
    expect(rows).toHaveLength(2);
    expect(rows[0]!.cadence).toBe("SALARY");
    expect(rows[0]!.rate.toString()).toBe("125000");
    expect(rows[0]!.effectiveTo).not.toBeNull();
    expect(rows[1]!.cadence).toBe("HOURLY");
    expect(rows[1]!.rate.toString()).toBe("32");
    expect(rows[1]!.effectiveTo).toBeNull();
  });

  test("Add additional role with inline + Add Position → new Position auto-selected → save", async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto(`http://localhost:3000/app/admin/people/employees/${fx.employeeId}`);
    await page.locator('button:has-text("Employment"), a:has-text("Employment")').first().click();

    // Open the additional-role form.
    await page.locator('[data-testid="btn-add-additional-role"]').click();
    // Choose F&B department.
    await page.locator('[data-testid="additional-department-select"]').selectOption(fx.fbDeptId);
    // The desired Position doesn't exist yet → + Add position.
    const uniquePositionName = `Banquet Supervisor Corr ${Date.now().toString().slice(-6)}`;
    await page.locator('[data-testid="additional-position-select-add"]').click();
    await page.locator('[data-testid="additional-position-select-add-name"]').fill(uniquePositionName);
    await Promise.all([
      page.waitForLoadState("domcontentloaded"),
      page.locator('[data-testid="additional-position-select-add-submit"]').click(),
    ]);
    // Wait for the new option to appear in the dropdown (React
    // batches state updates from the child picker — the option
    // list refresh + auto-select land in the next render).
    await expect
      .poll(async () =>
        page.locator('[data-testid="additional-position-select"]').inputValue(),
        { timeout: 5_000 })
      .not.toBe("");

    // Employment type + effective date + save.
    await page.locator('[data-testid="additional-type-select"]').selectOption("PART_TIME");
    await page.locator('[data-testid="additional-effective-from"]').fill("2027-02-01");
    await Promise.all([
      page.waitForLoadState("domcontentloaded"),
      page.locator('[data-testid="additional-submit"]').click(),
    ]);

    // Additional role rendered with the new position + department.
    await expect(page.locator('[data-testid="employment-additional-section"]')).toContainText(uniquePositionName);
    await expect(page.locator('[data-testid="employment-additional-section"]')).toContainText("Food & Beverage");
    await page.screenshot({ path: path.join(OUT, "03-additional-role-added-inline-position.png"), fullPage: true });

    // DB assertions — new EmployeePosition + new additional assignment.
    const newPos = await prisma.employeePosition.findFirst({ where: { name: uniquePositionName } });
    expect(newPos).not.toBeNull();
    expect(newPos!.departmentId).toBe(fx.fbDeptId);
    const asg = await prisma.employeeEmploymentAssignment.findFirst({
      where: { employeeId: fx.employeeId, role: "ADDITIONAL", positionId: newPos!.id },
    });
    expect(asg).not.toBeNull();
  });
});
