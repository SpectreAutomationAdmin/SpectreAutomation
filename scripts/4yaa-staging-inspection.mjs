#!/usr/bin/env node
// EP-TRAIN-4Y-AA §1 + §3 + §7 + §8 — pre-change staging inspection.
//
// Read-only probe. No GPU. No DB mutation. Pulls:
//   1. /api/admin/training/courses/<id>/metadata  →  AI title + description
//   2. /api/admin/training/versions/<id>/generation-status
//        → drafts breakdown + shortfall + dedup decisions per group
//   3. /api/admin/ai-training/drafts (filtered by courseVersion)
//        → full question text + options + sourceSegmentIds (for §7)
//
// Output: test-results/4yaa-staging-inspection.json  (+ summary printed)

import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.SPECTRE_STAGING_BASE_URL ?? "https://staging.spectreautomation.com";
const COURSE_ID = "cmw8n6z8f0008z4nxck6uvms9";
const VERSION_ID = "cmw8n6z9a000az4nx56vwh02f";
const RUN_ID_EXPECTED = "cmw9rrl1g000rj41xaoxvzqbb";

function env(k) {
  if (process.env[k]) return process.env[k];
  for (const f of [".env.playwright.local", ".env.staging.local", ".env.local"]) {
    const p = path.join(process.cwd(), f);
    if (!fs.existsSync(p)) continue;
    for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z_0-9]+)\s*=\s*(.*)\s*$/);
      if (m && m[1] === k) return m[2].replace(/^["']|["']$/g, "");
    }
  }
  return null;
}
const EMAIL = env("SPECTRE_STAGING_EMAIL");
const PW = env("SPECTRE_STAGING_PASSWORD");
if (!EMAIL || !PW) {
  console.error("SPECTRE_STAGING_EMAIL / PASSWORD required");
  process.exit(2);
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1100 } });
  const page = await ctx.newPage();

  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
  await page.fill('input[name="email"]', EMAIL);
  await page.fill('input[name="password"]', PW);
  await Promise.all([
    page.waitForURL(/\/app\//, { timeout: 30_000 }),
    page.click('button[type="submit"]'),
  ]);

  const out = { capturedAt: new Date().toISOString(), base: BASE, courseId: COURSE_ID, versionId: VERSION_ID };

  // ─── 1. Course metadata ─────────────────────────────────────────
  const r1 = await page.request.get(`${BASE}/api/admin/training/courses/${COURSE_ID}/metadata`);
  out.metadata = r1.ok() ? await r1.json() : { status: r1.status() };

  // ─── 2. Generation status ───────────────────────────────────────
  const r2 = await page.request.get(`${BASE}/api/admin/training/versions/${VERSION_ID}/generation-status`);
  out.generationStatus = r2.ok() ? await r2.json() : { status: r2.status() };
  const observedRunId = out.generationStatus?.runId ?? null;
  out.observedRunIdMatchesPilot = observedRunId === RUN_ID_EXPECTED;

  // ─── 3. Drafts (full, with options + segments) ──────────────────
  // The list endpoint returns summary rows; we need the individual
  // draft payloads with full question text. Iterate /api/admin/ai-training/drafts/<id>.
  const r3 = await page.request.get(
    `${BASE}/api/admin/ai-training/drafts?limit=50&states=REQUIRES_HUMAN_REVIEW,APPROVED_DRAFT,REJECTED,GENERATED,VALIDATION_PENDING,VALIDATION_FAILED`,
  );
  const draftsList = r3.ok() ? await r3.json() : { rows: [] };
  const theseDrafts = (draftsList.rows ?? []).filter((d) => d.courseVersionId === VERSION_ID);
  out.draftsForThisVersion_count = theseDrafts.length;
  out.drafts = [];
  for (const d of theseDrafts) {
    const id = d.draftId ?? d.id;
    const r = await page.request.get(`${BASE}/api/admin/ai-training/drafts/${id}`);
    const body = r.ok() ? await r.json() : { httpStatus: r.status() };
    out.drafts.push({ listSummary: d, detail: body });
  }

  // ─── 4. Run cancel endpoint for the completed run (idempotent;
  //       confirms the run is known & shows its shortfallReason) ───
  // Skip the cancel call itself; just inspect the list endpoint
  // behaviour by reading generationStatus above.

  fs.mkdirSync("test-results", { recursive: true });
  const outPath = path.join("test-results", "4yaa-staging-inspection.json");
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));

  console.log("━━━━━━━━━━━━━━ 4Y-AA PRE-CHANGE INSPECTION ━━━━━━━━━━━━━━");
  console.log(`  captured:                   ${out.capturedAt}`);
  console.log(`  course.title:               ${out.metadata?.course?.title ?? "(?)"}`);
  console.log(`  course.description (chars): ${(out.metadata?.course?.description ?? "").length}`);
  console.log(`  description (first 240):    ${(out.metadata?.course?.description ?? "").slice(0, 240)}`);
  console.log(`  attribution.source:         ${out.metadata?.course?.attribution?.source ?? "(?)"}`);
  console.log(`  attribution.runId:          ${out.metadata?.course?.attribution?.runId ?? "(?)"}`);
  console.log(`  generationStatus.state:     ${out.generationStatus?.state}`);
  console.log(`  generationStatus.runId:     ${out.generationStatus?.runId}`);
  console.log(`  observedRun==pilot:         ${out.observedRunIdMatchesPilot}`);
  console.log(`  draftCount:                 ${out.generationStatus?.draftCount}`);
  console.log(`  breakdown:                  ${JSON.stringify(out.generationStatus?.draftBreakdown)}`);
  const sf = out.generationStatus?.shortfall;
  if (sf && typeof sf === "object") {
    console.log(`  shortfall.generatedCount:   ${sf.generatedCount}`);
    console.log(`  shortfall.shortfall:        ${sf.shortfall}`);
    console.log(`  shortfall.dedupDecisions#:  ${(sf.dedupDecisions ?? []).length}`);
    const groups = {};
    for (const d of sf.dedupDecisions ?? []) {
      groups[d.group] = (groups[d.group] ?? 0) + 1;
    }
    console.log(`  dedup groups:               ${JSON.stringify(groups)}`);
    console.log(`  shortfall.reason:           ${sf.reason}`);
  } else {
    console.log(`  shortfall:                  (none persisted)`);
  }
  console.log(`\n  --- ${out.drafts.length} drafts ---`);
  out.drafts.forEach((d, i) => {
    const detail = d.detail ?? {};
    const body = detail.draft ?? detail.body ?? detail;
    const qt = body?.questionText ?? d.listSummary?.topic ?? "?";
    const segs = body?.sourceSegmentIds ?? [];
    const opts = (body?.options ?? []).map((o) => `  ${o.isCorrect ? "✓" : " "} ${o.text}`);
    const rx = /according to the transcript|according to the evidence|evidence window|segments?\s*\[|segment\s+\d+|transcript segments?/i;
    const match = rx.test(qt);
    console.log(`  [${i + 1}] state=${d.listSummary?.state}  verdict=${d.listSummary?.latestVerdict}  segs=${JSON.stringify(segs)}`);
    console.log(`       Q: ${qt}`);
    for (const line of opts) console.log(`       ${line}`);
    if (match) console.log(`       ⚠️  internal source-ref phrasing detected`);
  });
  console.log(`\n  output JSON: ${outPath}`);
  await browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
