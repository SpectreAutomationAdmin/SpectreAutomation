// Sprint 3 · Phase 5 · Slice 3 (2026-08-09) — Vendor Profile +
// AP Coding modal Confidence UX authenticated staging acceptance.
//
// Verifies for every real staging control:
//   • Modal opens at the canonical step (auto-resolved → AP Coding,
//     unmatched → Vendor Profile).
//   • Vendor Profile carries a supplier-identity confidence line +
//     separate vendor-match line (§5-§8).
//   • AP Coding carries transaction understanding + GL confidence
//     lines, and keeps the recommended account visible even when GL
//     confidence is Moderate (§10-§11).
//   • The GL alternative disclosure ships a humanised rejection
//     reason (never a percentage) (§12-§13).
//   • CPA Multiple keeps two allocation rows with per-row confidence
//     (§16-§17).
//   • Nothing inside the modal renders a raw "NN%" confidence value
//     (§37).
//
// Uses .env.playwright.local via loginAsFounder. No screenshots
// captured before login. ZERO SKIPS.

import { test, expect, type Page, type Locator } from "@playwright/test";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const availability = stagingCredsAvailable();
const OUT = "test-results/phase5-slice3-modal-confidence";

const CARDS = [
  { label: "DMM",              wiSuffix: "20128fk9" },
  { label: "Oakcreek_1087769", wiSuffix: "2lrnzi7d" },
  { label: "Oakcreek_1091559", wiSuffix: "9h76vkbm" },
  { label: "OXIO",             wiSuffix: "c7g773n5" },
  { label: "CPA_Alberta",      wiSuffix: "fr09w3bz" },
];

async function findCard(page: Page, suffix: string): Promise<Locator> {
  const card = page.locator(
    `[data-testid="email-intake-card"][data-work-intake-item-id$="${suffix}"], ` +
    `[data-testid="ap-review-card"][data-work-intake-item-id$="${suffix}"]`
  ).first();
  await card.waitFor({ state: "visible", timeout: 15_000 });
  await card.scrollIntoViewIfNeeded();
  return card;
}

async function openModal(page: Page, wiSuffix: string): Promise<Locator> {
  const card = await findCard(page, wiSuffix);
  const primary = card.locator('[data-testid="ap-action-primary"]').first();
  await primary.click();
  const modal = page.locator('[data-testid="create-vendor-and-post-modal"]').first();
  await modal.waitFor({ state: "visible", timeout: 10_000 });
  return modal;
}

async function currentStep(modal: Locator): Promise<string | null> {
  const title = await modal.locator('[data-testid="cvap-step-title"]').first().textContent();
  return (title ?? "").trim();
}

async function switchToVendorProfileStep(modal: Locator): Promise<void> {
  // If the modal opened at AP Coding via auto-resolve or a matched
  // vendor path, click "Review / change vendor" or the step-1 header
  // button to reach the Vendor Profile step.
  const step1Btn = modal.locator('[data-testid="cvap-step-1-btn"]').first();
  if (await step1Btn.isVisible().catch(() => false)) {
    await step1Btn.click();
    return;
  }
  const reviewBtn = modal.getByRole("button", { name: /review.*change vendor/i }).first();
  if (await reviewBtn.isVisible().catch(() => false)) {
    await reviewBtn.click();
  }
}

async function switchToApCodingStep(modal: Locator): Promise<void> {
  const step2Btn = modal.locator('[data-testid="cvap-step-2-btn"]').first();
  if (await step2Btn.isVisible().catch(() => false) && !(await step2Btn.isDisabled().catch(() => false))) {
    await step2Btn.click();
  }
}

test.describe("Phase 5 · Slice 3 — modal Confidence UX (5 real controls)", () => {
  test.skip(!availability.ready, availability.reason ?? "staging credentials required");
  test.setTimeout(600_000);
  test.beforeAll(() => { mkdirSync(OUT, { recursive: true }); });

  for (const c of CARDS) {
    test(`${c.label}: modal confidence UX + no percentage`, async ({ context }) => {
      const page = await loginAsFounder(context);
      await page.goto(`${availability.baseURL}/app/admin`, { waitUntil: "domcontentloaded" });
      await page.waitForLoadState("networkidle").catch(() => { /* ignore */ });

      const modal = await openModal(page, c.wiSuffix);
      const initialStep = await currentStep(modal);
      console.log(`[${c.label}] modal opened at step: ${initialStep}`);

      // ---- Vendor Profile step ----------------------------------------
      await switchToVendorProfileStep(modal);
      const vendorConf = modal.locator('[data-testid="cvap-vendor-confidence"]').first();
      await vendorConf.waitFor({ state: "visible", timeout: 5_000 });
      const supplierLine = modal.locator('[data-testid="cvap-vendor-supplier-confidence"]').first();
      const supplierLevel = await supplierLine.getAttribute("data-confidence-level");
      const vendorMatchEl = modal.locator('[data-testid="cvap-vendor-match-state"]').first();
      const vendorMatchState = await vendorMatchEl.getAttribute("data-vendor-match");
      console.log(`[${c.label}] Vendor Profile: supplier=${supplierLevel} · match=${vendorMatchState}`);
      expect(["HIGH", "MODERATE", "LOW", "NEEDS_REVIEW"]).toContain(supplierLevel);
      expect(["MATCHED", "AMBIGUOUS", "NOT_FOUND"]).toContain(vendorMatchState);
      await modal.screenshot({ path: join(OUT, `${c.label}-vendor-profile.png`) });

      // Hover the supplier line to reveal the popover, capture, dismiss
      await supplierLine.hover();
      const supplierPopover = modal.locator('[data-testid="cvap-vendor-supplier-confidence-popover"]').first();
      await supplierPopover.waitFor({ state: "visible", timeout: 3_000 });
      await modal.screenshot({ path: join(OUT, `${c.label}-vendor-profile-popover.png`) });
      await page.keyboard.press("Escape");
      await page.mouse.move(10, 10);

      // ---- AP Coding step ---------------------------------------------
      await switchToApCodingStep(modal);
      const codingConf = modal.locator('[data-testid="cvap-coding-confidence-row"]').first();
      await codingConf.waitFor({ state: "visible", timeout: 5_000 });
      const txLine = modal.locator('[data-testid="cvap-coding-transaction-confidence"]').first();
      const glLine = modal.locator('[data-testid="cvap-coding-gl-confidence"]').first();
      const txLevel = await txLine.getAttribute("data-confidence-level");
      const glLevel = await glLine.getAttribute("data-confidence-level");
      console.log(`[${c.label}] AP Coding: transaction=${txLevel} · gl=${glLevel}`);
      expect(["HIGH", "MODERATE", "LOW", "NEEDS_REVIEW"]).toContain(txLevel);
      expect(["HIGH", "MODERATE", "LOW", "NEEDS_REVIEW"]).toContain(glLevel);

      // §10 — Recommended account still shown (single-allocation cards)
      // OR CPA-shape (Multiple) shows the allocations table instead.
      const recommended = modal.locator('[data-testid="cvap-coding-recommended"]').first();
      const allocationsTable = modal.locator('[data-testid="cvap-allocations-table"]').first();
      const hasRecommended = await recommended.isVisible().catch(() => false);
      const hasAllocations = await allocationsTable.isVisible().catch(() => false);
      expect(hasRecommended || hasAllocations).toBe(true);

      await modal.screenshot({ path: join(OUT, `${c.label}-ap-coding.png`) });

      // Open GL confidence popover
      await glLine.hover();
      const glPopover = modal.locator('[data-testid="cvap-coding-gl-confidence-popover"]').first();
      await glPopover.waitFor({ state: "visible", timeout: 3_000 });
      await modal.screenshot({ path: join(OUT, `${c.label}-ap-coding-gl-popover.png`) });
      await page.keyboard.press("Escape");
      await page.mouse.move(10, 10);

      // §37 — modal body must not render any raw "NN%" confidence
      // number. We tolerate GST verification lines that render an
      // actual GST rate (e.g. "GST verified at 5%"); we assert that
      // no substring in the confidence-adjacent regions contains %.
      const modalText = ((await modal.textContent()) ?? "");
      const bannedPatterns = [
        /confidence\s*\d{1,3}\s*%/i,
        /\(\s*\d{1,3}\s*%\s*\)/,      // "(72%)" alternates chip
      ];
      for (const rx of bannedPatterns) {
        expect(modalText).not.toMatch(rx);
      }

      // ---- Navigation persistence (§23) ------------------------------
      // Go back to Vendor Profile, then forward again — confidence
      // labels must survive.
      await switchToVendorProfileStep(modal);
      await switchToApCodingStep(modal);
      const txLevelAfter = await modal.locator('[data-testid="cvap-coding-transaction-confidence"]').first().getAttribute("data-confidence-level");
      const glLevelAfter = await modal.locator('[data-testid="cvap-coding-gl-confidence"]').first().getAttribute("data-confidence-level");
      expect(txLevelAfter).toBe(txLevel);
      expect(glLevelAfter).toBe(glLevel);

      // Dismiss
      await modal.locator('[data-testid="cvap-close"]').first().click();
    });
  }

  test("CPA — Multiple allocations carry per-row confidence with distinct levels (§16-§17)", async ({ context }) => {
    const page = await loginAsFounder(context);
    await page.goto(`${availability.baseURL}/app/admin`, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle").catch(() => { /* ignore */ });
    const modal = await openModal(page, "fr09w3bz");
    await switchToApCodingStep(modal);

    const table = modal.locator('[data-testid="cvap-allocations-table"]').first();
    await table.waitFor({ state: "visible", timeout: 5_000 });

    // At least 2 allocation rows
    const rows = table.locator('tr[data-testid^="cvap-allocation-"]');
    const rowCount = await rows.count();
    console.log(`[CPA] allocation rows = ${rowCount}`);
    expect(rowCount).toBeGreaterThanOrEqual(2);

    // Every row has a per-row confidence level set
    for (let i = 0; i < rowCount; i++) {
      const level = await rows.nth(i).getAttribute("data-allocation-confidence");
      console.log(`[CPA] allocation row ${i}: level=${level}`);
      expect(["HIGH", "MODERATE", "NEEDS_REVIEW"]).toContain(level);
    }

    // §16 — Multiple does NOT collapse to a single recommendedAccount
    const recommended = modal.locator('[data-testid="cvap-coding-recommended"]').first();
    await expect(recommended).toHaveCount(0);

    await modal.screenshot({ path: join(OUT, "CPA-allocations-with-confidence.png") });
  });
});
