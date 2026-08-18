// HR-2B.2 (2026-08-18) — Photo upload input + client-side preview.
//
// The file input accepts `image/*` and captures the phone camera when
// available (`capture="user"` — mobile front camera as the default
// suggestion for a shoulders-up shot). Renders a local preview from
// the selected File so the employee sees WHAT they picked before
// clicking Upload. No network activity in this component — the
// preview URL is a client-only object URL and is revoked on unmount.

"use client";

import { useEffect, useRef, useState } from "react";

export default function PhotoUploadFields() {
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  return (
    <div className="space-y-4">
      <label className="block">
        <span className="block text-sm text-stone-700">Choose a photo</span>
        <input
          ref={inputRef}
          type="file"
          name="photo"
          accept="image/*"
          capture="user"
          required
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (!f) {
              setPreviewUrl(null);
              setSelectedName(null);
              return;
            }
            if (previewUrl) URL.revokeObjectURL(previewUrl);
            setPreviewUrl(URL.createObjectURL(f));
            setSelectedName(f.name);
          }}
          className="mt-2 block w-full text-sm text-stone-800 file:mr-4 file:rounded-md file:border-0 file:bg-stone-100 file:px-4 file:py-2 file:text-sm file:font-medium file:text-stone-800 hover:file:bg-stone-200"
        />
        <span className="mt-2 block text-xs text-stone-500">
          Up to 10 MB. JPG or PNG.
        </span>
      </label>

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
            <button
              type="button"
              onClick={() => {
                if (previewUrl) URL.revokeObjectURL(previewUrl);
                setPreviewUrl(null);
                setSelectedName(null);
                if (inputRef.current) inputRef.current.value = "";
              }}
              className="mt-1 text-xs text-stone-500 hover:text-stone-800 underline"
            >
              Choose a different photo
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
