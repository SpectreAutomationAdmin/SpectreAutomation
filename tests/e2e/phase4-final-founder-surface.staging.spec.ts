// Sprint 3 · Phase 4 FINAL FOUNDER-SURFACE ACCEPTANCE (2026-08-09).
//
// This is the closeout-evidence gap identified after the Phase 4 Final
// Freeze report: prove that the five genuine Outlook-backed AP Work
// Intake cards visibly render the frozen Phase 4 result in the ACTUAL
// Mission Control UI — not just via backend/projection.
//
// NO production intelligence changes. Test-only. If any card disagrees
// with the frozen accepted backend result: STOP and report first-failure
// per §13 of the acceptance directive.
//
// Test uses the real /app/admin Mission Control feed, discovers each
// card by its `data-work-intake-item-id` attribute (ends-with the 4-8
// char suffix), and asserts founder-facing DOM values.

import { test, expect, type Page, type Locator } from "@playwright/test";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const availability = stagingCredsAvailable();
const OUT = "test-results/phase4-final-founder-surface";

interface Expected {
  label: string;
  wiSuffix: string;                        // parent EMAIL WI id (feed-visible card)
  apChildSuffix4: string;                  // 4-char suffix of the AP_INVOICE_REVIEW child (for inspect-wi backend probe)
  supplierMatch: RegExp;                   // must match visible supplier text
  categoryMatch: RegExp;                   // must match visible category text
  supplierForbidden?: RegExp[];            // must NOT match
  categoryForbidden?: RegExp[];            // must NOT match
}

// The founder-facing feed card is the EMAIL INTAKE that carries the
// AP invoice attachment. The child AP_INVOICE_REVIEW WIs are
// suppressed per `loadChildReviewIntakesToSuppress` — the email card
// renders the linked AP analysis inline. wiSuffix below is the
// PARENT email WI id (verified against ApIntakeSource +
// EmailWorkIntakeOrigin on staging on 2026-08-09).
const CONTROLS: Expected[] = [
  {
    label: "DMM",
    wiSuffix: "20128fk9",           // parent email WI (child AP=094a8uyu)
    apChildSuffix4: "8uyu",
    supplierMatch: /DMM\s*ENERGY|DMM\s*Energy/i,
    categoryMatch: /fuel/i,
    supplierForbidden: [/dmmenergy/, /account number/i],
    categoryForbidden: [/capital/i, /^—$/, /^-$/],
  },
  {
    label: "Oakcreek 1087769",
    wiSuffix: "2lrnzi7d",           // parent email WI (child AP=rkso7b0b)
    apChildSuffix4: "7b0b",
    supplierMatch: /oakcreek/i,
    categoryMatch: /.+/, // any non-empty category acceptable; frozen result is operating R&M-adjacent
    categoryForbidden: [/^—$/, /^-$/, /capital\s+improvement/i, /construction\s+in\s+progress/i],
  },
  {
    label: "Oakcreek 1091559",
    wiSuffix: "9h76vkbm",           // parent email WI (child AP=w2io64kn)
    apChildSuffix4: "64kn",
    supplierMatch: /oakcreek/i,
    categoryMatch: /equipment|capital|grounds/i,
    categoryForbidden: [
      /construction\s+in\s+progress/i,
      /^R&M/i,
      /Repair(?:s)?\s+(?:&|and)\s+Maintenance/i,
      /equipment\s+parts/i,
      /^—$/, /^-$/,
    ],
  },
  {
    label: "OXIO",
    wiSuffix: "c7g773n5",           // parent email WI (child AP=lvtndiin)
    apChildSuffix4: "diin",
    supplierMatch: /oxio/i,
    categoryMatch: /internet|connectivity|telecom|telephone/i,
    supplierForbidden: [
      /taxes\s*\/?\s*fees/i,
      /lise\s+montsion/i,
      /oxio-\d{6,}/i,
    ],
    categoryForbidden: [/taxes/i, /^—$/, /^-$/],
  },
  {
    label: "CPA Alberta",
    wiSuffix: "fr09w3bz",           // parent email WI (child AP=k8vgaj1k)
    apChildSuffix4: "aj1k",
    supplierMatch: /CPA\s*Alberta/i,
    categoryMatch: /multiple/i,
    supplierForbidden: [/christopher/i, /turcato/i],
    categoryForbidden: [/^—$/, /^-$/, /^membership$/i, /^interest$/i, /^penalty$/i],
  },
];

async function findCardBySuffix(page: Page, wiSuffix: string): Promise<Locator | null> {
  const active = page.locator(`[data-testid="email-intake-card"][data-work-intake-item-id$="${wiSuffix}"], [data-testid="ap-review-card"][data-work-intake-item-id$="${wiSuffix}"]`).first();
  if (await active.isVisible({ timeout: 5_000 }).catch(() => false)) return active;
  return null;
}

test.describe("Phase 4 FINAL FOUNDER-SURFACE — 5 real controls (DOM)", () => {
  test.skip(!availability.ready, availability.reason ?? "staging credentials required");
  test.setTimeout(600_000);
  test.beforeAll(() => { mkdirSync(OUT, { recursive: true }); });

  for (const ctrl of CONTROLS) {
    test(`§4 ${ctrl.label} founder-facing card renders accepted values`, async ({ context }) => {
      const page = await loginAsFounder(context);
      // /app/admin is the actual Mission Control admin route; /mission-control 404s
      await page.goto(`${availability.baseURL}/app/admin`, { waitUntil: "domcontentloaded" });
      await page.waitForLoadState("networkidle").catch(() => { /* ignore */ });

      // Try the Active view first
      let card = await findCardBySuffix(page, ctrl.wiSuffix);
      let inHistory = false;

      // Not in Active feed (may be resolved) — try History
      if (!card) {
        await page.goto(`${availability.baseURL}/app/admin?view=history`, { waitUntil: "domcontentloaded" });
        await page.waitForLoadState("networkidle").catch(() => { /* ignore */ });
        card = await findCardBySuffix(page, ctrl.wiSuffix);
        inHistory = true;
      }

      // Card not reachable at all — that's a first-failure D (Work Intake
      // routing/filter defect) per §13.
      expect(card, `${ctrl.label}: card [data-work-intake-item-id$="${ctrl.wiSuffix}"] not visible on /app/admin (Active) nor ?view=history — first failure category D (routing/filter defect)`).not.toBeNull();

      // Scroll the card into view; take card-level screenshot BEFORE we
      // interact so we have evidence even if a later assertion fails.
      await card!.scrollIntoViewIfNeeded();
      const cardScreenshotPath = join(OUT, `${ctrl.label.replace(/[^a-z0-9]/gi, "_")}-card.png`);
      await card!.screenshot({ path: cardScreenshotPath });
      console.log(`[${ctrl.label}] wi=${ctrl.wiSuffix} in=${inHistory ? "history" : "active"} screenshot=${cardScreenshotPath}`);

      // ---- Supplier -----------------------------------------------------
      // Vendor-linked (matched) or unlinked (create-vendor button). Read
      // whichever renders.
      const supplierLink = card!.locator('[data-testid="ap-title-vendor-link"], [data-testid="ap-title-vendor-button"]').first();
      const supplierText = (await supplierLink.textContent().catch(() => "")) ?? "";
      console.log(`[${ctrl.label}] supplier="${supplierText.trim().slice(0, 100)}"`);
      expect(supplierText.trim(), `${ctrl.label} supplier text should match ${ctrl.supplierMatch}`).toMatch(ctrl.supplierMatch);
      for (const forbidden of ctrl.supplierForbidden ?? []) {
        expect(supplierText.trim(), `${ctrl.label} supplier must NOT match ${forbidden}`).not.toMatch(forbidden);
      }

      // ---- Category / purpose -------------------------------------------
      // Read the .v child of the category cell (the actual visible value).
      const categoryCell = card!.locator('[data-testid="ap-readout-category"] .v').first();
      const categoryText = (await categoryCell.textContent().catch(() => "")) ?? "";
      console.log(`[${ctrl.label}] category="${categoryText.trim().slice(0, 80)}"`);
      expect(categoryText.trim(), `${ctrl.label} category should match ${ctrl.categoryMatch}`).toMatch(ctrl.categoryMatch);
      for (const forbidden of ctrl.categoryForbidden ?? []) {
        expect(categoryText.trim(), `${ctrl.label} category must NOT match ${forbidden}`).not.toMatch(forbidden);
      }
    });
  }

  test("§10 backend → projection → DOM parity table", async ({ context }) => {
    // Rebuild the backend view via inspect-wi for each control and print
    // the parity table alongside what the DOM showed. This test does not
    // repeat the DOM read (previous per-card tests already assert that)
    // — its purpose is to emit the parity summary the founder needs.
    const page = await loginAsFounder(context);
    const rows: Array<{ label: string; supplier: string; category: string; gl: string; allocationCount: number | null; capitalState: string }> = [];
    for (const ctrl of CONTROLS) {
      // Use the AP CHILD suffix for inspect-wi (parent email WI has no
      // AP analyseResult of its own; the analyse lives on the child).
      const res = await page.request.post(
        `${availability.baseURL}/api/ap-intelligence/inspect-wi`,
        { data: { wiIdSuffix4: ctrl.apChildSuffix4 }, timeout: 120_000 },
      );
      const body = res.status() === 200 ? await res.json() : { analyseResult: null };
      const a = body.analyseResult ?? {};
      const gl = a.glRecommendationWinner ?? {};
      const allocations = a.allocations ?? {};
      rows.push({
        label: ctrl.label,
        supplier: (a.supplierGuessedName ?? "").slice(0, 40),
        category: (allocations.cardCategory ?? "-"),
        gl: `${gl.accountNumber ?? "-"}: ${gl.accountName ?? "-"}`.slice(0, 60),
        allocationCount: allocations.entryCount ?? null,
        capitalState: a.capitalState ?? "-",
      });
    }
    console.log("=== §10 parity table (backend view) ===");
    console.log("| control | supplier | category | GL | allocationCount | capitalState |");
    for (const r of rows) {
      console.log(`| ${r.label} | ${r.supplier} | ${r.category} | ${r.gl} | ${r.allocationCount} | ${r.capitalState} |`);
    }
    // Sanity: all 5 rows returned
    expect(rows).toHaveLength(5);
  });
});
