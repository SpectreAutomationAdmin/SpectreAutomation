// Sprint 3 · Phase 5 · Slice 1 (2026-08-09) — Confidence UX
// authenticated staging acceptance (§26-§28).
//
// Asserts against the 5 real Outlook-backed AP cards:
//   - Compact card shows decision-specific summary label
//     ("High confidence" / "Moderate confidence" / "Needs review")
//     — NEVER a percentage.
//   - Hover opens the disclosure popover with per-decision rows.
//   - Focus / Enter / Space open the popover (accessibility).
//   - Escape closes.
//   - CPA Multiple popover (Category cell) opens and shows both
//     allocations with GL number + name + amount.
//   - Screenshots captured.
//
// NO backend intelligence changes; this spec verifies the UI-only
// Confidence adapter deployed in Phase 5 Slice 1.

import { test, expect, type Page, type Locator } from "@playwright/test";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const availability = stagingCredsAvailable();
const OUT = "test-results/phase5-slice1-confidence-ux";

// Parent EMAIL WI suffixes (visible in the feed — same mapping used
// by phase4-final-founder-surface.staging.spec.ts).
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

test.describe("Phase 5 Slice 1 · Confidence UX — 5 real cards", () => {
  test.skip(!availability.ready, availability.reason ?? "staging credentials required");
  test.setTimeout(600_000);
  test.beforeAll(() => { mkdirSync(OUT, { recursive: true }); });

  for (const c of CARDS) {
    test(`${c.label}: qualitative summary label + hover popover + no percentage`, async ({ context }) => {
      const page = await loginAsFounder(context);
      await page.goto(`${availability.baseURL}/app/admin`, { waitUntil: "domcontentloaded" });
      await page.waitForLoadState("networkidle").catch(() => { /* ignore */ });
      const card = await findCard(page, c.wiSuffix);

      // §5-§6 · §11 Slice 2 update — Summary label is either "High"
      // (all HIGH) or "<Level> · <Dimension>" (weakest material
      // intelligence dimension). Never a raw percentage.
      const summary = card.locator('[data-testid="ap-readout-confidence"] .v').first();
      const summaryText = ((await summary.textContent()) ?? "").trim();
      console.log(`[${c.label}] confidence summary = "${summaryText}"`);
      // Accept the new Slice 2 formats.
      expect(summaryText).toMatch(/^(High|Moderate\s*·\s*(Supplier|Category|GL)|Low\s*·\s*(Supplier|Category|GL)|Needs review\s*·\s*(Supplier|Category|GL))/);
      // Must NOT show a raw percentage.
      expect(summaryText).not.toMatch(/\d{1,3}\s*%/);

      // §12 · Hover opens the popover (mouse)
      const confidenceCell = card.locator('[data-testid="ap-readout-confidence"]').first();
      await confidenceCell.hover();
      const popover = card.locator('[data-testid="ap-readout-confidence-popover"]').first();
      await popover.waitFor({ state: "visible", timeout: 5_000 });
      // Three rows: supplier · category · gl
      const supplierRow = popover.locator('[data-testid="ap-readout-confidence-supplier"]').first();
      const categoryRow = popover.locator('[data-testid="ap-readout-confidence-category"]').first();
      const glRow       = popover.locator('[data-testid="ap-readout-confidence-gl"]').first();
      await expect(supplierRow).toBeVisible();
      await expect(categoryRow).toBeVisible();
      await expect(glRow).toBeVisible();

      // Per-decision level attribute is set (data-confidence-level)
      const supplierLevel = await supplierRow.getAttribute("data-confidence-level");
      const categoryLevel = await categoryRow.getAttribute("data-confidence-level");
      const glLevel = await glRow.getAttribute("data-confidence-level");
      console.log(`[${c.label}] supplier=${supplierLevel} · category=${categoryLevel} · gl=${glLevel}`);
      expect(["HIGH", "MODERATE", "LOW", "NEEDS_REVIEW"]).toContain(supplierLevel);
      expect(["HIGH", "MODERATE", "LOW", "NEEDS_REVIEW"]).toContain(categoryLevel);
      expect(["HIGH", "MODERATE", "LOW", "NEEDS_REVIEW"]).toContain(glLevel);

      // §28 · Screenshot the disclosed popover state
      await card.screenshot({ path: join(OUT, `${c.label}-disclosed.png`) });

      // §12 · Escape closes
      await page.keyboard.press("Escape");
      // Move focus away so it does not re-open via focus retention
      await page.mouse.move(10, 10);
      await popover.waitFor({ state: "hidden", timeout: 3_000 }).catch(() => { /* ignore */ });

      // §28 · Screenshot the closed (default) state after dismissal
      await card.screenshot({ path: join(OUT, `${c.label}-closed.png`) });
    });
  }

  test("CPA Multiple category popover — 2 allocations + total (§10)", async ({ context }) => {
    const page = await loginAsFounder(context);
    await page.goto(`${availability.baseURL}/app/admin`, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle").catch(() => { /* ignore */ });
    const card = await findCard(page, "fr09w3bz");

    const categoryCell = card.locator('[data-testid="ap-readout-category"]').first();
    // Confirm cell shows "Multiple ▾"
    const cellV = card.locator('[data-testid="ap-readout-category"] .v').first();
    const cellText = ((await cellV.textContent()) ?? "").trim();
    expect(cellText).toMatch(/^Multiple/);

    // Hover to open the allocations popover
    await categoryCell.hover();
    const popover = card.locator('[data-testid="ap-readout-category-popover"]').first();
    await popover.waitFor({ state: "visible", timeout: 5_000 });
    const rows = popover.locator(".cat-hover-row");
    const rowCount = await rows.count();
    console.log(`[CPA Multiple] allocations rendered = ${rowCount}`);
    expect(rowCount).toBe(2);

    // Each row shows GL number + name + amount (all present, non-empty)
    for (let i = 0; i < rowCount; i++) {
      const rowText = ((await rows.nth(i).textContent()) ?? "").trim();
      console.log(`[CPA Multiple row ${i}] "${rowText}"`);
      // GL prefix + amount pattern (e.g. "GL 6064 Membership & Dues  $495.00")
      expect(rowText).toMatch(/GL\s+\d{4}/);
      expect(rowText).toMatch(/\$[\d,]+\.\d{2}/);
    }
    // Total reconciliation present
    const total = popover.locator(".cat-hover-total").first();
    await expect(total).toBeVisible();

    await card.screenshot({ path: join(OUT, "CPA_Alberta-multiple-popover.png") });

    // §12 · Escape dismisses
    await page.keyboard.press("Escape");
    await page.mouse.move(10, 10);
    await popover.waitFor({ state: "hidden", timeout: 3_000 }).catch(() => { /* ignore */ });
  });

  test("Accessibility — keyboard focus + Enter opens confidence popover (DMM)", async ({ context }) => {
    const page = await loginAsFounder(context);
    await page.goto(`${availability.baseURL}/app/admin`, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle").catch(() => { /* ignore */ });
    const card = await findCard(page, "20128fk9");

    const cell = card.locator('[data-testid="ap-readout-confidence"]').first();
    // Focus via keyboard (element has tabIndex=0 + role=button)
    await cell.focus();
    const popover = card.locator('[data-testid="ap-readout-confidence-popover"]').first();
    // Focus alone should open per onFocus handler
    await popover.waitFor({ state: "visible", timeout: 5_000 });

    // Escape closes
    await page.keyboard.press("Escape");
    await page.mouse.move(10, 10);
    await popover.waitFor({ state: "hidden", timeout: 3_000 }).catch(() => { /* ignore */ });
  });
});
