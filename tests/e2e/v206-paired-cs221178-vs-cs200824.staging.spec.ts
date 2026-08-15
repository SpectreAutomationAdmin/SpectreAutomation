// Paired forensic capture for Club Support #221178 (v206 PASS) vs #200824
// (v206 FAIL — no GL category). Read-only, no code changes.
import { test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

const OUT = "test-results/v206-paired-cs";
fs.mkdirSync(OUT, { recursive: true });

const CASES = [
  { key: "cs221178", wiId: "cmsmhak530wv7ppa0lrncy9ib", docId: "cmsmhajfb0wuzppa0wi1u07nu" },
  { key: "cs200824", wiId: "cmstrkoyy030913qwre6er2cq", docId: "cmstrko8t030113qw5kk5j6ev" },
];

test.describe("Paired diagnostic — CS221178 vs CS200824 under v206", () => {
  const avail = stagingCredsAvailable();
  test.skip(!avail.ready, avail.reason ?? "creds missing");
  test.setTimeout(180_000);

  test("capture ap-evidence + card + document metadata for both", async ({ browser }) => {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 2,
    });
    const page = await loginAsFounder(context, { landing: "/app/admin" });
    const base = avail.baseURL;

    for (const c of CASES) {
      // ap-evidence — re-runs analyseIngestedInvoice under v206
      const evResp = await page.request.get(
        `${base}/api/mission-control/work-intake/${c.wiId}/ap-evidence`,
      );
      const evBody = await evResp.json().catch(async () => ({ rawText: (await evResp.text()).slice(0, 4000) }));
      fs.writeFileSync(
        path.join(OUT, `${c.key}-ap-evidence.json`),
        JSON.stringify({ status: evResp.status(), body: evBody }, null, 2),
      );
      console.log(`[${c.key}] ap-evidence HTTP ${evResp.status()}`);

      // document metadata
      const metaResp = await page.request.get(
        `${base}/api/documents/${c.docId}/metadata`,
      );
      const metaBody = await metaResp.json().catch(async () => ({ rawText: (await metaResp.text()).slice(0, 2000) }));
      fs.writeFileSync(
        path.join(OUT, `${c.key}-document-metadata.json`),
        JSON.stringify({ status: metaResp.status(), body: metaBody }, null, 2),
      );

      // download raw PDF for text inspection
      const dlResp = await page.request.get(
        `${base}/api/documents/${c.docId}/download`,
      );
      if (dlResp.ok()) {
        const buf = await dlResp.body();
        fs.writeFileSync(path.join(OUT, `${c.key}.pdf`), buf);
        console.log(`[${c.key}] pdf downloaded (${buf.length} bytes)`);
      } else {
        console.log(`[${c.key}] pdf download HTTP ${dlResp.status()} — skipped`);
      }
    }

    // Feed screenshot — both cards should be visible on /app/admin
    await page.goto(`${base}/app/admin`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(4000);
    await page.screenshot({ path: path.join(OUT, "mission-control-feed.png"), fullPage: true });

    // Focused per-card crops
    for (const c of CASES) {
      const invMatch = c.key === "cs221178" ? "#221178" : "#200824";
      const locator = page.locator("article, section, div").filter({ hasText: invMatch }).filter({ hasText: "MISSING INFORMATION" }).first();
      const count = await locator.count().catch(() => 0);
      if (count > 0) {
        await locator.scrollIntoViewIfNeeded();
        await page.waitForTimeout(300);
        await locator.screenshot({ path: path.join(OUT, `${c.key}-card-focused.png`) }).catch(() => {});
      }
    }

    await context.close();
  });
});
