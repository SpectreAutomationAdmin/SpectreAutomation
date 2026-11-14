#!/usr/bin/env node
// EP-TRAIN-4Y-BA post-deploy — forensic probe of the current run state.
import { execSync } from "node:child_process";
const VERSION_ID = "cmwgl11wv002jh25jb8gfzlwi";
const script = `
const { PrismaClient } = require("@prisma/client");
const p = new PrismaClient();
(async () => {
  try {
    const nonTerminal = await p.trainingQuestionAiGenerationRun.findMany({
      where: { courseVersionId: "${VERSION_ID}",
        executionStatus: { in: ["REQUESTED","QUEUED","RUNNING","COMPLETED"] } },
      orderBy: { requestedAt: "desc" },
      select: { id: true, executionStatus: true, requestedAt: true, startedAt: true,
        completedAt: true, leaseExpiresAt: true, inferenceMs: true, gpuSeconds: true,
        executionErrorCode: true, executionErrorMessage: true },
    });
    const drafts = await p.trainingQuestionAiDraft.findMany({
      where: { courseVersionId: "${VERSION_ID}" },
      orderBy: { generatedAt: "asc" },
      select: { id: true, state: true, contentHash: true, generatedAt: true, generationRunId: true },
    });
    const costAgg = await p.trainingQuestionAiGenerationRun.aggregate({
      where: { courseVersionId: "${VERSION_ID}" },
      _sum: { inferenceMs: true, gpuSeconds: true },
    });
    const transcriptionCost = await p.trainingTranscriptionJob.aggregate({
      where: { courseVersionId: "${VERSION_ID}" },
      _sum: { estimatedCostUsdMicros: true },
    });
    console.log("==PROBE_BEGIN==");
    console.log(JSON.stringify({ nonTerminal, drafts, costAgg, transcriptionCost }, null, 2));
    console.log("==PROBE_END==");
  } catch (e) {
    console.log("==PROBE_BEGIN==");
    console.log(JSON.stringify({ error: e.message }));
    console.log("==PROBE_END==");
  } finally { await p.$disconnect(); }
})();
`;
const b64 = Buffer.from(script,"utf8").toString("base64");
const flyctl = "C:/Users/cturcato/.fly/bin/flyctl.exe";
const out = execSync(`"${flyctl}" ssh console --app spectre-staging --command 'sh -lc "cd /app && echo ${b64} | base64 -d | node"'`,
  { encoding:"utf8", maxBuffer: 10*1024*1024, shell:"bash.exe" });
const m = out.match(/==PROBE_BEGIN==\s*([\s\S]*?)\s*==PROBE_END==/);
console.log(m ? m[1] : out.slice(-2000));
