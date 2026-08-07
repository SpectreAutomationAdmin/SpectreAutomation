// Diagnostic probe for the Slice 4-reopen orchestrator on the real
// DMM PDF. Prints the analyseResult + supplier identity view. Delete
// after acceptance.

import { test } from "@playwright/test";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

const availability = stagingCredsAvailable();

test.describe("phase 4-reopen · probe DMM identity", () => {
  test.skip(!availability.ready, availability.reason ?? "creds unavailable");

  test("dump identity result for real DMM", async ({ context }) => {
    const page = await loginAsFounder(context);
    const res = await page.request.post(`${availability.baseURL}/api/ap-intelligence/inspect-wi`, {
      data: { wiIdSuffix4: "8fk9" },
    });
    console.log("HTTP:", res.status());
    const body = await res.json();
    console.log("supplierGuessedName:", body.analyseResult?.supplierGuessedName);
    console.log("canonicalSupplierWinner:", JSON.stringify(body.analyseResult?.canonicalSupplierWinner));
    console.log("canonicalSupplierCandidates:", JSON.stringify(body.analyseResult?.canonicalSupplierCandidates?.slice(0, 3), null, 2));
  });
});
