#!/usr/bin/env node
import { execSync } from "node:child_process";
import fs from "node:fs";

const COURSE_ID = "cmw8n6z8f0008z4nxck6uvms9";
const VERSION_ID = "cmw8n6z9a000az4nx56vwh02f";
const AP_RUN = "cmwbfy1ul000dv9lt44apd074";

const ALL_14_HASHES = new Set([
  "24c26223e6d1","5d2863681508","e05878acffc1","084e91e008d1","fcf533481947",
  "e479567ee290","01ff61464357","155890567d00","c855a6435458","f8ae54baa666","00054b4f30fa",
  "7c428a0d126a","642496d444c2","008af536cb3d",
]);
const BASELINE_ATTRIBUTION_AT = "2026-11-10T20:42:51.040Z";

const script = `
const { PrismaClient } = require("@prisma/client");
const p = new PrismaClient();
(async () => {
  try {
    const liveDrafts = await p.trainingQuestionAiDraft.findMany({
      where: { courseVersionId: "${VERSION_ID}",
        state: { in: ["REQUIRES_HUMAN_REVIEW","EDITED_VALIDATION_STALE","VALIDATION_FAILED","GENERATED","VALIDATION_PENDING","APPROVED_DRAFT","PROMOTED"] } },
      select: { id: true, contentHash: true, generationRunId: true },
    });
    const course = await p.trainingCourse.findUnique({
      where: { id: "${COURSE_ID}" },
      select: { title: true, aiMetadataAttributionAt: true, code: true },
    });
    const apDraftCount = await p.trainingQuestionAiDraft.count({ where: { generationRunId: "${AP_RUN}" } });
    const completionsCount = await p.trainingCompletion.count({ where: { courseVersionId: "${VERSION_ID}" } });
    console.log("==4YAQ_POSTDEPLOY_BEGIN==");
    console.log(JSON.stringify({ liveDrafts, course, apDraftCount, completionsCount }, null, 2));
    console.log("==4YAQ_POSTDEPLOY_END==");
  } catch (e) {
    console.log("==4YAQ_POSTDEPLOY_BEGIN==");
    console.log(JSON.stringify({ error: e.message }));
    console.log("==4YAQ_POSTDEPLOY_END==");
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
const m = out.match(/==4YAQ_POSTDEPLOY_BEGIN==\s*([\s\S]*?)\s*==4YAQ_POSTDEPLOY_END==/);
if (!m) { console.error("no markers\n" + out); process.exit(1); }
const db = JSON.parse(m[1]);

const observed = new Set(db.liveDrafts.map((d) => d.contentHash.slice(0, 12)));
const allPreserved = db.liveDrafts.length === 14 && [...ALL_14_HASHES].every((h) => observed.has(h));
const metadataPreserved = db.course?.title === "Employee Onboarding and Policies" &&
  db.course?.aiMetadataAttributionAt === BASELINE_ATTRIBUTION_AT;

console.log(JSON.stringify({
  totalLiveDrafts: db.liveDrafts.length,
  allPreserved, metadataPreserved,
  apDraftCount: db.apDraftCount,
  completionsCount: db.completionsCount,
  courseTitle: db.course?.title,
  aiMetadataAttributionAt: db.course?.aiMetadataAttributionAt,
}, null, 2));

fs.mkdirSync("test-results", { recursive: true });
fs.writeFileSync("test-results/4yaq-post-deploy-db.json",
  JSON.stringify({ db, preservation: { allPreserved, metadataPreserved } }, null, 2));
if (!allPreserved || !metadataPreserved) { console.error("PRESERVATION FAIL"); process.exit(1); }
