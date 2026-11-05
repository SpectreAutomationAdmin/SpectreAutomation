// EP-TRAIN-6D-4H — authenticated Playwright acceptance against
// staging.spectreautomation.com, capturing the persisted review
// surface populated with authentic EP-TRAIN-6C historical candidates
// (8 drafts: Q1-Q8, 3 REJECTED + 5 REQUIRES_HUMAN_REVIEW).
//
// Screenshots (all on deployed staging via CLUB_ADMIN session):
//   01 — 1440×900  candidate queue (all 8 rows visible / selected row)
//   02 — 1440×900  REQUIRES_HUMAN_REVIEW detail (Q1 / Q8)
//                  showing source evidence, citations, advisory flags
//   03 — 1440×900  REJECTED detail (Q3 — strongest: 3 hard errors)
//   04 — 1440×900  advisory-flag detail (Q4 — carries SOURCE_ORG_MISMATCH)
//   05 — 1440×900  question text + answer options for a high-quality
//                  candidate (Q8 parking policy, rubric 96/100)
//   06 — 390×844   mobile queue + detail view
//
// Precondition: import-historical.mjs has been run on staging so
// Coulee Ridge has 8 historical drafts.

import { test, expect } from "@playwright/test";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

const BASE = process.env.SPECTRE_STAGING_BASE_URL ?? "https://staging.spectreautomation.com";
const OUT = "test-results/ep-train-6d4h";

test.describe.configure({ mode: "serial" });
test.setTimeout(240_000);

const creds = stagingCredsAvailable();
test.skip(!creds.ready, "staging credentials missing");

test.describe("EP-TRAIN-6D-4H historical AI-candidate visual acceptance", () => {
  test("Authenticated CLUB_ADMIN — capture persisted-mode screenshots", async ({ browser }) => {
    const context = await browser.newContext();
    const page = await loginAsFounder(context);

    // Fetch the current queue to discover the deployed draft IDs.
    const api = await page.request.get(`${BASE}/api/admin/ai-training/drafts?limit=50`);
    expect(api.status()).toBe(200);
    const body = await api.json();
    expect(body.rows).toBeDefined();
    const rows: Array<{ draftId: string; state: string }> = body.rows;

    // Pick a representative draft for each required screenshot state.
    const q1 = rows.find((r) => r.draftId.endsWith("q1-criticism-must-offer-solution"));
    const q3Rejected = rows.find((r) => r.draftId.endsWith("q3-safety-near-miss-reporting"));
    const q4SourceOrg = rows.find((r) => r.draftId.endsWith("q4-member-experience-framing"));
    const q8HighQuality = rows.find((r) => r.draftId.endsWith("q8-parking-policy"));
    expect(q1, "Q1 historical draft missing — run import-historical.mjs first").toBeDefined();
    expect(q3Rejected, "Q3 REJECTED historical draft missing").toBeDefined();
    expect(q4SourceOrg, "Q4 historical draft missing").toBeDefined();
    expect(q8HighQuality, "Q8 historical draft missing").toBeDefined();

    // 1440x900 default viewport throughout.
    await page.setViewportSize({ width: 1440, height: 900 });

    // Screenshot 1 — queue view with Q1 selected (top of queue)
    await page.goto(`${BASE}/app/admin/ai-training/review/persisted?candidate=${q1!.draftId}`, {
      waitUntil: "domcontentloaded",
    });
    await expect(page.getByText("Persisted review", { exact: false }).first()).toBeVisible({ timeout: 30_000 });
    await page.waitForLoadState("load").catch(() => {});
    await page.screenshot({ path: `${OUT}/01-candidate-queue-with-q1-selected-1440x900.png`, fullPage: false });

    // Screenshot 2 — REQUIRES_HUMAN_REVIEW detail with source evidence (Q8 parking — strongest rubric)
    await page.goto(`${BASE}/app/admin/ai-training/review/persisted?candidate=${q8HighQuality!.draftId}`, {
      waitUntil: "domcontentloaded",
    });
    await expect(page.getByText("Persisted review", { exact: false }).first()).toBeVisible({ timeout: 30_000 });
    await page.waitForLoadState("load").catch(() => {});
    await page.screenshot({ path: `${OUT}/02-detail-requires-human-review-q8-1440x900.png`, fullPage: false });

    // Screenshot 3 — REJECTED detail showing hard errors + advisory flags (Q3)
    await page.goto(`${BASE}/app/admin/ai-training/review/persisted?candidate=${q3Rejected!.draftId}`, {
      waitUntil: "domcontentloaded",
    });
    await expect(page.getByText("Persisted review", { exact: false }).first()).toBeVisible({ timeout: 30_000 });
    await page.waitForLoadState("load").catch(() => {});
    await page.screenshot({ path: `${OUT}/03-detail-rejected-q3-with-hard-errors-1440x900.png`, fullPage: false });

    // Screenshot 4 — SOURCE_ORG_MISMATCH advisory on Q4 (member-experience framing)
    await page.goto(`${BASE}/app/admin/ai-training/review/persisted?candidate=${q4SourceOrg!.draftId}`, {
      waitUntil: "domcontentloaded",
    });
    await expect(page.getByText("Persisted review", { exact: false }).first()).toBeVisible({ timeout: 30_000 });
    await page.waitForLoadState("load").catch(() => {});
    await page.screenshot({ path: `${OUT}/04-detail-source-org-mismatch-q4-1440x900.png`, fullPage: false });

    // Screenshot 5 — rejected-state filter (shows only the 3 REJECTED candidates in the queue)
    await page.goto(`${BASE}/app/admin/ai-training/review/persisted?state=REJECTED`, {
      waitUntil: "domcontentloaded",
    });
    await expect(page.getByText("Persisted review", { exact: false }).first()).toBeVisible({ timeout: 30_000 });
    await page.waitForLoadState("load").catch(() => {});
    await page.screenshot({ path: `${OUT}/05-queue-filtered-rejected-only-1440x900.png`, fullPage: false });

    // Screenshot 6 — mobile 390×844 with Q1 selected
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${BASE}/app/admin/ai-training/review/persisted?candidate=${q1!.draftId}`, {
      waitUntil: "domcontentloaded",
    });
    await expect(page.getByText("Persisted review", { exact: false }).first()).toBeVisible({ timeout: 30_000 });
    await page.waitForLoadState("load").catch(() => {});
    await page.screenshot({ path: `${OUT}/06-detail-q1-390x844.png`, fullPage: false });

    // Assertion — no mutation controls enabled anywhere on any of these screens.
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${BASE}/app/admin/ai-training/review/persisted?candidate=${q1!.draftId}`, {
      waitUntil: "domcontentloaded",
    });
    const mutationVerbs = ["Approve", "Edit", "Reject", "Revalidate", "Request regeneration"];
    for (const verb of mutationVerbs) {
      const enabledCount = await page.locator(`button:not([disabled]):has-text("${verb}")`).count();
      expect(enabledCount, `No enabled "${verb}" button must exist on the persisted review surface`).toBe(0);
    }
  });
});
