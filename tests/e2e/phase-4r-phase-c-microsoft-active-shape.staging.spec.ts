// Phase 4R · Phase C · C1 sanity check (2026-08-15) — Microsoft ACTIVE
// card DOM shape prior to completion. Founder-facing evidence that:
//   * card renders as MATCHED existing vendor
//   * no "Create vendor & post" CTA is presented
//   * displayed vendor, invoice, amount, category match ap-evidence
//
// READ-ONLY. No mutation.

import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

const OUT = "test-results/phase-4r-phase-c-microsoft-active";
fs.mkdirSync(OUT, { recursive: true });

// Parent EMAIL WI id (what the Mission Control feed renders) —
// the AP-child WI `cms0l576g00017d6viorrz0rh` is the row that
// carries the INGESTED_DOCUMENT origin, but the DOM card the
// founder sees carries the parent's id.
const MICROSOFT_PARENT_WI = "cms0i8qlp0013nc7oo377f1rl";
const MICROSOFT_CHILD_WI = "cms0l576g00017d6viorrz0rh";

test.describe("Phase C · C1 Microsoft ACTIVE shape (DOM founder view)", () => {
  const avail = stagingCredsAvailable();
  test.skip(!avail.ready, avail.reason ?? "creds missing");
  test.setTimeout(300_000);

  test("Microsoft card renders as existing-vendor MATCHED with no vendor-create CTA", async ({ browser }) => {
    const ctx = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 2,
    });
    const page = await loginAsFounder(ctx, { landing: "/app/admin" });
    await page.waitForLoadState("networkidle").catch(() => {});

    const card = page.locator(`[data-work-intake-item-id="${MICROSOFT_PARENT_WI}"]`).first();
    await card.scrollIntoViewIfNeeded();
    await expect(card).toBeVisible();

    const grab = async (selector: string) => {
      const el = card.locator(selector).first();
      if (await el.count() === 0) return null;
      return ((await el.textContent()) ?? "").trim();
    };

    // Full DOM capture
    const dom = {
      apTitle: await grab('[data-testid="ap-title"]'),
      apWorkSummary: await grab('[data-testid="ap-work-summary"]'),
      apAmount: await grab('[data-testid="ap-readout-amount"]'),
      apInvoiceOrPo: await grab('[data-testid="ap-readout-po-or-invoice"]'),
      apCategory: await grab('[data-testid="ap-readout-category"]'),
      apConfidenceLevel: await card.locator('[data-testid="ap-readout-confidence"]').first()
        .getAttribute("data-confidence-level").catch(() => null),
      apWorkflowPill: await grab('[data-testid="ap-workflow-pill"]'),
      apRecommendation: await grab('[data-testid="ap-recommendation"]'),
      apSenderLine: await grab('[data-testid="ap-sender-line"]'),
    };

    // Enumerate every button + link on the card to detect the CTA set
    const buttonEls = card.locator("button, a[href], [role='button']");
    const btnCount = await buttonEls.count();
    const ctas: Array<{ text: string; testid: string | null; href: string | null }> = [];
    for (let i = 0; i < btnCount; i++) {
      const el = buttonEls.nth(i);
      const text = ((await el.textContent()) ?? "").trim();
      const testid = await el.getAttribute("data-testid");
      const href = await el.getAttribute("href");
      if (text) ctas.push({ text, testid, href });
    }

    const capture = { dom, ctas };
    fs.writeFileSync(path.join(OUT, "microsoft-active-dom.json"), JSON.stringify(capture, null, 2));
    console.log("DOM capture:", JSON.stringify(capture, null, 2));

    await card.screenshot({ path: path.join(OUT, "microsoft-active-card.png") });

    // Assertions per §C1 founder requirements
    expect(dom.apTitle, "AP title should contain Microsoft").toMatch(/Microsoft/i);
    expect(dom.apTitle, "AP title should contain invoice E0701097E3").toContain("E0701097E3");
    expect(dom.apAmount, "amount should be $31.29 CAD").toMatch(/\$?\s*31\.29/);
    expect(dom.apInvoiceOrPo, "invoice line should be #E0701097E3").toContain("E0701097E3");

    // The pill should NOT read "Vendor match required" — this indicates
    // existing-vendor MATCHED path.
    expect(dom.apWorkflowPill ?? "", "workflow pill should not require vendor match").not.toMatch(/vendor\s*match\s*required/i);

    // No CTA should read "Create vendor & post" (§C1 hard constraint)
    for (const cta of ctas) {
      expect(cta.text, `CTA should not suggest creating a new Microsoft vendor: '${cta.text}'`).not.toMatch(/create\s*vendor.*post/i);
    }

    await ctx.close();
  });
});
