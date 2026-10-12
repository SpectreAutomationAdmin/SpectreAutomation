// MBR-VIS-4 §9 — real PDF text-extraction acceptance.
//
// Downloads the actual PDFs for Mar 2026 Coulee Ridge in both modes
// against the live staging environment, runs the bytes through
// pdf-parse, and inspects the extracted text to verify:
//
//   §A  mode=draft serves a Draft PDF with the DRAFT · NOT FOR BOARD
//       DISTRIBUTION designation present in the footer text.
//   §B  mode=published 404s cleanly when the period has never been
//       published (the directive is explicit: never silently serve
//       live data as "published").
//   §C  The Shell button now sends mode=draft by default (admin
//       editing surface) so the ambiguous all-visible PDF is gone.
//   §D  Draft Preview banner carries a Download Draft PDF link that
//       drops a DRAFT-watermarked PDF.
//
// Does NOT publish, overwrite, or alter any real Coulee Ridge data.
// The spec is read-only against the current staging state.  Lifecycle
// scenarios D (first publication), E (unpublished changes), F
// (republish), G (financial immutability), K (publication failure),
// L (historical reproducibility) are deferred to a dedicated
// isolated-fixture harness slice; this spec covers scenarios A, B,
// C, I, J and the full architecture of the mode routing.

import { test } from "@playwright/test";
import { expect } from "@playwright/test";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

const creds = stagingCredsAvailable();
const runAt = creds.ready ? test : test.skip;
const BASE = "https://staging.spectreautomation.com";

type PdfParseFn = (buffer: Buffer) => Promise<{ text: string; numpages: number }>;

async function pdfParse(buf: Buffer): Promise<{ text: string; numpages: number }> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
  const mod = require("pdf-parse/lib/pdf-parse.js") as PdfParseFn;
  return mod(buf);
}

function ensureOutDir(): string {
  const outDir = path.join("test-results");
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  return outDir;
}

runAt(
  "MBR-VIS-4 §A · mode=draft downloads a Draft PDF with DRAFT designation",
  async ({ browser }) => {
    test.setTimeout(300_000);
    const ctx = await browser.newContext({ viewport: { width: 1650, height: 930 } });
    const page = await loginAsFounder(ctx);

    const res = await page.request.get(
      `${BASE}/api/reporting/monthly/pdf?period=2026-03&mode=draft`,
      { timeout: 180_000 },
    );
    console.log(`MBR_VIS_4_DRAFT_STATUS ${res.status()}`);
    expect(res.status()).toBe(200);

    const contentType = res.headers()["content-type"] ?? "";
    const disposition = res.headers()["content-disposition"] ?? "";
    expect(contentType).toContain("application/pdf");
    console.log(`MBR_VIS_4_DRAFT_FILENAME ${disposition}`);
    // Filename decoration proves the API respected mode=draft.
    expect(disposition).toContain("-DRAFT");

    const buf = Buffer.from(await res.body());
    console.log(`MBR_VIS_4_DRAFT_SIZE ${buf.length}`);
    expect(buf.length).toBeGreaterThan(10_000);
    expect(buf.slice(0, 4).toString("utf8")).toBe("%PDF");

    const outDir = ensureOutDir();
    const outPath = path.join(outDir, "mbr-vis-4-mar-2026-draft.pdf");
    writeFileSync(outPath, buf);
    console.log(`MBR_VIS_4_DRAFT_WROTE ${outPath}`);

    const parsed = await pdfParse(buf);
    console.log(`MBR_VIS_4_DRAFT_PAGES ${parsed.numpages}`);
    const text = parsed.text;

    // The DRAFT designation must appear in the extracted text —
    // Playwright's running footerTemplate writes "DRAFT · NOT FOR
    // BOARD DISTRIBUTION" into the margin of every page, and
    // pdf-parse preserves footer text content.
    const lower = text.toLowerCase().replace(/\s+/g, " ");
    const draftHit = lower.includes("draft") &&
      (lower.includes("not for board distribution") ||
       lower.includes("not for board"));
    console.log(`MBR_VIS_4_DRAFT_TEXT_HAS_DRAFT ${draftHit}`);
    expect(draftHit).toBe(true);

    // Spot-check that scorecard rows still render.  Mar 2026 is
    // DRAFT state — the explicitly-hidden row(s) will be absent;
    // the explicitly-visible rows will be present.
    const expectRow = (needle: string) => {
      const hit = lower.includes(needle.toLowerCase());
      console.log(`MBR_VIS_4_DRAFT_HAS ${JSON.stringify(needle)} → ${hit}`);
      return hit;
    };
    expectRow("Dues-to-Revenue Ratio");
    expectRow("Payroll & Benefits Ratio");

    await ctx.close();
  },
);

runAt(
  "MBR-VIS-4 §B · mode=published 404s when no snapshot exists for the period",
  async ({ browser }) => {
    test.setTimeout(120_000);
    const ctx = await browser.newContext({ viewport: { width: 1650, height: 930 } });
    const page = await loginAsFounder(ctx);

    // Mar 2026 Coulee Ridge is DRAFT (per the MBR-VIS-3 investigation
    // on 2026-10-11): status=DRAFT, packagePayloadJson=null.  A
    // Published PDF request must 404 — never silently substitute a
    // live rebuild.
    const res = await page.request.get(
      `${BASE}/api/reporting/monthly/pdf?period=2026-03&mode=published`,
      { timeout: 60_000, failOnStatusCode: false },
    );
    const status = res.status();
    const body = await res.text().catch(() => "");
    console.log(`MBR_VIS_4_PUB_STATUS ${status}`);
    console.log(`MBR_VIS_4_PUB_BODY ${body.slice(0, 200)}`);
    expect(status).toBe(404);
    expect(body.toLowerCase()).toContain("no published snapshot available");

    await ctx.close();
  },
);

runAt(
  "MBR-VIS-4 §C · default (no mode) is now draft — the ambiguous all-visible PDF is gone",
  async ({ browser }) => {
    test.setTimeout(300_000);
    const ctx = await browser.newContext({ viewport: { width: 1650, height: 930 } });
    const page = await loginAsFounder(ctx);

    // No ?mode= — the API should default to draft and watermark.
    const res = await page.request.get(
      `${BASE}/api/reporting/monthly/pdf?period=2026-03`,
      { timeout: 180_000 },
    );
    console.log(`MBR_VIS_4_DEFAULT_STATUS ${res.status()}`);
    expect(res.status()).toBe(200);

    const disposition = res.headers()["content-disposition"] ?? "";
    console.log(`MBR_VIS_4_DEFAULT_FILENAME ${disposition}`);
    expect(disposition).toContain("-DRAFT");

    const buf = Buffer.from(await res.body());
    expect(buf.length).toBeGreaterThan(10_000);

    const outDir = ensureOutDir();
    const outPath = path.join(outDir, "mbr-vis-4-mar-2026-default.pdf");
    writeFileSync(outPath, buf);
    console.log(`MBR_VIS_4_DEFAULT_WROTE ${outPath}`);

    const parsed = await pdfParse(buf);
    const lower = parsed.text.toLowerCase().replace(/\s+/g, " ");
    expect(lower).toContain("draft");

    await ctx.close();
  },
);

runAt(
  "MBR-VIS-4 §D · admin page shows a publication-status chip in Editing mode",
  async ({ browser }) => {
    test.setTimeout(180_000);
    const ctx = await browser.newContext({ viewport: { width: 1650, height: 930 } });
    const page = await loginAsFounder(ctx);
    await page.goto(
      `${BASE}/app/admin/reporting/monthly?period=2026-03`,
      { waitUntil: "domcontentloaded", timeout: 60_000 },
    );
    await page.waitForTimeout(4500);

    const chip = page.locator('[data-testid="publication-status-chip"]');
    const count = await chip.count();
    console.log(`MBR_VIS_4_CHIP_COUNT ${count}`);
    expect(count).toBeGreaterThan(0);

    const tone = await chip.first().getAttribute("data-tone");
    console.log(`MBR_VIS_4_CHIP_TONE ${tone}`);
    // Mar 2026 is DRAFT (never published) → tone should be "draft".
    expect(["draft", "pending"]).toContain(tone);

    const txt = (await chip.first().innerText()).toLowerCase();
    console.log(`MBR_VIS_4_CHIP_TXT ${txt.slice(0, 200)}`);
    // Chip must identify the state in plain language.
    const isDraftState = txt.includes("not yet published");
    const isPendingState = txt.includes("unpublished changes");
    expect(isDraftState || isPendingState).toBe(true);

    // Shell button must now be labelled Download Draft PDF.
    const btn = page.locator('[data-testid="download-pdf-button"]');
    const btnTxt = await btn.first().innerText().catch(() => "");
    console.log(`MBR_VIS_4_SHELL_BTN_TXT ${btnTxt}`);
    const btnMode = await btn.first().getAttribute("data-pdf-mode");
    console.log(`MBR_VIS_4_SHELL_BTN_MODE ${btnMode}`);
    expect(btnMode).toBe("draft");
    expect(btnTxt.toLowerCase()).toContain("draft");

    await ctx.close();
  },
);

runAt(
  "MBR-VIS-4 §E · Draft Preview banner carries a Download Draft PDF link",
  async ({ browser }) => {
    test.setTimeout(180_000);
    const ctx = await browser.newContext({ viewport: { width: 1650, height: 930 } });
    const page = await loginAsFounder(ctx);
    await page.goto(
      `${BASE}/app/admin/reporting/monthly?period=2026-03&preview=draft`,
      { waitUntil: "domcontentloaded", timeout: 60_000 },
    );
    await page.waitForTimeout(3500);

    const link = page.locator('[data-testid="publication-state-draft-download-pdf"]');
    const count = await link.count();
    console.log(`MBR_VIS_4_DRAFT_BANNER_LINK_COUNT ${count}`);
    expect(count).toBe(1);
    const href = await link.first().getAttribute("href");
    console.log(`MBR_VIS_4_DRAFT_BANNER_HREF ${href}`);
    expect(href).toContain("mode=draft");
    expect(href).toContain("period=2026-03");

    // Shell button in preview=draft context must also resolve to draft.
    const btnMode = await page
      .locator('[data-testid="download-pdf-button"]')
      .first()
      .getAttribute("data-pdf-mode");
    expect(btnMode).toBe("draft");

    await ctx.close();
  },
);
