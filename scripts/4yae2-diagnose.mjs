#!/usr/bin/env node
// EP-TRAIN-4Y-AE2 §2 + §4 — diagnose checkpoint ordering + inspect
// the full supersedes chain for all 5 current drafts.

import { spawn } from "node:child_process";
import fs from "node:fs";

const FLYCTL = process.env.FLYCTL_BIN ??
  (process.platform === "win32"
    ? "C:\\Users\\cturcato\\.fly\\bin\\flyctl.exe"
    : "/usr/local/bin/flyctl");
const APP = "spectre-staging";
const VERSION_ID = "cmw8n6z9a000az4nx56vwh02f";
const RUN_ID = "cmw9rrl1g000rj41xaoxvzqbb";

const script = `
import { PrismaClient } from "/app/node_modules/@prisma/client/default.js";
const p = new PrismaClient();
try {
  const VERSION_ID = ${JSON.stringify(VERSION_ID)};
  const RUN_ID = ${JSON.stringify(RUN_ID)};
  // Load generation run + plan.
  const run = await p.trainingQuestionAiGenerationRun.findUnique({
    where: { id: RUN_ID },
    select: {
      id: true,
      shortfallReasonJson: true,
      assessmentPlanJson: true,
    },
  });
  // Parse plan.proposedCheckpointGroups for id → atSec.
  const planObj = run?.assessmentPlanJson ? JSON.parse(run.assessmentPlanJson) : {};
  const groupAtSec = {};
  for (const g of (planObj.proposedCheckpointGroups ?? [])) {
    if (typeof g.id === "string" && typeof g.atSec === "number") {
      groupAtSec[g.id] = g.atSec;
    }
  }
  // Parse shortfall to get contentHash → group mapping.
  const sfj = run?.shortfallReasonJson ? JSON.parse(run.shortfallReasonJson) : {};
  const hashToGroup = {};
  for (const d of (sfj.dedupDecisions ?? [])) {
    if (d.kept === true && typeof d.candidateContentHash === "string" && typeof d.group === "string") {
      hashToGroup[d.candidateContentHash] = d.group;
    }
  }
  // Load ALL drafts for the version in ascending generatedAt order.
  const drafts = await p.trainingQuestionAiDraft.findMany({
    where: { courseVersionId: VERSION_ID },
    orderBy: { generatedAt: "asc" },
    select: {
      id: true, state: true, contentHash: true, supersedesDraftId: true,
      generatedAt: true, generationRunId: true, draftJson: true,
    },
  });
  // Build supersedes chain: for each ACTIVE row, walk UP via supersedesDraftId
  // to find the ORIGINAL ancestor.
  const byId = Object.fromEntries(drafts.map((d) => [d.id, d]));
  const activeStates = new Set([
    "GENERATED", "VALIDATION_PENDING", "REQUIRES_HUMAN_REVIEW",
    "APPROVED_DRAFT", "EDITED_VALIDATION_STALE", "VALIDATION_FAILED",
  ]);
  const active = drafts.filter((d) => activeStates.has(d.state));
  const rows = [];
  for (const d of active) {
    const chain = [d];
    let cursor = d.supersedesDraftId;
    while (cursor && byId[cursor]) {
      chain.unshift(byId[cursor]);
      cursor = byId[cursor].supersedesDraftId;
    }
    const original = chain[0];
    const group = hashToGroup[original.contentHash] ?? null;
    const atSec = group ? (groupAtSec[group] ?? null) : null;
    const body = (() => { try { return JSON.parse(d.draftJson); } catch { return {}; } })();
    const originalBody = (() => { try { return JSON.parse(original.draftJson); } catch { return {}; } })();
    rows.push({
      activeId: d.id,
      activeState: d.state,
      originalId: original.id,
      originalContentHash: original.contentHash,
      group,
      atSec,
      chainLength: chain.length,
      chainIds: chain.map((x) => x.id),
      currentStem: String(body.questionText ?? "").slice(0, 240),
      currentOptions: (body.options ?? []).map((o) => String(o.text ?? "").slice(0, 80)),
      currentCorrectIndex: (body.options ?? []).findIndex((o) => !!o.isCorrect),
      originalStem: String(originalBody.questionText ?? "").slice(0, 240),
      originalOptions: (originalBody.options ?? []).map((o) => String(o.text ?? "").slice(0, 80)),
      originalCorrectIndex: (originalBody.options ?? []).findIndex((o) => !!o.isCorrect),
    });
  }
  // Sort by atSec ascending so the acceptance report is pre-ordered.
  rows.sort((a, b) => {
    const aA = a.atSec ?? Number.POSITIVE_INFINITY;
    const bA = b.atSec ?? Number.POSITIVE_INFINITY;
    if (aA !== bA) return aA - bA;
    return a.originalContentHash.localeCompare(b.originalContentHash);
  });
  console.log(JSON.stringify({ capturedAt: new Date().toISOString(), groupAtSec, hashToGroupKeys: Object.keys(hashToGroup), rows }, null, 2));
} finally { await p.$disconnect(); }
`;

async function runFly() {
  return new Promise((resolve, reject) => {
    const b64 = Buffer.from(script, "utf8").toString("base64");
    const remoteShell = "echo " + b64 + " | base64 -d | node --input-type=module";
    const args = ["ssh", "console", "--app", APP, "--command", "sh -c " + JSON.stringify(remoteShell)];
    const child = spawn(FLYCTL, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => { stdout += d; process.stdout.write(d); });
    child.stderr.on("data", (d) => { stderr += d; process.stderr.write(d); });
    child.on("close", (code) => code === 0 ? resolve({ stdout, stderr }) : reject(new Error("flyctl exited " + code)));
  });
}
const r = await runFly();
const m = r.stdout.match(/\{[\s\S]*"capturedAt"[\s\S]*\}/);
if (!m) { console.error("no JSON captured"); process.exit(1); }
fs.mkdirSync("test-results", { recursive: true });
fs.writeFileSync("test-results/4yae2-diagnose.json", m[0]);
const d = JSON.parse(m[0]);
console.log("\n━━━━━━ 4Y-AE2 §4 CHECKPOINT AUDIT (by atSec) ━━━━━━");
for (const row of d.rows) {
  console.log(`\n[atSec=${row.atSec} group=${row.group}] active=${row.activeId} chain=${row.chainLength}`);
  console.log(`  stem:         ${row.currentStem.slice(0, 140)}`);
  console.log(`  options:      ${JSON.stringify(row.currentOptions)}`);
  console.log(`  correctIndex: ${row.currentCorrectIndex}`);
  if (row.chainLength > 1) {
    console.log(`  originalStem:    ${row.originalStem.slice(0, 140)}`);
    console.log(`  originalOptions: ${JSON.stringify(row.originalOptions)}`);
    console.log(`  originalCorrect: ${row.originalCorrectIndex}`);
  }
}
