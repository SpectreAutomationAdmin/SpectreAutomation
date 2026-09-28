// WI-2B.6 — post-fix smoke check on staging v591.
//
// Confirms:
//   (a) The temporary WI-2B.6 diagnostic fields are GONE from the
//       /ap-evidence route response.
//   (b) The route still returns 200 with the accepted extraction
//       fields (invoiceDate / dueDate / lineItemCount) intact.

import { test, expect } from "@playwright/test";
import { loginAs } from "./_lib/staging-auth";

const BASE_URL = "https://staging.spectreautomation.com";
const CTRL_EMAIL = "fixture.controller.3e@spectre.test";
const FIXTURE_PW = "spectre-3e-fixture";
// AP_INVOICE_REVIEW child WI for invoice #200824 (PAY NOW's doc).
const CHILD_AP_WI_200824 = "cmstrkoyy030913qwre6er2cq";

test.use({ trace: "off", video: "off" });
test.describe.configure({ mode: "serial" });

test("WI-2B.6 · diagnostic fields removed from /ap-evidence", async ({ browser }) => {
  test.setTimeout(60_000);
  const ctx = await browser.newContext();
  const page = await loginAs(ctx, CTRL_EMAIL, FIXTURE_PW);
  const res = await page.request.get(`${BASE_URL}/api/mission-control/work-intake/${CHILD_AP_WI_200824}/ap-evidence`);
  expect(res.status()).toBe(200);
  const payload = await res.json();
  // The route still returns the accepted shape.
  expect(payload?.extraction?.state).toBeTruthy();
  expect(typeof payload?.extraction?.invoiceDate === "string" || payload?.extraction?.invoiceDate === null).toBe(true);
  expect(typeof payload?.extraction?.dueDate === "string" || payload?.extraction?.dueDate === null).toBe(true);
  expect(typeof payload?.extraction?.lineItemCount).toBe("number");
  // But the temporary diagnostic fields are gone.
  expect(payload?._wi2b6_canonicalLineItems).toBeUndefined();
  expect(payload?._wi2b6_taxComponents).toBeUndefined();
});
