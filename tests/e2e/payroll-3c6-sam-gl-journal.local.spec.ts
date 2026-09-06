// Payroll-3C-6 (2026-09-05) — Sam Complex approve → post → GL journal
// Playwright acceptance.
//
// Programmatically POSTs Sam's next OPEN semi-monthly period via
// scripts/payroll-3c6-sam-post-next.ts (which walks the same
// approve-and-post service the UI would trigger), then drives the
// browser to view the resulting GL journal and asserts:
//   • balanced (D = C)
//   • net-pay-payable = PayrollBatchEmployee.netPay (§65)
//   • RRSP payable aggregates EE + ER (§28, §BD)
//   • employer benefits post as expense + payable (§27, §BE)
//   • no employee-name PII in journal descriptions (§74, §BO)

import { test, expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const OUT = path.resolve("test-results/payroll-3c6");
fs.mkdirSync(OUT, { recursive: true });

const CHRIS = "chris.fixture@preview.spectre.test";  // Controller — holds gl:read for the /gl page.
const PASS  = "TA1C-Preview-99";

async function adminSignIn(page: Page, email: string) {
  await page.goto("/login");
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill(PASS);
  await Promise.all([
    page.waitForURL(/\/app(?!\/.*login).*/, { timeout: 30_000 }),
    page.getByRole("button", { name: /^Sign in$/ }).click(),
  ]);
}

function runTsx(script: string): string {
  return execFileSync("npx", ["tsx", script], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], shell: true,
  });
}

interface PostResult {
  clubId: string; batchId: string; batchEmployeeId: string;
  journalEntryId: string; entryNumber: string;
  totalDebits: string; totalCredits: string; difference: string;
  payPeriodSequence: number; payDateIso: string;
  lines: Array<{ accountNumber: string; accountName: string; debit: string; credit: string; description: string | null }>;
  samEmployeeStatutory: {
    grossPay: string; netPay: string;
    deductionFederalTax: string; deductionProvincialTax: string;
    employerCppCombined: string; employerEi: string;
  };
}

test.describe.serial("Payroll-3C-6 · Sam Complex post → GL", () => {
  let result: PostResult;

  test.beforeAll(async () => {
    const raw = runTsx("scripts/payroll-3c6-sam-post-next.ts");
    const line = raw.trim().split(/\r?\n/).filter((s) => s.startsWith("{")).pop() ?? "{}";
    result = JSON.parse(line) as PostResult;
    // Persist the payload for the checkpoint.
    fs.writeFileSync(path.join(OUT, "sam-post-result.json"), JSON.stringify(result, null, 2));
    // Balance + statutory invariants. Statutory federal / Alberta
    // are stable across periods for Sam (same YTD credit method +
    // H2 package). Net pay varies slightly across periods because
    // employer EI's per-period allocation shifts as PR advances, so
    // we assert reconciliation to whatever the batch actually paid
    // (net-pay clearing == PayrollBatchEmployee.netPay) rather than
    // pinning a literal.
    expect(result.totalDebits).toBe(result.totalCredits);
    expect(result.difference).toBe("0.00");
    expect(result.samEmployeeStatutory.deductionFederalTax).toBe("651.67");
    expect(result.samEmployeeStatutory.deductionProvincialTax).toBe("317.38");
  });

  test("net-pay-payable credit reconciles exactly to PayrollBatchEmployee.netPay (§65)", () => {
    const net = result.lines.find((l) => l.accountNumber === "2100");
    expect(net).toBeDefined();
    expect(Number(net!.credit).toFixed(2)).toBe(Number(result.samEmployeeStatutory.netPay).toFixed(2));
  });

  test("RRSP payable aggregates EE + ER on a single credit line ($458.34)", () => {
    const rrspLines = result.lines.filter((l) => l.accountNumber === "2150");
    expect(rrspLines.length).toBe(1);
    expect(Number(rrspLines[0].credit).toFixed(2)).toBe("458.34");
  });

  test("employer benefits post to expense (5130) AND to benefits payable (2160)", () => {
    const benExp  = result.lines.find((l) => l.accountNumber === "5130");
    const benLiab = result.lines.find((l) => l.accountNumber === "2160");
    expect(benExp).toBeDefined();
    expect(benLiab).toBeDefined();
    expect(Number(benExp!.debit)).toBeGreaterThan(0);
    expect(Number(benLiab!.credit)).toBeGreaterThan(0);
    // Life $20.93 + AD&D $2.25 + Dep Life $0.83 = $24.01 employer benefits expense
    expect(Number(benExp!.debit).toFixed(2)).toBe("24.01");
    // + LTD EE $28.11 into the same benefits payable = $52.12
    expect(Number(benLiab!.credit).toFixed(2)).toBe("52.12");
  });

  test("residual salary expense = gross − cash allowance components (no double-count)", () => {
    const salary = result.lines.find((l) => l.accountNumber === "5100");
    expect(salary).toBeDefined();
    // gross $4,620.83 − Cell Phone $37.50 = $4,583.33
    expect(Number(salary!.debit).toFixed(2)).toBe("4583.33");
    const cell = result.lines.find((l) => l.accountNumber === "5131");
    expect(Number(cell!.debit).toFixed(2)).toBe("37.50");
  });

  test("journal descriptions carry no employee-name / SIN / TD1 PII", () => {
    const blob = result.lines.map((l) => l.description ?? "").join(" | ");
    // Sam's name must not appear.
    expect(blob).not.toContain("Sam Complex");
    // SIN pattern.
    expect(blob).not.toMatch(/\b\d{3}[\s-]?\d{3}[\s-]?\d{3}\b/);
    // Fixture TD1 claim amounts.
    expect(blob).not.toContain("16452");
    expect(blob).not.toContain("22769");
  });

  test("GL journal page renders the balanced journal in the browser", async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    await adminSignIn(page, CHRIS);
    await page.goto(`/app/admin/payroll/batches/${result.batchId}/gl`);
    await expect(page.locator('[data-testid="payroll-gl-page"]')).toBeVisible({ timeout: 30_000 });

    // Balance banner: "Balanced: debits $X = credits $X".
    await expect(page.getByText(/Balanced: debits/i)).toBeVisible({ timeout: 15_000 });

    // Every line's account number should be rendered in the browser DOM.
    const html = await page.content();
    for (const l of result.lines) {
      expect(html).toContain(l.accountNumber);
    }
    // Net-pay clearing amount visible (matches PayrollBatchEmployee.netPay).
    expect(html).toContain(Number(result.samEmployeeStatutory.netPay).toFixed(2));

    await page.screenshot({ path: path.join(OUT, "sam-gl-journal.png"), fullPage: true });
    await context.close();
  });
});
