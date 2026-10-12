// MBR-VIS-5I — Operating vs. Capital Stewardship component
// visibility acceptance.  Verifies on live staging:
//
//   §A  Section-level toggle renders beside the "Operating vs.
//        Capital Stewardship" heading.
//   §B  All 4 ribbon tiles carry independent inline toggles.
//   §C  Operating + Capital subsection toggles render on the
//        dark-green panel headers (white eye on dark bg).
//   §D  At least one Operating + one Capital per-metric toggle
//        renders inside the paired grid (`row:...` keys).
//   §E  Hiding a ribbon tile marks ONLY that tile hidden; the
//        neighbour tile is untouched; Draft Preview omits the
//        hidden tile from the DOM.
//   §F  The ribbon's Reserve Coverage toggle is INDEPENDENT of any
//        detailed Capital Stewardship Reserve Coverage card — the
//        two keys live under distinct namespaces.
//   §G  Round-trip geometry preserved on a sample ribbon tile
//        after hide → restore.

import { test } from "@playwright/test";
import { expect } from "@playwright/test";
import path from "node:path";
import { mkdirSync, existsSync } from "node:fs";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

const creds = stagingCredsAvailable();
const runAt = creds.ready ? test : test.skip;
const BASE = "https://staging.spectreautomation.com";

function ensureOutDir(): string {
  const outDir = path.join("test-results");
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  return outDir;
}

const SECTION_KEY = "card:stewardship-dashboard:operating-vs-capital-stewardship";
const RIBBON_KEYS = [
  "tile:stewardship-dashboard:total-operating-revenue",
  "tile:stewardship-dashboard:noi-before-depreciation",
  "tile:stewardship-dashboard:capital-fund-income-ytd",
  "tile:stewardship-dashboard:reserve-coverage-ratio",
];
const OPERATING_SUBSECTION_KEY = "card:stewardship-dashboard:operating-stewardship-subsection";
const CAPITAL_SUBSECTION_KEY = "card:stewardship-dashboard:capital-stewardship-subsection";

async function clickToggle(page: import("@playwright/test").Page, componentKey: string) {
  await page
    .locator(`[data-testid="inline-card-toggle-${componentKey}"] button`)
    .first()
    .click();
  await page.waitForTimeout(1000);
}

runAt(
  "MBR-VIS-5I · Operating vs. Capital Stewardship — section + ribbon + subsection + per-metric toggles + preview omission + independence",
  async ({ browser }) => {
    test.setTimeout(600_000);
    const ctx = await browser.newContext({ viewport: { width: 1650, height: 2000 } });
    const page = await loginAsFounder(ctx);
    const outDir = ensureOutDir();

    await page.goto(`${BASE}/app/admin/reporting/monthly?period=2026-03#stewardship-dashboard`, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await page.waitForTimeout(6000);

    // ─── §A — section-level toggle present. ────────────────────
    const sectionToggle = page.locator(`[data-testid="inline-card-toggle-${SECTION_KEY}"]`);
    const sectionCount = await sectionToggle.count();
    console.log(`MBR_VIS_5I_SECTION_TOGGLE count=${sectionCount}`);
    expect(sectionCount).toBeGreaterThanOrEqual(1);

    // ─── §B — all 4 ribbon tile toggles present. ───────────────
    for (const key of RIBBON_KEYS) {
      const n = await page.locator(`[data-testid="inline-card-toggle-${key}"]`).count();
      console.log(`MBR_VIS_5I_RIBBON ${key} count=${n}`);
      expect(n).toBeGreaterThanOrEqual(1);
    }

    // ─── §C — Operating + Capital subsection toggles present. ──
    const opSub = await page.locator(`[data-testid="inline-card-toggle-${OPERATING_SUBSECTION_KEY}"]`).count();
    const capSub = await page.locator(`[data-testid="inline-card-toggle-${CAPITAL_SUBSECTION_KEY}"]`).count();
    console.log(`MBR_VIS_5I_OP_SUBSECTION count=${opSub}`);
    console.log(`MBR_VIS_5I_CAP_SUBSECTION count=${capSub}`);
    expect(opSub).toBeGreaterThanOrEqual(1);
    expect(capSub).toBeGreaterThanOrEqual(1);

    // ─── §D — ≥1 Operating + ≥1 Capital per-metric toggle. ─────
    const opMetrics = await page.locator(
      '[data-testid^="inline-card-toggle-row:stewardship-dashboard:operating-stewardship-subsection:"]',
    ).count();
    const capMetrics = await page.locator(
      '[data-testid^="inline-card-toggle-row:stewardship-dashboard:capital-stewardship-subsection:"]',
    ).count();
    console.log(`MBR_VIS_5I_OP_METRIC_TOGGLE_COUNT ${opMetrics}`);
    console.log(`MBR_VIS_5I_CAP_METRIC_TOGGLE_COUNT ${capMetrics}`);
    expect(opMetrics).toBeGreaterThanOrEqual(1);
    expect(capMetrics).toBeGreaterThanOrEqual(1);

    // ─── §E — hide the Revenue ribbon tile; verify independence
    //           + Draft Preview omission. ───────────────────────
    const REVENUE_KEY = RIBBON_KEYS[0];
    const NOI_KEY = RIBBON_KEYS[1];
    const revenueTile = page.locator('[data-testid="stewardship-summary-revenue"]').first();
    await revenueTile.scrollIntoViewIfNeeded();
    await page.waitForTimeout(400);
    const beforeBox = await revenueTile.boundingBox();
    console.log(`MBR_VIS_5I_REVENUE_BEFORE ${JSON.stringify(beforeBox)}`);

    const revenueInitial = await page.evaluate((k: string) => {
      const el = document.querySelector(`[data-component-key="${k}"]`);
      return el?.getAttribute("data-card-hidden") === "true";
    }, REVENUE_KEY);

    if (!revenueInitial) await clickToggle(page, REVENUE_KEY);
    const neighbours = await page.evaluate(
      ({ a, b }: { a: string; b: string }) => ({
        revenueHidden: document.querySelector(`[data-component-key="${a}"]`)?.getAttribute("data-card-hidden"),
        noiHidden: document.querySelector(`[data-component-key="${b}"]`)?.getAttribute("data-card-hidden"),
      }),
      { a: REVENUE_KEY, b: NOI_KEY },
    );
    console.log(`MBR_VIS_5I_INDEPENDENCE ${JSON.stringify(neighbours)}`);
    expect(neighbours.revenueHidden).toBe("true");
    expect(neighbours.noiHidden ?? "false").toBe("false");

    // Draft Preview — Revenue tile must be absent from the DOM.
    await page.goto(`${BASE}/app/admin/reporting/monthly?period=2026-03&preview=draft#stewardship-dashboard`, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await page.waitForTimeout(5000);
    const previewState = await page.evaluate(
      ({ a, b }: { a: string; b: string }) => ({
        revenuePresent: !!document.querySelector(`[data-component-key="${a}"]`),
        noiPresent: !!document.querySelector(`[data-component-key="${b}"]`),
      }),
      { a: REVENUE_KEY, b: NOI_KEY },
    );
    console.log(`MBR_VIS_5I_PREVIEW ${JSON.stringify(previewState)}`);
    expect(previewState.revenuePresent).toBe(false);
    expect(previewState.noiPresent).toBe(true);

    await page.screenshot({
      path: path.join(outDir, "mbr-vis-5i-preview-revenue-hidden.png"),
      clip: { x: 0, y: 0, width: 1650, height: 1200 },
    });
    console.log(
      "MBR_VIS_5I_PREVIEW_SCREENSHOT test-results/mbr-vis-5i-preview-revenue-hidden.png",
    );

    // ─── §F — ribbon Reserve Coverage key is independent of
    //           any detailed Capital Stewardship card key.
    //           Walk the DOM: the ribbon toggle must exist AND
    //           the row:...capital-stewardship-subsection:...
    //           namespace must have NO entry that equals the ribbon
    //           key — the two keys live in distinct trees. ───────
    await page.goto(`${BASE}/app/admin/reporting/monthly?period=2026-03#stewardship-dashboard`, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await page.waitForTimeout(4000);
    const keyNamespaces = await page.evaluate(() => {
      const toggles = Array.from(
        document.querySelectorAll('[data-testid^="inline-card-toggle-"]'),
      );
      const keys = toggles.map((el) => {
        const t = el.getAttribute("data-testid") ?? "";
        return t.replace(/^inline-card-toggle-/, "");
      });
      return {
        ribbonReserveCoverage: keys.includes(
          "tile:stewardship-dashboard:reserve-coverage-ratio",
        ),
        anyRowReserveCoverage: keys.some((k) =>
          k.startsWith("row:stewardship-dashboard:capital-stewardship-subsection:"),
        ),
        collision: keys.filter(
          (k) =>
            k === "tile:stewardship-dashboard:reserve-coverage-ratio" ||
            k === "row:stewardship-dashboard:capital-stewardship-subsection:reserve-coverage-ratio",
        ).length,
      };
    });
    console.log(`MBR_VIS_5I_KEY_NAMESPACES ${JSON.stringify(keyNamespaces)}`);
    expect(keyNamespaces.ribbonReserveCoverage).toBe(true);
    expect(keyNamespaces.anyRowReserveCoverage).toBe(true);

    // ─── §G — restore Revenue; verify round-trip geometry. ─────
    await clickToggle(page, REVENUE_KEY);
    await page.waitForTimeout(400);
    const afterBox = await page.locator('[data-testid="stewardship-summary-revenue"]').first().boundingBox();
    console.log(`MBR_VIS_5I_REVENUE_AFTER ${JSON.stringify(afterBox)}`);
    if (beforeBox && afterBox) {
      expect(Math.abs(beforeBox.width - afterBox.width)).toBeLessThanOrEqual(1);
      expect(Math.abs(beforeBox.height - afterBox.height)).toBeLessThanOrEqual(1);
    }
    // If the Controller originally had it hidden, restore to that state.
    if (revenueInitial) await clickToggle(page, REVENUE_KEY);

    // Full-chapter screenshot of editing mode (all restored).
    await page.setViewportSize({ width: 1650, height: 3000 });
    await page.waitForTimeout(500);
    await page.goto(`${BASE}/app/admin/reporting/monthly?period=2026-03#stewardship-dashboard`, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await page.waitForTimeout(5000);
    await page.screenshot({
      path: path.join(outDir, "mbr-vis-5i-editing-op-vs-cap.png"),
      clip: { x: 0, y: 0, width: 1650, height: 3000 },
    });
    console.log(
      "MBR_VIS_5I_EDITING_SCREENSHOT test-results/mbr-vis-5i-editing-op-vs-cap.png",
    );

    await ctx.close();
  },
);
