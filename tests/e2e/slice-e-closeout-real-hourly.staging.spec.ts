// Slice E closeout (2026-09-19) §7-9 — real hourly zero-hours browser
// flow on v436 staging. Uses the synthetic slice-c-benefits-test tenant
// (with the SliceE HourlyZeroHours employee from --payroll-ready).

import { test, expect } from "@playwright/test";
import { loginAs, stagingCredsAvailable } from "./_lib/staging-auth";

const VIEWPORT = { width: 1440, height: 900 };
const FIXTURE_ADMIN_EMAIL = "slice-c-benefits-test-admin@fixture.spectre.test";
const FIXTURE_ADMIN_PASSWORD =
  process.env.SPECTRE_FIXTURE_ADMIN_PASSWORD ?? "SliceC-Benefits-Fixture-2026!";

test.describe("Slice E closeout — real hourly zero-hours screenshots", () => {
  test.beforeAll(() => {
    const { ready, reason } = stagingCredsAvailable();
    test.skip(!ready, reason ?? "staging creds unavailable");
  });

  test("12 · Real BLOCKER surface + 13 · Ack form open with reason filled", async ({ context }) => {
    const page = await loginAs(context, FIXTURE_ADMIN_EMAIL, FIXTURE_ADMIN_PASSWORD, { landing: "/app/admin" });
    await page.setViewportSize(VIEWPORT);

    // Prepare an hourly-only pay period → NO_APPROVED_HOURS_FOR_HOURLY
    // fires. Register page then renders the PREPARED gate + ack panel.
    const res = await page.request.post("/api/dev/slice-e-hourly-prepare?clubSlug=slice-c-benefits-test&seq=20");
    if (!res.ok()) throw new Error(`hourly-prepare failed: ${res.status()} ${await res.text()}`);
    const j = (await res.json()) as { batchId: string; registerUrl: string };

    await page.goto(j.registerUrl, { waitUntil: "domcontentloaded" });
    // Either the PREPARED gate testid or the register-page testid must
    // land. Both include the ack panel.
    const gate = page.getByTestId("payroll-register-prepared-gate");
    const registerPage = page.getByTestId("payroll-register-page");
    await Promise.race([
      gate.waitFor({ state: "visible", timeout: 20_000 }).catch(() => {}),
      registerPage.waitFor({ state: "visible", timeout: 20_000 }).catch(() => {}),
    ]);
    // The ack panel MUST be visible with the hourly employee.
    await expect(page.getByTestId("zero-hours-ack-panel")).toBeVisible({ timeout: 15_000 });
    const card = page.locator('[data-testid^="zero-hours-ack-card-"]').first();
    await expect(card).toBeVisible();
    await expect(card).toContainText(/HourlyZeroHours/);
    await expect(card.locator('[data-testid^="zero-hours-blocker-badge-"]')).toBeVisible();

    // 12 · Real BLOCKER surface — Ack panel + blocker badge + employee
    // identity + explanation.
    await page.screenshot({ path: "test-results/slice-e/12-zero-hours-blocker-real.png", fullPage: true });

    // 13 · Ack form with reason picker exercised. Pick
    // "Seasonal — inactive but still employed" instead of the default
    // so the shot visibly differs from 12 and demonstrates the picker
    // interaction.
    const cardId = (await card.getAttribute("data-testid"))!.replace("zero-hours-ack-card-", "");
    const reasonRadio = page.getByTestId(`zero-hours-reason-seasonal_inactive-${cardId}`);
    await reasonRadio.check();
    await reasonRadio.scrollIntoViewIfNeeded();
    await page.screenshot({ path: "test-results/slice-e/13-zero-hours-ack-form-filled.png", fullPage: true });

    // Optional: actually submit to prove the resolved state also works.
    // Skipped here to keep the shot deterministic — the resolved state
    // is proven end-to-end by the Slice E closeout vitest.
  });
});
