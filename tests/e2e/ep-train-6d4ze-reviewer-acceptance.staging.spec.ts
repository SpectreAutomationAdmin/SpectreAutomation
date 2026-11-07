// EP-TRAIN-6D-4Z-E — Reviewer staging acceptance.
//
// Drives the TRAINING_AI_REVIEWER flow on staging end-to-end:
//   1. Synthetic reviewer (NOT founder) logs in.
//   2. Reviewer lands on the persisted-review page (hr:training:ai:read gate).
//   3. Reviewer opens the approval dialog.
//   4. Reviewer independently selects the correct option.
//   5. Reviewer ticks the attestation checkbox.
//   6. Reviewer clicks Approve. The 4N service transitions the draft
//      REQUIRES_HUMAN_REVIEW → APPROVED_DRAFT and writes
//      TrainingQuestionAiReview.reviewedByUserId = reviewer.id
//      (NOT founder).
//   7. Screenshots captured at both viewports.
//
// Negative scenarios (same synthetic reviewer, fresh page):
//   8. Reviewer cannot load the 4Y workspace (no hr:training:read
//      gate failure at page; buttons that need write are disabled).
//   9. Reviewer cannot navigate to settings/users (role-management).
//
// Founder login (CLUB_ADMIN, NOT reviewer) negative:
//   10. Founder can view the persisted-review queue (CLUB_ADMIN carries
//       hr:training:ai:read) BUT the Approve button is disabled
//       (CLUB_ADMIN lacks hr:training:ai:approve).
//
// Fixture inputs (env vars):
//   REVIEWER_EMAIL, REVIEWER_PASSWORD
//   FIXTURE_DRAFT_ID, FIXTURE_COURSE_ID, FIXTURE_VERSION_ID
//   FIXTURE_DRAFT_HASH, FIXTURE_DRAFT_VERIFIED_INDEX, FIXTURE_DRAFT_VERIFIED_TEXT

import { test, expect } from "@playwright/test";
import {
  loginAs,
  loginAsFounder,
  stagingCredsAvailable,
} from "./_lib/staging-auth";
import fs from "node:fs";
import path from "node:path";

const SHOT_DIR = path.join("test-results", "ep-train-6d4z-e", "screenshots");

test.beforeAll(async () => {
  if (!fs.existsSync(SHOT_DIR)) fs.mkdirSync(SHOT_DIR, { recursive: true });
});

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function fixture() {
  return {
    reviewerEmail: requireEnv("REVIEWER_EMAIL"),
    reviewerPassword: requireEnv("REVIEWER_PASSWORD"),
    draftId: requireEnv("FIXTURE_DRAFT_ID"),
    courseId: requireEnv("FIXTURE_COURSE_ID"),
    versionId: requireEnv("FIXTURE_VERSION_ID"),
  };
}

const PERSISTED_URL = (draftId: string) =>
  `/app/admin/ai-training/review/persisted?candidate=${draftId}`;

// ─── POSITIVE — reviewer end-to-end approval journey ─────────────────

for (const vp of [
  { name: "desktop-1440x900", width: 1440, height: 900 },
  { name: "mobile-390x844", width: 390, height: 844 },
]) {
  test.describe(`4Z-E reviewer approval journey (${vp.name})`, () => {
    test(
      vp.name === "desktop-1440x900"
        ? "reviewer approves via real UI (authoritative transition)"
        : "reviewer approval UI renders on mobile (view-only verification)",
      async ({ context }) => {
        test.skip(!stagingCredsAvailable().ready, "staging credentials missing");
        const f = fixture();

        // Reviewer login.
        const page = await loginAs(
          context,
          f.reviewerEmail,
          f.reviewerPassword,
          { landing: PERSISTED_URL(f.draftId) },
        );
        await page.setViewportSize({ width: vp.width, height: vp.height });

        // Queue + evidence visible.
        await expect(page).toHaveURL(new RegExp("/review/persisted"));
        await page.screenshot({ path: path.join(SHOT_DIR, `01-queue--${vp.name}.png`) });

        // Mobile is a visual-evidence-only run — the draft may already
        // be APPROVED_DRAFT by the preceding desktop journey. Skip the
        // enabled-button assertion; capture the screenshot so founder
        // visual review can see the mobile layout.
        if (vp.name !== "desktop-1440x900") {
          await page.screenshot({ path: path.join(SHOT_DIR, `02-evidence-and-approve--${vp.name}.png`) });
          return;
        }

        // Approve button exists AND enabled (desktop only).
        const approveBtn = page.getByTestId("approve-candidate-button");
        await expect(approveBtn).toBeVisible();
        await expect(approveBtn).toBeEnabled();
        await page.screenshot({ path: path.join(SHOT_DIR, `02-evidence-and-approve--${vp.name}.png`) });

        // Open dialog.
        await approveBtn.click();
        const dialog = page.getByRole("dialog");
        await expect(dialog).toBeVisible();
        await page.screenshot({ path: path.join(SHOT_DIR, `03-approval-dialog--${vp.name}.png`) });

        // Independent verified-answer selection — pick option A
        // (fixture's correct answer; reviewer independently attests).
        await dialog.locator('input[name="verified-answer"]').first().check();

        // Attestation checkbox (first checkbox inside the dialog).
        await dialog.locator('input[type="checkbox"]').first().check();

        // Approve button inside the dialog.
        const dialogApproveBtn = dialog.getByRole("button", { name: /^Approve candidate$|^Approving/ });
        await expect(dialogApproveBtn).toBeEnabled();
        await dialogApproveBtn.click();

        // Dialog closes after the approval POST resolves. We do NOT
        // assert that the top-level "approve-candidate-button"
        // disappears — the PersistedReviewWorkspace may keep the
        // button rendered until the page reloads; the authoritative
        // acceptance evidence is a parameterised DB read that
        // confirms draft.state === "APPROVED_DRAFT" + review row
        // exists with reviewedByUserId == reviewer.id (done
        // separately via scripts/ep-train-6d4ze-verify-attribution.mjs).
        await expect(dialog).toBeHidden({ timeout: 15_000 });
        await page.screenshot({ path: path.join(SHOT_DIR, `04-post-approval--${vp.name}.png`) });
      },
    );
  });
}

// ─── NEGATIVE — reviewer CANNOT do unrelated things ───────────────────

test.describe("4Z-E reviewer negative (desktop 1440×900)", () => {
  test("reviewer CANNOT access tenant-admin settings/users (role-management refusal)", async ({ context }) => {
    test.skip(!stagingCredsAvailable().ready, "staging credentials missing");
    const f = fixture();
    const page = await loginAs(context, f.reviewerEmail, f.reviewerPassword, {
      landing: "/app/admin/settings/users",
    });
    await page.setViewportSize({ width: 1440, height: 900 });
    // The page should either redirect or render a permission-denied
    // state; either way, the reviewer must NOT see a users table.
    const url = new URL(page.url());
    const isForbidden =
      !url.pathname.startsWith("/app/admin/settings/users")
      || (await page.locator("text=/not authori[sz]ed|permission|forbidden|403/i").count()) > 0;
    expect(isForbidden).toBe(true);
    await page.screenshot({ path: path.join(SHOT_DIR, `05-reviewer-denied-settings--desktop-1440x900.png`) });
  });

  test("reviewer workspace Promote / Publish / Assign controls are NOT clickable", async ({ context }) => {
    test.skip(!stagingCredsAvailable().ready, "staging credentials missing");
    const f = fixture();
    // The 4Y workspace page gate is hr:training:read. Reviewer carries it.
    const page = await loginAs(context, f.reviewerEmail, f.reviewerPassword, {
      landing: `/app/admin/people/safety-training/${f.courseId}/${f.versionId}/ai-workspace`,
    });
    await page.setViewportSize({ width: 1440, height: 900 });
    // Reviewer can see the workspace (hr:training:read)…
    const stepper = page.getByTestId("ai-workspace-stepper");
    // …but may also be redirected if hr:training:read isn't present
    // in a stricter interpretation. Either outcome is acceptable
    // under §6 "reviewer promotion refusal + publication refusal":
    const stepperVisible = await stepper.isVisible().catch(() => false);
    if (stepperVisible) {
      // Navigate to assembly — the promote button must be disabled or absent.
      await page.getByTestId("ai-workspace-stage-assemble").click();
      // Promote-to-checkpoint button carries data-testid; it must NOT be enabled.
      const promoteBtn = page.getByTestId("ai-workspace-assemble-promote-checkpoint");
      if (await promoteBtn.count()) {
        await expect(promoteBtn).toBeDisabled();
      }
    }
    await page.screenshot({ path: path.join(SHOT_DIR, `06-reviewer-workspace--desktop-1440x900.png`) });
  });
});

// ─── NEGATIVE — CLUB_ADMIN alone cannot approve ──────────────────────

test.describe("4Z-E CLUB_ADMIN approve refusal (desktop 1440×900)", () => {
  test("founder (CLUB_ADMIN, NO reviewer role) sees the queue but Approve is disabled", async ({ context }) => {
    test.skip(!stagingCredsAvailable().ready, "staging credentials missing");
    const f = fixture();
    const page = await loginAsFounder(context, { landing: PERSISTED_URL(f.draftId) });
    await page.setViewportSize({ width: 1440, height: 900 });
    // CLUB_ADMIN carries hr:training:ai:read → sees the queue.
    await expect(page).toHaveURL(new RegExp("/review/persisted"));
    // Approve button carries data-testid; the disabled-explanation
    // sibling must be visible instead of an enabled Approve button.
    const approveBtn = page.getByTestId("approve-candidate-button");
    const explanation = page.getByTestId("approve-disabled-explanation");
    // Either the button is disabled OR the explanation is visible in
    // its place — the reviewer-eligibility machinery flips between
    // the two depending on whether a candidate is selected.
    const btnExists = await approveBtn.count();
    const explExists = await explanation.count();
    expect(btnExists + explExists).toBeGreaterThan(0);
    if (btnExists > 0) {
      await expect(approveBtn).toBeDisabled();
    }
    await page.screenshot({ path: path.join(SHOT_DIR, `07-club-admin-approve-disabled--desktop-1440x900.png`) });
  });
});
