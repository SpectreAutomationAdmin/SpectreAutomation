// Phase 4 kickoff — §2 mandatory trace of the REAL MAIL-8FK9 DMM
// bytes via the deployed analyser. Prints the extractedTextSample
// + canonical candidate lists so we can see EXACTLY what the
// production analyser produces from the actual stored PDF before
// modifying any code. Delete after Slice 4 tuning is complete.

import { test } from "@playwright/test";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

const availability = stagingCredsAvailable();

test.describe("phase 4 · trace real DMM bytes", () => {
  test.skip(!availability.ready, availability.reason ?? "creds unavailable");

  test("dump inspect-wi output for MAIL-8FK9", async ({ context }) => {
    const page = await loginAsFounder(context);
    const res = await page.request.post(`${availability.baseURL}/api/ap-intelligence/inspect-wi`, {
      data: { wiIdSuffix4: "8fk9" },
    });
    console.log("HTTP:", res.status());
    const body = await res.json();
    console.log("=== extractedTextSample (first 2KB of real pdf-parse text) ===");
    console.log(body.extractedTextSample ?? "(null — no canonicalProbe run)");
    console.log("=== end sample ===");
    console.log("");
    console.log("analyseResult:", JSON.stringify(body.analyseResult ?? "(none)", null, 2));
  });
});
