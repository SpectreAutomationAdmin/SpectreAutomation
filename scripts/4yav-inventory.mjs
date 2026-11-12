#!/usr/bin/env node
// EP-TRAIN-4Y-AV §1 — pull full inventory for the 15 AI-generated
// questions on the Silver Springs onboarding course, plus the
// underlying transcript segments so grounding can be assessed.
//
// READ-ONLY. No writes. No approvals. No promotions. No deletions.

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const COURSE_ID = "cmw8n6z8f0008z4nxck6uvms9";
const VERSION_ID = "cmw8n6z9a000az4nx56vwh02f";

const script = `
const { PrismaClient } = require("@prisma/client");
const p = new PrismaClient();
(async () => {
  try {
    const course = await p.trainingCourse.findUnique({
      where: { id: "${COURSE_ID}" },
      select: {
        id: true, clubId: true, code: true, title: true, description: true,
        aiMetadataAttributionSource: true, aiMetadataAttributedTitle: true,
        aiMetadataAttributionAt: true,
      },
    });
    if (!course) { console.log("==4YAV_BEGIN=="); console.log(JSON.stringify({ error: "course_not_found" })); console.log("==4YAV_END=="); return; }
    const clubId = course.clubId;
    const version = await p.trainingCourseVersion.findUnique({
      where: { id: "${VERSION_ID}" },
      select: {
        id: true, state: true, passingScore: true, retakesAllowed: true,
        required: true, requiresKnowledgeTest: true, appliesToAll: true,
        videoStorageKey: true, description: true,
      },
    });
    const drafts = await p.trainingQuestionAiDraft.findMany({
      where: { clubId, courseVersionId: "${VERSION_ID}" },
      orderBy: [{ generatedAt: "asc" }, { id: "asc" }],
      select: {
        id: true, state: true, stateChangedAt: true,
        contentHash: true, draftJson: true,
        supersedesDraftId: true, generationRunId: true,
        generatedAt: true, generatedByUserId: true,
        sourceVideoSha256: true, groundingProjectionSha256: true,
        modelSelectedAnswerSnapshotJson: true,
        promotion: { select: { questionId: true, destination: true, checkpointId: true } },
      },
    });
    const runs = await p.trainingQuestionAiGenerationRun.findMany({
      where: { clubId, courseVersionId: "${VERSION_ID}" },
      orderBy: [{ requestedAt: "asc" }],
      select: {
        id: true, executionStatus: true, requestedAt: true, completedAt: true,
        shortfallReasonJson: true, assessmentPlanJson: true,
        resolvedTranscriptBuildId: true,
      },
    });
    const validations = await p.trainingQuestionAiValidation.findMany({
      where: { clubId, draftId: { in: drafts.map((d) => d.id) } },
      orderBy: [{ runAt: "desc" }],
      select: {
        id: true, draftId: true, draftContentHash: true,
        validatorVersion: true, verdict: true, stage: true,
        errorsJson: true, warningsJson: true, flagsJson: true,
        verifiedCorrectAnswerSnapshotJson: true, runAt: true,
      },
    });
    let transcriptBuildId = null;
    for (const r of runs) { if (r.resolvedTranscriptBuildId) { transcriptBuildId = r.resolvedTranscriptBuildId; break; } }
    let segments = [];
    if (transcriptBuildId) {
      segments = await p.trainingTranscriptSegment.findMany({
        where: { clubId, transcriptBuildId },
        orderBy: [{ segmentIndex: "asc" }],
        select: {
          id: true, segmentIndex: true, text: true,
          startSec: true, endSec: true,
          pendingReviewJson: true, sourceOrgMismatchJson: true,
          uncertaintyWarning: true, reviewerAttestedAt: true,
        },
      });
    }
    const checkpoints = await p.trainingCheckpoint.findMany({
      where: { clubId, courseVersionId: "${VERSION_ID}" },
      orderBy: [{ atSec: "asc" }],
      select: { id: true, atSec: true, title: true, questionCount: true },
    }).catch(() => []);
    const completions = await p.trainingCompletion.count({ where: { courseVersionId: "${VERSION_ID}" } });
    console.log("==4YAV_BEGIN==");
    console.log(JSON.stringify({ course, version, drafts, runs, validations, segments, checkpoints, completions }, null, 2));
    console.log("==4YAV_END==");
  } catch (e) {
    console.log("==4YAV_BEGIN==");
    console.log(JSON.stringify({ error: e.message, stack: e.stack?.slice(0, 2000) }));
    console.log("==4YAV_END==");
  } finally { await p.$disconnect(); }
})();
`;
const b64 = Buffer.from(script, "utf8").toString("base64");
const remote = `sh -lc "cd /app && echo ${b64} | base64 -d | node"`;
const flyctl = "C:/Users/cturcato/.fly/bin/flyctl.exe";
const out = execSync(
  `"${flyctl}" ssh console --app spectre-staging --command '${remote}'`,
  { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, shell: "bash.exe" },
);
const m = out.match(/==4YAV_BEGIN==\s*([\s\S]*?)\s*==4YAV_END==/);
if (!m) { console.error("no markers"); console.error(out.slice(-2000)); process.exit(1); }
const data = JSON.parse(m[1]);

const outDir = "test-results";
fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, "4yav-inventory.json");
fs.writeFileSync(outPath, JSON.stringify(data, null, 2));
console.log("wrote", outPath);
console.log({
  drafts: data.drafts?.length,
  runs: data.runs?.length,
  validations: data.validations?.length,
  segments: data.segments?.length,
  checkpoints: data.checkpoints?.length,
  completions: data.completions,
});
