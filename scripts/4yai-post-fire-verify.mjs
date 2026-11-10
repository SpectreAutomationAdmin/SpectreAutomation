#!/usr/bin/env node
import { execSync } from "node:child_process";
import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const BASE = "https://staging.spectreautomation.com";
const COURSE_ID = "cmw8n6z8f0008z4nxck6uvms9";
const VERSION_ID = "cmw8n6z9a000az4nx56vwh02f";
const ORIGINAL_RUN = "cmw9rrl1g000rj41xaoxvzqbb";
const RECOVERY_RUN = "cmwb8im9j000jvh64v96ahxwg";

// Pre-fire course snapshot taken from the gates report.
const PRE_FIRE_TITLE = "Employee Onboarding and Policies";
const PRE_FIRE_CODE = "EMPLOYEE_ONBOARDING_AND_POLICIES_39A872";
const PRE_FIRE_CHECKPOINT_HASHES = new Set([
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

const script = `
const { PrismaClient } = require("@prisma/client");
const p = new PrismaClient();
(async () => {
  try {
    const liveDrafts = await p.trainingQuestionAiDraft.findMany({
      where: { courseVersionId: "${VERSION_ID}",
        state: { in: ["REQUIRES_HUMAN_REVIEW","EDITED_VALIDATION_STALE","VALIDATION_FAILED","GENERATED","VALIDATION_PENDING","APPROVED_DRAFT","PROMOTED"] } },
      select: { id: true, state: true, contentHash: true, generationRunId: true, generatedAt: true },
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
    const draftsFromRecovery = await p.trainingQuestionAiDraft.count({ where: { generationRunId: "${RECOVERY_RUN}" } });
    const completionsCount = await p.trainingCompletion.count({ where: { courseVersionId: "${VERSION_ID}" } });
    const recoveryDraftIds = (await p.trainingQuestionAiDraft.findMany({
      where: { generationRunId: "${RECOVERY_RUN}" }, select: { id: true },
    })).map((d) => d.id);
    const promotedQuestionsFromRecovery = recoveryDraftIds.length === 0 ? 0 :
      await p.trainingQuestion.count({
        where: { courseVersionId: "${VERSION_ID}",
          aiPromotion: { is: { draftId: { in: recoveryDraftIds } } } },
      });

    console.log("==4YAI_POSTFIRE_BEGIN==");
    console.log(JSON.stringify({
      liveDrafts: liveDrafts.map((d) => ({ id: d.id, state: d.state, hash12: d.contentHash.slice(0,12), runId: d.generationRunId })),
      liveDraftCount: liveDrafts.length,
      originalRunStatus: originalRun?.executionStatus,
      course,
      draftsFromRecovery,
      completionsCount,
      promotedQuestionsFromRecovery,
    }, null, 2));
    console.log("==4YAI_POSTFIRE_END==");
  } catch (e) {
    console.log("==4YAI_POSTFIRE_BEGIN==");
    console.log(JSON.stringify({ error: e.message, stack: e.stack }));
    console.log("==4YAI_POSTFIRE_END==");
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
const m = out.match(/==4YAI_POSTFIRE_BEGIN==\s*([\s\S]*?)\s*==4YAI_POSTFIRE_END==/);
if (!m) { console.error("no markers"); process.exit(1); }
const dbReport = JSON.parse(m[1]);

// Preservation assertions.
const observedHashes = new Set(dbReport.liveDrafts.map((d) => d.hash12));
const checkpointsPreserved = dbReport.liveDraftCount === 5 &&
  [...PRE_FIRE_CHECKPOINT_HASHES].every((h) => observedHashes.has(h));
const titleUnchanged = dbReport.course?.title === PRE_FIRE_TITLE;
const codeUnchanged = dbReport.course?.code === PRE_FIRE_CODE;
const metadataSuppressed = (() => {
  // If §3 worked, the course row's aiMetadataAttributionAt should NOT
  // have advanced past the pre-recovery AG-era timestamp.
  const atStr = dbReport.course?.aiMetadataAttributionAt;
  if (!atStr) return false;
  // We know it was 2026-11-10T20:42:51 after the AG failure.
  const at = new Date(atStr).getTime();
  const aiFireStart = new Date("2026-11-10T22:01:00Z").getTime();
  return at < aiFireStart;
})();

console.log("Preservation summary:");
console.log(JSON.stringify({
  checkpointsPreserved,
  titleUnchanged,
  codeUnchanged,
  metadataSuppressed,
  liveDraftCount: dbReport.liveDraftCount,
  draftsFromRecovery: dbReport.draftsFromRecovery,
  promotedQuestionsFromRecovery: dbReport.promotedQuestionsFromRecovery,
  completionsCount: dbReport.completionsCount,
  courseTitle: dbReport.course?.title,
  courseCode: dbReport.course?.code,
  aiMetadataAttributionAt: dbReport.course?.aiMetadataAttributionAt,
}, null, 2));

fs.mkdirSync("test-results", { recursive: true });
fs.writeFileSync("test-results/4yai-post-fire-db.json", JSON.stringify({
  dbReport,
  preservation: { checkpointsPreserved, titleUnchanged, codeUnchanged, metadataSuppressed },
}, null, 2));

// Playwright screenshots
const b = await chromium.launch({ headless: true });
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
const pg = await ctx.newPage();
await pg.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
await pg.fill('input[name="email"]', env("SPECTRE_STAGING_EMAIL"));
await pg.fill('input[name="password"]', env("SPECTRE_STAGING_PASSWORD"));
await Promise.all([pg.waitForURL(/\/app\//), pg.click('button[type="submit"]')]);
await pg.goto(`${BASE}/app/admin/people/safety-training/${COURSE_ID}/${VERSION_ID}/review`, { waitUntil: "domcontentloaded" });
await pg.waitForTimeout(4500);
await pg.screenshot({ path: "test-results/4yai-review-default.png", fullPage: true });
const faTab = pg.locator('button:has-text("Final Assessment"), button:has-text("Final assessment")');
if (await faTab.count()) {
  await faTab.first().click();
  await pg.waitForTimeout(800);
  await pg.screenshot({ path: "test-results/4yai-review-fa-tab.png", fullPage: true });
}
const cpTab = pg.locator('button:has-text("Checkpoints")');
if (await cpTab.count()) {
  await cpTab.first().click();
  await pg.waitForTimeout(800);
  await pg.screenshot({ path: "test-results/4yai-review-cp-tab.png", fullPage: true });
}
await b.close();
console.log("Screenshots saved under test-results/4yai-review-*.png");
