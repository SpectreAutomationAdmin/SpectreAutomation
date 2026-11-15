/**
 * EP-TRAIN-4Y-BF — READ-ONLY checks on staging.
 *
 * This spec only LOOKS. It sends GET requests and opens one page; it
 * never uploads, clicks a control, or changes anything. It runs as the
 * founder precisely to show what a real manager account gets:
 *
 *   - the server does NOT treat a real account as a test principal, so
 *     its uploads are real uploads (and, on staging, locked);
 *   - the preparation screen of a real course is read-only and shows no
 *     internal wording.
 */
import { test, expect } from "@playwright/test";
import fs from "node:fs";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

const REAL_COURSE_ID = "cmwgxzh6j000e54dnh62vwznu";
const REAL_VERSION_ID = "cmwgxzh7e000g54dn2btx5kfp";
const OUT = "test-results/4ybf";

const FORBIDDEN =
  /\$\s?\d|\bcosts?\b|\bbudget|\bGPU\b|\bModal\b|authoriz|\binference\b|\bbillable\b|Continue preparation|Confirm and continue|\bResume\b|\bRetry\b/i;

test.describe("EP-TRAIN-4Y-BF — read-only checks as a real account", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("a real account is not a test principal; its course screen is read-only", async ({ browser }) => {
    const creds = stagingCredsAvailable();
    test.skip(!creds.ready, creds.reason ?? "staging creds missing");
    fs.mkdirSync(OUT, { recursive: true });
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await loginAsFounder(ctx);

    // The isolation endpoint exists on this build and answers a real
    // account exactly like an unknown route.
    const isolation = await ctx.request.get(`${creds.baseURL}/api/admin/training/test-isolation`);
    expect(isolation.status()).toBe(404);

    await page.goto(
      `${creds.baseURL}/app/admin/people/safety-training/${REAL_COURSE_ID}/${REAL_VERSION_ID}/upload`,
      { waitUntil: "domcontentloaded" },
    );
    const card = page.getByTestId("training-prep-progress");
    await expect(card).toBeVisible({ timeout: 20_000 });
    // Nothing to press, nothing internal to read.
    expect(await card.locator("button, a[role='button'], input, select").count()).toBe(0);
    const text = await card.innerText();
    expect(text).not.toMatch(FORBIDDEN);
    await page.screenshot({ path: `${OUT}/R-real-course-read-only.png`, fullPage: true });

    const status = await ctx.request.get(
      `${creds.baseURL}/api/admin/training/versions/${REAL_VERSION_ID}/preparation-status`,
    );
    expect(status.status()).toBe(200);
    fs.writeFileSync(
      `${OUT}/R-real-course.json`,
      JSON.stringify({ isolationEndpointForRealAccount: isolation.status(), cardText: text, status: await status.json() }, null, 2),
    );
    await ctx.close();
  });
});
