#!/usr/bin/env node
// EP-TRAIN-4Y-AL §3 — fa-2 output-exhaustion forensic analysis.
// Reads AK + AI shortfallReasonJson from staging and inspects fa-2's
// perGroupDiagnostics payload. No GPU.

import { execSync } from "node:child_process";
import fs from "node:fs";

const AK_RUN = "cmwbatqv9000j3ykfqccbyt7v";
const AI_RUN = "cmwb8im9j000jvh64v96ahxwg";
const ORIGINAL_RUN = "cmw9rrl1g000rj41xaoxvzqbb";

const script = `
const { PrismaClient } = require("@prisma/client");
const p = new PrismaClient();
(async () => {
  try {
    const akRun = await p.trainingQuestionAiGenerationRun.findUnique({
      where: { id: "${AK_RUN}" },
      select: {
        inferenceMs: true, promptTokenCount: true, outputTokenCount: true,
        shortfallReasonJson: true, assessmentPlanJson: true,
      },
    });
    const aiRun = await p.trainingQuestionAiGenerationRun.findUnique({
      where: { id: "${AI_RUN}" },
      select: {
        inferenceMs: true, promptTokenCount: true, outputTokenCount: true,
        shortfallReasonJson: true, assessmentPlanJson: true,
      },
    });
    const origRun = await p.trainingQuestionAiGenerationRun.findUnique({
      where: { id: "${ORIGINAL_RUN}" },
      select: { assessmentPlanJson: true },
    });
    console.log("==4YAL_FA2_BEGIN==");
    console.log(JSON.stringify({
      ak: akRun ? {
        inferenceMs: akRun.inferenceMs,
        promptTokenCount: akRun.promptTokenCount,
        outputTokenCount: akRun.outputTokenCount,
        shortfall: JSON.parse(akRun.shortfallReasonJson || "{}"),
        plan: JSON.parse(akRun.assessmentPlanJson || "{}"),
      } : null,
      ai: aiRun ? {
        inferenceMs: aiRun.inferenceMs,
        promptTokenCount: aiRun.promptTokenCount,
        outputTokenCount: aiRun.outputTokenCount,
        shortfall: JSON.parse(aiRun.shortfallReasonJson || "{}"),
      } : null,
      orig: origRun ? { plan: JSON.parse(origRun.assessmentPlanJson || "{}") } : null,
    }, null, 2));
    console.log("==4YAL_FA2_END==");
  } catch (e) {
    console.log("==4YAL_FA2_BEGIN==");
    console.log(JSON.stringify({ error: e.message }));
    console.log("==4YAL_FA2_END==");
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
const m = out.match(/==4YAL_FA2_BEGIN==\s*([\s\S]*?)\s*==4YAL_FA2_END==/);
if (!m) { console.error("no markers"); process.exit(1); }
const data = JSON.parse(m[1]);

// Compare fa-2 across AI + AK + against other chunks
function extract(diag, group) {
  return (diag.perGroupDiagnostics || []).find((g) => g.group === group);
}

function describeChunk(label, d) {
  if (!d) return `${label}: n/a`;
  return `${label}: requested=${d.requestedCount} returned=${d.proposalCountFromModal} persisted=${d.persistedCount} | prompt=${d.modalPromptTokens} out=${d.modalOutputTokens}${d.modalOutputTokens === 2048 ? " [CAP]" : ""} | elapsed=${d.modalElapsedMs}ms`;
}

console.log("\n═══ fa-2 across AI + AK forensic comparison ═══\n");
console.log("4Y-AI shortfall:");
console.log("  " + describeChunk("fa-1", extract(data.ai.shortfall, "fa-1")));
console.log("  " + describeChunk("fa-2", extract(data.ai.shortfall, "fa-2")));
console.log("  " + describeChunk("fa-3", extract(data.ai.shortfall, "fa-3")));
console.log("  " + describeChunk("fa-4", extract(data.ai.shortfall, "fa-4")));
console.log("\n4Y-AK shortfall:");
console.log("  " + describeChunk("fa-1", extract(data.ak.shortfall, "fa-1")));
console.log("  " + describeChunk("fa-2", extract(data.ak.shortfall, "fa-2")));
console.log("  " + describeChunk("fa-3", extract(data.ak.shortfall, "fa-3")));
console.log("  " + describeChunk("fa-4", extract(data.ak.shortfall, "fa-4")));

// Pull fa-2's eligibleSegmentIds from the original plan to see what
// the chunk's content space was.
const origPlan = data.orig?.plan;
console.log("\n═══ Plan comparison ═══");
console.log(`\nOriginal plan proposedFinalAssessment.targetQuestionCount: ${origPlan?.proposedFinalAssessment?.targetQuestionCount}`);
console.log(`Original plan has proposedFinalAssessmentChunks? ${Array.isArray(origPlan?.proposedFinalAssessmentChunks)}`);
console.log(`LO count: ${(origPlan?.learningObjectives ?? []).length}`);

// AK recovery plan — pull chunks + LO coverage for fa-2
const akPlan = data.ak?.plan;
if (akPlan?.proposedFinalAssessmentChunks) {
  console.log("\n═══ AK recovery plan chunks ═══");
  for (const c of akPlan.proposedFinalAssessmentChunks) {
    const idCount = (c.eligibleSegmentIds ?? []).length;
    console.log(`  ${c.id}: target=${c.targetQuestionCount} eligibleIds=${idCount} LOs=${c.coverageLearningObjectiveIds?.length ?? 0}`);
    console.log(`    focusTopicLabel: ${c.focusTopicLabel}`);
    console.log(`    focusTopicSummary: ${(c.focusTopicSummary || "").slice(0, 150)}...`);
  }
}

fs.mkdirSync("test-results", { recursive: true });
fs.writeFileSync("test-results/4yal-fa2-forensics.json", JSON.stringify(data, null, 2));
console.log("\nFull data saved to test-results/4yal-fa2-forensics.json");
