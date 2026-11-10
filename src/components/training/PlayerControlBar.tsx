"use client";

// EP-TRAIN-4Y-AB §2 (2026-11-10) — shared training-video control bar.
//
// Extracted verbatim from the employee CoursePlayer's PlayerControlBar.
// All visual behaviour is preserved; the component now accepts optional
// callbacks and labels so the Manager Review surface can reuse the same
// primitive without duplicating the implementation.
//
// Manager-mode opt-ins (all optional, backwards-compatible):
//   - `markerLabels`:            `Record<checkpointId, string>` to show
//                                a numbered badge inside each marker.
//   - `onMarkerClick`:           invoked when a marker is clicked (via
//                                mouse or keyboard); when provided,
//                                each marker renders as a focusable
//                                <button>. Employee mode leaves this
//                                undefined so markers remain decorative
//                                indicators (the overlay / gating
//                                drives the UX, not direct clicks).
//   - `allowUnrestrictedSeek`:   when true, no clamp against
//                                `firstUnclearedRequiredAtSecond` (used
//                                in manager mode for content review).
//                                Employee mode omits it, preserving the
//                                existing seek-forward restriction.
//   - `activeMarkerId`:          id of the marker that should display
//                                the "active" state (filled green,
//                                scaled). Driven by the question-pane
//                                selection in manager mode.
//
// Employee mode (no manager-mode props passed) renders identically to
// the pre-AB PlayerControlBar — same styles, same testids, same ARIA.

import React, { useEffect, useRef, useState } from "react";

export interface PlayerCheckpointMarker {
  readonly id: string;
  readonly atSecond: number;
  readonly label?: string | null;
  readonly requiredToProceed?: boolean;
}

export interface PlayerControlBarProps {
  readonly videoRef: React.RefObject<HTMLVideoElement | null>;
  readonly sortedCheckpoints: readonly PlayerCheckpointMarker[];
  readonly cleared: ReadonlySet<string>;
  readonly videoDurationSec: number | null;
  /** Employee seek-forward clamp. Undefined / Infinity → no clamp.
   *  Manager mode passes `Number.POSITIVE_INFINITY`. */
  readonly firstUnclearedRequiredAtSecond: number;
  /** EP-TRAIN-4Y-AB §2: numbered-badge labels per marker.
   *  Employee mode omits this; manager mode passes `{cp.id: "1", …}`. */
  readonly markerLabels?: Readonly<Record<string, string>>;
  /** EP-TRAIN-4Y-AB §2: click-handler per marker. When present,
   *  markers render as focusable buttons. Keyboard Enter / Space
   *  also triggers. Employee mode omits this. */
  readonly onMarkerClick?: (checkpointId: string, atSecond: number) => void;
  /** EP-TRAIN-4Y-AB §2+§6: marker currently "selected" in the question
   *  pane. Rendered with the filled-green + slightly-scaled active
   *  treatment distinct from the "cleared" treatment. Employee mode
   *  omits this. */
  readonly activeMarkerId?: string | null;
  /** EP-TRAIN-4Y-AB §2: when true, `seekTo` does NOT clamp against
   *  `firstUnclearedRequiredAtSecond` even if a finite value is passed.
   *  Manager mode sets this to true for unrestricted content review. */
  readonly allowUnrestrictedSeek?: boolean;
}

export function PlayerControlBar(props: PlayerControlBarProps) {
  const {
    videoRef,
    sortedCheckpoints,
    cleared,
    videoDurationSec,
    firstUnclearedRequiredAtSecond,
    markerLabels,
    onMarkerClick,
    activeMarkerId,
    allowUnrestrictedSeek,
  } = props;

  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(
    videoDurationSec && videoDurationSec > 0 ? videoDurationSec : 0,
  );
  const [isPlaying, setIsPlaying] = useState(false);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(1);
  const seekBarRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const onTime = () => setCurrentTime(v.currentTime);
    const onMeta = () => {
      if (Number.isFinite(v.duration) && v.duration > 0) setDuration(v.duration);
    };
    const onPlay = () => setIsPlaying(true);
    const onPauseEvt = () => setIsPlaying(false);
    const onVol = () => {
      setVolume(v.volume);
      setMuted(v.muted);
    };
    const onRate = () => setPlaybackRate(v.playbackRate);
    v.addEventListener("timeupdate", onTime);
    v.addEventListener("loadedmetadata", onMeta);
    v.addEventListener("durationchange", onMeta);
    v.addEventListener("play", onPlay);
    v.addEventListener("pause", onPauseEvt);
    v.addEventListener("volumechange", onVol);
    v.addEventListener("ratechange", onRate);
    return () => {
      v.removeEventListener("timeupdate", onTime);
      v.removeEventListener("loadedmetadata", onMeta);
      v.removeEventListener("durationchange", onMeta);
      v.removeEventListener("play", onPlay);
      v.removeEventListener("pause", onPauseEvt);
      v.removeEventListener("volumechange", onVol);
      v.removeEventListener("ratechange", onRate);
    };
  }, [videoRef]);

  const safeDuration =
    duration > 0
      ? duration
      : videoDurationSec && videoDurationSec > 0
        ? videoDurationSec
        : 1;
  const playedPct = Math.min(100, Math.max(0, (currentTime / safeDuration) * 100));

  function togglePlay() {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) void v.play().catch(() => { /* autoplay rejection — ignore */ });
    else v.pause();
  }

  function seekTo(sec: number) {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = Math.max(0, Math.min(safeDuration, sec));
    // Employee mode: onSeeking attached on the <video> element clamps
    // against firstUnclearedRequiredAtSecond — markers CANNOT bypass
    // that gating. Manager mode's video element omits the onSeeking
    // clamp and passes allowUnrestrictedSeek=true (purely declarative
    // here — the actual enforcement lives on the <video>).
  }

  function onSeekBarClick(e: React.MouseEvent<HTMLDivElement>) {
    const bar = seekBarRef.current;
    if (!bar) return;
    const rect = bar.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    seekTo(pct * safeDuration);
  }

  function onSeekBarKey(e: React.KeyboardEvent<HTMLDivElement>) {
    const v = videoRef.current;
    if (!v) return;
    if (e.key === "ArrowRight") { e.preventDefault(); seekTo(v.currentTime + 5); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); seekTo(v.currentTime - 5); }
    else if (e.key === "Home") { e.preventDefault(); seekTo(0); }
    else if (e.key === "End") { e.preventDefault(); seekTo(safeDuration); }
    else if (e.key === " " || e.key === "Spacebar" || e.key === "k") { e.preventDefault(); togglePlay(); }
  }

  function setRate(r: number) {
    const v = videoRef.current;
    if (!v) return;
    v.playbackRate = r;
  }
  function toggleMute() {
    const v = videoRef.current;
    if (!v) return;
    v.muted = !v.muted;
  }
  function setVol(val: number) {
    const v = videoRef.current;
    if (!v) return;
    v.volume = Math.max(0, Math.min(1, val));
    if (val > 0 && v.muted) v.muted = false;
  }
  function toggleFullscreen() {
    const v = videoRef.current;
    if (!v) return;
    const container = v.parentElement;
    if (!document.fullscreenElement) {
      void (container ?? v).requestFullscreen?.().catch(() => { /* ignore */ });
    } else {
      void document.exitFullscreen?.().catch(() => { /* ignore */ });
    }
  }

  const total = sortedCheckpoints.length;
  const clearedCount = sortedCheckpoints.reduce(
    (n, cp) => (cleared.has(cp.id) ? n + 1 : n),
    0,
  );
  // Suppress the "N/N checkpoints cleared" footer in manager mode —
  // the "cleared" concept doesn't apply during content review. Manager
  // mode passes an empty Set; employee mode passes the real cleared
  // set. We key off `onMarkerClick` presence as the mode discriminator.
  const isManagerMode = typeof onMarkerClick === "function";
  const unrestrictedSeek = allowUnrestrictedSeek === true;
  // Documented intentional read — the enforcement happens on the
  // <video> element's onSeeking; the prop + helper above exist so a
  // future refactor can move the clamp into this component without a
  // breaking API change. Silences the unused-variable lint.
  void firstUnclearedRequiredAtSecond;
  void unrestrictedSeek;

  return (
    <div
      className="bg-stone-50 border-t border-stone-200 px-3 py-2 flex items-center gap-2 flex-wrap md:flex-nowrap"
      role="group"
      aria-label="Video playback controls"
      data-testid="portal-course-player-controls"
      data-player-mode={isManagerMode ? "manager" : "employee"}
    >
      <button
        type="button"
        onClick={togglePlay}
        className="shrink-0 w-9 h-9 rounded-full bg-club-green-700 hover:bg-club-green-800 text-white flex items-center justify-center focus:outline-none focus:ring-2 focus:ring-club-green-500"
        aria-label={isPlaying ? "Pause" : "Play"}
        data-testid="portal-course-player-playpause"
      >
        {isPlaying ? (
          <svg viewBox="0 0 20 20" className="w-4 h-4" fill="currentColor" aria-hidden><rect x="5" y="4" width="3" height="12" rx="1"/><rect x="12" y="4" width="3" height="12" rx="1"/></svg>
        ) : (
          <svg viewBox="0 0 20 20" className="w-4 h-4" fill="currentColor" aria-hidden><path d="M5 3l12 7-12 7V3z"/></svg>
        )}
      </button>
      <div className="shrink-0 text-xs text-stone-700 font-mono tabular-nums w-24" data-testid="portal-course-player-time">
        {formatMMSS(currentTime)} / {formatMMSS(safeDuration)}
      </div>
      <div
        ref={seekBarRef}
        onClick={onSeekBarClick}
        onKeyDown={onSeekBarKey}
        role="slider"
        tabIndex={0}
        aria-label="Seek"
        aria-valuemin={0}
        aria-valuemax={Math.round(safeDuration)}
        aria-valuenow={Math.round(currentTime)}
        aria-valuetext={`${formatMMSS(currentTime)} of ${formatMMSS(safeDuration)}`}
        className="relative flex-1 min-w-[180px] h-6 cursor-pointer focus:outline-none focus:ring-2 focus:ring-club-green-500 rounded"
        data-testid="portal-course-player-seek"
      >
        {/* Base track */}
        <div className="absolute inset-x-0 top-1/2 -translate-y-1/2 h-1 rounded-full bg-stone-300" aria-hidden />
        {/* Played portion */}
        <div
          className="absolute left-0 top-1/2 -translate-y-1/2 h-1 rounded-full bg-club-green-700"
          style={{ width: `${playedPct}%` }}
          aria-hidden
        />
        {/* Checkpoint markers overlaid on the SAME timeline */}
        {sortedCheckpoints.map((cp, i) => {
          const left = Math.min(100, Math.max(0, (cp.atSecond / safeDuration) * 100));
          const isCleared = cleared.has(cp.id);
          const isActive = activeMarkerId === cp.id;
          const mins = Math.floor(cp.atSecond / 60);
          const secs = Math.floor(cp.atSecond % 60);
          const timeLabel = `${mins}:${secs.toString().padStart(2, "0")}`;
          const statusLabel = isActive
            ? "selected"
            : isCleared
              ? "completed"
              : cp.requiredToProceed
                ? "upcoming (required)"
                : "upcoming";
          // Marker sizing: badged (numbered) markers are bigger so the
          // label stays legible. Unbadged (employee-mode) markers keep
          // their original 12px size to preserve visual parity.
          const badge = markerLabels?.[cp.id];
          const dotSize = badge ? "w-5 h-5 text-[10px] font-semibold font-mono" : "w-3 h-3";
          const classes = isActive
            ? "bg-club-green-700 border-club-green-800 text-white shadow"
            : isCleared
              ? "bg-club-green-700 border-club-green-800 text-white"
              : cp.requiredToProceed
                ? "bg-amber-400 border-amber-600"
                : "bg-white border-stone-500 text-stone-700";
          const label = `Checkpoint ${i + 1} of ${total} at ${timeLabel}, ${statusLabel}`;
          const title = `Checkpoint ${i + 1} at ${timeLabel} — ${statusLabel}`;
          const sharedClassName = `absolute top-1/2 -translate-y-1/2 -translate-x-1/2 ${dotSize} rounded-full border-2 ${classes} flex items-center justify-center transition-transform`;
          if (onMarkerClick) {
            return (
              <button
                key={cp.id}
                type="button"
                onClick={(e) => { e.stopPropagation(); onMarkerClick(cp.id, cp.atSecond); }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onMarkerClick(cp.id, cp.atSecond);
                  }
                }}
                aria-label={label}
                title={title}
                data-testid={`portal-course-checkpoint-marker-${cp.id}`}
                data-checkpoint-status={isActive ? "active" : isCleared ? "completed" : "upcoming"}
                className={`${sharedClassName} focus:outline-none focus:ring-2 focus:ring-offset-1 focus:ring-club-green-500 hover:scale-110 ${isActive ? "scale-110" : ""}`}
                style={{ left: `${left}%` }}
              >
                {badge ? <span className="leading-none">{badge}</span> : null}
              </button>
            );
          }
          return (
            <span
              key={cp.id}
              className={`${sharedClassName} shadow-sm`}
              style={{ left: `${left}%` }}
              role="img"
              aria-label={label}
              title={title}
              data-testid={`portal-course-checkpoint-marker-${cp.id}`}
              data-checkpoint-status={isCleared ? "completed" : "upcoming"}
            >
              {badge ? <span className="leading-none">{badge}</span> : null}
            </span>
          );
        })}
        {/* Playhead knob */}
        <span
          className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-3.5 h-3.5 rounded-full bg-white border-2 border-club-green-700 shadow"
          style={{ left: `${playedPct}%` }}
          aria-hidden
        />
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <button
          type="button"
          onClick={toggleMute}
          className="w-8 h-8 rounded hover:bg-stone-200 flex items-center justify-center text-stone-700 focus:outline-none focus:ring-2 focus:ring-club-green-500"
          aria-label={muted || volume === 0 ? "Unmute" : "Mute"}
          data-testid="portal-course-player-mute"
        >
          {muted || volume === 0 ? (
            <svg viewBox="0 0 20 20" className="w-4 h-4" fill="currentColor" aria-hidden><path d="M3 7v6h3l5 4V3L6 7H3zm11.59 1.41L13.17 10l1.42 1.59L13.17 13l-1.58-1.59L10 13.17 11.59 11.59 10 10.17l1.59-1.58L10 7l1.59 1.59L13.17 7l1.42 1.41z"/></svg>
          ) : (
            <svg viewBox="0 0 20 20" className="w-4 h-4" fill="currentColor" aria-hidden><path d="M3 7v6h3l5 4V3L6 7H3zm13 3a4 4 0 00-2-3.46v6.92A4 4 0 0016 10z"/></svg>
          )}
        </button>
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={muted ? 0 : volume}
          onChange={(e) => setVol(parseFloat(e.target.value))}
          className="w-16 accent-club-green-700"
          aria-label="Volume"
          data-testid="portal-course-player-volume"
        />
      </div>
      <select
        value={playbackRate.toString()}
        onChange={(e) => setRate(parseFloat(e.target.value))}
        className="shrink-0 text-xs rounded border border-stone-300 bg-white px-2 py-1 focus:outline-none focus:ring-2 focus:ring-club-green-500"
        aria-label="Playback speed"
        data-testid="portal-course-player-rate"
      >
        <option value="1">1x</option>
        <option value="1.25">1.25x</option>
        <option value="1.5">1.5x</option>
        <option value="2">2x</option>
      </select>
      <button
        type="button"
        onClick={toggleFullscreen}
        className="shrink-0 w-8 h-8 rounded hover:bg-stone-200 flex items-center justify-center text-stone-700 focus:outline-none focus:ring-2 focus:ring-club-green-500"
        aria-label="Toggle fullscreen"
        data-testid="portal-course-player-fullscreen"
      >
        <svg viewBox="0 0 20 20" className="w-4 h-4" fill="currentColor" aria-hidden><path d="M3 3h5v2H5v3H3V3zm9 0h5v5h-2V5h-3V3zM3 12h2v3h3v2H3v-5zm14 0v5h-5v-2h3v-3h2z"/></svg>
      </button>
      {total > 0 && !isManagerMode && (
        <span
          className="shrink-0 text-[11px] text-stone-600 tabular-nums whitespace-nowrap"
          data-testid="portal-course-checkpoint-count"
          aria-label={`${clearedCount} of ${total} checkpoints cleared`}
        >
          {clearedCount} / {total} checkpoints
        </span>
      )}
    </div>
  );
}

export function formatMMSS(totalSec: number): string {
  if (!Number.isFinite(totalSec) || totalSec < 0) return "0:00";
  const m = Math.floor(totalSec / 60);
  const s = Math.floor(totalSec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}
