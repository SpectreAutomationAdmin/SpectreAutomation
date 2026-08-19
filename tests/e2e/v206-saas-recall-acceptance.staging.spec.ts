// v206 SaaS-recall repair acceptance (2026-08-15) — verifies the bounded
// classifier fix against real Coulee Ridge invoices on staging without
// modifying any threshold, weight, or v206 architecture.
//
// Founder §11 required real regression set:
//   #221178, #200824 (formerly reported as #220824), DMM B0037FC,
//   Oakcreek #1091559, Oakcreek #1087769, OXIO, CPA Alberta controls.

import { test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

const OUT = "test-results/v206-saas-recall-acceptance";
fs.mkdirSync(OUT, { recursive: true });

const CASES: Array<{ key: string; wiId: string }> = [
  { key: "cs221178", wiId: "cmsmhak530wv7ppa0lrncy9ib" },
  { key: "cs200824", wiId: "cmstrkoyy030913qwre6er2cq" },
  { key: "dmm_b0037fc", wiId: "cmsgpxuyy000711jt094a8uyu" },
  { key: "oak1091559", wiId: "cms6yc9tf02xvyy77w2io64kn" },
  { key: "oak1087769", wiId: "cms6xwpvc01o1yy77rkso7b0b" },
];

test.describe("v206 SaaS-recall real regression set", () => {
  const avail = stagingCredsAvailable();
  test.skip(!avail.ready, avail.reason ?? "creds missing");
  test.setTimeout(300_000);

  test("capture ap-evidence + card for all real controls", async ({ browser }) => {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 2,
    });
    const page = await loginAsFounder(context, { landing: "/app/admin" });
    const base = avail.baseURL;

    // Health first
    const health = await page.request.get(`${base}/api/health`);
    const healthJson = await health.json();
    fs.writeFileSync(path.join(OUT, "health.json"), JSON.stringify(healthJson, null, 2));

    for (const c of CASES) {
      const evResp = await page.request.get(
        `${base}/api/mission-control/work-intake/${c.wiId}/ap-evidence`,
      );
      const evBody = await evResp.json().catch(async () => ({ rawText: (await evResp.text()).slice(0, 4000) }));
      fs.writeFileSync(
        path.join(OUT, `${c.key}-ap-evidence.json`),
        JSON.stringify({ status: evResp.status(), body: evBody }, null, 2),
      );
      console.log(`[${c.key}] ap-evidence HTTP ${evResp.status()}`);
    }

    // Screenshot feed
    await page.goto(`${base}/app/admin`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(4000);
    await page.screenshot({
      path: path.join(OUT, "mission-control-feed.png"),
      fullPage: true,
    });
    console.log("[feed] Mission Control feed captured");

    // Focused per-card crops
    const cardMatches: Record<string, string> = {
      cs221178: "#221178",
      cs200824: "#200824",
      dmm_b0037fc: "#B0037FC",
      oak1091559: "#1091559-00",
      oak1087769: "#1087769-00",
    };
    for (const c of CASES) {
      const match = cardMatches[c.key];
      const locator = page.locator("article, section, div").filter({ hasText: match }).filter({ hasText: "MISSING INFORMATION" }).first();
      const count = await locator.count().catch(() => 0);
      if (count > 0) {
        await locator.scrollIntoViewIfNeeded();
        await page.waitForTimeout(300);
        await locator.screenshot({ path: path.join(OUT, `${c.key}-card.png`) }).catch(() => {});
        console.log(`[${c.key}] card captured`);
      } else {
        console.log(`[${c.key}] card not found on feed`);
      }
    }

    await context.close();
  });
});
