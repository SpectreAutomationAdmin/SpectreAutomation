#!/usr/bin/env node
import { execSync } from "node:child_process";
import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const BASE = "https://staging.spectreautomation.com";
const COURSE_ID = "cmw8n6z8f0008z4nxck6uvms9";
const VERSION_ID = "cmw8n6z9a000az4nx56vwh02f";
const ORIGINAL_RUN = "cmw9rrl1g000rj41xaoxvzqbb";
const AK_RUN = "cmwbatqv9000j3ykfqccbyt7v";
const AN_RUN = "cmwbdnn1b000d58whatdxvp5u";

const PRESERVED_CHECKPOINT_HASHES = new Set([
  "24c26223e6d1", "5d2863681508", "e05878acffc1", "084e91e008d1", "fcf533481947",
]);
const PRESERVED_AK_FA_HASHES = new Set([
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
    const course = await p.trainingCourse.findUnique({
      where: { id: "${COURSE_ID}" },
      select: { title: true, description: true, code: true, aiMetadataAttributionAt: true },
    });
    const completionsCount = await p.trainingCompletion.count({ where: { courseVersionId: "${VERSION_ID}" } });
    const originalRun = await p.trainingQuestionAiGenerationRun.findUnique({
      where: { id: "${ORIGINAL_RUN}" }, select: { executionStatus: true },
    });
    console.log("==4YAN_POSTFIRE_BEGIN==");
    const checkpoints = liveDrafts.filter((d) => d.generationRunId === "${ORIGINAL_RUN}");
    const akFa = liveDrafts.filter((d) => d.generationRunId === "${AK_RUN}");
    const anFa = liveDrafts.filter((d) => d.generationRunId === "${AN_RUN}");
    console.log(JSON.stringify({
      totalLiveDrafts: liveDrafts.length,
      checkpoints: checkpoints.map((d) => ({ id: d.id, state: d.state, hash12: d.contentHash.slice(0,12) })),
      akFa: akFa.map((d) => ({ id: d.id, state: d.state, hash12: d.contentHash.slice(0,12) })),
      anFa: anFa.map((d) => {
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
      course, completionsCount,
      originalRunStatus: originalRun?.executionStatus,
    }, null, 2));
    console.log("==4YAN_POSTFIRE_END==");
  } catch (e) {
    console.log("==4YAN_POSTFIRE_BEGIN==");
    console.log(JSON.stringify({ error: e.message }));
    console.log("==4YAN_POSTFIRE_END==");
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
const m = out.match(/==4YAN_POSTFIRE_BEGIN==\s*([\s\S]*?)\s*==4YAN_POSTFIRE_END==/);
if (!m) { console.error("no markers"); process.exit(1); }
const db = JSON.parse(m[1]);

const cpHashes = new Set(db.checkpoints.map((d) => d.hash12));
const akHashes = new Set(db.akFa.map((d) => d.hash12));
const checkpointsPreserved = db.checkpoints.length === 5 &&
  [...PRESERVED_CHECKPOINT_HASHES].every((h) => cpHashes.has(h));
const akFaPreserved = db.akFa.length === 6 &&
  [...PRESERVED_AK_FA_HASHES].every((h) => akHashes.has(h));
const metadataPreserved = db.course?.title === "Employee Onboarding and Policies" &&
  db.course?.aiMetadataAttributionAt === BASELINE_ATTRIBUTION_AT;

console.log("Preservation + totals:");
console.log(JSON.stringify({
  totalLiveDrafts: db.totalLiveDrafts,
  checkpointsCount: db.checkpoints.length,
  checkpointsPreserved,
  akFaCount: db.akFa.length,
  akFaPreserved,
  anFaCount: db.anFa.length,
  metadataPreserved,
  courseTitle: db.course?.title,
  aiMetadataAttributionAt: db.course?.aiMetadataAttributionAt,
  originalRunStatus: db.originalRunStatus,
  completionsCount: db.completionsCount,
}, null, 2));

console.log("\n3 newly persisted AN FA drafts:");
for (let i = 0; i < db.anFa.length; i++) {
  const d = db.anFa[i];
  const correctIdx = d.options.findIndex((o) => o.isCorrect);
  console.log(`\n  [${i+1}] ${d.id} (${d.state}, hash ${d.hash12})`);
  console.log(`      Stem: ${(d.questionText || "").slice(0, 160)}`);
  for (let j = 0; j < d.options.length; j++) {
    const marker = j === correctIdx ? "✓" : " ";
    console.log(`      ${marker} ${String.fromCharCode(65+j)}. ${(d.options[j].text || "").slice(0, 100)}`);
  }
  console.log(`      sourceSegmentIds: [${(d.sourceSegmentIds || []).join(", ")}]`);
  const hasSegmentRef = /\b(?:transcript\s+)?segments?\b.*?(?:\[\s*\d+(?:\s*,\s*\d+)*\s*\]|\bids?\b|\d+)/i.test(d.questionText || "");
  const hasAccording = /according\s+to\s+(?:the\s+)?(?:transcript|training|evidence|material|course\s+content)/i.test(d.questionText || "");
  console.log(`      sanitiser-safe: ${!hasSegmentRef && !hasAccording}`);
}

fs.mkdirSync("test-results", { recursive: true });
fs.writeFileSync("test-results/4yan-post-fire-db.json",
  JSON.stringify({ db, preservation: { checkpointsPreserved, akFaPreserved, metadataPreserved } }, null, 2));

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
await pg.screenshot({ path: "test-results/4yan-review-default.png", fullPage: true });
const faTab = pg.locator('button:has-text("Final Assessment"), button:has-text("Final assessment")');
if (await faTab.count()) {
  await faTab.first().click();
  await pg.waitForTimeout(800);
  await pg.screenshot({ path: "test-results/4yan-review-fa-q1.png", fullPage: true });
  for (let i = 2; i <= 9; i++) {
    const next = pg.locator('[data-testid="manager-review-next"], button:has-text("Next")').first();
    if (await next.isEnabled().catch(() => false)) {
      await next.click();
      await pg.waitForTimeout(600);
      await pg.screenshot({ path: `test-results/4yan-review-fa-q${i}.png`, fullPage: true });
    }
  }
}
const cpTab = pg.locator('button:has-text("Checkpoints")');
if (await cpTab.count()) {
  await cpTab.first().click();
  await pg.waitForTimeout(800);
  await pg.screenshot({ path: "test-results/4yan-review-cp-tab.png", fullPage: true });
}
await b.close();
console.log("\nScreenshots saved under test-results/4yan-review-*.png");
