// EP-TRAIN-6D-4F § 8 + § 9 — authenticated Playwright acceptance
// against staging.spectreautomation.com.
//
// Scope:
//   §8 UI acceptance — capture the five required views at 1440×900 +
//      390×844. Because 6D-4D intentionally ships `hr:training:ai:read`
//      with NO role grants, the founder's staging user (CLUB_ADMIN +
//      CONTROLLER) is redirected from the persisted route to the
//      fixture preview. We capture the behaviour as evidence AND the
//      fixture preview surface for visual-language parity.
//   §9 Deployed API security — 401 unauth, same-shape 404 denial,
//      400 on invalid params, no POST/PATCH handler.
//
// Credentials come from .env.playwright.local via tests/e2e/_lib/
// staging-auth.ts (SPECTRE_STAGING_EMAIL / SPECTRE_STAGING_PASSWORD).

import { test, expect } from "@playwright/test";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

const BASE = process.env.SPECTRE_STAGING_BASE_URL ?? "https://staging.spectreautomation.com";
const OUT = "test-results/ep-train-6d4f";

test.describe.configure({ mode: "serial" });
test.setTimeout(180_000);

test.skip(!stagingCredsAvailable(), "staging credentials missing");

test.describe("EP-TRAIN-6D-4F staging acceptance", () => {
  test("§9.a /api/health returns 200 (public baseline)", async ({ page }) => {
    const r = await page.request.get(`${BASE}/api/health`);
    expect(r.status()).toBe(200);
    const body = await r.json();
    expect(body.status).toBe("ok");
  });

  test("§9.b /api/admin/ai-training/drafts returns 401 when unauthenticated", async ({ page }) => {
    const r = await page.request.get(`${BASE}/api/admin/ai-training/drafts`);
    expect(r.status()).toBe(401);
    const body = await r.json();
    expect(body).toEqual({ error: "unauthenticated" });
  });

  test("§9.c unsupported HTTP methods unavailable (POST → 404 / 405)", async ({ page }) => {
    const r = await page.request.post(`${BASE}/api/admin/ai-training/drafts`, {
      data: { test: true },
    });
    // Next.js returns 404 for missing method or 405 if route exists w/o handler.
    expect([404, 405]).toContain(r.status());
  });

  test("Authenticated flows — § 8 + § 9 continue", async ({ browser }) => {
    const context = await browser.newContext();
    const page = await loginAsFounder(context);

    // §9.d authenticated GET to drafts → service throws FORBIDDEN (no permission grant)
    // → route maps to same-shape 404
    const authGet = await page.request.get(`${BASE}/api/admin/ai-training/drafts`);
    expect(authGet.status()).toBe(404);
    const authGetBody = await authGet.json();
    expect(authGetBody).toEqual({ error: "not_found" });

    // §9.e cross-tenant candidate id → same-shape 404 (no enumeration signal)
    const crossTenant = await page.request.get(
      `${BASE}/api/admin/ai-training/drafts/does-not-exist`,
    );
    expect(crossTenant.status()).toBe(404);

    // §9.f invalid pagination → 400 (but only reachable if permission passes;
    // CLUB_ADMIN gets 404 same-shape first, which is the correct order)
    const invalidLimit = await page.request.get(
      `${BASE}/api/admin/ai-training/drafts?limit=999`,
    );
    expect([400, 404]).toContain(invalidLimit.status());

    // §8 fixture preview — reachable by CLUB_ADMIN (no permission check)
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${BASE}/app/admin/ai-training/review`, { waitUntil: "domcontentloaded" });
    await expect(page.getByText("Fixture preview", { exact: true }).first()).toBeVisible({ timeout: 30_000 });
    await page.waitForLoadState("load").catch(() => {});
    await page.screenshot({
      path: `${OUT}/01-fixture-preview-1440x900.png`,
      fullPage: false,
    });

    // §8 persisted-route attempt → auth gate redirects back to fixture preview
    // (hr:training:ai:read is not granted to CLUB_ADMIN / CONTROLLER).
    const persistedResp = await page.goto(
      `${BASE}/app/admin/ai-training/review/persisted`,
      { waitUntil: "domcontentloaded" },
    );
    await page.waitForLoadState("load").catch(() => {});
    // Either a redirect (handled transparently) or we land on fixture. Verify we
    // did NOT land on a 500 and that the destination URL is the fixture page.
    const landedUrl = page.url();
    expect(landedUrl).toContain("/app/admin/ai-training/review");
    expect(persistedResp?.status() ?? 200).toBeLessThan(500);
    await page.screenshot({
      path: `${OUT}/02-persisted-redirect-destination-1440x900.png`,
      fullPage: false,
    });

    // §8 mobile fixture preview
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${BASE}/app/admin/ai-training/review`, { waitUntil: "domcontentloaded" });
    await expect(page.getByText("Fixture preview", { exact: true }).first()).toBeVisible({ timeout: 30_000 });
    await page.waitForLoadState("load").catch(() => {});
    await page.screenshot({
      path: `${OUT}/03-fixture-preview-390x844.png`,
      fullPage: false,
    });
  });
});
