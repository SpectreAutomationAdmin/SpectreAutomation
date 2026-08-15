// Forensic trace of the restored Microsoft WI on staging.
// Read-only. No mutation. Diagnostic capture only.

import { test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

const OUT = "test-results/microsoft-forensic";
fs.mkdirSync(OUT, { recursive: true });

const CANDIDATES: Array<{ key: string; wiId: string }> = [
  { key: "restored-email-wi",    wiId: "cms0i8qlp0013nc7oo377f1rl" },  // "Invoice #93458725404" (Chris Turcato), RESTORED
  { key: "ap-intake-93458725404", wiId: "cms0l576g00017d6viorrz0rh" }, // "93458725404.pdf" (AP_INVOICE_REVIEW)
];

test.describe("Microsoft forensic trace", () => {
  const avail = stagingCredsAvailable();
  test.skip(!avail.ready, avail.reason ?? "");
  test.setTimeout(240_000);

  test("capture ap-evidence + doc + Mission Control feed for the restored Microsoft item", async ({ browser }) => {
    const ctx = await browser.newContext({
      viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2,
    });
    const page = await loginAsFounder(ctx, { landing: "/app/admin" });
    const base = avail.baseURL;

    for (const c of CANDIDATES) {
      const evUrl = `${base}/api/mission-control/work-intake/${c.wiId}/ap-evidence`;
      const ev = await page.request.get(evUrl);
      const body = await ev.json().catch(async () => ({ rawText: (await ev.text()).slice(0, 6000) }));
      fs.writeFileSync(
        path.join(OUT, `${c.key}-ap-evidence.json`),
        JSON.stringify({ status: ev.status(), url: evUrl, body }, null, 2),
      );
      console.log(`[${c.key}] ap-evidence HTTP ${ev.status()}`);

      // Try to pull the underlying document + PDF bytes when the ap-evidence
      // response has an ingestedDocumentId. Some WIs (email-only) may not have one.
      const docId = (body && body.document && body.document.id) || null;
      if (docId) {
        const pdf = await page.request.get(`${base}/api/documents/${docId}/download`);
        if (pdf.ok()) {
          const buf = await pdf.body();
          fs.writeFileSync(path.join(OUT, `${c.key}-doc.pdf`), buf);
          console.log(`[${c.key}] downloaded pdf ${buf.length}b`);
        } else {
          console.log(`[${c.key}] pdf download HTTP ${pdf.status()}`);
        }

        const meta = await page.request.get(`${base}/api/documents/${docId}/metadata`);
        const metaBody = await meta.json().catch(async () => ({ raw: (await meta.text()).slice(0, 2000) }));
        fs.writeFileSync(path.join(OUT, `${c.key}-doc-metadata.json`), JSON.stringify({ status: meta.status(), body: metaBody }, null, 2));
      } else {
        fs.writeFileSync(path.join(OUT, `${c.key}-no-doc.txt`), "ap-evidence had no document.id — likely email-only WI");
        console.log(`[${c.key}] no document.id in ap-evidence response`);
      }
    }

    // Full Mission Control feed for visual reference
    await page.goto(`${base}/app/admin`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(4000);
    await page.screenshot({ path: path.join(OUT, "feed-full.png"), fullPage: true });
    console.log("captured feed-full.png");

    // Try to find the E0701097E3 card in the feed and screenshot it focused
    const card = page.locator("article, section, div").filter({ hasText: "E0701097E3" }).first();
    if (await card.count() > 0) {
      await card.scrollIntoViewIfNeeded();
      await page.waitForTimeout(300);
      await card.screenshot({ path: path.join(OUT, "e0701097e3-card.png") });
      console.log("captured e0701097e3-card.png");
    } else {
      console.log("E0701097E3 card not located by hasText selector");
    }

    await ctx.close();
  });
});
