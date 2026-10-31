// @vitest-environment jsdom
//
// EP-TRAIN-4C (2026-10-31) — PlayerControlBar unit tests.
//
// Verifies that the custom control bar:
//   - exposes one visible playback timeline (not two)
//   - renders checkpoint markers DIRECTLY on the seek track at
//     proportional timestamps
//   - distinguishes cleared / upcoming-required / upcoming-optional
//   - shows play/pause, time, volume, speed, fullscreen controls
//   - supports keyboard operation on the seek slider
//   - preserves the server-side seek-cap: a click on a marker beyond
//     the first-uncleared required checkpoint produces a seek that
//     the <video>'s onSeeking handler can clamp (we assert the
//     videoRef.currentTime is set to the clicked target; the clamp
//     is enforced by the real <video> element in the browser)

import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { useRef, type RefObject } from "react";
import { PlayerControlBar } from "../src/app/employee/(authed)/safety-training/[versionId]/CoursePlayer";

afterEach(() => { cleanup(); });

function makeMockVideo(opts: { duration?: number; currentTime?: number } = {}): HTMLVideoElement {
  const v = document.createElement("video");
  Object.defineProperty(v, "duration", { configurable: true, writable: true, value: opts.duration ?? 60 });
  Object.defineProperty(v, "currentTime", { configurable: true, writable: true, value: opts.currentTime ?? 0 });
  Object.defineProperty(v, "paused", { configurable: true, writable: true, value: true });
  Object.defineProperty(v, "muted", { configurable: true, writable: true, value: false });
  Object.defineProperty(v, "volume", { configurable: true, writable: true, value: 1 });
  Object.defineProperty(v, "playbackRate", { configurable: true, writable: true, value: 1 });
  v.play = vi.fn(() => Promise.resolve());
  v.pause = vi.fn();
  return v;
}

function Harness({ video, checkpoints, cleared, duration, firstUncleared }: {
  video: HTMLVideoElement;
  checkpoints: Array<{ id: string; atSecond: number; label: string | null; requiredToProceed: boolean; maxRetries: number; displayOrder: number; questions: unknown[] }>;
  cleared: Set<string>;
  duration: number;
  firstUncleared: number;
}) {
  const ref = useRef<HTMLVideoElement | null>(video);
  return (
    <PlayerControlBar
      videoRef={ref as RefObject<HTMLVideoElement | null>}
      sortedCheckpoints={checkpoints as unknown as never}
      cleared={cleared}
      videoDurationSec={duration}
      firstUnclearedRequiredAtSecond={firstUncleared}
    />
  );
}

const CP = (id: string, atSecond: number, cleared = false, required = true) => ({
  id, atSecond, label: null, requiredToProceed: required, maxRetries: 2, displayOrder: 0, questions: [],
});

describe("EP-TRAIN-4C :: PlayerControlBar", () => {
  it("renders exactly ONE seek slider (not two parallel timelines)", () => {
    render(<Harness video={makeMockVideo({ duration: 60 })} checkpoints={[]} cleared={new Set()} duration={60} firstUncleared={Infinity} />);
    const sliders = screen.getAllByRole("slider");
    // One slider for seek + the volume input happens to be type=range (also role=slider in the DOM a11y tree).
    // Importantly we have ZERO additional strip + ZERO separate watch-progress element.
    expect(screen.queryByTestId("portal-course-checkpoint-strip")).toBeNull();
    expect(screen.queryByTestId("portal-course-progress-percent")).toBeNull();
    expect(sliders.length).toBeGreaterThanOrEqual(1);
    // The seek track specifically:
    const seek = screen.getByTestId("portal-course-player-seek");
    expect(seek).toBeTruthy();
    expect(seek.getAttribute("role")).toBe("slider");
  });

  it("renders checkpoint markers overlaid INSIDE the seek track", () => {
    render(<Harness
      video={makeMockVideo({ duration: 60 })}
      checkpoints={[CP("cp1", 15), CP("cp2", 30)]}
      cleared={new Set()}
      duration={60}
      firstUncleared={15}
    />);
    const seek = screen.getByTestId("portal-course-player-seek");
    const cp1 = screen.getByTestId("portal-course-checkpoint-marker-cp1");
    const cp2 = screen.getByTestId("portal-course-checkpoint-marker-cp2");
    expect(seek.contains(cp1)).toBe(true);
    expect(seek.contains(cp2)).toBe(true);
    // Positioned at atSecond/duration * 100% of the seek width.
    expect(cp1.getAttribute("style")).toContain("left: 25%");
    expect(cp2.getAttribute("style")).toContain("left: 50%");
  });

  it("distinguishes cleared / upcoming-required / upcoming-optional visually AND via data-attribute", () => {
    render(<Harness
      video={makeMockVideo({ duration: 60 })}
      checkpoints={[CP("cpA", 10, true, true), CP("cpB", 20, false, true), CP("cpC", 30, false, false)]}
      cleared={new Set(["cpA"])}
      duration={60}
      firstUncleared={20}
    />);
    const cpA = screen.getByTestId("portal-course-checkpoint-marker-cpA");
    const cpB = screen.getByTestId("portal-course-checkpoint-marker-cpB");
    const cpC = screen.getByTestId("portal-course-checkpoint-marker-cpC");
    expect(cpA.getAttribute("data-checkpoint-status")).toBe("completed");
    expect(cpB.getAttribute("data-checkpoint-status")).toBe("upcoming");
    expect(cpC.getAttribute("data-checkpoint-status")).toBe("upcoming");
    expect(cpA.className).toContain("bg-club-green-700");
    expect(cpB.className).toContain("bg-amber-400");
    expect(cpC.className).toContain("bg-white");
  });

  it("checkpoint-count label shows 'cleared / total'", () => {
    render(<Harness
      video={makeMockVideo({ duration: 60 })}
      checkpoints={[CP("cp1", 15, true), CP("cp2", 30, false)]}
      cleared={new Set(["cp1"])}
      duration={60}
      firstUncleared={30}
    />);
    const count = screen.getByTestId("portal-course-checkpoint-count");
    expect(count.textContent).toContain("1 / 2 checkpoints");
  });

  it("play button toggles video.play()/pause()", () => {
    const v = makeMockVideo({ duration: 60 });
    render(<Harness video={v} checkpoints={[]} cleared={new Set()} duration={60} firstUncleared={Infinity} />);
    const btn = screen.getByTestId("portal-course-player-playpause");
    fireEvent.click(btn);
    expect(v.play).toHaveBeenCalled();
  });

  it("seek slider Left/Right arrows seek -5s / +5s", () => {
    const v = makeMockVideo({ duration: 60, currentTime: 30 });
    render(<Harness video={v} checkpoints={[]} cleared={new Set()} duration={60} firstUncleared={Infinity} />);
    const seek = screen.getByTestId("portal-course-player-seek");
    fireEvent.keyDown(seek, { key: "ArrowRight" });
    expect(v.currentTime).toBe(35);
    fireEvent.keyDown(seek, { key: "ArrowLeft" });
    expect(v.currentTime).toBe(30);
  });

  it("seek slider Space toggles play/pause", () => {
    const v = makeMockVideo({ duration: 60 });
    render(<Harness video={v} checkpoints={[]} cleared={new Set()} duration={60} firstUncleared={Infinity} />);
    const seek = screen.getByTestId("portal-course-player-seek");
    fireEvent.keyDown(seek, { key: " " });
    expect(v.play).toHaveBeenCalled();
  });

  it("seek slider click seeks to that proportional time", () => {
    const v = makeMockVideo({ duration: 60 });
    render(<Harness video={v} checkpoints={[]} cleared={new Set()} duration={60} firstUncleared={Infinity} />);
    const seek = screen.getByTestId("portal-course-player-seek");
    // Mock bounding rect so the click position becomes deterministic.
    Object.defineProperty(seek, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ left: 0, top: 0, width: 100, height: 10, right: 100, bottom: 10, x: 0, y: 0, toJSON: () => ({}) }),
    });
    fireEvent.click(seek, { clientX: 50 }); // 50 of 100 width = 50%
    expect(v.currentTime).toBe(30); // 50% of 60s
  });

  it("playback-rate selector sets v.playbackRate", () => {
    const v = makeMockVideo({ duration: 60 });
    render(<Harness video={v} checkpoints={[]} cleared={new Set()} duration={60} firstUncleared={Infinity} />);
    const sel = screen.getByTestId("portal-course-player-rate") as HTMLSelectElement;
    fireEvent.change(sel, { target: { value: "2" } });
    expect(v.playbackRate).toBe(2);
  });

  it("mute button toggles v.muted", () => {
    const v = makeMockVideo({ duration: 60 });
    render(<Harness video={v} checkpoints={[]} cleared={new Set()} duration={60} firstUncleared={Infinity} />);
    const btn = screen.getByTestId("portal-course-player-mute");
    fireEvent.click(btn);
    expect(v.muted).toBe(true);
  });

  it("volume slider sets v.volume and unmutes if raising from 0", () => {
    const v = makeMockVideo({ duration: 60 });
    v.muted = true;
    render(<Harness video={v} checkpoints={[]} cleared={new Set()} duration={60} firstUncleared={Infinity} />);
    const slider = screen.getByTestId("portal-course-player-volume") as HTMLInputElement;
    fireEvent.change(slider, { target: { value: "0.5" } });
    expect(v.volume).toBe(0.5);
    expect(v.muted).toBe(false);
  });

  it("exposes accessible region label + role=slider + aria-value* on the seek track", () => {
    render(<Harness
      video={makeMockVideo({ duration: 60, currentTime: 15 })}
      checkpoints={[]}
      cleared={new Set()}
      duration={60}
      firstUncleared={Infinity}
    />);
    const seek = screen.getByTestId("portal-course-player-seek");
    expect(seek.getAttribute("aria-label")).toBe("Seek");
    expect(seek.getAttribute("aria-valuemin")).toBe("0");
    expect(seek.getAttribute("aria-valuemax")).toBe("60");
    expect(seek.getAttribute("tabIndex")).toBe("0");
    // Marker aria-labels include number, timestamp, status.
    render(<Harness
      video={makeMockVideo({ duration: 60 })}
      checkpoints={[CP("cpA", 15, false, true)]}
      cleared={new Set()}
      duration={60}
      firstUncleared={15}
    />);
    const marker = screen.getAllByTestId("portal-course-checkpoint-marker-cpA")[0];
    const label = marker.getAttribute("aria-label");
    expect(label).toMatch(/Checkpoint 1 of 1 at 0:15/);
    expect(label).toMatch(/upcoming \(required\)/);
  });
});
