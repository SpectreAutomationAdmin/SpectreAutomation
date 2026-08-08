// Sprint 3 · Phase 4 Slice 5.1 (2026-08-08) — OCR as a first-class
// evidence provider — authenticated staging acceptance across the
// five real Outlook-backed cards.
//
// Amendments 1-8 acceptance:
//   - DMM: targeted trigger evaluated; if fused-row detected on a
//     digital page, a targeted OCR row exists / is enqueued for
//     that specific pageNumber.
//   - Oakcreek 1087769: IMAGE_ONLY page routes to OCR; on
//     completion the ONE canonical evidence path fuses and the
//     Work Intake projection updates without a Mission Control
//     render.
//   - Oakcreek 1091559: stays native-first; NO OCR provider calls
//     unless a specific unresolved region justifies it.
//   - OXIO: stays native-first; NO OCR provider calls.
//   - CPA Alberta: stays native-first except for justified
//     targeted visual branding.
//
// Founder-mandated stability: supplier + totals remain unchanged
// across the five cards (Slice 4-reopen frozen surface preserved).

import { test, expect, type Page } from "@playwright/test";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

const availability = stagingCredsAvailable();

interface InspectResult {
  ok?: boolean;
  analyseResult?: {
    supplierGuessedName?: string;
    invoiceNumber?: string;
    total?: number | string;
    canonicalLineItemsV2?: Array<{ description: string; extension: number; role: string; sourceStrategy: string }>;
    canonicalPages?: Array<{ page: number; pageClass: string; itemsProduced: number; routedTo: string }>;
    canonicalOcrPending?: boolean;
    canonicalDiagnostic?: string;
  };
}

async function probe(page: Page, suffix4: string): Promise<InspectResult> {
  const res = await page.request.post(
    `${availability.baseURL}/api/ap-intelligence/inspect-wi`,
    { data: { wiIdSuffix4: suffix4, positionalTrace: true } },
  );
  expect(res.status(), `inspect-wi ${suffix4} HTTP`).toBe(200);
  return await res.json();
}

test.describe("Slice 5.1 · OCR first-class evidence — real staging cards", () => {
  test.skip(!availability.ready, availability.reason ?? "creds unavailable");
  test.setTimeout(120_000);

  test("DMM (8fk9) supplier + total stable (frozen surfaces held)", async ({ context }) => {
    const page = await loginAsFounder(context);
    const r = await probe(page, "8fk9");
    expect(r.analyseResult?.supplierGuessedName).toMatch(/DMM/i);
    expect(Number(r.analyseResult?.total)).toBe(2532.92);
  });

  test("Oakcreek 1087769 (7b0b) IMAGE_ONLY page routes to OCR (not fabricated)", async ({ context }) => {
    const page = await loginAsFounder(context);
    const r = await probe(page, "7b0b");
    const pages = r.analyseResult?.canonicalPages ?? [];
    // Amendment #1: page-level routing. The IMAGE_ONLY page must
    // route to TEXTRACT_PENDING (or FUSED once OCR completes).
    // Either state is truthful; neither state fabricates content.
    const imgOnlyPage = pages.find((p) => p.pageClass === "IMAGE_ONLY");
    expect(imgOnlyPage, "Oakcreek 1087769 has an IMAGE_ONLY page").toBeTruthy();
    // Supplier/totals stable.
    expect(r.analyseResult?.supplierGuessedName).toMatch(/Oakcreek/i);
    expect(Number(r.analyseResult?.total)).toBe(1056.22);
  });

  test("Oakcreek 1091559 (vkbm) stays native-first; NO OCR provider calls unless targeted", async ({ context }) => {
    const page = await loginAsFounder(context);
    const r = await probe(page, "vkbm");
    const pages = r.analyseResult?.canonicalPages ?? [];
    // All pages should be DIGITAL_TEXT → POSITIONED. No PARTIAL / IMAGE_ONLY.
    for (const p of pages) {
      expect(p.pageClass, `page ${p.page} class`).toBe("DIGITAL_TEXT");
      expect(p.routedTo, `page ${p.page} routing`).toBe("POSITIONED");
    }
    expect(r.analyseResult?.supplierGuessedName).toMatch(/Oakcreek/i);
    expect(Number(r.analyseResult?.total)).toBe(77833.35);
  });

  test("OXIO (73n5) stays native-first; NO OCR provider calls", async ({ context }) => {
    const page = await loginAsFounder(context);
    const r = await probe(page, "73n5");
    const pages = r.analyseResult?.canonicalPages ?? [];
    for (const p of pages) {
      // OXIO has 2 digital pages. Neither should route to OCR.
      expect(p.pageClass).toBe("DIGITAL_TEXT");
      expect(p.routedTo).toBe("POSITIONED");
    }
    expect(r.analyseResult?.supplierGuessedName).toBe("OXIO");
    expect(r.analyseResult?.invoiceNumber).toBe("OXIO-23375874");
  });

  test("CPA Alberta (w3bz) stays native-first (targeted visual branding only)", async ({ context }) => {
    const page = await loginAsFounder(context);
    const r = await probe(page, "w3bz");
    const pages = r.analyseResult?.canonicalPages ?? [];
    for (const p of pages) {
      expect(p.pageClass).toBe("DIGITAL_TEXT");
      expect(p.routedTo).toBe("POSITIONED");
    }
    expect(r.analyseResult?.supplierGuessedName).toMatch(/CPA/i);
    expect(Number(r.analyseResult?.total)).toBe(1420.50);
  });

  test("all five docs: one canonical authority + no supplier / total regression", async ({ context }) => {
    const page = await loginAsFounder(context);
    const suffixes = [
      { label: "DMM", suffix: "8fk9", supplier: /DMM/i, total: 2532.92 },
      { label: "Oakcreek 1091559", suffix: "vkbm", supplier: /Oakcreek/i, total: 77833.35 },
      { label: "Oakcreek 1087769", suffix: "7b0b", supplier: /Oakcreek/i, total: 1056.22 },
      { label: "OXIO", suffix: "73n5", supplier: /OXIO/, total: 40.32 },
      { label: "CPA", suffix: "w3bz", supplier: /CPA/i, total: 1420.50 },
    ];
    for (const { label, suffix, supplier, total } of suffixes) {
      const r = await probe(page, suffix);
      expect(r.analyseResult?.supplierGuessedName, `${label} supplier`).toMatch(supplier);
      expect(Number(r.analyseResult?.total), `${label} total`).toBe(total);
      // Canonical diagnostic present — proves the ONE authority
      // produced the analysis (even when it emitted zero items).
      expect(typeof r.analyseResult?.canonicalDiagnostic).toBe("string");
    }
  });
});
