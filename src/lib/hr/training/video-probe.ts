// EP-TRAIN-4E A2 (2026-10-31) — server-side video duration extraction.
//
// Spectre must NEVER trust a client-supplied `durationSec` as the
// authoritative length of a training video — the browser's
// HTMLVideoElement is best-effort and can report NaN / 0 / Infinity on
// some codecs, and a malicious client could trivially forge any value.
//
// Alpine's `ffmpeg` package (Dockerfile line 68-75) bundles `ffprobe`,
// so we can invoke it directly without a separate install step.
//
// We extract duration two ways and take the first that returns a
// finite, positive, plausible value:
//   1. `ffprobe -show_entries format=duration` → the authoritative
//      container-level duration.
//   2. Fallback: `ffmpeg -i <in> -f null -` → parse stderr for
//      `Duration: HH:MM:SS.ms`.  Covers the rare case where the
//      container has no `format.duration` tag but the stream itself
//      can be decoded.
//
// Hard cap: 0 < duration <= 28800 (8h) — same band already enforced
// on the client-supplied field in video.ts.
//
// The caller stores the probed value verbatim.  Clients that pass a
// client-supplied `durationSec` are IGNORED for authoritative-length
// purposes; the client value is at best logged as a cross-check.

import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type ProbeState =
  | "ok"
  | "ffprobe-missing"
  | "no-duration"
  | "out-of-range"
  | "probe-failed";

export interface ProbeResult {
  state: ProbeState;
  /** Integer seconds (floor of the probed float).  Only valid when
   *  state === "ok".  Guaranteed 1..28800 in that case. */
  durationSec: number | null;
  /** Raw float probed from the media (before rounding + clamping).
   *  Useful for log / audit. */
  rawDurationSec: number | null;
  /** Short diagnostic for audit / logs.  Never contains user input. */
  note: string;
}

const MIN_DURATION_SEC = 1;
const MAX_DURATION_SEC = 8 * 3600;

/** Spawn `ffprobe -v error -show_entries format=duration -of
 *  default=noprint_wrappers=1:nokey=1 <path>`.  Returns the parsed
 *  float on success, OR null on any failure (missing binary, non-zero
 *  exit code, non-numeric output). */
async function runFfprobeDuration(path: string, timeoutMs = 20_000): Promise<{ ok: true; durationSec: number } | { ok: false; reason: "ffprobe-missing" | "probe-failed"; note: string }> {
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
      resolve({ ok: false, reason: "probe-failed", note: `ffprobe timeout after ${timeoutMs}ms` });
    }, timeoutMs);
    proc.stdout.on("data", (d) => { stdout += String(d); });
    proc.stderr.on("data", (d) => { stderr += String(d); });
    proc.on("error", (err) => {
      clearTimeout(timer);
      // ENOENT = binary not installed; other codes = probe-failed.
      const reason = (err as NodeJS.ErrnoException).code === "ENOENT" ? "ffprobe-missing" : "probe-failed";
      resolve({ ok: false, reason, note: `${reason}: ${err.message}` });
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        resolve({ ok: false, reason: "probe-failed", note: `ffprobe exit ${code}: ${stderr.slice(0, 200)}` });
        return;
      }
      const raw = Number.parseFloat(stdout.trim());
      if (!Number.isFinite(raw) || raw <= 0) {
        resolve({ ok: false, reason: "probe-failed", note: `ffprobe produced non-numeric duration: ${stdout.trim().slice(0, 80)}` });
        return;
      }
      resolve({ ok: true, durationSec: raw });
    });
  });
}

/** Fallback: parse the `Duration: HH:MM:SS.ms` line out of
 *  `ffmpeg -i <path> -f null -` stderr.  Only used if ffprobe failed
 *  with "probe-failed" (not "ffprobe-missing" — if ffprobe is missing,
 *  ffmpeg likely is too). */
async function runFfmpegDurationFromStderr(path: string, timeoutMs = 20_000): Promise<{ ok: true; durationSec: number } | { ok: false; note: string }> {
  return new Promise((resolve) => {
    const proc = spawn("ffmpeg", [
      "-hide_banner",
      "-i", path,
      "-f", "null",
      "-",
    ], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      resolve({ ok: false, note: `ffmpeg timeout after ${timeoutMs}ms` });
    }, timeoutMs);
    proc.stderr.on("data", (d) => { stderr += String(d); });
    proc.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, note: `ffmpeg spawn error: ${err.message}` });
    });
    proc.on("close", () => {
      clearTimeout(timer);
      // ffmpeg -f null exits 0 for -i probes.  Parse Duration from stderr
      // regardless of exit code so we can still salvage probe data from
      // partial reads.
      const match = /Duration:\s*(\d+):(\d{2}):(\d{2})\.(\d+)/.exec(stderr);
      if (!match) {
        resolve({ ok: false, note: `ffmpeg stderr lacked Duration line (${stderr.length}B)` });
        return;
      }
      const h = Number(match[1]);
      const m = Number(match[2]);
      const s = Number(match[3]);
      const fracRaw = match[4];
      const frac = Number("0." + fracRaw);
      const durationSec = h * 3600 + m * 60 + s + (Number.isFinite(frac) ? frac : 0);
      if (!Number.isFinite(durationSec) || durationSec <= 0) {
        resolve({ ok: false, note: `ffmpeg Duration parsed to invalid value: ${durationSec}` });
        return;
      }
      resolve({ ok: true, durationSec });
    });
  });
}

/** Probe a training video's duration server-side.  Writes bytes to a
 *  short-lived temp file, invokes ffprobe (with ffmpeg stderr fallback),
 *  validates the result, and returns a structured outcome.
 *
 *  Caller MUST honor the structured state — treat anything other than
 *  state === "ok" as a hard failure (reject the upload, do NOT publish). */
export async function probeMediaDuration(bytes: Buffer, mimeType: string): Promise<ProbeResult> {
  const ext = mimeType.includes("webm") ? ".webm"
    : mimeType.includes("quicktime") ? ".mov"
    : ".mp4";
  const dir = await mkdtemp(join(tmpdir(), "probe-"));
  const inPath = join(dir, `in${ext}`);
  try {
    await writeFile(inPath, bytes);
    // Primary: ffprobe.
    const primary = await runFfprobeDuration(inPath);
    let raw: number | null = null;
    let probeNote = "";
    if (primary.ok) {
      raw = primary.durationSec;
      probeNote = "ffprobe";
    } else if (primary.reason === "ffprobe-missing") {
      return {
        state: "ffprobe-missing",
        durationSec: null,
        rawDurationSec: null,
        note: primary.note,
      };
    } else {
      // Fallback: ffmpeg -i stderr parsing.
      const fallback = await runFfmpegDurationFromStderr(inPath);
      if (fallback.ok) {
        raw = fallback.durationSec;
        probeNote = `ffprobe failed (${primary.note}); ffmpeg stderr salvage`;
      } else {
        return {
          state: "probe-failed",
          durationSec: null,
          rawDurationSec: null,
          note: `ffprobe: ${primary.note}; ffmpeg: ${fallback.note}`,
        };
      }
    }
    const rounded = Math.max(1, Math.round(raw));
    if (rounded < MIN_DURATION_SEC || rounded > MAX_DURATION_SEC) {
      return {
        state: "out-of-range",
        durationSec: null,
        rawDurationSec: raw,
        note: `probed ${raw}s is outside acceptable band ${MIN_DURATION_SEC}..${MAX_DURATION_SEC}`,
      };
    }
    return {
      state: "ok",
      durationSec: rounded,
      rawDurationSec: raw,
      note: `${probeNote}: raw=${raw.toFixed(3)}s rounded=${rounded}s`,
    };
  } catch (err) {
    return {
      state: "probe-failed",
      durationSec: null,
      rawDurationSec: null,
      note: `probe wrapper threw: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    try { await rm(dir, { recursive: true, force: true }); } catch { /* noop */ }
  }
}
