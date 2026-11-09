#!/usr/bin/env node
// EP-TRAIN-4Y-V V-2 pre-flight — READ-ONLY idempotency verification.
// Confirms the founder course's chain on staging BEFORE firing the
// authorized pilot in V-3:
//   - course + version exist (expected)
//   - video uploaded + sha recorded
//   - transcript build resolved (expected: reused from Silver Springs)
//   - NO active TrainingQuestionAiGenerationRun (prerequisite for
//     the pilot — if a default-plan auto-trigger beat us to it, we
//     STOP and ask).
//   - attribution columns exist (migration applied)
//
// No writes. No GPU. Exits 0 on green, 1 on any blocker.
//
// Runs locally against the staging DB via `flyctl ssh console` + a
// one-shot node script. Direct DB read, no HTTP.

import { execSync } from "node:child_process";

const COURSE_ID = "cmw8n6z8f0008z4nxck6uvms9";
const VERSION_ID = "cmw8n6z9a000az4nx56vwh02f";

function ssh(cmd) {
  // Pipe a tiny Node one-shot into a running staging container via
  // `fly ssh console -C`. The container has node + the generated
  // prisma client at /app/node_modules/@prisma/client.
  const escaped = cmd.replace(/'/g, `'"'"'`);
  return execSync(
    `"C:/Users/cturcato/.fly/bin/flyctl.exe" ssh console -a spectre-staging -C "/bin/sh -c '${escaped}'" 2>&1`,
    { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
  );
}

function reportTable(label, row) {
  console.log(`\n=== ${label} ===`);
  for (const [k, v] of Object.entries(row)) {
    console.log(`  ${k}: ${v === null ? "null" : JSON.stringify(v)}`);
  }
}

const PROBE = `
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
(async () => {
  const course = await p.trainingCourse.findUnique({
    where: { id: '${COURSE_ID}' },
    select: {
      id: true,
      title: true,
      code: true,
      description: true,
      aiMetadataAttributionAt: true,
      aiMetadataAttributionRunId: true,
      aiMetadataAttributionSource: true,
      aiMetadataAttributedTitle: true,
    },
  });
  const version = await p.trainingCourseVersion.findUnique({
    where: { id: '${VERSION_ID}' },
    select: {
      id: true,
      state: true,
      videoSha256: true,
      videoDurationSec: true,
      videoStorageKey: true,
      courseId: true,
      course: { select: { clubId: true } },
    },
  });
  const activeRuns = await p.trainingQuestionAiGenerationRun.findMany({
    where: {
      courseVersionId: '${VERSION_ID}',
      executionStatus: { in: ['REQUESTED', 'QUEUED', 'RUNNING', 'COMPLETED'] },
    },
    select: {
      id: true,
      executionStatus: true,
      planIdentity: true,
      requestedAt: true,
      sourceVideoSha256: true,
    },
    orderBy: { requestedAt: 'desc' },
  });
  const latestBuild = version?.videoSha256
    ? await p.trainingTranscriptBuild.findFirst({
        where: { sourceVideoSha256: version.videoSha256, clubId: version.course.clubId },
        orderBy: { producedAt: 'desc' },
        select: {
          id: true,
          resolvedTranscriptBuildId: true,
          producedAt: true,
          transcriberName: true,
          transcriberModelName: true,
        },
      })
    : null;
  const segmentCount = latestBuild
    ? await p.trainingTranscriptSegment.count({
        where: { transcriptBuildId: latestBuild.id, clubId: version.course.clubId },
      })
    : 0;
  console.log(JSON.stringify({ course, version, activeRuns, latestBuild, segmentCount }));
  await p.$disconnect();
})();
`;

console.log("EP-TRAIN-4Y-V V-2 pre-flight — reading founder course state from staging…");
console.log(`  COURSE_ID: ${COURSE_ID}`);
console.log(`  VERSION_ID: ${VERSION_ID}\n`);

const out = ssh(
  `cd /app && node -e ${JSON.stringify(PROBE).replace(/"/g, `\\"`)}`,
);

// Find the JSON line we emitted (Fly SSH wraps with diagnostic output).
const jsonLine = out.split("\n").find((l) => l.trim().startsWith("{\"course\":"));
if (!jsonLine) {
  console.error("ERROR: no probe output captured. Raw output:\n", out.slice(-2000));
  process.exit(2);
}
const probe = JSON.parse(jsonLine);

reportTable("course", probe.course);
reportTable("version", probe.version);
reportTable("latestBuild", probe.latestBuild);
console.log(`\n=== segmentCount: ${probe.segmentCount}`);
console.log(`\n=== activeRuns (${probe.activeRuns.length}) ===`);
for (const r of probe.activeRuns) {
  reportTable(`  run ${r.id}`, r);
}

// Preconditions for V-3 pilot.
let blockers = 0;
function check(cond, msg) {
  if (cond) {
    console.log(`  OK: ${msg}`);
  } else {
    console.log(`  BLOCKER: ${msg}`);
    blockers++;
  }
}

console.log("\n=== Pilot preconditions ===");
check(probe.course !== null, "course exists");
check(probe.version !== null, "version exists");
check(probe.version?.state === "DRAFT", "version is DRAFT");
check(
  typeof probe.version?.videoSha256 === "string" && probe.version.videoSha256.length === 64,
  "video sha256 recorded",
);
check(probe.latestBuild !== null, "transcript build resolved");
check(probe.segmentCount > 20, `transcript segments ≥ 20 (got ${probe.segmentCount})`);
check(
  probe.activeRuns.filter((r) => r.executionStatus !== "FAILED" && r.executionStatus !== "CANCELLED").length === 0,
  "no active or completed generation run blocking the pilot",
);
check(
  "aiMetadataAttributionAt" in (probe.course ?? {}),
  "aiMetadataAttribution* columns present (4Y-V migration applied)",
);

if (blockers > 0) {
  console.log(`\nBLOCKERS: ${blockers} — NOT clear to fire V-3 pilot.`);
  process.exit(1);
}
console.log("\nALL PRECONDITIONS MET. Clear to fire V-3 pilot.");
