// Sprint 3 · Post-Slice-3 lifecycle contract (2026-08-09) —
// Analysis-pending renderer acceptance on staging.
//
// The five real staging AP cards are all STABLE (analyseIngestedInvoice
// completed weeks ago). This spec proves:
//   1. None of the five real cards render the pending body — every
//      one still renders the full AP readout row + workflow pill.
//   2. The lifecycle contract's negative assertion holds: no card
//      exposes the `ap-work-summary-pending` sentinel that the
//      pending renderer would emit.
//   3. The AP feed remains navigable end-to-end.
//
// This is the founder-facing regression floor for §28 (five real
// controls must retain their final stable states after the lifecycle
// change is deployed).
//
// The positive pending-body assertion (a card that SHOULD be pending
// renders the pending body) is covered by the 19-scenario unit
// matrix — staging doesn't hold a currently-pending record we can
// reproducibly point Playwright at without race conditions.

import { test, expect, type Page, type Locator } from "@playwright/test";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const availability = stagingCredsAvailable();
const OUT = "test-results/lifecycle-analysis-pending";

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

test.describe("Lifecycle · analysis-pending negative acceptance (§28)", () => {
  test.skip(!availability.ready, availability.reason ?? "staging credentials required");
  test.setTimeout(600_000);
  test.beforeAll(() => { mkdirSync(OUT, { recursive: true }); });

  for (const c of CARDS) {
    test(`${c.label}: renders stable AP body — never pending shell`, async ({ context }) => {
      const page = await loginAsFounder(context);
      await page.goto(`${availability.baseURL}/app/admin`, { waitUntil: "domcontentloaded" });
      await page.waitForLoadState("networkidle").catch(() => { /* ignore */ });
      const card = await findCard(page, c.wiSuffix);

      // Negative: the pending-only work-summary sentinel must NOT exist
      // for a stable card.
      const pendingSentinel = card.locator('[data-testid="ap-work-summary-pending"]');
      await expect(pendingSentinel).toHaveCount(0);

      // Positive: the stable AP body is present (full readout row,
      // confidence disclosure with a data-confidence-level attribute).
      const confidenceCell = card.locator('[data-testid="ap-readout-confidence"]').first();
      await expect(confidenceCell).toBeVisible();
      const confidenceLevel = await confidenceCell.getAttribute("data-confidence-level");
      expect(["HIGH", "MODERATE", "LOW", "NEEDS_REVIEW"]).toContain(confidenceLevel);

      // Positive: the workflow pill exists and does NOT read "Analysis pending".
      const pill = card.locator('[data-testid="ap-workflow-pill"]').first();
      await expect(pill).toBeVisible();
      const pillText = ((await pill.textContent()) ?? "").trim();
      expect(pillText).not.toMatch(/^Analysis pending/i);
      console.log(`[${c.label}] pill="${pillText}" · confidence=${confidenceLevel}`);

      await card.screenshot({ path: join(OUT, `${c.label}-stable.png`) });
    });
  }
});
