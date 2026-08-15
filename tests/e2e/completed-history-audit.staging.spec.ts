// Diagnostic — capture the Completed History feed on staging so we can
// find the Microsoft/Canada regression the founder observed.

import { test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

const OUT = "test-results/completed-history-audit";
fs.mkdirSync(OUT, { recursive: true });

test.describe("Completed History diagnostic capture", () => {
  const avail = stagingCredsAvailable();
  test.skip(!avail.ready, avail.reason ?? "");
  test.setTimeout(120_000);

  test("capture Completed History feed + Active + snapshot every WI", async ({ browser }) => {
    const ctx = await browser.newContext({
      viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2,
    });
    const page = await loginAsFounder(ctx, { landing: "/app/admin" });
    const base = avail.baseURL;

    // Full Active feed
    await page.goto(`${base}/app/admin`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3000);
    await page.screenshot({ path: path.join(OUT, "active-feed.png"), fullPage: true });

    // Try to switch to Completed History view. Common patterns to try:
    // click a tab / toggle named Completed / History.
    const historyToggle = page.getByRole("link", { name: /Completed history/i })
      .or(page.getByRole("button", { name: /Completed history/i }))
      .or(page.getByRole("tab", { name: /Completed history/i }));
    if (await historyToggle.count() > 0) {
      await historyToggle.first().click({ trial: false });
      await page.waitForTimeout(2500);
      await page.screenshot({ path: path.join(OUT, "completed-history-feed.png"), fullPage: true });
      console.log("captured completed-history-feed.png");

      // Extract inner text so we can grep for Microsoft / Canada without OCR.
      const bodyText = await page.evaluate(() => document.body.innerText);
      fs.writeFileSync(path.join(OUT, "completed-history-body.txt"), bodyText);
      const hasMs = /microsoft/i.test(bodyText);
      const hasCanadaSupplier = /·\s*Canada\b/i.test(bodyText) || /invoice.*Canada/i.test(bodyText);
      console.log(`hasMicrosoft=${hasMs} hasCanadaSupplier=${hasCanadaSupplier}`);
    } else {
      console.log("Completed History toggle not found on this view");
    }

    await ctx.close();
  });
});
