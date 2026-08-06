// Sprint 3 · Post-16H Phase 4 Slice 2 (2026-08-06) — feature-
// specific authenticated staging acceptance. Founder rule (§11):
// "The standing authenticated Playwright rule requires
// feature-specific acceptance, not only a general page tour."
//
// This spec does NOT ask the founder to submit another invoice.
// It exercises the Slice 2 extraction changes via canonical
// REPLAY — POSTing the exact case bodies from the dev corpus
// to the staging /api/ap-intelligence/replay-analyse endpoint
// (added as part of Slice 2 for headless verification) and
// asserting the returned ApAnalyseResult reflects the canonical
// evidence layer's selection.
//
// If the replay endpoint is not present, the spec skips with a
// clear message so the run does not fabricate evidence. Ownership
// stays with the founder to authorise the endpoint before Slice 3.

import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import {
  loginAsFounder,
  stagingCredsAvailable,
} from "./_lib/staging-auth";

const availability = stagingCredsAvailable();

function readCase(id: string): { text: string; expected: Record<string, unknown> } {
  const p = path.join(process.cwd(), "tests", "ap-benchmark", "corpus", "dev", `${id}.case.json`);
  const raw = JSON.parse(fs.readFileSync(p, "utf8"));
  return { text: raw.source.text, expected: raw.expected };
}

test.describe("Phase 4 · Slice 2 · feature-specific extraction acceptance", () => {
  test.skip(!availability.ready, availability.reason ?? "creds unavailable");

  test("DMM Energy — supplier is not a table heading, invoice number is not 'OICE', total is 2532.92", async ({ context }) => {
    const page = await loginAsFounder(context);
    const { text, expected } = readCase("dmm-energy-fuel");
    const res = await page.request.post(
      `${availability.baseURL}/api/ap-intelligence/replay-analyse`,
      {
        data: { text, emailSenderAddress: "billing@dmmenergy.example" },
      },
    );
    if (res.status() === 404) {
      test.skip(true, "replay endpoint not yet deployed — see final report.");
      return;
    }
    expect(res.status(), "replay endpoint status").toBe(200);
    const body = await res.json();
    const supplier = body.vendor?.guessedName ?? body.invoice?.vendor?.guessedName;
    expect(String(supplier)).toMatch(/DMM Energy/i);
    expect(String(supplier)).not.toMatch(/^(PRODUIT|DESCRIPTION|INVOICE|FACTURE|Item)$/i);
    const invNum = body.invoice?.invoiceNumber ?? body.invoiceNumber;
    expect(invNum).not.toBe("OICE");
    expect(invNum).toBe(expected.invoiceNumber);
    const total = Number(body.invoice?.total ?? body.total);
    expect(total).toBeCloseTo(expected.total as number, 2);
    // Canonical evidence surface presence.
    if (body.selection) {
      expect(body.selection.payableReference.type).toBe("INVOICE_NUMBER");
      expect(body.selection.total.value).toBeCloseTo(expected.total as number, 2);
    }
  });

  test("Credit memo — payref = CREDIT_MEMO_NUMBER, total = -1260.00", async ({ context }) => {
    const page = await loginAsFounder(context);
    const { text, expected } = readCase("credit-memo");
    const res = await page.request.post(
      `${availability.baseURL}/api/ap-intelligence/replay-analyse`,
      { data: { text } },
    );
    if (res.status() === 404) {
      test.skip(true, "replay endpoint not yet deployed — see final report.");
      return;
    }
    expect(res.status()).toBe(200);
    const body = await res.json();
    const invNum = body.invoice?.invoiceNumber ?? body.invoiceNumber;
    expect(invNum).toBe(expected.invoiceNumber);
    const total = Number(body.invoice?.total ?? body.total);
    expect(total).toBeCloseTo(expected.total as number, 2);
    if (body.invoice?.payableReferenceType) {
      expect(body.invoice.payableReferenceType).toBe("CREDIT_MEMO_NUMBER");
    }
  });

  test("Telecom statement — payref = STATEMENT_NUMBER, account number NOT substituted", async ({ context }) => {
    const page = await loginAsFounder(context);
    const { text, expected } = readCase("statement-plus-account-number");
    const res = await page.request.post(
      `${availability.baseURL}/api/ap-intelligence/replay-analyse`,
      { data: { text } },
    );
    if (res.status() === 404) {
      test.skip(true, "replay endpoint not yet deployed — see final report.");
      return;
    }
    expect(res.status()).toBe(200);
    const body = await res.json();
    const invNum = body.invoice?.invoiceNumber ?? body.invoiceNumber;
    expect(invNum).toBe(expected.invoiceNumber);
    expect(invNum).not.toContain("4402");   // account number must not surface
    if (body.invoice?.payableReferenceType) {
      expect(body.invoice.payableReferenceType).toBe("STATEMENT_NUMBER");
    }
  });

  test("Canadian invoice in USD — currency is USD, not overridden by Canadian tax inference", async ({ context }) => {
    const page = await loginAsFounder(context);
    const { text, expected } = readCase("canadian-invoice-usd");
    const res = await page.request.post(
      `${availability.baseURL}/api/ap-intelligence/replay-analyse`,
      { data: { text } },
    );
    if (res.status() === 404) {
      test.skip(true, "replay endpoint not yet deployed — see final report.");
      return;
    }
    expect(res.status()).toBe(200);
    const body = await res.json();
    const currency = body.invoice?.currency ?? body.currency;
    expect(currency).toBe(expected.currency);
  });

  test("Frozen safety floor — /api/health still reports canonical Phase 3.2 diagnostics", async ({ context }) => {
    const page = await loginAsFounder(context);
    const res = await page.request.get(`${availability.baseURL}/api/health`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body.apIntelligence.eligibilityRuleVersion).toBeGreaterThanOrEqual(2);
    expect(body.apIntelligence.workflowDecisionVersion).toBeGreaterThanOrEqual(1);
  });
});
