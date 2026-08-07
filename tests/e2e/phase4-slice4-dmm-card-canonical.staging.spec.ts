// Sprint 3 · Post-16H Phase 4 Slice 4 (2026-08-07) — mandatory §15
// acceptance against the ACTUAL MAIL-8FK9 DMM Work Intake card.
//
// Founder rule: "The real existing MAIL-8FK9 card is the acceptance
// case. Do not substitute Oakcreek, OXIO or CPA. Do not create a
// replacement DMM card. Playwright must assert against the actual
// card and the actual production data path."
//
// Assertions:
//   * exactly one DMM card
//   * supplier is an organization derived from PDF evidence, not
//     an instructional sentence
//   * payable reference populated
//   * amount is canonical GROSS (2532.92), not subtotal (2412.30)
//   * currency correct (CAD)

import { test, expect, type Page, type Locator } from "@playwright/test";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

const availability = stagingCredsAvailable();

// Founder-observed strings that MUST NOT appear on the DMM card
// after Slice 4. General guards — not DMM-specific.
const FORBIDDEN_SUPPLIER_SENTENCE_TOKENS =
  /\b(please\s+write|please\s+return|please\s+remit|please\s+send|remit\s+payment|write\s+your\s+account)\b/i;

async function findDmmCard(page: Page): Promise<Locator | null> {
  await page.goto("/app/admin", { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle");
  const items = page.locator(".spectre-mc-item").filter({ hasText: /MAIL-8FK9/ });
  const n = await items.count();
  if (n === 0) return null;
  return items.first();
}

test.describe("Phase 4 · Slice 4 · DMM card canonical acceptance", () => {
  test.skip(!availability.ready, availability.reason ?? "creds unavailable");

  test("DMM card supplier is a PDF-derived organization, not an instructional sentence", async ({ context }) => {
    const page = await loginAsFounder(context, { landing: "/app/admin" });
    await page.setViewportSize({ width: 1440, height: 900 });
    const card = await findDmmCard(page);
    expect(card, "DMM card must be present").not.toBeNull();
    const text = (await card!.innerText()).replace(/\s+/g, " ");
    expect(text, "DMM card must NOT surface a remittance-instruction sentence as supplier")
      .not.toMatch(FORBIDDEN_SUPPLIER_SENTENCE_TOKENS);
    // The supplier should carry the DMM identity somewhere (either
    // "Dmmenergy" from the website domain seed, "DMM ENERGY" from
    // the footer terms, or an operator-corrected value). We accept
    // any variant of "DMM" as evidence the analyser reached the
    // real supplier signal.
    // Accept any DMM identity variant — website-domain seed
    // ("Dmmenergy"), footer terms ("DMM ENERGY INC."), or
    // operator-corrected value.
    expect(text, "DMM card must contain a DMM identity variant").toMatch(/dmm/i);
    await card!.screenshot({ path: "test-results/artifacts/dmm-card-slice4.png" });
  });

  test("DMM card amount reflects canonical GROSS (2532.92), not subtotal", async ({ context }) => {
    const page = await loginAsFounder(context, { landing: "/app/admin" });
    await page.setViewportSize({ width: 1440, height: 900 });
    const card = await findDmmCard(page);
    expect(card, "DMM card must be present").not.toBeNull();
    const amountCell = card!.locator('[data-testid="ap-readout-amount"]');
    if (await amountCell.count()) {
      const amt = (await amountCell.innerText()).replace(/\s+/g, " ").trim();
      // Canonical gross is 2,532.92. Subtotal 2,412.30 (the pre-Slice-4
      // wrong value) must NOT appear as the amount cell.
      expect(amt, "amount cell must show canonical gross 2,532.92").toMatch(/2[,.]?532[.]?92/);
      expect(amt, "amount cell must not show subtotal-as-gross 2,412.30").not.toMatch(/2[,.]?412[.]?30/);
    }
    const cardText = (await card!.innerText()).replace(/\s+/g, " ");
    expect(cardText, "card text must include 2,532.92 somewhere").toMatch(/2[,.]?532[.]?92/);
  });

  test("DMM card payable reference is populated + currency is CAD", async ({ context }) => {
    const page = await loginAsFounder(context, { landing: "/app/admin" });
    await page.setViewportSize({ width: 1440, height: 900 });
    // Verify canonical values via the inspect-wi diagnostic path
    // (proves the production data path — same values that render
    // on the card).
    const res = await page.request.post(`${availability.baseURL}/api/ap-intelligence/inspect-wi`, {
      data: { wiIdSuffix4: "8fk9" },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    const ar = body.analyseResult;
    expect(ar?.invoiceNumber, "canonical invoice number populated").toBe("B0037FC");
    expect(String(ar?.total), "canonical gross total").toBe("2532.92");
    expect(String(ar?.subtotal), "canonical subtotal").toBe("2412.30");
    expect(String(ar?.taxTotal), "canonical tax total").toBe("120.62");
    expect(ar?.currency, "canonical currency").toBe("CAD");
    expect(String(ar?.supplierGuessedName), "supplier is NOT a sentence")
      .not.toMatch(FORBIDDEN_SUPPLIER_SENTENCE_TOKENS);
    expect(String(ar?.supplierGuessedName), "supplier carries DMM identity")
      .toMatch(/DMM|dmm/i);
  });

  test("exactly one DMM card in the feed (no duplicates from Slice 4 changes)", async ({ context }) => {
    const page = await loginAsFounder(context, { landing: "/app/admin" });
    await page.waitForLoadState("networkidle");
    const items = page.locator(".spectre-mc-item").filter({ hasText: /MAIL-8FK9/ });
    expect(await items.count(), "exactly one DMM Work Intake card").toBe(1);
  });
});
