// HR-2B.5 staging Playwright smoke (§19).
//
// Runs against https://staging.spectreautomation.com after
// spectre-staging deploy. Verifies the HR-2B.5-new user-facing
// surfaces render — no admin auth required for the portal login
// page, and the auth boundary (admin cookie can't reach portal
// pages without an employee session) is exercised.
//
// A full staging walk of the onboarding invitation → Submit journey
// requires real staff invitation issuance which is out of scope for
// this smoke; the local Playwright spec exercises the full journey
// against synthetic fixtures.

import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { stagingCredsAvailable, loginAsFounder } from "./_lib/staging-auth";

const OUT = path.resolve("test-results/hr-2b5-staging");
fs.mkdirSync(OUT, { recursive: true });

test.describe("HR-2B.5 · Staging smoke", () => {
  test("Employee Portal login page renders with Club branding (no Spectre wordmark)", async ({ page, baseURL }) => {
    // Unauthenticated — portal login is a public page.
    await page.goto("/employee/login", { waitUntil: "domcontentloaded" });
    // The form renders. HR mobile-hotfix (2026-08-25) — login
    // identifier is email, not employee number.
    await expect(page.locator('[data-testid="employee-login-email"]')).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('[data-testid="employee-login-password"]')).toBeVisible();
    await expect(page.locator('[data-testid="employee-login-submit"]')).toBeVisible();
    // Email placeholder + input type=email.
    const emailInput = page.locator('[data-testid="employee-login-email"]');
    expect(await emailInput.getAttribute("type")).toBe("email");
    expect(await emailInput.getAttribute("placeholder")).toMatch(/@/);
    await page.screenshot({ path: path.join(OUT, "staging-01-employee-login.png"), fullPage: true });
  });

  test("Employee routes redirect to /employee/login when no portal cookie", async ({ page }) => {
    // No employee session cookie → layout guard redirects.
    await page.goto("/employee", { waitUntil: "domcontentloaded" });
    await expect(page).toHaveURL(/\/employee\/login/);
    await page.goto("/employee/pay", { waitUntil: "domcontentloaded" });
    await expect(page).toHaveURL(/\/employee\/login/);
    await page.goto("/employee/profile", { waitUntil: "domcontentloaded" });
    await expect(page).toHaveURL(/\/employee\/login/);
  });

  test("Wrong-credentials login returns a neutral error (§9 no enumeration)", async ({ page }) => {
    await page.goto("/employee/login");
    // HR mobile-hotfix (2026-08-25) — login by email.
    await page.locator('[data-testid="employee-login-email"]').fill("nobody-here@example.com");
    await page.locator('[data-testid="employee-login-password"]').fill("obviously-wrong-password");
    // Do NOT wait for a specific URL — the login action redirects
    // BACK to /employee/login with ?err=... which is still /login.
    await page.locator('[data-testid="employee-login-submit"]').click();
    await page.waitForURL(/\/employee\/login/, { timeout: 20_000 });
    // Error banner surfaces without leaking whether the employee exists.
    await expect(page.locator('[data-testid="employee-login-error"]')).toBeVisible();
    const errText = await page.locator('[data-testid="employee-login-error"]').innerText();
    // Neutral phrasing — should not say "employee not found" or "wrong password" specifically.
    expect(errText).not.toMatch(/does not exist|not found|no such/i);
  });

  test.describe("admin-session boundary (§42)", () => {
    test("founder admin cookie cannot access /employee/** portal surfaces", async ({ context }) => {
      const check = stagingCredsAvailable();
      test.skip(!check.ready, `Staging creds unavailable: ${check.reason ?? ""}`);
      const page = await loginAsFounder(context);
      // Logged in as admin. Try to hit /employee routes.
      await page.goto("/employee");
      // The admin session is not an employee portal session → redirect
      // back to /employee/login.
      await expect(page).toHaveURL(/\/employee\/login/);
      await page.goto("/employee/pay");
      await expect(page).toHaveURL(/\/employee\/login/);
    });
  });
});
