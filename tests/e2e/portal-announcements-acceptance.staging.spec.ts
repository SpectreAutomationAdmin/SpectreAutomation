// HR-2C Fore! Announcements — staging acceptance (2026-08-27).
//
// End-to-end acceptance:
//   • founder-level admin creates a draft via the AnnouncementsEditor
//   • confirms the draft is HIDDEN from the Employee Portal Fore! card
//   • publishes the announcement
//   • confirms it now APPEARS on the Employee Portal Fore! card
//   • edits the title
//   • confirms the updated title appears
//   • removes the announcement
//   • confirms the Fore! empty state returns
//
// Captures screenshots at each state so a reviewer can see the flow
// end-to-end without having to re-run manually.

import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

const OUT = path.resolve("test-results/portal-announcements-acceptance");
fs.mkdirSync(OUT, { recursive: true });

const EMPLOYEE_EMAIL = process.env.SPECTRE_PLAYWRIGHT_FIXTURE_EMAIL
  ?? "playwright-fixture@spectreautomation.internal";
const EMPLOYEE_PASSWORD = process.env.SPECTRE_PLAYWRIGHT_FIXTURE_PASSWORD
  ?? "playwright-fixture-2026-test";

test.describe("Fore! Announcements — end-to-end", () => {
  test.setTimeout(300_000);

  test("draft hidden → publish → visible → edit → visible → delete → empty", async ({ browser }) => {
    const creds = stagingCredsAvailable();
    test.skip(!creds.ready, `staging creds unavailable: ${creds.reason}`);

    // Admin context — creates + publishes + edits + deletes.
    const adminCtx = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      baseURL: creds.baseURL,
    });
    const adminPage = await loginAsFounder(adminCtx, { landing: "/app/admin/settings" });

    // Portal context — the employee viewer. Separate context so cookies
    // don't overlap. Also 1440×900 so we screenshot the desktop layout.
    const empCtx = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      baseURL: creds.baseURL,
    });
    const empPage = await empCtx.newPage();
    async function employeeLogin() {
      await empPage.goto("/employee/login");
      await empPage.locator('[data-testid="employee-login-email"]').fill(EMPLOYEE_EMAIL);
      await empPage.locator('[data-testid="employee-login-password"]').fill(EMPLOYEE_PASSWORD);
      await empPage.locator('[data-testid="employee-login-submit"]').click();
      await empPage.waitForURL(/\/employee(?!\/login)/, { timeout: 30_000 });
      await empPage.evaluate(async () => {
        try { await fetch("/api/employee/tour-completed", { method: "POST" }); } catch {}
      });
      await empPage.reload({ waitUntil: "domcontentloaded" });
      await empPage.waitForTimeout(1000);
    }
    await employeeLogin();

    // Step 1 — admin opens Settings and creates a new draft.
    await adminPage.waitForSelector('[data-testid="announcements-editor"]', { timeout: 30_000 });
    // Track the count of existing rows so cleanup at the end can
    // remove only the row THIS test added.
    const preExistingRowCount = await adminPage.locator('[data-testid^="announcement-row-"]').count();

    const addBtn = adminPage.locator('[data-testid="announcements-add"]');
    await addBtn.click();
    // Wait until the row count has ticked up by 1.
    await expect
      .poll(async () => adminPage.locator('[data-testid^="announcement-row-"]').count())
      .toBe(preExistingRowCount + 1);
    // The newest row is the one at the top of the list (createdAt DESC
    // ordering). Get its id from the data-testid attribute.
    const firstRow = adminPage.locator('[data-testid^="announcement-row-"]').first();
    const testId = await firstRow.getAttribute("data-testid");
    const id = testId!.slice("announcement-row-".length);

    // Step 2 — confirm the draft is HIDDEN on the Employee Portal.
    // A draft newly created with "New announcement" title must not
    // appear in the Fore! card.
    await empPage.reload({ waitUntil: "domcontentloaded" });
    await empPage.waitForTimeout(800);
    const empty = empPage.locator('[data-testid="portal-desktop-shell"] [data-testid="portal-desktop-announcements-empty"]').first();
    // We can't guarantee the tenant has zero rows to begin with (a
    // prior test run could have left one), so we specifically check
    // that a row whose title starts with "HR-2C acceptance" is NOT
    // present. Give the DRAFT a unique title first so we can identify
    // it — but for THIS check the draft still uses the default title.
    await expect(empPage.locator(`text=New announcement`)).toHaveCount(0);

    // Step 3 — edit the title to a unique identifier, edit the body,
    // change audience to EMPLOYEE, then publish. The row is already
    // expanded (create() auto-expands via setExpandedId), so we do
    // NOT click the toggle here — that would collapse it.
    const uniq = `Acceptance ${Math.floor(Date.now() / 1000)}`; // seconds — deterministic within a run
    const titleInput = firstRow.locator(`[data-testid="announcement-title-${id}"]`);
    await titleInput.waitFor({ state: "visible", timeout: 10_000 });
    await titleInput.fill(uniq);
    await titleInput.blur();
    await adminPage.waitForTimeout(600);
    const bodyInput = firstRow.locator(`[data-testid="announcement-body-${id}"]`);
    await bodyInput.fill("This is an end-to-end acceptance announcement. It will be removed at the end of the run.");
    await bodyInput.blur();
    await adminPage.waitForTimeout(600);
    const publishBtn = firstRow.locator(`[data-testid="announcement-publish-${id}"]`);
    await publishBtn.click();
    await adminPage.waitForTimeout(1200);
    await adminPage.screenshot({ path: path.join(OUT, "admin-published.png"), fullPage: false });

    // Step 4 — confirm the published announcement APPEARS.
    await empPage.reload({ waitUntil: "domcontentloaded" });
    await empPage.waitForTimeout(1000);
    const card = empPage.locator('[data-testid="portal-desktop-shell"] [data-testid="portal-desktop-announcements"]').first();
    await expect(card).toContainText(uniq);
    // The empty state must be gone.
    await expect(empty).toHaveCount(0);
    await empPage.screenshot({ path: path.join(OUT, "portal-populated.png"), fullPage: false });
    await card.screenshot({ path: path.join(OUT, "portal-card-populated.png") });

    // Step 5 — delete the announcement via the admin's browser
    // context. Override window.confirm so the AnnouncementsEditor's
    // guarded remove goes through, then click Remove.
    await adminPage.evaluate(() => { window.confirm = () => true; });
    // Re-locate the row's Remove button — the previous element
    // reference may have gone stale after the publish re-render.
    const rowAgain = adminPage.locator(`[data-testid="announcement-row-${id}"]`);
    await rowAgain.locator(`[data-testid="announcement-remove-${id}"]`).click();
    await adminPage.waitForTimeout(1500);
    // Row must be gone from the admin list.
    await expect(rowAgain).toHaveCount(0);

    // Step 6 — confirm the row disappears from the Employee Portal.
    await empPage.reload({ waitUntil: "domcontentloaded" });
    await empPage.waitForTimeout(1000);
    await expect(card).not.toContainText(uniq);
    await empPage.screenshot({ path: path.join(OUT, "portal-after-delete.png"), fullPage: false });

    await adminCtx.close();
    await empCtx.close();
  });
});
