#!/usr/bin/env node
import { execSync } from "node:child_process";
import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const BASE = "https://staging.spectreautomation.com";
const COURSE_ID = "cmw8n6z8f0008z4nxck6uvms9";
const VERSION_ID = "cmw8n6z9a000az4nx56vwh02f";
const ORIGINAL_RUN = "cmw9rrl1g000rj41xaoxvzqbb";
const RECOVERY_RUN = "cmwbatqv9000j3ykfqccbyt7v";

const BASELINE_HASHES = new Set([
  "24c26223e6d1", "5d2863681508", "e05878acffc1", "084e91e008d1", "fcf533481947",
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

// DB inspection — original checkpoints + recovery drafts + course
const script = `
const { PrismaClient } = require("@prisma/client");
const p = new PrismaClient();
(async () => {
  try {
    const liveDrafts = await p.trainingQuestionAiDraft.findMany({
      where: { courseVersionId: "${VERSION_ID}",
        state: { in: ["REQUIRES_HUMAN_REVIEW","EDITED_VALIDATION_STALE","VALIDATION_FAILED","GENERATED","VALIDATION_PENDING","APPROVED_DRAFT","PROMOTED"] } },
      select: { id: true, state: true, contentHash: true, generationRunId: true, generatedAt: true, draftJson: true },
      orderBy: { generatedAt: "asc" },
    });
    const originalRun = await p.trainingQuestionAiGenerationRun.findUnique({
      where: { id: "${ORIGINAL_RUN}" },
      select: { executionStatus: true, assessmentPlanJson: true, shortfallReasonJson: true, completedAt: true },
    });
    const course = await p.trainingCourse.findUnique({
      where: { id: "${COURSE_ID}" },
      select: { title: true, description: true, code: true, aiMetadataAttributionAt: true, aiMetadataAttributionSource: true },
    });
    const completionsCount = await p.trainingCompletion.count({ where: { courseVersionId: "${VERSION_ID}" } });
    const recoveryDraftIds = (await p.trainingQuestionAiDraft.findMany({
      where: { generationRunId: "${RECOVERY_RUN}" }, select: { id: true },
    })).map((d) => d.id);
    const promotedQuestionsFromRecovery = recoveryDraftIds.length === 0 ? 0 :
      await p.trainingQuestion.count({
        where: { courseVersionId: "${VERSION_ID}",
          aiPromotion: { is: { draftId: { in: recoveryDraftIds } } } },
      });
    console.log("==4YAK_POSTFIRE_BEGIN==");
    const originalCheckpoints = liveDrafts.filter((d) => d.generationRunId === "${ORIGINAL_RUN}");
    const recoveryDrafts = liveDrafts.filter((d) => d.generationRunId === "${RECOVERY_RUN}");
    console.log(JSON.stringify({
      totalLiveDrafts: liveDrafts.length,
      originalCheckpoints: originalCheckpoints.map((d) => ({ id: d.id, state: d.state, hash12: d.contentHash.slice(0,12) })),
      recoveryDrafts: recoveryDrafts.map((d) => {
        let body = {};
        try { body = JSON.parse(d.draftJson || "{}"); } catch {}
        return {
          id: d.id, state: d.state, hash12: d.contentHash.slice(0,12),
          questionText: body.questionText,
          options: (body.options ?? []).map((o) => ({ text: o.text, isCorrect: !!o.isCorrect })),
          explanation: body.explanation,
          sourceSegmentIds: body.sourceSegmentIds,
        };
      }),
      originalRunStatus: originalRun?.executionStatus,
      course,
      completionsCount,
      promotedQuestionsFromRecovery,
    }, null, 2));
    console.log("==4YAK_POSTFIRE_END==");
  } catch (e) {
    console.log("==4YAK_POSTFIRE_BEGIN==");
    console.log(JSON.stringify({ error: e.message }));
    console.log("==4YAK_POSTFIRE_END==");
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
const m = out.match(/==4YAK_POSTFIRE_BEGIN==\s*([\s\S]*?)\s*==4YAK_POSTFIRE_END==/);
if (!m) { console.error("no markers"); process.exit(1); }
const dbReport = JSON.parse(m[1]);

const observedBaselineHashes = new Set(dbReport.originalCheckpoints.map((d) => d.hash12));
const checkpointsPreserved = dbReport.originalCheckpoints.length === 5 &&
  [...BASELINE_HASHES].every((h) => observedBaselineHashes.has(h));
const metadataPreserved = dbReport.course?.title === "Employee Onboarding and Policies" &&
  dbReport.course?.aiMetadataAttributionAt === BASELINE_ATTRIBUTION_AT;

console.log("\nPreservation summary:");
console.log(JSON.stringify({
  totalLiveDrafts: dbReport.totalLiveDrafts,
  originalCheckpoints: dbReport.originalCheckpoints.length,
  checkpointsPreserved,
  recoveryDraftCount: dbReport.recoveryDrafts.length,
  metadataPreserved,
  courseTitle: dbReport.course?.title,
  aiMetadataAttributionAt: dbReport.course?.aiMetadataAttributionAt,
  originalRunStatus: dbReport.originalRunStatus,
  completionsCount: dbReport.completionsCount,
  promotedQuestionsFromRecovery: dbReport.promotedQuestionsFromRecovery,
}, null, 2));

console.log("\nPersisted FA draft stems + answer validation:");
for (let i = 0; i < dbReport.recoveryDrafts.length; i++) {
  const d = dbReport.recoveryDrafts[i];
  const correctIdx = d.options.findIndex((o) => o.isCorrect);
  console.log(`\n  [${i+1}] ${d.id} (hash ${d.hash12})`);
  console.log(`      Stem: ${(d.questionText || "").slice(0, 160)}`);
  for (let j = 0; j < d.options.length; j++) {
    const marker = j === correctIdx ? "✓" : " ";
    console.log(`      ${marker} ${String.fromCharCode(65+j)}. ${(d.options[j].text || "").slice(0, 100)}`);
  }
  console.log(`      sourceSegmentIds: [${(d.sourceSegmentIds || []).join(", ")}]`);
  const hasSegmentRef = /\b(?:transcript\s+)?segments?\b.*?(?:\[\s*\d+(?:\s*,\s*\d+)*\s*\]|\bids?\b|\d+)/i.test(d.questionText || "");
  const hasAccording = /according\s+to\s+(?:the\s+)?(?:transcript|material)/i.test(d.questionText || "");
  console.log(`      sanitiser-safe (no segment-id leak): ${!hasSegmentRef && !hasAccording}`);
}

fs.mkdirSync("test-results", { recursive: true });
fs.writeFileSync("test-results/4yak-post-fire-db.json",
  JSON.stringify({ dbReport, preservation: { checkpointsPreserved, metadataPreserved } }, null, 2));

// Screenshots
const b = await chromium.launch({ headless: true });
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
const pg = await ctx.newPage();
await pg.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
await pg.fill('input[name="email"]', env("SPECTRE_STAGING_EMAIL"));
await pg.fill('input[name="password"]', env("SPECTRE_STAGING_PASSWORD"));
await Promise.all([pg.waitForURL(/\/app\//), pg.click('button[type="submit"]')]);
await pg.goto(`${BASE}/app/admin/people/safety-training/${COURSE_ID}/${VERSION_ID}/review`, { waitUntil: "domcontentloaded" });
await pg.waitForTimeout(4500);
await pg.screenshot({ path: "test-results/4yak-review-default.png", fullPage: true });
const faTab = pg.locator('button:has-text("Final Assessment"), button:has-text("Final assessment")');
if (await faTab.count()) {
  await faTab.first().click();
  await pg.waitForTimeout(800);
  await pg.screenshot({ path: "test-results/4yak-review-fa-q1.png", fullPage: true });
  for (let i = 2; i <= 6; i++) {
    const next = pg.locator('[data-testid="manager-review-next"], button:has-text("Next")').first();
    if (await next.isEnabled().catch(() => false)) {
      await next.click();
      await pg.waitForTimeout(600);
      await pg.screenshot({ path: `test-results/4yak-review-fa-q${i}.png`, fullPage: true });
    }
  }
}
const cpTab = pg.locator('button:has-text("Checkpoints")');
if (await cpTab.count()) {
  await cpTab.first().click();
  await pg.waitForTimeout(800);
  await pg.screenshot({ path: "test-results/4yak-review-cp-tab.png", fullPage: true });
}
await b.close();
console.log("\nScreenshots saved under test-results/4yak-review-*.png");
