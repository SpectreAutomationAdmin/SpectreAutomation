// AUTH-3D.RBAC.FIX post-deploy visual acceptance capture.
//
// Founder Controller identity signs into Marc's Employee Profile on
// live staging (image sha-03e281beb6e0). Verifies the two new
// sections ARE visible, and that Delete/Archive lifecycle controls
// remain HIDDEN (canLifecycle gate unchanged).

import { test, expect } from "@playwright/test";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

const MARC_EMPLOYEE_ID = "cmu0ndf4p001vk9md2ntmo2ck";

test.describe("AUTH-3D.RBAC.FIX · Controller staging visual", () => {
  test.setTimeout(180_000);

  test("Controller sees Portal password + Portal access; does NOT see Delete/Archive", async ({ browser }) => {
    const avail = stagingCredsAvailable();
    test.skip(!avail.ready, avail.reason ?? "no staging creds");

    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await loginAsFounder(ctx);

    await page.goto(`${avail.baseURL}/app/admin/people/employees/${MARC_EMPLOYEE_ID}`, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });

    // Portal password section must now be visible.
    const portalPassword = page.locator('[data-testid="portal-reset-admin-section"]');
    await portalPassword.waitFor({ timeout: 20_000 });
    await portalPassword.scrollIntoViewIfNeeded();
    await page.waitForTimeout(400);
    await portalPassword.screenshot({ path: "test-results/auth3drbac-controller-portal-password.png" });

    // Portal access section must be visible.
    const portalAccess = page.locator('[data-testid="portal-signout-admin-section"]');
    await portalAccess.waitFor({ timeout: 20_000 });
    await portalAccess.scrollIntoViewIfNeeded();
    await page.waitForTimeout(400);
    await portalAccess.screenshot({ path: "test-results/auth3drbac-controller-portal-access.png" });

    // Confirmation state on the sign-out button.
    await page.getByTestId("portal-signout-everywhere-open").click();
    await page.waitForTimeout(300);
    await portalAccess.screenshot({ path: "test-results/auth3drbac-controller-portal-access-confirm.png" });

    // Delete/Archive (canLifecycle) MUST NOT be present for Controller.
    // These controls live inside EmployeeLifecycleControls; the tests
    // there use data-testids that don't render at all when canLifecycle
    // is false. Assert none of them are present in the DOM.
    const lifecycleControls = page.locator('[data-testid="lifecycle-archive-btn"], [data-testid="lifecycle-delete-btn"], button:has-text("Archive"), button:has-text("Terminate")');
    expect(await lifecycleControls.count()).toBe(0);

    // Capture the fuller Overview panel so the founder can see the
    // whole section stack in context (header + Portal password +
    // Portal access + absence of Delete/Archive).
    const overviewMain = page.locator("main").first();
    await overviewMain.screenshot({ path: "test-results/auth3drbac-controller-overview-1440.png" });

    await ctx.close();
  });
});
