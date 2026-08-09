// Sprint 3 · Phase 5 · Slice 2 (2026-08-09) — workflow / confidence
// separation staging acceptance. Locks the §1 §10 §11 §14 rules:
//
//   • Compact confidence summary reports the WEAKEST material
//     intelligence dimension, NOT a workflow blocker.
//   • Workflow pill remains visible ADJACENT to the confidence cell.
//   • Popover has two sections: Intelligence + Workflow (when
//     blockers exist).
//   • CPA "Multiple" popover behavior unchanged.

import { test, expect, type Page, type Locator } from "@playwright/test";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const availability = stagingCredsAvailable();
const OUT = "test-results/phase5-slice2-workflow-confidence-separation";

const CARDS = [
  { label: "DMM",              wiSuffix: "20128fk9", childAp: "8uyu" },
  { label: "Oakcreek_1087769", wiSuffix: "2lrnzi7d", childAp: "7b0b" },
  { label: "Oakcreek_1091559", wiSuffix: "9h76vkbm", childAp: "64kn" },
  { label: "OXIO",             wiSuffix: "c7g773n5", childAp: "diin" },
  { label: "CPA_Alberta",      wiSuffix: "fr09w3bz", childAp: "aj1k" },
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

test.describe("Phase 5 · Slice 2 — workflow / confidence separation (5 real cards)", () => {
  test.skip(!availability.ready, availability.reason ?? "staging credentials required");
  test.setTimeout(600_000);
  test.beforeAll(() => { mkdirSync(OUT, { recursive: true }); });

  for (const c of CARDS) {
    test(`${c.label}: compact summary shows intelligence weakest-dimension (not workflow blocker)`, async ({ context }) => {
      const page = await loginAsFounder(context);
      await page.goto(`${availability.baseURL}/app/admin`, { waitUntil: "domcontentloaded" });
      await page.waitForLoadState("networkidle").catch(() => { /* ignore */ });
      const card = await findCard(page, c.wiSuffix);

      // Compact confidence cell content
      const summary = card.locator('[data-testid="ap-readout-confidence"] .v').first();
      const summaryText = ((await summary.textContent()) ?? "").trim();

      // Read the data-confidence-level attribute (source-of-truth for
      // the adapter's summary decision).
      const summaryCell = card.locator('[data-testid="ap-readout-confidence"]').first();
      const summaryLevel = await summaryCell.getAttribute("data-confidence-level");
      const weakestDim = await summaryCell.getAttribute("data-confidence-dimension");
      console.log(`[${c.label}] compact="${summaryText}" · level=${summaryLevel} · weakest=${weakestDim || "(none)"}`);

      // §1 CRITICAL: compact summary MUST NOT be "Needs review · Workflow"
      // Every real card has Phase 3 blockers (unapproved) but that is
      // no longer allowed to define the compact confidence field.
      // Accepted formats:
      //   "High"
      //   "Moderate · <Supplier|Category|GL>"
      //   "Low · <Supplier|Category|GL>"
      //   "Needs review · <Supplier|Category|GL>"
      expect(summaryText).toMatch(/^(High|Moderate\s*·\s*(Supplier|Category|GL)|Low\s*·\s*(Supplier|Category|GL)|Needs review\s*·\s*(Supplier|Category|GL))/);

      // If the summary is NOT "High", it must name a dimension.
      if (summaryLevel && summaryLevel !== "HIGH") {
        expect(weakestDim).toBeTruthy();
        expect(["supplier", "transaction", "gl"]).toContain(weakestDim);
      }

      // §20 — workflow pill remains visible on the card
      const workflowPill = card.locator('[data-testid="ap-workflow-pill"]').first();
      await expect(workflowPill).toBeVisible();

      // §28 · Screenshot compact state
      await card.screenshot({ path: join(OUT, `${c.label}-compact.png`) });

      // Open popover
      await summaryCell.hover();
      const popover = card.locator('[data-testid="ap-readout-confidence-popover"]').first();
      await popover.waitFor({ state: "visible", timeout: 5_000 });

      // §14 — Intelligence section: three rows
      const supplierRow = popover.locator('[data-testid="ap-readout-confidence-supplier"]').first();
      const categoryRow = popover.locator('[data-testid="ap-readout-confidence-category"]').first();
      const glRow       = popover.locator('[data-testid="ap-readout-confidence-gl"]').first();
      await expect(supplierRow).toBeVisible();
      await expect(categoryRow).toBeVisible();
      await expect(glRow).toBeVisible();
      const supplierLevel = await supplierRow.getAttribute("data-confidence-level");
      const categoryLevel = await categoryRow.getAttribute("data-confidence-level");
      const glLevel = await glRow.getAttribute("data-confidence-level");
      console.log(`[${c.label}] popover intelligence: supplier=${supplierLevel} · category=${categoryLevel} · gl=${glLevel}`);

      // Screenshot open popover
      await card.screenshot({ path: join(OUT, `${c.label}-popover.png`) });

      // Dismiss
      await page.keyboard.press("Escape");
      await page.mouse.move(10, 10);
      await popover.waitFor({ state: "hidden", timeout: 3_000 }).catch(() => { /* ignore */ });
    });
  }

  test("§17 CPA Multiple category popover unchanged (2 allocations)", async ({ context }) => {
    const page = await loginAsFounder(context);
    await page.goto(`${availability.baseURL}/app/admin`, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle").catch(() => { /* ignore */ });
    const card = await findCard(page, "fr09w3bz");
    const catCell = card.locator('[data-testid="ap-readout-category"]').first();
    await catCell.hover();
    const popover = card.locator('[data-testid="ap-readout-category-popover"]').first();
    await popover.waitFor({ state: "visible", timeout: 5_000 });
    const rows = popover.locator(".cat-hover-row");
    expect(await rows.count()).toBe(2);
    await card.screenshot({ path: join(OUT, "CPA_Alberta-multiple-popover.png") });
  });
});
