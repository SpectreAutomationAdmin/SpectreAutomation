// Phase 4R · Phase C · §C3-C5 — Completed History + immutability
// verification for Microsoft. Runs AFTER
// phase-4r-phase-c-microsoft-e2e-completion has completed the intake.
//
// Read-only — no mutation.
//
//   §C3  Completion snapshot AUTHORITATIVE — verified indirectly via
//        §C4 (Completed History renders the same authoritative facts
//        the posting action stamped into cardSnapshot).
//   §C4  Completed History renders the AUTHORITATIVE Microsoft facts:
//        supplier=Microsoft Corporation, invoice=E0701097E3,
//        amount=$31.29 CAD, GL 6062 Licenses.
//   §C5  Immutability proof — the History card facts match the
//        authoritative snapshot (not the pre-completion live extraction
//        that had "guessedName=Canada" pre-Phase-B). The Phase-A
//        automated immutability suite covers the simulated-analyser-
//        change gate (15/15 green).

import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

const OUT = "test-results/phase-4r-phase-c-microsoft-history";
fs.mkdirSync(OUT, { recursive: true });

const MICROSOFT_PARENT_WI = "cms0i8qlp0013nc7oo377f1rl";

test.describe("Phase C · §C3-C5 Microsoft Completed History (frozen facts)", () => {
  const avail = stagingCredsAvailable();
  test.skip(!avail.ready, avail.reason ?? "creds missing");
  test.setTimeout(300_000);

  test("Completed History renders the authoritative Microsoft snapshot", async ({ browser }) => {
    expect(avail.baseURL, "safety: staging-only").toMatch(/staging|localhost/i);
    const ctx = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 2,
    });
    const page = await loginAsFounder(ctx, { landing: "/app/admin?view=history" });
    await page.waitForLoadState("networkidle").catch(() => {});
    await page.screenshot({ path: path.join(OUT, "01-history-view.png"), fullPage: true });

    const card = page.locator(`[data-work-intake-item-id="${MICROSOFT_PARENT_WI}"]`).first();
    await expect(card, "Microsoft parent WI should appear in Completed History").toBeVisible({ timeout: 20_000 });
    await card.scrollIntoViewIfNeeded();

    const grab = async (selector: string) => {
      const el = card.locator(selector).first();
      if (await el.count() === 0) return null;
      return ((await el.textContent()) ?? "").trim();
    };
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
    };
    fs.writeFileSync(path.join(OUT, "history-dom.json"), JSON.stringify(dom, null, 2));
    console.log("[§C4] history DOM:", JSON.stringify(dom, null, 2));
    await card.screenshot({ path: path.join(OUT, "02-microsoft-history-card.png") });

    // §C4 — authoritative frozen facts must appear
    expect(dom.apTitle ?? "", "history card title must show Microsoft Corporation")
      .toMatch(/microsoft\s*corporation/i);
    expect(dom.apTitle ?? "", "history card title must show invoice E0701097E3")
      .toContain("E0701097E3");
    expect(dom.apAmount ?? "", "history amount must be $31.29 CAD").toMatch(/\$?\s*31\.29/);
    expect(dom.apInvoiceOrPo ?? "", "history invoice cell must be #E0701097E3").toContain("E0701097E3");
    expect(dom.apCategory ?? "", "history category must be Licenses").toMatch(/licenses/i);

    // §C5 — the pre-Phase-B live extraction returned "Canada" as the
    // supplier. The frozen snapshot must NEVER render that.
    expect(dom.apTitle ?? "", "history must NEVER render Canada as the supplier").not.toMatch(/^Canada\b/i);
    expect(dom.apWorkSummary ?? "", "history summary must NEVER read Canada as supplier").not.toMatch(/^Canada\b/i);

    await ctx.close();
  });
});
