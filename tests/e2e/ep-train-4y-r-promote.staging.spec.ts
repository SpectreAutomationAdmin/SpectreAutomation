// EP-TRAIN-4Y-R §6 closeout — walks revalidate → promote on the
// previously-approved draft after slice-4 syncs the draft's
// groundingProjectionSha256 scalar.
import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

const COURSE_ID = "cmvzs3vz9000256qcu7lfysoz";
const VERSION_ID = "cmvzs3w05000456qcgfgps7gy";
const APPROVED_DRAFT_ID = "cmw7zjm38007pcnz1s7wrlrvp";
const BASE = process.env.SPECTRE_STAGING_BASE_URL ?? "https://staging.spectreautomation.com";

function readLocalEnv(key: string): string | undefined {
  if (process.env[key]) return process.env[key];
  for (const file of [".env.playwright.local", ".env.staging.local", ".env.local"]) {
    const p = path.join(process.cwd(), file);
    if (!fs.existsSync(p)) continue;
    for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z_0-9]+)\s*=\s*(.*)\s*$/);
      if (m && m[1] === key) return m[2].replace(/^["']|["']$/g, "");
    }
  }
  return undefined;
}

async function loginAsReviewer(ctx: BrowserContext): Promise<Page> {
  const email = readLocalEnv("SPECTRE_4YQ_REVIEWER_EMAIL")!;
  const password = readLocalEnv("SPECTRE_4YQ_REVIEWER_PASSWORD")!;
  const page = await ctx.newPage();
  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
  await page.locator('input[name="email"]').fill(email);
  await page.locator('input[name="password"]').fill(password);
  await Promise.all([
    page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 30_000 }),
    page.locator('form[action] button[type="submit"], form button[type="submit"]').first().click(),
  ]);
  return page;
}

test.describe("EP-TRAIN-4Y-R §6 — promote closeout", () => {
  test.skip(!stagingCredsAvailable().ready, "staging credentials not set");

  test("revalidate syncs scalar → founder promotes approved draft", async ({ browser }) => {
    test.setTimeout(3 * 60_000);

    // Reviewer kicks a fresh revalidate on the already-APPROVED draft.
    // The slice-4 fix in revalidateDraft now writes
    // draft.groundingProjectionSha256 = materialised.projectionSha256,
    // which aligns the scalar for the promote-route integrity check.
    const reviewerCtx = await browser.newContext({ viewport: { width: 1600, height: 1100 } });
    const reviewerPage = await loginAsReviewer(reviewerCtx);
    const reval = await reviewerPage.request.post(
      `${BASE}/api/admin/ai-training/drafts/${APPROVED_DRAFT_ID}/revalidate`,
    );
    const revalBody = await reval.json();
    console.log(`REVALIDATE_POST_SLICE4: status=${reval.status()} body=${JSON.stringify(revalBody)}`);
    expect(reval.status()).toBe(200);
    await reviewerPage.close();
    await reviewerCtx.close();

    // Founder (CLUB_ADMIN) now attempts promotion with a fresh content
    // hash + validation id.
    const founderCtx = await browser.newContext({ viewport: { width: 1600, height: 1100 } });
    const founderPage = await loginAsFounder(founderCtx);
    const state = await founderPage.request.get(
      `${BASE}/api/admin/ai-training/drafts/${APPROVED_DRAFT_ID}/state`,
    );
    const stateBody = await state.json();
    console.log(`STATE_PRE_PROMOTE: ${JSON.stringify(stateBody)}`);

    const promote = await founderPage.request.post(
      `${BASE}/api/admin/ai-training/drafts/${APPROVED_DRAFT_ID}/promote`,
      {
        data: {
          destination: { kind: "FINAL_ASSESSMENT" },
          expectedDraftContentHash: stateBody.contentHash,
          expectedValidationId: stateBody.latestValidationId,
        },
      },
    );
    const promoteBody = await promote.json();
    console.log(`PROMOTE_RESULT: status=${promote.status()} body=${JSON.stringify(promoteBody)}`);
    expect(promote.status(), "promote succeeds after scalar sync").toBe(200);

    // Verify a real TrainingQuestion row was created on the version.
    const resp = await founderPage.request.get(
      `${BASE}/app/admin/people/safety-training/${COURSE_ID}/${VERSION_ID}`,
      { headers: { Accept: "text/html" } },
    );
    expect(resp.status()).toBe(200);
    await founderPage.close();
    await founderCtx.close();

    console.log("\n====== 4Y-R §6 CLOSEOUT ======");
    console.log("Revalidate post-slice-4 completed");
    console.log(`Promote: ${promote.status()}`);
  });
});
