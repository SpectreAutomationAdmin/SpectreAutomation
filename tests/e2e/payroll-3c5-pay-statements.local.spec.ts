// Payroll-3C-3D.1 (2026-09-09) — local Playwright acceptance for the
// deterministic Sam Complex source-comparison flagship statement.
//
// Preconditions:
//   • dev server on http://localhost:3000
//   • fixtures reseeded (founder preview + 3c1-components)
//
// This spec uses the deterministic reset+history script so the
// flagship batch is always the newest POSTED SAL-SM-COMPLEX pay
// with payDate 2026-08-31 (Spectre's canonical semi-monthly EOM
// pay date matching the source deposit date). Twelve prior POSTED
// history batches feed YTD (seq 4 through seq 15).

import { test, expect, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const OUT = path.resolve("test-results/payroll-3c3d1");
fs.mkdirSync(OUT, { recursive: true });

const RAELENE_EMAIL = "raelene.sample@preview.spectre.test";
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
function runTsx(script: string): string {
  return execFileSync("npx", ["tsx", script], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], shell: true,
  });
}

test.describe.serial("Payroll-3C-3D.1 · Sam source-comparison flagship", () => {
  let flagshipBatchId = "";
  let flagshipBatchEmployeeId = "";
  let flagshipPayDateIso = "";
  let postedHistoryCount = 0;

  test.beforeAll(async () => {
    runFixture("founder preview reset",   ["run", "fixture:payroll-founder-preview:reset"]);
    runFixture("founder preview reseed",  ["run", "fixture:payroll-founder-preview"]);
    runFixture("3C-1 complex components", ["run", "fixture:payroll-3c1-components"]);
    // 3C-3D.1 deterministic reset + history rebuild.
    const raw = runTsx("scripts/payroll-3c3d1-sam-reset-history.ts");
    const line = raw.trim().split(/\r?\n/).filter((s) => s.startsWith("{")).pop() ?? "{}";
    const parsed = JSON.parse(line) as {
      flagshipBatchId: string; flagshipBatchEmployeeId: string;
      flagshipPayDateIso: string; postedHistoryCount: number;
    };
    flagshipBatchId = parsed.flagshipBatchId;
    flagshipBatchEmployeeId = parsed.flagshipBatchEmployeeId;
    flagshipPayDateIso = parsed.flagshipPayDateIso;
    postedHistoryCount = parsed.postedHistoryCount;
    // Sanity: 12 posted history + flagship = 13 total; flagship = Aug 31.
    expect(postedHistoryCount).toBe(12);
    // Payroll-3C-3E.1: SEMI_MONTHLY payday policy is the calendar
    // 15th / EOM with Sat/Sun → preceding Friday adjustment. Aug 31
    // 2026 is a Monday, so seq 16 pays Aug 31 (NOT Sep 6 as the
    // legacy `periodEnd + 5 days` model produced).
    expect(flagshipPayDateIso).toBe("2026-08-31T00:00:00.000Z");
  });

  test.afterAll(async () => {
    // Leave the DB in the deterministic reseeded state for founder review.
    await prisma.$disconnect();
  });

  test("Sam Complex Sept 1 flagship — DOM shows Cash 4,620.83 · Taxable 4,874.01 · CPP pens 4,874.01 · EI 4,620.83 · Employer benefits 253.18", async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    await signIn(page, RAELENE_EMAIL);

    // Payroll History → newest POSTED batch is the Sept 1 flagship.
    await page.goto("/app/admin/payroll/history");
    await expect(page.getByTestId("payroll-history-page")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId(`payroll-history-row:${flagshipBatchId}`)).toBeVisible();
    await page.screenshot({ path: path.join(OUT, "01-history-flagship.png"), fullPage: true });

    // Click through to the flagship's Statements.
    await page.getByTestId(`payroll-history-open:${flagshipBatchId}`).click();
    await expect(page.getByTestId("paystubs-page")).toBeVisible({ timeout: 30_000 });
    const card = page.getByTestId("paystub-card").first();
    await expect(card).toBeVisible();

    // Expand statutory-bases panel so text is in the DOM (not gated by <details>).
    await card.getByTestId("paystub-bases").locator("summary").click();

    const html = await card.innerHTML();

    // Current section totals (labels come from the frozen snapshot
    // displayName which the fixture defines).
    expect(html).toContain("4620.83"); // cash current + EI insurable current
    expect(html).toContain("4874.01"); // taxable + pensionable current
    expect(html).toContain("253.18");  // employer benefits section total
    // Employer benefit rows are individually visible.
    expect(html).toContain("Employer AD&amp;D Premium");
    expect(html).toContain("Employer Dependent Life Premium");
    expect(html).toContain("Employer Life Insurance Premium");
    expect(html).toContain("Employer RRSP Contribution");
    // Employee deductions.
    expect(html).toContain("229.17"); // RRSP EE current
    expect(html).toContain("28.11");  // LTD current
    // Cell Phone Allowance visible in Earnings.
    expect(html).toContain("Cell Phone Allowance");
    expect(html).toContain("37.50");

    // YTD-including-this-pay is non-zero on the recurring rows (§20 + §37).
    // Regular Salary: not a labelled component snapshot for SALARY
    // cadence, but Cell Phone Allowance YTD across 13 posted periods
    // (12 history + flagship) = 13 × $37.50 = $487.50 exact.
    expect(html).toContain("487.50");
    // AD&D YTD = 13 × 2.25 = 29.25.
    expect(html).toContain("29.25");
    // Dependent Life YTD = 13 × 0.83 = 10.79.
    expect(html).toContain("10.79");
    // Life Insurance ER YTD = 13 × 20.93 = 272.09.
    expect(html).toContain("272.09");
    // RRSP EE / RRSP ER YTD = 13 × 229.17 = 2979.21.
    expect(html).toContain("2979.21");
    // LTD YTD = 13 × 28.11 = 365.43.
    expect(html).toContain("365.43");

    // Sensitive-data sweep + no raw internal enums.
    expect(html).not.toMatch(/\b\d{3}[\s-]?\d{3}[\s-]?\d{3}\b/); // SIN
    expect(html).not.toContain("16542"); // TD1 fed claim
    expect(html).not.toContain("22769"); // TD1 prov claim
    expect(html).not.toContain("CUSTOM_TEST");
    expect(html).not.toContain("SPECTRE_LIBRARY");
    expect(html).not.toContain("RRSP_DEDUCTED_AT_SOURCE");
    expect(html).not.toContain("T4127");
    expect(html).not.toContain("provenance");

    await page.screenshot({ path: path.join(OUT, "02-flagship-statement.png"), fullPage: true });
    await context.close();
  });

  test("Sam Complex history — exactly 13 POSTED batches (12 history + flagship)", async () => {
    const club = await prisma.club.findFirstOrThrow({ where: { slug: "coulee-ridge" } });
    const pg = await prisma.payrollPayGroup.findFirstOrThrow({
      where: { clubId: club.id, code: "SAL-SM-COMPLEX" },
    });
    const all = await prisma.payrollBatch.findMany({
      where: { clubId: club.id, payPeriod: { payGroupId: pg.id } },
    });
    const posted = all.filter((b) => b.status === "POSTED");
    expect(posted.length).toBe(13);
    // No non-POSTED batches (deterministic).
    expect(all.length).toBe(13);

    // No Sam payroll before employment (hireDate = 2026-02-02).
    const sam = await prisma.employee.findFirstOrThrow({
      where: { clubId: club.id, email: "complex.pay@preview.spectre.test" },
    });
    const hireDate = sam.hireDate!;
    expect(hireDate.toISOString()).toBe("2026-02-02T00:00:00.000Z");
    const preHire = await prisma.payrollBatchEmployee.findMany({
      where: {
        clubId: club.id, employeeId: sam.id,
        batch: { payPeriod: { payDate: { lt: hireDate } } },
      },
    });
    expect(preHire.length).toBe(0);

    // Every POSTED history + flagship batch employee shows the
    // current 3C-3D economic values (deterministic post-reset).
    for (const b of posted) {
      const be = await prisma.payrollBatchEmployee.findFirstOrThrow({ where: { batchId: b.id } });
      expect(Number(be.earningsTaxable).toFixed(2)).toBe("4874.01");
      expect(Number(be.earningsInsurable).toFixed(2)).toBe("4620.83");
      expect(Number(be.earningsPensionable).toFixed(2)).toBe("4874.01");
      expect(Number(be.grossPay).toFixed(2)).toBe("4620.83");
      // Payroll-3C-3D.7 — production K2/K2P uses the CRA projected
      // YTD CPP/EI credit method. Sam reconciles to Rise's
      // $652.27 fed / $317.42 AB / $3,040.05 net at:
      //   Federal $651.67  (Δ vs Rise = $0.60, NEAR-EXACT)
      //   Alberta $317.38  (Δ vs Rise = $0.04, EXACT)
      //   Net     $3,037.85 (Δ vs Rise = $2.20)
      expect(Number(be.deductionFederalTax).toFixed(2)).toBe("651.67");
      expect(Number(be.deductionProvincialTax).toFixed(2)).toBe("317.38");
      expect(Number(be.netPay).toFixed(2)).toBe("3037.85");
    }
  });
});
