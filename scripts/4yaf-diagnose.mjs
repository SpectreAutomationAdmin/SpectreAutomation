#!/usr/bin/env node
// EP-TRAIN-4Y-AF §2 — diagnose why the 4Y-Z pilot FA group produced zero
// final-assessment questions. Read-only; no Prisma writes; no GPU.
//
// Executes inside the Fly web machine via SSH: one base64-encoded
// Prisma one-shot that dumps:
//   • the run row (executionStatus, error code, inferenceMs, tokens)
//   • the assessment plan (checkpoint + FA targets, coverage LOs,
//     eligible segment ids)
//   • the shortfall reason JSON (if any)
//   • the dedup decisions log (tells us what Modal returned per group)
//   • the persisted drafts bound to this run (by destination)
//   • transcript size + first + last segment indices
//
// Pass criterion: the output explains what the FA group returned and
// why the shortfall persisted zero rows.

import { execSync } from "node:child_process";
import fs from "node:fs";

const RUN_ID = "cmw9rrl1g000rj41xaoxvzqbb";
const COURSE_ID = "cmw8n6z8f0008z4nxck6uvms9";
const VERSION_ID = "cmw8n6z9a000az4nx56vwh02f";

const script = `
const { PrismaClient } = require("@prisma/client");
const p = new PrismaClient();
(async () => {
  try {
    const run = await p.trainingQuestionAiGenerationRun.findUnique({
      where: { id: "${RUN_ID}" },
      select: {
        id: true,
        executionStatus: true,
        executionErrorCode: true,
        executionErrorMessage: true,
        attempts: true,
        maxAttempts: true,
        inferenceMs: true,
        promptTokenCount: true,
        outputTokenCount: true,
        modelName: true,
        modalAppIdentity: true,
        queuedAt: true,
        startedAt: true,
        completedAt: true,
        shortfallReasonJson: true,
        assessmentPlanJson: true,
        resolvedTranscriptBuildId: true,
        groundingProjectionSha256: true,
      },
    });
    if (!run) { console.log(JSON.stringify({ ok:false, error: "RUN_NOT_FOUND" })); return; }

    const plan = run.assessmentPlanJson ? JSON.parse(run.assessmentPlanJson) : null;
    const shortfall = run.shortfallReasonJson ? JSON.parse(run.shortfallReasonJson) : null;

    // Group the dedup decisions by group
    const dedupByGroup = {};
    if (shortfall && Array.isArray(shortfall.dedupDecisions)) {
      for (const d of shortfall.dedupDecisions) {
        const g = d.group || "(none)";
        if (!dedupByGroup[g]) dedupByGroup[g] = { kept: 0, dropped: 0, verdicts: {} };
        if (d.kept === true) dedupByGroup[g].kept++;
        else dedupByGroup[g].dropped++;
        const v = d.decision && d.decision.verdict ? d.decision.verdict : "unknown";
        dedupByGroup[g].verdicts[v] = (dedupByGroup[g].verdicts[v] || 0) + 1;
      }
    }

    // Persisted drafts bound to this run
    const drafts = await p.trainingQuestionAiDraft.findMany({
      where: { generationRunId: "${RUN_ID}" },
      select: {
        id: true,
        state: true,
        contentHash: true,
        generatedAt: true,
        supersedesDraftId: true,
      },
      orderBy: [{ generatedAt: "asc" }],
    });

    // Transcript size
    const build = await p.trainingTranscriptBuild.findFirst({
      where: { id: run.resolvedTranscriptBuildId ? undefined : undefined },
      select: { id: true },
    }).catch(() => null);
    let segmentStats = null;
    if (plan && plan.eligibleSegmentIds) {
      segmentStats = {
        count: plan.eligibleSegmentIds.length,
        min: plan.eligibleSegmentIds[0],
        max: plan.eligibleSegmentIds[plan.eligibleSegmentIds.length - 1],
        excluded: plan.sourceEvidenceRequirements && plan.sourceEvidenceRequirements.excludedSegmentIndices
          ? plan.sourceEvidenceRequirements.excludedSegmentIndices : [],
      };
    }

    const report = {
      ok: true,
      run: {
        id: run.id,
        status: run.executionStatus,
        errorCode: run.executionErrorCode,
        errorMessage: run.executionErrorMessage,
        attempts: run.attempts + "/" + run.maxAttempts,
        inferenceMs: run.inferenceMs,
        promptTokens: run.promptTokenCount,
        outputTokens: run.outputTokenCount,
        model: run.modelName,
        modalAppIdentity: run.modalAppIdentity,
        queuedAt: run.queuedAt,
        startedAt: run.startedAt,
        completedAt: run.completedAt,
      },
      plan: plan ? {
        schemaVersion: plan.schemaVersion,
        promptContract: plan.generationPromptContract || "(legacy)",
        totalTarget: plan.totalTargetQuestionCount,
        checkpointGroups: (plan.proposedCheckpointGroups || []).map((cg) => ({
          id: cg.id,
          atSec: cg.atSec,
          target: cg.targetQuestionCount,
          los: cg.learningObjectiveIds,
        })),
        finalAssessment: plan.proposedFinalAssessment ? {
          target: plan.proposedFinalAssessment.targetQuestionCount,
          coverageLos: plan.proposedFinalAssessment.coverageLearningObjectiveIds,
        } : null,
        learningObjectiveCount: (plan.learningObjectives || []).length,
        firstLoTitles: (plan.learningObjectives || []).slice(0, 5).map((lo) => lo.title),
      } : null,
      segmentStats,
      shortfall: shortfall ? {
        schemaVersion: shortfall.schemaVersion || "v1-implicit",
        shortfallCount: shortfall.shortfallCount,
        sanitizerDropCount: shortfall.sanitizerDropCount,
        dedupDropCount: shortfall.dedupDropCount,
        hasPerGroupDiagnostics: Array.isArray(shortfall.perGroupDiagnostics),
        perGroupDiagnostics: shortfall.perGroupDiagnostics || null,
        dedupByGroup,
        totalDedupRows: Array.isArray(shortfall.dedupDecisions) ? shortfall.dedupDecisions.length : 0,
        otherKeys: Object.keys(shortfall).filter(k => !["schemaVersion","shortfallCount","sanitizerDropCount","dedupDropCount","dedupDecisions","perGroupDiagnostics"].includes(k)),
      } : null,
      draftCount: drafts.length,
      draftStates: drafts.reduce((acc, d) => { acc[d.state] = (acc[d.state]||0)+1; return acc; }, {}),
    };
    console.log("==4YAF_REPORT_BEGIN==");
    console.log(JSON.stringify(report, null, 2));
    console.log("==4YAF_REPORT_END==");
  } catch (e) {
    console.log(JSON.stringify({ ok:false, error: e.message, stack: e.stack }));
  } finally {
    await p.$disconnect();
  }
})();
`;

const b64 = Buffer.from(script, "utf8").toString("base64");
const remote = `sh -lc "cd /app && echo ${b64} | base64 -d | node"`;
const flyctl = "C:/Users/cturcato/.fly/bin/flyctl.exe";

process.stderr.write("Running 4YAF diagnostic over Fly SSH...\n");
const out = execSync(
  `"${flyctl}" ssh console --app spectre-staging --command '${remote}'`,
  { encoding: "utf8", maxBuffer: 10 * 1024 * 1024, shell: "bash.exe" },
);

fs.mkdirSync("test-results", { recursive: true });
fs.writeFileSync("test-results/4yaf-diagnose.raw.txt", out);

const m = out.match(/==4YAF_REPORT_BEGIN==\s*([\s\S]*?)\s*==4YAF_REPORT_END==/);
if (!m) {
  process.stderr.write("No report markers found in SSH output. Raw saved.\n");
  process.exit(1);
}
const report = JSON.parse(m[1]);
fs.writeFileSync("test-results/4yaf-diagnose.json", JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
