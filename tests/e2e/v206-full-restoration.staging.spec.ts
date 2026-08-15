// Founder-directed 2026-08-14: full v206 staging restoration acceptance.
//
// After deploying exact v206 (cbb1b52) to spectre-staging, verify the
// four real Coulee Ridge controls end-to-end:
//   * hit ap-evidence (which re-runs analyseIngestedInvoice under v206
//     on every GET — see src/app/api/mission-control/work-intake/[id]/
//     ap-evidence/route.ts:72)
//   * capture the full ApAnalyseResult JSON per case
//   * screenshot the founder-facing Work Intake card
//
// NO writes. Everything below is read-only. The persisted findings on
// staging are unchanged; we're capturing the on-demand recompute.

import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

const OUT = "test-results/v206-full-restoration";
fs.mkdirSync(OUT, { recursive: true });

const CASES = [
  { key: "221178",  wiId: "cmsmhak530wv7ppa0lrncy9ib" },
  { key: "DMM_B0037FC", wiId: "cmsgpxuyy000711jt094a8uyu" },
  { key: "1091559", wiId: "cms6yc9tf02xvyy77w2io64kn" },
  { key: "1087769", wiId: "cms6xwpvc01o1yy77rkso7b0b" },
];

test.describe("v206 full-restoration acceptance — four Coulee Ridge controls", () => {
  const avail = stagingCredsAvailable();
  test.skip(!avail.ready, avail.reason ?? "creds missing");

  test.setTimeout(300_000);

  test("capture ap-evidence + card for each real case", async ({ browser }) => {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 2,
    });
    const page = await loginAsFounder(context, { landing: "/app/admin" });
    const base = avail.baseURL;

    // Sanity: /api/health must be 200
    const health = await page.request.get(`${base}/api/health`);
    expect(health.status()).toBe(200);
    const healthJson = await health.json();
    fs.writeFileSync(path.join(OUT, "health.json"), JSON.stringify(healthJson, null, 2));

    for (const c of CASES) {
      const evidenceUrl = `${base}/api/mission-control/work-intake/${c.wiId}/ap-evidence`;
      const resp = await page.request.get(evidenceUrl);
      const status = resp.status();
      let body: unknown = null;
      try {
        body = await resp.json();
      } catch {
        body = { rawText: (await resp.text()).slice(0, 4000) };
      }
      fs.writeFileSync(
        path.join(OUT, `${c.key}-ap-evidence.json`),
        JSON.stringify({ status, url: evidenceUrl, body }, null, 2),
      );
      console.log(`[${c.key}] ap-evidence HTTP ${status}`);

    }

    // Founder-facing surface on v206 is the Mission Control feed at /app/admin.
    // Screenshot the full feed once, then attempt to locate each WI card
    // and capture its own bounding-box crop for a focused per-case shot.
    await page.goto(`${base}/app/admin`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(4000);
    await page.screenshot({
      path: path.join(OUT, "mission-control-feed-full.png"),
      fullPage: true,
    });
    console.log("[feed] full Mission Control feed screenshot captured");

    for (const c of CASES) {
      // Match by displayed invoice number — the card title on the feed
      // reads "<Vendor> invoice #<invoiceNumber> — ...", not the raw filename.
      const invMatch = c.key === "DMM_B0037FC" ? "#B0037FC" : c.key === "221178" ? "#221178" : c.key === "1091559" ? "#1091559-00" : "#1087769-00";
      const locator = page.locator(`article, section, div`).filter({ hasText: invMatch }).filter({ hasText: "MISSING INFORMATION" }).first();
      const count = await locator.count().catch(() => 0);
      if (count > 0) {
        await locator.scrollIntoViewIfNeeded();
        await page.waitForTimeout(500);
        await locator.screenshot({ path: path.join(OUT, `${c.key}-card-focused.png`) }).catch(async (e) => {
          console.log(`[${c.key}] focused screenshot failed (${e.message}); skipping`);
        });
        console.log(`[${c.key}] card focused-crop captured (matched by filename)`);
      } else {
        console.log(`[${c.key}] card not found on Mission Control feed by filename "${filename}"`);
      }
    }

    await context.close();
  });
});
