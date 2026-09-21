// FPP-6D (2026-09-21) — head→card gap alignment, card-toggle
// behaviour, and symmetric close motion.
//
// The tests deliberately DO NOT approve the founder batch — the
// close behaviour is exercised via URL, X, and second-click paths,
// none of which mutate the batch.

import { test, expect } from "@playwright/test";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

test.use({ viewport: { width: 1440, height: 900 } });

const OVERVIEW_URL = "/app/admin";
const OPEN_URL = "/app/admin?workItem=cmual5x0x00087hkl20vowupf";
const CARD_TESTID = "payroll-final-approval-card-cmual5x0x00087hkl20vowupf";

test.describe("FPP-6D — gap alignment", () => {
  test("Head→first-card gap is materially equal to inter-card gap", async ({ context }) => {
    const gate = stagingCredsAvailable();
    test.skip(!gate.ready, gate.reason ?? "no creds");
    const page = await loginAsFounder(context, { landing: OVERVIEW_URL });
    await page.waitForLoadState("domcontentloaded");
    const g = await page.evaluate(() => {
      const head = document.querySelector('.spectre-mc-feed-head')?.getBoundingClientRect();
      const cards = Array.from(document.querySelectorAll('.spectre-mc-item')).slice(0, 2)
        .map((c) => c.getBoundingClientRect());
      if (!head || cards.length < 2) return null;
      return {
        headToFirst: cards[0].top - head.bottom,
        firstToSecond: cards[1].top - cards[0].bottom,
      };
    });
    expect(g).not.toBeNull();
    console.log("HEAD→CARD1:", g!.headToFirst, "CARD1→CARD2:", g!.firstToSecond);
    // Within 6px of each other — "materially equivalent visually".
    expect(Math.abs(g!.headToFirst - g!.firstToSecond)).toBeLessThanOrEqual(6);
  });
});

test.describe("FPP-6D — card toggle + close motion", () => {
  test("Clicking selected card closes preview via same canonical URL flow", async ({ context }) => {
    const gate = stagingCredsAvailable();
    test.skip(!gate.ready, gate.reason ?? "no creds");
    const page = await loginAsFounder(context, { landing: OPEN_URL });
    await page.waitForLoadState("domcontentloaded");
    await expect(page.getByTestId("payroll-approval-preview")).toBeVisible({ timeout: 15_000 });
    // Second click on the selected card.
    await page.getByTestId(CARD_TESTID).click();
    // During the exit animation the preview is still mounted with the
    // --closing modifier and data-closing="true".
    await expect(page.getByTestId("payroll-approval-preview"))
      .toHaveAttribute("data-closing", "true", { timeout: 100 });
    // After the animation window and URL replace, the preview is gone
    // and the workspace has returned to the closed state.
    await page.waitForURL((url) => !url.search.includes("workItem="), { timeout: 3_000 });
    await expect(page.getByTestId("payroll-approval-preview")).toHaveCount(0);
    await expect(page.getByTestId("mission-control-workspace"))
      .toHaveAttribute("data-preview-open", "false");
  });

  test("X close: preview animates out then URL clears", async ({ context }) => {
    const gate = stagingCredsAvailable();
    test.skip(!gate.ready, gate.reason ?? "no creds");
    const page = await loginAsFounder(context, { landing: OPEN_URL });
    await page.waitForLoadState("domcontentloaded");
    await expect(page.getByTestId("payroll-approval-preview")).toBeVisible({ timeout: 15_000 });
    await page.getByTestId("preview-close").click();
    // Same closing lifecycle.
    await expect(page.getByTestId("payroll-approval-preview"))
      .toHaveAttribute("data-closing", "true", { timeout: 100 });
    await page.waitForURL((url) => !url.search.includes("workItem="), { timeout: 3_000 });
    await expect(page.getByTestId("payroll-approval-preview")).toHaveCount(0);
  });

  test("Browser Back from open state returns cleanly to closed", async ({ context }) => {
    const gate = stagingCredsAvailable();
    test.skip(!gate.ready, gate.reason ?? "no creds");
    const page = await loginAsFounder(context, { landing: OVERVIEW_URL });
    await page.waitForLoadState("domcontentloaded");
    // Open then back.
    await page.getByTestId(CARD_TESTID).click();
    await expect(page.getByTestId("payroll-approval-preview")).toBeVisible({ timeout: 15_000 });
    await page.goBack();
    await expect(page.getByTestId("payroll-approval-preview")).toHaveCount(0);
    await expect(page.getByTestId("mission-control-workspace"))
      .toHaveAttribute("data-preview-open", "false");
  });

  test("Rapid open/close toggles do not corrupt state", async ({ context }) => {
    const gate = stagingCredsAvailable();
    test.skip(!gate.ready, gate.reason ?? "no creds");
    const page = await loginAsFounder(context, { landing: OVERVIEW_URL });
    await page.waitForLoadState("domcontentloaded");
    for (let i = 0; i < 3; i++) {
      await page.getByTestId(CARD_TESTID).click();          // open
      await expect(page.getByTestId("payroll-approval-preview")).toBeVisible({ timeout: 3_000 });
      await page.getByTestId(CARD_TESTID).click();          // close
      await page.waitForURL((url) => !url.search.includes("workItem="), { timeout: 3_000 });
    }
    // Final state: closed, exactly one card in feed, no orphaned preview.
    await expect(page.getByTestId("payroll-approval-preview")).toHaveCount(0);
    await expect(page.getByTestId(CARD_TESTID)).toHaveCount(1);
    await expect(page.getByTestId("mission-control-workspace"))
      .toHaveAttribute("data-preview-open", "false");
  });

  test("Closing state applies preview-exit animation to the pane", async ({ context }) => {
    const gate = stagingCredsAvailable();
    test.skip(!gate.ready, gate.reason ?? "no creds");
    const page = await loginAsFounder(context, { landing: OPEN_URL });
    await page.waitForLoadState("domcontentloaded");
    await expect(page.getByTestId("payroll-approval-preview")).toBeVisible({ timeout: 15_000 });
    // Trigger close and immediately probe the running animation.
    const [animName, opacity] = await Promise.all([
      page.evaluate(async () => {
        const card = document.querySelector(`[data-testid="${"payroll-final-approval-card-cmual5x0x00087hkl20vowupf"}"]`) as HTMLElement | null;
        card?.click();
        // Give the browser a beat to apply the class + start animation.
        await new Promise((r) => requestAnimationFrame(() => r(null)));
        const el = document.querySelector('[data-testid="payroll-approval-preview"]') as HTMLElement | null;
        return el ? getComputedStyle(el).animationName : "";
      }),
      page.evaluate(async () => {
        // Sample opacity mid-animation.
        await new Promise((r) => setTimeout(r, 110));
        const el = document.querySelector('[data-testid="payroll-approval-preview"]') as HTMLElement | null;
        return el ? parseFloat(getComputedStyle(el).opacity) : NaN;
      }),
    ]);
    expect(animName).toContain("spectre-mc-preview-exit");
    // Mid-animation opacity should be somewhere between 0 and 1.
    expect(opacity).toBeGreaterThan(0);
    expect(opacity).toBeLessThan(1);
  });
});
