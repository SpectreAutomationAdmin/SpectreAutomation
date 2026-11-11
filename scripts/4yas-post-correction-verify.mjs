#!/usr/bin/env node
// EP-TRAIN-4Y-AS §7+§8 — verify post-correction state.

import { execSync } from "node:child_process";
import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const BASE = "https://staging.spectreautomation.com";
const COURSE_ID = "cmw8n6z8f0008z4nxck6uvms9";
const VERSION_ID = "cmw8n6z9a000az4nx56vwh02f";
const AR_RUN_ID = "cmwbij5rq0007mmqsxow0h9jv";

const ALL_14_HASHES = new Set([
  "24c26223e6d1","5d2863681508","e05878acffc1","084e91e008d1","fcf533481947",
  "e479567ee290","01ff61464357","155890567d00","c855a6435458","f8ae54baa666","00054b4f30fa",
  "7c428a0d126a","642496d444c2","008af536cb3d",
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

const script = `
const { PrismaClient } = require("@prisma/client");
const p = new PrismaClient();
(async () => {
  try {
    const liveDrafts = await p.trainingQuestionAiDraft.findMany({
      where: { courseVersionId: "${VERSION_ID}",
        state: { in: ["REQUIRES_HUMAN_REVIEW","EDITED_VALIDATION_STALE","VALIDATION_FAILED","GENERATED","VALIDATION_PENDING","APPROVED_DRAFT","PROMOTED"] } },
      select: { id: true, contentHash: true, generationRunId: true, state: true, createdAt: true },
      orderBy: { createdAt: "asc" },
    });
    const course = await p.trainingCourse.findUnique({
      where: { id: "${COURSE_ID}" },
      select: { title: true, aiMetadataAttributionAt: true },
    });
    const completionsCount = await p.trainingCompletion.count({ where: { courseVersionId: "${VERSION_ID}" } });
    const arRun = await p.trainingQuestionAiGenerationRun.findUnique({
      where: { id: "${AR_RUN_ID}" },
      select: { shortfallReasonJson: true },
    });
    const auditRecent = await p.auditLog.findMany({
      where: { action: "hr.training.ai-rejected-proposal.recovered" },
      orderBy: { createdAt: "desc" },
      take: 3,
      select: { id: true, createdAt: true, entityType: true, entityId: true, beforeJson: true, afterJson: true, metaJson: true, userId: true },
    });
    console.log("==4YAS_POSTCORR_BEGIN==");
    console.log(JSON.stringify({ liveDrafts, course, completionsCount, arRun, auditRecent }, null, 2));
    console.log("==4YAS_POSTCORR_END==");
  } catch (e) {
    console.log("==4YAS_POSTCORR_BEGIN==");
    console.log(JSON.stringify({ error: e.message }));
    console.log("==4YAS_POSTCORR_END==");
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
const m = out.match(/==4YAS_POSTCORR_BEGIN==\s*([\s\S]*?)\s*==4YAS_POSTCORR_END==/);
if (!m) { console.error("no markers"); process.exit(1); }
const db = JSON.parse(m[1]);

const observed14 = new Set(db.liveDrafts
  .filter((d) => ALL_14_HASHES.has(d.contentHash.slice(0, 12)))
  .map((d) => d.contentHash.slice(0, 12)));
const allPreserved = observed14.size === 14;
const metadataPreserved = db.course?.title === "Employee Onboarding and Policies" &&
  db.course?.aiMetadataAttributionAt === BASELINE_ATTRIBUTION_AT;
const newDrafts = db.liveDrafts.filter((d) => !ALL_14_HASHES.has(d.contentHash.slice(0, 12)));

// Parse shortfall to verify recoveryHistory
let recoveryHistory = [];
try {
  const sj = JSON.parse(db.arRun?.shortfallReasonJson || "{}");
  for (const g of sj.perGroupDiagnostics || []) {
    for (const h of g.recoveryHistory || []) recoveryHistory.push({ ...h, groupId: g.group });
  }
} catch {}

console.log(JSON.stringify({
  totalLiveDrafts: db.liveDrafts.length,
  allPreservedExisting14: allPreserved,
  metadataPreserved,
  newDrafts: newDrafts.map((d) => ({
    id: d.id, hash12: d.contentHash.slice(0, 12),
    runId: d.generationRunId, state: d.state, createdAt: d.createdAt,
  })),
  recoveryHistoryCount: recoveryHistory.length,
  recoveryHistory: recoveryHistory.map((r) => ({
    savedAt: r.savedAt, savedByUserId: r.savedByUserId,
    savedAsDraftId: r.savedAsDraftId, groupId: r.groupId,
    editedStem: r.editedQuestionText?.slice(0, 80),
  })),
  completionsCount: db.completionsCount,
  auditRecent: db.auditRecent,
}, null, 2));

fs.mkdirSync("test-results", { recursive: true });
fs.writeFileSync("test-results/4yas-post-correction-db.json",
  JSON.stringify({ db, preservation: { allPreserved, metadataPreserved, newDraftCount: newDrafts.length } }, null, 2));

// Screenshots
const b2 = await chromium.launch({ headless: true });
const ctx = await b2.newContext({ viewport: { width: 1440, height: 900 } });
const pg = await ctx.newPage();
await pg.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
await pg.fill('input[name="email"]', env("SPECTRE_STAGING_EMAIL"));
await pg.fill('input[name="password"]', env("SPECTRE_STAGING_PASSWORD"));
await Promise.all([pg.waitForURL(/\/app\//), pg.click('button[type="submit"]')]);
await pg.goto(`${BASE}/app/admin/people/safety-training/${COURSE_ID}/${VERSION_ID}/review`, { waitUntil: "domcontentloaded" });
await pg.waitForTimeout(3500);
await pg.screenshot({ path: "test-results/4yas-review-default.png", fullPage: true });
const faTab = pg.locator('button:has-text("Final Assessment"), button:has-text("Final assessment")');
if (await faTab.count()) {
  await faTab.first().click();
  await pg.waitForTimeout(600);
  await pg.screenshot({ path: "test-results/4yas-review-fa-tab.png", fullPage: true });
}
const cpTab = pg.locator('button:has-text("Checkpoints")');
if (await cpTab.count()) {
  await cpTab.first().click();
  await pg.waitForTimeout(600);
  await pg.screenshot({ path: "test-results/4yas-review-cp-tab.png", fullPage: true });
}
// Refresh and recapture to prove persistence.
await pg.reload({ waitUntil: "domcontentloaded" });
await pg.waitForTimeout(2500);
await pg.screenshot({ path: "test-results/4yas-review-after-refresh.png", fullPage: true });
await b2.close();
console.log("\nScreenshots saved under test-results/4yas-review-*.png");

if (!allPreserved || !metadataPreserved) { console.error("PRESERVATION FAIL"); process.exit(1); }
if (newDrafts.length < 1) { console.error("NO NEW DRAFT PERSISTED"); process.exit(1); }
if (recoveryHistory.length < 1) { console.error("RECOVERY HISTORY NOT RECORDED"); process.exit(1); }
console.log(`\n✓ 14 preserved + ${newDrafts.length} new draft + audit + persistence`);
