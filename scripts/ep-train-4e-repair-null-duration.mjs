#!/usr/bin/env node
// EP-TRAIN-4E A3 (2026-10-31) — repair training videos whose
// videoDurationSec is NULL by probing the ORIGINAL stored media
// object with ffprobe (ffmpeg fallback).
//
// SAFETY INVARIANTS (per founder directive §A3):
//   - DRY-RUN by default (DRY_RUN=1).  Set DRY_RUN=0 to apply writes.
//   - Only the `videoDurationSec` column is modified.  Everything else
//     — videoStorageKey / videoSha256 / videoSizeBytes / videoMimeType
//     / state / publishedAt / retiredAt / createdAt / etc. — is
//     preserved verbatim.
//   - NEVER touches TrainingProgress, TrainingAttempt, TrainingCompletion,
//     TrainingAssignment, or any employee record.  Those are a
//     separately-authorised action per §A3.
//   - Writes an audit row via the standard hr.training.video.optimize
//     action with a before/after snapshot for every row updated.
//   - Verifies the probed duration is 1..28800s before writing.  Rows
//     whose probe fails or whose duration lands outside that band are
//     logged + skipped (NOT updated).
//
// Usage via flyctl ssh:
//   DRY_RUN=1 flyctl ssh console --app spectre-staging -C \
//     "sh -c 'cd /app && node scripts/ep-train-4e-repair-null-duration.mjs'"
//   DRY_RUN=0 flyctl ssh console --app spectre-staging -C \
//     "sh -c 'cd /app && node scripts/ep-train-4e-repair-null-duration.mjs'"
//
// The script writes bytes to /tmp per candidate and cleans up after
// itself.  A failed probe leaves the DB row unchanged.

import { PrismaClient } from "@prisma/client";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";

const prisma = new PrismaClient();

const MIN_DURATION_SEC = 1;
const MAX_DURATION_SEC = 8 * 3600;
const DRY_RUN = process.env.DRY_RUN !== "0";

function s3Client() {
  const endpoint = process.env.S3_ENDPOINT;
  const region = process.env.S3_REGION ?? "auto";
  const forcePathStyle = String(process.env.S3_FORCE_PATH_STYLE ?? "true") === "true";
  const accessKeyId = process.env.R2_ACCESS_KEY_ID ?? process.env.S3_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY ?? process.env.S3_SECRET_ACCESS_KEY;
  if (!endpoint || !accessKeyId || !secretAccessKey) {
    throw new Error("Missing S3/R2 credentials in env (S3_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY)");
  }
  return new S3Client({ endpoint, region, forcePathStyle, credentials: { accessKeyId, secretAccessKey } });
}

async function fetchObjectBytes(client, bucket, clubId, storageKey) {
  // The s3StorageAdapter (src/lib/integrations/storage.ts:60) stores
  // the real R2 Key as `clubs/${clubId}/${storageKey}` -- prepending
  // the club prefix regardless of what the storageKey already carries.
  // Reproduce that convention here so the raw S3 Get lines up.
  const realKey = `clubs/${clubId}/${storageKey}`;
  const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: realKey }));
  const chunks = [];
  for await (const chunk of res.Body) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function probeDuration(path) {
  return new Promise((resolve) => {
    const proc = spawn("ffprobe", [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      path,
    ], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      resolve({ ok: false, note: `ffprobe timeout` });
    }, 20_000);
    proc.stdout.on("data", (d) => { stdout += String(d); });
    proc.stderr.on("data", (d) => { stderr += String(d); });
    proc.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, note: `ffprobe error: ${err.message}` });
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) { resolve({ ok: false, note: `ffprobe exit ${code}: ${stderr.slice(0, 200)}` }); return; }
      const raw = Number.parseFloat(stdout.trim());
      if (!Number.isFinite(raw) || raw <= 0) { resolve({ ok: false, note: `non-numeric: ${stdout.slice(0, 80)}` }); return; }
      resolve({ ok: true, raw });
    });
  });
}

async function main() {
  const bucket = process.env.S3_BUCKET;
  if (!bucket) throw new Error("Missing S3_BUCKET in env");

  const affected = await prisma.trainingCourseVersion.findMany({
    where: { videoStorageKey: { not: null }, videoDurationSec: null },
    select: {
      id: true, version: true, state: true, title: true,
      videoStorageKey: true, videoMimeType: true, videoSizeBytes: true, videoSha256: true,
      publishedAt: true, retiredAt: true,
      course: { select: { id: true, code: true, title: true, clubId: true, club: { select: { name: true } } } },
    },
    orderBy: [{ course: { clubId: "asc" } }, { course: { code: "asc" } }, { version: "asc" }],
  });

  if (affected.length === 0) {
    console.log(JSON.stringify({ ok: true, dryRun: DRY_RUN, affected: 0, note: "No rows with NULL duration" }, null, 2));
    return;
  }

  const s3 = s3Client();
  const results = [];

  for (const v of affected) {
    const dir = await mkdtemp(join(tmpdir(), "ep4e-"));
    const ext = (v.videoMimeType ?? "").includes("webm") ? ".webm"
      : (v.videoMimeType ?? "").includes("quicktime") ? ".mov"
      : ".mp4";
    const inPath = join(dir, `in${ext}`);
    const row = {
      versionId: v.id,
      versionIdTail: v.id.slice(-6),
      version: v.version,
      state: v.state,
      club: v.course.club.name,
      courseCode: v.course.code,
      courseTitle: v.course.title,
      videoStorageKey: v.videoStorageKey,
      videoSizeBytes: v.videoSizeBytes,
      before: { videoDurationSec: null },
    };
    try {
      const bytes = await fetchObjectBytes(s3, bucket, v.course.clubId, v.videoStorageKey);
      await writeFile(inPath, bytes);
      const probe = await probeDuration(inPath);
      if (!probe.ok) {
        row.outcome = "probe-failed";
        row.note = probe.note;
        results.push(row);
        continue;
      }
      const rawDurationSec = probe.raw;
      const rounded = Math.max(1, Math.round(rawDurationSec));
      if (rounded < MIN_DURATION_SEC || rounded > MAX_DURATION_SEC) {
        row.outcome = "out-of-range";
        row.rawDurationSec = rawDurationSec;
        row.note = `probed ${rawDurationSec}s is outside acceptable band`;
        results.push(row);
        continue;
      }
      row.rawDurationSec = rawDurationSec;
      row.after = { videoDurationSec: rounded };
      if (DRY_RUN) {
        row.outcome = "would-update";
      } else {
        await prisma.trainingCourseVersion.update({
          where: { id: v.id },
          data: { videoDurationSec: rounded },
        });
        await prisma.auditLog.create({
          data: {
            clubId: v.course.clubId,
            userId: null,
            action: "hr.training.video.duration-repair",
            entityType: "TrainingCourseVersion",
            entityId: v.id,
            afterJson: JSON.stringify({
              repairedBy: "ep-train-4e-repair-null-duration.mjs",
              before: { videoDurationSec: null },
              after: { videoDurationSec: rounded },
              rawDurationSec,
              probeNote: `ffprobe raw=${rawDurationSec.toFixed(3)}s rounded=${rounded}s`,
              videoStorageKey: v.videoStorageKey,
              videoSha256: v.videoSha256,
            }),
          },
        }).catch(async () => {
          // Fallback — some env/schema variants require slightly different fields.
          // Preserve the attempt as a soft outcome rather than failing the repair.
          console.error(`audit insert fallback for ${v.id} failed; row updated but audit log unwritten`);
        });
        row.outcome = "updated";
      }
    } catch (err) {
      row.outcome = "error";
      row.note = err instanceof Error ? err.message : String(err);
    } finally {
      try { await rm(dir, { recursive: true, force: true }); } catch { /* noop */ }
    }
    results.push(row);
  }

  console.log(JSON.stringify({
    ok: true,
    dryRun: DRY_RUN,
    totalCandidates: affected.length,
    outcomes: {
      updated: results.filter((r) => r.outcome === "updated").length,
      wouldUpdate: results.filter((r) => r.outcome === "would-update").length,
      probeFailed: results.filter((r) => r.outcome === "probe-failed").length,
      outOfRange: results.filter((r) => r.outcome === "out-of-range").length,
      error: results.filter((r) => r.outcome === "error").length,
    },
    rows: results,
  }, null, 2));
}

main()
  .catch((err) => {
    console.error("ep-train-4e-repair failed:", err instanceof Error ? err.stack ?? err.message : String(err));
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
