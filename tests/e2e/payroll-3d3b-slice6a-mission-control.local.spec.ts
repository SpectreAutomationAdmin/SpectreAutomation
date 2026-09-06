// Payroll-3D-3B Slice 6A (2026-09-06) — local browser acceptance for
// the Mission Control PayrollActionCard.
//
// Prerequisite: run the fixture once per fresh dev DB:
//   tsx scripts/payroll-3d3b-slice6a-fixture.ts
//
// Playwright auto-starts `npm run dev` on :3000 per playwright.config.ts.
// The spec logs in as the Events Manager (correction card + scope card
// present) and the Grounds Manager (should see neither Taylor obligation)
// and captures screenshots for the checkpoint.
//
// This spec is LOCALHOST ONLY. It does not touch staging, and does
// not exercise Coulee Ridge data.

import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const OUT = path.resolve("test-results/payroll-3d3b-slice6a");
fs.mkdirSync(OUT, { recursive: true });

const EVENTS_MGR   = "slice6a.events.mgr@spectre.test";
const GROUNDS_MGR  = "slice6a.grounds.mgr@spectre.test";
const TENANT_ADMIN = "slice6a.admin@spectre.test";
const PASSWORD = "password";

async function login(page: Page, email: string) {
  await page.goto("http://localhost:3000/login");
  // Prefer the full email+password form (idempotent regardless of
  // which quick-select accounts happen to be seeded).
  await page.locator('form input[name="email"][type="email"]').fill(email);
  await page.locator('form input[name="password"]').fill(PASSWORD);
  await Promise.all([
    page.waitForURL(/\/app/, { timeout: 30_000 }),
    page.locator('form button[type="submit"]:has-text("Sign in")').click(),
  ]);
}

test.describe("Payroll-3D-3B Slice 6A · Mission Control PayrollActionCard", () => {
  test.describe.configure({ mode: "serial" });
  test.slow();

  test("Events Manager sees correction review card + blocked scope card", async ({ page }) => {
    await login(page, EVENTS_MGR);
    await page.goto("http://localhost:3000/app/admin");
    // Mission Control feed lands on /app/admin.
    await page.waitForSelector('[data-testid^="payroll-action-card-"]', { timeout: 30_000 });

    // At 1440×900 — desktop admin default.
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.screenshot({ path: path.join(OUT, "01-events-mgr-1440x900.png"), fullPage: true });

    // Correction review card visible + Approve/Reject/deep-link.
    const approve = page.locator('[data-testid="payroll-correction-approve"]').first();
    const reject  = page.locator('[data-testid="payroll-correction-reject"]').first();
    await expect(approve).toBeVisible();
    await expect(reject).toBeVisible();
    // Body content — employee + correction type + reason.
    await expect(page.locator('h3', { hasText: /Taylor/ }).first()).toBeVisible();
    await expect(page.getByText(/Correct Clock In/).first()).toBeVisible();
    await expect(page.getByText(/Rounded to top of the hour/).first()).toBeVisible();

    // Blocked scope card: NO Approve Time (a PENDING correction blocks
    // readiness). If the scope card is rendered, it must NOT expose
    // the primary approve button.
    const scopeApprove = page.locator('[data-testid="payroll-scope-approve"]');
    await expect(scopeApprove).toHaveCount(0);

    await page.screenshot({ path: path.join(OUT, "02-correction-card.png") });
  });

  test("Reject panel opens inline with Cancel + Confirm", async ({ page }) => {
    await login(page, EVENTS_MGR);
    await page.goto("http://localhost:3000/app/admin");
    await page.locator('[data-testid="payroll-correction-reject"]').first().click();
    await expect(page.locator('[data-testid="payroll-correction-reject-note"]')).toBeVisible();
    await page.locator('[data-testid="payroll-correction-reject-note"]').fill("Not warranted — reviewed with Taylor.");
    await page.screenshot({ path: path.join(OUT, "03-reject-panel-open.png"), fullPage: true });
    // Cancel closes the panel without a domain change.
    await page.locator('[data-testid="payroll-correction-reject-cancel"]').click();
    await expect(page.locator('[data-testid="payroll-correction-reject-note"]')).toHaveCount(0);
  });

  test("Grounds Manager does NOT see Taylor's Events correction / approval cards", async ({ page }) => {
    await login(page, GROUNDS_MGR);
    await page.goto("http://localhost:3000/app/admin");
    // Give the page time to load — but assert absence.
    await page.waitForLoadState("networkidle");
    const anyPayrollCard = page.locator('[data-testid^="payroll-action-card-"]');
    // Grounds may see other cards, but must NOT own any Events-worked
    // Taylor correction. The seeded Taylor correction is Events-worked,
    // so Grounds should see zero correction OR scope cards for Taylor.
    // Assert: no correction-approve action visible for Grounds.
    await expect(page.locator('[data-testid="payroll-correction-approve"]')).toHaveCount(0);
    await page.screenshot({ path: path.join(OUT, "04-grounds-mgr-empty.png"), fullPage: true });
    // Assert scope-related cards don't accidentally leak.
    const cards = await anyPayrollCard.count();
    // Grounds may have zero cards (fixture didn't seed any Grounds work).
    expect(cards).toBe(0);
  });

  test("Tenant Admin sees the fixture's config-gap surface (none — approver assigned)", async ({ page }) => {
    // In this fixture, both departments have approvers assigned, so
    // the Tenant Admin has no correction-config-gap card. We assert
    // the ABSENCE, then take a "clean" MC screenshot for the record.
    await login(page, TENANT_ADMIN);
    await page.goto("http://localhost:3000/app/admin");
    await page.waitForLoadState("networkidle");
    await expect(page.locator('[data-testid="payroll-correction-gap-remediation"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="payroll-scope-gap-remediation"]')).toHaveCount(0);
    await page.screenshot({ path: path.join(OUT, "05-tenant-admin.png"), fullPage: true });
  });

  test("Mission Control renders cleanly at 1280×800 (narrow admin laptop)", async ({ page }) => {
    await login(page, EVENTS_MGR);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("http://localhost:3000/app/admin");
    await page.waitForSelector('[data-testid^="payroll-action-card-"]', { timeout: 30_000 });
    // Assert card fits — action buttons visible on-viewport.
    await expect(page.locator('[data-testid="payroll-correction-approve"]').first()).toBeVisible();
    await expect(page.locator('[data-testid="payroll-correction-reject"]').first()).toBeVisible();
    await page.screenshot({ path: path.join(OUT, "06-events-mgr-1280x800.png"), fullPage: true });
  });

  test("Keyboard accessibility — Approve reachable via Tab, Reject panel keyboard-openable", async ({ page }) => {
    await login(page, EVENTS_MGR);
    await page.goto("http://localhost:3000/app/admin");
    await page.waitForSelector('[data-testid="payroll-correction-approve"]', { timeout: 30_000 });
    const approve = page.locator('[data-testid="payroll-correction-approve"]').first();
    await approve.focus();
    await expect(approve).toBeFocused();
    // Tab moves to Reject.
    await page.keyboard.press("Tab");
    const rejectFocus = await page.evaluate(() =>
      (document.activeElement as HTMLElement | null)?.getAttribute("data-testid") ?? null,
    );
    expect(rejectFocus).toBe("payroll-correction-reject");
    // Space activates the button.
    await page.keyboard.press("Space");
    await expect(page.locator('[data-testid="payroll-correction-reject-note"]')).toBeVisible();
  });
});
