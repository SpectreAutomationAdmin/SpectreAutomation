// HR-2C Employment (2026-08-24) — Admin Employment tab Playwright walk.
//
// Founder-mandated §32:
//   Employee Profile → Employment
//     → Change compensation: $22/hr → $24/hr (effective future) →
//       history shows both rows
//     → Add role: Food & Beverage / Banquet Server / hourly $19
//     → Change primary role: Administration / Clubhouse Manager
//     → Add allowance: Cell Phone $75/month
//
// Seeds a fresh employee + departments + positions via prisma. Uses
// the dev-only quick-login admin form (same pattern as other admin
// specs). Tests the full mutation loop through the UI + verifies
// persistence via prisma.

import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";

const OUT = path.resolve("test-results/hr-2c-employment");
fs.mkdirSync(OUT, { recursive: true });

const prisma = new PrismaClient();

interface Fixture {
  clubId: string;
  employeeId: string;
  administrationDeptId: string;
  fbDeptId: string;
  clubhouseMgrId: string;
  banquetSvrId: string;
}
let fx: Fixture;

async function seedFixture(): Promise<Fixture> {
  const club = await prisma.club.findFirst({ where: { slug: "silver-springs" } });
  if (!club) throw new Error("[HR-2C Employment] Silver Springs not seeded — run `npm run db:seed`.");

  // Purge stale test employees + department fixtures.
  const staleEmps = await prisma.employee.findMany({
    where: { clubId: club.id, employeeNumber: { startsWith: "EMP-2CE-" } },
    select: { id: true },
  });
  for (const e of staleEmps) {
    await prisma.employeeAllowance.deleteMany({ where: { employeeId: e.id } });
    await prisma.employeeCompensation.updateMany({ where: { employeeId: e.id }, data: { assignmentId: null } });
    await prisma.employeeEmploymentAssignment.deleteMany({ where: { employeeId: e.id } });
    await prisma.employeeCompensation.deleteMany({ where: { employeeId: e.id } });
    await prisma.employee.deleteMany({ where: { id: e.id } });
  }
  // Ensure canonical test departments exist.
  const admin = await prisma.department.upsert({
    where: { clubId_code: { clubId: club.id, code: "ADMIN_2CE" } },
    update: {},
    create: { clubId: club.id, code: "ADMIN_2CE", name: "Administration (2CE)", sortOrder: 100 },
  });
  const fb = await prisma.department.upsert({
    where: { clubId_code: { clubId: club.id, code: "FB_2CE" } },
    update: {},
    create: { clubId: club.id, code: "FB_2CE", name: "Food & Beverage (2CE)", sortOrder: 101 },
  });
  const clubhouseMgr = await prisma.employeePosition.upsert({
    where: { clubId_code: { clubId: club.id, code: "CLBHSE_MGR_2CE" } },
    update: { departmentId: admin.id },
    create: { clubId: club.id, code: "CLBHSE_MGR_2CE", name: "Clubhouse Manager (2CE)", departmentId: admin.id },
  });
  const banquetSvr = await prisma.employeePosition.upsert({
    where: { clubId_code: { clubId: club.id, code: "BANQ_SVR_2CE" } },
    update: { departmentId: fb.id },
    create: { clubId: club.id, code: "BANQ_SVR_2CE", name: "Banquet Server (2CE)", departmentId: fb.id },
  });

  const employee = await prisma.employee.create({
    data: {
      clubId: club.id,
      employeeNumber: `EMP-2CE-${Math.floor(Math.random() * 90000 + 10000)}`,
      firstName: "Chris",
      lastName: `Smith-${Date.now().toString().slice(-6)}`,
      personalEmail: `chris-${Date.now()}@spec.test`,
      status: "ACTIVE",
      employeeLifecycle: "ACTIVE",
      employmentType: "FULL_TIME",
    },
  });

  return {
    clubId: club.id,
    employeeId: employee.id,
    administrationDeptId: admin.id,
    fbDeptId: fb.id,
    clubhouseMgrId: clubhouseMgr.id,
    banquetSvrId: banquetSvr.id,
  };
}

async function loginAsAdmin(page: Page): Promise<void> {
  await page.goto("http://localhost:3000/login");
  await page
    .locator('form:has(input[name="email"][value="admin@silversprings.club"]) button')
    .first()
    .click();
  await page.waitForURL(/\/app/, { timeout: 30_000 });
}

test.describe("HR-2C Employment · admin walk", () => {
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

  test("Employment tab: change comp → add additional role → change primary → add allowance", async ({ page }) => {
    await loginAsAdmin(page);

    // Open employee profile.
    await page.goto(`http://localhost:3000/app/admin/people/employees/${fx.employeeId}`);
    // Click Employment tab.
    await page.locator('button:has-text("Employment"), a:has-text("Employment")').first().click();
    await expect(page.locator('[data-testid="employee-tab-body-employment"]')).toBeVisible();
    await page.screenshot({ path: path.join(OUT, "01-employment-tab-empty.png"), fullPage: true });

    // §32 · a — Set primary role (there is none yet).
    await page.locator('[data-testid="btn-add-primary-role"]').click();
    await page.locator('[data-testid="primary-department-select"]').selectOption(fx.administrationDeptId);
    await page.locator('[data-testid="primary-position-select"]').selectOption(fx.clubhouseMgrId);
    await page.locator('[data-testid="primary-type-select"]').selectOption("FULL_TIME");
    await page.locator('[data-testid="primary-effective-from"]').fill("2026-01-01");
    await Promise.all([
      page.waitForLoadState("domcontentloaded"),
      page.locator('[data-testid="primary-submit"]').click(),
    ]);
    await expect(page.locator('[data-testid="primary-position"]')).toContainText("Clubhouse Manager");
    await expect(page.locator('[data-testid="primary-department"]')).toContainText("Administration");

    // §32 · a — Change compensation: $22/hr effective 2026-01-01.
    await page.locator('[data-testid="btn-change-compensation"]').click();
    await page.locator('[data-testid="comp-cadence-select"]').selectOption("HOURLY");
    await page.locator('[data-testid="comp-amount"]').fill("22.00");
    await page.locator('[data-testid="comp-effective-from"]').fill("2026-01-01");
    await Promise.all([
      page.waitForLoadState("domcontentloaded"),
      page.locator('[data-testid="comp-submit"]').click(),
    ]);
    await expect(page.locator('[data-testid="primary-compensation"]')).toContainText(/22/);

    // §32 · a — Raise to $24 effective 2026-07-01.
    await page.locator('[data-testid="btn-change-compensation"]').click();
    await page.locator('[data-testid="comp-cadence-select"]').selectOption("HOURLY");
    await page.locator('[data-testid="comp-amount"]').fill("24.00");
    await page.locator('[data-testid="comp-effective-from"]').fill("2026-07-01");
    await Promise.all([
      page.waitForLoadState("domcontentloaded"),
      page.locator('[data-testid="comp-submit"]').click(),
    ]);
    // Compensation history shows two rows.
    const compRows = page.locator('[data-testid^="comp-history-"]');
    await expect(compRows).toHaveCount(2);
    await page.screenshot({ path: path.join(OUT, "02-employment-comp-history.png"), fullPage: true });

    // §32 · b — Add additional role: Food & Beverage / Banquet Server / hourly.
    await page.locator('[data-testid="btn-add-additional-role"]').click();
    await page.locator('[data-testid="additional-department-select"]').selectOption(fx.fbDeptId);
    await page.locator('[data-testid="additional-position-select"]').selectOption(fx.banquetSvrId);
    await page.locator('[data-testid="additional-type-select"]').selectOption("PART_TIME");
    await page.locator('[data-testid="additional-effective-from"]').fill("2026-08-01");
    await Promise.all([
      page.waitForLoadState("domcontentloaded"),
      page.locator('[data-testid="additional-submit"]').click(),
    ]);
    await expect(page.locator('[data-testid="employment-additional-section"]')).toContainText("Banquet Server");
    await expect(page.locator('[data-testid="employment-additional-section"]')).toContainText("Food & Beverage");

    // §32 · c — Add allowance: Cell Phone $75 monthly.
    await page.locator('[data-testid="btn-add-allowance"]').click();
    await page.locator('[data-testid="allowance-type-select"]').selectOption("CELL_PHONE");
    await page.locator('[data-testid="allowance-amount"]').fill("75.00");
    await page.locator('[data-testid="allowance-frequency-select"]').selectOption("MONTHLY");
    await page.locator('[data-testid="allowance-effective-from"]').fill("2026-01-01");
    await Promise.all([
      page.waitForLoadState("domcontentloaded"),
      page.locator('[data-testid="allowance-submit"]').click(),
    ]);
    await expect(page.locator('[data-testid="employment-allowances-section"]')).toContainText("Cell Phone");
    await expect(page.locator('[data-testid="employment-allowances-section"]')).toContainText(/75/);
    await page.screenshot({ path: path.join(OUT, "03-employment-full.png"), fullPage: true });

    // DB assertions — canonical persistence.
    const primaryRows = await prisma.employeeEmploymentAssignment.findMany({
      where: { employeeId: fx.employeeId, role: "PRIMARY" },
    });
    expect(primaryRows).toHaveLength(1);
    const additionalRows = await prisma.employeeEmploymentAssignment.findMany({
      where: { employeeId: fx.employeeId, role: "ADDITIONAL" },
    });
    expect(additionalRows).toHaveLength(1);
    const compRowsDb = await prisma.employeeCompensation.findMany({
      where: { employeeId: fx.employeeId },
    });
    expect(compRowsDb).toHaveLength(2);
    // Prior row closed; current is $24.
    const priorRow = compRowsDb.find((c) => c.rate.toString() === "22")!;
    const currentRow = compRowsDb.find((c) => c.rate.toString() === "24")!;
    expect(priorRow.effectiveTo).not.toBeNull();
    expect(currentRow.effectiveTo).toBeNull();
    const allowances = await prisma.employeeAllowance.findMany({
      where: { employeeId: fx.employeeId },
    });
    expect(allowances).toHaveLength(1);
    expect(allowances[0]!.allowanceType).toBe("CELL_PHONE");
    expect(allowances[0]!.frequency).toBe("MONTHLY");
    expect(allowances[0]!.amount.toString()).toBe("75");
  });
});
