// EP-TRAIN-5C-3C (2026-11-02) — authenticated admin helper that drives
// the real "Publish this version" dialog so publishDraftWithPolicy
// executes through the production server-action code path.
//
// Requires an authenticated founder page (loginAsFounder from
// _lib/staging-auth.ts).  The caller provides a pre-seeded DRAFT v2
// (see seedDraftV2WithCheckpoints in _lib/ep-train-5c3a-seed.ts) so
// the "Publish this version" button is already enabled on load.
//
// Why go through the UI rather than invoke the service directly:
// - The directive mandates "use the actual administrative revision
//   service"; the admin UI's server action is that service.
// - Dynamic-importing the TypeScript module in the Fly container is
//   fragile (no .ts loader + the Next.js standalone output does not
//   expose src/lib/* as resolvable paths).
// - The admin UI path exercises the real permission check, audit
//   write, posting guard, and supersession loop — exactly matching
//   what a real admin encounters when they publish a revision.

import { expect, type Page } from "@playwright/test";

const BASE =
  process.env.SPECTRE_STAGING_BASE_URL ?? "https://staging.spectreautomation.com";

/** Drive the admin publish flow for an already-authored DRAFT v2.
 *  Returns the courseVersion id (same `draftVersionId`) after the
 *  success panel appears. */
export async function publishRevisionViaAdminUI(
  page: Page,
  args: {
    courseId: string;
    draftVersionId: string;
    policy: "ALL_APPLICABLE" | "NON_COMPLETERS" | "SELECTED";
    selectedEmployeeNumbers?: string[];
  },
): Promise<void> {
  const { courseId, draftVersionId, policy, selectedEmployeeNumbers = [] } = args;

  await page.goto(
    `${BASE}/app/admin/people/safety-training/${encodeURIComponent(courseId)}/${encodeURIComponent(draftVersionId)}`,
    { waitUntil: "networkidle" },
  );

  // Open the publish dialog.
  const openBtn = page.locator('[data-testid="training-publish-revision-open"]');
  await expect(openBtn).toBeVisible({ timeout: 15_000 });
  await openBtn.click();

  const dialog = page.locator('[data-testid="training-publish-revision-dialog"]');
  await expect(dialog).toBeVisible({ timeout: 10_000 });

  // Select the policy.
  await dialog.locator(`[data-testid="training-publish-policy-${policy}"]`).click();

  if (policy === "SELECTED") {
    for (const empNum of selectedEmployeeNumbers) {
      await dialog
        .locator(`[data-testid="training-publish-select-${empNum}"]`)
        .click();
    }
  }

  // Confirm.
  await dialog.locator('[data-testid="training-publish-revision-confirm"]').click();

  // Wait for the success panel.
  await expect(
    dialog.locator('[data-testid="training-publish-revision-success"]'),
  ).toBeVisible({ timeout: 30_000 });
}
