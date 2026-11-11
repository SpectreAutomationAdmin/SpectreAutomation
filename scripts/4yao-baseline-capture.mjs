#!/usr/bin/env node
// EP-TRAIN-4Y-AO §1 — capture all 14 existing question hashes + IDs
// BEFORE any AO code change. Read-only; preservation anchor.

import { execSync } from "node:child_process";
import fs from "node:fs";

const VERSION_ID = "cmw8n6z9a000az4nx56vwh02f";
const ORIGINAL_RUN = "cmw9rrl1g000rj41xaoxvzqbb";
const AK_RUN = "cmwbatqv9000j3ykfqccbyt7v";
const AN_RUN = "cmwbdnn1b000d58whatdxvp5u";

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
    const course = await p.trainingCourse.findUnique({
      where: { id: "cmw8n6z8f0008z4nxck6uvms9" },
      select: { title: true, description: true, code: true, aiMetadataAttributionAt: true, aiMetadataAttributionSource: true },
    });
    console.log("==4YAO_BASE_BEGIN==");
    console.log(JSON.stringify({
      drafts: liveDrafts.map((d) => ({
        id: d.id, state: d.state, contentHash: d.contentHash,
        generationRunId: d.generationRunId, generatedAt: d.generatedAt,
        supersedesDraftId: d.supersedesDraftId,
        questionText: (() => { try { return JSON.parse(d.draftJson || "{}").questionText; } catch { return null; } })(),
        correctIdx: (() => {
          try {
            const opts = JSON.parse(d.draftJson || "{}").options || [];
            return opts.findIndex((o) => o.isCorrect);
          } catch { return -1; }
        })(),
      })),
      course,
    }, null, 2));
    console.log("==4YAO_BASE_END==");
  } catch (e) {
    console.log("==4YAO_BASE_BEGIN==");
    console.log(JSON.stringify({ error: e.message }));
    console.log("==4YAO_BASE_END==");
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
const m = out.match(/==4YAO_BASE_BEGIN==\s*([\s\S]*?)\s*==4YAO_BASE_END==/);
if (!m) { console.error("no markers"); process.exit(1); }
const data = JSON.parse(m[1]);

const checkpoints = data.drafts.filter((d) => d.generationRunId === ORIGINAL_RUN);
const akFa = data.drafts.filter((d) => d.generationRunId === AK_RUN);
const anFa = data.drafts.filter((d) => d.generationRunId === AN_RUN);

console.log(`\nTotal live drafts: ${data.drafts.length} (expected 14)`);

console.log(`\n5 Checkpoints:`);
for (const d of checkpoints) console.log(`  ${d.id}  hash=${d.contentHash.slice(0, 12)}...  "${(d.questionText || "").slice(0, 72)}..."`);

console.log(`\n6 AK FA drafts:`);
for (const d of akFa) console.log(`  ${d.id}  hash=${d.contentHash.slice(0, 12)}...  "${(d.questionText || "").slice(0, 72)}..."`);

console.log(`\n3 AN FA drafts:`);
for (const d of anFa) console.log(`  ${d.id}  hash=${d.contentHash.slice(0, 12)}...  "${(d.questionText || "").slice(0, 72)}..."`);

console.log(`\nCourse metadata:`);
console.log(`  title=${data.course.title}`);
console.log(`  aiMetadataAttributionAt=${data.course.aiMetadataAttributionAt}`);

fs.mkdirSync("test-results", { recursive: true });
fs.writeFileSync("test-results/4yao-baseline.json", JSON.stringify(data, null, 2));
console.log("\nBaseline saved to test-results/4yao-baseline.json");
