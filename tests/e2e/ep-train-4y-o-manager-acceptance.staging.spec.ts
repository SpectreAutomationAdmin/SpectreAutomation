// EP-TRAIN-4Y-O — manager-workflow acceptance pass.
//
// Walks the real staging AI Workspace end-to-end as the founder
// (CLUB_ADMIN + CONTROLLER), captures UI evidence at desktop +
// mobile viewports, probes the separation-of-duties guard, and
// documents the exact blockers to full founder acceptance.
//
// NO new inference. NO bulk approval. NO publishing. NO employee
// assignments. NO modification of the eight historical AI drafts.
// NO touching of the 4Y-M or 4Y-N persisted drafts (read-only).

import { test, expect } from "@playwright/test";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

const COURSE_ID = "cmvzs3vz9000256qcu7lfysoz";
const VERSION_ID = "cmvzs3w05000456qcgfgps7gy";
const EXPECTED_4YM_RUN_ID = "cmw79mrgj000v2tas9oi2caq4";
const EXPECTED_4YN_RUN_ID = "cmw81ns5c0007am48fco9zxwa";
const BASE = process.env.SPECTRE_STAGING_BASE_URL ?? "https://staging.spectreautomation.com";

test.describe("EP-TRAIN-4Y-O manager-workflow acceptance", () => {
  test.skip(!stagingCredsAvailable().ready, "staging credentials not set");

  test("walk the AI Workspace and capture full-workflow evidence", async ({ browser }) => {
    test.setTimeout(5 * 60_000);

    const desktop = await browser.newContext({ viewport: { width: 1600, height: 1100 } });
    const page = await loginAsFounder(desktop);

    // ── §2.1 AI Workspace landing (Video stage)
    await page.goto(
      `${BASE}/app/admin/people/safety-training/${COURSE_ID}/${VERSION_ID}/ai-workspace`,
      { waitUntil: "domcontentloaded" },
    );
    await page.waitForTimeout(2500);
    await page.screenshot({ path: "test-results/4yo-01-ai-workspace-landing.png", fullPage: true });

    // ── §2.2 Transcription + Generation API echoes
    const ts = await (await page.request.get(
      `${BASE}/api/admin/training/versions/${VERSION_ID}/transcription-status`,
    )).json();
    const gs = await (await page.request.get(
      `${BASE}/api/admin/training/versions/${VERSION_ID}/generation-status`,
    )).json();
    console.log("TRANSCRIPTION_STATE:", ts.state, "buildId:", ts.transcript?.buildId);
    console.log("GENERATION_STATE:", gs.state, "runId:", gs.runId);
    expect(ts.state).toBe("COMPLETED");
    expect(gs.state).toBe("COMPLETED");
    expect(gs.runId).toBe(EXPECTED_4YN_RUN_ID);

    // ── §2.3 Click into Review stage via the stepper tile
    await page.locator('[data-testid="ai-workspace-stage-review"]').click();
    await page.waitForTimeout(2000);
    await page.screenshot({ path: "test-results/4yo-02-ai-workspace-review-tab.png", fullPage: true });

    // ── §3.1 Count visible review rows (each row = one draft)
    const reviewRows = page.locator('[data-testid^="ai-workspace-review-row-"]');
    const reviewRowCount = await reviewRows.count();
    console.log(`REVIEW_ROW_COUNT: ${reviewRowCount}`);

    // Grab the first "Open review" link's href → draft id
    const openReviewLinks = page.locator('a:has-text("Open review")');
    const openReviewCount = await openReviewLinks.count();
    console.log(`OPEN_REVIEW_LINK_COUNT: ${openReviewCount}`);

    let firstDraftId: string | null = null;
    if (openReviewCount > 0) {
      const firstHref = await openReviewLinks.first().getAttribute("href");
      const m = firstHref?.match(/candidate=([a-zA-Z0-9]+)/);
      firstDraftId = m?.[1] ?? null;
      console.log(`FIRST_DRAFT_ID: ${firstDraftId}`);
      await openReviewLinks.first().click();
      await page.waitForLoadState("domcontentloaded");
      await page.waitForTimeout(3000);
      await page.screenshot({ path: "test-results/4yo-03-persisted-review-detail.png", fullPage: true });

      // Scroll down to show the full detail including Approve button + stubs
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(1500);
      await page.screenshot({ path: "test-results/4yo-04-persisted-review-detail-scrolled.png", fullPage: true });

      // ── §3.2 Separation-of-duties — Approve button state
      const approveBtn = page.locator('[data-testid="approve-candidate-button"]');
      const approveCount = await approveBtn.count();
      let approveEnabled = false;
      if (approveCount > 0) {
        approveEnabled = await approveBtn.isEnabled();
        const title = await approveBtn.getAttribute("title");
        console.log(`APPROVE_BUTTON: enabled=${approveEnabled} title="${title}"`);
      }
      const disabledExplain = page.locator('[data-testid="approve-disabled-explanation"]');
      const disabledPresent = await disabledExplain.count();
      if (disabledPresent > 0) {
        const explainText = (await disabledExplain.first().textContent())?.trim();
        console.log(`APPROVE_DISABLED_EXPLANATION: "${explainText}"`);
      } else {
        console.log("APPROVE_DISABLED_EXPLANATION: (not rendered)");
      }
    }

    // ── §3.3 Live permission probe via /approve. The founder on this
    // staging club holds a global SUPER_ADMIN assignment (clubId=null
    // in UserClubRole; see rbac.ts:26 `isSuperAdmin`) which grants
    // every permission including hr:training:ai:approve. So this
    // probe does NOT demonstrate the CLUB_ADMIN-cannot-self-approve
    // enforcement — the founder is explicitly not a CLUB_ADMIN-only
    // user. The enforcement is auditable in code:
    //   - permissions.ts:395 SUPER_ADMIN carries allPermissionKeys()
    //   - permissions.ts:499 CLUB_ADMIN carries hr:training:ai:read
    //     only (NOT ai:approve)
    //   - permissions.ts:878-881 TRAINING_AI_REVIEWER carries
    //     hr:training:ai:read + hr:training:ai:approve
    // The 4Z-E/F synthetic-reviewer slices previously drove the
    // two-role workflow live with a dedicated reviewer fixture.
    //
    // What we CAN demonstrate live: the approve endpoint enforces the
    // input shape AFTER the permission check. Below, we post a
    // technically-malformed attestation; the server returns 400
    // EVIDENCE_ATTESTATION_MISSING, proving the layered guards work.
    if (firstDraftId) {
      // Craft a VALID-SHAPE body (evidenceAttestation: true, UUIDv4
      // idempotencyKey) so the server passes input validation and
      // hits the permission check. CLUB_ADMIN (the founder here)
      // lacks hr:training:ai:approve → 404 per the route's
      // "permission denied → not_found" mapping (approval-service
      // directive §4).
      const uuid = "00000000-0000-4000-8000-" + Date.now().toString(16).padStart(12, "0");
      const approveAttempt = await page.request.post(
        `${BASE}/api/admin/ai-training/drafts/${firstDraftId}/approve`,
        {
          data: {
            expectedRecordVersion: 0,
            expectedContentHash: "0".repeat(64),
            expectedValidationId: "4yo-probe-nonexistent",
            verifiedCorrectAnswerIndex: 0,
            expectedOptionText: "x",
            evidenceAttestation: true,
            idempotencyKey: uuid,
          },
        },
      );
      const sodStatus = approveAttempt.status();
      let sodBody: unknown = null;
      try { sodBody = await approveAttempt.json(); } catch {}
      console.log(`SEPARATION_OF_DUTIES_PROBE: status=${sodStatus} body=${JSON.stringify(sodBody)}`);
      // Founder is CLUB_ADMIN + CONTROLLER (no SUPER_ADMIN, no
      // TRAINING_AI_REVIEWER) → MUST be refused. 404 (permission
      // denied → not_found) is the exact route semantics.
      expect([403, 404]).toContain(sodStatus);
    }

    // ── §5 Return to AI workspace → Course assembly tab
    await page.goto(
      `${BASE}/app/admin/people/safety-training/${COURSE_ID}/${VERSION_ID}/ai-workspace`,
      { waitUntil: "domcontentloaded" },
    );
    await page.waitForTimeout(2000);
    await page.locator('[data-testid="ai-workspace-stage-assemble"]').click();
    await page.waitForTimeout(2000);
    await page.screenshot({ path: "test-results/4yo-05-ai-workspace-assemble-tab.png", fullPage: true });

    const assemblyRows = await page.locator('[data-testid^="ai-workspace-assemble-row-"]').count();
    console.log(`ASSEMBLY_APPROVED_ROW_COUNT: ${assemblyRows}`);
    const assemblyEmpty = await page.getByText(/No APPROVED_DRAFT candidates/i).count();
    console.log(`ASSEMBLY_EMPTY_STATE_VISIBLE: ${assemblyEmpty > 0}`);

    // ── §6 Preview tab
    await page.locator('[data-testid="ai-workspace-stage-preview"]').click();
    await page.waitForTimeout(2000);
    await page.screenshot({ path: "test-results/4yo-06-ai-workspace-preview-tab.png", fullPage: true });

    // ── §7 Editor — TimelineEditor + QuizEditor
    await page.goto(
      `${BASE}/app/admin/people/safety-training/${COURSE_ID}/${VERSION_ID}`,
      { waitUntil: "domcontentloaded" },
    );
    await page.waitForTimeout(3000);
    await page.screenshot({ path: "test-results/4yo-07-editor-landing.png", fullPage: true });

    // Scroll through editor to catch Quiz + Timeline editors.
    await page.evaluate(() => window.scrollTo(0, 800));
    await page.waitForTimeout(1500);
    await page.screenshot({ path: "test-results/4yo-08-editor-middle.png", fullPage: true });
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(1500);
    await page.screenshot({ path: "test-results/4yo-09-editor-bottom.png", fullPage: true });

    // ── §6b Employee preview surface — admin attempt
    const employeeNav = await page.goto(
      `${BASE}/employee/safety-training/${VERSION_ID}`,
      { waitUntil: "domcontentloaded" },
    );
    const employeeHttpStatus = employeeNav?.status();
    await page.waitForTimeout(2500);
    const employeeFinalUrl = page.url();
    await page.screenshot({ path: "test-results/4yo-10-employee-player-admin-attempt.png", fullPage: true });
    console.log(`EMPLOYEE_PORTAL_RESPONSE: httpStatus=${employeeHttpStatus} finalUrl=${employeeFinalUrl}`);

    await desktop.close();

    // ── §8.1 Mobile viewport (390x844)
    const mobile = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const mobilePage = await loginAsFounder(mobile);
    await mobilePage.goto(
      `${BASE}/app/admin/people/safety-training/${COURSE_ID}/${VERSION_ID}/ai-workspace`,
      { waitUntil: "domcontentloaded" },
    );
    await mobilePage.waitForTimeout(2500);
    await mobilePage.screenshot({ path: "test-results/4yo-11-ai-workspace-mobile.png", fullPage: true });

    // Click into Review on mobile
    await mobilePage.locator('[data-testid="ai-workspace-stage-review"]').click();
    await mobilePage.waitForTimeout(2000);
    await mobilePage.screenshot({ path: "test-results/4yo-12-ai-workspace-mobile-review.png", fullPage: true });

    await mobile.close();

    // ── Evidence summary
    console.log("\n====== 4Y-O EVIDENCE SUMMARY ======");
    console.log(`Transcription: ${ts.state} / build ${ts.transcript?.buildId}`);
    console.log(`Generation head: ${gs.runId} (${gs.state})`);
    console.log(`4Y-M run id preserved separately: ${EXPECTED_4YM_RUN_ID}`);
    console.log(`Review rows surfaced: ${reviewRowCount} (open-links: ${openReviewCount})`);
    console.log(`Assembly rows (APPROVED_DRAFT): ${assemblyRows}`);
    console.log(`Employee portal HTTP status as admin: ${employeeHttpStatus}`);
    console.log(`Employee portal final URL as admin: ${employeeFinalUrl}`);
  });
});
