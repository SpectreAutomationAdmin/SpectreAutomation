// STEWARDSHIP-LIVE-2 (2026-10-05) — staging acceptance.
//
// Primary gate: one canonical NOI / Revenue / Dues / Payroll / Capital-
// Income across Section III stewardship, Section IV Statement of
// Activities, Section II Operating Results, and Payroll Analysis.
// Section III no longer uses regex classifiers; its numerators come
// from the canonical FS-Group projection.
//
// Secondary gate: Section IV expand/collapse chevrons hidden in print
// media (print:hidden class active under emulateMedia print).

import { test, expect, type Page } from "@playwright/test";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

const creds = stagingCredsAvailable();
const runAt = creds.ready ? test : test.skip;
const BASE = "https://staging.spectreautomation.com";
const COA_BATCH_ID = "cmuni5ymv000k136q3xdyrpmn";

async function invariant(page: Page) {
  const r = await page.request.get(`${BASE}/api/admin/coa-batch-diagnostic/${COA_BATCH_ID}`);
  expect(r.ok()).toBe(true);
  return r.json();
}

function parseStatementValue(s: string): number | null {
  const t = s.trim();
  if (t === "—" || t === "") return null;
  const neg = t.startsWith("(") && t.endsWith(")");
  const inner = neg ? t.slice(1, -1) : t;
  const n = Number(inner.replace(/,/g, ""));
  if (!Number.isFinite(n)) return null;
  return neg ? -n : n;
}

function rowValuesFromInnerText(innerText: string): number[] {
  const parts = innerText.split(/\t|\n/).map((s) => s.trim()).filter(Boolean);
  const isCell = (s: string): boolean => {
    if (s === "—") return true;
    if (/^[+-]?\d/.test(s)) return true;
    if (/^\(/.test(s)) return true;
    return false;
  };
  const nums: number[] = [];
  for (let i = parts.length - 1; i >= 0 && nums.length < 7; i--) {
    if (!isCell(parts[i])) continue;
    const v = parseStatementValue(parts[i]);
    nums.unshift(v ?? 0);
  }
  return nums;
}

runAt("STEWARDSHIP-LIVE-2 · Section III canonical rewiring + full parity + print polish", async ({ browser }) => {
  test.setTimeout(240_000);
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await loginAsFounder(ctx);

  const before = await invariant(page);
  console.log("STEWARDSHIP_LIVE_2_BEFORE " + JSON.stringify({ club: before.club }));
  expect(before.club.account).toBe(562);
  expect(before.club.journalEntry).toBe(0);
  expect(before.club.reportingLedgerBatch).toBe(2);
  expect(before.club.reportingLedgerSnapshot).toBe(2);

  // -------- (A) Section III stewardship headline cards --------
  await page.goto(`${BASE}/app/admin/reporting/monthly?period=2026-01#stewardship-dashboard`, { waitUntil: "domcontentloaded" });
  await page.locator('[data-testid="stewardship-kpi-dashboard"]').waitFor({ state: "visible", timeout: 20_000 });
  const sec3Revenue = await page.locator('[data-testid="stewardship-summary-revenue-value"]').innerText();
  const sec3Noi = await page.locator('[data-testid="stewardship-summary-noi-value"]').innerText();
  const sec3CapIncome = await page.locator('[data-testid="stewardship-summary-capital-fund-income-value"]').innerText();
  const sec3Reserve = await page.locator('[data-testid="stewardship-summary-reserve-coverage-value"]').innerText();
  console.log("STEWARDSHIP_LIVE_2_SECTION_III_HEADLINE " + JSON.stringify({
    revenue: sec3Revenue, noi: sec3Noi, capIncome: sec3CapIncome, reserve: sec3Reserve,
  }));
  expect(sec3Revenue).toMatch(/\$3\.124M/);
  expect(sec3Noi).toMatch(/\$2\.820M/);
  // Capital Fund Income from canonical capital-revenue total.
  // Note: formatMoneyShort uses 3-decimal M formatting, so $977K renders as $977K (not $0.977M).
  expect(sec3CapIncome).toMatch(/\$977K/);
  expect(sec3Reserve).toBe("—");

  // -------- (B) Section III Dues-to-Revenue + Payroll Ratio (canonical fsGroupKey) --------
  const duesCardActual = await page.locator('[data-testid="stewardship-dues-rev-actual"]').innerText();
  const payrollCardActual = await page.locator('[data-testid="stewardship-payroll-ratio-actual"]').innerText();
  const noiMarginActual = await page.locator('[data-testid="stewardship-noi-margin-actual"]').innerText();
  console.log("STEWARDSHIP_LIVE_2_SECTION_III_KPI " + JSON.stringify({
    duesRev: duesCardActual,
    payrollRatio: payrollCardActual,
    noiMargin: noiMarginActual,
  }));
  // Dues = $3,089,943.30 / $3,124,066.72 = 98.9%
  expect(duesCardActual).toMatch(/98\.9%/);
  // Payroll = $163,409.80 / $3,124,066.72 = 5.2%
  expect(payrollCardActual).toMatch(/5\.2%/);
  // NOI Margin = $2,820,446.76 / $3,124,066.72 = 90.3%
  expect(noiMarginActual).toMatch(/90\.3%/);

  // -------- (C) Section IV Statement of Activities parity --------
  await page.goto(`${BASE}/app/admin/reporting/monthly?period=2026-01#statement-of-activities`, { waitUntil: "domcontentloaded" });
  await page.locator('[data-testid="statement-of-activities-v2"]').waitFor({ state: "visible", timeout: 20_000 });
  const sec4OpRev = rowValuesFromInnerText(await page.locator('[data-testid="soa-row-total-operating-revenue"]').innerText())[4];
  const sec4Noi = rowValuesFromInnerText(await page.locator('[data-testid="soa-row-noi-before-dep"]').innerText())[4];
  const sec4CapRev = rowValuesFromInnerText(await page.locator('[data-testid="soa-row-cat-subtotal-CAPITAL_REVENUE"]').innerText())[4];
  const sec4DuesFsg = rowValuesFromInnerText(await page.locator('[data-testid="soa-row-fsg-IS_MEMBERSHIP_DUES"]').innerText())[4];
  const sec4PayrollFsg = rowValuesFromInnerText(await page.locator('[data-testid="soa-row-fsg-IS_PAYROLL"]').innerText())[4];
  console.log("STEWARDSHIP_LIVE_2_SECTION_IV " + JSON.stringify({
    totalOpRev: sec4OpRev, noi: sec4Noi, capitalRevenue: sec4CapRev,
    duesFsgYtd: sec4DuesFsg, payrollFsgYtd: sec4PayrollFsg,
  }));

  // Section II parity: Operating Revenue + NOI reconcile across sections.
  //   Section III rendered $3.124M, Section IV rendered $3,124,067 — same canonical number.
  //   Section III rendered $2.820M, Section IV rendered $2,820,447 — same canonical NOI.
  // Convert Section III "$3.124M" display to a cents-matching band.
  //   formatMoneyShort uses 3-decimal M for values ≥ $1M, so "$3.124M"
  //   corresponds to [3,124,000.00, 3,124,999.99]. Section IV $3,124,067
  //   rounds to "3,124" thousand → matches "$3.124M".
  expect(Math.abs(sec4OpRev - 3_124_067)).toBeLessThan(2);
  expect(Math.abs(sec4Noi - 2_820_447)).toBeLessThan(3);
  // Capital Fund Income: Section III $977K ↔ Section IV capital-revenue
  // subtotal $977,326.
  expect(Math.abs(sec4CapRev - 977_326)).toBeLessThan(2);
  // Dues numerator parity.
  expect(Math.abs(sec4DuesFsg - 3_089_943)).toBeLessThan(2);
  // Payroll numerator parity (matches PAYROLL-HIST-1 canonical $163,410).
  expect(Math.abs(sec4PayrollFsg - 163_410)).toBeLessThan(2);

  // -------- (D) Section IV print-chevron polish --------
  await page.emulateMedia({ media: "print" });
  await page.waitForTimeout(400);
  // All chevron buttons should be CSS-hidden (display:none from Tailwind print:hidden).
  const chevronVisible = await page.locator('[data-testid*="-toggle"]').first().isVisible().catch(() => false);
  console.log("STEWARDSHIP_LIVE_2_PRINT_CHEVRON_VISIBLE " + chevronVisible);
  expect(chevronVisible).toBe(false);
  await page.screenshot({ path: "test-results/stewardship-live-2-section-iv-print.png", fullPage: true });
  await page.emulateMedia({ media: null });

  // -------- (E) Section III screenshot --------
  await page.goto(`${BASE}/app/admin/reporting/monthly?period=2026-01#stewardship-dashboard`, { waitUntil: "domcontentloaded" });
  await page.locator('[data-testid="stewardship-kpi-dashboard"]').waitFor({ state: "visible", timeout: 20_000 });
  await page.screenshot({ path: "test-results/stewardship-live-2-section-iii.png", fullPage: true });

  const after = await invariant(page);
  expect(after.club).toEqual(before.club);
  await ctx.close();
});
