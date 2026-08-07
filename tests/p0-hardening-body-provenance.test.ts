// Sprint 3 · Post-16H P0-hardening (2026-08-07) — §3 body-derived
// AP-fact prohibition, enforced as a structural source-contract
// test. Founder rule: "When authoritative evidence says a non-inline
// accounting PDF exists or is pending, email body text must not
// become the authoritative source for supplier / payable reference /
// subtotal / tax / gross total / currency / line items / economic
// purpose / GL recommendation."
//
// The current mission-control projection populates `invoiceSummary`
// EXCLUSIVELY from `analyseIngestedInvoice` output (which parses
// PDF bytes via pdf-parse — never email body). This test locks that
// contract by grepping the projection source and asserting no path
// assigns `bodyTextExtract` or `bodyPreview` to an AP-fact field.
//
// Runtime shape: pure source-file inspection — no Prisma / network.

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const PROJECTION_PATH = path.join(process.cwd(), "src", "lib", "mission-control", "intelligence-review-intakes.ts");
const CARD_COMPONENT_PATH = path.join(process.cwd(), "src", "components", "mission-control", "EmailIntakeCard.tsx");

const AP_FACT_FIELDS = [
  "extractedVendor",
  "invoiceNumber",
  "gross",
  "subtotal",
  "taxTotal",
  "currency",
  "lineItems",
  "economicPurpose",
  "glAccountNumber",
];

const BODY_TEXT_SOURCES = [
  "bodyTextExtract",
  "bodyPreview",
  "bodyHtmlSanitized",
];

describe("P0-hardening · §3 body-derived AP-fact prohibition", () => {
  const projSrc = fs.readFileSync(PROJECTION_PATH, "utf8");
  const cardSrc = fs.readFileSync(CARD_COMPONENT_PATH, "utf8");

  it("mission-control projection does NOT assign a body-text source to any AP-fact field", () => {
    // For each AP-fact field name, check whether the projection
    // source contains a same-line assignment like
    // `{apFactField}: {someExpr containing bodyTextExtract | bodyPreview}`
    // The check is intentionally strict: any line that both
    // mentions the AP fact and a body source is flagged.
    const violations: string[] = [];
    const lines = projSrc.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const mentionsBody = BODY_TEXT_SOURCES.some((b) => line.includes(b));
      if (!mentionsBody) continue;
      // Look backward + forward a few lines for an AP-fact assignment.
      const window = lines.slice(Math.max(0, i - 3), Math.min(lines.length, i + 3)).join(" ");
      for (const f of AP_FACT_FIELDS) {
        // Pattern: `<field>: ...` — assignment to an AP fact key.
        const re = new RegExp(`\\b${f}\\s*:`);
        if (re.test(window) && mentionsBody) {
          violations.push(`line ${i + 1}: "${line.trim().slice(0, 100)}" — AP fact "${f}" near body-text source`);
        }
      }
    }
    expect(violations, "no AP fact may draw its value from email body text").toEqual([]);
  });

  it("card component does NOT render body text as authoritative supplier when hasAttachments is true", () => {
    // The Card renders `ap.extractedVendor.name` — which comes from
    // the projection's `invoiceSummary`, which comes from
    // analyseIngestedInvoice (PDF-only). This test asserts the card
    // does NOT read `msg.bodyTextExtract` / `preview` and route it
    // into any supplier / invoice / amount / total / currency slot.
    const violations: string[] = [];
    const lines = cardSrc.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const mentionsBody = BODY_TEXT_SOURCES.some((b) => line.includes(b));
      if (!mentionsBody) continue;
      const window = lines.slice(Math.max(0, i - 3), Math.min(lines.length, i + 3)).join(" ");
      // Any assignment of body text to a supplier / amount / etc.
      for (const f of ["vendor", "supplier", "invoiceNumber", "gross", "amount", "total", "subtotal", "tax"]) {
        // We look for JSX / var patterns that would route body text
        // into an authoritative AP slot.
        const re = new RegExp(`\\b${f}\\b\\s*=`);
        if (re.test(window) && mentionsBody) {
          violations.push(`line ${i + 1}: "${line.trim().slice(0, 100)}" — body text near "${f}"`);
        }
      }
    }
    expect(violations, "card must never assign body-text values to authoritative AP fields").toEqual([]);
  });

  it("analyseIngestedInvoice is the ONLY function that populates the invoiceSummary AP facts", () => {
    // Structural check on the projection: the assignment to `value:
    // LinkedIntelligenceForEmail["invoiceSummary"]` block MUST source
    // its fields from `extraction`, `analysis`, or downstream helpers
    // — never from a raw `emailMessage.body*` reference.
    const marker = 'const value: LinkedIntelligenceForEmail["invoiceSummary"] = {';
    const start = projSrc.indexOf(marker);
    expect(start).toBeGreaterThan(0);
    // Grab the value{} block up to the first standalone "};" on
    // its own line — good enough for a source-contract check.
    const tail = projSrc.slice(start, start + 4000);
    for (const body of BODY_TEXT_SOURCES) {
      expect(
        tail.includes(body),
        `the invoiceSummary construction block must NOT reference ${body} — the analyser (PDF bytes) is the only authoritative source`,
      ).toBe(false);
    }
  });
});
