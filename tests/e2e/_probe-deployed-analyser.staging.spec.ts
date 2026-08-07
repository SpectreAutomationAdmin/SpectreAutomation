// Diagnostic probe (temporary) — hit /api/ap-intelligence/replay-
// analyse on staging with the DMM corpus fixture and print the
// deployed analyser's supplier + payref + total. Confirms whether
// the running image contains the Slice 3 hotfix code paths.

import { test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

const availability = stagingCredsAvailable();

test.describe("probe deployed analyser", () => {
  test.skip(!availability.ready, availability.reason ?? "creds unavailable");

  test("run DMM fixture through /api/ap-intelligence/replay-analyse on staging", async ({ context }) => {
    const page = await loginAsFounder(context);
    const c = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), "tests/ap-benchmark/corpus/dev/dmm-energy-fuel.case.json"), "utf8"),
    );
    const res = await page.request.post(`${availability.baseURL}/api/ap-intelligence/replay-analyse`, {
      data: { text: c.source.text, emailSenderAddress: c.source.email.senderAddress },
    });
    console.log("HTTP:", res.status());
    const body = await res.json();
    console.log("supplier:", body.invoice?.vendor?.guessedName ?? body.supplier?.value ?? null);
    console.log("invoiceNumber:", body.invoice?.invoiceNumber ?? null);
    console.log("total:", body.invoice?.total ?? null);
    console.log("currency:", body.invoice?.currency ?? null);
    console.log("ruleVersion:", body.invoice?.ruleVersion ?? null);
    console.log("selection.supplier:", JSON.stringify(body.selection?.supplier ?? null));
    console.log("selection.payref:", JSON.stringify(body.selection?.payableReference ?? null));
  });
});
