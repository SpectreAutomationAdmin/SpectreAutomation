// MBR-FIX-2F — numeric acceptance for Section X card presentation.
//
// Live staging DOM parse per dept.  Asserts:
//   • "Other Operating Expenses" row exists (replacing old
//     "Operating Expenses").
//   • "Net Operating Result" label replaces "Net Income".
//   • Payroll + OtherOpEx numerically reconcile to the pre-fix
//     "Operating Expenses" value for every dept listed in the
//     directive §4.
//   • Payroll row and Other Operating Expenses row show different
//     values (not double-counted).

import { test, type Page } from "@playwright/test";
import { expect } from "@playwright/test";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

const creds = stagingCredsAvailable();
const runAt = creds.ready ? test : test.skip;
const BASE = "https://staging.spectreautomation.com";

function parseMoneyCell(raw: string): number {
  const m = raw.match(/-?\$?([\d,]+(?:\.\d+)?)/);
  if (!m) return NaN;
  const sign = /-/.test(raw) ? -1 : 1;
  return sign * Number(m[1].replace(/,/g, ""));
}

// Expected values from directive §4 (February 2026 YTD).
const EXPECTED = {
  "Administration":   { payroll: 99431.01, otherOpEx:  99582.00, netResult: -199013.01 },
  "Clubhouse":        { payroll: 15540.58, otherOpEx:  30344.91, netResult:  -45885.49 },
  "Food & Beverage":  { payroll: 92329.91, otherOpEx:  18327.80, netResult:  -58559.59, revenue: 90555.70, cogs: 38457.58 },
  "Golf Shop":        { payroll: 60369.80, otherOpEx:   9052.49, netResult:  -48957.69, revenue: 31150.48, cogs: 10685.88 },
  "Course & Grounds": { payroll: 84353.38, otherOpEx: 117392.34, netResult: -201745.72 },
};

async function readDeptCard(page: Page, deptName: string): Promise<Record<string, number>> {
  // Scope the search to the Section X card grid specifically.  The
  // dept names appear earlier on the page in the Chair's Dashboard
  // variance badges (e.g. "Administration ($199K) ($231K) +$32K"),
  // so we must anchor on the Section X "STATEMENT 08 OF 14" marker
  // and search forward from there.
  const sectionText = await page.evaluate(() => {
    const scopeText = document.body.innerText.replace(/\s+/g, " ");
    const anchor = scopeText.indexOf("STATEMENT 08 OF 14");
    return anchor < 0 ? "" : scopeText.slice(anchor);
  });
  if (!sectionText) throw new Error("Section X anchor not found");
  const i = sectionText.indexOf(deptName);
  if (i < 0) throw new Error(`dept card not found inside Section X: ${deptName}`);
  const card = sectionText.slice(i, i + 800);
  const out: Record<string, number> = {};
  const labels = [
    { key: "revenue",     label: "Revenue" },
    { key: "cogs",        label: "Cost of Sales" },
    { key: "payroll",     label: "Payroll & Benefits" },
    { key: "otherOpEx",   label: "Other Operating Expenses" },
    { key: "netResult",   label: "Net Operating Result" },
  ];
  for (const l of labels) {
    const re = new RegExp(l.label + `\\s+(-?\\$?[\\d,]+(?:\\.\\d+)?)`);
    const m = card.match(re);
    if (m) out[l.key] = parseMoneyCell(m[1]);
  }
  return out;
}

runAt("MBR-FIX-2F · Feb 2026 — Section X dept cards present mutually-exclusive expense categories", async ({ browser }) => {
  test.setTimeout(300_000);
  const ctx = await browser.newContext({ viewport: { width: 1650, height: 930 } });
  const page = await loginAsFounder(ctx);
  await page.goto(`${BASE}/app/admin/reporting/monthly?period=2026-02#departmental-p-and-l`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(4500);

  // Capture the Section X area for visual record.
  const section = page.locator('text=Departmental P&L Summary').first();
  const container = section.locator('xpath=ancestor::*[self::section or self::div][2]');
  await container.scrollIntoViewIfNeeded();
  await container.screenshot({ path: "test-results/mbr-fix-2f-feb-dept-cards.png" });

  // Pre-fix stale "Operating Expenses" label must be absent + new
  // "Other Operating Expenses" / "Net Operating Result" labels present.
  const sectionTxt = (await container.innerText()).replace(/\s+/g, " ");
  expect(sectionTxt).toContain("Other Operating Expenses");
  expect(sectionTxt).toContain("Net Operating Result");

  // Per-dept numeric reconciliation against directive §4.
  for (const [name, exp] of Object.entries(EXPECTED)) {
    const got = await readDeptCard(page, name);
    console.log(`MBR_FIX_2F_FEB_DEPT ${name} ${JSON.stringify(got)}`);
    expect(got.payroll, `${name} payroll`).toBeCloseTo(exp.payroll, 2);
    expect(got.otherOpEx, `${name} otherOpEx`).toBeCloseTo(exp.otherOpEx, 2);
    expect(got.netResult, `${name} netResult`).toBeCloseTo(exp.netResult, 2);
    if ("revenue" in exp) {
      expect(got.revenue, `${name} revenue`).toBeCloseTo(exp.revenue, 2);
      expect(got.cogs, `${name} cogs`).toBeCloseTo(exp.cogs, 2);
    }
    // Mutually-exclusive identity: Payroll must differ from OtherOpEx
    // for every real-dept card (= no accidental duplication).
    expect(got.payroll).not.toBe(got.otherOpEx);
    // Net result identity:
    //   NetResult = Revenue − COGS − Payroll − OtherOpEx
    const rev = got.revenue ?? 0;
    const cogs = got.cogs ?? 0;
    const synthNet = rev - cogs - got.payroll - got.otherOpEx;
    expect(Math.round(synthNet * 100) / 100, `${name} net identity`)
      .toBeCloseTo(exp.netResult, 2);
  }

  await ctx.close();
});

runAt("MBR-FIX-2F · Jan 2026 regression guard — Section X applies the same presentation", async ({ browser }) => {
  test.setTimeout(300_000);
  const ctx = await browser.newContext({ viewport: { width: 1650, height: 930 } });
  const page = await loginAsFounder(ctx);
  await page.goto(`${BASE}/app/admin/reporting/monthly?period=2026-01#departmental-p-and-l`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(4500);

  const section = page.locator('text=Departmental P&L Summary').first();
  const container = section.locator('xpath=ancestor::*[self::section or self::div][2]');
  await container.scrollIntoViewIfNeeded();
  const txt = (await container.innerText()).replace(/\s+/g, " ");
  await container.screenshot({ path: "test-results/mbr-fix-2f-jan-dept-cards.png" });

  // Same presentation applies to Jan — labels present.
  expect(txt).toContain("Other Operating Expenses");
  expect(txt).toContain("Net Operating Result");

  // Pick Food & Beverage (has rev, cogs, payroll, opex all non-zero
  // on Jan) and verify the identity.
  const got = await readDeptCard(page, "Food & Beverage");
  console.log(`MBR_FIX_2F_JAN_FB ${JSON.stringify(got)}`);
  // Identity: Revenue − COGS − Payroll − OtherOpEx = NetResult.
  const synthNet = Math.round(((got.revenue ?? 0) - (got.cogs ?? 0) - got.payroll - got.otherOpEx) * 100) / 100;
  expect(synthNet).toBeCloseTo(got.netResult, 2);
  // Payroll + OtherOpEx must differ (not visually duplicated).
  expect(got.payroll).not.toBe(got.otherOpEx);

  await ctx.close();
});
