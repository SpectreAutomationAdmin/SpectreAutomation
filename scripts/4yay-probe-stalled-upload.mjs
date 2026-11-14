#!/usr/bin/env node
// EP-TRAIN-4Y-AY §1 — identify the stalled video-course upload on staging.
// Read-only probe. No writes.

import { execSync } from "node:child_process";
import fs from "node:fs";

const script = `
const { PrismaClient } = require("@prisma/client");
const p = new PrismaClient();
(async () => {
  try {
    // 1. Most recently updated TrainingCourseVersion rows, DRAFT only
    const versions = await p.trainingCourseVersion.findMany({
      where: { state: "DRAFT" },
      orderBy: { updatedAt: "desc" },
      take: 25,
      select: {
        id: true, courseId: true, version: true, state: true, title: true,
        videoStorageKey: true, videoMimeType: true,
        videoSizeBytes: true, videoSha256: true, videoDurationSec: true,
        createdAt: true, updatedAt: true,
        course: { select: { id: true, clubId: true, code: true, title: true, createdByUserId: true, createdAt: true, updatedAt: true } },
        transcriptionJobs: {
          orderBy: { requestedAt: "desc" },
          select: {
            id: true, state: true, requestedAt: true, queuedAt: true,
            startedAt: true, completedAt: true, failureCode: true, failureMessage: true,
            attempts: true, maxAttempts: true, resolvedTranscriptBuildId: true,
            leaseExpiresAt: true,
          },
        },
        aiGenerationRuns: {
          orderBy: { requestedAt: "desc" },
          select: {
            id: true, executionStatus: true, requestedAt: true,
            startedAt: true, completedAt: true, executionErrorCode: true, executionErrorMessage: true, sourceVideoSha256: true,
          },
        },
      },
    });

    // 2. Transcript builds + segments for any sha we saw
    const shaSet = new Set(versions.map((v) => v.videoSha256).filter(Boolean));
    const builds = shaSet.size === 0 ? [] : await p.trainingTranscriptBuild.findMany({
      where: { sourceVideoSha256: { in: Array.from(shaSet) } },
      select: {
        id: true, clubId: true, sourceVideoSha256: true, resolvedTranscriptBuildId: true,
        producedAt: true, transcriberName: true, transcriberModelName: true,
      },
    });

    // 3. Queue status (if there's a canonical queue table)
    let queueRows = [];
    try {
      queueRows = await p.$queryRaw\`SELECT state, COUNT(*)::text AS n FROM "BackgroundTask" GROUP BY state\`;
    } catch (_e) { /* no such table on this build */ }

    console.log("==PROBE_BEGIN==");
    console.log(JSON.stringify({ versions, builds, queueRows }, null, 2));
    console.log("==PROBE_END==");
  } catch (e) {
    console.log("==PROBE_BEGIN==");
    console.log(JSON.stringify({ error: e.message, stack: e.stack }));
    console.log("==PROBE_END==");
  } finally { await p.$disconnect(); }
})();
`;
const b64 = Buffer.from(script, "utf8").toString("base64");
const remote = `sh -lc "cd /app && echo ${b64} | base64 -d | node"`;
const flyctl = "C:/Users/cturcato/.fly/bin/flyctl.exe";
const out = execSync(`"${flyctl}" ssh console --app spectre-staging --command '${remote}'`,
  { encoding: "utf8", maxBuffer: 20*1024*1024, shell: "bash.exe" });
const m = out.match(/==PROBE_BEGIN==\s*([\s\S]*?)\s*==PROBE_END==/);
if (!m) { console.error("no markers"); console.error(out.slice(-3000)); process.exit(1); }
fs.mkdirSync("test-results", { recursive: true });
fs.writeFileSync("test-results/4yay-probe-stalled-upload.json", m[1]);
console.log(m[1]);
