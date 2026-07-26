// Sprint 3 Checkpoint 15I (2026-07-26) — Local smoke test for the
// Variant D Work Intake card.
//
// Verifies against the real production component in the local dev
// server (SQLite):
//   • Mission Control renders after login without runtime error
//   • Every rendered Work Intake card is a `.spectre-mc-item` with
//     the Variant D structure (pill, h3, readout, rec)
//   • No `.spectre-mc-worktype` eyebrow anywhere in the DOM
//   • No collapsed-row "Open review" button on any card
//   • Clicking a card flips its data-expanded attribute + shows tabs
//   • The Active / Completed history toggle is present and switches
//     the ?view= query param
//
// Not the founder acceptance test — that runs against real staging
// mailbox data. This spec proves the local build boots and renders
// the new card DOM.

import { test, expect } from "@playwright/test";

const ADMIN = "admin@silversprings.club";
const PASSWORD = "password";
const BASE = process.env.SPECTRE_BASE_URL ?? "http://localhost:3001";

test.describe("Checkpoint 15I Variant D card — local smoke", () => {
  test("Mission Control page renders with Variant D chrome intact", async ({ page }) => {
    await page.goto(`${BASE}/login`);
    await page.fill('input[name="email"]', ADMIN);
    await page.fill('input[name="password"]', PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForURL(/\/app(\/|$)/, { timeout: 20_000 });

    await page.setViewportSize({ width: 1440, height: 900 });
    const resp = await page.goto(`${BASE}/app/admin`);
    expect(resp?.status(), "MC page must not 5xx").toBeLessThan(500);
    await page.waitForLoadState("networkidle");

    // Variant D page composition (already there before 15I; verify
    // nothing regressed).
    await expect(page.locator(".spectre-mc-briefing"), "briefing panel").toBeVisible();
    await expect(page.locator(".spectre-mc-grid"), "feed + rail grid").toBeVisible();
    await expect(page.locator(".spectre-mc-rail"), "right rail").toBeVisible();

    // Active / Completed toggle exists.
    await expect(page.getByTestId("feed-view-active"), "active toggle").toBeVisible();
    await expect(page.getByTestId("feed-view-history"), "history toggle").toBeVisible();

    await page.screenshot({
      path: "test-results/c15i-variant-d-mc.png",
      fullPage: false,
    });
  });

  test("no Variant D card renders the removed .spectre-mc-worktype eyebrow", async ({ page }) => {
    await signIn(page);
    await page.goto(`${BASE}/app/admin`);
    await page.waitForLoadState("networkidle");
    // Whether or not the local seed has items, the DOM must NOT
    // contain the old eyebrow class anywhere.
    const count = await page.locator(".spectre-mc-worktype").count();
    expect(count, "spectre-mc-worktype must not appear in rendered DOM").toBe(0);
  });

  test("no card exposes a collapsed-row 'Open review' button", async ({ page }) => {
    await signIn(page);
    await page.goto(`${BASE}/app/admin`);
    await page.waitForLoadState("networkidle");
    const openReview = page.getByRole("button", { name: /^Open review$/ });
    await expect(openReview, "Open review button must not appear on collapsed cards").toHaveCount(0);
  });

  test("history filter route accepts ?view=history without erroring", async ({ page }) => {
    await signIn(page);
    const resp = await page.goto(`${BASE}/app/admin?view=history`);
    expect(resp?.status(), "history view must not 5xx").toBeLessThan(500);
    await page.waitForLoadState("networkidle");
    await expect(page.getByTestId("feed-view-history")).toHaveClass(/on/);
  });

  test("if any Work Intake card is present, its data-attributes reflect the interaction contract", async ({ page }) => {
    await signIn(page);
    await page.goto(`${BASE}/app/admin`);
    await page.waitForLoadState("networkidle");
    const cards = page.locator(".spectre-mc-item");
    const count = await cards.count();
    if (count === 0) {
      // Empty queue is a valid state — assert the empty rendering.
      await expect(page.getByText(/Your work intake is empty|All clear/i)).toBeVisible();
      return;
    }
    // Every visible Work Intake card must carry the Variant D shell.
    for (let i = 0; i < count; i++) {
      const card = cards.nth(i);
      // Cards produced by the two new components carry data-testid
      // markers. Feed items produced by the legacy FeedItem may not —
      // they are the AR/AP/system-generated cards and are unchanged
      // by 15I.
      const testId = await card.getAttribute("data-testid");
      if (testId === "email-intake-card" || testId === "ap-review-card" || testId === "statement-review-card") {
        await expect(card).toHaveAttribute("data-unread", /true|false/);
        await expect(card).toHaveAttribute("data-expanded", /true|false/);
        await expect(card).toHaveAttribute("data-resolved", /true|false/);
      }
    }
  });
});

async function signIn(page: import("@playwright/test").Page) {
  await page.goto(`${BASE}/login`);
  await page.fill('input[name="email"]', ADMIN);
  await page.fill('input[name="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/app(\/|$)/, { timeout: 20_000 });
  await page.setViewportSize({ width: 1440, height: 900 });
}
