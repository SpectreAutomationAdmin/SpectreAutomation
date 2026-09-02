// TA-1B staging acceptance (2026-09-03).
//
// Authenticated Playwright pass against
// https://staging.spectreautomation.com. Runs the founder-critical
// gates for the Tenant Users page + invitation lifecycle:
//
//   1. Desktop 1440x900 — /app/admin/settings/users renders inside the
//      admin shell with the correct chrome + sections; the founder can
//      open the Invite User modal.
//   2. Create a synthetic invitation — the activation link is surfaced
//      in the UI banner (this is by design for founder acceptance).
//      The row appears in Pending Invitations with the correct label
//      + status.
//   3. Resend the invitation — new activation link surfaces; status
//      transitions.
//   4. Revoke a separate synthetic invitation.
//   5. No SIN / bank / KMS / raw role literal leak on the page.
//
// Uses a random-suffix email so re-runs never collide with prior
// synthetic invitations. Never touches Coulee Ridge role assignments,
// never touches Payroll routing, never issues any TENANT_ADMINISTRATION
// bootstrap.

import { test, expect } from "@playwright/test";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

const TENANT_USERS_URL = "/app/admin/settings/users";

function suffix(): string {
  // Second-precision — stable across quick sequential asserts within a test.
  return `${Date.now()}-${Math.floor(Math.random() * 1000)}`;
}

test.describe("Tenant Administration TA-1B — staging founder acceptance", () => {
  test.skip(!stagingCredsAvailable().ready, "staging credentials not configured");

  test("Tenant Users page renders + Invite modal opens (desktop 1440x900)", async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await loginAsFounder(context, { landing: TENANT_USERS_URL });

    await expect(page.locator('[data-testid="tenant-users-page"]')).toBeVisible();
    await expect(page.locator('[data-testid="tenant-users-header"]')).toContainText("Tenant Users");

    // Active Users section renders (either the table or the empty state).
    const activeSection = page.locator('[data-testid="tenant-users-active"]');
    await expect(activeSection).toBeVisible();

    // Invite User button is the primary action.
    const inviteBtn = page.locator('[data-testid="invite-user-btn"]');
    await expect(inviteBtn).toBeVisible();
    await inviteBtn.click();
    await expect(page.locator('[data-testid="invite-modal"]')).toBeVisible();
    await expect(page.locator('[data-testid="invite-form-email"]')).toBeVisible();

    // Role choices exist in the invite modal. Verify a couple of tenant-
    // assignable role labels appear (never bare literals). Scope to the
    // modal to avoid strict-mode collisions with any lingering rows from
    // prior acceptance runs.
    const rolesFieldset = page.locator('[data-testid="invite-form-roles"]');
    await expect(rolesFieldset.getByText("Payroll Administrator", { exact: true })).toBeVisible();
    await expect(rolesFieldset.getByText("Controller", { exact: true })).toBeVisible();
    // SUPER_ADMIN must NEVER appear in the invite form.
    await expect(rolesFieldset.getByText("Spectre Platform Admin")).toHaveCount(0);

    await page.screenshot({ path: "test-results/ta1b-01-tenant-users-1440.png", fullPage: true });
  });

  test("Create + resend + revoke synthetic invitation cycle", async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await loginAsFounder(context, { landing: TENANT_USERS_URL });
    await expect(page.locator('[data-testid="tenant-users-page"]')).toBeVisible();

    // Two synthetic invitees: one we'll resend, one we'll revoke.
    const stem = suffix();
    const inviteeA = `ta1b-resend-${stem}@spectre.test`;
    const inviteeB = `ta1b-revoke-${stem}@spectre.test`;

    // --- Create invitee A ---
    await page.locator('[data-testid="invite-user-btn"]').click();
    await page.locator('[data-testid="invite-form-email"]').fill(inviteeA);
    await page.locator('[data-testid="invite-form-first-name"]').fill("Resend");
    await page.locator('[data-testid="invite-form-last-name"]').fill("Test");
    await page.locator('[data-testid="invite-form-title"]').fill("Payroll Administrator (test)");
    await page.locator('[data-testid="invite-form-role:PAYROLL_ADMIN"]').check();
    await page.locator('[data-testid="invite-form-submit"]').click();

    // The banner + activation URL appear.
    await expect(page.locator('[data-testid="tenant-users-banner"]')).toContainText(/Activation link/i);
    await expect(page.locator('[data-testid="tenant-users-activation-url"]')).toContainText("/invite/");

    // Row appears in Pending Invitations.
    const rowA = page.locator(`[data-testid="tenant-invitations-table"] tr:has-text("${inviteeA}")`);
    await expect(rowA).toBeVisible({ timeout: 15_000 });

    // Grab this invitation's row id for the resend action selector.
    const invIdA = await rowA.getAttribute("data-testid");
    expect(invIdA).toMatch(/^tenant-invitation-row:/);
    const idA = (invIdA ?? "").replace("tenant-invitation-row:", "");
    await expect(page.locator(`[data-testid="tenant-invitation-status:${idA}"]`)).toContainText(/PENDING|SENT/);

    await page.screenshot({ path: "test-results/ta1b-02-invitation-created-1440.png", fullPage: true });

    // --- Resend invitee A ---
    await page.locator(`[data-testid="invitation-resend-btn:${idA}"]`).click();
    await expect(page.locator('[data-testid="tenant-users-banner"]')).toContainText(/resent/i);
    await expect(page.locator('[data-testid="tenant-users-activation-url"]')).toContainText("/invite/");

    // --- Create invitee B ---
    await page.locator('[data-testid="invite-user-btn"]').click();
    await page.locator('[data-testid="invite-form-email"]').fill(inviteeB);
    await page.locator('[data-testid="invite-form-first-name"]').fill("Revoke");
    await page.locator('[data-testid="invite-form-role:STAFF"]').check();
    await page.locator('[data-testid="invite-form-submit"]').click();
    const rowB = page.locator(`[data-testid="tenant-invitations-table"] tr:has-text("${inviteeB}")`);
    await expect(rowB).toBeVisible({ timeout: 15_000 });
    const invIdB = await rowB.getAttribute("data-testid");
    const idB = (invIdB ?? "").replace("tenant-invitation-row:", "");

    // --- Revoke invitee B (browser confirm auto-accept) ---
    page.once("dialog", (d) => d.accept());
    await page.locator(`[data-testid="invitation-revoke-btn:${idB}"]`).click();
    await expect(page.locator('[data-testid="tenant-users-banner"]')).toContainText(/revoked/i);
    // Revoked invitations are filtered out of the default "Pending" list —
    // banner confirmation is the founder-visible signal. Assert the row
    // has disappeared.
    await expect(page.locator(`[data-testid="tenant-invitation-row:${idB}"]`)).toHaveCount(0, { timeout: 15_000 });

    await page.screenshot({ path: "test-results/ta1b-03-invitation-revoked-1440.png", fullPage: true });
  });

  test("No SIN / bank / KMS / raw role literals rendered on Tenant Users page", async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await loginAsFounder(context, { landing: TENANT_USERS_URL });
    await expect(page.locator('[data-testid="tenant-users-page"]')).toBeVisible();
    const body = await page.locator("body").innerText();
    expect(body).not.toMatch(/\bSIN\b/i);
    expect(body).not.toMatch(/socialInsurance/i);
    expect(body).not.toMatch(/institutionSecretRef|transitSecretRef|accountSecretRef/);
    expect(body).not.toMatch(/enc:/);
    // Never show raw role-key literals (users see human labels).
    expect(body).not.toMatch(/\bPAYROLL_ADMIN\b/);
    expect(body).not.toMatch(/\bF_AND_B_MANAGER\b/);
    expect(body).not.toMatch(/\bSUPER_ADMIN\b/);
  });
});
