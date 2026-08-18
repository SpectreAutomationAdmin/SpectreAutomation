// HR-2B.2 (2026-08-18) — Photo upload input + client-side preview.
// HR-2B.3.1 (2026-08-18) §3 — offer TWO explicit paths: "Take a selfie"
// (mobile front camera via capture="user") and "Choose a photo" (native
// picker). Both write to the SAME `name="photo"` form control so the
// server action contract is unchanged. On desktop, capture="user" is a
// no-op — the browser opens the file picker either way.
//
// Deliberately NO custom camera engine — native inputs only. The
// employee sees a local preview from the selected File and can retake
// or upload without touching the network.

"use client";

import { useEffect, useRef, useState } from "react";

export default function PhotoUploadFields() {
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [helper, setHelper] = useState<string | null>(null);
  const selfieRef = useRef<HTMLInputElement | null>(null);
  const chooseRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  function handleFileChange(file: File | null) {
    if (!file) {
      setPreviewUrl(null);
      setSelectedName(null);
      return;
    }
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(URL.createObjectURL(file));
    setSelectedName(file.name || "photo");
    setHelper(null);
  }

  /** Ensure only ONE of the two `name="photo"` inputs holds a file at
   *  submit time. When the user picks in the selfie input we clear the
   *  choose input, and vice-versa, so the server sees a single file
   *  under `photo` instead of two. */
  function clearOther(target: HTMLInputElement | null) {
    if (target) target.value = "";
  }

  function resetSelection() {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(null);
    setSelectedName(null);
    if (selfieRef.current) selfieRef.current.value = "";
    if (chooseRef.current) chooseRef.current.value = "";
  }

  return (
    <div className="space-y-4">
      {/* Two hidden native file inputs — one with capture="user" for the
          selfie path, one without for the gallery/desktop path. Both
          share name="photo" so the server action's multipart contract
          is unchanged whichever input holds the selection. */}
      <input
        ref={selfieRef}
        type="file"
        name="photo"
        accept="image/*"
        capture="user"
        data-testid="photo-selfie-input"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0] ?? null;
          handleFileChange(f);
          if (f) clearOther(chooseRef.current);
        }}
      />
      <input
        ref={chooseRef}
        type="file"
        name="photo"
        accept="image/*"
        data-testid="photo-choose-input"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0] ?? null;
          handleFileChange(f);
          if (f) clearOther(selfieRef.current);
        }}
      />

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          data-testid="photo-selfie-button"
          onClick={() => {
            setHelper(null);
            selfieRef.current?.click();
          }}
          className="rounded-md bg-stone-100 px-4 py-2 text-sm font-medium text-stone-800 hover:bg-stone-200 focus:outline-none focus:ring-2 focus:ring-emerald-700 focus:ring-offset-2"
        >
          Take a selfie
        </button>
        <button
          type="button"
          data-testid="photo-choose-button"
          onClick={() => {
            setHelper(null);
            chooseRef.current?.click();
          }}
          className="rounded-md border border-stone-300 px-4 py-2 text-sm font-medium text-stone-700 hover:border-stone-400 focus:outline-none focus:ring-2 focus:ring-emerald-700 focus:ring-offset-2"
        >
          Choose a photo
        </button>
      </div>
      <p className="text-xs text-stone-500">
        Up to 10 MB. JPG, PNG, HEIC, or WEBP. On a phone, &ldquo;Take a selfie&rdquo;
        opens your front camera.
      </p>
      {helper && (
        <p className="text-xs text-amber-700" role="alert">{helper}</p>
      )}

      {previewUrl && (
        <div className="flex items-center gap-4 rounded-md border border-stone-200 bg-stone-50 px-3 py-3">
          {/* eslint-disable-next-line @next/next/no-img-element -- client-only object URL preview, no remote resource */}
          <img
            src={previewUrl}
            alt="Selected photo preview"
            className="h-20 w-20 rounded-md object-cover"
          />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm text-stone-800">{selectedName}</p>
            <div className="mt-1 flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={() => {
                  resetSelection();
                  selfieRef.current?.click();
                }}
                className="text-xs text-stone-600 hover:text-stone-900 underline"
              >
                Retake
              </button>
              <button
                type="button"
                onClick={resetSelection}
                className="text-xs text-stone-500 hover:text-stone-800 underline"
              >
                Choose a different photo
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
