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
    | { ok: true; percentComplete: number; videoCompleted: boolean }
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

// Normalise an array of [start, end] intervals: merge overlaps + sort.
// Used to compute unique watched coverage (rewatch doesn't double-count).
function mergeIntervals(intervals: Array<[number, number]>): Array<[number, number]> {
  if (intervals.length === 0) return [];
  const sorted = intervals.map(([s, e]) => [s, e] as [number, number]).sort((a, b) => a[0] - b[0]);
  const out: Array<[number, number]> = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const [s, e] = sorted[i];
    const last = out[out.length - 1];
    if (s <= last[1]) {
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
  const [phase, setPhase] = useState<Phase>({ kind: "video" });
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

  const sendProgress = useCallback(
    async (opts?: { force?: boolean }) => {
      if (!hasVideo) return;
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
        return;
      }
      // Non-force sends respect the inFlight guard to avoid spam;
      // force-sends wait for the current flight to drain then go.
      if (inFlightRef.current && !opts?.force) return;
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
        if (seq < highestResolvedSeqRef.current) return;
        highestResolvedSeqRef.current = seq;
        if ("ok" in result) {
          lastReportedSecondsRef.current = seconds;
          setProgress(() => ({
            secondsWatched: seconds,
            farthestSecond: farthest,
            percentComplete: result.percentComplete,
            videoCompleted: result.videoCompleted,
          }));
        } else {
          setError(result.error);
        }
      } finally {
        inFlightRef.current = false;
      }
    },
    [hasVideo, versionId, recordProgressAction],
  );

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
    if (currentIntervalRef.current) {
      watchedIntervalsRef.current.push([currentIntervalRef.current[0], currentIntervalRef.current[1]]);
      currentIntervalRef.current = null;
    }
    void sendProgress({ force: true });
  }

  function onEnded() {
    if (currentIntervalRef.current) {
      watchedIntervalsRef.current.push([currentIntervalRef.current[0], currentIntervalRef.current[1]]);
      currentIntervalRef.current = null;
    }
    void sendProgress({ force: true });
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
              className="absolute inset-0 w-full h-full"
              controls
              playsInline
              preload="auto"
              src={videoUrl}
              onLoadedMetadata={onLoadedMetadata}
              onTimeUpdate={onTimeUpdate}
              onSeeking={onSeeking}
              onPause={onPause}
              onEnded={onEnded}
              data-testid="portal-course-video"
            >
              Your browser does not support the video tag.
            </video>
            {/* EP-TRAIN-3 Slice 3 (2026-10-29): checkpoint overlay
                dims the video + presents the question UI inline when
                a checkpoint has been triggered or the result is being
                shown. */}
            {(phase.kind === "checkpoint-answering" || phase.kind === "checkpoint-result") && (
              <div
                className="absolute inset-0 flex items-center justify-center bg-stone-900/85 p-4 overflow-y-auto"
                data-testid="portal-checkpoint-overlay"
              >
                <div className="max-w-2xl w-full bg-white rounded-lg shadow-xl p-6 space-y-4 my-auto">
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
                </div>
              </div>
            )}
          </div>
          <div className="px-5 py-3 border-t border-stone-200 flex items-center justify-between gap-4">
            <div className="flex-1 min-w-0">
              <div className="text-[11px] uppercase tracking-[0.16em] text-stone-500">
                Watch progress
              </div>
              <div className="mt-1 h-1.5 rounded-full bg-stone-200 overflow-hidden">
                <div
                  className="h-full bg-club-green-700 transition-all"
                  style={{ width: `${percentDisplay}%` }}
                  aria-hidden
                />
              </div>
            </div>
            <div
              className="text-sm text-stone-700 tabular-nums"
              data-testid="portal-course-progress-percent"
            >
              {percentDisplay}%
            </div>
          </div>
        </section>
      )}

      {/* Quiz block */}
      {requiresKnowledgeTest && !alreadyCompleted && !blockingSubmittedAttempt && (
        <section
          className="rounded-lg border border-stone-200 bg-white px-5 py-5"
          data-testid="portal-course-quiz-section"
        >
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="font-serif text-xl text-club-ink">Knowledge test</h2>
            <span className="text-[11px] uppercase tracking-[0.16em] text-stone-500">
              Passing score {passingScore}%
            </span>
          </div>

          {phase.kind === "video" && !videoUnlocked && (
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
          )}

          {phase.kind === "video" && videoUnlocked && (
            <div className="mt-4" data-testid="portal-course-quiz-ready">
              <p className="text-sm text-stone-700">
                You&rsquo;re ready to take the knowledge test. Your answers will
                be graded once you submit.
              </p>
              <button
                type="button"
                className="btn btn-primary mt-3"
                onClick={onStartAttempt}
                disabled={busy}
                data-testid="portal-course-start-attempt"
              >
                {busy ? "Loading…" : "Start knowledge test"}
              </button>
            </div>
          )}

          {phase.kind === "quiz-answering" && (
            <div className="mt-4 space-y-6" data-testid="portal-course-quiz-answering">
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
              <div className="flex items-center justify-end gap-3">
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={onSubmitAttempt}
                  disabled={
                    busy || questions.some((q) => !answers[q.id])
                  }
                  data-testid="portal-course-submit-attempt"
                >
                  {busy ? "Submitting…" : "Submit answers"}
                </button>
              </div>
            </div>
          )}

          {phase.kind === "grading" && (
            <div className="mt-4 text-sm text-stone-600" data-testid="portal-course-quiz-grading">
              Grading your answers…
            </div>
          )}

          {phase.kind === "quiz-result" && phase.passed && (
            <div
              className="mt-4 rounded-md border border-emerald-200 bg-emerald-50/70 px-4 py-3"
              data-testid="portal-course-quiz-passed"
            >
              <p className="text-sm text-emerald-900">
                <strong>Training complete.</strong> Score: {phase.score}%.
              </p>
              <div className="mt-3">
                <Link
                  href="/employee/safety-training"
                  className="btn btn-secondary btn-sm"
                  data-testid="portal-course-quiz-back-to-dashboard"
                >
                  Back to Safety &amp; Training
                </Link>
              </div>
            </div>
          )}

          {phase.kind === "quiz-result" && !phase.passed && (
            <div
              className="mt-4 rounded-md border border-amber-200 bg-amber-50/70 px-4 py-3"
              data-testid="portal-course-quiz-failed"
            >
              <p className="text-sm text-amber-900">
                <strong>Not passed yet.</strong> Score: {phase.score}%. Review
                the training material and try again.
              </p>
              {retakesAllowed ? (
                <div className="mt-3 flex items-center gap-3">
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={onRetake}
                    data-testid="portal-course-quiz-retake"
                  >
                    Try again
                  </button>
                  <Link
                    href="/employee/safety-training"
                    className="text-xs uppercase tracking-[0.16em] text-stone-500 hover:text-stone-800"
                  >
                    Back to Safety &amp; Training
                  </Link>
                </div>
              ) : (
                <p className="mt-2 text-xs text-stone-700">
                  Retakes aren&rsquo;t allowed on this course. Speak with your
                  Club administrator.
                </p>
              )}
            </div>
          )}

          {error && (
            <div
              role="alert"
              className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
              data-testid="portal-course-error"
            >
              {error}
            </div>
          )}
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
    return (
      <div className="space-y-4" data-testid="portal-checkpoint-result">
        {phase.passed ? (
          <>
            <h3 className="font-serif text-xl text-emerald-900">Checkpoint cleared</h3>
            <p className="text-sm text-stone-700">Great. Playback resumes from where you paused.</p>
            <div className="flex justify-end">
              <button
                type="button"
                className="btn btn-primary"
                onClick={onResume}
                data-testid="portal-checkpoint-resume"
              >
                Resume video
              </button>
            </div>
          </>
        ) : phase.exhausted ? (
          <>
            <h3 className="font-serif text-xl text-amber-900">No retries remaining</h3>
            <p className="text-sm text-stone-700">
              Please contact your manager. They can reset this checkpoint.
            </p>
          </>
        ) : (
          <>
            <h3 className="font-serif text-xl text-amber-900">Not quite</h3>
            <p className="text-sm text-stone-700">
              Review the segment and try again. You have {phase.attemptsRemaining} attempt{phase.attemptsRemaining === 1 ? "" : "s"} left.
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
