// Phase 4R · Phase B v2 (2026-08-15) — §B8 real regression set on
// staging web v218. Read-only. Captures ap-evidence per fixture and
// compares against the last founder-accepted baseline (v217).
//
// Fixtures (per founder authorization):
//   Club Support #220824 / #200824  — cs200824  cmstrkoyy030913qwre6er2cq
//   Club Support #221178            — cs221178  cmsmhak530wv7ppa0lrncy9ib
//   DMM B0037FC                     — dmm       cmsgpxuyy000711jt094a8uyu
//   Oakcreek #1091559               — oak91559  cms6yc9tf02xvyy77w2io64kn
//   Oakcreek #1087769               — oak87769  cms6xwpvc01o1yy77rkso7b0b
//   OXIO                            — oxio      resolved via snapshot-summary (suffix c7g773n5)
//   CPA Alberta (primary)           — cpa       resolved via snapshot-summary (suffix fr09w3bz)
//   CPA Alberta (KTVD duplicate)    — cpa_ktvd  resolved via snapshot-summary (suffix ends 'ktvd')
//
// Diagnostic only — no code path is mutated by this run.

import { test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

const OUT = "test-results/phase-4r-phase-b-v2-regression-set";
fs.mkdirSync(OUT, { recursive: true });

interface Case { key: string; wiId?: string; wiSuffix?: string }
const KNOWN: Case[] = [
  { key: "cs200824",  wiId: "cmstrkoyy030913qwre6er2cq" },
  { key: "cs221178",  wiId: "cmsmhak530wv7ppa0lrncy9ib" },
  { key: "dmm",       wiId: "cmsgpxuyy000711jt094a8uyu" },
  { key: "oak91559",  wiId: "cms6yc9tf02xvyy77w2io64kn" },
  { key: "oak87769",  wiId: "cms6xwpvc01o1yy77rkso7b0b" },
];
const RESOLVE_BY_SUFFIX: Case[] = [
  // OXIO parent EMAIL WI's AP child (child WI is what has the
  // INGESTED_DOCUMENT origin ap-evidence requires).
  { key: "oxio",      wiSuffix: "c7g773n5" },
  // CPA Alberta parent EMAIL WI's AP child (documented child suffix
  // = 'aj1k'; parent suffix = 'fr09w3bz').
  { key: "cpa",       wiSuffix: "fr09w3bz" },
  // Second CPA fixture (MAIL-KTVD duplicate) — parent EMAIL suffix
  // 'ktvd'. Resolved gracefully if the card is still in the feed.
  { key: "cpa_ktvd",  wiSuffix: "ktvd" },
];

test.describe("Phase 4R · Phase B v2 §B8 real regression set", () => {
  const avail = stagingCredsAvailable();
  test.skip(!avail.ready, avail.reason ?? "creds missing");
  test.setTimeout(600_000);

  test("capture ap-evidence for every real fixture (Microsoft-adjacent controls)", async ({ browser }) => {
    const ctx = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 2,
    });
    const page = await loginAsFounder(ctx, { landing: "/app/admin" });
    const base = avail.baseURL;

    const health = await page.request.get(`${base}/api/health`);
    const healthJson = await health.json();
    fs.writeFileSync(path.join(OUT, "health.json"), JSON.stringify(healthJson, null, 2));
    console.log(`health status=${healthJson.status ?? "?"} sha=${(healthJson.sha ?? "?").slice(0,10)}`);

    // Resolve suffix → full ID via snapshot-summary
    const snap = await page.request.get(`${base}/api/mission-control/snapshot-summary`);
    const snapBody = await snap.json();
    const allIds: string[] = snapBody.workItemIds ?? [];
    fs.writeFileSync(path.join(OUT, "_snapshot.json"), JSON.stringify(snapBody, null, 2));

    // The parent EMAIL WIs have no INGESTED_DOCUMENT origin — ap-evidence
    // returns 404 on them. The AP-review CHILD WI is the one that
    // carries the document + fires ap-evidence. Resolve by scraping
    // the Mission Control DOM for [data-testid="ap-review-card"] +
    // [data-work-intake-item-id$="{parentSuffix}"] or the child's own
    // known suffix.
    await page.goto(`${base}/app/admin`, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle").catch(() => { /* ignore */ });
    // Enumerate EVERY DOM element that carries data-work-intake-item-id
    // (email-intake-card AND ap-review-card AND anything else). Child
    // AP review cards may be nested inside a parent email card.
    const allIdEls = page.locator('[data-work-intake-item-id]');
    const cardCount = await allIdEls.count();
    const apReviewWiIds: string[] = [];
    for (let i = 0; i < cardCount; i++) {
      const id = await allIdEls.nth(i).getAttribute("data-work-intake-item-id");
      const testid = await allIdEls.nth(i).getAttribute("data-testid");
      if (id) {
        apReviewWiIds.push(id);
        console.log(`[dom] id=${id} testid=${testid}`);
      }
    }
    fs.writeFileSync(path.join(OUT, "_ap-review-card-ids.json"), JSON.stringify(apReviewWiIds, null, 2));
    console.log(`[resolve] discovered ${apReviewWiIds.length} work-intake-item-id elements on Active feed`);

    const CASES: Case[] = [...KNOWN];
    for (const c of RESOLVE_BY_SUFFIX) {
      // (1) try the AP-review-card DOM list first (the child WIs)
      const domHit = apReviewWiIds.find((id) => id.endsWith(c.wiSuffix!));
      // (2) if no DOM hit, fall back to the snapshot-summary list
      //     (parents may be enough if the child suffix is known)
      const snapHit = allIds.find((id) => id.endsWith(c.wiSuffix!));
      const raw = (domHit ?? snapHit ?? "").replace(/^wi_/, "");
      if (raw) {
        CASES.push({ key: c.key, wiId: raw });
        console.log(`[resolve] ${c.key} suffix=${c.wiSuffix} → ${raw} (via=${domHit ? "dom" : "snapshot"})`);
      } else {
        console.log(`[resolve] ${c.key} suffix=${c.wiSuffix} → not found in feed (skipping)`);
      }
    }

    // Second pass: for OXIO + CPA parents whose only reachable id is the
    // parent EMAIL WI, ALSO enumerate the AP-review-card children in
    // the DOM whose parent-suffix matches the requested parent suffix.
    // This is a best-effort discovery that adds a child-shaped case
    // labelled `${key}_child` if found.
    const CHILD_SUFFIX_HINT: Record<string, string> = { cpa: "aj1k" };
    for (const c of RESOLVE_BY_SUFFIX) {
      const hint = CHILD_SUFFIX_HINT[c.key];
      if (!hint) continue;
      const child = apReviewWiIds.find((id) => id.endsWith(hint));
      if (child) {
        const raw = child.replace(/^wi_/, "");
        CASES.push({ key: `${c.key}_child`, wiId: raw });
        console.log(`[resolve] ${c.key}_child suffix=${hint} → ${raw}`);
      }
    }

    const results: Array<{
      key: string;
      wiId: string;
      httpStatus: number;
      supplier: string | null;
      taxNumber: string | null;
      vendorState: string | null;
      matchedVendorLegalName: string | null;
      matchSignals: string[];
      invoiceNumber: string | null;
      subtotal: number | null;
      taxTotal: number | null;
      total: number | null;
      currency: string | null;
      glAccountNumber: string | null;
      glAccountName: string | null;
      glConfidence: number | null;
      capitalState: string | null;
      workflowState: string | null;
      duplicateWarning: boolean | null;
    }> = [];

    for (const c of CASES) {
      const evUrl = `${base}/api/mission-control/work-intake/${c.wiId}/ap-evidence`;
      const ev = await page.request.get(evUrl);
      const body = await ev.json().catch(async () => ({ rawText: (await ev.text()).slice(0, 4000) }));
      fs.writeFileSync(
        path.join(OUT, `${c.key}-ap-evidence.json`),
        JSON.stringify({ status: ev.status(), wiId: c.wiId, url: evUrl, body }, null, 2),
      );

      const b: any = body ?? {};
      const gl0 = b.glRecommendation?.candidates?.[0] ?? null;
      const vendorTop = b.vendorResolution?.candidates?.[0] ?? null;
      const row = {
        key: c.key,
        wiId: c.wiId!,
        httpStatus: ev.status(),
        supplier: b.extraction?.vendor?.guessedName ?? null,
        taxNumber: b.extraction?.vendor?.guessedTaxNumber ?? null,
        vendorState: b.vendorResolution?.state ?? null,
        matchedVendorLegalName: vendorTop?.legalName ?? null,
        matchSignals: vendorTop?.matchSignals ?? [],
        invoiceNumber: b.extraction?.invoiceNumber ?? null,
        subtotal: b.extraction?.subtotal ?? null,
        taxTotal: b.extraction?.taxTotal ?? null,
        total: b.extraction?.total ?? null,
        currency: b.extraction?.currency ?? null,
        glAccountNumber: b.glRecommendation?.accountNumber ?? gl0?.accountNumber ?? null,
        glAccountName: b.glRecommendation?.accountName ?? gl0?.accountName ?? null,
        glConfidence: gl0?.confidence ?? null,
        capitalState: b.capitalRecommendation?.state ?? null,
        workflowState: b.workflowState ?? b.workflow?.state ?? null,
        duplicateWarning: b.duplicateWarning ?? null,
      };
      results.push(row);
      console.log(
        `[${c.key}] status=${ev.status()} supplier="${row.supplier}" ` +
        `vendor=${row.vendorState}:${row.matchedVendorLegalName} ` +
        `inv#${row.invoiceNumber} tot=${row.total} ${row.currency} ` +
        `gl=${row.glAccountNumber}:${row.glAccountName} cap=${row.capitalState}`,
      );
    }

    // For any case whose ap-evidence returned 404 (typically parent
    // EMAIL WIs without an INGESTED_DOCUMENT origin), fall back to
    // DOM inspection of the rendered email-intake-card. These fields
    // are the founder-facing acceptance evidence anyway.
    const domCaptures: Record<string, Record<string, string | null>> = {};
    for (const r of results) {
      if (r.httpStatus === 200) continue;
      const card = page.locator(`[data-work-intake-item-id="${r.wiId}"]`).first();
      const exists = await card.count();
      if (!exists) {
        domCaptures[r.key] = { note: "card not present in current feed" };
        continue;
      }
      await card.scrollIntoViewIfNeeded();
      const grab = async (selector: string) => {
        const el = card.locator(selector).first();
        if (await el.count() === 0) return null;
        return ((await el.textContent()) ?? "").trim();
      };
      domCaptures[r.key] = {
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
      await card.screenshot({ path: path.join(OUT, `${r.key}-card.png`) }).catch(() => {});
    }
    fs.writeFileSync(path.join(OUT, "_dom-captures.json"), JSON.stringify(domCaptures, null, 2));
    for (const [key, cap] of Object.entries(domCaptures)) {
      console.log(`[dom-fallback:${key}] title=${cap.apTitle} amount=${cap.apAmount} invoice=${cap.apInvoiceOrPo} category=${cap.apCategory} pill=${cap.apWorkflowPill}`);
    }

    fs.writeFileSync(path.join(OUT, "_summary.json"), JSON.stringify(results, null, 2));

    // Print a compact table for the founder-facing report
    console.log("\n=== §B8 summary ===");
    for (const r of results) {
      console.log(
        `${r.key.padEnd(10)} | supplier=${(r.supplier ?? "-").padEnd(30)} | ` +
        `vendor=${(r.vendorState ?? "-").padEnd(10)} | inv#${r.invoiceNumber ?? "-"} | ` +
        `total=${r.total ?? "-"} ${r.currency ?? ""} | gl=${r.glAccountNumber ?? "-"}`,
      );
    }

    await ctx.close();
  });
});
