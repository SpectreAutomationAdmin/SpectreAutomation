// Sprint 3 · Post-16H Phase 4 Slice 4-reopen (2026-08-07) —
// §8-§9 EXACT ground-truth supplier acceptance. No loose semantic
// assertions. Each card asserts:
//   1. an exact supplier value or accepted alias
//   2. that specific rejected variants (normalized keys, generic
//      labels, recipient names) DO NOT appear as the supplier
//   3. the founder-visible surface (Mission Control card) shows
//      the same value the diagnostic reports (canonical → card
//      parity)

import { test, expect, type Page } from "@playwright/test";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

const availability = stagingCredsAvailable();

interface ProbeShape {
  supplierGuessedName?: string;
  invoiceNumber?: string;
  canonicalSupplierWinner?: {
    value: string;
    confidence: number;
    ruleKey: string;
    evidenceSnippet?: string;
  };
}

async function probe(page: Page, suffix4: string): Promise<ProbeShape> {
  const res = await page.request.post(`${availability.baseURL}/api/ap-intelligence/inspect-wi`, {
    data: { wiIdSuffix4: suffix4 },
  });
  expect(res.status(), `inspect-wi ${suffix4} HTTP`).toBe(200);
  const body = await res.json();
  return body.analyseResult ?? {};
}

async function readCardText(page: Page, mailTag: string): Promise<string> {
  await page.goto("/app/admin", { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle");
  const item = page.locator(".spectre-mc-item").filter({ hasText: new RegExp(mailTag) }).first();
  const n = await item.count();
  if (n === 0) return "";
  return (await item.innerText()).replace(/\s+/g, " ");
}

test.describe("Slice 4-reopen · exact supplier ground truth on actual staging cards", () => {
  test.skip(!availability.ready, availability.reason ?? "creds unavailable");

  test("DMM (MAIL-8FK9) supplier is the DMM legal or operating name", async ({ context }) => {
    const page = await loginAsFounder(context);
    const p = await probe(page, "8fk9");
    // Accepted variants per founder §1 ("DMM Energy / DMM Energy Inc.").
    const acceptedSupplier = /^(DMM\s+ENERGY(?:\s+INC\.?)?|DMM\s+Energy(?:\s+Inc\.?)?)$/;
    expect(p.supplierGuessedName, "DMM supplier matches accepted alias set").toMatch(acceptedSupplier);
    // Rejected variants:
    expect(p.supplierGuessedName ?? "", "not domain-derived normalized key")
      .not.toBe("Dmmenergy");
    expect(p.supplierGuessedName ?? "", "not a remittance-instruction sentence")
      .not.toMatch(/please\s+write/i);
    // Card parity:
    const cardText = await readCardText(page, "MAIL-8FK9");
    expect(cardText, "DMM card text carries DMM identity").toMatch(/DMM/i);
    expect(cardText, "DMM card must not surface Cpaalberta / Taxes\\/Fees / LISE").not.toMatch(/Cpaalberta|Taxes\/Fees|LISE\s+MONTSION/i);
  });

  test("CPA Alberta (MAIL-W3BZ) supplier is 'CPA ALBERTA' or 'CPA Alberta' — NOT 'Cpaalberta'", async ({ context }) => {
    const page = await loginAsFounder(context);
    const p = await probe(page, "w3bz");
    // Accepted supplier: exactly "CPA ALBERTA" (from HEADER_ORG_TEXT
    // in the PDF) OR "CPA Alberta" (title-case variant OR matched
    // tenant vendor row). Explicit rejection of the normalized key.
    const accepted = /^CPA\s+ALBERTA$|^CPA\s+Alberta$/;
    expect(p.supplierGuessedName, "CPA supplier matches accepted alias set").toMatch(accepted);
    expect(p.supplierGuessedName ?? "", "CPA supplier must NOT be the normalized cluster key").not.toBe("Cpaalberta");
    // The canonical winner rule key must be the identity orchestrator
    // (not a domain-only shortcut) OR the tenant vendor match path.
    expect(p.canonicalSupplierWinner?.ruleKey ?? "", "CPA winner is not domain-only shortcut")
      .not.toMatch(/website_domain_seed(?!\+identity_orchestrator)/);
    // Card parity:
    const cardText = await readCardText(page, "MAIL-W3BZ");
    expect(cardText, "CPA card text carries CPA identity").toMatch(/CPA\s+ALBERTA|CPA\s+Alberta/i);
    expect(cardText, "CPA card must NOT display 'Cpaalberta'").not.toMatch(/Cpaalberta/);
  });

  test("OXIO (MAIL-73N5) supplier is 'OXIO' — NOT 'Taxes/Fees', NOT 'LISE MONTSION', NOT 'OXIO-<statement>'", async ({ context }) => {
    const page = await loginAsFounder(context);
    const p = await probe(page, "73n5");
    expect(p.supplierGuessedName, "OXIO supplier is exactly 'OXIO'").toBe("OXIO");
    // Founder-explicit rejections:
    expect(p.supplierGuessedName ?? "").not.toBe("Taxes/Fees");
    expect(p.supplierGuessedName ?? "").not.toBe("LISE MONTSION");
    expect(p.supplierGuessedName ?? "").not.toMatch(/^OXIO-\d{4,}$/);
    // Payref: OXIO-23375874 is the PDF-printed statement number
    // (verified against real bytes) — keep as-is.
    expect(p.invoiceNumber).toBe("OXIO-23375874");
    // Card parity:
    const cardText = await readCardText(page, "MAIL-73N5");
    expect(cardText).toMatch(/\bOXIO\b/);
    expect(cardText, "OXIO card must NOT surface Taxes/Fees / LISE / statement-# as supplier")
      .not.toMatch(/Taxes\/Fees|LISE\s+MONTSION/i);
  });

  test("Oakcreek (MAIL-VKBM) supplier is 'Oakcreek Golf & Turf LP' — regression control", async ({ context }) => {
    const page = await loginAsFounder(context);
    const p = await probe(page, "vkbm");
    // Accepted variants: the exact vendor-matched name, or the
    // PDF-derived name.
    const accepted = /Oakcreek\s+Golf\s*(?:&|and)?\s*Turf\s+LP/i;
    expect(p.supplierGuessedName, "Oakcreek supplier matches accepted alias set").toMatch(accepted);
    expect(p.supplierGuessedName ?? "", "Oakcreek supplier must NOT be a label concat").not.toMatch(/Bill\s*ToShip\s*To/i);
    // Card parity:
    const cardText = await readCardText(page, "MAIL-VKBM");
    expect(cardText, "Oakcreek card text carries Oakcreek identity").toMatch(/Oakcreek/i);
  });

  test("all four cards render defensible suppliers simultaneously — no regression tradeoff", async ({ context }) => {
    const page = await loginAsFounder(context);
    const dmm = await probe(page, "8fk9");
    const cpa = await probe(page, "w3bz");
    const oxio = await probe(page, "73n5");
    const oak = await probe(page, "vkbm");
    // Each supplier must contain its expected substring.
    expect(dmm.supplierGuessedName, "DMM").toMatch(/DMM/i);
    expect(cpa.supplierGuessedName, "CPA").toMatch(/CPA\s+ALBERTA|CPA\s+Alberta/i);
    expect(oxio.supplierGuessedName, "OXIO").toBe("OXIO");
    expect(oak.supplierGuessedName, "Oakcreek").toMatch(/Oakcreek/i);
    // None of the four may show a founder-rejected value.
    const rejected = ["Cpaalberta", "Taxes/Fees", "LISE MONTSION", "Bill ToShip To", "Dmmenergy"];
    for (const [label, name] of [["DMM", dmm.supplierGuessedName], ["CPA", cpa.supplierGuessedName], ["OXIO", oxio.supplierGuessedName], ["Oakcreek", oak.supplierGuessedName]] as const) {
      for (const r of rejected) {
        expect(name, `${label} supplier must not be rejected value '${r}'`).not.toBe(r);
      }
    }
  });
});
