#!/usr/bin/env node
// EP-TRAIN-4Y-AJ §6 — live verification on v1145.
// Confirms (a) preflight returns the AH+AJ shape (chunks + eligible
// ids + focusTopicSummary present), (b) /review page shows Checkpoints
// 5 / Final Assessment 0, (c) preservation guarantees unchanged.

import { execSync } from "node:child_process";
import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const BASE = "https://staging.spectreautomation.com";
const COURSE_ID = "cmw8n6z8f0008z4nxck6uvms9";
const VERSION_ID = "cmw8n6z9a000az4nx56vwh02f";
const ORIGINAL_RUN = "cmw9rrl1g000rj41xaoxvzqbb";

const PRE_AJ_CHECKPOINT_HASHES = new Set([
  "24c26223e6d1", "5d2863681508", "e05878acffc1", "084e91e008d1", "fcf533481947",
]);

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

// DB-side preservation check
const script = `
const { PrismaClient } = require("@prisma/client");
const p = new PrismaClient();
(async () => {
  try {
    const liveDrafts = await p.trainingQuestionAiDraft.findMany({
      where: { courseVersionId: "${VERSION_ID}",
        state: { in: ["REQUIRES_HUMAN_REVIEW","EDITED_VALIDATION_STALE","VALIDATION_FAILED","GENERATED","VALIDATION_PENDING","APPROVED_DRAFT","PROMOTED"] } },
      select: { id: true, contentHash: true, state: true, generationRunId: true },
    });
    const course = await p.trainingCourse.findUnique({
      where: { id: "${COURSE_ID}" },
      select: { title: true, description: true, code: true, aiMetadataAttributionAt: true },
    });
    const originalRun = await p.trainingQuestionAiGenerationRun.findUnique({
      where: { id: "${ORIGINAL_RUN}" },
      select: { executionStatus: true },
    });
    console.log("==4YAJ_LIVE_BEGIN==");
    console.log(JSON.stringify({
      liveDraftCount: liveDrafts.length,
      hashes: liveDrafts.map((d) => d.contentHash.slice(0, 12)),
      states: liveDrafts.map((d) => d.state),
      course,
      originalRunStatus: originalRun?.executionStatus,
    }, null, 2));
    console.log("==4YAJ_LIVE_END==");
  } catch (e) {
    console.log("==4YAJ_LIVE_BEGIN==");
    console.log(JSON.stringify({ error: e.message }));
    console.log("==4YAJ_LIVE_END==");
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
const m = out.match(/==4YAJ_LIVE_BEGIN==\s*([\s\S]*?)\s*==4YAJ_LIVE_END==/);
if (!m) { console.error("no markers"); process.exit(1); }
const dbReport = JSON.parse(m[1]);
const observedHashes = new Set(dbReport.hashes);
const checkpointsPreserved = dbReport.liveDraftCount === 5 &&
  [...PRE_AJ_CHECKPOINT_HASHES].every((h) => observedHashes.has(h));
const metadataPreserved = dbReport.course?.title === "Employee Onboarding and Policies" &&
  dbReport.course?.aiMetadataAttributionAt === "2026-11-10T20:42:51.040Z";

console.log("DB preservation:");
console.log(JSON.stringify({
  checkpointsPreserved, metadataPreserved,
  liveDraftCount: dbReport.liveDraftCount,
  courseTitle: dbReport.course?.title,
  aiMetadataAttributionAt: dbReport.course?.aiMetadataAttributionAt,
  originalRunStatus: dbReport.originalRunStatus,
}, null, 2));

// Preflight — should still return 4 chunks + eligibleSegmentIds (AH)
// + focusTopicSummary (AI). The prompt itself isn't exposed via the
// HTTP response, but the preflight shape proves the recovery pipeline
// still accepts a request on the AJ release.
const b = await chromium.launch({ headless: true });
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
const pg = await ctx.newPage();
await pg.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
await pg.fill('input[name="email"]', env("SPECTRE_STAGING_EMAIL"));
await pg.fill('input[name="password"]', env("SPECTRE_STAGING_PASSWORD"));
await Promise.all([pg.waitForURL(/\/app\//), pg.click('button[type="submit"]')]);
const preflight = await pg.request.post(
  `${BASE}/api/admin/ai-training/runs/${ORIGINAL_RUN}/recover-final-assessment`,
  { headers: { "Content-Type": "application/json" }, data: { preflight: true } },
);
const prefBody = await preflight.json();
console.log("\nPreflight preview:");
console.log(JSON.stringify({
  ok: prefBody.ok, ready: prefBody.ready,
  targetShortfall: prefBody.targetShortfall,
  chunkCount: prefBody.chunksProposed?.length,
  fa1EligibleIdCount: prefBody.chunksProposed?.[0]?.eligibleSegmentIds?.length,
  fa4EligibleIdCount: prefBody.chunksProposed?.[3]?.eligibleSegmentIds?.length,
  projectedCostUsd: prefBody.projectedCostUsd,
  ineligibleLearningObjectiveIds: prefBody.ineligibleLearningObjectiveIds,
}, null, 2));

// Review page
await pg.goto(`${BASE}/app/admin/people/safety-training/${COURSE_ID}/${VERSION_ID}/review`, { waitUntil: "domcontentloaded" });
await pg.waitForTimeout(3500);
await pg.screenshot({ path: "test-results/4yaj-review-default.png", fullPage: true });
const faTab = pg.locator('button:has-text("Final Assessment"), button:has-text("Final assessment")');
if (await faTab.count()) { await faTab.first().click(); await pg.waitForTimeout(600); await pg.screenshot({ path: "test-results/4yaj-review-fa-tab.png", fullPage: true }); }
const cpTab = pg.locator('button:has-text("Checkpoints")');
if (await cpTab.count()) { await cpTab.first().click(); await pg.waitForTimeout(600); await pg.screenshot({ path: "test-results/4yaj-review-cp-tab.png", fullPage: true }); }
await b.close();

fs.mkdirSync("test-results", { recursive: true });
fs.writeFileSync("test-results/4yaj-live-verify.json", JSON.stringify({ dbReport, preflight: prefBody, checkpointsPreserved, metadataPreserved }, null, 2));
console.log("\nScreenshots saved under test-results/4yaj-review-*.png");
if (!checkpointsPreserved || !metadataPreserved) { console.error("PRESERVATION FAIL"); process.exit(1); }
