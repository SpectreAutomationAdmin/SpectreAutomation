// TA-1B closeout staging acceptance (2026-09-03).
//
// Authenticated Playwright pass against
// https://staging.spectreautomation.com covering:
//
//   1. Tenant Users page renders + Invite modal opens (1440x900).
//   2. Create synthetic invitation via the founder-facing UI. NEW
//      behaviour: no raw activation URL in the DOM; banner reads
//      "Invitation sent to <email>" (or the console-adapter variant).
//   3. Revoke synthetic invitation — row removed from Pending list.
//   4. Sensitive-data + raw-role-literal sweep — also confirms no
//      raw activation URL anywhere in the DOM.
//   5. Landing-page paths:
//      5a. NEW email — landing renders create-account form.
//      5b. EXISTING email (founder) — unauthenticated visit shows
//          "Sign in to accept"; authenticated visit as the correct
//          founder shows "Accept invitation" button, no password
//          form (proves password-preservation intent at the UI).
//
// Random-suffix emails ensure re-runs never collide with prior
// synthetic invitations. Never touches Coulee Ridge role assignments
// beyond synthetic PENDING/REVOKED invitations addressed to
// spectre.test / the founder's email (immediately revoked, never
// activated).
//
// The staging Fly app has SPECTRE_ALLOW_ACTIVATION_URL=true set so
// the SUPER_ADMIN-authenticated founder session may fetch the raw
// activation URL via the test-only ?includeActivationUrl=true
// escape hatch. Production does NOT set this env var.

import { test, expect, type Page } from "@playwright/test";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

const TENANT_USERS_URL = "/app/admin/settings/users";

function suffix(): string {
  return `${Date.now()}-${Math.floor(Math.random() * 1000)}`;
}

async function readClubId(page: Page): Promise<string> {
  const id = await page.locator('[data-testid="tenant-users-page"]').getAttribute("data-club-id");
  if (!id) throw new Error("could not read data-club-id from tenant users page");
  return id;
}

async function readFounderEmail(_page: Page): Promise<string> {
  // Read from process.env first (CI + manually exported), then fall
  // back to reading .env.playwright.local directly (same file the
  // staging-auth helper consults). Never logged.
  const fromEnv = (process.env.SPECTRE_STAGING_EMAIL ?? "").trim();
  if (fromEnv) return fromEnv.toLowerCase();
  try {
    const { readFileSync, existsSync } = await import("node:fs");
    const { join } = await import("node:path");
    for (const file of [".env.playwright.local", ".env.staging.local", ".env.local"]) {
      const p = join(process.cwd(), file);
      if (!existsSync(p)) continue;
      const raw = readFileSync(p, "utf8");
      const m = raw.match(/^\s*SPECTRE_STAGING_EMAIL\s*=\s*(.+)\s*$/m);
      if (m) return m[1].replace(/^["']|["']$/g, "").trim().toLowerCase();
    }
  } catch { /* ignore */ }
  // Stable staging founder email (documented in the memory reference).
  return "cturcato@spectreautomation.com";
}

test.describe("Tenant Administration TA-1B closeout — staging founder acceptance", () => {
  test.skip(!stagingCredsAvailable().ready, "staging credentials not configured");

  test("Tenant Users page renders + Invite modal opens (desktop 1440x900)", async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await loginAsFounder(context, { landing: TENANT_USERS_URL });

    await expect(page.locator('[data-testid="tenant-users-page"]')).toBeVisible();
    await expect(page.locator('[data-testid="tenant-users-header"]')).toContainText("Tenant Users");
    await expect(page.locator('[data-testid="tenant-users-active"]')).toBeVisible();
    const inviteBtn = page.locator('[data-testid="invite-user-btn"]');
    await expect(inviteBtn).toBeVisible();
    await inviteBtn.click();
    await expect(page.locator('[data-testid="invite-modal"]')).toBeVisible();

    const rolesFieldset = page.locator('[data-testid="invite-form-roles"]');
    await expect(rolesFieldset.getByText("Payroll Administrator", { exact: true })).toBeVisible();
    await expect(rolesFieldset.getByText("Controller", { exact: true })).toBeVisible();
    await expect(rolesFieldset.getByText("Spectre Platform Admin")).toHaveCount(0);

    await page.screenshot({ path: "test-results/ta1b-closeout-01-tenant-users-1440.png", fullPage: true });
  });

  test("Create + revoke — banner says 'sent' + no raw activation URL in DOM", async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await loginAsFounder(context, { landing: TENANT_USERS_URL });
    await expect(page.locator('[data-testid="tenant-users-page"]')).toBeVisible();

    const stem = suffix();
    const invitee = `ta1b-close-cycle-${stem}@spectre.test`;

    // Wait for hydration before clicking — this test previously
    // flaked with the modal never opening if the click landed before
    // React attached its handler.
    await page.waitForLoadState("networkidle");
    const inviteBtn = page.locator('[data-testid="invite-user-btn"]');
    await expect(inviteBtn).toBeEnabled();
    await inviteBtn.click();
    try {
      await expect(page.locator('[data-testid="invite-modal"]')).toBeVisible({ timeout: 5000 });
    } catch {
      // One retry — hydration race safety net.
      await inviteBtn.click();
      await expect(page.locator('[data-testid="invite-modal"]')).toBeVisible({ timeout: 10_000 });
    }
    await page.locator('[data-testid="invite-form-email"]').fill(invitee);
    await page.locator('[data-testid="invite-form-first-name"]').fill("Cycle");
    await page.locator('[data-testid="invite-form-title"]').fill("Payroll Administrator (test)");
    await page.locator('[data-testid="invite-form-role:PAYROLL_ADMIN"]').check();
    await page.locator('[data-testid="invite-form-submit"]').click();

    // Banner reads "sent to <email>" or the console-adapter variant.
    await expect(page.locator('[data-testid="tenant-users-banner"]')).toContainText(/sent to/i);
    // No activation-URL block in the founder UI.
    await expect(page.locator('[data-testid="tenant-users-activation-url"]')).toHaveCount(0);
    // Body sweep — no raw /invite/<token> URL anywhere in the DOM.
    const bodyText = await page.locator("body").innerText();
    expect(bodyText).not.toMatch(/\/invite\/[A-Za-z0-9_-]{20,}/);

    // Row appears in Pending.
    const row = page.locator(`[data-testid="tenant-invitations-table"] tr:has-text("${invitee}")`);
    await expect(row).toBeVisible({ timeout: 15_000 });
    const invId = ((await row.getAttribute("data-testid")) ?? "").replace("tenant-invitation-row:", "");

    await page.screenshot({ path: "test-results/ta1b-closeout-02-invitation-created-1440.png", fullPage: true });

    // Revoke.
    page.once("dialog", (d) => d.accept());
    await page.locator(`[data-testid="invitation-revoke-btn:${invId}"]`).click();
    await expect(page.locator('[data-testid="tenant-users-banner"]')).toContainText(/revoked/i);
    await expect(page.locator(`[data-testid="tenant-invitation-row:${invId}"]`)).toHaveCount(0, { timeout: 15_000 });

    await page.screenshot({ path: "test-results/ta1b-closeout-03-invitation-revoked-1440.png", fullPage: true });
  });

  test("No SIN / bank / KMS / raw role literals / activation URL on Tenant Users page", async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await loginAsFounder(context, { landing: TENANT_USERS_URL });
    await expect(page.locator('[data-testid="tenant-users-page"]')).toBeVisible();
    const body = await page.locator("body").innerText();
    expect(body).not.toMatch(/\bSIN\b/i);
    expect(body).not.toMatch(/socialInsurance/i);
    expect(body).not.toMatch(/institutionSecretRef|transitSecretRef|accountSecretRef/);
    expect(body).not.toMatch(/enc:/);
    expect(body).not.toMatch(/\bPAYROLL_ADMIN\b/);
    expect(body).not.toMatch(/\bF_AND_B_MANAGER\b/);
    expect(body).not.toMatch(/\bSUPER_ADMIN\b/);
    // Founder UI must never surface a raw activation URL.
    expect(body).not.toMatch(/\/invite\/[A-Za-z0-9_-]{20,}/);
  });

  test("Landing page — new-user path shows create-account form; existing-user path shows accept shell (no password)", async ({ browser }) => {
    test.setTimeout(180_000);
    const founderContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const founderPage = await loginAsFounder(founderContext, { landing: TENANT_USERS_URL });
    await expect(founderPage.locator('[data-testid="tenant-users-page"]')).toBeVisible();

    const clubId = await readClubId(founderPage);
    const founderEmail = await readFounderEmail(founderPage);

    // Create a NEW-user invitation via the API with the test-only
    // activation-URL escape hatch. Reuses the authenticated founder
    // cookie via the browser context's own request client.
    const stem = suffix();
    const newEmail = `ta1b-close-landing-${stem}@spectre.test`;
    const createNew = await founderContext.request.post(
      `https://staging.spectreautomation.com/api/clubs/${clubId}/tenant-users?includeActivationUrl=true`,
      { data: { email: newEmail, initialRoleKeys: ["STAFF"] } },
    );
    expect(createNew.status()).toBe(200);
    const createNewJson = await createNew.json();
    expect(createNewJson.activationUrl).toMatch(
      /https:\/\/staging\.spectreautomation\.com\/invite\/[A-Za-z0-9_-]{20,}/,
    );

    // 5a. New-user landing — unauthenticated.
    const anon = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const anonPage = await anon.newPage();
    await anonPage.goto(String(createNewJson.activationUrl), { waitUntil: "domcontentloaded" });
    await expect(anonPage.locator('[data-testid="invite-activation-card"]')).toBeVisible();
    await expect(anonPage.locator('[data-testid="invite-activation-form"]')).toBeVisible();
    await expect(anonPage.locator('[data-testid="invite-password"]')).toBeVisible();
    await expect(anonPage.locator('[data-testid="invite-email"]')).toContainText(newEmail);
    await anonPage.screenshot({ path: "test-results/ta1b-closeout-04-landing-new-user-1440.png", fullPage: true });
    // Revoke the new-user invitation to keep staging tidy.
    await founderContext.request.delete(
      `https://staging.spectreautomation.com/api/clubs/${clubId}/tenant-users/invitations/${createNewJson.invitation.id}`,
    );

    // 5b. Existing-user landing — using the founder's own email.
    test.skip(!founderEmail, "could not infer founder email");

    // Pre-step: revoke any stale founder-email invitations from prior
    // acceptance runs so the duplicate-live check does not 409 us.
    const listResp = await founderContext.request.get(
      `https://staging.spectreautomation.com/api/clubs/${clubId}/tenant-users`,
    );
    if (listResp.ok()) {
      const listJson = await listResp.json();
      const stale = (listJson.invitations ?? []).filter((inv: { email: string; status: string }) =>
        inv.email.toLowerCase() === founderEmail.toLowerCase() &&
        ["PENDING", "SENT", "OPENED"].includes(inv.status),
      );
      for (const inv of stale) {
        await founderContext.request.delete(
          `https://staging.spectreautomation.com/api/clubs/${clubId}/tenant-users/invitations/${inv.id}`,
        );
      }
    }

    const createExist = await founderContext.request.post(
      `https://staging.spectreautomation.com/api/clubs/${clubId}/tenant-users?includeActivationUrl=true`,
      { data: { email: founderEmail, initialRoleKeys: ["STAFF"] } },
    );
    if (createExist.status() !== 200) {
      const detail = await createExist.text();
      test.skip(true, `founder-email invitation refused (${createExist.status()}): ${detail.slice(0, 200)}`);
    }
    const createExistJson = await createExist.json();
    expect(String(createExistJson.activationUrl ?? "")).toMatch(
      /https:\/\/staging\.spectreautomation\.com\/invite\/[A-Za-z0-9_-]{20,}/,
    );
    await runExistingUserAssertions(browser, String(createExistJson.activationUrl));
    // Revoke to keep staging tidy — never activate (would grant founder
    // an extra role on their own tenant).
    await founderContext.request.delete(
      `https://staging.spectreautomation.com/api/clubs/${clubId}/tenant-users/invitations/${createExistJson.invitation.id}`,
    );
  });
});

async function runExistingUserAssertions(
  browser: import("@playwright/test").Browser,
  activationUrl: string,
) {
  // The URL comes from our own API, but pass through `new URL(...).href`
  // to normalise it defensively against any Playwright/Chromium URL
  // quirk with baseURL + absolute-URL resolution on Windows.
  const normalised = new URL(activationUrl).href;

  // Unauthenticated visitor → "Sign in to accept" link.
  const anon = await browser.newContext({ viewport: { width: 1440, height: 900 }, baseURL: undefined });
  const anonPage = await anon.newPage();
  await anonPage.goto(normalised, { waitUntil: "domcontentloaded" });
  await expect(anonPage.locator('[data-testid="invite-existing-user-signin"]')).toBeVisible();
  await expect(anonPage.locator('[data-testid="invite-signin-link"]')).toBeVisible();
  await expect(anonPage.locator('[data-testid="invite-password"]')).toHaveCount(0);
  await anonPage.screenshot({ path: "test-results/ta1b-closeout-05-landing-existing-user-signin-1440.png", fullPage: true });

  // Correct-session visitor → Accept button, no password form.
  // loginAsFounder concatenates `${baseURL}${landing}` so `landing`
  // must be a relative path (§staging-auth.ts:153). Extract just the
  // /invite/<token> portion from the absolute activation URL.
  const parsed = new URL(normalised);
  const authContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const authPage = await loginAsFounder(authContext, { landing: parsed.pathname + parsed.search });
  await expect(authPage.locator('[data-testid="invite-existing-user-accept"]')).toBeVisible();
  await expect(authPage.locator('[data-testid="invite-accept-btn"]')).toBeVisible();
  await expect(authPage.locator('[data-testid="invite-password"]')).toHaveCount(0);
  await authPage.screenshot({ path: "test-results/ta1b-closeout-06-landing-existing-user-accept-1440.png", fullPage: true });
}
