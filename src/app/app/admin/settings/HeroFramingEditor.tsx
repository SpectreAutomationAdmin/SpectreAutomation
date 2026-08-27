"use client";

// HR portal hero framing editor (2026-08-26) — Admin Settings client
// component. Renders the same live hero preview as the Employee
// Portal (uses the shared `heroImageStyle()` helper) so Admin
// preview and portal render can never drift apart. Independent
// Desktop and Mobile tabs with drag-to-position and a zoom slider.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  clampHeroFraming,
  DEFAULT_HERO_FRAMING,
  HERO_FRAMING_BOUNDS,
  heroImageStyle,
  type EmployeePortalHeroFraming,
  type HeroFraming,
  type HeroFramingMode,
} from "@/lib/employee-portal/hero-framing";

interface Props {
  clubId: string;
  imageUrl: string | null;
  initialFraming: EmployeePortalHeroFraming;
}

const MODE_LABEL: Record<HeroFramingMode, string> = {
  desktop: "Desktop",
  mobile: "Mobile",
};

// Preview aspect ratios that match the actual portal containers.
// Desktop: `clamp(170px, 21vh, 260px)` inside a full-width column at
//   ~1200 px wide → roughly 6:1 aspect at 1536×864 (or 4:1 at 1080p).
// Mobile:  `clamp(150px, 22dvh, 215px)` inside a ~390 px column →
//   roughly 2:1 aspect.
const MODE_ASPECT: Record<HeroFramingMode, number> = {
  desktop: 5.5,
  mobile: 2,
};

export default function HeroFramingEditor({ clubId, imageUrl, initialFraming }: Props) {
  const [mode, setMode] = useState<HeroFramingMode>("desktop");
  const [framing, setFraming] = useState<EmployeePortalHeroFraming>(initialFraming);
  const [savedFraming, setSavedFraming] = useState<EmployeePortalHeroFraming>(initialFraming);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<{ tone: "idle" | "ok" | "err"; text: string }>({ tone: "idle", text: "" });

  const active = framing[mode];
  const isDirty = useMemo(
    () => JSON.stringify(framing) !== JSON.stringify(savedFraming),
    [framing, savedFraming],
  );

  const setActive = useCallback(
    (next: Partial<HeroFraming>) => {
      setFraming((prev) => ({
        ...prev,
        [mode]: clampHeroFraming({ ...prev[mode], ...next }),
      }));
    },
    [mode],
  );

  // ---------------------------------------------------------------
  // Pointer drag — translates cursor position within the preview
  // frame into normalized focal X/Y. Constrained so the image cannot
  // reveal blank canvas: focalX/Y are always clamped to 0..1 by the
  // shared helper.
  // ---------------------------------------------------------------
  const previewRef = useRef<HTMLDivElement | null>(null);
  const [dragging, setDragging] = useState(false);
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!imageUrl) return;
    const el = previewRef.current;
    if (!el) return;
    (e.target as Element).setPointerCapture(e.pointerId);
    setDragging(true);
    applyPointer(e.clientX, e.clientY, el);
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    const el = previewRef.current;
    if (!el) return;
    applyPointer(e.clientX, e.clientY, el);
  };
  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    try { (e.target as Element).releasePointerCapture(e.pointerId); } catch { /* noop */ }
    setDragging(false);
  };
  const applyPointer = (clientX: number, clientY: number, el: HTMLDivElement) => {
    const rect = el.getBoundingClientRect();
    const focalX = (clientX - rect.left) / rect.width;
    const focalY = (clientY - rect.top) / rect.height;
    setActive({ focalX, focalY });
  };

  // ---------------------------------------------------------------
  // Save + reset actions — hit the canonical server route so
  // authorization + audit flow through `updateClubMediaFraming`.
  // ---------------------------------------------------------------
  const save = async () => {
    setSaving(true);
    setStatus({ tone: "idle", text: "" });
    try {
      const res = await fetch(`/api/clubs/${clubId}/employee-portal-hero/framing`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "both", desktop: framing.desktop, mobile: framing.mobile }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { framing: EmployeePortalHeroFraming };
      setSavedFraming(body.framing);
      setFraming(body.framing);
      setStatus({ tone: "ok", text: "Framing saved." });
    } catch (err) {
      setStatus({ tone: "err", text: (err as Error).message ?? "Save failed." });
    } finally {
      setSaving(false);
    }
  };

  const resetMode = async () => {
    setSaving(true);
    setStatus({ tone: "idle", text: "" });
    try {
      const res = await fetch(`/api/clubs/${clubId}/employee-portal-hero/framing`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { framing: EmployeePortalHeroFraming };
      setSavedFraming(body.framing);
      setFraming(body.framing);
      setStatus({ tone: "ok", text: `${MODE_LABEL[mode]} framing reset.` });
    } catch (err) {
      setStatus({ tone: "err", text: (err as Error).message ?? "Reset failed." });
    } finally {
      setSaving(false);
    }
  };

  useEffect(() => {
    if (status.tone === "idle") return;
    const t = setTimeout(() => setStatus({ tone: "idle", text: "" }), 4000);
    return () => clearTimeout(t);
  }, [status]);

  const previewStyle = heroImageStyle(active);
  const aspect = MODE_ASPECT[mode];

  return (
    <div className="space-y-4" data-testid="hero-framing-editor">
      {/* Mode tabs */}
      <div className="flex items-center gap-2" role="tablist" aria-label="Framing mode">
        {(Object.keys(MODE_LABEL) as HeroFramingMode[]).map((m) => (
          <button
            key={m}
            type="button"
            role="tab"
            aria-selected={mode === m}
            data-testid={`hero-framing-tab-${m}`}
            onClick={() => setMode(m)}
            className={
              "px-4 py-2 rounded-md text-sm border transition-colors " +
              (mode === m
                ? "bg-club-green-800 text-white border-club-green-800"
                : "bg-white text-club-ink border-stone-300 hover:bg-stone-50")
            }
          >
            {MODE_LABEL[m]}
          </button>
        ))}
      </div>

      {/* Live preview — identical CSS to the portal hero. */}
      <div
        ref={previewRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        className={
          "relative w-full overflow-hidden rounded-lg border border-stone-200 bg-stone-100 " +
          (imageUrl ? (dragging ? "cursor-grabbing" : "cursor-grab") : "cursor-not-allowed")
        }
        style={{ aspectRatio: `${aspect} / 1` }}
        data-testid={`hero-framing-preview-${mode}`}
        data-mode={mode}
      >
        {imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={imageUrl}
            alt="Employee Portal hero preview"
            className="absolute inset-0 h-full w-full pointer-events-none select-none"
            style={previewStyle}
            draggable={false}
            data-testid={`hero-framing-preview-image-${mode}`}
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center text-sm text-stone-500">
            Upload an Employee Portal hero image above to enable framing.
          </div>
        )}
        {/* Representative overlay so admin sees what will sit on top. */}
        <div className="absolute inset-0 pointer-events-none flex flex-col justify-end p-4">
          <p className="font-serif text-2xl text-white drop-shadow-sm">Good evening, Chris</p>
          <div className="flex items-center gap-2 mt-1 text-white/95">
            <span aria-hidden="true" className="h-px w-8 bg-white/75" />
            <span className="text-[10px] tracking-[0.32em]">EMPLOYEE PORTAL</span>
          </div>
        </div>
      </div>

      {/* Numeric readouts + accessible nudge controls */}
      <div className="grid grid-cols-2 gap-4 text-sm text-club-ink">
        <label className="space-y-1">
          <span>Zoom</span>
          <input
            type="range"
            min={HERO_FRAMING_BOUNDS.zoomMin}
            max={HERO_FRAMING_BOUNDS.zoomMax}
            step="0.01"
            value={active.zoom}
            onChange={(e) => setActive({ zoom: Number(e.target.value) })}
            className="w-full"
            data-testid={`hero-framing-zoom-${mode}`}
          />
          <div className="text-xs text-stone-500 tabular-nums">
            {active.zoom.toFixed(2)}× — X {(active.focalX * 100).toFixed(1)}% · Y {(active.focalY * 100).toFixed(1)}%
          </div>
        </label>
        <div className="flex items-end justify-end gap-2">
          <button
            type="button"
            onClick={resetMode}
            disabled={saving}
            className="text-sm underline text-stone-600 hover:text-club-ink disabled:opacity-40"
            data-testid={`hero-framing-reset-${mode}`}
          >
            Reset {MODE_LABEL[mode]} to default
          </button>
          <button
            type="button"
            onClick={save}
            disabled={saving || !isDirty}
            className="spectre-btn spectre-btn-primary"
            data-testid="hero-framing-save"
          >
            {saving ? "Saving…" : "Save framing"}
          </button>
        </div>
      </div>

      {/* X / Y nudge — keyboard-accessible alternative to drag. */}
      <div className="grid grid-cols-2 gap-4 text-sm">
        <label className="space-y-1">
          <span className="text-club-ink">Horizontal focal (%)</span>
          <input
            type="number" min={0} max={100} step="1"
            value={Math.round(active.focalX * 100)}
            onChange={(e) => setActive({ focalX: Number(e.target.value) / 100 })}
            className="spectre-input w-24"
            data-testid={`hero-framing-focal-x-${mode}`}
          />
        </label>
        <label className="space-y-1">
          <span className="text-club-ink">Vertical focal (%)</span>
          <input
            type="number" min={0} max={100} step="1"
            value={Math.round(active.focalY * 100)}
            onChange={(e) => setActive({ focalY: Number(e.target.value) / 100 })}
            className="spectre-input w-24"
            data-testid={`hero-framing-focal-y-${mode}`}
          />
        </label>
      </div>

      {status.text && (
        <div
          className={
            "text-sm " +
            (status.tone === "ok" ? "text-emerald-700" : status.tone === "err" ? "text-red-700" : "text-stone-500")
          }
          role={status.tone === "err" ? "alert" : "status"}
          data-testid="hero-framing-status"
        >
          {status.text}
        </div>
      )}

      <p className="text-xs text-stone-500">
        Default: {DEFAULT_HERO_FRAMING.focalX * 100}% × {DEFAULT_HERO_FRAMING.focalY * 100}% at {DEFAULT_HERO_FRAMING.zoom}× —
        this is the current Spectre behavior. Reset returns the selected mode to that centered crop; the other mode is
        untouched.
      </p>
    </div>
  );
}
