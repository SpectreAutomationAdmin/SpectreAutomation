// EP-UX-2C §2 (2026-11-01) — representative-frame extractor.
//
// Spawns ffmpeg to pull a single JPEG frame from an uploaded
// training video.  Captures a frame a few seconds in to avoid the
// opening black / title cards (safe default: `videoDurationSec` × 0.1
// clamped to [1, 10] seconds).  Shrinks to 640 px wide while
// preserving the source's aspect ratio.  Encodes JPEG q=4 (small
// but legible).
//
// Alpine's ffmpeg package (Dockerfile line 68-75) includes the
// JPEG decoder, so no additional runtime deps are required.
//
// Returns a structured outcome.  Caller must honor:
//   state === "ok"              → persist bytes
//   state === "ffmpeg-missing"  → silently fall back to placeholder
//   state === "extract-failed"  → silently fall back to placeholder
//
// This extractor is called from TWO code paths:
//   1. uploadTrainingVideo         (fresh upload, inline)
//   2. ep-ux-2c-thumbnail-backfill (legacy videos, batch)
// Both pass the SAME inputs (bytes + mime); the extractor is
// side-effect free aside from a short-lived /tmp directory.

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type ThumbnailState = "ok" | "ffmpeg-missing" | "extract-failed";

export interface ThumbnailResult {
  state: ThumbnailState;
  bytes: Buffer | null;
  mimeType: string;
  note: string;
  /** The timestamp (seconds) ffmpeg was asked to capture.  Useful for
   *  audit / later tuning.  Null when extraction never ran. */
  capturedAtSec: number | null;
}

const THUMBNAIL_MIME = "image/jpeg";
const TARGET_WIDTH = 640;

/** Pick a sensible representative timestamp.  Avoids the black / title
 *  frames at the very start by seeking 10 % in, clamped to [1, 10]s. */
function pickCaptureSeconds(durationSec: number | null | undefined): number {
  if (!durationSec || !Number.isFinite(durationSec) || durationSec <= 2) return 0.5;
  const candidate = Math.round(durationSec * 0.1);
  return Math.max(1, Math.min(10, candidate));
}

async function runFfmpegThumbnail(
  inPath: string,
  outPath: string,
  seekSec: number,
  timeoutMs = 20_000,
): Promise<{ ok: true } | { ok: false; reason: "ffmpeg-missing" | "extract-failed"; note: string }> {
  return new Promise((resolve) => {
    // -ss BEFORE -i = fast seek (less accurate but we don't need
    // frame-perfect precision); -vframes 1 = one frame only; scale
    // keeps the aspect ratio by using -2 on height; q:v 4 = JPEG
    // quality 4 (balance of size + legibility).
    const args = [
      "-y",
      "-hide_banner",
      "-loglevel", "error",
      "-ss", String(seekSec),
      "-i", inPath,
      "-vframes", "1",
      "-vf", `scale=${TARGET_WIDTH}:-2`,
      "-q:v", "4",
      outPath,
    ];
    const proc = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      resolve({ ok: false, reason: "extract-failed", note: `ffmpeg timeout after ${timeoutMs}ms` });
    }, timeoutMs);
    proc.stderr.on("data", (d) => { stderr += String(d); });
    proc.on("error", (err) => {
      clearTimeout(timer);
      const reason = (err as NodeJS.ErrnoException).code === "ENOENT" ? "ffmpeg-missing" : "extract-failed";
      resolve({ ok: false, reason, note: `${reason}: ${err.message}` });
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve({ ok: true });
      } else {
        resolve({ ok: false, reason: "extract-failed", note: `ffmpeg exit ${code}: ${stderr.slice(0, 200)}` });
      }
    });
  });
}

/** Extract a representative frame from the given video bytes.
 *  Non-throwing; returns a structured outcome. */
export async function extractVideoThumbnail(
  videoBytes: Buffer,
  videoMimeType: string,
  videoDurationSec: number | null,
): Promise<ThumbnailResult> {
  const ext = videoMimeType.includes("webm") ? ".webm"
    : videoMimeType.includes("quicktime") ? ".mov"
    : ".mp4";
  const dir = await mkdtemp(join(tmpdir(), "thumb-"));
  const inPath = join(dir, `in${ext}`);
  const outPath = join(dir, "out.jpg");
  const seekSec = pickCaptureSeconds(videoDurationSec);
  try {
    await writeFile(inPath, videoBytes);
    const result = await runFfmpegThumbnail(inPath, outPath, seekSec);
    if (!result.ok) {
      return { state: result.reason, bytes: null, mimeType: THUMBNAIL_MIME, note: result.note, capturedAtSec: seekSec };
    }
    const bytes = await readFile(outPath);
    if (bytes.length === 0) {
      return { state: "extract-failed", bytes: null, mimeType: THUMBNAIL_MIME, note: "ffmpeg produced an empty output file", capturedAtSec: seekSec };
    }
    return { state: "ok", bytes, mimeType: THUMBNAIL_MIME, note: `${bytes.length}B at ${seekSec}s`, capturedAtSec: seekSec };
  } catch (err) {
    return {
      state: "extract-failed",
      bytes: null,
      mimeType: THUMBNAIL_MIME,
      note: `extractor wrapper threw: ${err instanceof Error ? err.message : String(err)}`,
      capturedAtSec: seekSec,
    };
  } finally {
    try { await rm(dir, { recursive: true, force: true }); } catch { /* noop */ }
  }
}
