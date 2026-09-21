// FPP-7 (2026-09-21) — SoD identity correction browser acceptance.
//
// FPP-7 finding: the staging Playwright helper's SPECTRE_STAGING_EMAIL
// credentials belong to Chris Turcato (cturcato@spectreautomation.com,
// user id cmrvdenz700034437agp7gqs5), not Marc. That means every
// FPP-6 acceptance test that appeared to authenticate "as the founder"
// was in fact authenticating as the Controller.
//
// This spec accepts that reality and verifies the CHRIS SESSION:
//   • Header identity resolves as Chris Turcato.
//   • Mission Control feed DOES contain the Controller approval card
//     (ownerUserId = Chris).
//   • Opening the preview keeps Approve ENABLED (Chris ≠ submitter),
//     the self-submitter hint is NOT rendered.
//   • The preview still binds to the exact frozen submitted evidence
//     (regression against FPP-6).
//
// The Marc session (visible header identity "Marc Maldiney", feed NOT
// containing the card, preview URL-hack disabling Approve) requires
// c.s.turcato@gmail.com credentials. Those live with the founder and
// are not captured in this repo. The founder will complete Marc-side
// verification manually.

import { test, expect } from "@playwright/test";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

const OVERVIEW_URL = "/app/admin";
const OPEN_URL = "/app/admin?workItem=cmual5x0x00087hkl20vowupf";

test.use({ viewport: { width: 1440, height: 900 } });

test.describe("FPP-7 SoD — Chris (Controller) session", () => {
  test("Header identity resolves as Chris Turcato", async ({ context }) => {
    const gate = stagingCredsAvailable();
    test.skip(!gate.ready, gate.reason ?? "no creds");
    const page = await loginAsFounder(context, { landing: OVERVIEW_URL });
    await page.waitForLoadState("domcontentloaded");
    const acctBtn = page.getByRole("button", { name: /account menu/i }).first();
    await expect(acctBtn).toBeVisible();
    const label = (await acctBtn.getAttribute("aria-label")) ?? "";
    expect(label).toMatch(/Chris\s+Turcato/i);
    await page.screenshot({ path: "test-results/fpp7-chris-header.png", fullPage: false });
  });

  test("Mission Control feed shows Chris the Controller approval card", async ({ context }) => {
    const gate = stagingCredsAvailable();
    test.skip(!gate.ready, gate.reason ?? "no creds");
    const page = await loginAsFounder(context, { landing: OVERVIEW_URL });
    await page.waitForLoadState("domcontentloaded");
    await expect(page.getByTestId("payroll-final-approval-card-cmual5x0x00087hkl20vowupf"))
      .toBeVisible({ timeout: 15_000 });
  });

  test("Chris preview: Approve is ENABLED (Chris ≠ submitter); self-hint not shown", async ({ context }) => {
    const gate = stagingCredsAvailable();
    test.skip(!gate.ready, gate.reason ?? "no creds");
    const page = await loginAsFounder(context, { landing: OPEN_URL });
    await page.waitForLoadState("domcontentloaded");
    await expect(page.getByTestId("payroll-approval-preview")).toBeVisible({ timeout: 15_000 });
    const approve = page.getByTestId("preview-approve");
    await expect(approve).toBeVisible();
    await expect(approve).toBeEnabled();
    // Self-submitter hint MUST NOT render for Chris.
    await expect(page.getByTestId("preview-not-actionable")).toHaveCount(0);
    // FPP-6 regression: frozen totals still bind.
    const summary = page.getByTestId("preview-summary");
    await expect(summary).toContainText("$4,620.83");
    await expect(summary).toContainText("$3,037.33");
    await expect(summary).toContainText("$639.96");
    await page.screenshot({ path: "test-results/fpp7-chris-preview-1440x900.png", fullPage: false });
    // Explicitly DO NOT click Approve — the founder completes that
    // action personally on the accepted staging batch.
  });

  test("FPP-6 layout regression: workspace opens with data-preview-open=true", async ({ context }) => {
    const gate = stagingCredsAvailable();
    test.skip(!gate.ready, gate.reason ?? "no creds");
    const page = await loginAsFounder(context, { landing: OPEN_URL });
    await page.waitForLoadState("domcontentloaded");
    await expect(page.getByTestId("mission-control-workspace"))
      .toHaveAttribute("data-preview-open", "true");
    // Rail + KPI still visible.
    await expect(page.getByRole("complementary", { name: /Executive rail/i })).toBeVisible();
  });
});
