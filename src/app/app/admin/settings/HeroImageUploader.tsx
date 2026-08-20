"use client";

// HR-2C §2-4 (2026-08-20) — Employee Portal hero image uploader.
//
// Standalone client component (no server-action wrap) — POSTs a
// multipart form to `/api/clubs/[id]/employee-portal-hero`, which
// delegates to canonical `setClubMedia`. Provides:
//   • current-image preview + replace + remove
//   • drag-and-drop OR file picker (browser-native, no library)
//   • MIME/size validation before upload (server re-validates)
//   • inline error surface
//   • cache-buster on the preview so the replaced image appears
//     immediately
//
// Renders the branded gradient fallback preview when no asset is set
// so admins see what the employee sees before uploading.

import { useState, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";

interface Props {
  clubId: string;
  /** True when a ClubMedia row exists on load. Client state
   *  supersedes this after upload/remove actions. */
  initiallyHasImage: boolean;
  /** Cache-buster on the current image URL (typically the row's
   *  sha256 or uploadedAt). */
  initialVersion: string | null;
  /** Club primary color for the fallback gradient preview. */
  primaryColor: string;
}

const ACCEPTED_MIME = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
];
const MAX_BYTES = 10 * 1024 * 1024;
const ACCEPTED_HINT = "JPEG, PNG or WEBP · max 10 MB";

export default function HeroImageUploader({
  clubId,
  initiallyHasImage,
  initialVersion,
  primaryColor,
}: Props) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [hasImage, setHasImage] = useState(initiallyHasImage);
  const [version, setVersion] = useState<string | null>(initialVersion);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);

  const handleFile = useCallback(async (file: File) => {
    setError(null);
    if (!ACCEPTED_MIME.includes(file.type)) {
      setError("Image must be JPEG, PNG, or WEBP.");
      return;
    }
    if (file.size === 0) {
      setError("Image file is empty.");
      return;
    }
    if (file.size > MAX_BYTES) {
      setError(`Image exceeds ${MAX_BYTES / (1024 * 1024)} MB limit.`);
      return;
    }
    setBusy(true);
    try {
      const fd = new FormData();
      fd.set("image", file);
      const res = await fetch(`/api/clubs/${clubId}/employee-portal-hero`, {
        method: "POST",
        body: fd,
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setError(data.error ?? "Upload failed.");
        setBusy(false);
        return;
      }
      const data = (await res.json()) as { id: string; uploadedAt: string };
      setHasImage(true);
      setVersion(data.uploadedAt);
      router.refresh();
    } catch {
      setError("Network error — please try again.");
    } finally {
      setBusy(false);
    }
  }, [clubId, router]);

  const handleRemove = useCallback(async () => {
    setError(null);
    setBusy(true);
    try {
      const res = await fetch(`/api/clubs/${clubId}/employee-portal-hero`, {
        method: "DELETE",
      });
      if (!res.ok) {
        setError("Could not remove the image.");
        return;
      }
      setHasImage(false);
      setVersion(null);
      router.refresh();
    } catch {
      setError("Network error — please try again.");
    } finally {
      setBusy(false);
    }
  }, [clubId, router]);

  const brand = primaryColor?.trim() || "#2f5832";
  const fallbackStyle = {
    background: `linear-gradient(135deg, ${brand} 0%, ${darken(brand, 22)} 100%)`,
  };

  const heroUrl = hasImage
    ? `/api/clubs/${clubId}/employee-portal-hero${version ? `?v=${encodeURIComponent(version)}` : ""}`
    : null;

  return (
    <div className="space-y-4" data-testid="hero-uploader">
      {/* Live preview at the same aspect the employee sees */}
      <div
        className="relative overflow-hidden rounded-lg border border-stone-200 h-48 md:h-56"
        style={heroUrl ? undefined : fallbackStyle}
        data-testid="hero-uploader-preview"
        data-has-image={hasImage ? "true" : "false"}
      >
        {heroUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={heroUrl} alt="Current hero" className="absolute inset-0 h-full w-full object-cover" />
        )}
        {!hasImage && (
          <div className="absolute inset-0 flex items-center justify-center">
            <p className="text-white/80 text-sm">
              No photograph set — employees see a branded gradient.
            </p>
          </div>
        )}
      </div>

      {/* Drop zone + file picker */}
      <div
        className={
          "rounded-md border border-dashed px-4 py-6 text-center cursor-pointer " +
          (dragOver ? "border-emerald-500 bg-emerald-50/60" : "border-stone-300 hover:border-stone-400")
        }
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          const file = e.dataTransfer.files?.[0];
          if (file) void handleFile(file);
        }}
        onClick={() => inputRef.current?.click()}
        data-testid="hero-uploader-dropzone"
      >
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPTED_MIME.join(",")}
          className="sr-only"
          data-testid="hero-uploader-input"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void handleFile(file);
            e.target.value = "";
          }}
        />
        <p className="text-sm text-stone-700">
          {busy ? "Uploading…" : hasImage ? "Drop a new photograph, or click to browse" : "Drop a photograph here, or click to browse"}
        </p>
        <p className="mt-1 text-xs text-stone-500">{ACCEPTED_HINT}</p>
      </div>

      {error && (
        <p role="alert" className="text-sm text-red-700" data-testid="hero-uploader-error">
          {error}
        </p>
      )}

      {hasImage && (
        <div className="flex items-center justify-end">
          <button
            type="button"
            onClick={handleRemove}
            disabled={busy}
            className="text-xs text-stone-500 hover:text-red-700 underline underline-offset-4"
            data-testid="hero-uploader-remove"
          >
            Remove current photograph
          </button>
        </div>
      )}
    </div>
  );
}

function darken(hex: string, percent: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1]!, 16);
  const r = Math.max(0, Math.floor(((n >> 16) & 0xff) * (1 - percent / 100)));
  const g = Math.max(0, Math.floor(((n >> 8) & 0xff) * (1 - percent / 100)));
  const b = Math.max(0, Math.floor((n & 0xff) * (1 - percent / 100)));
  return "#" + ((r << 16) | (g << 8) | b).toString(16).padStart(6, "0");
}
