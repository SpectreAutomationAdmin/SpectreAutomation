// EP-TRAIN-3 Slice 3B (2026-10-30) -- MP4 fast-start remuxing utility.
//
// Takes uploaded MP4 bytes + remuxes them with ffmpeg's `-movflags
// +faststart` + `-c copy` (stream-copy, no re-encode). Puts the moov
// atom at the START of the file so the browser can start decoding
// after a single Range request, instead of downloading the entire
// file to find moov at the end.
//
// Measured impact: 15-25s cold-start -> target < 2s first-frame.
//
// Validation: parses the output's first 10KB atoms + requires moov to
// appear before mdat. Only then is the remuxed buffer returned.
//
// Fallback: if ffmpeg is unavailable or the remux fails, returns the
// original bytes unchanged with a diagnostic field so the caller can
// decide whether to accept (dev / tests) or refuse (prod).

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type FastStartState = "already-fast-start" | "remuxed" | "not-mp4" | "ffmpeg-missing" | "remux-failed";

export interface RemuxResult {
  /** Final bytes to persist. Always a valid Buffer; identical to the
   *  input when state === "already-fast-start" | "not-mp4". */
  bytes: Buffer;
  state: FastStartState;
  /** True when the output's first 10KB show moov before mdat. */
  moovAtFront: boolean;
  /** Short diagnostic for audit / logs. */
  note: string;
  /** Byte size of the returned `bytes`. */
  sizeBytes: number;
}

/** Parse the first N bytes of an MP4 to inspect top-level atoms. */
export function inspectMp4Atoms(buf: Buffer, limit = 10 * 1024): Array<{ offset: number; size: number; type: string }> {
  const atoms: Array<{ offset: number; size: number; type: string }> = [];
  let p = 0;
  const end = Math.min(buf.length, limit);
  while (p + 8 <= end) {
    const size = buf.readUInt32BE(p);
    const type = buf.slice(p + 4, p + 8).toString("ascii");
    if (!/^[a-zA-Z0-9 ]{4}$/.test(type)) break; // not a valid atom
    atoms.push({ offset: p, size, type });
    if (size === 0) break; // extends to EOF
    if (size === 1) {
      // 64-bit size — pure JS can't read full 64-bit cleanly but we just stop.
      break;
    }
    p += size;
    if (p < 0 || p > end) break;
  }
  return atoms;
}

/** True when the file starts with ftyp + moov before any mdat. */
export function isFastStart(buf: Buffer): boolean {
  const atoms = inspectMp4Atoms(buf);
  if (atoms.length === 0) return false;
  if (atoms[0].type !== "ftyp") return false;
  const moovIdx = atoms.findIndex((a) => a.type === "moov");
  const mdatIdx = atoms.findIndex((a) => a.type === "mdat");
  // moov must appear AND must come before any observed mdat (if mdat
  // is past the 10KB window, moov is still at front, which is correct).
  if (moovIdx === -1) return false;
  if (mdatIdx !== -1 && moovIdx > mdatIdx) return false;
  return true;
}

/** True when the first atom is ftyp (minimal MP4-ish signature). */
function looksLikeMp4(buf: Buffer): boolean {
  if (buf.length < 12) return false;
  const type = buf.slice(4, 8).toString("ascii");
  return type === "ftyp";
}

/** Spawn ffmpeg with -c copy -movflags +faststart. Returns the stdout
 *  bytes OR null on any error. ffmpeg binary resolved from PATH. */
async function runFfmpegFaststart(input: Buffer, timeoutMs = 60_000): Promise<Buffer | null> {
  const dir = await mkdtemp(join(tmpdir(), "faststart-"));
  const inPath = join(dir, "in.mp4");
  const outPath = join(dir, "out.mp4");
  try {
    await writeFile(inPath, input);
    const args = [
      "-y",                  // overwrite output
      "-hide_banner",
      "-loglevel", "error",
      "-i", inPath,
      "-c", "copy",          // stream-copy (no re-encode)
      "-movflags", "+faststart",
      outPath,
    ];
    const result = await new Promise<{ ok: boolean; stderr: string }>((resolve) => {
      const proc = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
      let stderr = "";
      const timer = setTimeout(() => {
        proc.kill("SIGKILL");
        resolve({ ok: false, stderr: `timeout after ${timeoutMs}ms\n${stderr}` });
      }, timeoutMs);
      proc.stderr.on("data", (d) => { stderr += String(d); });
      proc.on("error", (err) => {
        clearTimeout(timer);
        resolve({ ok: false, stderr: String(err) });
      });
      proc.on("close", (code) => {
        clearTimeout(timer);
        resolve({ ok: code === 0, stderr });
      });
    });
    if (!result.ok) return null;
    return await readFile(outPath);
  } catch {
    return null;
  } finally {
    try { await rm(dir, { recursive: true, force: true }); } catch { /* noop */ }
  }
}

/** Idempotently fast-start-remux an MP4. Preserves the original when:
 *   - the file is not an MP4
 *   - the file is already fast-start
 *   - ffmpeg is missing or fails
 *   - the remuxed output fails validation
 *  Only replaces when the output is DEMONSTRABLY fast-start. */
export async function remuxToFastStart(bytes: Buffer, mimeType: string): Promise<RemuxResult> {
  if (!mimeType.includes("mp4") && !mimeType.includes("quicktime")) {
    return {
      bytes,
      state: "not-mp4",
      moovAtFront: false,
      note: `mimeType=${mimeType}, no fast-start applicable`,
      sizeBytes: bytes.length,
    };
  }
  if (!looksLikeMp4(bytes)) {
    return {
      bytes,
      state: "not-mp4",
      moovAtFront: false,
      note: "first atom is not ftyp; not an MP4",
      sizeBytes: bytes.length,
    };
  }
  if (isFastStart(bytes)) {
    return {
      bytes,
      state: "already-fast-start",
      moovAtFront: true,
      note: "input moov already before mdat",
      sizeBytes: bytes.length,
    };
  }
  const out = await runFfmpegFaststart(bytes);
  if (!out) {
    return {
      bytes,
      state: "ffmpeg-missing",
      moovAtFront: false,
      note: "ffmpeg returned no output (binary missing or remux failed); preserving original",
      sizeBytes: bytes.length,
    };
  }
  if (!isFastStart(out)) {
    return {
      bytes,
      state: "remux-failed",
      moovAtFront: false,
      note: "ffmpeg completed but output still not fast-start; preserving original",
      sizeBytes: bytes.length,
    };
  }
  return {
    bytes: out,
    state: "remuxed",
    moovAtFront: true,
    note: `remuxed via ffmpeg (-c copy -movflags +faststart); original ${bytes.length} -> ${out.length} bytes`,
    sizeBytes: out.length,
  };
}
