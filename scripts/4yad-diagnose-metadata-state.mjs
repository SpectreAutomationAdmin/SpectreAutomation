#!/usr/bin/env node
// EP-TRAIN-4Y-AD §2 — read-only diagnosis of the founder course's
// metadata state. Inspects:
//   - TrainingCourse.{title, description, code, aiMetadataAttribution*}
//   - TrainingCourseVersion.{title, description}
//   - TrainingQuestionAiGenerationRun summary
//   - AuditLog rows touching the course row
//   - UpdatedAt timestamps (regression timing)
// No mutation. No GPU.

import { spawn } from "node:child_process";
import fs from "node:fs";

const FLYCTL = process.env.FLYCTL_BIN ??
  (process.platform === "win32"
    ? "C:\\Users\\cturcato\\.fly\\bin\\flyctl.exe"
    : "/usr/local/bin/flyctl");
const APP = "spectre-staging";
const COURSE_ID = "cmw8n6z8f0008z4nxck6uvms9";
const VERSION_ID = "cmw8n6z9a000az4nx56vwh02f";

const script = `
import { PrismaClient } from "/app/node_modules/@prisma/client/default.js";
const p = new PrismaClient();
try {
  const course = await p.trainingCourse.findUnique({
    where: { id: "${COURSE_ID}" },
    select: {
      id: true,
      clubId: true,
      code: true,
      title: true,
      description: true,
      retiredAt: true,
      createdAt: true,
      updatedAt: true,
      currentVersionId: true,
      aiMetadataAttributionAt: true,
      aiMetadataAttributionRunId: true,
      aiMetadataAttributionSource: true,
      aiMetadataAttributedTitle: true,
    },
  });
  const version = await p.trainingCourseVersion.findUnique({
    where: { id: "${VERSION_ID}" },
    select: {
      id: true,
      courseId: true,
      version: true,
      state: true,
      title: true,
      description: true,
      publishedAt: true,
      createdAt: true,
      updatedAt: true,
      videoStorageKey: true,
      videoSha256: true,
      videoDurationSec: true,
    },
  });
  const runs = await p.trainingQuestionAiGenerationRun.findMany({
    where: { courseId: "${COURSE_ID}" },
    orderBy: { requestedAt: "desc" },
    take: 5,
    select: {
      id: true,
      executionStatus: true,
      requestedAt: true,
      completedAt: true,
      attempts: true,
      modelName: true,
      planIdentity: true,
    },
  });
  const audits = await p.auditLog.findMany({
    where: {
      OR: [
        { entityType: "TrainingCourse", entityId: "${COURSE_ID}" },
        { action: { contains: "course.metadata" }, metaJson: { contains: "${COURSE_ID}" } },
      ],
    },
    orderBy: { createdAt: "desc" },
    take: 25,
    select: {
      id: true,
      action: true,
      entityType: true,
      entityId: true,
      userId: true,
      beforeJson: true,
      afterJson: true,
      metaJson: true,
      createdAt: true,
    },
  });
  const auditsOnVersion = await p.auditLog.findMany({
    where: { entityType: "TrainingCourseVersion", entityId: "${VERSION_ID}" },
    orderBy: { createdAt: "desc" },
    take: 15,
    select: {
      id: true,
      action: true,
      userId: true,
      afterJson: true,
      createdAt: true,
    },
  });
  console.log(JSON.stringify({
    capturedAt: new Date().toISOString(),
    course,
    version,
    runs,
    auditsOnCourse: audits,
    auditsOnVersion,
  }, null, 2));
} finally {
  await p.$disconnect();
}
`;

async function runFly() {
  return new Promise((resolve, reject) => {
    const b64 = Buffer.from(script, "utf8").toString("base64");
    const remoteShell = "echo " + b64 + " | base64 -d | node --input-type=module";
    const args = ["ssh", "console", "--app", APP, "--command", "sh -c " + JSON.stringify(remoteShell)];
    const child = spawn(FLYCTL, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => { stdout += d; process.stdout.write(d); });
    child.stderr.on("data", (d) => { stderr += d; process.stderr.write(d); });
    child.on("close", (code) => code === 0 ? resolve({ stdout, stderr }) : reject(new Error("flyctl exited " + code)));
  });
}

const r = await runFly();
const match = r.stdout.match(/\{[\s\S]*"capturedAt"[\s\S]*\}/);
if (!match) { console.error("\nNo JSON blob captured"); process.exit(1); }
fs.mkdirSync("test-results", { recursive: true });
fs.writeFileSync("test-results/4yad-diag.json", match[0]);
const d = JSON.parse(match[0]);
console.log("\n━━━━━━━━━━ 4Y-AD DIAGNOSIS ━━━━━━━━━━");
console.log("COURSE.title:              ", JSON.stringify(d.course?.title));
console.log("COURSE.description(first120):", JSON.stringify((d.course?.description ?? "").slice(0, 120)));
console.log("COURSE.code:               ", JSON.stringify(d.course?.code));
console.log("COURSE.updatedAt:          ", d.course?.updatedAt);
console.log("attribution.source:        ", d.course?.aiMetadataAttributionSource);
console.log("attribution.runId:         ", d.course?.aiMetadataAttributionRunId);
console.log("attribution.at:            ", d.course?.aiMetadataAttributionAt);
console.log("attribution.title:         ", JSON.stringify(d.course?.aiMetadataAttributedTitle));
console.log();
console.log("VERSION.title:             ", JSON.stringify(d.version?.title));
console.log("VERSION.description(first120):", JSON.stringify((d.version?.description ?? "").slice(0, 120)));
console.log("VERSION.updatedAt:         ", d.version?.updatedAt);
console.log();
console.log("audits on course (newest 5):");
for (const a of d.auditsOnCourse.slice(0, 5)) console.log("  ", a.createdAt, a.action, a.userId ?? "(system)");
console.log("\naudits on version (newest 5):");
for (const a of d.auditsOnVersion.slice(0, 5)) console.log("  ", a.createdAt, a.action, a.userId ?? "(system)");
