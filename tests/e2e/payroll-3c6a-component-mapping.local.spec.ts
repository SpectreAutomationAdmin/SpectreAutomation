// Payroll-3C-6A (2026-09-05) — Component GL-mapping edit UI +
// future-only snapshot Playwright acceptance.
//
// Covers §25 (component mapping UI) and §26 (future-only mapping
// snapshot invariant). Uses the accepted Coulee Ridge fixture +
// Sam Complex; changes are reverted to the fixture state via
// scripts/payroll-founder-preview-components after the test.

import { test, expect, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const OUT = path.resolve("test-results/payroll-3c6a");
fs.mkdirSync(OUT, { recursive: true });

const RAELENE = "raelene.sample@preview.spectre.test";
const PASS    = "TA1C-Preview-99";

const prisma = new PrismaClient();

async function adminSignIn(page: Page, email: string) {
  await page.goto("/login");
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill(PASS);
  await Promise.all([
    page.waitForURL(/\/app(?!\/.*login).*/, { timeout: 30_000 }),
    page.getByRole("button", { name: /^Sign in$/ }).click(),
  ]);
}

function runFixture(script: string) {
  execFileSync("npm", ["run", script], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], shell: true,
  });
}

test.describe.serial("Payroll-3C-6A · Component GL mapping UI", () => {
  test.afterAll(async () => {
    // Restore Sam's Cell Phone → 5131 mapping the fixture expects.
    runFixture("fixture:payroll-3c1-components");
    await prisma.$disconnect();
  });

  test("Raelene edits a component's GL mapping through the browser + it persists + readiness updates", async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    await adminSignIn(page, RAELENE);

    // 1. Open Payroll Setup → Components.
    await page.goto("/app/admin/payroll/setup/components");
    await expect(page.locator('[data-testid="payroll-components-page"]')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('[data-testid="components-readiness-banner"]')).toBeVisible();
    await page.screenshot({ path: path.join(OUT, "01-components-page.png"), fullPage: true });

    // 2. Cell Phone Allowance row shows Configured (fixture-seeded).
    const cellRow = page.locator('[data-testid="component-row:CELL_PHONE_ALLOWANCE"]');
    await expect(cellRow).toBeVisible();
    const cellStatus = page.locator('[data-testid="component-gl-status:CELL_PHONE_ALLOWANCE"]');
    await expect(cellStatus).toContainText(/Configured/i);

    // 3. Click Edit GL on Cell Phone Allowance.
    await page.locator('[data-testid="component-edit-gl:CELL_PHONE_ALLOWANCE"]').click();
    const dialog = page.locator('[data-testid="component-edit-dialog"]');
    await expect(dialog).toBeVisible();
    await page.screenshot({ path: path.join(OUT, "02-edit-dialog.png"), fullPage: true });

    // 4. Verify the picker shows account numbers + names (no raw IDs).
    const select = page.locator('[data-testid="component-edit-expense-select"]');
    await expect(select).toBeVisible();
    const options = await select.locator("option").allInnerTexts();
    // Options must be formatted "NNNN — Name". No accountId strings
    // (cuids are 24-char alphanumeric; we assert nothing like that
    // appears in the OPTION LABELS).
    for (const label of options) {
      if (label.startsWith("—")) continue; // "— None —" placeholder
      expect(label).toMatch(/^\d{4} — /);
    }

    // 5. Change to a different expense account (5133 One-Time Bonus Expense).
    const club = await prisma.club.findFirstOrThrow({ where: { slug: "coulee-ridge" } });
    const alt = await prisma.account.findFirstOrThrow({
      where: { clubId: club.id, accountNumber: "5133" }, select: { id: true },
    });
    await select.selectOption(alt.id);

    // 6. Save + wait for the dialog to close.
    await page.locator('[data-testid="component-edit-save"]').click();
    await expect(dialog).not.toBeVisible({ timeout: 15_000 });

    // 7. Reload the page + assert the change persisted.
    await page.reload();
    await expect(page.locator('[data-testid="payroll-components-page"]')).toBeVisible({ timeout: 30_000 });
    const cellRowAfter = page.locator('[data-testid="component-row:CELL_PHONE_ALLOWANCE"]');
    await expect(cellRowAfter).toContainText(/5133/);
    await page.screenshot({ path: path.join(OUT, "03-after-save.png"), fullPage: true });

    // 8. Verify DB — component.expenseAccountId now = 5133.
    const cell = await prisma.payrollComponent.findFirstOrThrow({
      where: { clubId: club.id, code: "CELL_PHONE_ALLOWANCE" },
      include: { expenseAccount: true },
    });
    expect(cell.expenseAccount?.accountNumber).toBe("5133");

    await context.close();
  });

  test("§26 future-only: Batch A prepared with account X + mapping changed to Y + Batch A snapshot still X", async () => {
    // Purely a DB-level invariant proof — reuses the fixture's Sam
    // Complex Cell Phone component and the existing POSTED seq 17
    // batch. We inspect the frozen snapshot on that batch, mutate
    // the LIVE component mapping to a different account, and prove
    // the snapshot still references the ORIGINAL account. The
    // journal-level immutability is covered separately by §19 in
    // gl-component-posting-3c6a.test.ts.
    const club = await prisma.club.findFirstOrThrow({ where: { slug: "coulee-ridge" } });
    const pg = await prisma.payrollPayGroup.findFirstOrThrow({
      where: { clubId: club.id, code: "SAL-SM-COMPLEX" },
    });
    const priorBatch = await prisma.payrollBatch.findFirstOrThrow({
      where: { clubId: club.id, payGroupId: pg.id, status: "POSTED", payPeriod: { sequenceInYear: 17 } },
      orderBy: { createdAt: "desc" },
    });
    const cellSnap = await prisma.payrollBatchComponentSnapshot.findFirstOrThrow({
      where: { batchId: priorBatch.id, componentCode: "CELL_PHONE_ALLOWANCE" },
    });
    const originalExpenseAccountId = cellSnap.expenseAccountIdSnapshot;
    expect(originalExpenseAccountId).not.toBeNull();

    // Change the live component to a different expense account.
    const alt = await prisma.account.findFirstOrThrow({
      where: { clubId: club.id, accountNumber: "5133" }, select: { id: true },
    });
    const cell = await prisma.payrollComponent.findFirstOrThrow({
      where: { clubId: club.id, code: "CELL_PHONE_ALLOWANCE" }, select: { id: true, expenseAccountId: true },
    });
    const beforeLive = cell.expenseAccountId;
    await prisma.payrollComponent.update({
      where: { id: cell.id }, data: { expenseAccountId: alt.id },
    });

    // Re-read the historical snapshot — it must still hold the original.
    const cellSnapAfter = await prisma.payrollBatchComponentSnapshot.findFirstOrThrow({
      where: { id: cellSnap.id },
    });
    expect(cellSnapAfter.expenseAccountIdSnapshot).toBe(originalExpenseAccountId);

    // Restore the live mapping (also handled by the afterAll fixture reseed).
    if (beforeLive) {
      await prisma.payrollComponent.update({
        where: { id: cell.id }, data: { expenseAccountId: beforeLive },
      });
    }
  });

  test("PII sweep: setup UI carries no employee-name / SIN / TD1 / KMS leakage", async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    await adminSignIn(page, RAELENE);
    await page.goto("/app/admin/payroll/setup/components");
    await expect(page.locator('[data-testid="payroll-components-page"]')).toBeVisible({ timeout: 30_000 });
    const html = await page.content();
    // SIN pattern.
    expect(html).not.toMatch(/\b\d{3}[\s-]?\d{3}[\s-]?\d{3}\b/);
    // TD1 fixture claim amounts.
    expect(html).not.toContain("16452");
    expect(html).not.toContain("22769");
    // No KMS envelope prefix, no employee name.
    expect(html).not.toContain("KMS:");
    expect(html).not.toContain("Sam Complex");
    await context.close();
  });
});
