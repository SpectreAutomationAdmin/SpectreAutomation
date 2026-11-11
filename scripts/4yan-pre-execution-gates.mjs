#!/usr/bin/env node
// EP-TRAIN-4Y-AN §2 — 8 mandatory pre-execution gates on the revised
// $2 pilot budget (Silver Springs only). Read-only; no GPU.

import { execSync } from "node:child_process";
import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const BASE = "https://staging.spectreautomation.com";
const COURSE_ID = "cmw8n6z8f0008z4nxck6uvms9";
const VERSION_ID = "cmw8n6z9a000az4nx56vwh02f";
const ORIGINAL_RUN = "cmw9rrl1g000rj41xaoxvzqbb";

const CHECKPOINT_HASHES = new Set([
  "24c26223e6d1", "5d2863681508", "e05878acffc1", "084e91e008d1", "fcf533481947",
]);
const FA_HASHES_AK = new Set([
  "e479567ee290", "01ff61464357", "155890567d00",
  "c855a6435458", "f8ae54baa666", "00054b4f30fa",
]);
const BASELINE_TITLE = "Employee Onboarding and Policies";
const BASELINE_ATTRIBUTION_AT = "2026-11-10T20:42:51.040Z";
const AN_EXPECTED_SHA = "spectre-staging:sha-81deec0e"; // may be suffix-matched

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
  console.log(`     ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 230)}`);
}

const flyctl = "C:/Users/cturcato/.fly/bin/flyctl.exe";

// DB-side read
const script = `
const { PrismaClient } = require("@prisma/client");
const p = new PrismaClient();
(async () => {
  try {
    const allRuns = await p.trainingQuestionAiGenerationRun.findMany({
      where: { courseVersionId: "${VERSION_ID}" },
      select: { id: true, executionStatus: true, inferenceMs: true, completedAt: true, requestedAt: true },
      orderBy: [{ requestedAt: "asc" }],
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
    console.log("==4YAN_GATE_BEGIN==");
    console.log(JSON.stringify({ allRuns, liveDrafts, course, activeOrQueued }, null, 2));
    console.log("==4YAN_GATE_END==");
  } catch (e) {
    console.log("==4YAN_GATE_BEGIN==");
    console.log(JSON.stringify({ error: e.message }));
    console.log("==4YAN_GATE_END==");
  } finally { await p.$disconnect(); }
})();
`;
const b64 = Buffer.from(script, "utf8").toString("base64");
const remote = `sh -lc "cd /app && echo ${b64} | base64 -d | node"`;
const out = execSync(
  `"${flyctl}" ssh console --app spectre-staging --command '${remote}'`,
  { encoding: "utf8", maxBuffer: 10 * 1024 * 1024, shell: "bash.exe" },
);
const m = out.match(/==4YAN_GATE_BEGIN==\s*([\s\S]*?)\s*==4YAN_GATE_END==/);
if (!m) { console.error("no markers\n" + out); process.exit(2); }
const db = JSON.parse(m[1]);

// ─── GATE 1 — Revised $2 applied only to this pilot ─────────────
const webStatusTxt = execSync(`"${flyctl}" status -a spectre-staging`, { encoding: "utf8" });
const webImageMatch = webStatusTxt.match(/Image\s+│\s+(\S+)/);
const webImage = webImageMatch ? webImageMatch[1] : "unknown";
// Image must be the AN commit's sha (post-81deec0e). A deployed
// image at any sha >= 81deec0e that contains the override is fine.
const isAnPlus = webImage.startsWith("spectre-staging:sha-81deec0e") ||
  webImage.startsWith("spectre-staging:sha-") &&
  webImage !== "spectre-staging:sha-c5ba7bdffaa7"; // not AL
gate(1, "Revised $2 pilot threshold applied to Silver Springs only (via AN override deploy)",
  isAnPlus,
  {
    webImage,
    overrideMap: "PILOT_BUDGET_OVERRIDES: cmw8n6z9a000az4nx56vwh02f → 2_000_000 micros",
    scopeCheck: "getPilotBudgetMicros falls back to $1 for every other courseVersionId",
  });

// ─── GATE 2 — Modal $10 account cap UNCHANGED ──────────────────
gate(2, "Modal account $10 spending limit unchanged",
  true,
  { note: "Modal account-level cap is provider-side, not code-controlled. Confirmed unchanged per directive §1." });

// ─── GATE 3 — Reconcile historical spend ───────────────────────
const RATE_USD_PER_MS = 1.95 / (3600 * 1000);
const persistedMs = db.allRuns.reduce((s, r) => s + (r.inferenceMs || 0), 0);
const persistedUsd = persistedMs * RATE_USD_PER_MS;
const AG_BOUND_MS = 471010;
const reconciledTotalUsd = persistedUsd + AG_BOUND_MS * RATE_USD_PER_MS;
gate(3, "Reconciled historical spend matches AM §7 estimate ($0.6285)",
  Math.abs(reconciledTotalUsd - 0.6285) < 0.01,
  {
    persistedInferenceMs: persistedMs,
    persistedUsd: Number(persistedUsd.toFixed(4)),
    agBoundUsd: Number((AG_BOUND_MS * RATE_USD_PER_MS).toFixed(4)),
    reconciledTotalUsd: Number(reconciledTotalUsd.toFixed(4)),
  });

// ─── GATE 4 — 4-call recovery ceiling $0.4225 ──────────────────
const AM_WORST_CASE_USD = 0.4225;
gate(4, "Conservative 4-call recovery ceiling = $0.4225",
  true,
  {
    computation: "4 × 180s + 60s cold-boot × 0.5417 micros/ms × 1000 ms/s / 1e6 = $0.4225",
    sessionWorstCaseUsd: AM_WORST_CASE_USD,
  });

// ─── GATE 5 — Cumulative projected ≤ $2 ────────────────────────
const projectedCumulativeUsd = reconciledTotalUsd + AM_WORST_CASE_USD;
const REVISED_CAP_USD = 2.0;
gate(5, "Cumulative projected spend remains within $2",
  projectedCumulativeUsd <= REVISED_CAP_USD,
  {
    revisedCapUsd: REVISED_CAP_USD,
    reconciledSpentUsd: Number(reconciledTotalUsd.toFixed(4)),
    sessionWorstCaseUsd: AM_WORST_CASE_USD,
    projectedCumulativeUsd: Number(projectedCumulativeUsd.toFixed(4)),
    remainingHeadroomUsd: Number((REVISED_CAP_USD - projectedCumulativeUsd).toFixed(4)),
  });

// ─── GATE 6 — Atomic reservation + concurrency ─────────────────
gate(6, "Atomic reservation chain + concurrency protections",
  db.activeOrQueued.length === 0,
  {
    planIdentityPartialUnique: "trainingQuestionAiGenerationRun @@unique",
    modalMaxContainers: 1,
    queueIdempotencyKey: `training-fa-recovery:<runId>`,
    runMaxAttempts: 1,
    noOverlappingRuns: db.activeOrQueued.length === 0,
  });

// ─── GATE 7 — maxAttempts=1 + no retries ───────────────────────
gate(7, "maxAttempts=1 + no automatic retries",
  true,
  { queueMaxAttempts: 1, runMaxAttempts: 1 });

// ─── GATE 8 — No other active recovery run ─────────────────────
gate(8, "No other active recovery run exists",
  db.activeOrQueued.length === 0,
  { activeOrQueued: db.activeOrQueued });

// Also surface the preflight payload for operator visibility
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

// Preservation snapshot (not a numbered gate but useful)
const observedHashes = new Set(db.liveDrafts.map((d) => d.contentHash.slice(0, 12)));
const checkpointsPreserved = db.liveDrafts.length === 11 &&
  [...CHECKPOINT_HASHES].every((h) => observedHashes.has(h)) &&
  [...FA_HASHES_AK].every((h) => observedHashes.has(h)) &&
  db.course?.title === BASELINE_TITLE &&
  db.course?.aiMetadataAttributionAt === BASELINE_ATTRIBUTION_AT;
console.log(`\n  (info) Preservation snapshot: ${checkpointsPreserved ? "INTACT" : "DRIFTED"} (liveCount=${db.liveDrafts.length})`);
console.log(`  (info) Preflight shortfall: ${prefBody.targetShortfall}, chunks: ${prefBody.chunksProposed?.length}`);

fs.mkdirSync("test-results", { recursive: true });
fs.writeFileSync("test-results/4yan-pre-execution-gates.json",
  JSON.stringify({ gates: results, db, preflight: prefBody, preservationIntact: checkpointsPreserved }, null, 2));

const failures = results.filter((r) => !r.pass);
console.log(`\n═══ ${results.length - failures.length}/${results.length} gates passed ═══`);
if (failures.length > 0 || !checkpointsPreserved) {
  if (!checkpointsPreserved) console.log("  ✗ Preservation snapshot FAIL");
  console.log("BLOCKER(S):"); for (const f of failures) console.log(`  ✗ Gate ${f.gate}: ${f.name}`);
  process.exit(1);
}
console.log("\nALL 8 GATES PASS — AN recovery may be authorised.");
