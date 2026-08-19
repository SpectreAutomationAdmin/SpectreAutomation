// HR-2B.3.2 §3 (2026-08-18) — In-page selfie capture.
//
// Owns the full camera lifecycle for the About-You photo step:
//
//   Idle → Requesting → Live → Captured → (Accepted) → Idle
//                              ↑         ↓
//                              └── Retake ─┘
//
// Every state transition is testable via data-testid. The captured
// Blob is handed to the parent via `onAccept(file)`; the parent then
// wires the File into the outer `<form>`'s hidden `<input name="photo">`
// via the DataTransfer API and calls `form.requestSubmit()`.
//
// Stream discipline:
//   • Stream tracks are stopped on Cancel, on Accept (after handoff),
//     on unmount, and on any error branch.
//   • Retake keeps the stream alive so the preview resumes without
//     re-prompting for permission.
//   • React 18 strict-mode double-invoke is guarded via a ref that
//     tracks the stream the current effect owns; the cleanup only
//     stops the exact MediaStream it created, never a later one.
//
// Compatibility fallbacks:
//   • `navigator.mediaDevices?.getUserMedia` missing → Unsupported state.
//   • getUserMedia rejects with NotAllowedError / PermissionDeniedError
//     → PermissionDenied state.
//   • getUserMedia rejects with NotFoundError / DevicesNotFoundError /
//     OverconstrainedError → Unsupported state.
//   • If `facingMode: "user"` is over-constrained (desktop with no
//     front camera), retry once with `facingMode: "environment"` and
//     finally with `video: true` before giving up.

"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type SelfieCaptureFlowProps = {
  /** Called after the user clicks "Use this photo". The provided File
   *  is a fresh JPEG named `selfie.jpg`. The parent is responsible
   *  for wiring it into the outer form and submitting. */
  onAccept: (file: File) => void;
  /** Optional label override for the Idle-state trigger. */
  triggerLabel?: string;
  /** Optional CSS class for the trigger button. */
  triggerClassName?: string;
};

type CameraState =
  | { kind: "idle" }
  | { kind: "requesting" }
  | { kind: "live" }
  | { kind: "captured"; dataUrl: string; blob: Blob }
  | { kind: "permission_denied" }
  | { kind: "unsupported"; reason: "no_api" | "no_device" | "other" };

const DEFAULT_TRIGGER_CLASSNAME =
  "rounded-md bg-stone-100 px-4 py-2 text-sm font-medium text-stone-800 hover:bg-stone-200 focus:outline-none focus:ring-2 focus:ring-emerald-700 focus:ring-offset-2";

/** Stop every track on a MediaStream. Idempotent — safe to call twice. */
function stopStream(stream: MediaStream | null) {
  if (!stream) return;
  for (const track of stream.getTracks()) {
    try {
      track.stop();
    } catch {
      // Ignore — a track already ended is not a real error.
    }
  }
}

/** Try progressively looser constraints so desktops without a front
 *  camera still get a preview. */
async function requestCameraStream(): Promise<MediaStream> {
  const md = navigator.mediaDevices;
  if (!md?.getUserMedia) {
    throw Object.assign(new Error("getUserMedia unavailable"), {
      name: "NotSupportedError",
    });
  }
  const attempts: MediaStreamConstraints[] = [
    { video: { facingMode: "user" }, audio: false },
    { video: { facingMode: "environment" }, audio: false },
    { video: true, audio: false },
  ];
  let lastErr: unknown = null;
  for (const c of attempts) {
    try {
      return await md.getUserMedia(c);
    } catch (err) {
      lastErr = err;
      const name = (err as { name?: string })?.name ?? "";
      // Do NOT keep trying if the user denied permission — retrying
      // just spams the browser's permission stack with duplicate
      // prompts and there's no chance a looser constraint helps.
      if (name === "NotAllowedError" || name === "PermissionDeniedError") {
        throw err;
      }
    }
  }
  throw lastErr ?? new Error("Camera unavailable");
}

export default function SelfieCaptureFlow({
  onAccept,
  triggerLabel = "Take a selfie",
  triggerClassName = DEFAULT_TRIGGER_CLASSNAME,
}: SelfieCaptureFlowProps) {
  const [state, setState] = useState<CameraState>({ kind: "idle" });
  const videoRef = useRef<HTMLVideoElement | null>(null);
  // The stream this component currently owns. Cleanup functions only
  // stop THIS stream — never a stream a subsequent effect started.
  const streamRef = useRef<MediaStream | null>(null);
  // Track whether the component is still mounted so async callbacks
  // don't setState after unmount and leak a stream.
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      // Unmount safety net: stop whatever stream we still hold.
      const owned = streamRef.current;
      streamRef.current = null;
      stopStream(owned);
    };
  }, []);

  // Attach the current stream to the video element whenever we enter
  // the "live" state OR when the ref remounts (React can re-render
  // the video node between Idle and Live).
  useEffect(() => {
    if (state.kind !== "live") return;
    const stream = streamRef.current;
    const video = videoRef.current;
    if (!stream || !video) return;
    // Safari + iOS: srcObject is the correct assignment path.
    try {
      video.srcObject = stream;
    } catch {
      // Extremely old browsers: fall back to createObjectURL.
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (video as any).src = (URL as any).createObjectURL(stream);
      } catch {
        /* ignore */
      }
    }
    const p = video.play();
    if (p && typeof (p as Promise<void>).catch === "function") {
      (p as Promise<void>).catch(() => {
        // Auto-play blocked — the video element will remain paused;
        // the user's next click (Take photo) still works because the
        // video frames are drawn regardless of play state.
      });
    }
  }, [state.kind]);

  const startCamera = useCallback(async () => {
    setState({ kind: "requesting" });
    try {
      const stream = await requestCameraStream();
      if (!mountedRef.current) {
        stopStream(stream);
        return;
      }
      // Stop any prior stream we still hold (should be null in Idle).
      stopStream(streamRef.current);
      streamRef.current = stream;
      setState({ kind: "live" });
    } catch (err) {
      const name = (err as { name?: string })?.name ?? "";
      if (name === "NotAllowedError" || name === "PermissionDeniedError") {
        setState({ kind: "permission_denied" });
      } else if (
        name === "NotFoundError" ||
        name === "DevicesNotFoundError" ||
        name === "OverconstrainedError"
      ) {
        setState({ kind: "unsupported", reason: "no_device" });
      } else if (name === "NotSupportedError") {
        setState({ kind: "unsupported", reason: "no_api" });
      } else {
        setState({ kind: "unsupported", reason: "other" });
      }
    }
  }, []);

  const capturePhoto = useCallback(async () => {
    const video = videoRef.current;
    if (!video) return;
    const width = video.videoWidth || 320;
    const height = video.videoHeight || 240;
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(video, 0, 0, width, height);
    // Prefer async toBlob; fall back to synchronous dataURL → Blob if
    // toBlob is missing (older jsdom / Safari quirks).
    const blob: Blob = await new Promise((resolve) => {
      if (typeof canvas.toBlob === "function") {
        canvas.toBlob(
          (b) => {
            if (b) resolve(b);
            else resolve(new Blob([], { type: "image/jpeg" }));
          },
          "image/jpeg",
          0.9,
        );
      } else {
        const dataUrl = canvas.toDataURL("image/jpeg", 0.9);
        const byteString = atob(dataUrl.split(",")[1] ?? "");
        const bytes = new Uint8Array(byteString.length);
        for (let i = 0; i < byteString.length; i++) bytes[i] = byteString.charCodeAt(i);
        resolve(new Blob([bytes], { type: "image/jpeg" }));
      }
    });
    const dataUrl = canvas.toDataURL("image/jpeg", 0.9);
    setState({ kind: "captured", dataUrl, blob });
  }, []);

  const retake = useCallback(() => {
    // Keep the stream alive; just flip back to Live. The useEffect
    // above will re-attach the stream to the (remounted) <video>.
    if (!streamRef.current) {
      // Defensive: if the stream was somehow stopped (e.g. browser
      // revoked permission mid-flow), start over.
      startCamera();
      return;
    }
    setState({ kind: "live" });
  }, [startCamera]);

  const cancel = useCallback(() => {
    const owned = streamRef.current;
    streamRef.current = null;
    stopStream(owned);
    setState({ kind: "idle" });
  }, []);

  const accept = useCallback(() => {
    if (state.kind !== "captured") return;
    const file = new File([state.blob], "selfie.jpg", {
      type: "image/jpeg",
      lastModified: Date.now(),
    });
    // Stop tracks BEFORE handing off — the parent will submit the
    // form synchronously and we don't want the camera light burning
    // during the upload.
    const owned = streamRef.current;
    streamRef.current = null;
    stopStream(owned);
    setState({ kind: "idle" });
    onAccept(file);
  }, [state, onAccept]);

  // ---- Render ----------------------------------------------------------

  if (state.kind === "idle") {
    return (
      <button
        type="button"
        data-testid="photo-selfie-button"
        onClick={startCamera}
        className={triggerClassName}
      >
        {triggerLabel}
      </button>
    );
  }

  if (state.kind === "requesting") {
    return (
      <div
        data-testid="photo-selfie-requesting"
        className="flex items-center gap-3 rounded-md border border-stone-200 bg-stone-50 px-3 py-3 text-sm text-stone-700"
        role="status"
        aria-live="polite"
      >
        <span
          aria-hidden
          className="inline-block h-3 w-3 animate-pulse rounded-full bg-emerald-700"
        />
        Requesting camera…
        <button
          type="button"
          data-testid="photo-selfie-cancel-button"
          onClick={cancel}
          className="ml-auto text-xs text-stone-500 underline hover:text-stone-800"
        >
          Cancel
        </button>
      </div>
    );
  }

  if (state.kind === "permission_denied") {
    return (
      <div
        data-testid="photo-selfie-permission-denied"
        role="alert"
        className="space-y-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-3 text-sm text-amber-900"
      >
        <p className="font-medium">Camera access was blocked.</p>
        <p className="text-xs">
          To use the in-page camera, allow camera access in your browser and try
          again. You can also use &ldquo;Choose a photo&rdquo; below to upload an existing
          image.
        </p>
        <div className="flex items-center gap-3">
          <button
            type="button"
            data-testid="photo-selfie-retry-button"
            onClick={startCamera}
            className="rounded-md bg-stone-100 px-3 py-1.5 text-xs font-medium text-stone-800 hover:bg-stone-200"
          >
            Try again
          </button>
          <button
            type="button"
            data-testid="photo-selfie-cancel-button"
            onClick={cancel}
            className="text-xs text-stone-600 underline hover:text-stone-900"
          >
            Dismiss
          </button>
        </div>
      </div>
    );
  }

  if (state.kind === "unsupported") {
    const message =
      state.reason === "no_device"
        ? "No camera was detected on this device."
        : state.reason === "no_api"
          ? "This browser doesn't support in-page camera capture."
          : "The camera couldn't be started.";
    return (
      <div
        data-testid="photo-selfie-unsupported"
        role="alert"
        className="space-y-2 rounded-md border border-stone-200 bg-stone-50 px-3 py-3 text-sm text-stone-800"
      >
        <p className="font-medium">{message}</p>
        <p className="text-xs text-stone-600">
          Use &ldquo;Choose a photo&rdquo; below to upload an existing image instead.
        </p>
        <button
          type="button"
          data-testid="photo-selfie-cancel-button"
          onClick={cancel}
          className="text-xs text-stone-600 underline hover:text-stone-900"
        >
          Dismiss
        </button>
      </div>
    );
  }

  // Live + Captured share a card wrapper.
  return (
    <div className="space-y-3 rounded-md border border-stone-200 bg-stone-50 px-3 py-3">
      <div className="mx-auto w-full max-w-[400px]">
        {state.kind === "live" ? (
          <video
            ref={videoRef}
            data-testid="photo-selfie-video"
            className="block h-auto w-full rounded-md bg-black"
            playsInline
            muted
            autoPlay
          />
        ) : (
          // eslint-disable-next-line @next/next/no-img-element -- client-only data URL
          <img
            src={state.dataUrl}
            alt="Captured selfie preview"
            data-testid="photo-selfie-still"
            className="block h-auto w-full rounded-md bg-black"
          />
        )}
      </div>
      <div className="flex flex-wrap items-center justify-center gap-3">
        {state.kind === "live" ? (
          <>
            <button
              type="button"
              data-testid="photo-selfie-take-button"
              onClick={capturePhoto}
              className="rounded-md bg-emerald-800 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-900 focus:outline-none focus:ring-2 focus:ring-emerald-700 focus:ring-offset-2"
            >
              Take photo
            </button>
            <button
              type="button"
              data-testid="photo-selfie-cancel-button"
              onClick={cancel}
              className="rounded-md border border-stone-300 px-4 py-2 text-sm font-medium text-stone-700 hover:border-stone-400"
            >
              Cancel
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              data-testid="photo-selfie-accept-button"
              onClick={accept}
              className="rounded-md bg-emerald-800 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-900 focus:outline-none focus:ring-2 focus:ring-emerald-700 focus:ring-offset-2"
            >
              Use this photo
            </button>
            <button
              type="button"
              data-testid="photo-selfie-retake-button"
              onClick={retake}
              className="rounded-md border border-stone-300 px-4 py-2 text-sm font-medium text-stone-700 hover:border-stone-400"
            >
              Retake
            </button>
            <button
              type="button"
              data-testid="photo-selfie-cancel-button"
              onClick={cancel}
              className="rounded-md text-sm text-stone-500 underline hover:text-stone-800"
            >
              Cancel
            </button>
          </>
        )}
      </div>
    </div>
  );
}
