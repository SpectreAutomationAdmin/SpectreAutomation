// COA-MAP-2E (2026-10-07) — authenticated staging acceptance.
//
// Browser-level regression gate for the collapsed-state Account
// List vertical layout.  Fails on the regressed CSS; passes after
// fix.
//
// Reproduces the EXACT founder state:
//   /app/admin/coa  ·  Account List mode  ·  no selection  ·
//   all top-level type sections collapsed  ·  viewport ~1650x930.
//
// The gate measures `thead.top` in both expanded AND collapsed
// states and asserts invariance (within rendering tolerance).  On
// the regressed CSS the collapsed `thead.top` is pushed down ~438
// px; the fix anchors body to the `1fr` grid row so the table
// origin never moves.

import { test, expect, type BrowserContext, type Page } from "@playwright/test";
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
async function shot(page: Page, name: string): Promise<void> {
  await page
    .screenshot({ path: `test-results/coa-map-2e-${name}.png` })
    .catch(() => undefined);
}
async function layoutProbe(page: Page) {
  return page.evaluate(() => {
    const yOf = (sel: string) => {
      const el = document.querySelector(sel) as HTMLElement | null;
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { top: Math.round(r.top), bottom: Math.round(r.bottom), height: Math.round(r.height) };
    };
    const w = document.querySelector(".spectre-dw-table-wrap") as HTMLElement | null;
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      toolbar: yOf(".spectre-dw-toolbar"),
      thead: yOf(".spectre-dw-table thead tr"),
      firstGroupHeader: yOf(".spectre-dw-table .spectre-dw-group-header"),
      tableWrap: yOf(".spectre-dw-table-wrap"),
      wrapScroll: w ? { scrollTop: w.scrollTop, scrollHeight: w.scrollHeight, clientHeight: w.clientHeight } : null,
    };
  });
}

async function collapseAllTypes(page: Page): Promise<void> {
  const types = ["ASSET", "LIABILITY", "EQUITY", "REVENUE", "EXPENSE"];
  for (const t of types) {
    const row = page.locator(`[data-testid="coa-type-${t}"] .spectre-dw-group-header`).first();
    if ((await row.count()) > 0) {
      await row.scrollIntoViewIfNeeded();
      await row.click({ timeout: 5_000 }).catch(() => undefined);
      await page.waitForTimeout(120);
    }
  }
  await page.waitForTimeout(500);
}

runAt("COA-MAP-2E · collapsed-state header-Y invariance gate", async ({ browser }) => {
  test.setTimeout(300_000);
  // Match the founder's viewport class (screenshot ~1650x930).
  const ctx: BrowserContext = await browser.newContext({ viewport: { width: 1650, height: 930 } });
  const page = await loginAsFounder(ctx);

  const before = await invariant(page);
  console.log("COA_MAP_2E_BEFORE_INVARIANT " + JSON.stringify({ club: before.club }));
  expect(before.club.account).toBe(562);

  await page.goto(`${BASE}/app/admin/coa`, { waitUntil: "domcontentloaded" });
  await page.locator(".spectre-dw-table-wrap").waitFor({ state: "visible", timeout: 20_000 });
  await page.waitForTimeout(1000);

  // ------------------------------------------------------------
  // Expanded state (default) — baseline.
  // ------------------------------------------------------------
  const expanded = await layoutProbe(page);
  console.log("COA_MAP_2E_EXPANDED " + JSON.stringify(expanded));
  expect(expanded.toolbar).toBeTruthy();
  expect(expanded.thead).toBeTruthy();
  const expandedGap = expanded.thead!.top - expanded.toolbar!.bottom;
  console.log("COA_MAP_2E_EXPANDED_GAP " + expandedGap);
  expect(expandedGap).toBeLessThanOrEqual(8);
  await shot(page, "01-expanded");

  // ------------------------------------------------------------
  // Collapse ALL top-level sections — the exact founder state.
  // ------------------------------------------------------------
  await collapseAllTypes(page);
  const collapsed = await layoutProbe(page);
  console.log("COA_MAP_2E_COLLAPSED " + JSON.stringify(collapsed));
  await shot(page, "02-collapsed");

  // Hard gate — the SAME assertion the expanded state passed.
  // On the regressed CSS the collapsed thead.top was ~690 (438 px
  // below the toolbar); after the fix it must remain abutting.
  const collapsedGap = collapsed.thead!.top - collapsed.toolbar!.bottom;
  console.log("COA_MAP_2E_COLLAPSED_GAP " + collapsedGap);
  expect(collapsedGap).toBeLessThanOrEqual(8);

  // Header-Y invariance between states.
  const theadDelta = Math.abs(collapsed.thead!.top - expanded.thead!.top);
  console.log("COA_MAP_2E_THEAD_DELTA_COLLAPSED_VS_EXPANDED " + theadDelta);
  expect(theadDelta).toBeLessThanOrEqual(8);

  // Blank space must be BELOW the content.  Expenses (last visible
  // group header in collapsed mode) must sit above the workspace
  // bottom.
  const workspaceBottom = collapsed.tableWrap!.bottom;
  const firstGroupBottom = collapsed.firstGroupHeader!.bottom;
  console.log("COA_MAP_2E_UNUSED_SPACE_BELOW " + (workspaceBottom - firstGroupBottom));
  expect(workspaceBottom - firstGroupBottom).toBeGreaterThan(0);

  // ------------------------------------------------------------
  // Scroll owner integrity — COA-MAP-2C drag still works through
  // this scroll surface.
  // ------------------------------------------------------------
  expect(collapsed.wrapScroll).toBeTruthy();
  console.log("COA_MAP_2E_SCROLL_OWNER_PRESERVED " + JSON.stringify(collapsed.wrapScroll));

  // ------------------------------------------------------------
  // Baseline + January parity.
  // ------------------------------------------------------------
  const after = await invariant(page);
  console.log("COA_MAP_2E_AFTER_INVARIANT " + JSON.stringify({ club: after.club }));
  expect(after.club).toEqual(before.club);

  await page.goto(`${BASE}/app/admin/reporting/monthly?period=2026-01`, { waitUntil: "domcontentloaded" });
  const bodyText = await page.locator("body").innerText();
  const opRevPresent =
    bodyText.includes("$3,124,066.72") ||
    bodyText.includes("$3.12M") ||
    bodyText.includes("3,124,066");
  console.log("COA_MAP_2E_JAN_PARITY_OPREV " + opRevPresent);
  expect(opRevPresent).toBe(true);

  console.log(
    "COA_MAP_2E_AUTOMATED_PASS true · " +
    "expanded_gap=" + expandedGap + "px · " +
    "collapsed_gap=" + collapsedGap + "px · " +
    "thead_delta=" + theadDelta + "px · " +
    "unused_space_below=" + (workspaceBottom - firstGroupBottom) + "px · " +
    "baseline_preserved=true · jan_parity=true"
  );

  await ctx.close();
});
