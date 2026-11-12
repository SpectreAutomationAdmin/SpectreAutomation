#!/usr/bin/env node
// EP-TRAIN-4Y-AV §1 + §2 — v2: pulls transcript segments via the
// build's SHA256 hash (not FK). Still READ-ONLY.

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
    const runs = await p.trainingQuestionAiGenerationRun.findMany({
      where: { clubId, courseVersionId: "${VERSION_ID}" },
      orderBy: [{ requestedAt: "asc" }],
      select: {
        id: true, executionStatus: true, requestedAt: true, completedAt: true,
        resolvedTranscriptBuildId: true, sourceVideoSha256: true,
      },
    });
    const transcriptHash = runs.find((r) => r.resolvedTranscriptBuildId)?.resolvedTranscriptBuildId ?? null;
    const sourceVideoSha256 = runs.find((r) => r.sourceVideoSha256)?.sourceVideoSha256 ?? null;
    let transcriptBuild = null;
    let segments = [];
    if (transcriptHash && sourceVideoSha256) {
      transcriptBuild = await p.trainingTranscriptBuild.findFirst({
        where: { clubId, sourceVideoSha256, resolvedTranscriptBuildId: transcriptHash },
        select: {
          id: true, clubId: true, sourceVideoSha256: true,
          resolvedTranscriptBuildId: true, transcriberName: true,
          transcriberVersion: true, transcriberModelName: true,
          producedAt: true, createdAt: true,
        },
      });
      if (transcriptBuild) {
        segments = await p.trainingTranscriptSegment.findMany({
          where: { clubId, transcriptBuildId: transcriptBuild.id },
          orderBy: [{ segmentIndex: "asc" }],
          select: {
            id: true, segmentIndex: true, text: true,
            startSec: true, endSec: true,
            pendingReviewJson: true, sourceOrgMismatchJson: true,
            uncertaintyWarning: true, reviewerAttestedAt: true,
          },
        });
      }
    }
    const live = await p.trainingQuestionAiDraft.findMany({
      where: { clubId, courseVersionId: "${VERSION_ID}",
        state: { in: ["REQUIRES_HUMAN_REVIEW","APPROVED_DRAFT","GENERATED","VALIDATION_PENDING","EDITED_VALIDATION_STALE","VALIDATION_FAILED","PROMOTED"] } },
      orderBy: [{ generatedAt: "asc" }, { id: "asc" }],
      select: {
        id: true, state: true, stateChangedAt: true,
        contentHash: true, draftJson: true,
        supersedesDraftId: true, generationRunId: true,
        generatedAt: true, generatedByUserId: true,
      },
    });
    console.log("==4YAV_BEGIN==");
    console.log(JSON.stringify({ course, transcriptBuild, transcriptHash, sourceVideoSha256, segmentCount: segments.length, segments, live }, null, 2));
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
const outPath = path.join(outDir, "4yav-inventory-v2.json");
fs.writeFileSync(outPath, JSON.stringify(data, null, 2));
console.log("wrote", outPath);
console.log({
  course: data.course?.id,
  transcriptBuild: data.transcriptBuild?.id,
  segmentCount: data.segmentCount,
  liveDrafts: data.live?.length,
});
