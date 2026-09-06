// Payroll MVP posting (2026-09-05; TD1 hotfix 2026-09-07) — local
// Playwright acceptance for the Founder Preview end-to-end salaried
// payroll workflow.
//
// Preconditions:
//   • dev server on http://localhost:3000
//   • `npm run fixture:payroll-founder-preview` has been run
//
// Scenario A — Raelene (Payroll Admin) drives Prepare + Calculate
// from the browser
//   1. Log in
//   2. Mission Control shows the Payroll Admin preparation card
//   3. Open card → Payroll Processing page
//   4. Controller Final Approval queue NOT visible (server-side)
//   5. Time approvals show "Not required — salary-only"
//   6. Readiness reads "Ready to prepare"
//   7. Click Prepare payroll → batch appears with 9 employees,
//      0 BLOCKERS (TD1 resolves successfully with the fixed writer)
//   8. Click Calculate payroll → batch reaches CALCULATED
//   9. Sign out
//
// Scenario B — Chris (Controller)
//   1. Log in
//   2. Mission Control shows Payroll Final Approval card
//   3. Open review workspace
//   4. Approve → APPROVED, Post → POSTED
//   5. GL balances, 9 pay statements, WI resolved
//
// afterAll — reset + reseed the founder preview so the localhost
// DB is left in the exact pre-Raelene state.

import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const OUT = path.resolve("test-results/payroll-founder-preview");
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

async function signOut(context: BrowserContext) {
  await context.clearCookies();
}

let batchId: string = "";

test.describe.serial("Payroll Founder Preview — end-to-end", () => {
  test.beforeAll(() => {
    // Fresh preview state — reset any prior batch, ensure clean fixtures.
    try {
      execFileSync("npm", ["run", "fixture:payroll-founder-preview:reset"], {
        encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], shell: true,
      });
      execFileSync("npm", ["run", "fixture:payroll-founder-preview"], {
        encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], shell: true,
      });
    } catch (err) {
      throw new Error("beforeAll preview seed failed: " + (err as Error).message);
    }
  });

  test.afterAll(async () => {
    // Leave the founder database in the exact pre-Raelene state.
    try {
      execFileSync("npm", ["run", "fixture:payroll-founder-preview:reset"], {
        encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], shell: true,
      });
      execFileSync("npm", ["run", "fixture:payroll-founder-preview"], {
        encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], shell: true,
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("[afterAll] founder reset/reseed failed:", err);
    }
    await prisma.$disconnect();
  });

  // -----------------------------------------------------------------
  // A · Raelene prepares + calculates through the browser
  // -----------------------------------------------------------------
  test("Scenario A · Raelene prepares + calculates from Mission Control", async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();

    await signIn(page, RAELENE_EMAIL);

    // A1 · Mission Control shows the preparation card.
    await page.goto("/app/admin");
    await expect(page.getByRole("heading", { name: /Work Intake Feed/i })).toBeVisible({ timeout: 30_000 });
    const card = page.getByRole("article").filter({ hasText: "Payroll ready to process" }).first();
    await expect(card).toBeVisible({ timeout: 20_000 });
    await page.screenshot({ path: path.join(OUT, "01-raelene-mc.png"), fullPage: true });

    // A2 · Open the card → Payroll Processing page.
    await card.getByRole("link").first().click();
    await page.waitForURL(/\/app\/admin\/payroll\/process/, { timeout: 15_000 });

    // A3 · Controller Final Approval queue must NOT render.
    await expect(page.getByTestId("payroll-controller-queue")).toHaveCount(0);

    // A4 · Salary-only readiness.
    const timeApprovals = page.getByTestId("process-time-approvals");
    await expect(timeApprovals).toContainText(/Not required — this payroll contains salary-only employees/i);
    await expect(page.getByTestId("process-blocked-approvals")).toHaveCount(0);
    await expect(page.getByTestId("process-ready")).toContainText(/Ready to prepare/i);
    await page.screenshot({ path: path.join(OUT, "02-raelene-processing.png"), fullPage: true });

    // A5 · Prepare payroll — through the actual button.
    await page.getByTestId("process-prepare").click();
    await expect(page.getByTestId("process-batch")).toBeVisible({ timeout: 30_000 });
    await page.screenshot({ path: path.join(OUT, "03-raelene-prepared.png"), fullPage: true });

    // A6 · The prepared batch has 9 employees + zero blockers (TD1
    // is now securely resolvable end-to-end).
    const batchSection = page.getByTestId("process-batch");
    await expect(batchSection).toContainText(/Employees:.*9/i);
    await expect(batchSection).toContainText(/Blockers:\s*0/i);
    // No TD1 blocker copy anywhere in the exception panel.
    const grouped = page.getByTestId("process-grouped-exceptions");
    if (await grouped.count() > 0) {
      const groupedText = await grouped.innerText();
      expect(groupedText).not.toMatch(/could not be securely read/i);
      expect(groupedText).not.toMatch(/TD1_CLAIM_RESOLUTION_FAILED/);
    }

    // A7 · Calculate payroll — through the actual button.
    await page.getByTestId("process-calculate").click();
    await expect(page.getByTestId("process-status")).toContainText(/Payroll calculated/i, { timeout: 30_000 });
    await page.screenshot({ path: path.join(OUT, "04-raelene-calculated.png"), fullPage: true });

    // A8 · Persisted state — CALCULATED batch exists.
    const club = await prisma.club.findFirstOrThrow({ where: { slug: "coulee-ridge" } });
    const posted = await prisma.payrollBatch.findFirstOrThrow({
      where: { clubId: club.id, status: "CALCULATED" },
      orderBy: { createdAt: "desc" },
    });
    batchId = posted.id;

    const employeeCount = await prisma.payrollBatchEmployee.count({ where: { batchId } });
    expect(employeeCount).toBe(9);
    const blockerCount = await prisma.payrollBatchException.count({
      where: { batchId, severity: "BLOCKER" },
    });
    expect(blockerCount).toBe(0);

    // A9 · ECONOMIC CORRECTNESS — the founder-preview 2026-09-01→15
    // salary period must produce specific numbers, not just >0.
    // 9 preview salaries total $867,000; 24 SM periods → $36,125
    // per period. Alex earns $150k annual → $6,250.00 gross.
    const rows = await prisma.payrollBatchEmployee.findMany({
      where: { batchId },
      include: { employee: { select: { firstName: true, lastName: true } } },
    });
    const totalGross = rows.reduce((s, r) => s + Number(r.grossPay ?? 0), 0);
    expect(totalGross.toFixed(2)).toBe("36125.00");
    // Sanity-check the anti-defect: the $867,000 previously seen must not recur.
    expect(totalGross).not.toBe(867000);

    const alex = rows.find((r) => r.employee.firstName === "Alex");
    expect(alex).toBeTruthy();
    expect(Number(alex!.grossPay).toFixed(2)).toBe("6250.00");
    // The catastrophic-defect CPP for Alex was $4,230.45 (whole-year
    // maximum in one period). After periodization it must be an
    // order of magnitude smaller (~$363).
    expect(Number(alex!.deductionCppEeCombined)).toBeLessThan(1000);
    expect(Number(alex!.deductionEiEe)).toBeLessThan(500);
    expect(Number(alex!.deductionCpp2Ee)).toBe(0);

    await signOut(context);
    await context.close();
  });

  // -----------------------------------------------------------------
  // B · Chris approves + posts, verifies GL + paystubs
  // -----------------------------------------------------------------
  test("Scenario B · Chris approves + posts, GL balances, 9 pay statements, WI resolved", async ({ browser }) => {
    expect(batchId).toBeTruthy();
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();

    await signIn(page, CHRIS_EMAIL);

    await page.goto("/app/admin");
    await expect(page.getByRole("heading", { name: /Work Intake Feed/i })).toBeVisible({ timeout: 30_000 });
    const finalApprovalCard = page.getByRole("article").filter({ hasText: /Payroll/i }).first();
    await expect(finalApprovalCard).toBeVisible({ timeout: 20_000 });
    await page.screenshot({ path: path.join(OUT, "10-chris-mc.png"), fullPage: true });

    // Chris also sees the Controller queue on the Payroll Processing page.
    await page.goto("/app/admin/payroll/process");
    await expect(page.getByTestId("payroll-controller-queue")).toBeVisible({ timeout: 15_000 });

    await page.goto(`/app/admin/payroll/batches/${batchId}`);
    await expect(page.getByTestId("review-actions")).toBeVisible({ timeout: 30_000 });
    await page.screenshot({ path: path.join(OUT, "11-review-workspace.png"), fullPage: true });

    page.once("dialog", (d) => d.accept());
    await page.getByTestId("review-approve-btn").click();
    await expect(page.getByTestId("review-lifecycle-badge")).toHaveText("APPROVED", { timeout: 20_000 });

    page.once("dialog", (d) => d.accept());
    await page.getByTestId("review-post-btn").click();
    await expect(page.getByTestId("review-lifecycle-badge")).toHaveText("POSTED", { timeout: 20_000 });
    const banner = page.getByTestId("review-actions-banner");
    await expect(banner).toContainText(/Payment transmission: not yet enabled/i);
    await page.screenshot({ path: path.join(OUT, "13-posted.png"), fullPage: true });

    const posted = await prisma.payrollBatch.findUniqueOrThrow({ where: { id: batchId } });
    expect(posted.status).toBe("POSTED");
    expect(posted.glJournalEntryId).toBeTruthy();
    expect(posted.approvedByUserId).not.toBe(posted.preparedByUserId);

    const lines = await prisma.journalEntryLine.findMany({
      where: { journalEntryId: posted.glJournalEntryId! },
    });
    expect(lines.length).toBe(8);
    const totalD = lines.reduce((s, l) => s + Number(l.debit  ?? 0), 0);
    const totalC = lines.reduce((s, l) => s + Number(l.credit ?? 0), 0);
    expect(totalD).toBeGreaterThan(0);
    expect(totalD.toFixed(2)).toBe(totalC.toFixed(2));

    const wiOrigin = await prisma.workIntakeOrigin.findFirst({
      where: { clubId: posted.clubId, kind: "PAYROLL_FINAL_APPROVAL", referenceId: batchId, role: "PRIMARY" },
    });
    if (wiOrigin) {
      const wi = await prisma.workIntakeItem.findUniqueOrThrow({ where: { id: wiOrigin.workIntakeItemId } });
      expect(wi.status).toBe("RESOLVED");
    }

    await page.goto(`/app/admin/payroll/batches/${batchId}/paystubs`);
    await page.waitForLoadState("domcontentloaded");
    const stubCards = page.getByTestId("paystub-card");
    await expect(stubCards).toHaveCount(9);
    // Alex Preview's paystub shows $6,250.00 gross (150k / 24), not
    // $150,000 — the anti-defect assertion.
    const alexEmployee = await prisma.employee.findFirstOrThrow({ where: { firstName: "Alex", clubId: posted.clubId } });
    const alexCard = page.locator(`[data-employee-id="${alexEmployee.id}"]`);
    await expect(alexCard).toBeVisible();
    const alexNet = await alexCard.getByTestId("paystub-net-pay").innerText();
    // Alex net = $6,250 - deductions (~ $650 + tax) ≈ $4,304
    expect(Number(alexNet.replace(/[^\d.]/g, ""))).toBeLessThan(5000);
    expect(Number(alexNet.replace(/[^\d.]/g, ""))).toBeGreaterThan(3500);
    await page.screenshot({ path: path.join(OUT, "14-paystubs.png"), fullPage: true });

    const paystubMain = await page.locator("main").innerHTML().catch(async () => page.content());
    expect(paystubMain).not.toMatch(/\b\d{3}[\s-]?\d{3}[\s-]?\d{3}\b/);
    expect(paystubMain).not.toContain("16452");
    expect(paystubMain).not.toContain("22769");

    await page.goto(`/app/admin/payroll/batches/${batchId}/gl`);
    await page.waitForLoadState("domcontentloaded");
    await expect(page.getByText(/Balanced: debits/i)).toBeVisible({ timeout: 15_000 });
    await page.screenshot({ path: path.join(OUT, "15-gl.png"), fullPage: true });

    await signOut(context);
    await context.close();
  });
});
