#!/usr/bin/env node
import { execSync } from "node:child_process";
import fs from "node:fs";
const RUN_ID = "cmwbatqv9000j3ykfqccbyt7v";
const MAX_WAIT_MS = 15 * 60 * 1000;
const POLL_MS = 30 * 1000;
const flyctl = "C:/Users/cturcato/.fly/bin/flyctl.exe";

function probe() {
  const script = `
const { PrismaClient } = require("@prisma/client");
const p = new PrismaClient();
(async () => {
  try {
    const r = await p.trainingQuestionAiGenerationRun.findUnique({
      where: { id: "${RUN_ID}" },
      select: {
        executionStatus: true, executionErrorCode: true, executionErrorMessage: true,
        attempts: true, maxAttempts: true, inferenceMs: true,
        promptTokenCount: true, outputTokenCount: true,
        startedAt: true, completedAt: true, shortfallReasonJson: true,
      },
    });
    const drafts = await p.trainingQuestionAiDraft.count({ where: { generationRunId: "${RUN_ID}" } });
    console.log("==4YAK_PROBE_BEGIN==");
    console.log(JSON.stringify({ run: r, draftCount: drafts }, null, 2));
    console.log("==4YAK_PROBE_END==");
  } catch (e) {
    console.log("==4YAK_PROBE_BEGIN==");
    console.log(JSON.stringify({ error: e.message }));
    console.log("==4YAK_PROBE_END==");
  } finally { await p.$disconnect(); }
})();
`;
  const b64 = Buffer.from(script, "utf8").toString("base64");
  const remote = `sh -lc "cd /app && echo ${b64} | base64 -d | node"`;
  const out = execSync(
    `"${flyctl}" ssh console --app spectre-staging --command '${remote}'`,
    { encoding: "utf8", maxBuffer: 10 * 1024 * 1024, shell: "bash.exe" },
  );
  const m = out.match(/==4YAK_PROBE_BEGIN==\s*([\s\S]*?)\s*==4YAK_PROBE_END==/);
  if (!m) throw new Error("no markers");
  return JSON.parse(m[1]);
}

const start = Date.now();
let report;
while (Date.now() - start < MAX_WAIT_MS) {
  report = probe();
  const r = report.run || {};
  const t = Math.round((Date.now() - start) / 1000);
  console.log(`t+${t}s  state=${r.executionStatus}  attempts=${r.attempts}/${r.maxAttempts}  drafts=${report.draftCount}  err=${r.executionErrorCode || ""}  infMs=${r.inferenceMs || 0}`);
  if (r.executionStatus === "COMPLETED" || r.executionStatus === "FAILED" || r.executionStatus === "CANCELLED") break;
  await new Promise((r2) => setTimeout(r2, POLL_MS));
}
fs.mkdirSync("test-results", { recursive: true });
fs.writeFileSync("test-results/4yak-terminal-state.json", JSON.stringify({ at: new Date().toISOString(), ...report }, null, 2));
console.log("\nFinal:");
console.log(JSON.stringify(report, null, 2));
