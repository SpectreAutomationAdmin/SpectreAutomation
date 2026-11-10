#!/usr/bin/env node
// EP-TRAIN-4Y-AL §6 — live verify on v1146. Confirms preservation
// AND the §5 UI fix (no horizontal overflow at 1440x900).

import { execSync } from "node:child_process";
import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const BASE = "https://staging.spectreautomation.com";
const COURSE_ID = "cmw8n6z8f0008z4nxck6uvms9";
const VERSION_ID = "cmw8n6z9a000az4nx56vwh02f";
const ORIGINAL_RUN = "cmw9rrl1g000rj41xaoxvzqbb";

const PRESERVED_CHECKPOINT_HASHES = new Set([
  "24c26223e6d1", "5d2863681508", "e05878acffc1", "084e91e008d1", "fcf533481947",
]);
const PRESERVED_FA_HASHES = new Set([
  "e479567ee290", "01ff61464357", "155890567d00",
  "c855a6435458", "f8ae54baa666", "00054b4f30fa",
]);
const BASELINE_ATTRIBUTION_AT = "2026-11-10T20:42:51.040Z";

function env(k) {
  if (process.env[k]) return process.env[k];
  for (const f of [".env.playwright.local", ".env.local"]) {
    const p = path.join(process.cwd(), f);
    if (!fs.existsSync(p)) continue;
    for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z_0-9]+)\s*=\s*(.*)\s*$/);
      if (m && m[1] === k) return m[2].replace(/^["']|["']$/g, "");
    }
  }
  return null;
}

// DB preservation
const script = `
const { PrismaClient } = require("@prisma/client");
const p = new PrismaClient();
(async () => {
  try {
    const liveDrafts = await p.trainingQuestionAiDraft.findMany({
      where: { courseVersionId: "${VERSION_ID}",
        state: { in: ["REQUIRES_HUMAN_REVIEW","EDITED_VALIDATION_STALE","VALIDATION_FAILED","GENERATED","VALIDATION_PENDING","APPROVED_DRAFT","PROMOTED"] } },
      select: { id: true, contentHash: true, generationRunId: true },
    });
    const course = await p.trainingCourse.findUnique({
      where: { id: "${COURSE_ID}" },
      select: { title: true, description: true, code: true, aiMetadataAttributionAt: true },
    });
    console.log("==4YAL_LIVE_BEGIN==");
    console.log(JSON.stringify({
      liveDraftCount: liveDrafts.length,
      hashes: liveDrafts.map((d) => d.contentHash.slice(0, 12)),
      course,
    }, null, 2));
    console.log("==4YAL_LIVE_END==");
  } catch (e) {
    console.log("==4YAL_LIVE_BEGIN==");
    console.log(JSON.stringify({ error: e.message }));
    console.log("==4YAL_LIVE_END==");
  } finally { await p.$disconnect(); }
})();
`;
const b64 = Buffer.from(script, "utf8").toString("base64");
const remote = `sh -lc "cd /app && echo ${b64} | base64 -d | node"`;
const flyctl = "C:/Users/cturcato/.fly/bin/flyctl.exe";
const out = execSync(
  `"${flyctl}" ssh console --app spectre-staging --command '${remote}'`,
  { encoding: "utf8", maxBuffer: 10 * 1024 * 1024, shell: "bash.exe" },
);
const m = out.match(/==4YAL_LIVE_BEGIN==\s*([\s\S]*?)\s*==4YAL_LIVE_END==/);
if (!m) { console.error("no markers"); process.exit(1); }
const db = JSON.parse(m[1]);
const observed = new Set(db.hashes);
const allCheckpoints = [...PRESERVED_CHECKPOINT_HASHES].every((h) => observed.has(h));
const allFa = [...PRESERVED_FA_HASHES].every((h) => observed.has(h));
const metadataPreserved = db.course?.title === "Employee Onboarding and Policies" &&
  db.course?.aiMetadataAttributionAt === BASELINE_ATTRIBUTION_AT;

console.log("Preservation summary:");
console.log(JSON.stringify({
  liveDraftCount: db.liveDraftCount,
  all5CheckpointsPreserved: allCheckpoints,
  all6FaPreserved: allFa,
  metadataPreserved,
  courseTitle: db.course?.title,
  aiMetadataAttributionAt: db.course?.aiMetadataAttributionAt,
}, null, 2));

// Preflight — should still yield 4 chunks
const b = await chromium.launch({ headless: true });
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
const pg = await ctx.newPage();
await pg.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
await pg.fill('input[name="email"]', env("SPECTRE_STAGING_EMAIL"));
await pg.fill('input[name="password"]', env("SPECTRE_STAGING_PASSWORD"));
await Promise.all([pg.waitForURL(/\/app\//), pg.click('button[type="submit"]')]);
const preflight = await pg.request.post(
  `${BASE}/api/admin/ai-training/runs/${ORIGINAL_RUN}/recover-final-assessment`,
  { headers: { "Content-Type": "application/json" }, data: { preflight: true, maxPerChunk: 1 } },
);
const prefBody = await preflight.json();
console.log("\nPreflight (maxPerChunk: 1) preview:");
console.log(JSON.stringify({
  ready: prefBody.ready, targetShortfall: prefBody.targetShortfall,
  chunkCount: prefBody.chunksProposed?.length,
  chunkTargets: prefBody.chunksProposed?.map((c) => c.targetQuestionCount),
  projectedCostUsd: prefBody.projectedCostUsd,
}, null, 2));

// UI fix verification: load review, measure panel bounds
await pg.goto(`${BASE}/app/admin/people/safety-training/${COURSE_ID}/${VERSION_ID}/review`, { waitUntil: "domcontentloaded" });
await pg.waitForTimeout(3500);
const faTab = pg.locator('button:has-text("Final Assessment"), button:has-text("Final assessment")');
if (await faTab.count()) { await faTab.first().click(); await pg.waitForTimeout(600); }
await pg.screenshot({ path: "test-results/4yal-ui-after.png", fullPage: false });
const measurements = await pg.evaluate(() => {
  const panel = document.querySelector('[data-testid="manager-review-question-pane"]');
  const video = document.querySelector('[data-testid="manager-review-left"]');
  const body = document.querySelector('[data-testid="manager-review-body"]');
  const r = (el) => el?.getBoundingClientRect?.() ?? null;
  return {
    viewport: { w: window.innerWidth, h: window.innerHeight },
    panel: r(panel), video: r(video), body: r(body),
    docScrollWidth: document.documentElement.scrollWidth,
    hasHorizontalScroll: document.documentElement.scrollWidth > document.documentElement.clientWidth,
  };
});
console.log("\nUI post-fix measurements:");
console.log(JSON.stringify(measurements, null, 2));
await b.close();

fs.mkdirSync("test-results", { recursive: true });
fs.writeFileSync("test-results/4yal-live-verify.json", JSON.stringify({ db, preflight: prefBody, uiMeasurements: measurements, preservation: { allCheckpoints, allFa, metadataPreserved } }, null, 2));

if (!allCheckpoints || !allFa || !metadataPreserved) { console.error("PRESERVATION FAIL"); process.exit(1); }
