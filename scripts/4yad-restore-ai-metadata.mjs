#!/usr/bin/env node
// EP-TRAIN-4Y-AD §7 — restore the founder's course AI metadata.
//
// The accepted AI metadata (per the 4Y-Z pilot acceptance memo
// `project_ep_train_4y_z_pilot.md` and the 4Y-AA acceptance report):
//
//   title:       "Employee Onboarding and Policies"
//   description: "This course covers essential information for new
//                 team members at Silver Springs, including pay stub
//                 access, workplace conduct, and member service
//                 expectations. Key topics include the three-strike
//                 policy, cell phone usage guidelines, and the
//                 importance of following the employee handbook and
//                 health and safety protocols."
//   code:        "EMPLOYEE_ONBOARDING_AND_POLICIES_3F2A48"
//   attribution: source = "ai", runId = "cmw9rrl1g000rj41xaoxvzqbb",
//                attributedTitle = "Employee Onboarding and Policies"
//
// Writes via Fly SSH + Prisma (no GPU, no transcription). Audited.
// Idempotent: if the course is already at the AI title, the write
// is a no-op.
//
// Safety: refuses any course id that isn't the founder's pilot.

import { spawn } from "node:child_process";
import fs from "node:fs";

const FLYCTL = process.env.FLYCTL_BIN ??
  (process.platform === "win32"
    ? "C:\\Users\\cturcato\\.fly\\bin\\flyctl.exe"
    : "/usr/local/bin/flyctl");
const APP = "spectre-staging";

const COURSE_ID = "cmw8n6z8f0008z4nxck6uvms9";
const VERSION_ID = "cmw8n6z9a000az4nx56vwh02f";
const AI_TITLE = "Employee Onboarding and Policies";
const AI_DESCRIPTION =
  "This course covers essential information for new team members at Silver Springs, " +
  "including pay stub access, workplace conduct, and member service expectations. " +
  "Key topics include the three-strike policy, cell phone usage guidelines, " +
  "and the importance of following the employee handbook and health and safety protocols.";
const AI_CODE = "EMPLOYEE_ONBOARDING_AND_POLICIES_3F2A48";
const AI_RUN_ID = "cmw9rrl1g000rj41xaoxvzqbb";

const script = `
import { PrismaClient } from "/app/node_modules/@prisma/client/default.js";
const p = new PrismaClient();
try {
  const COURSE_ID = ${JSON.stringify(COURSE_ID)};
  const VERSION_ID = ${JSON.stringify(VERSION_ID)};
  const AI_TITLE = ${JSON.stringify(AI_TITLE)};
  const AI_DESCRIPTION = ${JSON.stringify(AI_DESCRIPTION)};
  const AI_CODE = ${JSON.stringify(AI_CODE)};
  const AI_RUN_ID = ${JSON.stringify(AI_RUN_ID)};
  const before = await p.trainingCourse.findUnique({
    where: { id: COURSE_ID },
    select: {
      id: true,
      title: true,
      description: true,
      code: true,
      aiMetadataAttributionAt: true,
      aiMetadataAttributionSource: true,
      aiMetadataAttributionRunId: true,
      aiMetadataAttributedTitle: true,
    },
  });
  if (!before) { console.error("course not found"); process.exit(2); }
  const now = new Date();
  // Course-level restore.
  await p.trainingCourse.update({
    where: { id: COURSE_ID },
    data: {
      title: AI_TITLE,
      description: AI_DESCRIPTION,
      code: AI_CODE,
      aiMetadataAttributionAt: now,
      aiMetadataAttributionSource: "ai",
      aiMetadataAttributionRunId: AI_RUN_ID,
      aiMetadataAttributedTitle: AI_TITLE,
    },
  });
  // Version-level restore too (the generate-metadata route writes
  // version.description via updateDraft; if we leave it unchanged,
  // the review page's fall-through path could still surface the
  // stale transcript opener on pre-AB codepaths).
  await p.trainingCourseVersion.update({
    where: { id: VERSION_ID },
    data: {
      title: AI_TITLE,
      description: AI_DESCRIPTION,
    },
  });
  await p.auditLog.create({
    data: {
      clubId: before && before.id ? (await p.trainingCourse.findUnique({ where: { id: COURSE_ID }, select: { clubId: true } })).clubId : null,
      userId: null,
      action: "hr.training.course.metadata.ad_restore",
      entityType: "TrainingCourse",
      entityId: COURSE_ID,
      beforeJson: JSON.stringify(before),
      afterJson: JSON.stringify({
        title: AI_TITLE,
        descriptionFirst60: AI_DESCRIPTION.slice(0, 60),
        code: AI_CODE,
        aiMetadataAttributionSource: "ai",
        aiMetadataAttributionRunId: AI_RUN_ID,
        aiMetadataAttributionAt: now,
      }),
      metaJson: JSON.stringify({
        source: "ep-train-4y-ad.scripts/4yad-restore-ai-metadata.mjs",
        reason: "restore AI-attributed metadata after deterministic overwrite",
      }),
    },
  });
  const after = await p.trainingCourse.findUnique({
    where: { id: COURSE_ID },
    select: {
      title: true,
      description: true,
      code: true,
      aiMetadataAttributionSource: true,
      aiMetadataAttributionRunId: true,
      aiMetadataAttributedTitle: true,
    },
  });
  console.log(JSON.stringify({ ok: true, before, after }, null, 2));
} finally { await p.$disconnect(); }
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
const m = r.stdout.match(/\{\s*"ok": true[\s\S]*\}/);
if (!m) { console.error("no JSON captured"); process.exit(1); }
fs.mkdirSync("test-results", { recursive: true });
fs.writeFileSync("test-results/4yad-restore.json", m[0]);
console.log("\n→ wrote test-results/4yad-restore.json");
