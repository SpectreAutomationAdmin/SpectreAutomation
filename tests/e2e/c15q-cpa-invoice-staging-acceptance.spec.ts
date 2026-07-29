// Sprint 3 · Checkpoint 15Q — STAGING browser acceptance test.
//
// Founder rule: no more checkpoints may be declared complete without
// a Playwright test proving the ACTUAL browser output on staging
// matches the acceptance criteria. This test drives the pre-15Q
// Work Intake UI on the deployed staging environment and asserts:
//
//   • supplier is derived from the invoice issuer, NOT
//     "Christopher Turcato, CPA" and NOT a monetary amount
//   • invoice number 1007565767 is present on the card
//   • GL recommendation is 6064 Membership & Dues
//   • 6061 Accounting fees is NOT the recommendation
//   • 6045 Score Cards & Printing is NOT the recommendation
//   • the pre-15Q Work Intake UI is unchanged (no reasoning panel,
//     no confidence chips, no tax breakdown)
//
// The founder runs this locally against staging (no credentials in
// the repo). See "How to run" at the bottom.

import { test, expect, type Page } from "@playwright/test";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Environment — every value is a local ENV VAR the founder sets. No
// credentials, no work-intake IDs, no personal data in the repo.
// ---------------------------------------------------------------------------
const BASE = process.env.SPECTRE_BASE_URL ?? "https://staging.spectreautomation.com";
const EMAIL = process.env.SPECTRE_STAGING_EMAIL ?? "";
const PASSWORD = process.env.SPECTRE_STAGING_PASSWORD ?? "";

// The CPA invoice number is public knowledge (visible in the browser
// title anyway). Located via DOM text search, NOT via a hardcoded
// work-intake DB id.
const CPA_INVOICE_NUMBER = process.env.SPECTRE_CPA_INVOICE_NO ?? "1007565767";

// Artefact directory — every test run writes fresh files here.
const OUT = process.env.SPECTRE_PLAYWRIGHT_OUT ?? "test-results/c15q-cpa-acceptance";

test.use({
  trace: "on",
  video: "retain-on-failure",
  screenshot: "only-on-failure",
});

async function signIn(page: Page): Promise<void> {
  if (!EMAIL || !PASSWORD) {
    throw new Error(
      "SPECTRE_STAGING_EMAIL and SPECTRE_STAGING_PASSWORD env vars are required. "
      + "Run: SPECTRE_STAGING_EMAIL='...' SPECTRE_STAGING_PASSWORD='...' "
      + "npx playwright test tests/e2e/c15q-cpa-invoice-staging-acceptance.spec.ts",
    );
  }
  await page.goto(`${BASE}/login`);
  await page.fill('input[name="email"]', EMAIL);
  await page.fill('input[name="password"]', PASSWORD);
  await Promise.all([
    page.waitForURL(/\/app(\/|$)/, { timeout: 20_000 }),
    page.click('button[type="submit"]'),
  ]);
}

test.describe("15Q · CPA invoice on Coulee Ridge — staging acceptance", () => {
  test.beforeAll(async () => {
    await mkdir(OUT, { recursive: true });
  });

  test("card renders correct vendor, invoice number, and GL 6064 Membership & Dues", async ({ page, context }) => {
    // ---- capture everything ------------------------------------------------
    const consoleLog: string[] = [];
    const netLog: string[] = [];
    page.on("console", (msg) => consoleLog.push(`[${msg.type()}] ${msg.text()}`));
    page.on("pageerror", (err) => consoleLog.push(`[pageerror] ${err.message}`));
    page.on("response", (res) => {
      const url = res.url();
      if (url.includes("/api/") || url.includes("/app/admin")) {
        netLog.push(`${res.status()} ${res.request().method()} ${url.replace(/^https?:\/\/[^/]+/, "")}`);
      }
    });
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true });

    // ---- sign in + open Mission Control -----------------------------------
    await page.setViewportSize({ width: 1440, height: 900 });
    await signIn(page);
    await page.goto(`${BASE}/app/admin`);
    await page.waitForLoadState("networkidle", { timeout: 45_000 });

    // Screenshot BEFORE opening any card — shows the whole feed as
    // the founder sees it.
    await page.screenshot({ path: join(OUT, "01-mission-control-feed.png"), fullPage: true });

    // ---- locate the CPA card by INVOICE NUMBER via DOM text ---------------
    // The card renders the invoice number in the readout cell
    // `[data-testid="ap-readout-po-or-invoice"]` prefixed with `#`.
    // We search for any card wrapping that cell whose text contains
    // the founder's invoice number, so we never hardcode a work-
    // intake DB id.
    const cardsWithInvoiceNumber = page
      .locator('[data-testid="email-intake-card"]')
      .filter({
        has: page.locator('[data-testid="ap-readout-po-or-invoice"]', {
          hasText: CPA_INVOICE_NUMBER,
        }),
      });

    // Fallback locator: some card variants embed the invoice number
    // in the title, not the readout cell.
    const cardsWithTitleText = page
      .locator('[data-testid="email-intake-card"]')
      .filter({ has: page.locator('h3', { hasText: CPA_INVOICE_NUMBER }) });

    const readoutCount = await cardsWithInvoiceNumber.count();
    const titleCount = await cardsWithTitleText.count();
    // eslint-disable-next-line no-console
    console.log(`[c15q] cards matching invoice #${CPA_INVOICE_NUMBER}: readout=${readoutCount} title=${titleCount}`);

    const card = readoutCount > 0
      ? cardsWithInvoiceNumber.first()
      : cardsWithTitleText.first();

    await expect(card, `No Work Intake card found for invoice #${CPA_INVOICE_NUMBER}. Confirm the invoice has been ingested on Coulee Ridge on staging.`).toBeVisible({ timeout: 15_000 });
    await card.scrollIntoViewIfNeeded();
    await card.screenshot({ path: join(OUT, "02-cpa-card-collapsed.png") });

    // ---- vendor / issuer assertions --------------------------------------
    const vendorLabel = card
      .locator('[data-testid="ap-title-vendor-link"], [data-testid="ap-title-vendor-button"]')
      .first();
    // The vendor slot exists (not the null-fallback "AP invoice" text).
    await expect(vendorLabel, "Vendor slot must be populated with an issuer — not the null-fallback").toBeVisible();
    const vendorText = (await vendorLabel.textContent())?.trim() ?? "";
    // eslint-disable-next-line no-console
    console.log(`[c15q] vendor text on card: "${vendorText}"`);

    // Founder acceptance criteria:
    //   • NOT the addressee ("Christopher TURCATO, CPA" / any
    //     person-with-CPA-credential shape)
    //   • NOT a monetary amount ($810 / $1,420 / etc.)
    //   • MUST contain "CPA Alberta" (the actual invoice issuer).
    expect(vendorText.toLowerCase(), "Vendor must not contain 'turcato' (the addressee/member)").not.toMatch(/turcato/i);
    expect(vendorText, "Vendor must not be a monetary amount").not.toMatch(/^\$?\d/);
    expect(vendorText.toLowerCase(), "Vendor should contain 'cpa alberta' (the actual issuer)").toContain("cpa alberta");

    // ---- invoice number ---------------------------------------------------
    const invoiceCell = card.locator('[data-testid="ap-readout-po-or-invoice"]').first();
    if ((await invoiceCell.count()) > 0) {
      await expect(invoiceCell).toContainText(CPA_INVOICE_NUMBER);
    }
    // Fallback: invoice number in the title.
    await expect(card).toContainText(CPA_INVOICE_NUMBER);

    // ---- GL recommendation ------------------------------------------------
    // The category cell holds the GL account name. Full "GL 6064
    // Membership & Dues" reference appears in the work summary at
    // [data-testid="ap-work-gl-ref"] when the recommender resolves
    // an account.
    const glRef = card.locator('[data-testid="ap-work-gl-ref"]').first();
    const categoryCell = card.locator('[data-testid="ap-readout-category"]').first();
    const glRefCount = await glRef.count();
    const categoryText = (await categoryCell.textContent())?.trim() ?? "";
    const glRefText = glRefCount > 0 ? ((await glRef.textContent())?.trim() ?? "") : "";
    // eslint-disable-next-line no-console
    console.log(`[c15q] GL ref: "${glRefText}"  · category cell: "${categoryText}"`);

    // Founder acceptance criteria:
    //   • MUST show 6064 Membership & Dues
    //   • MUST NOT show 6061 Accounting fees
    //   • MUST NOT show 6045 Score Cards & Printing
    const glCombined = `${glRefText} ${categoryText}`.toLowerCase();
    expect(glCombined, "GL must include 6064 Membership & Dues").toMatch(/6064|membership.*dues/i);
    expect(glCombined, "GL must not be 6061 Accounting fees").not.toMatch(/6061|accounting\s*fees/i);
    expect(glCombined, "GL must not be 6045 Score Cards & Printing").not.toMatch(/6045|score\s*cards/i);

    // ---- pre-15Q UI is unchanged (no reasoning panel) --------------------
    // The reverted UI must NOT contain any of the 15Q-first-slice
    // additions: reasoning panel, confidence chips, tax breakdown.
    await expect(page.locator('[data-testid="ap-reasoning-panel"]'), "The 15Q reasoning panel must be absent (engine-only checkpoint)").toHaveCount(0);
    await expect(page.locator('[data-testid="ap-reasoning-chips"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="ap-reasoning-tax"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="ap-reasoning-purpose"]')).toHaveCount(0);

    // ---- expand the card + capture ---------------------------------------
    await card.click();
    await page.waitForTimeout(500);
    await card.screenshot({ path: join(OUT, "03-cpa-card-expanded.png") });
    await page.screenshot({ path: join(OUT, "04-cpa-fullpage-expanded.png"), fullPage: true });

    // ---- finalise artefacts ----------------------------------------------
    await context.tracing.stop({ path: join(OUT, "trace.zip") });
    await writeFile(join(OUT, "console.log"), consoleLog.join("\n"), "utf8");
    await writeFile(join(OUT, "network.log"), netLog.join("\n"), "utf8");
    await writeFile(
      join(OUT, "assertion-report.md"),
      [
        "# 15Q · CPA Invoice Staging Acceptance",
        "",
        `Base URL: ${BASE}`,
        `Invoice number searched: ${CPA_INVOICE_NUMBER}`,
        `Vendor text observed: "${vendorText}"`,
        `GL ref observed: "${glRefText}"`,
        `Category cell observed: "${categoryText}"`,
        "",
        "## Assertions",
        "- vendor is not the addressee (contains no 'turcato'): PASS",
        "- vendor is not a monetary amount: PASS",
        "- vendor contains 'cpa alberta' (actual issuer): PASS",
        `- invoice number ${CPA_INVOICE_NUMBER} visible on card: PASS`,
        "- GL is 6064 Membership & Dues: PASS",
        "- GL is not 6061 Accounting fees: PASS",
        "- GL is not 6045 Score Cards & Printing: PASS",
        "- pre-15Q UI unchanged (no reasoning panel): PASS",
      ].join("\n"),
      "utf8",
    );
  });
});

// ---------------------------------------------------------------------------
// How to run (founder-side, local):
//
//   1. Ensure you're on the branch containing this file.
//   2. From c:\dev\SpectreAutomation:
//
//      SPECTRE_BASE_URL="https://staging.spectreautomation.com" \
//      SPECTRE_STAGING_EMAIL="<your staging login>" \
//      SPECTRE_STAGING_PASSWORD="<your staging password>" \
//      npx playwright test tests/e2e/c15q-cpa-invoice-staging-acceptance.spec.ts \
//        --project=chromium --reporter=list
//
//   3. Artefacts land in test-results/c15q-cpa-acceptance/:
//        01-mission-control-feed.png
//        02-cpa-card-collapsed.png
//        03-cpa-card-expanded.png
//        04-cpa-fullpage-expanded.png
//        trace.zip           (open with: npx playwright show-trace test-results/c15q-cpa-acceptance/trace.zip)
//        console.log
//        network.log
//        assertion-report.md
//
//   4. On failure, the report will name which assertion failed and
//      what value was observed vs expected. Send the artefacts and
//      I'll continue diagnosis.
// ---------------------------------------------------------------------------
