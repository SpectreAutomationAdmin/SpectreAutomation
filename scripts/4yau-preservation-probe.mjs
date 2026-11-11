#!/usr/bin/env node
// EP-TRAIN-4Y-AU §7 — preservation probe. 15 questions byte-identical,
// metadata unchanged, no unintended approvals/publications.

import { execSync } from "node:child_process";
import fs from "node:fs";

const COURSE_ID = "cmw8n6z8f0008z4nxck6uvms9";
const VERSION_ID = "cmw8n6z9a000az4nx56vwh02f";
const AS_DRAFT_ID = "cmwbl6aic0007107lhfo4n0wl";
const AS_CONTENT_HASH_12 = "b4d2ed9ffdf8";

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
      select: { id: true, contentHash: true, state: true },
      orderBy: { createdAt: "asc" },
    });
    const course = await p.trainingCourse.findUnique({
      where: { id: "${COURSE_ID}" },
      select: { title: true, aiMetadataAttributionAt: true },
    });
    const completionsCount = await p.trainingCompletion.count({ where: { courseVersionId: "${VERSION_ID}" } });
    const promotedCount = await p.trainingQuestionAiDraft.count({
      where: { courseVersionId: "${VERSION_ID}", state: "PROMOTED" },
    });
    console.log("==4YAU_PROBE_BEGIN==");
    console.log(JSON.stringify({ liveDrafts, course, completionsCount, promotedCount }, null, 2));
    console.log("==4YAU_PROBE_END==");
  } catch (e) {
    console.log("==4YAU_PROBE_BEGIN==");
    console.log(JSON.stringify({ error: e.message }));
    console.log("==4YAU_PROBE_END==");
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
const m = out.match(/==4YAU_PROBE_BEGIN==\s*([\s\S]*?)\s*==4YAU_PROBE_END==/);
if (!m) { console.error("no markers"); process.exit(1); }
const db = JSON.parse(m[1]);

const observed14 = new Set(db.liveDrafts
  .filter((d) => ALL_14_HASHES.has(d.contentHash.slice(0, 12)))
  .map((d) => d.contentHash.slice(0, 12)));
const allPreserved = observed14.size === 14;
const asDraft = db.liveDrafts.find((d) => d.id === AS_DRAFT_ID);
const asPreserved = asDraft && asDraft.contentHash.slice(0, 12) === AS_CONTENT_HASH_12;
const metadataPreserved = db.course?.title === "Employee Onboarding and Policies" &&
  db.course?.aiMetadataAttributionAt === BASELINE_ATTRIBUTION_AT;

console.log(JSON.stringify({
  totalLiveDrafts: db.liveDrafts.length,
  allPreservedExisting14: allPreserved,
  asDraftPreserved: !!asPreserved,
  metadataPreserved,
  completionsCount: db.completionsCount,
  promotedCount: db.promotedCount,
}, null, 2));

fs.mkdirSync("test-results", { recursive: true });
fs.writeFileSync("test-results/4yau-preservation.json",
  JSON.stringify({ db, preservation: { allPreserved, metadataPreserved, asPreserved: !!asPreserved } }, null, 2));

if (!allPreserved || !asPreserved || !metadataPreserved) {
  console.error("PRESERVATION FAIL"); process.exit(1);
}
if (db.promotedCount !== 0 || db.completionsCount !== 0) {
  console.error("UNINTENDED STATE CHANGE"); process.exit(1);
}
console.log("\n✓ 14 preserved + AS Q10 preserved + metadata unchanged + 0 promotions + 0 completions");
