#!/usr/bin/env node
import { execSync } from "node:child_process";
import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const BASE = "https://staging.spectreautomation.com";
const COURSE_ID = "cmw8n6z8f0008z4nxck6uvms9";
const VERSION_ID = "cmw8n6z9a000az4nx56vwh02f";
const AP_RUN = "cmwbfy1ul000dv9lt44apd074";

const ALL_14_HASHES = new Set([
  "24c26223e6d1", "5d2863681508", "e05878acffc1", "084e91e008d1", "fcf533481947",
  "e479567ee290", "01ff61464357", "155890567d00", "c855a6435458", "f8ae54baa666", "00054b4f30fa",
  "7c428a0d126a", "642496d444c2", "008af536cb3d",
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
      select: { id: true, contentHash: true, generationRunId: true },
    });
    const course = await p.trainingCourse.findUnique({
      where: { id: "${COURSE_ID}" },
      select: { title: true, aiMetadataAttributionAt: true, code: true },
    });
    const apDraftCount = await p.trainingQuestionAiDraft.count({ where: { generationRunId: "${AP_RUN}" } });
    const completionsCount = await p.trainingCompletion.count({ where: { courseVersionId: "${VERSION_ID}" } });
    console.log("==4YAP_POSTFIRE_BEGIN==");
    console.log(JSON.stringify({ liveDrafts, course, apDraftCount, completionsCount }, null, 2));
    console.log("==4YAP_POSTFIRE_END==");
  } catch (e) {
    console.log("==4YAP_POSTFIRE_BEGIN==");
    console.log(JSON.stringify({ error: e.message }));
    console.log("==4YAP_POSTFIRE_END==");
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
const m = out.match(/==4YAP_POSTFIRE_BEGIN==\s*([\s\S]*?)\s*==4YAP_POSTFIRE_END==/);
if (!m) { console.error("no markers"); process.exit(1); }
const db = JSON.parse(m[1]);

const observed = new Set(db.liveDrafts.map((d) => d.contentHash.slice(0, 12)));
const allPreserved = db.liveDrafts.length === 14 &&
  [...ALL_14_HASHES].every((h) => observed.has(h));
const metadataPreserved = db.course?.title === "Employee Onboarding and Policies" &&
  db.course?.aiMetadataAttributionAt === BASELINE_ATTRIBUTION_AT;

console.log("Preservation + totals:");
console.log(JSON.stringify({
  totalLiveDrafts: db.liveDrafts.length,
  allPreserved, metadataPreserved,
  apDraftCount: db.apDraftCount,
  completionsCount: db.completionsCount,
  courseTitle: db.course?.title,
  aiMetadataAttributionAt: db.course?.aiMetadataAttributionAt,
}, null, 2));

fs.mkdirSync("test-results", { recursive: true });
fs.writeFileSync("test-results/4yap-post-fire-db.json",
  JSON.stringify({ db, preservation: { allPreserved, metadataPreserved } }, null, 2));

const b = await chromium.launch({ headless: true });
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
const pg = await ctx.newPage();
await pg.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
await pg.fill('input[name="email"]', env("SPECTRE_STAGING_EMAIL"));
await pg.fill('input[name="password"]', env("SPECTRE_STAGING_PASSWORD"));
await Promise.all([pg.waitForURL(/\/app\//), pg.click('button[type="submit"]')]);
await pg.goto(`${BASE}/app/admin/people/safety-training/${COURSE_ID}/${VERSION_ID}/review`, { waitUntil: "domcontentloaded" });
await pg.waitForTimeout(3500);
await pg.screenshot({ path: "test-results/4yap-review-default.png", fullPage: true });
const faTab = pg.locator('button:has-text("Final Assessment"), button:has-text("Final assessment")');
if (await faTab.count()) {
  await faTab.first().click();
  await pg.waitForTimeout(600);
  await pg.screenshot({ path: "test-results/4yap-review-fa-tab.png", fullPage: true });
}
const cpTab = pg.locator('button:has-text("Checkpoints")');
if (await cpTab.count()) {
  await cpTab.first().click();
  await pg.waitForTimeout(600);
  await pg.screenshot({ path: "test-results/4yap-review-cp-tab.png", fullPage: true });
}
await b.close();
console.log("\nScreenshots saved under test-results/4yap-review-*.png");
if (!allPreserved || !metadataPreserved) { console.error("PRESERVATION FAIL"); process.exit(1); }
