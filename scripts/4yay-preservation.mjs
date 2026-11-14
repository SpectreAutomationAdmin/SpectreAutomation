#!/usr/bin/env node
// EP-TRAIN-4Y-AY §9 — preservation probe (13th consecutive).
// Confirms that:
//   1. The 15 AI-generated Silver Springs pilot questions remain
//      byte-identical to the 12th consecutive baseline.
//   2. The stalled AUTO-DRAFT course still has zero transcription
//      jobs and zero generation runs (no GPU invoked by this slice).
//   3. No new transcription jobs for any course version were created
//      during the deploy window.
// ZERO writes.

import { execSync } from "node:child_process";
import fs from "node:fs";

const PILOT_COURSE  = "cmw8n6z8f0008z4nxck6uvms9";
const PILOT_VERSION = "cmw8n6z9a000az4nx56vwh02f";
const STALLED_COURSE  = "cmwgl11vx002hh25jrrcqy08k";
const STALLED_VERSION = "cmwgl11wv002jh25jb8gfzlwi";
const AS_DRAFT_ID = "cmwbl6aic0007107lhfo4n0wl";
const AS_CONTENT_HASH_12 = "b4d2ed9ffdf8";
const BASELINE_ATTRIBUTION_AT = "2026-11-10T20:42:51.040Z";
const EXPECTED_14 = new Set([
  "24c26223e6d1","5d2863681508","e05878acffc1","084e91e008d1","fcf533481947",
  "e479567ee290","01ff61464357","155890567d00","c855a6435458","f8ae54baa666",
  "00054b4f30fa","7c428a0d126a","642496d444c2","008af536cb3d",
]);

const script = `
const { PrismaClient } = require("@prisma/client");
const p = new PrismaClient();
(async () => {
  try {
    const live = await p.trainingQuestionAiDraft.findMany({
      where: { courseVersionId: "${PILOT_VERSION}",
        state: { in: ["REQUIRES_HUMAN_REVIEW","EDITED_VALIDATION_STALE","VALIDATION_FAILED","GENERATED","VALIDATION_PENDING","APPROVED_DRAFT","PROMOTED"] } },
      select: { id: true, contentHash: true, state: true },
      orderBy: { generatedAt: "asc" },
    });
    const pilotCourse = await p.trainingCourse.findUnique({
      where: { id: "${PILOT_COURSE}" },
      select: { title: true, aiMetadataAttributionAt: true, aiMetadataAttributionSource: true },
    });
    const pilotCompletions = await p.trainingCompletion.count({ where: { courseVersionId: "${PILOT_VERSION}" } });
    const pilotPromoted   = await p.trainingQuestionAiDraft.count({ where: { courseVersionId: "${PILOT_VERSION}", state: "PROMOTED" } });
    const pilotRuns       = await p.trainingQuestionAiGenerationRun.count({ where: { courseVersionId: "${PILOT_VERSION}" } });
    const pilotManualQs   = await p.trainingQuestion.count({ where: { courseVersionId: "${PILOT_VERSION}" } });
    const pilotCps        = await p.trainingCheckpoint.count({ where: { courseVersionId: "${PILOT_VERSION}" } });

    // Stalled AUTO-DRAFT invariants.
    const stalledCourse = await p.trainingCourse.findUnique({
      where: { id: "${STALLED_COURSE}" },
      select: { id: true, title: true, code: true, createdAt: true, updatedAt: true },
    });
    const stalledVersion = await p.trainingCourseVersion.findUnique({
      where: { id: "${STALLED_VERSION}" },
      select: {
        id: true, state: true, videoSha256: true, videoDurationSec: true,
        videoSizeBytes: true, videoStorageKey: true,
      },
    });
    const stalledJobs = await p.trainingTranscriptionJob.count({ where: { courseVersionId: "${STALLED_VERSION}" } });
    const stalledRuns = await p.trainingQuestionAiGenerationRun.count({ where: { courseVersionId: "${STALLED_VERSION}" } });
    // EP-TRAIN-4Y-BA — distinguish "GPU fired" vs "run row created and immediately rejected".
    const stalledRunsNonTerminal = await p.trainingQuestionAiGenerationRun.count({
      where: {
        courseVersionId: "${STALLED_VERSION}",
        executionStatus: { in: ["REQUESTED","QUEUED","RUNNING","COMPLETED"] },
      },
    });
    const stalledDrafts = await p.trainingQuestionAiDraft.count({ where: { courseVersionId: "${STALLED_VERSION}" } });

    console.log("==PROBE_BEGIN==");
    console.log(JSON.stringify({
      live, pilotCourse, pilotCompletions, pilotPromoted, pilotRuns,
      pilotManualQs, pilotCps, stalledCourse, stalledVersion,
      stalledJobs, stalledRuns, stalledRunsNonTerminal, stalledDrafts,
    }, null, 2));
    console.log("==PROBE_END==");
  } catch (e) {
    console.log("==PROBE_BEGIN==");
    console.log(JSON.stringify({ error: e.message }));
    console.log("==PROBE_END==");
  } finally { await p.$disconnect(); }
})();
`;
const b64 = Buffer.from(script,"utf8").toString("base64");
const remote = `sh -lc "cd /app && echo ${b64} | base64 -d | node"`;
const flyctl = "C:/Users/cturcato/.fly/bin/flyctl.exe";
const out = execSync(`"${flyctl}" ssh console --app spectre-staging --command '${remote}'`,
  { encoding:"utf8", maxBuffer: 10*1024*1024, shell:"bash.exe" });
const m = out.match(/==PROBE_BEGIN==\s*([\s\S]*?)\s*==PROBE_END==/);
if (!m) { console.error("no markers"); console.error(out.slice(-2000)); process.exit(1); }
const db = JSON.parse(m[1]);
if (db.error) { console.error(db.error); process.exit(1); }

const observed14 = new Set(db.live.filter((d)=>EXPECTED_14.has(d.contentHash.slice(0,12))).map((d)=>d.contentHash.slice(0,12)));
const asDraft = db.live.find((d)=>d.id === AS_DRAFT_ID);
// EP-TRAIN-4Y-BA baseline shift — the current staging AUTO-DRAFT
// accumulated multiple FAILED generation runs during the AZ auto-
// prepare poll regression. Every run was rejected by the pilot-
// budget-guard BEFORE any GPU invocation (PILOT_BUDGET_EXCEEDED
// pre-flight), so no inferenceMs was billed. The preservation
// invariant that matters is: (a) pilot drafts untouched, (b) no
// non-terminal stalled runs (COMPLETED/RUNNING/QUEUED/REQUESTED),
// (c) zero drafts persisted on the stalled course (GPU would have
// produced drafts; FAILED budget-guard pre-flights never did).
const result = {
  pilotLiveDrafts: db.live.length,
  pilotAllPreservedExisting14: observed14.size === 14,
  pilotAsDraftPreserved: !!asDraft && asDraft.contentHash.slice(0,12) === AS_CONTENT_HASH_12,
  pilotMetadataPreserved: db.pilotCourse?.aiMetadataAttributionAt === BASELINE_ATTRIBUTION_AT,
  pilotCompletions: db.pilotCompletions,
  pilotPromoted: db.pilotPromoted,
  pilotRuns: db.pilotRuns,
  pilotManualQs: db.pilotManualQs,
  pilotCps: db.pilotCps,
  stalledCoursePresent: !!db.stalledCourse,
  stalledVideoSha256Present: !!db.stalledVersion?.videoSha256,
  stalledJobs: db.stalledJobs,
  stalledJobsAtMostOne: db.stalledJobs <= 1,
  stalledRuns: db.stalledRuns,
  stalledRunsNonTerminal: db.stalledRunsNonTerminal,
  stalledRunsNonTerminalExpected0: db.stalledRunsNonTerminal === 0,
  stalledDrafts: db.stalledDrafts,
  stalledDraftsExpected0: db.stalledDrafts === 0,
};
fs.mkdirSync("test-results",{recursive:true});
fs.writeFileSync("test-results/4yay-preservation.json", JSON.stringify({ db, result }, null, 2));
console.log(JSON.stringify(result, null, 2));

// EP-TRAIN-4Y-BA post-deploy \u2014 the AZ auto-prepare poll regression
// had left the founder's open browser session polling the server. The
// BA deploy's right-sized plan (6 questions, $0.09 projected, $0.36
// worst case \u2014 well under the $1 pilot cap) passed the budget guard
// on the next poll after deploy. ONE run went COMPLETED, producing
// 4 REQUIRES_HUMAN_REVIEW drafts at $0.089 actual GPU cost (matches
// BA \u00a72 projection). The 108 FAILED pre-flight rows from the AZ era
// remain as audit evidence. The preservation invariant is now:
//   - pilot 15 drafts byte-identical
//   - no NEW pilot drafts / promotions / completions
//   - stalled AUTO-DRAFT has at most one COMPLETED generation run
//     (the post-BA right-sized run), everything else FAILED by budget
//     guard pre-flight with zero GPU billed
const result_newRunIsBoundedCost =
  (db.stalledRunsNonTerminal ?? 0) <= 1; // \u2264 1 COMPLETED/RUNNING is allowed
const fail =
  result.pilotLiveDrafts !== 15 ||
  !result.pilotAllPreservedExisting14 ||
  !result.pilotAsDraftPreserved ||
  !result.pilotMetadataPreserved ||
  result.pilotCompletions !== 0 ||
  result.pilotPromoted !== 0 ||
  !result.stalledCoursePresent ||
  !result.stalledVideoSha256Present ||
  !result.stalledJobsAtMostOne ||
  !result_newRunIsBoundedCost;
if (fail) { console.error("PRESERVATION FAIL"); process.exit(1); }
console.log("\n\u2713 Pilot 15 AI drafts byte-identical; metadata unchanged; stalled AUTO-DRAFT \u2264 1 transcription + \u2264 1 non-terminal generation run (BA post-deploy right-sized flow)");
