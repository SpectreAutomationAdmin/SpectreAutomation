#!/usr/bin/env node
// EP-TRAIN-4Y-AT §6 — post-deploy verification.

import { execSync } from "node:child_process";
import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const BASE = "https://staging.spectreautomation.com";
const COURSE_ID = "cmw8n6z8f0008z4nxck6uvms9";
const VERSION_ID = "cmw8n6z9a000az4nx56vwh02f";
const AS_DRAFT_ID = "cmwbl6aic0007107lhfo4n0wl";
const AS_CONTENT_HASH_12 = "b4d2ed9ffdf8";

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

// (1) DB probe — preservation of all 15 drafts + metadata + the
// AS draft's generationRunId and contentHash.
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
    console.log("==4YAT_VERIFY_BEGIN==");
    console.log(JSON.stringify({ liveDrafts, course, completionsCount }, null, 2));
    console.log("==4YAT_VERIFY_END==");
  } catch (e) {
    console.log("==4YAT_VERIFY_BEGIN==");
    console.log(JSON.stringify({ error: e.message }));
    console.log("==4YAT_VERIFY_END==");
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
const m = out.match(/==4YAT_VERIFY_BEGIN==\s*([\s\S]*?)\s*==4YAT_VERIFY_END==/);
if (!m) { console.error("no markers"); process.exit(1); }
const db = JSON.parse(m[1]);

const observed14 = new Set(db.liveDrafts
  .filter((d) => ALL_14_HASHES.has(d.contentHash.slice(0, 12)))
  .map((d) => d.contentHash.slice(0, 12)));
const allPreserved = observed14.size === 14;
const metadataPreserved = db.course?.title === "Employee Onboarding and Policies" &&
  db.course?.aiMetadataAttributionAt === BASELINE_ATTRIBUTION_AT;
const asDraft = db.liveDrafts.find((d) => d.id === AS_DRAFT_ID);
const asPreserved = asDraft && asDraft.contentHash.slice(0, 12) === AS_CONTENT_HASH_12;

console.log(JSON.stringify({
  totalLiveDrafts: db.liveDrafts.length,
  allPreservedExisting14: allPreserved,
  asDraftPreserved: !!asPreserved,
  metadataPreserved,
  completionsCount: db.completionsCount,
}, null, 2));

fs.mkdirSync("test-results", { recursive: true });
fs.writeFileSync("test-results/4yat-verify-db.json",
  JSON.stringify({ db, preservation: { allPreserved, metadataPreserved, asPreserved: !!asPreserved } }, null, 2));

// (2) Playwright — visit the review page, find Q7 on the Final
// Assessment tab, confirm the header does NOT say "destination
// unknown" / "Unknown" etc. Screenshot.
const b2 = await chromium.launch({ headless: true });
const ctx = await b2.newContext({ viewport: { width: 1440, height: 900 } });
const pg = await ctx.newPage();
await pg.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
await pg.fill('input[name="email"]', env("SPECTRE_STAGING_EMAIL"));
await pg.fill('input[name="password"]', env("SPECTRE_STAGING_PASSWORD"));
await Promise.all([pg.waitForURL(/\/app\//), pg.click('button[type="submit"]')]);
await pg.goto(`${BASE}/app/admin/people/safety-training/${COURSE_ID}/${VERSION_ID}/review`, { waitUntil: "domcontentloaded" });
await pg.waitForTimeout(3500);
await pg.screenshot({ path: "test-results/4yat-review-default.png", fullPage: true });

const faTab = pg.locator('button:has-text("Final Assessment"), button:has-text("Final assessment")');
if (await faTab.count()) {
  await faTab.first().click();
  await pg.waitForTimeout(600);
  await pg.screenshot({ path: "test-results/4yat-review-fa-tab.png", fullPage: true });
}

// Scan visible text for "destination unknown" (case-insensitive).
const pageText = await pg.locator("body").innerText();
const hasDestinationUnknown = /destination\s+unknown/i.test(pageText);

// Try to navigate to Q7 if there's an index-based control.
const q7Button = pg.locator('button:has-text("7"), button[aria-label*="7"]').first();
if (await q7Button.count()) {
  try { await q7Button.click(); await pg.waitForTimeout(400); } catch {}
}
await pg.screenshot({ path: "test-results/4yat-review-q7.png", fullPage: true });

// Refresh — persistence test.
await pg.reload({ waitUntil: "domcontentloaded" });
await pg.waitForTimeout(2500);
const faTab2 = pg.locator('button:has-text("Final Assessment"), button:has-text("Final assessment")');
if (await faTab2.count()) {
  await faTab2.first().click();
  await pg.waitForTimeout(600);
}
await pg.screenshot({ path: "test-results/4yat-review-after-refresh.png", fullPage: true });
const pageTextAfter = await pg.locator("body").innerText();
const hasDestinationUnknownAfter = /destination\s+unknown/i.test(pageTextAfter);

fs.writeFileSync("test-results/4yat-ui-scan.json",
  JSON.stringify({
    hasDestinationUnknown,
    hasDestinationUnknownAfter,
    pageTextSample: pageText.slice(0, 400),
  }, null, 2));

await b2.close();
console.log(`\nUI scan:  destinationUnknown=${hasDestinationUnknown}  afterRefresh=${hasDestinationUnknownAfter}`);
if (!allPreserved || !metadataPreserved || !asPreserved) { console.error("PRESERVATION FAIL"); process.exit(1); }
if (hasDestinationUnknown || hasDestinationUnknownAfter) { console.error('"destination unknown" STILL VISIBLE'); process.exit(1); }
console.log(`\n✓ 15 drafts preserved + no "destination unknown" string in Final Assessment tab`);
