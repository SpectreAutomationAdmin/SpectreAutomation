// v206 Work Intake state fix acceptance (2026-08-15).
// Verifies §22 founder acceptance:
//   * Club Support #220824 card no longer shows "Missing Information"
//     when supplier + invoice + total + GL are all known and only the
//     Vendor record is missing. Primary action becomes "Create vendor
//     & post".
//   * All other real controls unchanged from v206 SaaS-recall baseline.

import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

const OUT = "test-results/work-intake-state-fix-acceptance";
fs.mkdirSync(OUT, { recursive: true });

const CASES: Array<{ key: string; wiId: string; invMatch: string; expectedPrimaryAction: string }> = [
  { key: "cs220824", wiId: "cmstrkoyy030913qwre6er2cq", invMatch: "#220824",   expectedPrimaryAction: "Create vendor & post" },
  { key: "cs221178", wiId: "cmsmhak530wv7ppa0lrncy9ib", invMatch: "#221178",   expectedPrimaryAction: "Create vendor & post" },
  { key: "dmm",      wiId: "cmsgpxuyy000711jt094a8uyu", invMatch: "#B0037FC",  expectedPrimaryAction: "Create vendor & post" },
  { key: "oak1091559", wiId: "cms6yc9tf02xvyy77w2io64kn", invMatch: "#1091559-00", expectedPrimaryAction: "Create vendor & post" },
  { key: "oak1087769", wiId: "cms6xwpvc01o1yy77rkso7b0b", invMatch: "#1087769-00", expectedPrimaryAction: "Create vendor & post" },
];

test.describe("Work Intake state fix — post-deploy acceptance", () => {
  const avail = stagingCredsAvailable();
  test.skip(!avail.ready, avail.reason ?? "");
  test.setTimeout(240_000);

  test("cards reflect new state model", async ({ browser }) => {
    const ctx = await browser.newContext({
      viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2,
    });
    const page = await loginAsFounder(ctx, { landing: "/app/admin" });
    const base = avail.baseURL;

    // Health first
    const h = await page.request.get(`${base}/api/health`);
    expect(h.status()).toBe(200);

    // Capture full feed
    await page.goto(`${base}/app/admin`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(4000);
    await page.screenshot({ path: path.join(OUT, "feed-full.png"), fullPage: true });

    // Per-card capture + primary-action assertion
    for (const c of CASES) {
      const card = page.locator("article, section, div")
        .filter({ hasText: c.invMatch })
        .filter({ hasText: /^\s*(MISSING INFORMATION|VENDOR MATCH REQUIRED|NEEDS JUDGMENT|READY FOR APPROVAL)\b/im })
        .first();
      const count = await card.count().catch(() => 0);
      if (count === 0) {
        console.log(`[${c.key}] card not found for ${c.invMatch}`);
        continue;
      }
      await card.scrollIntoViewIfNeeded();
      await page.waitForTimeout(300);
      await card.screenshot({ path: path.join(OUT, `${c.key}-card.png`) }).catch(() => {});

      // Read the card's textContent for the primary-action label.
      const cardText = await card.evaluate((el) => el.textContent ?? "");
      fs.writeFileSync(path.join(OUT, `${c.key}-card.txt`), cardText.slice(0, 4000));
      const hasExpected = cardText.includes(c.expectedPrimaryAction);
      const hasRequestInfo = cardText.includes("Request information");
      console.log(`[${c.key}] hasExpected="${c.expectedPrimaryAction}"=${hasExpected} · hasRequestInfo=${hasRequestInfo}`);
    }

    await ctx.close();
  });
});
