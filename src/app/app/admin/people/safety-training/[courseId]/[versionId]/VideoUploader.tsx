"use client";

// HR-2C B2 §video upload (2026-08-20) — admin video uploader.
// EP-TRAIN-4A §1 (2026-10-30) — byte-level transfer progress, smoothed
// ETA, explicit transferring/processing/ready/failed state machine,
// retry capability.
//
// Progress source: XMLHttpRequest `upload.progress` events (real
// client-to-server byte counts; never simulated).  The "Processing"
// state begins once the client has flushed the entire request body
// and the server has not yet responded — this is where fast-start
// remuxing + R2 persistence run.  "Ready" is set only after the
// POST response arrives with the stored sha256 + size.

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

interface Props {
  versionId: string;
  currentSha256: string | null;
  currentMimeType: string | null;
  currentSizeBytes: number | null;
  durationSec: number | null;
  disabled?: boolean;
}

type UploadState =
  | { kind: "idle" }
  | {
      kind: "transferring";
      file: File;
      transferredBytes: number;
      startedAt: number;
      bytesPerSecond: number | null;
    }
  | { kind: "processing"; file: File }
  | { kind: "ready"; sha256: string }
  | { kind: "failed"; file: File | null; message: string };

const ACCEPTED_MIME = ["video/mp4", "video/webm", "video/quicktime"];
const MAX_BYTES = 200 * 1024 * 1024;

// EMA (exponential moving average) smoothing factor for throughput.
// A value of 0.2 gives the latest sample 20% weight, previous 80%, so
// a brief network stall doesn't swing the ETA wildly.
const ETA_EMA_ALPHA = 0.2;
// Don't show an ETA until we have at least 1s of real transfer and
// at least 2% of the file transferred — otherwise the number is noise.
const ETA_MIN_ELAPSED_MS = 1_000;
const ETA_MIN_PROGRESS = 0.02;

function bytesLabel(n: number | null): string {
  if (n === null) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatEta(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds <= 0) return "Calculating…";
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))}s remaining`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}m ${s.toString().padStart(2, "0")}s remaining`;
}

/**
 * EP-TRAIN-4A §1 — pure ETA calculation (exported for unit test).
 * Returns null when we don't yet have a reliable throughput reading.
 */
export function computeEtaSeconds(
  transferredBytes: number,
  totalBytes: number,
  elapsedMs: number,
  bytesPerSecond: number | null,
): number | null {
  if (!Number.isFinite(totalBytes) || totalBytes <= 0) return null;
  const progress = transferredBytes / totalBytes;
  if (progress >= 1) return 0;
  if (elapsedMs < ETA_MIN_ELAPSED_MS) return null;
  if (progress < ETA_MIN_PROGRESS) return null;
  if (!bytesPerSecond || bytesPerSecond <= 0) return null;
  const remainingBytes = totalBytes - transferredBytes;
  return remainingBytes / bytesPerSecond;
}

export default function VideoUploader({
  versionId,
  currentSha256,
  currentMimeType,
  currentSizeBytes,
  durationSec,
  disabled,
}: Props) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const xhrRef = useRef<XMLHttpRequest | null>(null);
  const [state, setState] = useState<UploadState>({ kind: "idle" });
  const [uploadedShaHint, setUploadedShaHint] = useState<string | null>(null);

  const hasCurrent = !!currentSha256;
  const previewSrc = hasCurrent
    ? `/api/hr/training/versions/${versionId}/video?v=${encodeURIComponent(uploadedShaHint ?? currentSha256 ?? "")}`
    : null;

  function reset() {
    xhrRef.current?.abort();
    xhrRef.current = null;
    setState({ kind: "idle" });
  }

  function startUpload(file: File) {
    if (!ACCEPTED_MIME.includes(file.type)) {
      setState({ kind: "failed", file: null, message: "Video must be MP4, WebM, or QuickTime." });
      return;
    }
    if (file.size === 0) {
      setState({ kind: "failed", file: null, message: "Video file is empty." });
      return;
    }
    if (file.size > MAX_BYTES) {
      setState({
        kind: "failed",
        file: null,
        message: `Video exceeds ${MAX_BYTES / (1024 * 1024)} MB limit.`,
      });
      return;
    }

    void probeDuration(file)
      .catch(() => null)
      .then((durationSecondsProbe) => {
        const fd = new FormData();
        fd.set("video", file);
        if (durationSecondsProbe !== null) {
          fd.set("durationSec", String(Math.floor(durationSecondsProbe)));
        }

        const xhr = new XMLHttpRequest();
        xhrRef.current = xhr;
        const startedAt = Date.now();
        let lastEventAt = startedAt;
        let lastBytes = 0;
        let smoothedBps: number | null = null;

        xhr.upload.addEventListener("progress", (ev) => {
          if (!ev.lengthComputable) return;
          const now = Date.now();
          const dtMs = Math.max(1, now - lastEventAt);
          const dBytes = ev.loaded - lastBytes;
          const sampleBps = dBytes / (dtMs / 1000);
          smoothedBps = smoothedBps === null
            ? sampleBps
            : smoothedBps * (1 - ETA_EMA_ALPHA) + sampleBps * ETA_EMA_ALPHA;
          lastEventAt = now;
          lastBytes = ev.loaded;
          setState({
            kind: "transferring",
            file,
            transferredBytes: ev.loaded,
            startedAt,
            bytesPerSecond: smoothedBps,
          });
        });

        xhr.upload.addEventListener("load", () => {
          // Client has flushed the entire request body; the server is
          // now persisting + remuxing + validating.  Distinguish this
          // from "Ready" (which only fires once the server responds).
          setState({ kind: "processing", file });
        });

        xhr.addEventListener("load", () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            try {
              const data = JSON.parse(xhr.responseText) as { sha256: string; sizeBytes: number };
              setUploadedShaHint(data.sha256.slice(0, 12));
              setState({ kind: "ready", sha256: data.sha256 });
              router.refresh();
            } catch {
              setState({ kind: "failed", file, message: "Server response was not valid JSON." });
            }
          } else {
            let message = "Upload failed.";
            try {
              const data = JSON.parse(xhr.responseText) as { error?: string };
              if (data.error) message = data.error;
            } catch { /* ignore */ }
            setState({ kind: "failed", file, message });
          }
          xhrRef.current = null;
        });

        xhr.addEventListener("error", () => {
          setState({ kind: "failed", file, message: "Network error — please try again." });
          xhrRef.current = null;
        });

        xhr.addEventListener("abort", () => {
          xhrRef.current = null;
        });

        setState({
          kind: "transferring",
          file,
          transferredBytes: 0,
          startedAt,
          bytesPerSecond: null,
        });
        xhr.open("POST", `/api/hr/training/versions/${versionId}/video`);
        xhr.send(fd);
      });
  }

  function retryUpload() {
    if (state.kind === "failed" && state.file) {
      startUpload(state.file);
    } else {
      inputRef.current?.click();
    }
  }

  // Derived values for the active-upload tile.
  let progressBytes = 0;
  let progressTotal = 0;
  let percent = 0;
  let etaSeconds: number | null = null;
  let activeFile: File | null = null;
  if (state.kind === "transferring") {
    activeFile = state.file;
    progressBytes = state.transferredBytes;
    progressTotal = state.file.size;
    percent = Math.min(100, Math.floor((state.transferredBytes / state.file.size) * 100));
    etaSeconds = computeEtaSeconds(
      state.transferredBytes,
      state.file.size,
      Date.now() - state.startedAt,
      state.bytesPerSecond,
    );
  } else if (state.kind === "processing") {
    activeFile = state.file;
    progressBytes = state.file.size;
    progressTotal = state.file.size;
    percent = 100;
  }
  const showProgressTile = state.kind === "transferring" || state.kind === "processing";
  const isBusy = state.kind === "transferring" || state.kind === "processing";

  return (
    <div className="space-y-4" data-testid="training-video-uploader">
      {hasCurrent && (
        <div className="rounded-md border border-stone-200 bg-black text-white overflow-hidden">
          {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
          <video
            key={uploadedShaHint ?? currentSha256}
            controls
            preload="metadata"
            src={previewSrc ?? undefined}
            className="w-full max-h-64 bg-black"
            data-testid="training-video-preview"
          />
          <div className="flex items-center justify-between px-4 py-2 text-xs bg-stone-900">
            <span className="font-mono text-stone-400">{currentMimeType}</span>
            <span className="text-stone-300">
              {bytesLabel(currentSizeBytes)}
              {durationSec !== null && ` · ${Math.floor(durationSec / 60)}m ${durationSec % 60}s`}
            </span>
          </div>
        </div>
      )}

      {showProgressTile && activeFile && (
        <div
          className="rounded-md border border-stone-200 bg-white px-4 py-4 space-y-3"
          data-testid="training-video-progress"
          data-upload-state={state.kind}
        >
          <div className="flex items-baseline justify-between gap-3">
            <div className="min-w-0">
              <div className="text-sm font-medium text-stone-900 truncate" data-testid="training-video-progress-filename">
                {activeFile.name}
              </div>
              <div className="text-xs text-stone-500 font-mono mt-0.5" data-testid="training-video-progress-bytes">
                {bytesLabel(progressBytes)} / {bytesLabel(progressTotal)}
              </div>
            </div>
            <div className="text-right">
              <div className="text-sm font-mono text-stone-900" data-testid="training-video-progress-percent">
                {percent}%
              </div>
              <div className="text-[11px] text-stone-500 mt-0.5" data-testid="training-video-progress-eta">
                {state.kind === "transferring" ? formatEta(etaSeconds) : "Processing video…"}
              </div>
            </div>
          </div>
          <div
            className="h-1.5 rounded-full bg-stone-200 overflow-hidden"
            role="progressbar"
            aria-valuenow={percent}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div
              className={state.kind === "processing" ? "h-full bg-amber-500 animate-pulse" : "h-full bg-emerald-600 transition-[width] duration-200"}
              style={{ width: `${percent}%` }}
              data-testid="training-video-progress-bar"
            />
          </div>
          {state.kind === "processing" && (
            <p className="text-xs text-stone-600" data-testid="training-video-processing-message">
              Transfer complete. The server is validating and preparing the
              video for fast-start playback. This usually takes a few seconds.
            </p>
          )}
        </div>
      )}

      {state.kind === "ready" && (
        <div
          className="rounded-md border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900 flex items-center justify-between gap-3"
          data-testid="training-video-ready"
        >
          <span>
            <span className="font-medium">Video ready.</span>{" "}
            Preview above now plays the uploaded video.
          </span>
          <button
            type="button"
            onClick={reset}
            className="text-xs underline underline-offset-4 text-emerald-800 hover:text-emerald-950"
            data-testid="training-video-ready-dismiss"
          >
            Dismiss
          </button>
        </div>
      )}

      {state.kind === "failed" && (
        <div
          role="alert"
          className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 flex items-center justify-between gap-3"
          data-testid="training-video-error"
        >
          <span>{state.message}</span>
          {!disabled && (
            <button
              type="button"
              onClick={retryUpload}
              className="btn btn-secondary btn-sm"
              data-testid="training-video-retry"
            >
              {state.file ? "Retry" : "Choose file"}
            </button>
          )}
        </div>
      )}

      {!disabled && !isBusy && (
        <div
          className="rounded-md border border-dashed border-stone-300 px-4 py-6 text-center cursor-pointer hover:border-stone-400"
          onClick={() => inputRef.current?.click()}
          data-testid="training-video-dropzone"
        >
          <input
            ref={inputRef}
            type="file"
            accept={ACCEPTED_MIME.join(",")}
            className="sr-only"
            data-testid="training-video-input"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) startUpload(f);
              e.target.value = "";
            }}
          />
          <p className="text-sm text-stone-700">
            {hasCurrent ? "Replace video" : "Upload training video"}
          </p>
          <p className="mt-1 text-xs text-stone-500">
            MP4 or WebM · up to {MAX_BYTES / (1024 * 1024)} MB
          </p>
        </div>
      )}
    </div>
  );
}

/** Client-side probe of the video duration by loading metadata in a
 *  temporary <video> element. Never blocks the upload — falls back to
 *  server-side null if it fails or times out. */
async function probeDuration(file: File): Promise<number | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const v = document.createElement("video");
    v.preload = "metadata";
    v.src = url;
    const done = (value: number | null) => {
      URL.revokeObjectURL(url);
      resolve(value);
    };
    v.onloadedmetadata = () => done(Number.isFinite(v.duration) ? v.duration : null);
    v.onerror = () => done(null);
    setTimeout(() => done(null), 5000);
  });
}
