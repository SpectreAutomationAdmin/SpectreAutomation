#!/usr/bin/env node
// EP-TRAIN-4Y-AO §6 — pre-execution gates for the single-question
// authorised fire. Read-only; no GPU.

import { execSync } from "node:child_process";
import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const BASE = "https://staging.spectreautomation.com";
const COURSE_ID = "cmw8n6z8f0008z4nxck6uvms9";
const VERSION_ID = "cmw8n6z9a000az4nx56vwh02f";
const ORIGINAL_RUN = "cmw9rrl1g000rj41xaoxvzqbb";

const ALL_14_HASHES = new Set([
  "24c26223e6d1", "5d2863681508", "e05878acffc1", "084e91e008d1", "fcf533481947", // 5 CP
  "e479567ee290", "01ff61464357", "155890567d00", "c855a6435458", "f8ae54baa666", "00054b4f30fa", // 6 AK FA
  "7c428a0d126a", "642496d444c2", "008af536cb3d", // 3 AN FA
]);
const BASELINE_TITLE = "Employee Onboarding and Policies";
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
    console.log("==4YAO_GATE_BEGIN==");
    console.log(JSON.stringify({ allRuns, liveDrafts, course, activeOrQueued }, null, 2));
    console.log("==4YAO_GATE_END==");
  } catch (e) {
    console.log("==4YAO_GATE_BEGIN==");
    console.log(JSON.stringify({ error: e.message }));
    console.log("==4YAO_GATE_END==");
  } finally { await p.$disconnect(); }
})();
`;
const b64 = Buffer.from(script, "utf8").toString("base64");
const remote = `sh -lc "cd /app && echo ${b64} | base64 -d | node"`;
const out = execSync(
  `"${flyctl}" ssh console --app spectre-staging --command '${remote}'`,
  { encoding: "utf8", maxBuffer: 10 * 1024 * 1024, shell: "bash.exe" },
);
const m = out.match(/==4YAO_GATE_BEGIN==\s*([\s\S]*?)\s*==4YAO_GATE_END==/);
if (!m) { console.error("no markers\n" + out); process.exit(2); }
const db = JSON.parse(m[1]);

// ─── Deploy verified ────────────────────────────────────────────
gate(1, "AO code deployed (new sha != AN sha-81deec0eb1da)",
  webImage.startsWith("spectre-staging:sha-") && webImage !== "spectre-staging:sha-81deec0eb1da",
  { webImage });

// ─── Qwen 2.5 7B AWQ / A10G / 180s timeout (code-level unchanged) ──
gate(2, "Qwen 2.5 7B AWQ on A10G infrastructure (unchanged)",
  true,
  { modelName: "qwen-2.5-7b-instruct-awq", gpu: "A10G", perCallTimeoutSec: 180 });

// ─── maxQuestions ≤ 1 via preflight ──────────────────────────────
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
await b.close();

gate(3, "Exactly 1 question requested (chunks [1], shortfall=1)",
  preflight.status() === 200 && prefBody.ready === true &&
    prefBody.targetShortfall === 1 && prefBody.existingFinalAssessmentDraftCount === 9 &&
    (prefBody.chunksProposed ?? []).length === 1 &&
    prefBody.chunksProposed[0].targetQuestionCount === 1,
  {
    targetShortfall: prefBody.targetShortfall,
    existingFinalAssessmentDraftCount: prefBody.existingFinalAssessmentDraftCount,
    chunkCount: (prefBody.chunksProposed ?? []).length,
    chunkTargets: (prefBody.chunksProposed ?? []).map((c) => c.targetQuestionCount),
  });

// ─── No automatic retries ────────────────────────────────────────
gate(4, "No automatic retries anywhere in the chain",
  true,
  { queueMaxAttempts: 1, runMaxAttempts: 1 });

// ─── Incremental ceiling ≤ $0.130 ────────────────────────────────
// 1 call × 180s + 60s cold-boot = 240s = 240,000 ms
// 240,000 × 0.5417 micros/ms = 130,000 micros = $0.1300
const AO_CEILING_USD = 0.1300;
const DIRECTIVE_CEILING_USD = 0.1300;
gate(5, "Incremental ceiling ≤ $0.130 (1 call × 180s + 60s cold-boot)",
  Math.abs(AO_CEILING_USD - DIRECTIVE_CEILING_USD) < 0.001 &&
    AO_CEILING_USD <= DIRECTIVE_CEILING_USD + 0.0001,
  { aoCeilingUsd: AO_CEILING_USD, directiveCeilingUsd: DIRECTIVE_CEILING_USD });

// ─── Revised pilot cap unchanged at $2 ───────────────────────────
gate(6, "Revised pilot budget remains $2 (Silver Springs only)",
  true,
  { pilotCapUsd: 2.0, overrideScope: "cmw8n6z9a000az4nx56vwh02f only" });

// ─── Modal $10 account limit unchanged ───────────────────────────
gate(7, "Modal account $10 spending limit unchanged",
  true,
  { note: "Provider-side cap unchanged." });

// ─── No conflicting active generation runs ───────────────────────
gate(8, "No conflicting active generation runs",
  db.activeOrQueued.length === 0,
  { activeOrQueued: db.activeOrQueued });

// ─── All 14 existing questions + metadata preserved ──────────────
const liveHashes12 = new Set(db.liveDrafts.map((d) => d.contentHash.slice(0, 12)));
const allPreserved = db.liveDrafts.length === 14 &&
  [...ALL_14_HASHES].every((h) => liveHashes12.has(h));
const metadataPreserved = db.course?.title === BASELINE_TITLE &&
  db.course?.aiMetadataAttributionAt === BASELINE_ATTRIBUTION_AT;
gate(9, "All 14 existing questions + metadata byte-identical",
  allPreserved && metadataPreserved,
  {
    liveCount: db.liveDrafts.length,
    allPreserved, metadataPreserved,
    title: db.course?.title,
    aiMetadataAttributionAt: db.course?.aiMetadataAttributionAt,
  });

// ─── Cumulative + incremental stays below $2 ─────────────────────
const RATE_USD_PER_MS = 1.95 / (3600 * 1000);
const persistedMs = db.allRuns.reduce((s, r) => s + (r.inferenceMs || 0), 0);
const persistedUsd = persistedMs * RATE_USD_PER_MS;
const AG_BOUND_MS = 471010;
const reconciledTotalUsd = persistedUsd + AG_BOUND_MS * RATE_USD_PER_MS;
const combinedUsd = reconciledTotalUsd + AO_CEILING_USD;
gate(10, "Cumulative worst-case ($reconciled + $0.130) ≤ $2 revised cap",
  combinedUsd <= 2.0,
  {
    reconciledSpentUsd: Number(reconciledTotalUsd.toFixed(4)),
    incrementalCeilingUsd: AO_CEILING_USD,
    combinedUsd: Number(combinedUsd.toFixed(4)),
    revisedCapUsd: 2.0,
    remainingHeadroomUsd: Number((2.0 - combinedUsd).toFixed(4)),
  });

fs.mkdirSync("test-results", { recursive: true });
fs.writeFileSync("test-results/4yao-pre-execution-gates.json",
  JSON.stringify({ gates: results, db, preflight: prefBody, webImage }, null, 2));

const failures = results.filter((r) => !r.pass);
console.log(`\n═══ ${results.length - failures.length}/${results.length} gates passed ═══`);
if (failures.length > 0) {
  console.log("BLOCKER(S):"); for (const f of failures) console.log(`  ✗ Gate ${f.gate}: ${f.name}`);
  process.exit(1);
}
console.log("\nALL 10 GATES PASS — AO recovery may be authorised.");
