// AP-MOTION-1 (2026-10-13) — deterministic scene playback.
//
// Advances the scene index on an interval ONLY while `playing` is
// true.  Manual navigation (next / prev / replay / go-to) pauses
// auto-advance so the founder can inspect any single scene without
// the clock running out.
//
// Honours `prefers-reduced-motion` — when set, auto-play still
// works but the per-scene CSS transitions collapse to zero.

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { SCENE_INTERVAL_MS } from "./scenes";

export interface ScenePlaybackState {
  index: number;
  total: number;
  playing: boolean;
  play: () => void;
  pause: () => void;
  replay: () => void;
  next: () => void;
  prev: () => void;
  goTo: (i: number) => void;
}

export function useScenePlayback(total: number): ScenePlaybackState {
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clear = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (!playing) return;
    if (index >= total - 1) {
      setPlaying(false);
      return;
    }
    timerRef.current = setTimeout(() => {
      setIndex((i) => Math.min(i + 1, total - 1));
    }, SCENE_INTERVAL_MS);
    return () => clear();
  }, [playing, index, total, clear]);

  const play = useCallback(() => {
    if (index >= total - 1) setIndex(0);
    setPlaying(true);
  }, [index, total]);
  const pause = useCallback(() => {
    clear();
    setPlaying(false);
  }, [clear]);
  const replay = useCallback(() => {
    clear();
    setIndex(0);
    setPlaying(true);
  }, [clear]);
  const next = useCallback(() => {
    clear();
    setPlaying(false);
    setIndex((i) => Math.min(i + 1, total - 1));
  }, [clear, total]);
  const prev = useCallback(() => {
    clear();
    setPlaying(false);
    setIndex((i) => Math.max(i - 1, 0));
  }, [clear]);
  const goTo = useCallback(
    (i: number) => {
      clear();
      setPlaying(false);
      setIndex(Math.min(Math.max(i, 0), total - 1));
    },
    [clear, total],
  );

  return { index, total, playing, play, pause, replay, next, prev, goTo };
}
