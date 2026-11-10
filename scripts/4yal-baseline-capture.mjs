#!/usr/bin/env node
// EP-TRAIN-4Y-AL §1 — capture baseline hashes + IDs of all 11 existing
// questions BEFORE any AL code change. Read-only; written to
// test-results/4yal-baseline.json as the preservation anchor.

import { execSync } from "node:child_process";
import fs from "node:fs";

const VERSION_ID = "cmw8n6z9a000az4nx56vwh02f";
const ORIGINAL_RUN = "cmw9rrl1g000rj41xaoxvzqbb";
const AK_RUN = "cmwbatqv9000j3ykfqccbyt7v";

const script = `
const { PrismaClient } = require("@prisma/client");
const p = new PrismaClient();
(async () => {
  try {
    const liveDrafts = await p.trainingQuestionAiDraft.findMany({
      where: { courseVersionId: "${VERSION_ID}",
        state: { in: ["REQUIRES_HUMAN_REVIEW","EDITED_VALIDATION_STALE","VALIDATION_FAILED","GENERATED","VALIDATION_PENDING","APPROVED_DRAFT","PROMOTED"] } },
      select: {
        id: true, state: true, contentHash: true, generationRunId: true, generatedAt: true,
        supersedesDraftId: true, draftJson: true,
      },
      orderBy: { generatedAt: "asc" },
    });
    const originalRun = await p.trainingQuestionAiGenerationRun.findUnique({
      where: { id: "${ORIGINAL_RUN}" },
      select: { executionStatus: true, shortfallReasonJson: true },
    });
    const akRun = await p.trainingQuestionAiGenerationRun.findUnique({
      where: { id: "${AK_RUN}" },
      select: { executionStatus: true, inferenceMs: true, promptTokenCount: true, outputTokenCount: true, shortfallReasonJson: true },
    });
    const course = await p.trainingCourse.findUnique({
      where: { id: "cmw8n6z8f0008z4nxck6uvms9" },
      select: { title: true, description: true, code: true, aiMetadataAttributionAt: true, aiMetadataAttributionSource: true },
    });

    console.log("==4YAL_BASE_BEGIN==");
    console.log(JSON.stringify({
      drafts: liveDrafts.map((d) => ({
        id: d.id, state: d.state, contentHash: d.contentHash, generationRunId: d.generationRunId,
        generatedAt: d.generatedAt, supersedesDraftId: d.supersedesDraftId,
        // Only questionText + correctIdx surfaced so the baseline file doesn't balloon
        questionText: (() => { try { return JSON.parse(d.draftJson || "{}").questionText; } catch { return null; } })(),
        correctIdx: (() => {
          try {
            const opts = JSON.parse(d.draftJson || "{}").options || [];
            return opts.findIndex((o) => o.isCorrect);
          } catch { return -1; }
        })(),
      })),
      originalRunStatus: originalRun?.executionStatus,
      originalRunShortfallSize: (originalRun?.shortfallReasonJson || "").length,
      akRun,
      course,
    }, null, 2));
    console.log("==4YAL_BASE_END==");
  } catch (e) {
    console.log("==4YAL_BASE_BEGIN==");
    console.log(JSON.stringify({ error: e.message }));
    console.log("==4YAL_BASE_END==");
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
const m = out.match(/==4YAL_BASE_BEGIN==\s*([\s\S]*?)\s*==4YAL_BASE_END==/);
if (!m) { console.error("no markers"); process.exit(1); }
const data = JSON.parse(m[1]);

const checkpoints = data.drafts.filter((d) => d.generationRunId === ORIGINAL_RUN);
const faDrafts = data.drafts.filter((d) => d.generationRunId === AK_RUN);

console.log(`\nTotal live drafts: ${data.drafts.length} (expected 11)`);
console.log(`\n5 Checkpoints:`);
for (const d of checkpoints) {
  console.log(`  ${d.id}  state=${d.state}  hash=${d.contentHash.slice(0, 16)}...`);
  console.log(`    ${(d.questionText || "").slice(0, 80)}...`);
}
console.log(`\n6 Final Assessment drafts:`);
for (const d of faDrafts) {
  console.log(`  ${d.id}  state=${d.state}  hash=${d.contentHash.slice(0, 16)}...`);
  console.log(`    ${(d.questionText || "").slice(0, 100)}...`);
}
console.log(`\nCourse metadata:`);
console.log(`  title=${data.course.title}`);
console.log(`  aiMetadataAttributionAt=${data.course.aiMetadataAttributionAt}`);

fs.mkdirSync("test-results", { recursive: true });
fs.writeFileSync("test-results/4yal-baseline.json", JSON.stringify(data, null, 2));
console.log("\nBaseline saved to test-results/4yal-baseline.json");
