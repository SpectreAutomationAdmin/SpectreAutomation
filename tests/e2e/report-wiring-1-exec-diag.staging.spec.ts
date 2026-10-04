// REPORT-WIRING-1 diagnostic — dump the Executive At-a-Glance DOM
// so we know whether the comparison variance is rendering.

import { test } from "@playwright/test";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";
const creds = stagingCredsAvailable();
const runAt = creds.ready ? test : test.skip;
const BASE = "https://staging.spectreautomation.com";

runAt("REPORT-WIRING-1 exec diagnostic", async ({ browser }) => {
  test.setTimeout(120_000);
  const context = await browser.newContext();
  const page = await loginAsFounder(context);
  await page.goto(`${BASE}/app/admin/reporting/monthly?period=2026-01`, { waitUntil: "domcontentloaded" });
  await page.locator('[data-testid="financial-performance-source-panel"]').waitFor({ state: "visible", timeout: 20_000 });

  // How many exec-kpi cards exist?
  const cards = await page.locator('[data-testid^="exec-kpi-"]').count();
  console.log("DIAG_EXEC_KPI_TOTAL " + cards);
  // Enumerate each exec-kpi testid.
  const allTestids = await page.$$eval('[data-testid^="exec-kpi-"]', (nodes) =>
    nodes.map((n) => (n as HTMLElement).getAttribute("data-testid"))
  );
  console.log("DIAG_EXEC_KPI_TESTIDS " + JSON.stringify(allTestids));

  // Scoped text for the key Revenue + NOI cards.
  for (const key of ["ytd-revenue", "revenue", "noi"]) {
    const card = page.locator(`[data-testid="exec-kpi-${key}"]`);
    const n = await card.count();
    if (n === 0) {
      console.log(`DIAG_EXEC_CARD_${key}: NOT FOUND`);
      continue;
    }
    const text = (await card.innerText().catch(() => "")).replace(/\s+/g, " ");
    console.log(`DIAG_EXEC_CARD_${key}: ${JSON.stringify(text)}`);
  }

  await context.close();
});
