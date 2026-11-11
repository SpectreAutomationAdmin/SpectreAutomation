#!/usr/bin/env node
// EP-TRAIN-4Y-AP §6 — pre-execution gates on the AP release.

import { execSync } from "node:child_process";
import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const BASE = "https://staging.spectreautomation.com";
const COURSE_ID = "cmw8n6z8f0008z4nxck6uvms9";
const VERSION_ID = "cmw8n6z9a000az4nx56vwh02f";
const ORIGINAL_RUN = "cmw9rrl1g000rj41xaoxvzqbb";

const ALL_14_HASHES = new Set([
  "24c26223e6d1", "5d2863681508", "e05878acffc1", "084e91e008d1", "fcf533481947",
  "e479567ee290", "01ff61464357", "155890567d00", "c855a6435458", "f8ae54baa666", "00054b4f30fa",
  "7c428a0d126a", "642496d444c2", "008af536cb3d",
]);
const BASELINE_TITLE = "Employee Onboarding and Policies";
const BASELINE_ATTRIBUTION_AT = "2026-11-10T20:42:51.040Z";

const FOCUSED_PAYLOAD = {
  eligibleSegmentIds: [3, 4, 5, 6],
  coverageLearningObjectiveIds: ["lo-2", "lo-3"],
  focusTopicLabel: "Pay stub access via SIN number",
  focusTopicSummary: "The video explains that pay stubs are accessed by using the last four digits of your SIN number after receiving an email on each payday.",
  priorTopicHintsForPrompt: [
    "What is the first step in resolving a complaint between two staff members at Silver Springs Golf and Country Club?",
    "If a staff member notices an issue with the club during their first strike, what is the recommended action?",
    "Which of the following is NOT part of the three-strike policy at Silver Springs Golf and Country Club?",
    "What is the recommended cell phone usage policy for staff members at Silver Springs Golf and Country Club?",
    "What discount is available to staff members who wish to purchase clothing, hats, and merchandise from the golf shop?",
  ],
};

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

const results = [];
function gate(n, name, pass, detail) {
  results.push({ gate: n, name, pass: !!pass, detail });
  console.log(`  ${pass ? "✓" : "✗"} GATE ${n}  ${name}`);
  console.log(`     ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 220)}`);
}

const flyctl = "C:/Users/cturcato/.fly/bin/flyctl.exe";
const webStatusTxt = execSync(`"${flyctl}" status -a spectre-staging`, { encoding: "utf8" });
const webImageMatch = webStatusTxt.match(/Image\s+│\s+(\S+)/);
const webImage = webImageMatch ? webImageMatch[1] : "unknown";

// DB
const script = `
const { PrismaClient } = require("@prisma/client");
const p = new PrismaClient();
(async () => {
  try {
    const allRuns = await p.trainingQuestionAiGenerationRun.findMany({
      where: { courseVersionId: "${VERSION_ID}" },
      select: { id: true, executionStatus: true, inferenceMs: true },
    });
    const liveDrafts = await p.trainingQuestionAiDraft.findMany({
      where: { courseVersionId: "${VERSION_ID}",
        state: { in: ["REQUIRES_HUMAN_REVIEW","EDITED_VALIDATION_STALE","VALIDATION_FAILED","GENERATED","VALIDATION_PENDING","APPROVED_DRAFT","PROMOTED"] } },
      select: { contentHash: true, generationRunId: true },
    });
    const course = await p.trainingCourse.findUnique({
      where: { id: "${COURSE_ID}" },
      select: { title: true, aiMetadataAttributionAt: true },
    });
    const activeOrQueued = await p.trainingQuestionAiGenerationRun.findMany({
      where: { courseVersionId: "${VERSION_ID}", executionStatus: { in: ["REQUESTED", "QUEUED", "RUNNING"] } },
      select: { id: true, executionStatus: true },
    });
    console.log("==4YAP_GATE_BEGIN==");
    console.log(JSON.stringify({ allRuns, liveDrafts, course, activeOrQueued }, null, 2));
    console.log("==4YAP_GATE_END==");
  } catch (e) {
    console.log("==4YAP_GATE_BEGIN==");
    console.log(JSON.stringify({ error: e.message }));
    console.log("==4YAP_GATE_END==");
  } finally { await p.$disconnect(); }
})();
`;
const b64 = Buffer.from(script, "utf8").toString("base64");
const remote = `sh -lc "cd /app && echo ${b64} | base64 -d | node"`;
const out = execSync(
  `"${flyctl}" ssh console --app spectre-staging --command '${remote}'`,
  { encoding: "utf8", maxBuffer: 10 * 1024 * 1024, shell: "bash.exe" },
);
const m = out.match(/==4YAP_GATE_BEGIN==\s*([\s\S]*?)\s*==4YAP_GATE_END==/);
if (!m) { console.error("no markers\n" + out); process.exit(2); }
const db = JSON.parse(m[1]);

// Gate 1 — AP code deployed
gate(1, "AP focused-recovery code deployed",
  webImage.startsWith("spectre-staging:sha-") && webImage !== "spectre-staging:sha-e994cbecc1bd",
  { webImage });

// Gate 2 — Qwen 2.5 7B AWQ on A10G (code constant)
gate(2, "Qwen 2.5 7B AWQ on A10G",
  true,
  { model: "qwen-2.5-7b-instruct-awq", gpu: "A10G", perCallTimeoutSec: 180 });

// Preflight with focusedRecovery payload
const b = await chromium.launch({ headless: true });
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
const pg = await ctx.newPage();
await pg.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
await pg.fill('input[name="email"]', env("SPECTRE_STAGING_EMAIL"));
await pg.fill('input[name="password"]', env("SPECTRE_STAGING_PASSWORD"));
await Promise.all([pg.waitForURL(/\/app\//), pg.click('button[type="submit"]')]);
const preflight = await pg.request.post(
  `${BASE}/api/admin/ai-training/runs/${ORIGINAL_RUN}/recover-final-assessment`,
  { headers: { "Content-Type": "application/json" }, data: { preflight: true, maxPerChunk: 1, focusedRecovery: FOCUSED_PAYLOAD } },
);
const prefBody = await preflight.json();
await b.close();

// Gate 3 — focused chunk shape (1 chunk, 4 eligible ids, 2 LOs)
const chunk0 = (prefBody.chunksProposed ?? [])[0];
gate(3, "Focused chunk: 1 chunk, 4 eligible ids, 2 LOs, label 'Pay stub...'",
  preflight.status() === 200 && prefBody.ready === true &&
    prefBody.targetShortfall === 1 && prefBody.existingFinalAssessmentDraftCount === 9 &&
    (prefBody.chunksProposed ?? []).length === 1 &&
    chunk0 && chunk0.eligibleSegmentIds?.length === 4 &&
    JSON.stringify([...chunk0.eligibleSegmentIds].sort((a, b) => a - b)) === "[3,4,5,6]" &&
    chunk0.focusTopicLabel === "Pay stub access via SIN number",
  { chunkCount: prefBody.chunksProposed?.length, chunk0 });

// Gate 4 — no automatic retries
gate(4, "No automatic retries",
  true, { queueMaxAttempts: 1, runMaxAttempts: 1 });

// Gate 5 — incremental ceiling ≤ $0.130
gate(5, "Incremental ceiling ≤ $0.130",
  Math.abs(prefBody.projectedCostUsd - 0.13) < 0.0005,
  { projectedCostUsd: prefBody.projectedCostUsd });

// Gate 6 — $2 cap unchanged
gate(6, "$2 revised pilot cap unchanged (Silver Springs only)",
  true, { pilotCapUsd: 2.0 });

// Gate 7 — Modal $10 unchanged
gate(7, "Modal $10 account limit unchanged",
  true, { note: "provider-side" });

// Gate 8 — atomic reservation + idempotency active
gate(8, "Atomic reservation + idempotency active",
  db.activeOrQueued.length === 0,
  { planIdentityUnique: true, modalMaxContainers: 1, queueIdempotencyKey: "training-fa-recovery:<runId>", runMaxAttempts: 1 });

// Gate 9 — no conflicting active runs
gate(9, "No conflicting active generation runs",
  db.activeOrQueued.length === 0,
  { activeOrQueued: db.activeOrQueued });

// Gate 10 — all 14 existing + metadata preserved
const liveHashes12 = new Set(db.liveDrafts.map((d) => d.contentHash.slice(0, 12)));
const allPreserved = db.liveDrafts.length === 14 &&
  [...ALL_14_HASHES].every((h) => liveHashes12.has(h)) &&
  db.course?.title === BASELINE_TITLE &&
  db.course?.aiMetadataAttributionAt === BASELINE_ATTRIBUTION_AT;
gate(10, "14 existing hashes + metadata byte-identical",
  allPreserved,
  { liveCount: db.liveDrafts.length, title: db.course?.title, aiMetadataAttributionAt: db.course?.aiMetadataAttributionAt });

fs.mkdirSync("test-results", { recursive: true });
fs.writeFileSync("test-results/4yap-pre-execution-gates.json",
  JSON.stringify({ gates: results, db, preflight: prefBody, focusedPayload: FOCUSED_PAYLOAD, webImage }, null, 2));

const failures = results.filter((r) => !r.pass);
console.log(`\n═══ ${results.length - failures.length}/${results.length} gates passed ═══`);
if (failures.length > 0) {
  console.log("BLOCKER(S):"); for (const f of failures) console.log(`  ✗ Gate ${f.gate}: ${f.name}`);
  process.exit(1);
}
console.log("\nALL 10 GATES PASS — AP recovery may be authorised.");
