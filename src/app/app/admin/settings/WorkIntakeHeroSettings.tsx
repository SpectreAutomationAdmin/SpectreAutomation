"use client";

// WI-1D — Work Intake hero settings.
//
// Tenant-scoped controls that mirror the ClubMedia contract used by
// the Employee Portal hero. Delegates to:
//   POST   /api/clubs/[id]/work-intake-hero          — upload / replace
//   DELETE /api/clubs/[id]/work-intake-hero          — reset to Spectre default
//   POST   /api/clubs/[id]/work-intake-hero/framing  — persist focal + zoom
//
// Uses the "simple slider" fallback from §16 for the focal position
// so the founder can control the crop without a heavy drag library.
// The preview above the sliders renders at the SAME aspect ratio as
// the actual Work Intake hero (906 × 225 window → 4.03:1) so the
// admin sees exactly what will land on staging.

import { useState, useRef } from "react";
import { useRouter } from "next/navigation";

interface Props {
  clubId: string;
  initialHasImage: boolean;
  initialVersion: string | null;
  initialFocalX: number; // 0..100
  initialFocalY: number; // 0..100
}

export default function WorkIntakeHeroSettings({
  clubId,
  initialHasImage,
  initialVersion,
  initialFocalX,
  initialFocalY,
}: Props) {
  const router = useRouter();
  const [hasImage, setHasImage] = useState(initialHasImage);
  const [version, setVersion] = useState<string | null>(initialVersion);
  const [focalX, setFocalX] = useState(initialFocalX);
  const [focalY, setFocalY] = useState(initialFocalY);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const previewSrc = hasImage
    ? `/api/clubs/${clubId}/work-intake-hero${version ? `?v=${encodeURIComponent(version)}` : ""}`
    : "/marketing/photography/responsive/spectre-clubhouse-1440.jpg";

  async function onUpload(file: File) {
    setErr(null); setBusy(true);
    try {
      const fd = new FormData();
      fd.append("image", file);
      const res = await fetch(`/api/clubs/${clubId}/work-intake-hero`, { method: "POST", body: fd });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error || "Upload failed");
      setHasImage(true);
      setVersion(String(body.uploadedAt ?? Date.now()));
      setSavedAt(new Date().toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }));
      router.refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setBusy(false);
    }
  }

  async function onRemove() {
    setErr(null); setBusy(true);
    try {
      const res = await fetch(`/api/clubs/${clubId}/work-intake-hero`, { method: "DELETE" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error || "Remove failed");
      setHasImage(false); setVersion(null);
      setFocalX(50); setFocalY(50);
      router.refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Remove failed");
    } finally {
      setBusy(false);
    }
  }

  async function saveFraming(nextX: number, nextY: number) {
    if (!hasImage) return;
    setErr(null); setBusy(true);
    try {
      const res = await fetch(`/api/clubs/${clubId}/work-intake-hero/framing`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "desktop",
          desktop: { focalX: nextX, focalY: nextY, zoom: 1 },
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error || "Save failed");
      setSavedAt(new Date().toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }));
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      {/* Live preview at the same aspect ratio as the Work Intake hero */}
      <div
        style={{
          width: "100%",
          aspectRatio: "906 / 225",
          borderRadius: 10,
          overflow: "hidden",
          background: "#1a1712",
          position: "relative",
          marginBottom: 16,
          border: "1px solid var(--spectre-border-hairline)",
        }}
      >
        <img
          src={previewSrc}
          alt="Work Intake hero preview"
          style={{
            width: "100%",
            height: "100%",
            objectFit: "cover",
            objectPosition: `${focalX}% ${focalY}%`,
            display: "block",
          }}
        />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 16 }}>
        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={{ fontSize: 12, color: "var(--spectre-text-secondary)" }}>Horizontal focus · {Math.round(focalX)}%</span>
          <input
            type="range" min="0" max="100" step="1"
            value={focalX}
            onChange={(e) => setFocalX(Number(e.target.value))}
            onMouseUp={() => saveFraming(focalX, focalY)}
            onTouchEnd={() => saveFraming(focalX, focalY)}
            disabled={!hasImage || busy}
          />
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={{ fontSize: 12, color: "var(--spectre-text-secondary)" }}>Vertical focus · {Math.round(focalY)}%</span>
          <input
            type="range" min="0" max="100" step="1"
            value={focalY}
            onChange={(e) => setFocalY(Number(e.target.value))}
            onMouseUp={() => saveFraming(focalX, focalY)}
            onTouchEnd={() => saveFraming(focalX, focalY)}
            disabled={!hasImage || busy}
          />
        </label>
      </div>

      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <input
          ref={fileRef}
          type="file"
          accept="image/jpeg,image/png,image/webp,image/heic,image/heif"
          style={{ display: "none" }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onUpload(f);
          }}
        />
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={busy}
          className="spectre-btn spectre-btn--primary"
        >
          {hasImage ? "Replace image" : "Upload image"}
        </button>
        {hasImage && (
          <button
            type="button"
            onClick={onRemove}
            disabled={busy}
            className="spectre-btn spectre-btn--secondary"
          >
            Remove — restore default
          </button>
        )}
        {savedAt && (
          <span style={{ fontSize: 12, color: "var(--spectre-status-success)" }}>Saved · {savedAt}</span>
        )}
        {err && (
          <span style={{ fontSize: 12, color: "var(--spectre-status-error)" }}>{err}</span>
        )}
      </div>
      <p style={{ fontSize: 12, color: "var(--spectre-text-muted)", marginTop: 12 }}>
        JPEG, PNG, WEBP, HEIC or HEIF. Up to 10 MiB. The image window on Work Intake is fixed —
        only the focal position changes with these sliders.
      </p>
    </div>
  );
}
