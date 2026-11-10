#!/usr/bin/env node
// EP-TRAIN-4Y-AG post-fire verification. Confirms:
//   a. 5 accepted checkpoints are unchanged (same content hashes, states).
//   b. Course metadata (title / description / code) unchanged.
//   c. Recovery run is terminal FAILED, no additional attempts.
//   d. No FA drafts persisted from the recovery run.
//   e. No TrainingQuestion rows promoted or published from the recovery.
//   f. No employee completion records created.
// Also captures Manager Review screenshots at 1440×900.

import { execSync } from "node:child_process";
import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const BASE = "https://staging.spectreautomation.com";
const COURSE_ID = "cmw8n6z8f0008z4nxck6uvms9";
const VERSION_ID = "cmw8n6z9a000az4nx56vwh02f";
const ORIGINAL_RUN = "cmw9rrl1g000rj41xaoxvzqbb";
const RECOVERY_RUN = "cmwb5o94p000jasjoehfo3v15";

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
    // 5 checkpoint draft rows (the five chain-head EDITED_VALIDATION_STALE active drafts)
    const liveDrafts = await p.trainingQuestionAiDraft.findMany({
      where: {
        courseVersionId: "${VERSION_ID}",
        state: { in: ["REQUIRES_HUMAN_REVIEW","EDITED_VALIDATION_STALE","VALIDATION_FAILED","GENERATED","VALIDATION_PENDING","APPROVED_DRAFT","PROMOTED"] },
      },
      select: { id: true, state: true, contentHash: true, generationRunId: true, generatedAt: true },
      orderBy: { generatedAt: "asc" },
    });
    const recoveryRun = await p.trainingQuestionAiGenerationRun.findUnique({
      where: { id: "${RECOVERY_RUN}" },
      select: {
        executionStatus: true, executionErrorCode: true, executionErrorMessage: true,
        attempts: true, maxAttempts: true, inferenceMs: true,
        promptTokenCount: true, outputTokenCount: true,
        startedAt: true, completedAt: true, shortfallReasonJson: true,
      },
    });
    const originalRun = await p.trainingQuestionAiGenerationRun.findUnique({
      where: { id: "${ORIGINAL_RUN}" },
      select: { executionStatus: true, assessmentPlanJson: true, shortfallReasonJson: true, groundingProjectionSha256: true, completedAt: true },
    });
    const course = await p.trainingCourse.findUnique({
      where: { id: "${COURSE_ID}" },
      select: { title: true, description: true, code: true, aiMetadataAttributionSource: true, aiMetadataAttributionAt: true },
    });
    const draftsFromRecovery = await p.trainingQuestionAiDraft.count({ where: { generationRunId: "${RECOVERY_RUN}" } });
    const completionsCount = await p.trainingCompletion.count({ where: { courseVersionId: "${VERSION_ID}" } });
    const recoveryDraftIds = (await p.trainingQuestionAiDraft.findMany({
      where: { generationRunId: "${RECOVERY_RUN}" },
      select: { id: true },
    })).map(d => d.id);
    const promotedQuestionsFromRecovery = recoveryDraftIds.length === 0 ? 0 :
      await p.trainingQuestion.count({
        where: {
          courseVersionId: "${VERSION_ID}",
          aiPromotion: { is: { draftId: { in: recoveryDraftIds } } },
        },
      });

    console.log("==4YAG_POSTFIRE_BEGIN==");
    console.log(JSON.stringify({
      liveDrafts: liveDrafts.map(d => ({ id: d.id, state: d.state, hash12: d.contentHash.slice(0,12), runId: d.generationRunId })),
      liveDraftCount: liveDrafts.length,
      recoveryRun,
      originalRunStatus: originalRun?.executionStatus,
      originalRunIntact: {
        hasPlanJson: !!originalRun?.assessmentPlanJson,
        hasShortfallJson: !!originalRun?.shortfallReasonJson,
        completedAt: originalRun?.completedAt,
      },
      course,
      draftsFromRecovery,
      completionsCount,
      promotedQuestionsFromRecovery,
    }, null, 2));
    console.log("==4YAG_POSTFIRE_END==");
  } catch (e) {
    console.log("==4YAG_POSTFIRE_BEGIN==");
    console.log(JSON.stringify({ error: e.message, stack: e.stack }));
    console.log("==4YAG_POSTFIRE_END==");
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
const m = out.match(/==4YAG_POSTFIRE_BEGIN==\s*([\s\S]*?)\s*==4YAG_POSTFIRE_END==/);
if (!m) { console.error("no markers"); console.error(out); process.exit(1); }
const dbReport = JSON.parse(m[1]);
console.log("DB-side state:");
console.log(JSON.stringify(dbReport, null, 2));
fs.mkdirSync("test-results", { recursive: true });
fs.writeFileSync("test-results/4yag-post-fire-db.json", JSON.stringify(dbReport, null, 2));

// Playwright screenshots of Manager Review
const b = await chromium.launch({ headless: true });
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
const pg = await ctx.newPage();
await pg.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
await pg.fill('input[name="email"]', env("SPECTRE_STAGING_EMAIL"));
await pg.fill('input[name="password"]', env("SPECTRE_STAGING_PASSWORD"));
await Promise.all([pg.waitForURL(/\/app\//), pg.click('button[type="submit"]')]);
await pg.goto(`${BASE}/app/admin/people/safety-training/${COURSE_ID}/${VERSION_ID}/review`, { waitUntil: "domcontentloaded" });
await pg.waitForTimeout(4500);
await pg.screenshot({ path: "test-results/4yag-review-default.png", fullPage: true });
// Try to navigate to FA tab
const faTab = pg.locator('[data-testid="manager-review-mode-final_assessment"], button:has-text("Final Assessment")');
if (await faTab.count()) {
  await faTab.first().click();
  await pg.waitForTimeout(800);
  await pg.screenshot({ path: "test-results/4yag-review-fa-tab.png", fullPage: true });
}
const cpTab = pg.locator('[data-testid="manager-review-mode-checkpoint"], button:has-text("Checkpoints")');
if (await cpTab.count()) {
  await cpTab.first().click();
  await pg.waitForTimeout(800);
  await pg.screenshot({ path: "test-results/4yag-review-cp-tab.png", fullPage: true });
}
await b.close();

console.log("\nDone — screenshots in test-results/4yag-review-*.png");
