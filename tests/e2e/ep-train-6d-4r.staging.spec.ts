// EP-TRAIN-6D-4R — authenticated staging acceptance spec.
//
// Phase C → D → E execution. Depends on:
//   - The 4R Fly release being live on `spectre-staging`.
//   - Two synthetic identities already created (see
//     scratchpad/ep-train-6d4r/create-identities.mjs).
//   - The 4R synthetic fixture already seeded (see
//     scratchpad/ep-train-6d4r/create-fixture.mjs).
//
// Credentials for the two synthetic users must be in the environment
// as:
//   SPECTRE_4R_REVIEWER_EMAIL
//   SPECTRE_4R_REVIEWER_PASSWORD
//   SPECTRE_4R_CLUB_ADMIN_EMAIL
//   SPECTRE_4R_CLUB_ADMIN_PASSWORD
//   SPECTRE_4R_DRAFT_ID
//
// The passwords are random one-time UUIDs printed ONCE at identity
// creation; they are not recoverable afterwards and MUST NOT be
// committed. The spec skips cleanly if any of the vars is missing.
//
// Screenshots land under docs/training/ai-generation/screenshots-6d4r/.

import { expect, test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { loginAs, stagingCredsAvailable } from "./_lib/staging-auth";

const SHOT_DIR = path.join(process.cwd(), "docs/training/ai-generation/screenshots-6d4r");

function envOrSkip(name: string): string {
  const v = process.env[name];
  if (!v) {
    test.skip(true, `${name} not set — skipping`);
    return "";
  }
  return v;
}

function ensureShotDir() {
  if (!fs.existsSync(SHOT_DIR)) fs.mkdirSync(SHOT_DIR, { recursive: true });
}

test.describe("EP-TRAIN-6D-4R — staging reviewer acceptance", () => {
  test.beforeAll(() => {
    const { ready, reason } = stagingCredsAvailable();
    // We don't actually use founder creds — the loginAs helper only needs the baseURL.
    // But the readCreds() path needs SPECTRE_STAGING_BASE_URL to be defaulted,
    // which happens automatically.
    void ready;
    void reason;
    ensureShotDir();
  });

  test("CLUB_ADMIN synthetic — read workspace works, /approve POST returns 404", async ({ browser }) => {
    const email = envOrSkip("SPECTRE_4R_CLUB_ADMIN_EMAIL");
    const password = envOrSkip("SPECTRE_4R_CLUB_ADMIN_PASSWORD");
    const draftId = envOrSkip("SPECTRE_4R_DRAFT_ID");

    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await loginAs(ctx, email, password, {
      landing: `/app/admin/ai-training/review/persisted?candidate=${encodeURIComponent(draftId)}`,
    });

    // The workspace loads for a CLUB_ADMIN reader.
    await expect(page.locator("text=AI-assisted training")).toBeVisible();

    // Approve button is DISABLED (the eligibility matrix returns
    // canApprove=false for CLUB_ADMIN).
    const approveBtn = page.getByTestId("approve-candidate-button");
    await expect(approveBtn).toBeDisabled();

    // Negative test: directly POST /approve with the session cookie.
    // Playwright's page.request inherits the context's cookies, which
    // is exactly the CLUB_ADMIN session we just logged in with.
    const approveRes = await page.request.post(
      `/api/admin/ai-training/drafts/${encodeURIComponent(draftId)}/approve`,
      {
        headers: { "Content-Type": "application/json" },
        data: {
          expectedRecordVersion: 0,
          expectedContentHash: "0".repeat(64),
          expectedValidationId: "dummy",
          verifiedCorrectAnswerIndex: 0,
          evidenceAttestation: true,
          idempotencyKey: "00000000-0000-4000-8000-000000000000",
        },
      },
    );
    expect(approveRes.status()).toBe(404);
    const body = await approveRes.text();
    expect(body).toContain("not_found");

    await ctx.close();
  });

  test("Reviewer (SUPER_ADMIN club-scoped) — full approval journey + emerald chip after refresh", async ({ browser }) => {
    const email = envOrSkip("SPECTRE_4R_REVIEWER_EMAIL");
    const password = envOrSkip("SPECTRE_4R_REVIEWER_PASSWORD");
    const draftId = envOrSkip("SPECTRE_4R_DRAFT_ID");

    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await loginAs(ctx, email, password, {
      landing: `/app/admin/ai-training/review/persisted?candidate=${encodeURIComponent(draftId)}`,
    });

    // The workspace loaded for the reviewer.
    await expect(page.locator("text=AI-assisted training").first()).toBeVisible();
    // Reviewer mode notice present (not "read-only").
    await expect(page.locator("text=reviewer workspace").first()).toBeVisible();

    const approveBtn = page.getByTestId("approve-candidate-button");
    const alreadyApproved = await page.locator("text=Verified correct").first().isVisible().catch(() => false);

    if (!alreadyApproved) {
      await page.screenshot({
        path: path.join(SHOT_DIR, "1440-pre-approval.png"),
        fullPage: true,
      });

      await expect(approveBtn).toBeEnabled();
      await approveBtn.click();
      await expect(page.getByRole("dialog")).toBeVisible();

      const radios = page.getByRole("dialog").locator('input[type="radio"]');
      const rcount = await radios.count();
      for (let i = 0; i < rcount; i++) {
        expect(await radios.nth(i).isChecked()).toBe(false);
      }

      await page.screenshot({
        path: path.join(SHOT_DIR, "1440-dialog-open.png"),
        fullPage: true,
      });

      await radios.nth(1).check();
      const attestation = page.getByRole("dialog").locator('input[type="checkbox"]');
      await attestation.check();
      await page.getByRole("dialog").getByRole("button", { name: "Approve candidate" }).click();

      await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 15_000 });
    }

    // Verified-correct emerald chip renders after fresh server read.
    await expect(page.locator("text=Verified correct").first()).toBeVisible({ timeout: 15_000 });
    await expect(page.locator("text=4R Synthetic Reviewer").first()).toBeVisible();

    // After approval the trigger button is now disabled (ALREADY_VERIFIED reason).
    await expect(approveBtn).toBeDisabled();

    await page.screenshot({
      path: path.join(SHOT_DIR, "1440-post-approval.png"),
      fullPage: true,
    });

    // Mobile viewport screenshot of post-approval state.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await expect(page.locator("text=Verified correct").first()).toBeVisible({ timeout: 15_000 });
    await page.screenshot({
      path: path.join(SHOT_DIR, "390-post-approval.png"),
      fullPage: true,
    });

    await ctx.close();
  });

  test("Reviewer — historical candidate still unapproved (regression check)", async ({ browser }) => {
    const email = envOrSkip("SPECTRE_4R_REVIEWER_EMAIL");
    const password = envOrSkip("SPECTRE_4R_REVIEWER_PASSWORD");

    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await loginAs(ctx, email, password, {
      landing: "/app/admin/ai-training/review/persisted",
    });

    // Navigate directly to a known historical candidate (all 8 belong
    // to Coulee Ridge and were pre-snapshotted). The detail page MUST
    // render the 4M "Historical evidence unavailable" banner because
    // 4K's additive migration leaves their groundingProjectionId NULL.
    const historicalId = process.env.SPECTRE_4R_HISTORICAL_DRAFT_ID
      ?? "draft_hist_6c_q7-negativity-principle";
    await page.goto(
      `/app/admin/ai-training/review/persisted?candidate=${encodeURIComponent(historicalId)}`,
      { waitUntil: "domcontentloaded" },
    );
    // The workspace renders the evidence panel in two layouts
    // (hidden mobile stack + visible desktop aside). Scope to the
    // visible one by matching the specific badge class pattern on the
    // panel heading.
    await expect(
      page.locator("text=Historical evidence unavailable").locator("visible=true").first(),
    ).toBeVisible({ timeout: 15_000 });

    const approveBtn = page.getByTestId("approve-candidate-button");
    await expect(approveBtn).toBeDisabled();

    // Capture historical-state screenshot.
    await page.screenshot({
      path: path.join(SHOT_DIR, "1440-historical-unavailable.png"),
      fullPage: true,
    });

    await ctx.close();
  });
});
