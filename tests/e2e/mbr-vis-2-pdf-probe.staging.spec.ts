// MBR-VIS-2 — probe the PDF endpoint directly with the founder's
// cookie session so we can see WHY it fails.

import { test } from "@playwright/test";
import { expect } from "@playwright/test";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

const creds = stagingCredsAvailable();
const runAt = creds.ready ? test : test.skip;
const BASE = "https://staging.spectreautomation.com";

runAt("MBR-VIS-2 · probe PDF endpoint with authenticated session", async ({ browser }) => {
  test.setTimeout(300_000);
  const ctx = await browser.newContext({ viewport: { width: 1650, height: 930 } });
  const page = await loginAsFounder(ctx);
  // Capture the PDF endpoint response.
  const res = await page.request.get(
    `${BASE}/api/reporting/monthly/pdf?period=2026-03`,
    { timeout: 180_000 },
  );
  console.log(`MBR_VIS_2_PDF_STATUS ${res.status()}`);
  console.log(`MBR_VIS_2_PDF_HEADERS ${JSON.stringify(Object.fromEntries(Object.entries(res.headers())))}`);
  if (res.status() !== 200) {
    const text = await res.text().catch(() => "<unreadable>");
    console.log(`MBR_VIS_2_PDF_ERR_BODY ${text.slice(0, 2000)}`);
  } else {
    const body = await res.body();
    console.log(`MBR_VIS_2_PDF_SIZE ${body.length} first-bytes=${body.slice(0, 4).toString("hex")}`);
  }
  expect(res.status()).toBeLessThan(600);
  await ctx.close();
});
