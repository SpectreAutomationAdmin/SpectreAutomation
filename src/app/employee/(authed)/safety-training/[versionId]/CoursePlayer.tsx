"use client";

// HR-2C B3 §3-16, §22 (2026-08-20) — Employee course experience client.
//
// State machine (single component):
//   video-locked   →  employee is watching the training video; quiz start
//                     is unavailable and displays a lock reason
//   quiz-ready     →  video threshold reached, no attempt open, no
//                     completion yet → "Start knowledge test" button
//   quiz-answering →  attempt is open, questions listed, Submit button
//                     disabled until every question has a selection
//   grading        →  transient while the server grades
//   quiz-result    →  attempt just submitted; show pass / fail UX
//                     with Retake button (subject to B1 policy)
//   completed      →  a passing TrainingCompletion exists; the player
//                     shows the video for re-watch and hides the quiz
//
// Progress discipline (§6):
//   - No timer fired per animation frame.
//   - `timeupdate` fires ~4/sec — we accumulate `secondsWatched` and
//     only POST to the server when either:
//       * accumulated deltas > 15 seconds since last report,
//       * the video is paused (pause / ended / visibilitychange hidden),
//       * the page is unloaded (pagehide → sendBeacon),
//       * we cross the completion threshold locally (so the server
//         can flip the flag and the client can immediately unlock quiz)
//   - Seek jumps are ignored for `secondsWatched` — only real playback
//     accumulates. `farthestSecond` is max(currentTime), tracked
//     separately.
//
// Answer-key discipline:
//   - The Q&A payload is `getEmployeeCourseView`'s output — no
//     isCorrect ever reaches this file.
//   - The Submit action posts { questionId, selectedOptionId } only.
//   - Grading is 100% server-side (§10).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

export type QuestionType = "SINGLE_CHOICE" | "MULTI_ANSWER" | "TRUE_FALSE";

type Question = {
  id: string;
  prompt: string;
  questionType: QuestionType;
  options: Array<{ id: string; text: string; displayOrder: number }>;
};

type Checkpoint = {
  id: string;
  atSecond: number;
  label: string | null;
  requiredToProceed: boolean;
  maxRetries: number;
  questions: Question[];
};

type ProgressRow = {
  secondsWatched: number;
  farthestSecond: number;
  percentComplete: number;
  videoCompleted: boolean;
};

interface Props {
  versionId: string;
  hasVideo: boolean;
  videoDurationSec: number | null;
  requiresKnowledgeTest: boolean;
  passingScore: number;
  retakesAllowed: boolean;
  thresholdPercent: number;
  initialProgress: ProgressRow;
  questions: Question[];
  checkpoints: Checkpoint[];
  initialClearedCheckpointIds: string[];
  alreadyCompleted: boolean;
  canRetake: boolean;
  blockingSubmittedAttempt: boolean;
  submittedAttempts: Array<{
    attemptNumber: number;
    score: number;
    passed: boolean;
    submittedAt: string | null;
  }>;
  recordProgressAction: (
    courseVersionId: string,
    input: { secondsWatched: number; farthestSecond: number },
  ) => Promise<
    | { ok: true; percentComplete: number; videoCompleted: boolean; hasAuthoritativeDuration: boolean }
    | { error: string }
  >;
  startAttemptAction: (
    courseVersionId: string,
  ) => Promise<
    | { ok: true; attemptId: string; attemptNumber: number }
    | { error: string }
  >;
  submitAttemptAction: (
    attemptId: string,
    answers: Array<{ questionId: string; selectedOptionId?: string; selectedOptionIds?: string[] }>,
  ) => Promise<
    | { ok: true; score: number; passed: boolean; completionId: string | null; checkpointCleared?: boolean; attemptsRemaining?: number }
    | { error: string }
  >;
  startCheckpointAttemptAction: (
    courseVersionId: string,
    checkpointId: string,
  ) => Promise<
    | { ok: true; attemptId: string; attemptNumber: number; attemptsRemaining: number; maxRetries: number }
    | { error: string }
  >;
}

type Phase =
  | { kind: "video" }
  // EP-TRAIN-4D (2026-11-01): bounded transient state shown after
  // natural end-of-video while the final progress flush is in
  // flight.  Prevents the client from announcing "Ready for your
  // final knowledge test" before the server has confirmed that
  // percentComplete >= VIDEO_COMPLETION_THRESHOLD_PERCENT.
  | { kind: "finalizing" }
  // EP-TRAIN-4D (2026-11-01): server-confirmed ineligible state —
  // the employee reached end-of-video but authoritative coverage
  // is below threshold.  Reason distinguishes "actual coverage
  // short" from "course video has no authoritative duration
  // metadata on the server (fail-closed cap at threshold-1)".
  | {
      kind: "needs-more-viewing";
      percentComplete: number;
      thresholdPercent: number;
      reason: "coverage" | "duration-metadata-missing";
    }
  // EP-TRAIN-4B §3 (2026-10-31): the final knowledge test now opens
  // inside the video viewer using the checkpoint-overlay surface.
  // `quiz-ready` is shown as an in-player overlay once the video has
  // reached its eligible completion state; the employee starts the
  // test from the viewer rather than scrolling below the video.
  | { kind: "quiz-ready" }
  | { kind: "quiz-answering"; attemptId: string; attemptNumber: number }
  | { kind: "grading" }
  | { kind: "quiz-result"; score: number; passed: boolean }
  | {
      kind: "checkpoint-answering";
      checkpointId: string;
      attemptId: string;
      attemptNumber: number;
      attemptsRemaining: number;
    }
  | {
      kind: "checkpoint-result";
      checkpointId: string;
      passed: boolean;
      attemptsRemaining: number;
      exhausted: boolean;
    };

const REPORT_INTERVAL_SECONDS = 15;
// EP-TRAIN-3 Slice 3D (2026-10-30): seek vs natural-playback detection.
// A natural timeupdate advance = (playbackRate * tickInterval) + jitter.
// Anything beyond PLAYBACK_JUMP_GRACE (0.75s * playbackRate) is treated as
// a seek, which starts a NEW interval but does not accumulate as watched
// coverage of the gap. Replaces the old scalar MAX_DT_PER_TICK clamp
// which under-counted at 1.5x+ playback rates.
const PLAYBACK_JUMP_GRACE_SECONDS_PER_RATE = 0.75;

// EP-TRAIN-4B §4 (2026-10-31) — tick-jitter merge tolerance.
// EP-TRAIN-4B-1 (2026-10-31) — tolerance TIGHTENED to 0.05s.
//
// Staging traces showed the real tick-boundary jitter between
// successive committed intervals is sub-millisecond (0.000046s –
// 0.000910s observed).  The initial fix used 0.5s which also absorbs
// user-driven pause-resume gaps and allows cumulative inflation
// (N pauses × tolerance = N × 0.5s of credited-but-unwatched time).
// 0.05s (50ms) is >50× the observed jitter and still rules out any
// legitimate user action gap, while bounding cumulative inflation
// at an insignificant level even under adversarial repeated pauses.
const INTERVAL_MERGE_TOLERANCE_SECONDS = 0.05;

// Normalise an array of [start, end] intervals: merge overlaps + sort.
// Used to compute unique watched coverage (rewatch doesn't double-count).
function mergeIntervals(intervals: Array<[number, number]>): Array<[number, number]> {
  if (intervals.length === 0) return [];
  const sorted = intervals.map(([s, e]) => [s, e] as [number, number]).sort((a, b) => a[0] - b[0]);
  const out: Array<[number, number]> = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const [s, e] = sorted[i];
    const last = out[out.length - 1];
    if (s <= last[1] + INTERVAL_MERGE_TOLERANCE_SECONDS) {
      if (e > last[1]) last[1] = e;
    } else {
      out.push([s, e]);
    }
  }
  return out;
}

function uniqueCoverageSeconds(intervals: Array<[number, number]>): number {
  const merged = mergeIntervals(intervals);
  let sum = 0;
  for (const [s, e] of merged) sum += Math.max(0, e - s);
  return sum;
}

export default function CoursePlayer(props: Props) {
  const {
    versionId,
    hasVideo,
    videoDurationSec,
    requiresKnowledgeTest,
    passingScore,
    retakesAllowed,
    thresholdPercent,
    initialProgress,
    questions,
    checkpoints,
    initialClearedCheckpointIds,
    alreadyCompleted,
    canRetake,
    blockingSubmittedAttempt,
    submittedAttempts,
    recordProgressAction,
    startAttemptAction,
    submitAttemptAction,
    startCheckpointAttemptAction,
  } = props;

  const router = useRouter();

  const [progress, setProgress] = useState<ProgressRow>(initialProgress);
  // EP-TRAIN-4B §3 + EP-TRAIN-4D (2026-11-01): the initial overlay
  // state is derived from the SERVER-persisted percentComplete (not
  // from the browser's ended state).  Three cases:
  //   - percentComplete >= thresholdPercent → quiz-ready (returning
  //     employee whose earlier session already crossed the gate)
  //   - 0 < percentComplete < thresholdPercent AND farthestSecond ~=
  //     videoDurationSec → the employee's prior session reached
  //     end-of-video but didn't pass eligibility (NULL metadata OR
  //     actual coverage short); surface needs-more-viewing with the
  //     authoritative percent so there is no misleading Ready
  //     button.
  //   - otherwise → video (fresh viewing or still accumulating)
  const initialPhase: Phase = (() => {
    if (!requiresKnowledgeTest || alreadyCompleted || blockingSubmittedAttempt) {
      return { kind: "video" };
    }
    if (initialProgress.percentComplete >= thresholdPercent) {
      return { kind: "quiz-ready" };
    }
    // EP-TRAIN-4E (2026-11-01) — authoritative duration + live
    // coverage recomputation.  Once the server has `videoDurationSec`
    // populated (new uploads always do; legacy rows were back-filled
    // by the ops repair), the stored `percentComplete` on an
    // employee's TrainingProgress row can be a stale snapshot from
    // the pre-4E NULL-duration regime.  Compute live coverage from
    // the SAME verifiable watch evidence (secondsWatched) against
    // the authoritative duration — if that already satisfies the
    // threshold, land directly in quiz-ready.  A mount-only
    // useEffect further below force-flushes the server-side
    // TrainingProgress row so startAttempt won't be rejected by its
    // own stored stale percent.
    if (typeof videoDurationSec === "number" && videoDurationSec > 0) {
      const liveCoverage = Math.min(
        100,
        Math.floor((initialProgress.secondsWatched / videoDurationSec) * 100),
      );
      if (liveCoverage >= thresholdPercent) {
        return { kind: "quiz-ready" };
      }
      const nearlyAtEnd = initialProgress.farthestSecond >= videoDurationSec - 1;
      if (initialProgress.percentComplete > 0 && nearlyAtEnd) {
        return {
          kind: "needs-more-viewing",
          percentComplete: Math.max(liveCoverage, initialProgress.percentComplete),
          thresholdPercent,
          // Duration IS present on the server, so the UX branch is
          // "watch a little more" — NEVER the admin-contact /
          // retry-metadata-error state.  The duration-metadata-
          // missing branch is reserved for the (post-4E unreachable)
          // case where videoDurationSec is still NULL at mount.
          reason: "coverage",
        };
      }
      return { kind: "video" };
    }
    // Defensive fallback for videoDurationSec that is somehow still
    // NULL at mount time (post-4E, this should be unreachable —
    // uploads refuse without a probed duration and publish is gated
    // on a non-NULL value).  Keep the retry UX in case a future
    // regression lets this through.
    const nearlyAtEndNoDuration = false;
    if (initialProgress.percentComplete > 0 && nearlyAtEndNoDuration) {
      return {
        kind: "needs-more-viewing",
        percentComplete: initialProgress.percentComplete,
        thresholdPercent,
        reason: "duration-metadata-missing",
      };
    }
    return { kind: "video" };
  })();
  const [phase, setPhase] = useState<Phase>(initialPhase);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [multiAnswers, setMultiAnswers] = useState<Record<string, Set<string>>>({});
  const [cleared, setCleared] = useState<Set<string>>(new Set(initialClearedCheckpointIds));
  // EP-TRAIN-3E (2026-10-30): guard against concurrent openCheckpoint
  // invocations.  Previously, if two `timeupdate` events fired before
  // the first openCheckpoint's await settled, both would call
  // startCheckpointAttemptAction and both would then clear
  // `answers`/`multiAnswers` as part of their post-await setPhase.  If
  // the user had already selected an answer in the window between the
  // first and second openCheckpoint resolve, the second resolve wiped
  // the selections 100-300ms after the click — producing a
  // reproducible "clicks are accepted then forgotten" bug.  The ref
  // holds the in-flight checkpoint id (null = none), cleared on
  // response error, after setPhase on success, or on resume/retake.
  const openingCheckpointRef = useRef<string | null>(null);
  // EP-TRAIN-3 Slice 3-final (2026-10-30): resync when the server-
  // fetched prop updates (router.refresh() after a cleared submission
  // or on navigation back to the course page). Guarantees local client
  // state matches the server's authoritative cleared set.
  useEffect(() => {
    const incoming = new Set(initialClearedCheckpointIds);
    let changed = false;
    for (const id of incoming) {
      if (!clearedRef.current.has(id)) {
        clearedRef.current.add(id);
        changed = true;
      }
    }
    if (changed) {
      setCleared((prev) => {
        const merged = new Set<string>(prev);
        for (const id of incoming) merged.add(id);
        return merged;
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialClearedCheckpointIds]);

  // EP-TRAIN-3 Slice 3 (2026-10-29): sorted checkpoints + next-un-cleared helper.
  const sortedCheckpoints = useMemo(
    () => [...checkpoints].sort((a, b) => a.atSecond - b.atSecond),
    [checkpoints],
  );
  const firstUnclearedRequiredAtSecond = useMemo(() => {
    const next = sortedCheckpoints.find((cp) => cp.requiredToProceed && !cleared.has(cp.id));
    return next ? next.atSecond : Number.POSITIVE_INFINITY;
  }, [sortedCheckpoints, cleared]);

  // Progress accumulators
  const videoRef = useRef<HTMLVideoElement | null>(null);
  // EP-TRAIN-3 Slice 3D (2026-10-30): interval-based coverage. The
  // merged union of watched [start,end] pairs represents unique
  // content coverage; rewatch doesn't double-count. secondsWatchedRef
  // is derived from the union before each send to the server.
  const watchedIntervalsRef = useRef<Array<[number, number]>>(
    initialProgress.secondsWatched > 0 ? [[0, initialProgress.secondsWatched]] : [],
  );
  const currentIntervalRef = useRef<[number, number] | null>(null);
  const secondsWatchedRef = useRef(initialProgress.secondsWatched);
  const farthestRef = useRef(initialProgress.farthestSecond);
  const lastTimeRef = useRef(initialProgress.farthestSecond);
  const lastReportedSecondsRef = useRef(initialProgress.secondsWatched);
  const inFlightRef = useRef(false);
  // EP-TRAIN-3 Slice 3D (2026-10-30): monotonic request sequence.
  // Each send carries a `seq`; the client discards response-driven
  // state updates whose seq is older than the current head. Prevents a
  // slow earlier-fired request from overwriting a newer value.
  const sendSeqRef = useRef(0);
  const highestResolvedSeqRef = useRef(0);
  // EP-TRAIN-3 Slice 3D (2026-10-30): cleared state as useRef (for
  // closure freshness in onTimeUpdate) PLUS useState (for render).
  // Any mutation goes through `recordCleared` which keeps both in sync.
  const clearedRef = useRef<Set<string>>(new Set(initialClearedCheckpointIds));
  const recordCleared = useCallback((id: string) => {
    if (!clearedRef.current.has(id)) {
      clearedRef.current.add(id);
    }
    setCleared((prev) => (prev.has(id) ? prev : new Set([...prev, id])));
  }, []);

  const videoUrl = `/api/hr/training/versions/${encodeURIComponent(versionId)}/video`;

  // -------------------------------------------------------------------------
  // Progress reporting
  // -------------------------------------------------------------------------

  // EP-TRAIN-4D (2026-11-01): sendProgress now RETURNS the server
  // response so a caller (notably onEnded's final flush) can gate the
  // post-video UI transition on authoritative eligibility.
  const sendProgress = useCallback(
    async (opts?: { force?: boolean }): Promise<
      | { ok: true; percentComplete: number; videoCompleted: boolean; hasAuthoritativeDuration: boolean }
      | null
    > => {
      if (!hasVideo) return null;
      // EP-TRAIN-3 Slice 3D (2026-10-30): derive secondsWatched from
      // the merged interval union so rewatch doesn't double-count. The
      // currentInterval (open playback segment) is folded into the
      // union snapshot before computing.
      const intervals: Array<[number, number]> = [...watchedIntervalsRef.current];
      if (currentIntervalRef.current) {
        intervals.push([currentIntervalRef.current[0], currentIntervalRef.current[1]]);
      }
      const seconds = uniqueCoverageSeconds(intervals);
      secondsWatchedRef.current = seconds;
      const farthest = farthestRef.current;
      if (!opts?.force && seconds - lastReportedSecondsRef.current < REPORT_INTERVAL_SECONDS) {
        return null;
      }
      // Non-force sends respect the inFlight guard to avoid spam;
      // force-sends wait for the current flight to drain then go.
      if (inFlightRef.current && !opts?.force) return null;
      if (inFlightRef.current && opts?.force) {
        const deadline = Date.now() + 10_000;
        while (inFlightRef.current && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 100));
        }
      }
      const seq = ++sendSeqRef.current;
      inFlightRef.current = true;
      try {
        const result = await recordProgressAction(versionId, {
          secondsWatched: Math.floor(seconds),
          farthestSecond: Math.floor(farthest),
        });
        // Drop stale responses: another request may have already updated
        // state to a NEWER value. Only the latest-resolved seq updates UI.
        if (seq < highestResolvedSeqRef.current) return null;
        highestResolvedSeqRef.current = seq;
        if ("ok" in result) {
          lastReportedSecondsRef.current = seconds;
          setProgress(() => ({
            secondsWatched: seconds,
            farthestSecond: farthest,
            percentComplete: result.percentComplete,
            videoCompleted: result.videoCompleted,
          }));
          return { ok: true, percentComplete: result.percentComplete, videoCompleted: result.videoCompleted, hasAuthoritativeDuration: result.hasAuthoritativeDuration };
        }
        setError(result.error);
        return null;
      } finally {
        inFlightRef.current = false;
      }
    },
    [hasVideo, versionId, recordProgressAction],
  );

  // EP-TRAIN-4E (2026-11-01) — mount-only stale-percent resync.
  //
  // When the server has an authoritative duration populated AND the
  // employee's stored percentComplete is below threshold BUT their
  // existing watch evidence (secondsWatched) would satisfy threshold
  // against the authoritative duration, the TrainingProgress row is a
  // stale snapshot from the pre-4E regime.  The initial-mount
  // derivation above already lands them in quiz-ready for display,
  // but the server-side startAttempt gate reads percentComplete
  // directly from the DB.  Fire a one-shot force-sendProgress at
  // mount using the EXISTING secondsWatched + farthestSecond so the
  // server recomputes percentComplete against the authoritative
  // duration and persists the update.  No watch evidence is
  // modified — this is a pure recomputation using existing values
  // and is audited by the normal recordVideoProgress audit path.
  const didMountResyncRef = useRef(false);
  useEffect(() => {
    if (didMountResyncRef.current) return;
    didMountResyncRef.current = true;
    if (!requiresKnowledgeTest || alreadyCompleted || blockingSubmittedAttempt) return;
    if (typeof videoDurationSec !== "number" || videoDurationSec <= 0) return;
    const liveCoverage = Math.min(
      100,
      Math.floor((initialProgress.secondsWatched / videoDurationSec) * 100),
    );
    const storedBelowThreshold = initialProgress.percentComplete < thresholdPercent;
    const liveMeetsThreshold = liveCoverage >= thresholdPercent;
    if (!storedBelowThreshold || !liveMeetsThreshold) return;
    void sendProgress({ force: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Beacon-style flush on unload (best-effort — the server action
  // path is used everywhere else). This ensures a page close doesn't
  // discard the last ~15s.
  useEffect(() => {
    const onHide = () => {
      // Fire-and-forget — no await inside handler.
      void sendProgress({ force: true });
    };
    window.addEventListener("pagehide", onHide);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") void sendProgress({ force: true });
    });
    return () => {
      window.removeEventListener("pagehide", onHide);
    };
  }, [sendProgress]);

  // -------------------------------------------------------------------------
  // Video event handlers
  // -------------------------------------------------------------------------

  function onLoadedMetadata(e: React.SyntheticEvent<HTMLVideoElement>) {
    // Resume from persisted farthestSecond so the employee doesn't
    // have to re-scrub — but cap at duration - 2 so they don't
    // resume past the end.
    const el = e.currentTarget;
    if (initialProgress.farthestSecond > 1 && el.duration > 0) {
      el.currentTime = Math.min(initialProgress.farthestSecond, Math.max(0, el.duration - 2));
      lastTimeRef.current = el.currentTime;
    }
  }

  function onTimeUpdate(e: React.SyntheticEvent<HTMLVideoElement>) {
    const el = e.currentTarget;
    const now = el.currentTime;
    const rate = el.playbackRate || 1;
    const dt = now - lastTimeRef.current;
    lastTimeRef.current = now;
    // EP-TRAIN-3 Slice 3D (2026-10-30): interval-based coverage.
    const jumpGrace = PLAYBACK_JUMP_GRACE_SECONDS_PER_RATE * rate;
    const naturalAdvance = dt > 0 && dt <= jumpGrace;
    if (!el.paused && naturalAdvance) {
      if (!currentIntervalRef.current) {
        currentIntervalRef.current = [now - dt, now];
      } else {
        currentIntervalRef.current[1] = now;
      }
    } else {
      if (currentIntervalRef.current) {
        watchedIntervalsRef.current.push([currentIntervalRef.current[0], currentIntervalRef.current[1]]);
        currentIntervalRef.current = null;
      }
      if (!el.paused) currentIntervalRef.current = [now, now];
    }
    if (now > farthestRef.current) farthestRef.current = now;
    // Trigger uses clearedRef (always current).
    if (phase.kind === "video" && openingCheckpointRef.current === null) {
      const triggered = sortedCheckpoints.find(
        (cp) => !clearedRef.current.has(cp.id) && now >= cp.atSecond,
      );
      if (triggered) {
        if (!el.paused) el.pause();
        if (currentIntervalRef.current) {
          watchedIntervalsRef.current.push([currentIntervalRef.current[0], currentIntervalRef.current[1]]);
          currentIntervalRef.current = null;
        }
        openingCheckpointRef.current = triggered.id;
        void sendProgress({ force: true }).then(() => openCheckpoint(triggered.id));
      }
    }
    void sendProgress();
  }

  // EP-TRAIN-3 Slice 3 (2026-10-29): seek-forward prevention.
  // Clamp currentTime to the first un-cleared required checkpoint;
  // the server also enforces this via recordVideoProgress capping.
  function onSeeking(e: React.SyntheticEvent<HTMLVideoElement>) {
    const el = e.currentTarget;
    if (
      Number.isFinite(firstUnclearedRequiredAtSecond) &&
      el.currentTime > firstUnclearedRequiredAtSecond
    ) {
      el.currentTime = firstUnclearedRequiredAtSecond;
    }
  }

  async function openCheckpoint(checkpointId: string) {
    // EP-TRAIN-3E (2026-10-30): single-flight guard. If another
    // openCheckpoint invocation already resolved and set phase to
    // "checkpoint-answering" for this checkpoint, do not clobber the
    // user's answer state.  The onTimeUpdate branch above also sets
    // openingCheckpointRef so a second concurrent invocation is
    // short-circuited before it even starts.
    if (phase.kind === "checkpoint-answering" && phase.checkpointId === checkpointId) {
      openingCheckpointRef.current = null;
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const result = await startCheckpointAttemptAction(versionId, checkpointId);
      if ("ok" in result) {
        setPhase({
          kind: "checkpoint-answering",
          checkpointId,
          attemptId: result.attemptId,
          attemptNumber: result.attemptNumber,
          attemptsRemaining: result.attemptsRemaining,
        });
        setAnswers({});
        setMultiAnswers({});
      } else {
        setError(result.error);
      }
    } finally {
      setBusy(false);
      openingCheckpointRef.current = null;
    }
  }

  async function onSubmitCheckpoint() {
    if (phase.kind !== "checkpoint-answering") return;
    const cp = sortedCheckpoints.find((c) => c.id === phase.checkpointId);
    if (!cp) return;
    const payload = cp.questions.map((q) => {
      if (q.questionType === "MULTI_ANSWER") {
        return { questionId: q.id, selectedOptionIds: Array.from(multiAnswers[q.id] ?? new Set()) };
      }
      return { questionId: q.id, selectedOptionId: answers[q.id] };
    });
    const unanswered = cp.questions.some((q) =>
      q.questionType === "MULTI_ANSWER"
        ? (multiAnswers[q.id]?.size ?? 0) === 0
        : !answers[q.id],
    );
    if (unanswered) {
      setError("Please answer every question before submitting.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await submitAttemptAction(phase.attemptId, payload);
      if ("ok" in result) {
        const passed = !!result.checkpointCleared;
        const attemptsRemaining = result.attemptsRemaining ?? 0;
        // EP-TRAIN-3 Slice 3-final (2026-10-30) -- server is now the
        // SINGLE source of truth per founder directive §2. Optimistic
        // client `cleared` update is kept for immediate UX feedback,
        // but router.refresh() re-fetches getPlayerState so the
        // Course page's initialClearedCheckpointIds + player state
        // match the just-committed server state before the user can
        // navigate away or refresh. The success overlay is announced
        // only after the server-confirmed state is in hand.
        if (passed) {
          recordCleared(phase.checkpointId);
          router.refresh();
        }
        setPhase({
          kind: "checkpoint-result",
          checkpointId: phase.checkpointId,
          passed,
          attemptsRemaining,
          exhausted: !passed && attemptsRemaining === 0,
        });
      } else {
        setError(result.error);
      }
    } finally {
      setBusy(false);
    }
  }

  function onResumeAfterCheckpoint() {
    if (phase.kind === "checkpoint-result" && phase.passed) {
      recordCleared(phase.checkpointId);
    }
    setPhase({ kind: "video" });
    setAnswers({});
    setMultiAnswers({});
    openingCheckpointRef.current = null;
    const el = videoRef.current;
    if (el) void el.play().catch(() => {/* ignore autoplay refusal */});
  }

  function onRetryCheckpoint() {
    if (phase.kind !== "checkpoint-result") return;
    void openCheckpoint(phase.checkpointId);
  }

  function onPause() {
    // EP-TRAIN-4B-1 (2026-10-31): close the pause-side half of the
    // tick-boundary coverage gap.
    //
    // `onTimeUpdate` snapshots `currentIntervalRef[1]` at each
    // `timeupdate` event (which fires at most every ~250ms during
    // playback).  When the user pauses, the committed interval ends
    // at the LAST `timeupdate` currentTime — typically 100-300ms
    // short of the real `el.currentTime` at pause.  That gap is
    // then preserved by the merge (the gap exceeds the 0.05s
    // tolerance), understating unique coverage by 0.1-0.3s per pause
    // and compounding into a visibly wrong watch-progress %.
    //
    // Fix: extend the committed interval's end to `el.currentTime`
    // (the real pause position).  Content between `lastSeen` and
    // `currentTime` WAS actually played — the video just paused
    // mid-tick before `timeupdate` could record it.
    const el = videoRef.current;
    if (currentIntervalRef.current) {
      // Branch A: an open interval is still alive — commit it, with
      // the end extended to el.currentTime (closes the 100-300ms gap
      // between the last `timeupdate` snapshot and the real pause
      // position).
      const [start, lastSeen] = currentIntervalRef.current;
      const end = el && Number.isFinite(el.currentTime)
        ? Math.max(lastSeen, el.currentTime)
        : lastSeen;
      watchedIntervalsRef.current.push([start, end]);
      currentIntervalRef.current = null;
    } else if (
      el
      && Number.isFinite(el.currentTime)
      && watchedIntervalsRef.current.length > 0
    ) {
      // Branch B: a late `onTimeUpdate` with dt~0 already took the
      // ELSE path (naturalAdvance=false → commit + no new interval
      // because video is paused), so currentIntervalRef is already
      // null by the time this handler runs.  The last committed
      // interval's end is still 100-300ms short of the real pause
      // position for the same tick-boundary reason.  Extend its end
      // to el.currentTime IF the gap is within the natural-advance
      // threshold — guarantees we never extend across a legitimate
      // seek-forward (which produces a gap > jumpGrace).
      const last = watchedIntervalsRef.current[watchedIntervalsRef.current.length - 1];
      const rate = el.playbackRate || 1;
      const jumpGrace = PLAYBACK_JUMP_GRACE_SECONDS_PER_RATE * rate;
      const gap = el.currentTime - last[1];
      if (gap > 0 && gap <= jumpGrace) {
        last[1] = el.currentTime;
      }
    }
    void sendProgress({ force: true });
  }

  function onEnded() {
    // EP-TRAIN-4B §4 (2026-10-31): extend the final watched interval
    // to the authoritative video duration before committing.
    //
    // Root cause of the 98% end-of-video result the founder saw:
    //   1. The video element's last `timeupdate` fires at
    //      `currentTime = duration - ε` (ε ≈ 0.2–0.9s depending on
    //      the file's keyframe cadence).
    //   2. onTimeUpdate's natural-advance branch extends
    //      `currentIntervalRef[1]` to that value — short of
    //      `duration`.
    //   3. onEnded used to push that interval UNCHANGED, so unique
    //      coverage topped out at `duration - ε`.
    //   4. The client floors coverage before sending
    //      (`Math.floor(seconds)` in sendProgress).
    //      → With a 41.5s video + videoDurationSec=42 stored in DB:
    //        floor(41.3) = 41 → 41/42 = 97.6% → 98% rounded.
    //
    // Fix: the `ended` event is a definitive signal that the browser
    // played the media to completion.  Credit the full authoritative
    // duration (DB `videoDurationSec`, falling back to the media
    // element's own `duration` if the DB value is unavailable).
    // Seeking cannot forge the `ended` event — the browser only
    // fires it after the media reached its end during actual
    // playback.
    const el = videoRef.current;
    const mediaDuration = el?.duration && Number.isFinite(el.duration) ? el.duration : null;
    const authoritativeEnd = videoDurationSec && videoDurationSec > 0
      ? videoDurationSec
      : mediaDuration;
    if (currentIntervalRef.current) {
      // Common path: video played through to end without a pause
      // event just before.  The open interval already spans the
      // final segment; extend its end to the authoritative duration.
      const [start, lastSeen] = currentIntervalRef.current;
      const end = authoritativeEnd !== null ? Math.max(lastSeen, authoritativeEnd) : lastSeen;
      watchedIntervalsRef.current.push([start, end]);
      currentIntervalRef.current = null;
    } else if (authoritativeEnd !== null && watchedIntervalsRef.current.length > 0) {
      // onPause ran JUST before onEnded (HTML spec: a video playing
      // to end dispatches `pause` then `ended`).  onPause already
      // committed the open interval as [start, lastSeen] where
      // `lastSeen` is the final `timeupdate` currentTime — typically
      // 0.1-0.5s short of the real duration.  Pushing a NEW tail
      // interval `[lastKnown, authoritativeEnd]` would leave a gap
      // between the committed interval's end and the tail's start,
      // because `lastTimeRef` is updated by a later `timeupdate`
      // that fires AFTER pause's commit.  Instead, extend the
      // right-most committed interval's end to `authoritativeEnd`
      // directly, closing the sub-second gap.
      const last = watchedIntervalsRef.current[watchedIntervalsRef.current.length - 1];
      if (last[1] < authoritativeEnd) {
        last[1] = authoritativeEnd;
      }
    } else if (authoritativeEnd !== null) {
      // Edge-of-edge case: no committed intervals yet (e.g. a short
      // video that `ended` before the first `timeupdate` tick).
      const lastKnown = lastTimeRef.current;
      if (lastKnown >= 0 && lastKnown < authoritativeEnd) {
        watchedIntervalsRef.current.push([lastKnown, authoritativeEnd]);
      }
    }
    // EP-TRAIN-4D (2026-11-01): the final overlay state is now
    // SERVER-AUTHORITATIVE.  Previously `onEnded` set phase to
    // `quiz-ready` purely on the browser's `ended` event — but a
    // course with NULL `videoDurationSec` (legacy upload metadata
    // missing) caps server-side `percentComplete` at 89% to stay
    // fail-closed under EP-TRAIN-4B-1.  The client's "Ready" overlay
    // would then invite a Start click that the server rejects
    // (< VIDEO_COMPLETION_THRESHOLD_PERCENT), producing the founder's
    // observed blocker: `0:51 / 0:51` + both checkpoints cleared +
    // Ready overlay + "Complete the training video (at least 90%)".
    //
    // Fix: show a bounded `finalizing` state immediately, flush the
    // interval union to the server, and transition to the overlay
    // state the server actually says the employee is in.
    if (
      requiresKnowledgeTest
      && !alreadyCompleted
      && !blockingSubmittedAttempt
      && phase.kind === "video"
    ) {
      setPhase({ kind: "finalizing" });
    }
    void sendProgress({ force: true }).then((response) => {
      if (!requiresKnowledgeTest || alreadyCompleted || blockingSubmittedAttempt) return;
      if (!response) return; // network error — leave finalizing; useEffect will handle fallback
      const unlocked = response.percentComplete >= thresholdPercent;
      if (unlocked) {
        setPhase({ kind: "quiz-ready" });
      } else {
        setPhase({
          kind: "needs-more-viewing",
          percentComplete: response.percentComplete,
          thresholdPercent,
          reason: response.hasAuthoritativeDuration ? "coverage" : "duration-metadata-missing",
        });
      }
    });
  }

  // -------------------------------------------------------------------------
  // Quiz actions
  // -------------------------------------------------------------------------

  const videoUnlocked = progress.percentComplete >= thresholdPercent || !hasVideo;

  async function onStartAttempt() {
    setError(null);
    setBusy(true);
    try {
      const result = await startAttemptAction(versionId);
      if ("ok" in result) {
        setPhase({
          kind: "quiz-answering",
          attemptId: result.attemptId,
          attemptNumber: result.attemptNumber,
        });
        setAnswers({});
      } else {
        setError(result.error);
      }
    } finally {
      setBusy(false);
    }
  }

  async function onSubmitAttempt() {
    if (phase.kind !== "quiz-answering") return;
    // Guard: every question must have an answer.
    if (questions.some((q) => !answers[q.id])) {
      setError("Please answer every question before submitting.");
      return;
    }
    setError(null);
    setBusy(true);
    setPhase({ kind: "grading" });
    try {
      const payload = questions.map((q) => ({
        questionId: q.id,
        selectedOptionId: answers[q.id]!,
      }));
      const result = await submitAttemptAction(phase.attemptId, payload);
      if ("ok" in result) {
        setPhase({ kind: "quiz-result", score: result.score, passed: result.passed });
        if (result.passed) {
          // Refresh so the CompletedBanner + dashboard status flip.
          router.refresh();
        }
      } else {
        setError(result.error);
        setPhase({
          kind: "quiz-answering",
          attemptId: phase.attemptId,
          attemptNumber: phase.attemptNumber,
        });
      }
    } finally {
      setBusy(false);
    }
  }

  function onRetake() {
    setPhase({ kind: "video" });
    setAnswers({});
    setError(null);
  }

  // EP-TRAIN-4E A4 (2026-10-31): "Try again" from the
  // needs-more-viewing / duration-metadata-missing branch.  Flushes
  // whatever coverage the client holds, then asks the server to
  // re-evaluate.  If the server-side state has since been repaired
  // (duration backfilled by the ops repair script), the fresh
  // response will unlock quiz-ready without a page refresh.
  async function onNeedsMoreViewingRetry() {
    setError(null);
    setBusy(true);
    setPhase({ kind: "finalizing" });
    try {
      const response = await sendProgress({ force: true });
      if (!response) {
        // Server didn't respond — stay in a bounded state and let the
        // employee try once more.
        setPhase({
          kind: "needs-more-viewing",
          percentComplete: progress.percentComplete,
          thresholdPercent,
          reason: "duration-metadata-missing",
        });
        return;
      }
      const unlocked = response.percentComplete >= thresholdPercent;
      if (unlocked) {
        setPhase({ kind: "quiz-ready" });
      } else {
        setPhase({
          kind: "needs-more-viewing",
          percentComplete: response.percentComplete,
          thresholdPercent,
          reason: response.hasAuthoritativeDuration ? "coverage" : "duration-metadata-missing",
        });
      }
      // Pull a fresh server-rendered course view so any
      // administrator-side repair (e.g. videoDurationSec backfill) is
      // visible on the next render.
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  const percentDisplay = Math.min(100, Math.round(progress.percentComplete));

  const historyCount = submittedAttempts.length;

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <div className="space-y-8">
      {/* Video block -- EP-TRAIN-1 §A (2026-10-29):
         - 16:9 aspect ratio is RESERVED on the wrapper BEFORE the
           browser has any metadata so there is no 0-height black
           strip while R2 streams the first bytes.
         - The player sits inside a `relative` + `aspect-video`
           container; the inner <video> fills it with `absolute inset-0`.
           Container background is a muted stone (not pure black) so
           the "nothing yet rendered" state reads as a neutral poster
           rather than a dropped frame.
         - `preload="auto"` is now safe because the proxy streams
           + supports Range; the browser can grab a few seconds
           without blocking on the full download. */}
      {hasVideo && (
        <section
          className="rounded-lg border border-stone-200 bg-white overflow-hidden"
          data-testid="portal-course-video-section"
        >
          <div className="relative w-full aspect-video bg-stone-100">
            <video
              ref={videoRef}
              className="absolute inset-0 w-full h-full bg-stone-900"
              playsInline
              preload="auto"
              src={videoUrl}
              onLoadedMetadata={onLoadedMetadata}
              onTimeUpdate={onTimeUpdate}
              onSeeking={onSeeking}
              onPause={onPause}
              onEnded={onEnded}
              onClick={() => {
                const v = videoRef.current;
                if (!v) return;
                if (v.paused) void v.play().catch(() => { /* ignore autoplay */ });
                else v.pause();
              }}
              data-testid="portal-course-video"
            >
              Your browser does not support the video tag.
            </video>
            {/* EP-TRAIN-3 Slice 3 (2026-10-29): checkpoint overlay
                dims the video + presents the question UI inline when
                a checkpoint has been triggered or the result is being
                shown.
                EP-TRAIN-4B §3 (2026-10-31): same surface now also
                hosts the final-knowledge-test states so the employee
                never has to scroll below the video to start,
                submit, or see the result. */}
            {(phase.kind === "checkpoint-answering"
              || phase.kind === "checkpoint-result"
              || phase.kind === "finalizing"
              || phase.kind === "needs-more-viewing"
              || phase.kind === "quiz-ready"
              || phase.kind === "quiz-answering"
              || phase.kind === "grading"
              || phase.kind === "quiz-result") && (
              <div
                className="absolute inset-0 flex items-center justify-center bg-stone-900/85 p-4 overflow-y-auto"
                data-testid="portal-checkpoint-overlay"
              >
                <div className="max-w-2xl w-full bg-white rounded-lg shadow-xl p-6 space-y-4 my-auto max-h-full overflow-y-auto">
                  {(phase.kind === "checkpoint-answering" || phase.kind === "checkpoint-result") && (
                    <CheckpointPanel
                      phase={phase}
                      checkpoints={sortedCheckpoints}
                      answers={answers}
                      multiAnswers={multiAnswers}
                      busy={busy}
                      setAnswers={setAnswers}
                      setMultiAnswers={setMultiAnswers}
                      onSubmit={onSubmitCheckpoint}
                      onResume={onResumeAfterCheckpoint}
                      onRetry={onRetryCheckpoint}
                    />
                  )}
                  {(phase.kind === "finalizing"
                    || phase.kind === "needs-more-viewing"
                    || phase.kind === "quiz-ready"
                    || phase.kind === "quiz-answering"
                    || phase.kind === "grading"
                    || phase.kind === "quiz-result") && (
                    <FinalAssessmentPanel
                      phase={phase}
                      questions={questions}
                      answers={answers}
                      busy={busy}
                      passingScore={passingScore}
                      retakesAllowed={retakesAllowed}
                      setAnswers={setAnswers}
                      onStart={onStartAttempt}
                      onSubmit={onSubmitAttempt}
                      onRetake={onRetake}
                      onRetry={onNeedsMoreViewingRetry}
                    />
                  )}
                </div>
              </div>
            )}
          </div>
          {/* EP-TRAIN-4C §1 + §2 (2026-10-31): the separate Watch
              Progress bar + percentage is removed; a focused custom
              player-control bar replaces the native HTML5 controls
              and embeds checkpoint markers DIRECTLY on the seek
              timeline so there is only ONE playback line visible.
              Server-side watch-coverage accounting, checkpoint
              gating, seek restrictions, assessment eligibility,
              completion persistence, and audit remain unchanged. */}
          <PlayerControlBar
            videoRef={videoRef}
            sortedCheckpoints={sortedCheckpoints}
            cleared={cleared}
            videoDurationSec={videoDurationSec}
            firstUnclearedRequiredAtSecond={firstUnclearedRequiredAtSecond}
          />
        </section>
      )}

      {/* EP-TRAIN-4B §3 (2026-10-31): the knowledge-test start / answer
          / grade / result UI has moved INTO the in-player overlay above
          (same surface as mid-video checkpoint overlays).  The below-
          video quiz section is retained only for the pre-threshold
          locked state and non-video-blocking error surfacing — it no
          longer competes with the overlay for the employee's attention. */}
      {requiresKnowledgeTest && !alreadyCompleted && !blockingSubmittedAttempt && phase.kind === "video" && !videoUnlocked && (
        <section
          className="rounded-lg border border-stone-200 bg-white px-5 py-5"
          data-testid="portal-course-quiz-locked-section"
        >
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="font-serif text-xl text-club-ink">Knowledge test</h2>
            <span className="text-[11px] uppercase tracking-[0.16em] text-stone-500">
              Passing score {passingScore}%
            </span>
          </div>
          <div
            className="mt-4 rounded-md bg-stone-50 border border-stone-200 px-4 py-3"
            data-testid="portal-course-quiz-locked"
          >
            <p className="text-sm text-stone-700">
              Complete the training video before starting the knowledge test.
            </p>
            <p className="mt-1 text-xs text-stone-500">
              You&rsquo;ve watched {percentDisplay}% — the quiz unlocks at{" "}
              {thresholdPercent}%.
            </p>
          </div>
        </section>
      )}
      {error && (
        <section
          role="alert"
          className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
          data-testid="portal-course-error"
        >
          {error}
        </section>
      )}

      {/* Blocked-no-retakes state */}
      {blockingSubmittedAttempt && (
        <section
          className="rounded-lg border border-amber-200 bg-amber-50/70 px-5 py-4"
          data-testid="portal-course-blocked-no-retake"
        >
          <p className="text-sm text-amber-900">
            <strong>Not passed.</strong> Retakes aren&rsquo;t allowed on this
            course. Speak with your Club administrator.
          </p>
        </section>
      )}

      {/* Retake path — user completed a failed attempt and returned. */}
      {canRetake && phase.kind === "video" && (
        <section
          className="rounded-lg border border-stone-200 bg-white px-5 py-4"
          data-testid="portal-course-retake-note"
        >
          <p className="text-sm text-stone-700">
            Previous attempt: <strong>Not passed</strong>. Review the training
            video and start a new knowledge test when you&rsquo;re ready.
          </p>
        </section>
      )}

      {historyCount > 0 && (
        <section data-testid="portal-course-history">
          <h3 className="text-[11px] uppercase tracking-[0.2em] text-stone-500">
            Attempt history
          </h3>
          <ul className="mt-3 space-y-1 text-sm text-stone-700">
            {submittedAttempts.map((a) => (
              <li
                key={a.attemptNumber}
                className="flex items-center justify-between border-b border-stone-100 py-1"
                data-testid={`portal-course-history-${a.attemptNumber}`}
              >
                <span>Attempt {a.attemptNumber}</span>
                <span className="tabular-nums">
                  {a.score}% ·{" "}
                  <span className={a.passed ? "text-emerald-800" : "text-amber-800"}>
                    {a.passed ? "Passed" : "Not passed"}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function CheckpointPanel({
  phase,
  checkpoints,
  answers,
  multiAnswers,
  busy,
  setAnswers,
  setMultiAnswers,
  onSubmit,
  onResume,
  onRetry,
}: {
  phase: Phase;
  checkpoints: Checkpoint[];
  answers: Record<string, string>;
  multiAnswers: Record<string, Set<string>>;
  busy: boolean;
  setAnswers: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  setMultiAnswers: React.Dispatch<React.SetStateAction<Record<string, Set<string>>>>;
  onSubmit: () => void;
  onResume: () => void;
  onRetry: () => void;
}) {
  if (phase.kind === "checkpoint-answering") {
    const cp = checkpoints.find((c) => c.id === phase.checkpointId);
    if (!cp) return null;
    return (
      <div className="space-y-4" data-testid="portal-checkpoint-answering">
        <div className="flex items-baseline justify-between gap-3">
          <h3 className="font-serif text-xl text-club-ink">
            Knowledge check{cp.label ? ` — ${cp.label}` : ""}
          </h3>
          <span className="text-[11px] uppercase tracking-[0.14em] text-stone-500" data-testid="portal-checkpoint-attempts-remaining">
            {phase.attemptsRemaining} attempt{phase.attemptsRemaining === 1 ? "" : "s"} remaining
          </span>
        </div>
        <p className="text-xs text-stone-500">
          Answer every question to continue. Playback resumes once this checkpoint is cleared.
        </p>
        <div className="space-y-5">
          {cp.questions.map((q, i) => (
            <fieldset key={q.id} className="space-y-2" data-testid={`portal-checkpoint-question-${q.id}`}>
              <legend className="text-sm text-club-ink">
                <span className="text-[11px] uppercase tracking-[0.14em] text-stone-500 mr-2">
                  Question {i + 1}
                </span>
                {q.prompt}
              </legend>
              {q.questionType === "MULTI_ANSWER" ? (
                <div className="mt-1 space-y-1.5">
                  {q.options.map((o) => {
                    const selected = multiAnswers[q.id]?.has(o.id) ?? false;
                    const toggleOption = () => {
                      setMultiAnswers((prev) => {
                        const next = { ...prev };
                        const set = new Set(next[q.id] ?? new Set());
                        if (set.has(o.id)) set.delete(o.id); else set.add(o.id);
                        next[q.id] = set;
                        return next;
                      });
                    };
                    return (
                      // EP-TRAIN-3 Slice 3D-verify (2026-10-30): explicit
                      // onClick on the label to guarantee deterministic
                      // toggling for all click origins (label, span, or
                      // input). The native "click label -> toggle input"
                      // path was observed to be unreliable for checkboxes
                      // inside this controlled-React overlay in some
                      // browser/CSS conditions. No htmlFor/id binding —
                      // combining it with the implicit label wrapper
                      // doubles the a11y accessible-name resolution.
                      <label
                        key={o.id}
                        className={`flex items-center gap-3 px-3 py-2 rounded-md border cursor-pointer ${
                          selected
                            ? "border-club-green-700 bg-club-green-50"
                            : "border-stone-200 hover:bg-stone-50"
                        }`}
                        data-testid={`portal-checkpoint-option-${o.id}`}
                        onClick={(e) => {
                          // Only run our explicit handler for non-INPUT
                          // click targets. If the user clicks the input
                          // itself the native onChange fires below.
                          if ((e.target as HTMLElement).tagName !== "INPUT") {
                            e.preventDefault();
                            toggleOption();
                          }
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={selected}
                          onChange={toggleOption}
                          className="accent-club-green-700"
                        />
                        <span className="text-sm text-stone-800">{o.text}</span>
                      </label>
                    );
                  })}
                </div>
              ) : (
                <div className="mt-1 space-y-1.5">
                  {q.options.map((o) => (
                    <label
                      key={o.id}
                      className={`flex items-center gap-3 px-3 py-2 rounded-md border cursor-pointer ${
                        answers[q.id] === o.id
                          ? "border-club-green-700 bg-club-green-50"
                          : "border-stone-200 hover:bg-stone-50"
                      }`}
                      data-testid={`portal-checkpoint-option-${o.id}`}
                    >
                      <input
                        type="radio"
                        name={`cp-${q.id}`}
                        value={o.id}
                        checked={answers[q.id] === o.id}
                        onChange={() => setAnswers((prev) => ({ ...prev, [q.id]: o.id }))}
                        className="accent-club-green-700"
                      />
                      <span className="text-sm text-stone-800">{o.text}</span>
                    </label>
                  ))}
                </div>
              )}
            </fieldset>
          ))}
        </div>
        <div className="flex items-center justify-end">
          <button
            type="button"
            className="btn btn-primary"
            onClick={onSubmit}
            disabled={busy}
            data-testid="portal-checkpoint-submit"
          >
            {busy ? "Checking…" : "Submit"}
          </button>
        </div>
      </div>
    );
  }
  if (phase.kind === "checkpoint-result") {
    // EP-TRAIN-4B §1 (2026-10-31): copy polished to match the Spectre
    // premium tone — encouraging, specific, no exclamation stacking or
    // gamified praise.  The policy (attempts remaining, retry
    // governance, no answer disclosure) is unchanged.
    return (
      <div className="space-y-4" data-testid="portal-checkpoint-result">
        {phase.passed ? (
          <>
            <h3 className="font-serif text-xl text-emerald-900">Nicely done.</h3>
            <p className="text-sm text-stone-700">
              You&rsquo;ve got it. You&rsquo;re ready for the next part of your
              training.
            </p>
            <div className="flex justify-end">
              <button
                type="button"
                className="btn btn-primary"
                onClick={onResume}
                data-testid="portal-checkpoint-resume"
              >
                Continue watching
              </button>
            </div>
          </>
        ) : phase.exhausted ? (
          <>
            <h3 className="font-serif text-xl text-amber-900">
              Let&rsquo;s pause here for now.
            </h3>
            <p className="text-sm text-stone-700">
              You&rsquo;ve used your attempts on this checkpoint. Please speak
              with your manager — they can review the segment with you and
              reopen this checkpoint when you&rsquo;re ready to try again.
            </p>
          </>
        ) : (
          <>
            <h3 className="font-serif text-xl text-amber-900">
              Not quite &mdash; give it another try.
            </h3>
            <p className="text-sm text-stone-700">
              Review the relevant moment in the video, then re-answer the
              question. You have {phase.attemptsRemaining} attempt
              {phase.attemptsRemaining === 1 ? "" : "s"} remaining on this
              checkpoint.
            </p>
            <div className="flex justify-end gap-3">
              <button
                type="button"
                className="btn btn-primary"
                onClick={onRetry}
                data-testid="portal-checkpoint-retry"
              >
                Try again
              </button>
            </div>
          </>
        )}
      </div>
    );
  }
  return null;
}

// EP-TRAIN-4B §3 (2026-10-31): final knowledge test, rendered INSIDE
// the video viewer overlay.  Mirrors the checkpoint overlay surface so
// the employee stays within a single visual context from start to
// finish — no scrolling below the video to begin, submit, or see the
// result.  All state transitions re-use the pre-existing
// onStartAttempt / onSubmitAttempt / onRetake handlers; this component
// is a UI shell only.
function FinalAssessmentPanel({
  phase,
  questions,
  answers,
  busy,
  passingScore,
  retakesAllowed,
  setAnswers,
  onStart,
  onSubmit,
  onRetake,
  onRetry,
}: {
  phase: Extract<Phase, { kind: "finalizing" | "needs-more-viewing" | "quiz-ready" | "quiz-answering" | "grading" | "quiz-result" }>;
  questions: Question[];
  answers: Record<string, string>;
  busy: boolean;
  passingScore: number;
  retakesAllowed: boolean;
  setAnswers: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  onStart: () => void;
  onSubmit: () => void;
  onRetake: () => void;
  // EP-TRAIN-4E A4 (2026-10-31): invoked when the employee hits the
  // "Try again" button on the duration-metadata-missing branch.
  onRetry: () => void;
}) {
  // EP-TRAIN-4D (2026-11-01): bounded transient state while the final
  // progress flush is persisting on the server.  The decision between
  // quiz-ready and needs-more-viewing is server-authoritative and
  // happens in `onEnded` once the server response arrives — this
  // state is purely for the brief window before that.
  if (phase.kind === "finalizing") {
    return (
      <div className="space-y-3" data-testid="portal-course-finalizing">
        <h3 className="font-serif text-xl text-club-ink">
          Finalizing your training progress&hellip;
        </h3>
        <p className="text-sm text-stone-700">
          We&rsquo;re confirming that your viewing time has been recorded.
          This usually takes a moment.
        </p>
      </div>
    );
  }
  if (phase.kind === "needs-more-viewing") {
    return (
      <div className="space-y-3" data-testid="portal-course-needs-more-viewing">
        {phase.reason === "duration-metadata-missing" ? (
          // EP-TRAIN-4E A4 (2026-10-31) — this branch should rarely
          // fire now that uploads measure duration server-side and the
          // one-shot repair fixed legacy rows.  If it does fire (a
          // media object went missing on R2, or ffprobe transiently
          // failed on upload), the employee sees a short, professional
          // "try again" copy with a Retry button — never a "contact
          // your administrator" dead-end.
          <>
            <h3 className="font-serif text-xl text-amber-900">
              We couldn&rsquo;t finish loading this training.
            </h3>
            <p className="text-sm text-stone-700">
              Please try again shortly.
            </p>
            <div className="flex justify-end">
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={onRetry}
                disabled={busy}
                data-testid="portal-course-needs-more-viewing-retry"
              >
                {busy ? "Loading…" : "Try again"}
              </button>
            </div>
          </>
        ) : (
          <>
            <h3 className="font-serif text-xl text-amber-900">
              Just a little more to watch.
            </h3>
            <p className="text-sm text-stone-700">
              You&rsquo;ve completed {phase.percentComplete}% of the training
              video. The knowledge test unlocks at {phase.thresholdPercent}%.
              Review any segments you&rsquo;d like to revisit and the
              assessment will open automatically.
            </p>
          </>
        )}
      </div>
    );
  }
  if (phase.kind === "quiz-ready") {
    return (
      <div className="space-y-4" data-testid="portal-course-quiz-ready">
        <div className="flex items-baseline justify-between gap-3">
          <h3 className="font-serif text-xl text-club-ink">
            Ready for your final knowledge test
          </h3>
          <span className="text-[11px] uppercase tracking-[0.16em] text-stone-500">
            Passing score {passingScore}%
          </span>
        </div>
        <p className="text-sm text-stone-700">
          You&rsquo;ve finished the training video. The knowledge test confirms
          what you&rsquo;ve learned. Your answers will be graded once you submit.
        </p>
        <div className="flex justify-end">
          <button
            type="button"
            className="btn btn-primary"
            onClick={onStart}
            disabled={busy}
            data-testid="portal-course-start-attempt"
          >
            {busy ? "Loading…" : "Start knowledge test"}
          </button>
        </div>
      </div>
    );
  }
  if (phase.kind === "quiz-answering") {
    return (
      <div className="space-y-4" data-testid="portal-course-quiz-answering">
        <div className="flex items-baseline justify-between gap-3">
          <h3 className="font-serif text-xl text-club-ink">Knowledge test</h3>
          <span className="text-[11px] uppercase tracking-[0.16em] text-stone-500">
            Passing score {passingScore}%
          </span>
        </div>
        <div className="space-y-5">
          {questions.map((q, i) => (
            <fieldset
              key={q.id}
              className="space-y-2"
              data-testid={`portal-course-question-${q.id}`}
            >
              <legend className="text-sm text-club-ink">
                <span className="text-[11px] uppercase tracking-[0.16em] text-stone-500 mr-2">
                  Question {i + 1}
                </span>
                {q.prompt}
              </legend>
              <div className="mt-1 space-y-1.5">
                {q.options.map((o) => (
                  <label
                    key={o.id}
                    className={`flex items-center gap-3 px-3 py-2 rounded-md border cursor-pointer ${
                      answers[q.id] === o.id
                        ? "border-club-green-700 bg-club-green-50"
                        : "border-stone-200 hover:bg-stone-50"
                    }`}
                    data-testid={`portal-course-option-${o.id}`}
                  >
                    <input
                      type="radio"
                      name={q.id}
                      value={o.id}
                      checked={answers[q.id] === o.id}
                      onChange={() =>
                        setAnswers((prev) => ({ ...prev, [q.id]: o.id }))
                      }
                      className="accent-club-green-700"
                    />
                    <span className="text-sm text-stone-800">{o.text}</span>
                  </label>
                ))}
              </div>
            </fieldset>
          ))}
        </div>
        <div className="flex items-center justify-end gap-3">
          <button
            type="button"
            className="btn btn-primary"
            onClick={onSubmit}
            disabled={busy || questions.some((q) => !answers[q.id])}
            data-testid="portal-course-submit-attempt"
          >
            {busy ? "Submitting…" : "Submit answers"}
          </button>
        </div>
      </div>
    );
  }
  if (phase.kind === "grading") {
    return (
      <div className="space-y-2" data-testid="portal-course-quiz-grading">
        <h3 className="font-serif text-xl text-club-ink">Grading your answers&hellip;</h3>
        <p className="text-sm text-stone-700">This takes a moment.</p>
      </div>
    );
  }
  // quiz-result
  if (phase.passed) {
    return (
      <div className="space-y-3" data-testid="portal-course-quiz-passed">
        <h3 className="font-serif text-xl text-emerald-900">Excellent work.</h3>
        <p className="text-sm text-stone-700">
          You passed the knowledge test with {phase.score}%. Your training is
          now marked complete.
        </p>
        <div className="flex justify-end">
          <Link
            href="/employee/safety-training"
            className="btn btn-secondary btn-sm"
            data-testid="portal-course-quiz-back-to-dashboard"
          >
            Back to Safety &amp; Training
          </Link>
        </div>
      </div>
    );
  }
  return (
    <div className="space-y-3" data-testid="portal-course-quiz-failed">
      <h3 className="font-serif text-xl text-amber-900">
        Close &mdash; not quite there yet.
      </h3>
      <p className="text-sm text-stone-700">
        You scored {phase.score}%, which is just below the {passingScore}%
        pass mark.
        {retakesAllowed
          ? " When you&rsquo;re ready, take a moment to review the training video and try the knowledge test again."
          : ""}
      </p>
      {retakesAllowed ? (
        <div className="flex items-center justify-end gap-3">
          <Link
            href="/employee/safety-training"
            className="text-xs uppercase tracking-[0.16em] text-stone-500 hover:text-stone-800"
          >
            Back to Safety &amp; Training
          </Link>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={onRetake}
            data-testid="portal-course-quiz-retake"
          >
            Review and retake
          </button>
        </div>
      ) : (
        <p className="text-xs text-stone-700">
          Retakes aren&rsquo;t enabled on this course. Please speak with your
          Club administrator and they&rsquo;ll help you with the next step.
        </p>
      )}
    </div>
  );
}

// EP-TRAIN-4C §2 (2026-10-31) — custom player-control bar with
// integrated checkpoint markers on the actual video seek timeline.
//
// Replaces the native HTML5 `controls` and the earlier separate
// CheckpointMarkersStrip.  There is now exactly ONE playback timeline
// visible to the employee: this control bar's seek track.
//
// Controls preserved from native HTML5 behavior:
//   - Play / pause (button + Space keyboard shortcut)
//   - Current time + duration display
//   - Seek bar with click-to-seek + Left/Right arrow keyboard
//   - Volume + mute (slider + M keyboard)
//   - Playback rate selector (1x / 1.5x / 2x)
//   - Fullscreen button (+ F keyboard)
//
// Checkpoint markers overlay the seek track at their proportional
// timestamps.  Marker colors: cleared = green, upcoming-required =
// amber, upcoming-optional = stone.  Markers are display-only — a
// click on a marker seeks to that timestamp but the existing
// `onSeeking` clamp against the first-uncleared required checkpoint
// IS NOT RELAXED.  No bypass is introduced.
//
// Keyboard accessibility: the seek track is a `role="slider"` with
// `aria-valuemin/max/now`; the control bar is wrapped by a region
// label; every button has an accessible name; focus states are
// visible.
export function PlayerControlBar({
  videoRef,
  sortedCheckpoints,
  cleared,
  videoDurationSec,
  firstUnclearedRequiredAtSecond,
}: {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  sortedCheckpoints: Checkpoint[];
  cleared: Set<string>;
  videoDurationSec: number | null;
  firstUnclearedRequiredAtSecond: number;
}) {
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(videoDurationSec && videoDurationSec > 0 ? videoDurationSec : 0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(1);
  const seekBarRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const onTime = () => setCurrentTime(v.currentTime);
    const onMeta = () => { if (Number.isFinite(v.duration) && v.duration > 0) setDuration(v.duration); };
    const onPlay = () => setIsPlaying(true);
    const onPauseEvt = () => setIsPlaying(false);
    const onVol = () => { setVolume(v.volume); setMuted(v.muted); };
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

  const safeDuration = duration > 0 ? duration : (videoDurationSec && videoDurationSec > 0 ? videoDurationSec : 1);
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
    // onSeeking (attached on the <video>) will clamp against any
    // uncleared required checkpoint — markers CANNOT bypass that.
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
  const clearedCount = sortedCheckpoints.reduce((n, cp) => (cleared.has(cp.id) ? n + 1 : n), 0);

  return (
    <div
      className="bg-stone-50 border-t border-stone-200 px-3 py-2 flex items-center gap-2 flex-wrap md:flex-nowrap"
      role="group"
      aria-label="Video playback controls"
      data-testid="portal-course-player-controls"
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
          const mins = Math.floor(cp.atSecond / 60);
          const secs = Math.floor(cp.atSecond % 60);
          const timeLabel = `${mins}:${secs.toString().padStart(2, "0")}`;
          const statusLabel = isCleared ? "completed" : cp.requiredToProceed ? "upcoming (required)" : "upcoming";
          const classes = isCleared
            ? "bg-club-green-700 border-club-green-800"
            : cp.requiredToProceed
              ? "bg-amber-400 border-amber-600"
              : "bg-white border-stone-500";
          return (
            <span
              key={cp.id}
              className={`absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-3 h-3 rounded-full border-2 shadow-sm ${classes}`}
              style={{ left: `${left}%` }}
              role="img"
              aria-label={`Checkpoint ${i + 1} of ${total} at ${timeLabel}, ${statusLabel}`}
              title={`Checkpoint ${i + 1} at ${timeLabel} — ${statusLabel}`}
              data-testid={`portal-course-checkpoint-marker-${cp.id}`}
              data-checkpoint-status={isCleared ? "completed" : "upcoming"}
            />
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
      {total > 0 && (
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

function formatMMSS(totalSec: number): string {
  if (!Number.isFinite(totalSec) || totalSec < 0) return "0:00";
  const m = Math.floor(totalSec / 60);
  const s = Math.floor(totalSec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}
