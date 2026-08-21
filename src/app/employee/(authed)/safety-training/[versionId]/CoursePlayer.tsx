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

type Question = {
  id: string;
  prompt: string;
  options: Array<{ id: string; text: string; displayOrder: number }>;
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
    answers: Array<{ questionId: string; selectedOptionId: string }>,
  ) => Promise<
    | { ok: true; score: number; passed: boolean; completionId: string | null }
    | { error: string }
  >;
}

type Phase =
  | { kind: "video" }
  | { kind: "quiz-answering"; attemptId: string; attemptNumber: number }
  | { kind: "grading" }
  | {
      kind: "quiz-result";
      score: number;
      passed: boolean;
    };

const REPORT_INTERVAL_SECONDS = 15;
const MAX_DT_PER_TICK = 2; // seek jumps > 2s ignored for secondsWatched

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
    alreadyCompleted,
    canRetake,
    blockingSubmittedAttempt,
    submittedAttempts,
    recordProgressAction,
    startAttemptAction,
    submitAttemptAction,
  } = props;

  const router = useRouter();

  const [progress, setProgress] = useState<ProgressRow>(initialProgress);
  const [phase, setPhase] = useState<Phase>({ kind: "video" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [answers, setAnswers] = useState<Record<string, string>>({});

  // Progress accumulators
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const secondsWatchedRef = useRef(initialProgress.secondsWatched);
  const farthestRef = useRef(initialProgress.farthestSecond);
  const lastTimeRef = useRef(initialProgress.farthestSecond);
  const lastReportedSecondsRef = useRef(initialProgress.secondsWatched);
  const inFlightRef = useRef(false);

  const videoUrl = `/api/hr/training/versions/${encodeURIComponent(versionId)}/video`;

  // -------------------------------------------------------------------------
  // Progress reporting
  // -------------------------------------------------------------------------

  const sendProgress = useCallback(
    async (opts?: { force?: boolean }) => {
      if (!hasVideo) return;
      const seconds = secondsWatchedRef.current;
      const farthest = farthestRef.current;
      if (!opts?.force && seconds - lastReportedSecondsRef.current < REPORT_INTERVAL_SECONDS) {
        return;
      }
      if (inFlightRef.current) return;
      inFlightRef.current = true;
      try {
        const result = await recordProgressAction(versionId, {
          secondsWatched: Math.floor(seconds),
          farthestSecond: Math.floor(farthest),
        });
        if ("ok" in result) {
          lastReportedSecondsRef.current = seconds;
          setProgress((p) => ({
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
    const dt = now - lastTimeRef.current;
    lastTimeRef.current = now;
    if (dt > 0 && dt <= MAX_DT_PER_TICK) {
      // Real playback delta — accumulate.
      secondsWatchedRef.current += dt;
    }
    if (now > farthestRef.current) farthestRef.current = now;
    // Debounced network write — bounded to REPORT_INTERVAL_SECONDS.
    void sendProgress();
  }

  function onPause() {
    void sendProgress({ force: true });
  }

  function onEnded() {
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
      {/* Video block */}
      {hasVideo && (
        <section
          className="rounded-lg border border-stone-200 bg-white overflow-hidden"
          data-testid="portal-course-video-section"
        >
          <div className="bg-stone-900">
            <video
              ref={videoRef}
              className="w-full max-h-[70vh]"
              controls
              playsInline
              preload="metadata"
              src={videoUrl}
              onLoadedMetadata={onLoadedMetadata}
              onTimeUpdate={onTimeUpdate}
              onPause={onPause}
              onEnded={onEnded}
              data-testid="portal-course-video"
            >
              Your browser does not support the video tag.
            </video>
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
