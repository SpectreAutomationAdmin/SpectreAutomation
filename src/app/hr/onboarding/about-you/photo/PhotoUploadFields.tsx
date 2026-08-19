// HR-2B.2 (2026-08-18) — Photo upload input + client-side preview.
// HR-2B.3.1 (2026-08-18) §3 — offer TWO explicit paths: "Take a selfie"
// and "Choose a photo".
// HR-2B.3.2 (2026-08-18) §3 — the selfie path now runs a real in-page
// camera experience (permission → live preview → capture → accept)
// instead of just triggering `<input capture="user">`. The captured
// Blob is wired into a hidden `<input name="photo">` via the
// DataTransfer API, then the outer form is submitted programmatically
// so the server sees the SAME multipart contract as the picker path.
//
// Both paths share `name="photo"` on the underlying inputs; the server
// action (`uploadPhotoAction`) picks the first non-empty File.

"use client";

import { useEffect, useRef, useState } from "react";
import SelfieCaptureFlow from "./SelfieCaptureFlow";

export default function PhotoUploadFields() {
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [helper, setHelper] = useState<string | null>(null);
  // The hidden `<input>` that holds a captured-selfie File. We assign
  // to it programmatically via a DataTransfer.
  const selfieInputRef = useRef<HTMLInputElement | null>(null);
  // The hidden `<input>` bound to the native picker.
  const chooseRef = useRef<HTMLInputElement | null>(null);
  // Reference to the enclosing <form> so the selfie flow can trigger
  // requestSubmit() after the capture is accepted.
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  function setFilePreview(file: File | null) {
    if (!file) {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      setPreviewUrl(null);
      setSelectedName(null);
      return;
    }
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(URL.createObjectURL(file));
    setSelectedName(file.name || "photo");
    setHelper(null);
  }

  /** Ensure only ONE `name="photo"` input carries a file at submit
   *  time. When one input receives a selection, blank the other. */
  function clearOther(target: HTMLInputElement | null) {
    if (target) target.value = "";
  }

  function resetSelection() {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(null);
    setSelectedName(null);
    if (selfieInputRef.current) selfieInputRef.current.value = "";
    if (chooseRef.current) chooseRef.current.value = "";
  }

  /** Assign the captured selfie File to the hidden selfie input via
   *  the DataTransfer API, then submit the enclosing form. The server
   *  sees the SAME `name="photo"` multipart entry it would from the
   *  native picker path. */
  function handleSelfieAccepted(file: File) {
    const input = selfieInputRef.current;
    if (!input) {
      setHelper("Something went wrong wiring the captured photo. Please choose a photo instead.");
      return;
    }
    // Clear the "other" path first — mutual exclusion.
    clearOther(chooseRef.current);
    // DataTransfer isn't supported in every environment; guard for it.
    try {
      const dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
    } catch {
      setHelper("Your browser blocked the automatic upload. Please try 'Choose a photo' instead.");
      return;
    }
    setFilePreview(file);
    // Find the enclosing form and submit programmatically so the
    // existing server action runs unchanged.
    const form = rootRef.current?.closest("form") ?? input.form;
    if (form && typeof form.requestSubmit === "function") {
      form.requestSubmit();
    } else if (form) {
      form.submit();
    } else {
      setHelper("Photo captured but the form couldn't be submitted automatically. Press the Upload button below.");
    }
  }

  return (
    <div ref={rootRef} className="space-y-4">
      {/* Hidden native inputs — both share name="photo" so the server
          action's multipart contract holds. The selfie input receives
          its file via DataTransfer from the capture flow; the choose
          input is populated by the native picker. */}
      <input
        ref={selfieInputRef}
        type="file"
        name="photo"
        accept="image/*"
        data-testid="photo-selfie-input"
        hidden
        // No onChange — this input is only written to via the
        // DataTransfer API from the selfie flow. If a user hits it
        // manually somehow, we still preview the file for parity.
        onChange={(e) => {
          const f = e.target.files?.[0] ?? null;
          setFilePreview(f);
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
          setFilePreview(f);
          if (f) clearOther(selfieInputRef.current);
        }}
      />

      <div className="flex flex-wrap items-center gap-3">
        <SelfieCaptureFlow onAccept={handleSelfieAccepted} />
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
        Up to 10 MB. JPG, PNG, HEIC, or WEBP. &ldquo;Take a selfie&rdquo; opens
        your camera in the browser — no separate app required.
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
