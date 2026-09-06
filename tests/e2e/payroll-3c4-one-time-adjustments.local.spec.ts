// Payroll-3C-4A (2026-09-09) — local Playwright acceptance for
// pre-calculation review + one-time adjustments on the REAL fixture.
//
// Sam Complex arrives with SEVEN recurring components already
// (Cell Phone Allowance $37.50, employer benefits, RRSP EE/ER, LTD).
// This spec proves that one-time adjustments COEXIST with those
// recurring rows and that the founder-scenario cash gross =
// $5,193.23 (regular $4,583.33 + Cell Phone $37.50 + Bonus $500 +
// Reimb $72.40; the $50 Deduction lands on the net-pay side).
//
// Preconditions:
//   • dev server on http://localhost:3000
//   • `npm run fixture:payroll-founder-preview`   has been run
//   • `npm run fixture:payroll-3c1-components`    has been run

import { test, expect, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const OUT = path.resolve("test-results/payroll-3c4a");
fs.mkdirSync(OUT, { recursive: true });

const RAELENE_EMAIL = "raelene.sample@preview.spectre.test";
const CHRIS_EMAIL   = "chris.fixture@preview.spectre.test";
const PASSWORD      = "TA1C-Preview-99";

const prisma = new PrismaClient();

async function signIn(page: Page, email: string) {
  await page.goto("/login");
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill(PASSWORD);
  await Promise.all([
    page.waitForURL(/\/app(?!\/.*login).*/, { timeout: 30_000 }),
    page.getByRole("button", { name: /^Sign in$/ }).click(),
  ]);
}

function runFixture(label: string, args: string[]) {
  try {
    execFileSync("npm", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], shell: true });
  } catch (err) {
    throw new Error(`${label} failed: ${(err as Error).message}`);
  }
}

async function samGross(samBEId: string): Promise<number> {
  const be = await prisma.payrollBatchEmployee.findUniqueOrThrow({ where: { id: samBEId } });
  return Number(be.grossPay ?? 0);
}

test.describe.serial("Payroll-3C-4A · one-time adjustments (Sam Complex)", () => {
  let batchId = "";
  let samBatchEmployeeId = "";

  test.beforeAll(async () => {
    runFixture("founder preview reset",   ["run", "fixture:payroll-founder-preview:reset"]);
    runFixture("founder preview reseed",  ["run", "fixture:payroll-founder-preview"]);
    runFixture("3C-1 complex components", ["run", "fixture:payroll-3c1-components"]);

    // Prepare the Sam Complex batch via a tiny script so we don't
    // pull the internal payroll modules through Playwright's ts loader
    // (which does not run in ESM mode for arbitrary `.ts` imports).
    const raw = execFileSync("npx", ["tsx", "scripts/payroll-3c4a-prepare-sam-batch.ts"], {
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], shell: true,
    });
    const line = raw.trim().split(/\r?\n/).filter((s) => s.startsWith("{")).pop() ?? "{}";
    const parsed = JSON.parse(line) as { batchId: string; batchEmployeeId: string; clubId: string };
    batchId = parsed.batchId;
    samBatchEmployeeId = parsed.batchEmployeeId;
  });

  test.afterAll(async () => {
    try {
      runFixture("founder preview reset",   ["run", "fixture:payroll-founder-preview:reset"]);
      runFixture("founder preview reseed",  ["run", "fixture:payroll-founder-preview"]);
      runFixture("3C-1 complex components", ["run", "fixture:payroll-3c1-components"]);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("[afterAll] 3C-4A reset/reseed failed:", err);
    }
    await prisma.$disconnect();
  });

  test("Raelene adds three one-time adjustments to Sam; cash reaches $5,193.23; recurring Cell Phone survives", async ({ browser }) => {
    expect(batchId).toBeTruthy();
    expect(samBatchEmployeeId).toBeTruthy();

    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    await signIn(page, RAELENE_EMAIL);

    await page.goto(`/app/admin/payroll/batches/${batchId}`);
    await expect(page.getByTestId("review-header-card")).toBeVisible({ timeout: 30_000 });
    await page.screenshot({ path: path.join(OUT, "01-review-workspace.png"), fullPage: true });

    // Baseline snapshot inventory — must include the seven recurring
    // rows the fixture wires up on Sam Complex.
    const baselineSnaps = await prisma.payrollBatchComponentSnapshot.findMany({
      where: { batchId, batchEmployeeId: samBatchEmployeeId },
      orderBy: { componentCode: "asc" },
    });
    const baselineCodes = baselineSnaps.map((r) => r.componentCode).sort();
    expect(baselineCodes).toEqual([
      "AD_D_ER_PREMIUM", "CELL_PHONE_ALLOWANCE", "DEPENDENT_LIFE_ER_PREMIUM",
      "LIFE_INSURANCE_ER_PREMIUM", "LTD_EE", "RRSP_EE", "RRSP_ER",
    ]);
    expect(baselineSnaps.every((r) => r.provenance === "RECURRING_EMPLOYEE_SETUP")).toBe(true);

    // Expand Sam's row.
    await page.locator(`[data-testid^="review-emp-expand:"]`).first().click();
    await expect(page.getByTestId("adjustment-open").first()).toBeVisible({ timeout: 10_000 });

    async function addAdjustment(code: string, amount: string, reason: string) {
      await page.getByTestId("adjustment-open").first().click();
      await expect(page.getByTestId("adjustment-form")).toBeVisible();
      await page.getByTestId("adjustment-component").first().selectOption({ value: code });
      await page.getByTestId("adjustment-amount").first().fill(amount);
      await page.getByTestId("adjustment-reason").first().fill(reason);
      await page.getByTestId("adjustment-submit").first().click();
      await expect(page.getByTestId(`component-onetime-badge:${code}`).first()).toBeVisible({ timeout: 10_000 });
    }

    await addAdjustment("ONE_TIME_BONUS_TEST", "500", "August performance bonus");
    await addAdjustment("EXPENSE_REIMBURSEMENT_TEST", "72.40", "August fuel receipts");
    await addAdjustment("ONE_TIME_DEDUCTION_TEST", "50", "equipment fund");

    await page.screenshot({ path: path.join(OUT, "02-three-adjustments.png"), fullPage: true });

    // After adding: seven recurring + three one-time = ten snapshots.
    // The recurring Cell Phone $37.50 must still be present, unchanged.
    const afterAdd = await prisma.payrollBatchComponentSnapshot.findMany({
      where: { batchId, batchEmployeeId: samBatchEmployeeId },
      orderBy: { componentCode: "asc" },
    });
    expect(afterAdd.length).toBe(10);
    const recurringAfter = afterAdd.filter((r) => r.provenance === "RECURRING_EMPLOYEE_SETUP").map((r) => r.componentCode).sort();
    expect(recurringAfter).toEqual(baselineCodes);
    const cell = afterAdd.find((r) => r.componentCode === "CELL_PHONE_ALLOWANCE");
    expect(cell?.resolvedAmount?.toString()).toBe(baselineSnaps.find((r) => r.componentCode === "CELL_PHONE_ALLOWANCE")?.resolvedAmount?.toString());

    const oneTimes = afterAdd.filter((r) => r.provenance === "ONE_TIME_PAYROLL_ADJUSTMENT");
    expect(oneTimes.length).toBe(3);
    const raelene = await prisma.user.findFirstOrThrow({ where: { email: RAELENE_EMAIL } });
    expect(oneTimes.every((r) => r.enteredByUserId === raelene.id)).toBe(true);
    expect(oneTimes.every((r) => (r.reason ?? "").length > 0)).toBe(true);
    expect(oneTimes.every((r) => r.sourceAssignmentId === null)).toBe(true);

    // Calculate through the same script pattern as prepare.
    const club = await prisma.club.findFirstOrThrow({ where: { slug: "coulee-ridge" } });
    execFileSync("npx", ["tsx", "scripts/payroll-3c4a-calculate-sam-batch.ts", batchId, club.id], {
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], shell: true,
    });

    const calc = await prisma.payrollBatch.findUniqueOrThrow({ where: { id: batchId } });
    expect(calc.status).toBe("CALCULATED");

    // Founder acceptance — exact economic reconciliation. After the
    // 3C-3D statutory library promotions (Dep Life to LIBRARY,
    // Cell Phone to taxable-cash-allowance LIBRARY with EI ADD),
    // Sam's baseline taxable + pensionable now include Dependent
    // Life $0.83 as well; and EI insurable now includes the $37.50
    // Cell Phone Allowance per verified CRA treatment (Rise's
    // configuration differs — see §18 3C-3D).
    //   taxable / pensionable = 4583.33 + 37.50 + 500 (bonus)
    //                         + 2.25 + 0.83 + 20.93 + 229.17 = 5,374.01
    //   EI insurable          = 4583.33 + 37.50 (cell) + 500 (bonus) = 5,120.83
    const beAfter = await prisma.payrollBatchEmployee.findUniqueOrThrow({ where: { id: samBatchEmployeeId } });
    expect(Number(beAfter.grossPay).toFixed(2)).toBe("5193.23");
    expect(Number(beAfter.earningsTaxable).toFixed(2)).toBe("5374.01");
    expect(Number(beAfter.earningsPensionable).toFixed(2)).toBe("5374.01");
    expect(Number(beAfter.earningsInsurable).toFixed(2)).toBe("5120.83");

    // Configured employee deductions = RRSP EE 229.17 + LTD 28.11 + one-time 50 = $307.28.
    const finalSnaps = await prisma.payrollBatchComponentSnapshot.findMany({
      where: { batchId, batchEmployeeId: samBatchEmployeeId },
    });
    const configured = finalSnaps
      .filter((r) => r.side === "EMPLOYEE" && r.cashEffect === "DECREASES_NET_PAY" && r.resolvedAmount != null)
      .reduce((acc, r) => acc + Number(r.resolvedAmount!.toString()), 0);
    expect(configured.toFixed(2)).toBe("307.28");

    // Post-CALCULATED, adjustment controls must NOT be present.
    await page.reload();
    await expect(page.getByTestId("review-status-badge")).toContainText(/CALCULATED/i, { timeout: 15_000 });
    await page.locator(`[data-testid^="review-emp-expand:"]`).first().click();
    await expect(page.getByTestId("adjustment-open")).toHaveCount(0);
    await expect(page.locator("[data-testid^='adjustment-remove:']")).toHaveCount(0);
    await page.screenshot({ path: path.join(OUT, "03-calculated-readonly.png"), fullPage: true });

    await context.clearCookies();
    await context.close();
  });

  test("Chris (Controller) sees the three adjustments read-only", async ({ browser }) => {
    expect(batchId).toBeTruthy();
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    await signIn(page, CHRIS_EMAIL);

    await page.goto(`/app/admin/payroll/batches/${batchId}`);
    await expect(page.getByTestId("review-header-card")).toBeVisible({ timeout: 30_000 });
    await page.locator(`[data-testid^="review-emp-expand:"]`).first().click();

    // The three one-time badges are visible — Chris can review the
    // reasons Raelene entered.
    await expect(page.getByTestId("component-onetime-badge:ONE_TIME_BONUS_TEST").first()).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("component-onetime-badge:EXPENSE_REIMBURSEMENT_TEST").first()).toBeVisible();
    await expect(page.getByTestId("component-onetime-badge:ONE_TIME_DEDUCTION_TEST").first()).toBeVisible();

    // No add/remove controls for the Controller.
    await expect(page.getByTestId("adjustment-open")).toHaveCount(0);
    await expect(page.locator("[data-testid^='adjustment-remove:']")).toHaveCount(0);
    await page.screenshot({ path: path.join(OUT, "04-controller-readonly.png"), fullPage: true });

    await context.clearCookies();
    await context.close();
  });
});
