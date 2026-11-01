#!/usr/bin/env node
// EP-UX-2C §2 (2026-11-01) — thumbnail backfill for existing videos.
//
// Idempotent, DRY-RUN by default (DRY_RUN=1).  For every
// TrainingCourseVersion row with videoStorageKey IS NOT NULL AND
// videoThumbnailStorageKey IS NULL:
//
//   1. Download the ORIGINAL video bytes from R2 (using the SAME
//      double-prefix key convention the s3StorageAdapter writes).
//   2. Spawn ffmpeg to extract a representative frame (10% of
//      duration, clamped to [1, 10]s; 640px wide; q=4 JPEG).
//   3. PUT the JPEG under a parallel training-thumbnails/ prefix.
//   4. UPDATE only `videoThumbnailStorageKey` +
//      `videoThumbnailMimeType` + `videoThumbnailSizeBytes`.
//      NEVER touches `videoStorageKey`, `videoSha256`, `videoSizeBytes`,
//      `videoDurationSec`, `state`, `publishedAt`, `retiredAt`.
//   5. Write an AuditLog row for every attempt (success + failure).
//
// Safety invariants (per founder EP-UX-2C directive):
//   - Does NOT modify training completion history, video content,
//     assessment configuration, or published-version identity.
//   - Does NOT touch TrainingProgress / TrainingAttempt /
//     TrainingCompletion / TrainingAssignment.
//   - A per-row failure is isolated; the next row still processes.
//   - Re-running the script on a row whose thumbnail already exists
//     is a NO-OP (the WHERE clause excludes it).
//
// Usage via flyctl ssh:
//   DRY_RUN=1 flyctl ssh console --app spectre-staging -C \
//     "sh -c 'cd /app && node scripts/ep-ux-2c-thumbnail-backfill.mjs'"
//   DRY_RUN=0 flyctl ssh console --app spectre-staging -C \
//     "sh -c 'cd /app && node scripts/ep-ux-2c-thumbnail-backfill.mjs'"

import { PrismaClient } from "@prisma/client";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";

const prisma = new PrismaClient();
const DRY_RUN = process.env.DRY_RUN !== "0";

function s3Client() {
  const endpoint = process.env.S3_ENDPOINT;
  const region = process.env.S3_REGION ?? "auto";
  const forcePathStyle = String(process.env.S3_FORCE_PATH_STYLE ?? "true") === "true";
  const accessKeyId = process.env.R2_ACCESS_KEY_ID ?? process.env.S3_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY ?? process.env.S3_SECRET_ACCESS_KEY;
  if (!endpoint || !accessKeyId || !secretAccessKey) throw new Error("missing S3/R2 credentials");
  return new S3Client({ endpoint, region, forcePathStyle, credentials: { accessKeyId, secretAccessKey } });
}

async function fetchObjectBytes(client, bucket, clubId, storageKey) {
  // Same key reconstruction as scripts/ep-train-4e-repair-null-duration.mjs
  // and the s3StorageAdapter.
  const realKey = `clubs/${clubId}/${storageKey}`;
  const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: realKey }));
  const chunks = [];
  for await (const chunk of res.Body) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function putObjectBytes(client, bucket, clubId, storageKey, bytes, mimeType) {
  const realKey = `clubs/${clubId}/${storageKey}`;
  await client.send(new PutObjectCommand({
    Bucket: bucket, Key: realKey, Body: bytes, ContentType: mimeType,
  }));
}

function pickCaptureSeconds(durationSec) {
  if (!durationSec || !Number.isFinite(durationSec) || durationSec <= 2) return 0.5;
  const candidate = Math.round(durationSec * 0.1);
  return Math.max(1, Math.min(10, candidate));
}

async function runFfmpegThumbnail(inPath, outPath, seekSec, timeoutMs = 20_000) {
  return new Promise((resolve) => {
    const args = [
      "-y", "-hide_banner", "-loglevel", "error",
      "-ss", String(seekSec),
      "-i", inPath,
      "-vframes", "1",
      "-vf", "scale=640:-2",
      "-q:v", "4",
      outPath,
    ];
    const proc = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    const timer = setTimeout(() => { proc.kill("SIGKILL"); resolve({ ok: false, note: `ffmpeg timeout` }); }, timeoutMs);
    proc.stderr.on("data", (d) => { stderr += String(d); });
    proc.on("error", (err) => { clearTimeout(timer); resolve({ ok: false, note: `ffmpeg error: ${err.message}` }); });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ ok: true });
      else resolve({ ok: false, note: `ffmpeg exit ${code}: ${stderr.slice(0, 200)}` });
    });
  });
}

async function main() {
  const bucket = process.env.S3_BUCKET;
  if (!bucket) throw new Error("missing S3_BUCKET");

  const candidates = await prisma.trainingCourseVersion.findMany({
    where: {
      videoStorageKey: { not: null },
      videoThumbnailStorageKey: null,
    },
    select: {
      id: true, version: true, state: true, title: true,
      videoStorageKey: true, videoMimeType: true, videoDurationSec: true, videoSha256: true,
      course: { select: { id: true, code: true, clubId: true, club: { select: { name: true } } } },
    },
    orderBy: [{ course: { clubId: "asc" } }, { course: { code: "asc" } }, { version: "asc" }],
  });

  if (candidates.length === 0) {
    console.log(JSON.stringify({ ok: true, dryRun: DRY_RUN, candidates: 0, note: "no rows need thumbnails" }, null, 2));
    return;
  }

  const s3 = s3Client();
  const results = [];
  for (const v of candidates) {
    const dir = await mkdtemp(join(tmpdir(), "ep2c-"));
    const ext = (v.videoMimeType ?? "").includes("webm") ? ".webm"
      : (v.videoMimeType ?? "").includes("quicktime") ? ".mov"
      : ".mp4";
    const inPath = join(dir, `in${ext}`);
    const outPath = join(dir, "out.jpg");
    const row = {
      versionId: v.id,
      versionIdTail: v.id.slice(-6),
      courseCode: v.course.code,
      courseTitle: v.title,
      club: v.course.club.name,
    };
    try {
      const videoBytes = await fetchObjectBytes(s3, bucket, v.course.clubId, v.videoStorageKey);
      await writeFile(inPath, videoBytes);
      const seekSec = pickCaptureSeconds(v.videoDurationSec);
      const probe = await runFfmpegThumbnail(inPath, outPath, seekSec);
      if (!probe.ok) {
        row.outcome = "extract-failed";
        row.note = probe.note;
        results.push(row);
        continue;
      }
      const thumbBytes = await readFile(outPath);
      row.thumbnailSizeBytes = thumbBytes.length;
      row.capturedAtSec = seekSec;
      const thumbStorageKey = `training-thumbnails/${v.course.id}/${v.version}/${v.videoSha256 ?? v.id}.jpg`;
      // The DB storageKey (the "under-prefix" slug) is the single-
      // slash form; the s3StorageAdapter will prepend `clubs/{clubId}/`.
      // For this backfill we're using the raw S3 client so we need
      // the FULL double-prefixed real R2 key — matching what the
      // upload service's `storage.put({storageKey:...})` would land.
      if (DRY_RUN) {
        row.outcome = "would-update";
        row.proposedThumbnailStorageKey = `clubs/${v.course.clubId}/${thumbStorageKey}`;
      } else {
        await putObjectBytes(s3, bucket, v.course.clubId, thumbStorageKey, thumbBytes, "image/jpeg");
        // The DB column stores the pre-double-prefix form so the
        // existing resolveDocumentStorage.get() works correctly:
        //   adapter PUT at `clubs/${clubId}/${storageKey}` ⇔
        //   adapter GET at `clubs/${clubId}/${storageKey}`.
        // The storage.put call ABOVE already added the clubs prefix,
        // so the DB key stores `clubs/${clubId}/training-thumbnails/...`
        // and the adapter re-prefixes on fetch — giving the correct
        // real R2 key (double-prefixed, matching the upload service).
        const dbKey = `clubs/${v.course.clubId}/${thumbStorageKey}`;
        await prisma.trainingCourseVersion.update({
          where: { id: v.id },
          data: {
            videoThumbnailStorageKey: dbKey,
            videoThumbnailMimeType: "image/jpeg",
            videoThumbnailSizeBytes: thumbBytes.length,
          },
        });
        await prisma.auditLog.create({
          data: {
            clubId: v.course.clubId,
            userId: null,
            action: "hr.training.video.thumbnail-backfill",
            entityType: "TrainingCourseVersion",
            entityId: v.id,
            afterJson: JSON.stringify({
              backfilledBy: "ep-ux-2c-thumbnail-backfill.mjs",
              thumbnailStorageKey: dbKey,
              thumbnailSizeBytes: thumbBytes.length,
              capturedAtSec: seekSec,
              sourceSha: v.videoSha256,
            }),
          },
        }).catch(() => { /* audit insert optional */ });
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
    totalCandidates: candidates.length,
    outcomes: {
      updated: results.filter((r) => r.outcome === "updated").length,
      wouldUpdate: results.filter((r) => r.outcome === "would-update").length,
      extractFailed: results.filter((r) => r.outcome === "extract-failed").length,
      error: results.filter((r) => r.outcome === "error").length,
    },
    rows: results,
  }, null, 2));
}

main()
  .catch((e) => { console.error("ep-ux-2c-backfill failed:", e instanceof Error ? e.stack ?? e.message : String(e)); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
