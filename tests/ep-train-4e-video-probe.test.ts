// EP-TRAIN-4E A2 (2026-10-31) — server-side duration-extraction invariants.
//
// probeMediaDuration must:
//   - return state="ok" with a rounded integer in [1, 28800] on a valid probe;
//   - return state="probe-failed" (NOT state="ok") when ffprobe produces non-
//     numeric or zero output;
//   - return state="out-of-range" when the probed value is > 28800s or < 1s;
//   - clean up its temp dir in every path.
//
// These tests exercise the pure contract via jest-style spawn-mocking so
// no actual ffprobe binary is required.

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock node:child_process BEFORE importing the module under test so
// our stub replaces the real `spawn` for every call made by probeMediaDuration.
vi.mock("node:child_process", () => {
  return {
    spawn: vi.fn(),
  };
});

import { spawn } from "node:child_process";
import type { SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { probeMediaDuration } from "../src/lib/hr/training/video-probe";

type FakeChild = EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: (signal?: string) => void;
};

function makeFakeChild(): FakeChild {
  const emitter = new EventEmitter() as FakeChild;
  emitter.stdout = new EventEmitter();
  emitter.stderr = new EventEmitter();
  emitter.kill = () => { /* noop */ };
  return emitter;
}

/** Install a spawn stub that produces (stdout, stderr, exitCode) in order of
 *  spawn calls. */
function installSpawnScript(scripted: Array<{ stdout?: string; stderr?: string; code?: number; errorCode?: string }>): void {
  const mocked = spawn as unknown as ReturnType<typeof vi.fn>;
  mocked.mockReset();
  let idx = 0;
  mocked.mockImplementation(((command: string, _args: ReadonlyArray<string>, _opts: SpawnOptions) => {
    const spec = scripted[idx++] ?? { code: 0, stdout: "" };
    const child = makeFakeChild();
    // Defer emits so the caller can attach listeners synchronously.
    queueMicrotask(() => {
      if (spec.errorCode) {
        const err = new Error("spawn error");
        (err as NodeJS.ErrnoException).code = spec.errorCode;
        child.emit("error", err);
        return;
      }
      if (spec.stdout) child.stdout.emit("data", Buffer.from(spec.stdout));
      if (spec.stderr) child.stderr.emit("data", Buffer.from(spec.stderr));
      child.emit("close", spec.code ?? 0);
    });
    return child as unknown as ReturnType<typeof spawn>;
  }) as unknown as (...args: unknown[]) => unknown);
}

describe("EP-TRAIN-4E :: probeMediaDuration", () => {
  beforeEach(() => {
    (spawn as unknown as ReturnType<typeof vi.fn>).mockReset();
  });

  it("ffprobe stdout '42.167' → state=ok, durationSec=42", async () => {
    installSpawnScript([{ stdout: "42.167\n", code: 0 }]);
    const result = await probeMediaDuration(Buffer.from([0x00]), "video/mp4");
    expect(result.state).toBe("ok");
    expect(result.durationSec).toBe(42);
    expect(result.rawDurationSec).toBeCloseTo(42.167, 2);
  });

  it("ffprobe stdout '51.0' → state=ok, durationSec=51 (matches founder's course)", async () => {
    installSpawnScript([{ stdout: "51.000000\n", code: 0 }]);
    const result = await probeMediaDuration(Buffer.from([0x00]), "video/mp4");
    expect(result.state).toBe("ok");
    expect(result.durationSec).toBe(51);
  });

  it("ffprobe stdout 'N/A' → fallback runs; both fail → state=probe-failed", async () => {
    installSpawnScript([
      { stdout: "N/A\n", code: 0 },
      // ffmpeg fallback with no Duration line
      { stderr: "no match here", code: 0 },
    ]);
    const result = await probeMediaDuration(Buffer.from([0x00]), "video/mp4");
    expect(result.state).toBe("probe-failed");
    expect(result.durationSec).toBeNull();
  });

  it("ffprobe exits non-zero + ffmpeg stderr has Duration → fallback salvages", async () => {
    installSpawnScript([
      { stderr: "ffprobe died", code: 1 },
      { stderr: "...\n  Duration: 00:00:42.17, start: 0.000000, bitrate: ...\n", code: 0 },
    ]);
    const result = await probeMediaDuration(Buffer.from([0x00]), "video/mp4");
    expect(result.state).toBe("ok");
    expect(result.durationSec).toBe(42);
  });

  it("ffprobe ENOENT → state=ffprobe-missing (no fallback attempted)", async () => {
    installSpawnScript([{ errorCode: "ENOENT" }]);
    const result = await probeMediaDuration(Buffer.from([0x00]), "video/mp4");
    expect(result.state).toBe("ffprobe-missing");
    expect(result.durationSec).toBeNull();
  });

  it("ffprobe stdout '0.0' → state=probe-failed (duration must be > 0)", async () => {
    installSpawnScript([
      { stdout: "0.0\n", code: 0 },
      { stderr: "", code: 0 },
    ]);
    const result = await probeMediaDuration(Buffer.from([0x00]), "video/mp4");
    expect(result.state).toBe("probe-failed");
  });

  it("ffprobe stdout '32400' (9h) → state=out-of-range", async () => {
    installSpawnScript([{ stdout: "32400\n", code: 0 }]);
    const result = await probeMediaDuration(Buffer.from([0x00]), "video/mp4");
    expect(result.state).toBe("out-of-range");
    expect(result.durationSec).toBeNull();
    expect(result.rawDurationSec).toBe(32400);
  });

  it("ffprobe stdout '28800' (exactly 8h) → state=ok", async () => {
    installSpawnScript([{ stdout: "28800\n", code: 0 }]);
    const result = await probeMediaDuration(Buffer.from([0x00]), "video/mp4");
    expect(result.state).toBe("ok");
    expect(result.durationSec).toBe(28800);
  });

  it("ffprobe stdout '0.4' → rounds up to 1 (minimum valid) and returns ok", async () => {
    // Edge: Math.round(0.4) = 0 but Math.max(1, 0) = 1.  A legitimately
    // 0.4s video is pathological but the clamp means we never emit 0.
    installSpawnScript([{ stdout: "0.4\n", code: 0 }]);
    const result = await probeMediaDuration(Buffer.from([0x00]), "video/mp4");
    expect(result.state).toBe("ok");
    expect(result.durationSec).toBe(1);
  });
});
