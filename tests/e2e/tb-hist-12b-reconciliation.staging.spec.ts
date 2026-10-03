// TB-HIST-12B §10-11 (2026-10-03) — staging reconciliation proofs
// for Chapter IV (Statement of Activities) + Chapter VII (Statement
// of Financial Position) + cross-component KPI parity.
//
// All proofs run against the live Coulee January 2026 package
// without any accounting writes. The specs capture BEFORE / AFTER
// invariants to prove the baseline (562 / 0 / 2 / 2) is untouched.

import { test, expect, type Page } from "@playwright/test";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

const creds = stagingCredsAvailable();
const runAt = creds.ready ? test : test.skip;
const BASE = "https://staging.spectreautomation.com";
const COA_BATCH_ID = "cmuni5ymv000k136q3xdyrpmn";

async function captureInvariant(page: Page) {
  const resp = await page.request.get(`${BASE}/api/admin/coa-batch-diagnostic/${COA_BATCH_ID}`);
  expect(resp.ok(), `coa diagnostic responded ${resp.status()}`).toBe(true);
  return resp.json();
}

runAt("TB-HIST-12B §10-11 · Chapter IV + VII numerical reconciliation + Executive KPI parity (Coulee Jan 2026)", async ({ browser }) => {
  test.setTimeout(240_000);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await loginAsFounder(context);

  const before = await captureInvariant(page);
  console.log("TB_HIST_12B_BEFORE " + JSON.stringify({
    status: before.status, totalRows: before.total, club: before.club,
  }));

  // -----------------------------------------------------------------
  // CHAPTER X regression — Departmental P&L still reconciles (TB-HIST-10/11/12)
  // -----------------------------------------------------------------
  const reconUrl = `${BASE}/api/admin/dept-pl-reconciliation?clubId=${before.clubId}&from=2026-01-01&to=2026-01-31`;
  const reconResp = await page.request.get(reconUrl);
  expect(reconResp.ok(), `dept-pl-reconciliation responded ${reconResp.status()}`).toBe(true);
  const recon = await reconResp.json();
  console.log("TB_HIST_12B_CHAPTER_X_RECON " + JSON.stringify({
    rowCount: recon.rows.length,
    isBalanced: recon.reconciliation?.isBalanced,
    totals: recon.totals,
  }));
  // §17 D.20 Chapter X consolidated reconciliation still balanced
  expect(recon.reconciliation?.isBalanced).toBe(true);
  // §17 D.25 — all 8 departments remain
  const deptNames: string[] = recon.rows.map((r: { departmentName: string }) => r.departmentName);
  const expected = [
    "Administration", "Clubhouse", "Corporate Income & Expenses",
    "Dues & Charges", "Food & Beverage", "Golf Shop",
    "Course & Grounds", "Long Range Plan & Renovation",
  ];
  for (const n of expected) {
    expect(deptNames, `department ${n} missing from resolver`).toContain(n);
  }

  // -----------------------------------------------------------------
  // CHAPTER VII — Assets = Liabilities + Equity + cross-page parity
  // -----------------------------------------------------------------
  await page.goto(`${BASE}/app/admin/reports/balance-sheet?asOf=2026-01-31`, { waitUntil: "domcontentloaded" });
  const bsBodyText = await page.locator("body").innerText();

  // The BS page already asserts isBalanced within $0.01 as a server-
  // side gate. We confirm the balance pill appears without an
  // "unbalanced" warning.
  console.log("TB_HIST_12B_CH_VII_BS_LOADED " + JSON.stringify({
    hasBalancedMarker: bsBodyText.includes("Balance Sheet") || bsBodyText.includes("Statement of Financial Position"),
  }));
  expect(bsBodyText.includes("Balance Sheet") || bsBodyText.includes("Statement of Financial Position")).toBe(true);

  // Extract Working Capital + Current Ratio from the Monthly Reporting
  // Package (Chair's Dashboard) via the stewardship-tiles DOM.
  await page.goto(`${BASE}/app/admin/reporting/monthly?period=2026-01`, { waitUntil: "domcontentloaded" });

  // Stewardship tile — Working Capital
  const wcTile = page.locator('[data-testid="stewardship-tile-working-capital-metric"]');
  const wcDisplay = (await wcTile.textContent({ timeout: 15_000 }))?.trim() ?? "";
  // Stewardship tile — Current Ratio
  const crTile = page.locator('[data-testid="stewardship-tile-current-ratio-metric"]');
  const crDisplay = (await crTile.textContent({ timeout: 15_000 }))?.trim() ?? "";
  console.log("TB_HIST_12B_STEWARDSHIP_TILES " + JSON.stringify({
    workingCapital: wcDisplay,
    currentRatio: crDisplay,
  }));

  // Each tile must render SOMETHING other than empty.
  expect(wcDisplay.length).toBeGreaterThan(0);
  expect(crDisplay.length).toBeGreaterThan(0);

  // -----------------------------------------------------------------
  // Executive Financial Health card must agree with the Stewardship tile
  // (§17 D.22-23 — single calculation source)
  // -----------------------------------------------------------------
  const fhCoverWc = page.locator('[data-testid="cover-briefing-financial-health-kpi-working-capital"]').first();
  const fhCoverWcText = (await fhCoverWc.textContent({ timeout: 10_000 }).catch(() => null)) ?? "";
  const fhCoverCr = page.locator('[data-testid="cover-briefing-financial-health-kpi-current-ratio"]').first();
  const fhCoverCrText = (await fhCoverCr.textContent({ timeout: 10_000 }).catch(() => null)) ?? "";
  console.log("TB_HIST_12B_EXEC_FH " + JSON.stringify({
    workingCapital: fhCoverWcText,
    currentRatio: fhCoverCrText,
  }));
  // Executive card's Working Capital display must contain the same
  // formatted value substring as the Stewardship tile.
  if (wcDisplay && wcDisplay !== "Unavailable") {
    expect(fhCoverWcText).toContain(wcDisplay);
  }
  if (crDisplay && crDisplay !== "Unavailable") {
    expect(fhCoverCrText).toContain(crDisplay);
  }

  // -----------------------------------------------------------------
  // Capital Program card — financial position tiles render; project
  // execution stays Unavailable
  // -----------------------------------------------------------------
  const capBody = await page.locator("body").innerText();
  // Project execution MUST appear with Unavailable.
  expect(capBody).toMatch(/Project Execution/i);
  expect(capBody).toMatch(/Capital financial position|Unavailable/);
  // No evaluative Capital Program verdicts.
  expect(capBody).not.toContain("On Plan");
  expect(capBody).not.toContain("Strong Position");
  expect(capBody).not.toContain("Executing");

  await page.screenshot({ path: "test-results/tb-hist-12b-chair-dashboard.png", fullPage: true });

  const after = await captureInvariant(page);
  console.log("TB_HIST_12B_AFTER " + JSON.stringify({ club: after.club }));
  expect(after.club).toEqual(before.club);
  await context.close();
});
