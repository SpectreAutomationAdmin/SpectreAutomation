// EP-TRAIN-3 Slice 3B (2026-10-30) -- remediate the staging Workplace
// Safety Orientation v2 video (and any other non-fast-start WSO
// version) via the audited `remediateVideoFastStart` service.
//
// Idempotent: if already fast-start, returns "already-fast-start" and
// writes an audit row noting the no-op.  Legitimate completions +
// progress + checkpoints are preserved (we only update
// videoStorageKey/videoSizeBytes/videoSha256 on the TrainingCourseVersion
// row; completions reference courseVersionId, not storageKey).
//
// Usage via Fly SSH:
//   base64 -w0 scripts/ep-train-3-slice3b-remediate-wso.mjs | ssh console
//
// Env: requires R2_* vars (already set on staging) + ffmpeg (installed
// via Dockerfile in this slice).

import { createRequire } from "node:module";
const require = createRequire("/app/.next/standalone/node_modules/@prisma/client/");
const { PrismaClient } = require("@prisma/client");

// Importing the compiled service via Next.js standalone. The service
// lives at `.next/standalone/.next/server/app/...` as inlined chunks;
// re-exporting through a server action is cleaner than reaching into
// the bundled chunks. For a one-shot script, replicate the behaviour
// directly using Prisma + storage adapter + ffmpeg.
const bcrypt = require("bcryptjs");
void bcrypt; // kept for consistency with other scripts
const { createHash } = require("node:crypto");
const { spawn } = require("node:child_process");
const { mkdtemp, readFile, rm, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { S3Client, GetObjectCommand, PutObjectCommand } = require("@aws-sdk/client-s3");

const CLUB_ID = "cmrvdeny7000144372ktmmg9c";
const COURSE_CODE = "WORKPLACE_SAFETY"; // adjust if different
const COURSE_ID = "cmt28yaet005g114f43ybgw9f"; // from prior probe

const p = new PrismaClient();
const s3 = new S3Client({
  region: process.env.S3_REGION ?? "auto",
  credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY },
  endpoint: process.env.S3_ENDPOINT,
  forcePathStyle: (process.env.S3_FORCE_PATH_STYLE ?? "true") === "true",
});
const BUCKET = process.env.S3_BUCKET;

function inspectAtoms(buf, limit = 10240) {
  const atoms = [];
  let pos = 0;
  const end = Math.min(buf.length, limit);
  while (pos + 8 <= end) {
    const size = buf.readUInt32BE(pos);
    const type = buf.slice(pos + 4, pos + 8).toString("ascii");
    if (!/^[a-zA-Z0-9 ]{4}$/.test(type)) break;
    atoms.push({ offset: pos, size, type });
    if (size === 0 || size === 1) break;
    pos += size;
    if (pos < 0 || pos > end) break;
  }
  return atoms;
}

function isFastStart(buf) {
  const atoms = inspectAtoms(buf);
  if (atoms.length === 0 || atoms[0].type !== "ftyp") return false;
  const moov = atoms.findIndex((a) => a.type === "moov");
  const mdat = atoms.findIndex((a) => a.type === "mdat");
  if (moov === -1) return false;
  if (mdat !== -1 && moov > mdat) return false;
  return true;
}

async function remux(bytes) {
  const dir = await mkdtemp(join(tmpdir(), "wso-faststart-"));
  const inPath = join(dir, "in.mp4");
  const outPath = join(dir, "out.mp4");
  try {
    await writeFile(inPath, bytes);
    await new Promise((resolve, reject) => {
      const proc = spawn("ffmpeg", [
        "-y", "-hide_banner", "-loglevel", "error",
        "-i", inPath, "-c", "copy", "-movflags", "+faststart", outPath,
      ], { stdio: ["ignore", "ignore", "pipe"] });
      let stderr = "";
      proc.stderr.on("data", (d) => stderr += String(d));
      proc.on("close", (code) => code === 0 ? resolve() : reject(new Error(stderr)));
      proc.on("error", reject);
    });
    return await readFile(outPath);
  } finally {
    try { await rm(dir, { recursive: true, force: true }); } catch { /* noop */ }
  }
}

async function remediateVersion(v) {
  const fullKey = `clubs/${CLUB_ID}/${v.videoStorageKey}`;
  console.log(`\n=== version ${v.id} (v${v.version}, state=${v.state}) ===`);
  console.log("storage key:", fullKey);
  const resp = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: fullKey }));
  const chunks = [];
  for await (const c of resp.Body) chunks.push(Buffer.from(c));
  const originalBuf = Buffer.concat(chunks);
  console.log("downloaded:", originalBuf.length, "bytes");
  const originalAtoms = inspectAtoms(originalBuf).slice(0, 5);
  console.log("original first-5 atoms:", JSON.stringify(originalAtoms));
  if (isFastStart(originalBuf)) {
    console.log("ALREADY_FAST_START -- no-op");
    await p.auditLog.create({
      data: {
        clubId: CLUB_ID, userId: "cmrvdenz700034437agp7gqs5",
        action: "hr.training.video.optimize",
        entityType: "TrainingCourseVersion", entityId: v.id,
        afterJson: JSON.stringify({ state: "already-fast-start", storageKey: v.videoStorageKey, reason: "EP-TRAIN-3 Slice 3B WSO remediation (operator-run)" }),
      },
    });
    return;
  }
  console.log("REMUX_START");
  const remuxed = await remux(originalBuf);
  console.log("REMUX_DONE:", remuxed.length, "bytes");
  const newAtoms = inspectAtoms(remuxed).slice(0, 5);
  console.log("remuxed first-5 atoms:", JSON.stringify(newAtoms));
  if (!isFastStart(remuxed)) {
    throw new Error("remuxed output is not fast-start -- aborting");
  }
  const newSha = createHash("sha256").update(remuxed).digest("hex");
  const newRelKey = `training/${COURSE_ID}/${v.version}/${newSha}`;
  const newFullKey = `clubs/${CLUB_ID}/${newRelKey}`;
  console.log("new storage key:", newFullKey);
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET, Key: newFullKey, Body: remuxed, ContentType: v.videoMimeType,
  }));
  console.log("UPLOADED");
  await p.trainingCourseVersion.update({
    where: { id: v.id },
    data: { videoStorageKey: newRelKey, videoSizeBytes: remuxed.length, videoSha256: newSha },
  });
  console.log("DB_UPDATED");
  await p.auditLog.create({
    data: {
      clubId: CLUB_ID, userId: "cmrvdenz700034437agp7gqs5",
      action: "hr.training.video.optimize",
      entityType: "TrainingCourseVersion", entityId: v.id,
      beforeJson: JSON.stringify({ storageKey: v.videoStorageKey, sizeBytes: originalBuf.length, sha256: v.videoSha256 }),
      afterJson: JSON.stringify({ storageKey: newRelKey, sizeBytes: remuxed.length, sha256: newSha, reason: "EP-TRAIN-3 Slice 3B WSO remediation" }),
    },
  });
  console.log("AUDITED");
}

async function main() {
  const versions = await p.trainingCourseVersion.findMany({
    where: { courseId: COURSE_ID, NOT: { videoStorageKey: null } },
    select: { id: true, version: true, state: true, videoStorageKey: true, videoMimeType: true, videoSizeBytes: true, videoSha256: true },
    orderBy: { version: "asc" },
  });
  console.log("Found", versions.length, "WSO versions with video.");
  for (const v of versions) {
    try {
      await remediateVersion(v);
    } catch (e) {
      console.error("REMEDIATE_FAILED", v.id, e.message);
    }
  }
  await p.$disconnect();
}

main().catch((e) => { console.error("ERR", e); process.exit(1); });
