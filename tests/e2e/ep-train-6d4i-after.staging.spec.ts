// EP-TRAIN-6D-4I — "after" screenshots following the reviewer-first
// UX refinement. Uses the same candidates as the 6D-4I "before" spec
// so the acceptance doc can show direct side-by-side diffs:
//   Q8 (REQUIRES_HUMAN_REVIEW, 1 flag) — strongest-rubric candidate
//   Q6 (REJECTED, 2 hard errors)        — subject-attribution defect
//   Q3 (REJECTED, 3 hard errors + 2 flags) — strongest defect case
//   mobile Q8 @ 390×844
//
// Also opens the collapsible technical-provenance <details> on Q8 so
// the founder can confirm the fixture-placeholder callout renders
// honestly.

import { test, expect } from "@playwright/test";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

const BASE = process.env.SPECTRE_STAGING_BASE_URL ?? "https://staging.spectreautomation.com";
const OUT = "test-results/ep-train-6d4i/after";

test.describe.configure({ mode: "serial" });
test.setTimeout(240_000);

const creds = stagingCredsAvailable();
test.skip(!creds.ready, "staging credentials missing");

test.describe("EP-TRAIN-6D-4I — AFTER screenshots + read-only assertions", () => {
  test("Q8/Q6/Q3 @ 1440, mobile Q8 @ 390, provenance-open Q8", async ({ browser }) => {
    const context = await browser.newContext();
    const page = await loginAsFounder(context);

    await page.setViewportSize({ width: 1440, height: 900 });

    for (const [label, draftIdSuffix] of [
      ["q8", "q8-parking-policy"],
      ["q6", "q6-phone-call-discretion-back-room"],
      ["q3", "q3-safety-near-miss-reporting"],
    ] as const) {
      const draftId = `draft_hist_6c_${draftIdSuffix}`;
      await page.goto(`${BASE}/app/admin/ai-training/review/persisted?candidate=${draftId}`, {
        waitUntil: "domcontentloaded",
      });
      await expect(page.getByText("Persisted review", { exact: false }).first()).toBeVisible({ timeout: 30_000 });
      await page.waitForLoadState("load").catch(() => {});
      await page.screenshot({ path: `${OUT}/${label}-after-1440x900.png`, fullPage: false });
    }

    // Q8 with the technical-provenance <details> open so the
    // fixture-placeholder callout is visible in the screenshot.
    // We open the <details> via the DOM directly (robust against
    // off-screen / sticky-aside positioning that defeats the auto-
    // scroll on a plain click).
    await page.goto(
      `${BASE}/app/admin/ai-training/review/persisted?candidate=draft_hist_6c_q8-parking-policy`,
      { waitUntil: "domcontentloaded" },
    );
    await expect(page.getByText("Persisted review", { exact: false }).first()).toBeVisible({ timeout: 30_000 });
    await page.waitForLoadState("load").catch(() => {});
    await page.evaluate(() => {
      const details = Array.from(document.querySelectorAll("details"));
      for (const d of details) {
        if ((d.textContent ?? "").includes("Technical provenance")) {
          (d as HTMLDetailsElement).open = true;
        }
      }
    });
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${OUT}/q8-after-provenance-open-1440x900.png`, fullPage: true });

    // Mobile Q8
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(
      `${BASE}/app/admin/ai-training/review/persisted?candidate=draft_hist_6c_q8-parking-policy`,
      { waitUntil: "domcontentloaded" },
    );
    await expect(page.getByText("Persisted review", { exact: false }).first()).toBeVisible({ timeout: 30_000 });
    await page.waitForLoadState("load").catch(() => {});
    await page.screenshot({ path: `${OUT}/mobile-q8-after-390x844.png`, fullPage: false });

    // Read-only invariant — unchanged from 6D-4G/6D-4H. Re-assert.
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(
      `${BASE}/app/admin/ai-training/review/persisted?candidate=draft_hist_6c_q8-parking-policy`,
      { waitUntil: "domcontentloaded" },
    );
    const mutationVerbs = ["Approve", "Edit", "Reject", "Revalidate", "Request regeneration"];
    for (const verb of mutationVerbs) {
      const enabledCount = await page.locator(`button:not([disabled]):has-text("${verb}")`).count();
      expect(enabledCount, `No enabled "${verb}" button must exist`).toBe(0);
    }

    // Evidence-fidelity assertions — the new UI must contain these
    // honest strings (the schema-gap callouts).
    // Scope to visible matches only — the component renders the
    // evidence panel twice (lg:hidden mobile + hidden lg:block desktop),
    // so bare `getByText()` returns both. On a 1440 viewport the mobile
    // one is CSS-hidden; we want the visible desktop aside.
    await expect(
      page.locator("aside").getByText("Transcript body", { exact: false }),
    ).toBeVisible();
    await expect(
      page.locator("aside").getByText("Not persisted on the AI-review schema in this slice", { exact: false }),
    ).toBeVisible();
    await expect(
      page.locator("aside").getByText("Timestamps per cited segment are not persisted", { exact: false }),
    ).toBeVisible();

    // Tenant isolation smoke — the 8 historical drafts are still visible
    // on this CLUB_ADMIN session, same shape as 6D-4H.
    const apiCheck = await page.request.get(`${BASE}/api/admin/ai-training/drafts?limit=50`);
    expect(apiCheck.status()).toBe(200);
    const body = await apiCheck.json();
    expect(Array.isArray(body.rows)).toBe(true);
    expect(body.rows.length).toBe(8);
  });
});
