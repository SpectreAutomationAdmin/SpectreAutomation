// AUTH-3C — visual capture on localhost.
//
// Sign in via demo shortcut on http://localhost:3000, then capture:
//   1. Employee profile Access panel with the new control at rest.
//   2. Employee confirmation state (after click).
//   3. Tenant Users list with the new per-row control.
//   4. Tenant User confirmation state (after click).
//
// The dev server exposes the `super@spectre.app / password` demo
// account on the platform host, which is a SUPER_ADMIN — the same
// level of authority a founder-facing local review uses.

import { test } from "@playwright/test";

const BASE = process.env.SPECTRE_LOCAL_BASE_URL ?? "http://localhost:3000";

async function loginDemo(browser: import("@playwright/test").Browser) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
  // Use the "Spectre Super Admin" demo shortcut — its server action
  // hardcodes password="password" and bypasses the visible form's
  // credential collection entirely.
  const superForm = page
    .locator('form')
    .filter({ hasText: "Spectre Super Admin" })
    .first();
  await Promise.all([
    page.waitForURL((u) => u.pathname.startsWith("/app/"), { timeout: 30_000 }),
    superForm.locator('button[type="submit"]').first().click(),
  ]);
  return { ctx, page };
}

test.describe("AUTH-3C · visual capture", () => {
  test.setTimeout(180_000);

  test("Employee profile: rest + confirmation states", async ({ browser }) => {
    const { ctx, page } = await loginDemo(browser);

    // Navigate directly to the seeded AUTH-3C demo employee.
    const DEMO_EMPLOYEE_ID = "cmuhy09oi0001l0lqivirmkxk"; // Marc Demo
    await page.goto(`${BASE}/app/admin/people/employees/${DEMO_EMPLOYEE_ID}`, {
      waitUntil: "domcontentloaded",
    });

    // The profile page renders Overview by default. Scroll to the new
    // "Portal access" section.
    const section = page.locator('[data-testid="portal-signout-admin-section"]');
    await section.waitFor({ timeout: 15_000 });
    await section.scrollIntoViewIfNeeded();
    await page.waitForTimeout(400);
    await section.screenshot({ path: "test-results/auth3c-employee-profile-rest.png" });

    // Click into confirmation.
    await page.getByTestId("portal-signout-everywhere-open").click();
    await page.waitForTimeout(200);
    await section.screenshot({ path: "test-results/auth3c-employee-profile-confirm.png" });

    await ctx.close();
  });

  test("Tenant Users: rest + confirmation states", async ({ browser }) => {
    const { ctx, page } = await loginDemo(browser);

    await page.goto(`${BASE}/app/admin/settings/users`, { waitUntil: "domcontentloaded" });
    await page.locator('[data-testid^="tenant-user-row:"]').first().waitFor({ timeout: 15_000 });

    // Capture the People section (list scoped by the People tab).
    const peopleSection = page.locator('[data-testid="tenant-users-active"]');
    await peopleSection.scrollIntoViewIfNeeded();
    await page.waitForTimeout(400);
    await peopleSection.screenshot({ path: "test-results/auth3c-tenant-users-rest.png" });

    // Open confirmation on the first row (avoiding self-revocation
    // because we're signed in as super@spectre.app and would like a
    // deterministic second-person confirmation copy on the capture).
    const openButtons = page.locator('[data-testid^="tenant-user-signout-open:"]');
    // Prefer a non-self target: any row whose data-is-self ancestor is
    // "false". Fallback: the first available open button.
    const nonSelfRow = page.locator('[data-testid^="tenant-user-signout:"][data-is-self="false"]').first();
    let clicked = false;
    if (await nonSelfRow.count()) {
      await nonSelfRow.locator('[data-testid^="tenant-user-signout-open:"]').first().click();
      clicked = true;
    } else {
      await openButtons.first().click();
      clicked = true;
    }
    if (!clicked) throw new Error("no signout open button found on Tenant Users");
    await page.waitForTimeout(300);
    await peopleSection.screenshot({ path: "test-results/auth3c-tenant-users-confirm.png" });

    await ctx.close();
  });
});
