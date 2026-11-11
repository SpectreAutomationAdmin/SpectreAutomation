#!/usr/bin/env node
// EP-TRAIN-4Y-AP §2 — inspect the actual transcript segments around
// the proposed "pay-stub access" topic BEFORE firing GPU. Read-only.

import { execSync } from "node:child_process";
import fs from "node:fs";

const VERSION_ID = "cmw8n6z9a000az4nx56vwh02f";

const script = `
const { PrismaClient } = require("@prisma/client");
const p = new PrismaClient();
(async () => {
  try {
    // Get the resolvedTranscriptBuildId from the original run's plan
    const origRun = await p.trainingQuestionAiGenerationRun.findFirst({
      where: { courseVersionId: "${VERSION_ID}", executionStatus: "COMPLETED" },
      select: { resolvedTranscriptBuildId: true, clubId: true, assessmentPlanJson: true },
    });
    const planObj = JSON.parse(origRun.assessmentPlanJson);
    const build = await p.trainingTranscriptBuild.findFirst({
      where: {
        clubId: origRun.clubId,
        resolvedTranscriptBuildId: origRun.resolvedTranscriptBuildId,
      },
      select: { id: true },
    });
    // Load segments 0..30 (first 30 to see payroll / SIN content)
    const segs = await p.trainingTranscriptSegment.findMany({
      where: {
        clubId: origRun.clubId,
        transcriptBuildId: build.id,
        segmentIndex: { in: Array.from({ length: 30 }, (_, i) => i) },
      },
      select: { segmentIndex: true, startSec: true, endSec: true, text: true },
      orderBy: [{ segmentIndex: "asc" }],
    });
    console.log("==4YAP_TRANSCRIPT_BEGIN==");
    console.log(JSON.stringify({
      resolvedTranscriptBuildId: origRun.resolvedTranscriptBuildId,
      planEligibleIds0to30: (planObj.eligibleSegmentIds ?? []).filter((i) => i < 30),
      learningObjectivesFirst8: (planObj.learningObjectives ?? []).slice(0, 8).map((lo) => ({ id: lo.id, title: lo.title, segmentIds: lo.segmentIds })),
      segments: segs,
    }, null, 2));
    console.log("==4YAP_TRANSCRIPT_END==");
  } catch (e) {
    console.log("==4YAP_TRANSCRIPT_BEGIN==");
    console.log(JSON.stringify({ error: e.message, stack: e.stack }));
    console.log("==4YAP_TRANSCRIPT_END==");
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
const m = out.match(/==4YAP_TRANSCRIPT_BEGIN==\s*([\s\S]*?)\s*==4YAP_TRANSCRIPT_END==/);
if (!m) { console.error("no markers"); process.exit(1); }
const data = JSON.parse(m[1]);

console.log("First 30 transcript segments (0-29):\n");
for (const s of data.segments) {
  console.log(`  [${s.segmentIndex.toString().padStart(2)}] ${Number(s.startSec).toFixed(1).padStart(6)}s  ${(s.text || "").slice(0, 160)}`);
}
console.log("\nFirst 8 learning objectives:\n");
for (const lo of data.learningObjectivesFirst8) {
  console.log(`  ${lo.id}: segs=[${lo.segmentIds.join(",")}]`);
  console.log(`    title: "${lo.title.slice(0, 120)}"`);
}

console.log("\nPlan-eligible ids 0-29:", data.planEligibleIds0to30.join(", "));

fs.mkdirSync("test-results", { recursive: true });
fs.writeFileSync("test-results/4yap-transcript.json", JSON.stringify(data, null, 2));
