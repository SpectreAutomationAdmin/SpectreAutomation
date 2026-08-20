"use client";

// HR-2C B2 §video upload (2026-08-20) — admin video uploader.
//
// Client-side upload flow with progress + validation + preview of the
// currently-attached video. Never exposes storage keys — always
// references the same-origin proxy route.

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

const ACCEPTED_MIME = ["video/mp4", "video/webm", "video/quicktime"];
const MAX_BYTES = 200 * 1024 * 1024;

function bytesLabel(n: number | null): string {
  if (n === null) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
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
  const [selected, setSelected] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uploadedShaHint, setUploadedShaHint] = useState<string | null>(null);

  const hasCurrent = !!currentSha256;
  const previewSrc = hasCurrent
    ? `/api/hr/training/versions/${versionId}/video?v=${encodeURIComponent(uploadedShaHint ?? currentSha256 ?? "")}`
    : null;

  async function handleUpload(file: File) {
    setError(null);
    if (!ACCEPTED_MIME.includes(file.type)) {
      setError("Video must be MP4, WebM, or QuickTime.");
      return;
    }
    if (file.size === 0) {
      setError("Video file is empty.");
      return;
    }
    if (file.size > MAX_BYTES) {
      setError(`Video exceeds ${MAX_BYTES / (1024 * 1024)} MB limit.`);
      return;
    }
    setBusy(true);
    try {
      // Client-side duration probe.
      const durationSecondsProbe = await probeDuration(file).catch(() => null);
      const fd = new FormData();
      fd.set("video", file);
      if (durationSecondsProbe !== null) fd.set("durationSec", String(Math.floor(durationSecondsProbe)));
      const res = await fetch(`/api/hr/training/versions/${versionId}/video`, {
        method: "POST",
        body: fd,
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setError(data.error ?? "Upload failed.");
        setBusy(false);
        return;
      }
      const data = (await res.json()) as { sha256: string; sizeBytes: number };
      setUploadedShaHint(data.sha256.slice(0, 12));
      setSelected(null);
      router.refresh();
    } catch {
      setError("Network error — please try again.");
    } finally {
      setBusy(false);
    }
  }

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

      {!disabled && (
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
              if (f) {
                setSelected(f);
                void handleUpload(f);
              }
              e.target.value = "";
            }}
          />
          <p className="text-sm text-stone-700">
            {busy && selected ? `Uploading ${selected.name}…` : hasCurrent ? "Replace video" : "Upload training video"}
          </p>
          <p className="mt-1 text-xs text-stone-500">MP4 or WebM · up to {MAX_BYTES / (1024 * 1024)} MB</p>
        </div>
      )}

      {error && (
        <p role="alert" className="text-sm text-red-700" data-testid="training-video-error">
          {error}
        </p>
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
