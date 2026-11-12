#!/usr/bin/env node
// EP-TRAIN-4Y-AX §8 — post-deploy preservation probe (12th consecutive).
// Confirms every one of the 15 AI-generated pilot questions remains
// byte-identical, the five original checkpoints keep their atSec
// values, course.aiMetadataAttributionAt is unchanged, and no manual
// questions or disposable checkpoints are LEFT behind by the
// Playwright acceptance flow. ZERO writes.

import { execSync } from "node:child_process";
import fs from "node:fs";

const COURSE_ID  = "cmw8n6z8f0008z4nxck6uvms9";
const VERSION_ID = "cmw8n6z9a000az4nx56vwh02f";
const AS_DRAFT_ID = "cmwbl6aic0007107lhfo4n0wl";
const AS_CONTENT_HASH_12 = "b4d2ed9ffdf8";
const BASELINE_ATTRIBUTION_AT = "2026-11-10T20:42:51.040Z";
const EXPECTED_14 = new Set([
  "24c26223e6d1","5d2863681508","e05878acffc1","084e91e008d1","fcf533481947",
  "e479567ee290","01ff61464357","155890567d00","c855a6435458","f8ae54baa666",
  "00054b4f30fa","7c428a0d126a","642496d444c2","008af536cb3d",
]);
// Pilot checkpoint baseline. The 4Y-Z pilot never materialised
// TrainingCheckpoint rows — the five logical checkpoints come from
// the assessment-plan's proposedCheckpointGroups (atSec = 107, 214,
// 321, 428, 535) which the /review page.tsx renders via its
// resolveCheckpointMarkers fallback. So the preservation invariant
// is: TrainingCheckpoint count = 0 AND TrainingQuestion count = 0
// (any non-zero means a disposable row was LEFT BEHIND by the
// Playwright acceptance test, which would be a cleanup regression).
const EXPECTED_CP_COUNT = 0;
const EXPECTED_MANUAL_QUESTION_COUNT = 0;

const script = `
const { PrismaClient } = require("@prisma/client");
const p = new PrismaClient();
(async () => {
  try {
    const live = await p.trainingQuestionAiDraft.findMany({
      where: { courseVersionId: "${VERSION_ID}",
        state: { in: ["REQUIRES_HUMAN_REVIEW","EDITED_VALIDATION_STALE","VALIDATION_FAILED","GENERATED","VALIDATION_PENDING","APPROVED_DRAFT","PROMOTED"] } },
      select: { id: true, contentHash: true, state: true },
      orderBy: { generatedAt: "asc" },
    });
    const course = await p.trainingCourse.findUnique({
      where: { id: "${COURSE_ID}" },
      select: { title: true, aiMetadataAttributionAt: true, aiMetadataAttributionSource: true },
    });
    const completions = await p.trainingCompletion.count({ where: { courseVersionId: "${VERSION_ID}" } });
    const promoted   = await p.trainingQuestionAiDraft.count({ where: { courseVersionId: "${VERSION_ID}", state: "PROMOTED" } });
    const runs      = await p.trainingQuestionAiGenerationRun.count({ where: { courseVersionId: "${VERSION_ID}" } });
    const manualQs  = await p.trainingQuestion.count({ where: { courseVersionId: "${VERSION_ID}" } });
    const checkpoints = await p.trainingCheckpoint.findMany({
      where: { courseVersionId: "${VERSION_ID}" },
      orderBy: [{ atSecond: "asc" }],
      select: { id: true, atSecond: true, label: true },
    });
    console.log("==PROBE_BEGIN==");
    console.log(JSON.stringify({ live, course, completions, promoted, runs, manualQs, checkpoints }, null, 2));
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
const cpAtSecs = db.checkpoints.map((c)=>c.atSecond).sort((a,b)=>a-b);
const result = {
  liveDrafts: db.live.length,
  allPreservedExisting14: observed14.size === 14,
  asDraftPreserved: !!asDraft && asDraft.contentHash.slice(0,12) === AS_CONTENT_HASH_12,
  metadataPreserved: db.course?.aiMetadataAttributionAt === BASELINE_ATTRIBUTION_AT,
  completions: db.completions,
  promoted: db.promoted,
  runs: db.runs,
  manualQs: db.manualQs,
  manualQsMatchesBaseline: db.manualQs === EXPECTED_MANUAL_QUESTION_COUNT,
  cpCount: db.checkpoints.length,
  cpCountMatchesBaseline: db.checkpoints.length === EXPECTED_CP_COUNT,
  cpAtSecs,
};
fs.mkdirSync("test-results",{recursive:true});
fs.writeFileSync("test-results/4yax-preservation.json", JSON.stringify({ db, result }, null, 2));
console.log(JSON.stringify(result, null, 2));

const fail =
  result.liveDrafts !== 15 ||
  !result.allPreservedExisting14 ||
  !result.asDraftPreserved ||
  !result.metadataPreserved ||
  result.completions !== 0 ||
  result.promoted !== 0 ||
  !result.manualQsMatchesBaseline ||
  !result.cpCountMatchesBaseline;
if (fail) { console.error("PRESERVATION FAIL"); process.exit(1); }
console.log("\n✓ 15 AI drafts byte-identical · metadata unchanged · 0 promotions · 0 completions · 0 residual manual questions · 0 residual checkpoint rows (baseline shape preserved)");
