#!/usr/bin/env node
// EP-TRAIN-4Y-BB §1 — trace the 30-marker discrepancy + current state.
import { execSync } from "node:child_process";
import fs from "node:fs";
const VID = "cmwgl11wv002jh25jb8gfzlwi";
const COURSE = "cmwgl11vx002hh25jrrcqy08k";
const script = `
const { PrismaClient } = require("@prisma/client");
const p = new PrismaClient();
(async () => {
  try {
    const runs = await p.trainingQuestionAiGenerationRun.findMany({
      where: { courseVersionId: "${VID}" },
      orderBy: { requestedAt: "asc" },
      select: { id: true, executionStatus: true, requestedAt: true, completedAt: true,
        assessmentPlanJson: true, shortfallReasonJson: true, inferenceMs: true,
        executionErrorCode: true, executionErrorMessage: true },
      take: 5, // first few
    });
    const latestRuns = await p.trainingQuestionAiGenerationRun.findMany({
      where: { courseVersionId: "${VID}" },
      orderBy: { requestedAt: "desc" },
      select: { id: true, executionStatus: true, requestedAt: true, completedAt: true,
        assessmentPlanJson: true, shortfallReasonJson: true, inferenceMs: true,
        executionErrorCode: true, executionErrorMessage: true,
        _count: { select: { drafts: true } } },
      take: 5,
    });
    const checkpoints = await p.trainingCheckpoint.findMany({
      where: { courseVersionId: "${VID}" },
      select: { id: true, atSecond: true, label: true, requiredToProceed: true, createdAt: true },
      orderBy: { atSecond: "asc" },
    });
    const questions = await p.trainingQuestion.findMany({
      where: { courseVersionId: "${VID}" },
      select: { id: true, prompt: true, checkpointId: true, displayOrder: true, active: true,
        aiPromotion: { select: { questionId: true } } },
      orderBy: { displayOrder: "asc" },
    });
    const drafts = await p.trainingQuestionAiDraft.findMany({
      where: { courseVersionId: "${VID}" },
      select: { id: true, state: true, contentHash: true, draftJson: true, generatedAt: true, generationRunId: true },
      orderBy: { generatedAt: "asc" },
    });

    // Strip plan JSON down to summary for the output.
    const summarise = (r) => {
      if (r.assessmentPlanJson) {
        try {
          const plan = JSON.parse(r.assessmentPlanJson);
          r.planSummary = {
            learningObjectives: plan.learningObjectives?.length ?? null,
            proposedCheckpointGroups: plan.proposedCheckpointGroups?.length ?? null,
            proposedCheckpointGroupTarget: plan.proposedCheckpointGroups?.reduce((s,g)=>s+(g.targetQuestionCount||0),0) ?? null,
            proposedFinalAssessmentTarget: plan.proposedFinalAssessment?.targetQuestionCount ?? null,
            totalTargetQuestionCount: plan.totalTargetQuestionCount,
            checkpointAtSecs: (plan.proposedCheckpointGroups ?? []).map((g) => g.atSec),
          };
        } catch (e) { r.planSummary = { error: e.message }; }
        delete r.assessmentPlanJson;
      }
      return r;
    };
    runs.forEach(summarise);
    latestRuns.forEach(summarise);

    // Summarise drafts: parse destination from draftJson.
    const draftsSummary = drafts.map((d) => {
      try {
        const j = JSON.parse(d.draftJson);
        return { id: d.id, state: d.state, generationRunId: d.generationRunId,
          generatedAt: d.generatedAt, draftPrompt: j.prompt?.slice(0, 100),
          contentHash12: d.contentHash.slice(0, 12) };
      } catch { return { id: d.id, state: d.state, parseError: true }; }
    });

    console.log("==PROBE_BEGIN==");
    console.log(JSON.stringify({
      firstRuns: runs, latestRuns,
      checkpointCount: checkpoints.length, checkpoints,
      questionCount: questions.length, questions,
      draftCount: drafts.length, draftsSummary,
    }, null, 2));
    console.log("==PROBE_END==");
  } catch (e) {
    console.log("==PROBE_BEGIN==");
    console.log(JSON.stringify({ error: e.message, stack: e.stack }));
    console.log("==PROBE_END==");
  } finally { await p.$disconnect(); }
})();
`;
const b64 = Buffer.from(script,"utf8").toString("base64");
const flyctl = "C:/Users/cturcato/.fly/bin/flyctl.exe";
const out = execSync(`"${flyctl}" ssh console --app spectre-staging --command 'sh -lc "cd /app && echo ${b64} | base64 -d | node"'`,
  { encoding:"utf8", maxBuffer: 25*1024*1024, shell:"bash.exe" });
const m = out.match(/==PROBE_BEGIN==\s*([\s\S]*?)\s*==PROBE_END==/);
if (!m) { console.error(out.slice(-2000)); process.exit(1); }
fs.mkdirSync("test-results",{recursive:true});
fs.writeFileSync("test-results/4ybb-probe.json", m[1]);
console.log(m[1]);
