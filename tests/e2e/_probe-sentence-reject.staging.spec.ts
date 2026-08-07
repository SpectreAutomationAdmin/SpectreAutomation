// Diagnostic probe (temporary) — confirm the deployed analyser
// rejects sentence-shaped supplier candidates per the Slice 3
// hotfix. Submits a synthetic payload that mimics the exact
// remittance-instruction sentence the real DMM WI card is showing.

import { test } from "@playwright/test";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

const availability = stagingCredsAvailable();

test.describe("probe sentence-reject on deployed analyser", () => {
  test.skip(!availability.ready, availability.reason ?? "creds unavailable");

  test("submits the DMM 'Please write...' sentence-first PDF layout via replay", async ({ context }) => {
    const page = await loginAsFounder(context);
    // Mimic a plausible real-PDF pdf-parse output where an
    // remittance instruction leads and DMM letterhead follows.
    const text = [
      "Please write your account number AND the invoice number on your cheque or return a copy of the invoice with your payment",
      "",
      "DMM Energy Inc.",
      "1234, boulevard de l'Industrie · Rouyn-Noranda QC J9X 5B7",
      "No TPS: 812345678 RT0001",
      "",
      "Invoice B0037FC",
      "Date: 2026-08-04",
      "",
      "PRODUIT                            QUANTITÉ    PRIX      MONTANT",
      "Diesel biodégradable dyed low-sulphur   1700    1.4190     2412.30",
      "",
      "                                              Subtotal:     2412.30",
      "                                              GST (5%):      120.62",
      "                                              Invoice Total: 2532.92 CAD",
    ].join("\n");
    const res = await page.request.post(
      `${availability.baseURL}/api/ap-intelligence/replay-analyse`,
      { data: { text, emailSenderAddress: "billing@dmmenergy.example" } },
    );
    console.log("HTTP:", res.status());
    const body = await res.json();
    console.log("guessedName:", body.invoice?.vendor?.guessedName);
    console.log("invoiceNumber:", body.invoice?.invoiceNumber);
    console.log("total:", body.invoice?.total);
    console.log("selection.supplier:", JSON.stringify(body.selection?.supplier));
    // Print rejected-alternates so we can see what the ranker
    // disqualified.
    console.log("supplier.rejectedAlternates:", JSON.stringify(body.selection?.supplier?.rejectedAlternates ?? []));
  });
});
