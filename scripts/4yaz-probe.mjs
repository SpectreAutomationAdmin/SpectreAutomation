#!/usr/bin/env node
// EP-TRAIN-4Y-AZ §1-§2 — complete processing history for the current
// upload. Read-only probe. No writes.

import { execSync } from "node:child_process";
import fs from "node:fs";

const VERSION_ID = "cmwgl11wv002jh25jb8gfzlwi";
const COURSE_ID = "cmwgl11vx002hh25jrrcqy08k";

const script = `
const { PrismaClient } = require("@prisma/client");
const p = new PrismaClient();
(async () => {
  try {
    const version = await p.trainingCourseVersion.findUnique({
      where: { id: "${VERSION_ID}" },
      select: {
        id: true, state: true, createdAt: true, updatedAt: true,
        videoStorageKey: true, videoMimeType: true, videoSizeBytes: true,
        videoSha256: true, videoDurationSec: true,
        videoThumbnailStorageKey: true, videoThumbnailSizeBytes: true,
      },
    });
    const course = await p.trainingCourse.findUnique({
      where: { id: "${COURSE_ID}" },
      select: { id: true, title: true, code: true, createdAt: true, updatedAt: true,
        aiMetadataAttributionAt: true, aiMetadataAttributionSource: true,
        aiMetadataAttributedTitle: true },
    });
    const jobs = await p.trainingTranscriptionJob.findMany({
      where: { courseVersionId: "${VERSION_ID}" },
      orderBy: { requestedAt: "asc" },
      select: {
        id: true, state: true, attempts: true, maxAttempts: true,
        requestedAt: true, queuedAt: true, startedAt: true,
        completedAt: true, cancelledAt: true, leaseExpiresAt: true,
        failureCode: true, failureMessage: true,
        resolvedTranscriptBuildId: true, elapsedMsTotal: true,
        elapsedMsColdBoot: true, elapsedMsTranscribe: true,
        estimatedCostUsdMicros: true, sourceVideoSha256: true,
        requestedByUserId: true, createdAt: true, updatedAt: true,
      },
    });
    const builds = await p.trainingTranscriptBuild.findMany({
      where: { sourceVideoSha256: version?.videoSha256 ?? "" },
      orderBy: { producedAt: "asc" },
      select: { id: true, clubId: true, sourceVideoSha256: true,
        producedAt: true, transcriberName: true, transcriberModelName: true,
        resolvedTranscriptBuildId: true },
    });
    const runs = await p.trainingQuestionAiGenerationRun.findMany({
      where: { courseVersionId: "${VERSION_ID}" },
      orderBy: { requestedAt: "asc" },
      select: {
        id: true, executionStatus: true, requestedAt: true, queuedAt: true,
        startedAt: true, completedAt: true, leaseExpiresAt: true, attempts: true,
        maxAttempts: true, executionErrorCode: true, executionErrorMessage: true,
        inferenceMs: true, gpuSeconds: true, planIdentity: true,
        modelName: true, modelBackend: true,
        resolvedTranscriptBuildId: true, sourceVideoSha256: true,
        assessmentPlanJson: true, shortfallReasonJson: true,
        createdAt: true, updatedAt: true,
      },
    });
    const drafts = await p.trainingQuestionAiDraft.findMany({
      where: { courseVersionId: "${VERSION_ID}" },
      select: { id: true, generationRunId: true, state: true, contentHash: true,
        generatedAt: true, createdAt: true, updatedAt: true },
    });

    // Narrow the plan down to size by stripping the chunky bits.
    for (const r of runs) {
      if (r.assessmentPlanJson) {
        try {
          const plan = JSON.parse(r.assessmentPlanJson);
          r.planSummary = {
            schemaVersion: plan.schemaVersion,
            learningObjectivesCount: Array.isArray(plan.learningObjectives) ? plan.learningObjectives.length : null,
            proposedCheckpointGroupsCount: Array.isArray(plan.proposedCheckpointGroups) ? plan.proposedCheckpointGroups.length : null,
            proposedCheckpointGroupsTarget: Array.isArray(plan.proposedCheckpointGroups) ? plan.proposedCheckpointGroups.reduce((s,g)=>s+(g.targetQuestionCount||0),0) : null,
            proposedFinalAssessmentTarget: plan.proposedFinalAssessment?.targetQuestionCount ?? null,
            totalTargetQuestionCount: plan.totalTargetQuestionCount,
            eligibleSegmentIdCount: Array.isArray(plan.eligibleSegmentIds) ? plan.eligibleSegmentIds.length : null,
            generatedAt: plan.generatedAt,
          };
        } catch (e) { r.planSummary = { error: e.message }; }
        r.assessmentPlanJson = "(stripped)";
      }
      if (r.shortfallReasonJson) {
        try {
          const sf = JSON.parse(r.shortfallReasonJson);
          r.shortfallSummary = {
            schemaVersion: sf.schemaVersion,
            dedupDecisionsCount: Array.isArray(sf.dedupDecisions) ? sf.dedupDecisions.length : null,
            keptCount: Array.isArray(sf.dedupDecisions) ? sf.dedupDecisions.filter((d)=>d.kept===true).length : null,
          };
        } catch (e) { r.shortfallSummary = { error: e.message }; }
        r.shortfallReasonJson = "(stripped)";
      }
    }

    console.log("==PROBE_BEGIN==");
    console.log(JSON.stringify({ now: new Date().toISOString(), course, version, jobs, builds, runs, drafts }, null, 2));
    console.log("==PROBE_END==");
  } catch (e) {
    console.log("==PROBE_BEGIN==");
    console.log(JSON.stringify({ error: e.message, stack: e.stack }));
    console.log("==PROBE_END==");
  } finally { await p.$disconnect(); }
})();
`;
const b64 = Buffer.from(script,"utf8").toString("base64");
const remote = `sh -lc "cd /app && echo ${b64} | base64 -d | node"`;
const flyctl = "C:/Users/cturcato/.fly/bin/flyctl.exe";
const out = execSync(`"${flyctl}" ssh console --app spectre-staging --command '${remote}'`,
  { encoding:"utf8", maxBuffer: 20*1024*1024, shell:"bash.exe" });
const m = out.match(/==PROBE_BEGIN==\s*([\s\S]*?)\s*==PROBE_END==/);
if (!m) { console.error("no markers"); console.error(out.slice(-3000)); process.exit(1); }
fs.mkdirSync("test-results",{recursive:true});
fs.writeFileSync("test-results/4yaz-probe.json", m[1]);
console.log(m[1]);
