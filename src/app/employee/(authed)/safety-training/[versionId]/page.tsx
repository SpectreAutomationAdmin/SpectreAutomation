// HR-2C B3 §3-16 (2026-08-20) + EP-UX-2 (2026-11-01) redesign.
//
// Loads a single applicable published course via canonical B1
// employee-safe reads (`getEmployeeCourseView`, `getProgress`,
// `getEmployeeAttemptHistory`) and hands the whole payload to the
// EP-TRAIN-4E client player.
//
// EP-UX-2 — the surrounding layout is rebuilt to the founder-approved
// reference (`docs/design/ep-ux-2/ep-ux-2-course-reference.png`):
//
//   1. Hero: play icon + title + metadata chip row
//      (Completed/In Progress/Not Started | Type | Duration |
//       Completed date | Score)
//   2. Two-column body (desktop 70/30):
//        - LEFT  CoursePlayer (unchanged; EP-TRAIN-4E frozen)
//        - RIGHT TrainingStatusPanel (variant per state)
//   3. Tabs: About This Course | Course Content | Your Result
//
// The CoursePlayer props stanza is preserved verbatim — EP-TRAIN-4E
// through EP-TRAIN-4E-2A are frozen functional baselines.
//
// Ownership discipline (unchanged):
//   - Never joins back through prisma to read admin fields.
//   - Never surfaces version id / course code / storage key in copy.
//   - Reads through the EmployeePortalPrincipal only — an admin
//     Principal cannot enter this page.

import { notFound, redirect } from "next/navigation";
import { getEmployeePortalPrincipal } from "@/lib/employee-portal-session";
import {
  getEmployeeCourseView,
  getEmployeeAttemptHistory,
} from "@/lib/hr/training/employee-read";
import { getProgress, VIDEO_COMPLETION_THRESHOLD_PERCENT } from "@/lib/hr/training/attempts";
import { resolveApplicableCourses } from "@/lib/hr/training/applicability";
import { getPlayerState } from "@/lib/hr/training/attempts";
import {
  getEmployeeTrainingRecommendations,
  isLikelyStagingFixtureText,
} from "@/lib/hr/training/employee-recommendations";
import { prisma } from "@/lib/prisma";
import CoursePlayer from "./CoursePlayer";
import RecommendationsRail from "./RecommendationsRail";
import { RegisterBreadcrumbLabel } from "@/components/spectre/breadcrumb-labels";
import TrainingTabs from "@/components/employee/safety-training/TrainingTabs";
import {
  recordVideoProgressAction,
  startAttemptAction,
  submitAttemptAction,
  startCheckpointAttemptAction,
} from "../_actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type AttemptSummary = Awaited<ReturnType<typeof getEmployeeAttemptHistory>>[number];

function formatCompleted(d: Date | null | undefined): string {
  if (!d) return "";
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function formatDuration(seconds: number | null | undefined): string {
  if (!seconds || !Number.isFinite(seconds) || seconds <= 0) return "";
  if (seconds < 60) return `${Math.round(seconds)} second${seconds === 1 ? "" : "s"}`;
  const mins = Math.floor(seconds / 60);
  const rem = Math.round(seconds - mins * 60);
  if (rem === 0) return `${mins} min`;
  return `${mins} min ${rem} sec`;
}

function courseTypeLabel(view: { version: { hasVideo: boolean; requiresKnowledgeTest: boolean } }): string {
  const hasVideo = view.version.hasVideo;
  const hasAssessment = view.version.requiresKnowledgeTest;
  if (hasVideo && hasAssessment) return "Video + Assessment";
  if (hasVideo) return "Video Only";
  if (hasAssessment) return "Assessment";
  return "Course";
}

export default async function EmployeeCoursePage({
  params,
}: {
  params: Promise<{ versionId: string }>;
}) {
  const principal = await getEmployeePortalPrincipal();
  if (!principal) redirect("/employee/login");

  const { versionId } = await params;

  const applicable = await resolveApplicableCourses(principal.employeeId);
  const match = applicable.find((a) => a.version.id === versionId);
  if (!match) notFound();

  let view;
  try {
    view = await getEmployeeCourseView(principal, versionId);
  } catch {
    notFound();
  }

  const [progress, attempts, completion, recommendations, playerState] = await Promise.all([
    getProgress(principal, versionId),
    getEmployeeAttemptHistory(principal, versionId),
    prisma.trainingCompletion.findUnique({
      where: {
        employeeId_courseVersionId: {
          employeeId: principal.employeeId,
          courseVersionId: versionId,
        },
      },
      select: { id: true, completedAt: true, score: true },
    }),
    getEmployeeTrainingRecommendations({
      employeeId: principal.employeeId,
      excludeVersionId: versionId,
      limit: 6,
    }),
    getPlayerState(principal, versionId),
  ]);
  const initialClearedCheckpointIds = playerState.checkpoints.filter((c) => c.cleared).map((c) => c.id);

  const submittedAttempts = attempts.filter((a) => a.submittedAt !== null);
  const canRetake =
    view.version.retakesAllowed && !completion && submittedAttempts.length > 0;
  const hasBlockingSubmittedAttempt =
    !view.version.retakesAllowed && submittedAttempts.some((a) => !a.passed);

  const initialProgress = progress ?? {
    secondsWatched: 0,
    farthestSecond: 0,
    percentComplete: 0,
    videoCompleted: false,
  };

  // EP-TRAIN-2 §1-§3 (2026-10-29): staging-fixture copy filter.
  const safeDescription = isLikelyStagingFixtureText(view.description) ? null : view.description;
  const safeTitle = isLikelyStagingFixtureText(view.title) ? view.category : view.title;

  // EP-UX-2 — classify course state for the hero chip row + the
  // right-side status panel.  Server-authoritative: `completion` row
  // is the only source of "completed" (EP-TRAIN-4E rule).
  const state: "completed" | "in-progress" | "not-started" =
    completion !== null
      ? "completed"
      : initialProgress.farthestSecond > 0 || submittedAttempts.length > 0
        ? "in-progress"
        : "not-started";

  const durationLabel = formatDuration(view.version.videoDurationSec);
  const typeLabel = courseTypeLabel(view);

  return (
    <div
      className="w-full px-6 md:px-8 py-6 md:py-8 max-w-[1600px]"
      data-testid="portal-course"
    >
      <RegisterBreadcrumbLabel id={versionId} label={safeTitle} />

      {/* ------------------------------------------------------------
          §10 — Course header (title + metadata chip row) */}
      <header className="mb-6" data-testid="portal-course-header">
        <h1
          className="font-serif text-3xl md:text-4xl text-club-ink leading-tight flex items-center gap-3"
          data-testid="portal-course-title"
        >
          <PlayCircle className="text-club-green-800" />
          <span>{safeTitle}</span>
        </h1>
        <div
          className="mt-3 flex items-center gap-x-5 gap-y-2 flex-wrap text-sm text-stone-600"
          data-testid="portal-course-metadata"
        >
          <StatePill state={state} />
          <span className="inline-flex items-center gap-1.5" data-testid="portal-course-meta-type">
            <DocIcon /> {typeLabel}
          </span>
          {durationLabel && (
            <span className="inline-flex items-center gap-1.5" data-testid="portal-course-meta-duration">
              <ClockIcon /> {durationLabel}
            </span>
          )}
          {completion && (
            <span className="inline-flex items-center gap-1.5" data-testid="portal-course-meta-completed-date">
              <CalendarIcon /> Completed {formatCompleted(completion.completedAt)}
            </span>
          )}
          {completion && (
            <span
              className="inline-flex items-center rounded-full bg-emerald-50 text-emerald-800 border border-emerald-200 px-2.5 py-0.5 text-xs font-semibold"
              data-testid="portal-course-meta-score"
            >
              Score: {completion.score}%
            </span>
          )}
        </div>
      </header>

      {/* ------------------------------------------------------------
          §11 — Two-column: CoursePlayer (left) + TrainingStatusPanel (right)
          Mobile stacks (single column); tablet single column; desktop ≥ lg
          switches to 70/30 — matches founder reference. */}
      <div
        id="course-video"
        className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_340px] xl:grid-cols-[minmax(0,1fr)_380px] gap-6 lg:gap-8"
      >
        {/* LEFT — CoursePlayer (EP-TRAIN-4E, unchanged props) */}
        <div className="min-w-0 space-y-6">
          <CoursePlayer
            versionId={versionId}
            hasVideo={view.version.hasVideo}
            videoDurationSec={view.version.videoDurationSec}
            requiresKnowledgeTest={view.version.requiresKnowledgeTest}
            passingScore={view.version.passingScore}
            retakesAllowed={view.version.retakesAllowed}
            thresholdPercent={VIDEO_COMPLETION_THRESHOLD_PERCENT}
            initialProgress={initialProgress}
            questions={view.questions}
            checkpoints={view.checkpoints}
            initialClearedCheckpointIds={initialClearedCheckpointIds}
            alreadyCompleted={completion !== null}
            canRetake={canRetake}
            blockingSubmittedAttempt={hasBlockingSubmittedAttempt}
            submittedAttempts={submittedAttempts.map((a) => ({
              attemptNumber: a.attemptNumber,
              score: a.score,
              passed: a.passed,
              submittedAt: a.submittedAt ? a.submittedAt.toISOString() : null,
            }))}
            recordProgressAction={recordVideoProgressAction}
            startAttemptAction={startAttemptAction}
            submitAttemptAction={submitAttemptAction}
            startCheckpointAttemptAction={startCheckpointAttemptAction}
          />
        </div>

        {/* RIGHT — Training Status Panel */}
        <TrainingStatusPanel
          state={state}
          completion={completion}
          progressPercent={initialProgress.percentComplete}
          attemptCount={submittedAttempts.length}
          passingScore={view.version.passingScore}
          thresholdPercent={VIDEO_COMPLETION_THRESHOLD_PERCENT}
        />
      </div>

      {/* ------------------------------------------------------------
          §14 — Course detail tabs */}
      <div className="mt-12">
        <TrainingTabs
          testIdPrefix="portal-course-tabs"
          tabs={[
            {
              id: "about",
              label: "About This Course",
              content: (
                <AboutThisCoursePanel
                  description={safeDescription}
                  typeLabel={typeLabel}
                  durationLabel={durationLabel}
                  passingScore={view.version.passingScore}
                  thresholdPercent={VIDEO_COMPLETION_THRESHOLD_PERCENT}
                  requiresKnowledgeTest={view.version.requiresKnowledgeTest}
                  hasVideo={view.version.hasVideo}
                />
              ),
            },
            {
              id: "content",
              label: "Course Content",
              content: (
                <CourseContentPanel
                  hasVideo={view.version.hasVideo}
                  checkpointCount={view.checkpoints.length}
                  requiresKnowledgeTest={view.version.requiresKnowledgeTest}
                  questionCount={view.questions.length}
                />
              ),
            },
            {
              id: "result",
              label: "Your Result",
              content: (
                <YourResultPanel
                  state={state}
                  completion={completion}
                  attempts={submittedAttempts}
                  passingScore={view.version.passingScore}
                />
              ),
            },
          ]}
        />
      </div>

      {/* Recommended Training rail — retained from HR-2C B3, moved
         below the primary content so it never visually competes with
         the active course per EP-UX-2 §8. */}
      {recommendations.recommendations.length > 0 && (
        <div className="mt-10">
          <RecommendationsRail recommendations={recommendations.recommendations} />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Panels + reusable bits
// ---------------------------------------------------------------------------

function StatePill({ state }: { state: "completed" | "in-progress" | "not-started" }) {
  if (state === "completed") {
    return (
      <span
        className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 text-emerald-800 border border-emerald-200 px-2.5 py-0.5 text-xs font-semibold"
        data-testid="portal-course-state-pill"
      >
        <SmallCheck /> Completed
      </span>
    );
  }
  if (state === "in-progress") {
    return (
      <span
        className="inline-flex items-center gap-1.5 rounded-full bg-amber-50 text-amber-800 border border-amber-200 px-2.5 py-0.5 text-xs font-semibold"
        data-testid="portal-course-state-pill"
      >
        In Progress
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full bg-stone-100 text-stone-700 border border-stone-200 px-2.5 py-0.5 text-xs font-semibold"
      data-testid="portal-course-state-pill"
    >
      Not Started
    </span>
  );
}

function TrainingStatusPanel({
  state,
  completion,
  progressPercent,
  attemptCount,
  passingScore,
  thresholdPercent,
}: {
  state: "completed" | "in-progress" | "not-started";
  completion: { id: string; completedAt: Date; score: number } | null;
  progressPercent: number;
  attemptCount: number;
  passingScore: number;
  thresholdPercent: number;
}) {
  if (state === "completed" && completion) {
    return (
      <aside
        className="h-fit rounded-xl border border-stone-200 bg-white p-6"
        data-testid="portal-course-status-panel"
      >
        <div className="flex items-center gap-3">
          <div className="h-9 w-9 rounded-full bg-emerald-100 flex items-center justify-center text-emerald-800">
            <CheckIcon />
          </div>
          <h2 className="font-serif text-xl text-club-ink">Training Complete</h2>
        </div>
        <p className="mt-3 text-sm text-stone-600 leading-relaxed">
          You’ve completed this course and passed the final knowledge test.
        </p>
        <div className="my-5 h-px bg-stone-200" />
        <MetricRow icon={<RibbonIcon />} label="Your score" value={`${completion.score}%`} />
        <MetricRow icon={<CalendarIcon />} label="Completed" value={formatCompleted(completion.completedAt)} />
        <MetricRow icon={<CountIcon />} label="Attempts" value={attemptCount.toString()} />
        <a
          href="#course-video"
          className="mt-5 w-full inline-flex items-center justify-center gap-2 rounded-md border border-club-green-800 bg-white text-club-green-800 hover:bg-club-green-50 text-sm font-semibold px-4 py-2.5"
          data-testid="portal-course-replay"
        >
          <PlayIcon /> Replay Training
        </a>
      </aside>
    );
  }
  if (state === "in-progress") {
    return (
      <aside
        className="h-fit rounded-xl border border-stone-200 bg-white p-6"
        data-testid="portal-course-status-panel"
      >
        <h2 className="font-serif text-xl text-club-ink">Continue Your Training</h2>
        <p className="mt-3 text-sm text-stone-600 leading-relaxed">
          You’re {progressPercent}% through the training video. The knowledge
          test unlocks at {thresholdPercent}%.
        </p>
        <div className="my-5 h-2 w-full rounded-full bg-stone-100 overflow-hidden">
          <div
            className="h-full bg-club-green-800"
            style={{ width: `${Math.max(0, Math.min(100, progressPercent))}%` }}
          />
        </div>
        <a
          href="#course-video"
          className="w-full inline-flex items-center justify-center gap-2 rounded-md bg-club-green-800 text-white hover:bg-club-green-900 text-sm font-semibold px-4 py-2.5"
          data-testid="portal-course-continue"
        >
          <PlayIcon /> Continue Training
        </a>
      </aside>
    );
  }
  // not-started
  return (
    <aside
      className="h-fit rounded-xl border border-stone-200 bg-white p-6"
      data-testid="portal-course-status-panel"
    >
      <h2 className="font-serif text-xl text-club-ink">Ready to Begin</h2>
      <p className="mt-3 text-sm text-stone-600 leading-relaxed">
        Watch at least {thresholdPercent}% of the training video, clear every
        checkpoint, then pass the final knowledge test with a score of at
        least {passingScore}%.
      </p>
      <a
        href="#course-video"
        className="mt-5 w-full inline-flex items-center justify-center gap-2 rounded-md bg-club-green-800 text-white hover:bg-club-green-900 text-sm font-semibold px-4 py-2.5"
        data-testid="portal-course-start"
      >
        <PlayIcon /> Start Training
      </a>
    </aside>
  );
}

function MetricRow({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="flex items-center justify-between py-2 text-sm">
      <span className="flex items-center gap-2 text-stone-600">
        <span className="text-stone-500">{icon}</span>
        {label}
      </span>
      <span className="font-semibold text-club-ink tabular-nums">{value}</span>
    </div>
  );
}

function AboutThisCoursePanel({
  description,
  typeLabel,
  durationLabel,
  passingScore,
  thresholdPercent,
  requiresKnowledgeTest,
  hasVideo,
}: {
  description: string | null;
  typeLabel: string;
  durationLabel: string;
  passingScore: number;
  thresholdPercent: number;
  requiresKnowledgeTest: boolean;
  hasVideo: boolean;
}) {
  const completionCopy = hasVideo && requiresKnowledgeTest
    ? `Watch at least ${thresholdPercent}% of the video and pass the final assessment (≥ ${passingScore}%).`
    : hasVideo
      ? `Watch at least ${thresholdPercent}% of the video.`
      : `Pass the final assessment (≥ ${passingScore}%).`;
  return (
    <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_280px] gap-10">
      <div className="min-w-0">
        <h3 className="font-serif text-xl text-club-ink">Course Overview</h3>
        {description ? (
          <p className="mt-3 text-sm text-stone-700 leading-relaxed">{description}</p>
        ) : (
          <p className="mt-3 text-sm text-stone-500 leading-relaxed italic">
            No overview provided.
          </p>
        )}
      </div>
      <aside className="min-w-0 space-y-5">
        <AboutMetaRow icon={<DocIcon />} label="Format" value={typeLabel} />
        {durationLabel && (
          <AboutMetaRow icon={<ClockIcon />} label="Duration" value={durationLabel} />
        )}
        <AboutMetaRow icon={<CheckSquareIcon />} label="Completion Requirement" value={completionCopy} />
      </aside>
    </div>
  );
}

function AboutMetaRow({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="flex items-start gap-3">
      <div className="h-9 w-9 rounded-md bg-stone-100 flex items-center justify-center text-stone-500 shrink-0">
        {icon}
      </div>
      <div className="min-w-0">
        <div className="text-xs font-semibold uppercase tracking-wide text-stone-500">{label}</div>
        <div className="mt-0.5 text-sm text-stone-700">{value}</div>
      </div>
    </div>
  );
}

function CourseContentPanel({
  hasVideo,
  checkpointCount,
  requiresKnowledgeTest,
  questionCount,
}: {
  hasVideo: boolean;
  checkpointCount: number;
  requiresKnowledgeTest: boolean;
  questionCount: number;
}) {
  const items: Array<{ icon: React.ReactNode; title: string; detail: string }> = [];
  if (hasVideo) items.push({ icon: <PlayCircle />, title: "Video lesson", detail: "Core instructional material presented through video." });
  if (checkpointCount > 0) items.push({ icon: <CheckSquareIcon />, title: "Interactive checkpoints", detail: `${checkpointCount} knowledge check${checkpointCount === 1 ? "" : "s"} during the video.` });
  if (requiresKnowledgeTest) {
    // Note: questionCount includes checkpoint questions.  Final-
    // assessment-only count isn't surfaced by the employee-safe view,
    // so we describe the final assessment without a bare question count
    // to avoid misleading math.
    items.push({ icon: <RibbonIcon />, title: "Final knowledge assessment", detail: "Graded by the server; passing score required to complete the course." });
  }
  if (items.length === 0) {
    return (
      <p className="text-sm text-stone-500 italic">
        No course content configured yet.
      </p>
    );
  }
  return (
    <ul className="space-y-3 max-w-3xl">
      {items.map((it, i) => (
        <li key={i} className="flex items-start gap-4 rounded-lg border border-stone-200 bg-white p-5">
          <div className="h-10 w-10 rounded-full bg-club-green-50 text-club-green-800 flex items-center justify-center shrink-0">
            {it.icon}
          </div>
          <div className="min-w-0">
            <div className="font-semibold text-club-ink">{it.title}</div>
            <div className="mt-1 text-sm text-stone-600">{it.detail}</div>
          </div>
        </li>
      ))}
    </ul>
  );
}

function YourResultPanel({
  state,
  completion,
  attempts,
  passingScore,
}: {
  state: "completed" | "in-progress" | "not-started";
  completion: { id: string; completedAt: Date; score: number } | null;
  attempts: AttemptSummary[];
  passingScore: number;
}) {
  if (state === "completed" && completion) {
    return (
      <div className="space-y-6 max-w-3xl">
        <div className="rounded-xl border border-emerald-200 bg-emerald-50/60 p-5">
          <div className="flex items-center gap-3">
            <div className="h-9 w-9 rounded-full bg-emerald-100 text-emerald-800 flex items-center justify-center">
              <CheckIcon />
            </div>
            <div>
              <div className="font-semibold text-emerald-900">Completed</div>
              <div className="text-sm text-emerald-800/90">
                You passed on {formatCompleted(completion.completedAt)}.
              </div>
            </div>
          </div>
          <div className="mt-5 grid grid-cols-1 sm:grid-cols-3 gap-5 text-sm">
            <ResultCell label="Verified score" value={`${completion.score}%`} />
            <ResultCell label="Passing score" value={`${passingScore}%`} />
            <ResultCell label="Attempts" value={attempts.length.toString()} />
          </div>
        </div>
        {attempts.length > 0 && (
          <div>
            <h3 className="font-serif text-lg text-club-ink">Attempt history</h3>
            <ul className="mt-3 space-y-2">
              {attempts.map((a) => (
                <li
                  key={a.id}
                  className="flex items-center justify-between rounded-lg border border-stone-200 bg-white px-4 py-2.5 text-sm"
                >
                  <span className="text-stone-700">Attempt {a.attemptNumber}</span>
                  <span className="tabular-nums">
                    {a.score}% ·{" "}
                    <span className={a.passed ? "text-emerald-800 font-semibold" : "text-amber-800 font-semibold"}>
                      {a.passed ? "Passed" : "Not passed"}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    );
  }
  return (
    <div className="rounded-xl border border-stone-200 bg-white p-6 text-sm text-stone-600 max-w-3xl">
      Results will appear here after you complete the final knowledge test.
    </div>
  );
}

function ResultCell({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs font-semibold uppercase tracking-wide text-emerald-800/80">{label}</div>
      <div className="mt-1 text-xl font-semibold text-club-ink tabular-nums">{value}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Icons (inline SVG — no deps)
// ---------------------------------------------------------------------------

function PlayCircle({ className = "" }: { className?: string }) {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <circle cx="12" cy="12" r="10" />
      <path d="M10 8l6 4-6 4z" fill="currentColor" />
    </svg>
  );
}

function PlayIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M8 5v14l11-7z" />
    </svg>
  );
}

function DocIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </svg>
  );
}

function ClockIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
  );
}

function CalendarIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="4" width="18" height="17" rx="2" />
      <path d="M3 9h18" />
      <path d="M8 2v4M16 2v4" />
    </svg>
  );
}

function RibbonIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="9" r="6" />
      <path d="M8.5 14l-2 7 5.5-3 5.5 3-2-7" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 12l5 5L20 7" />
    </svg>
  );
}

function SmallCheck() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 12l5 5L20 7" />
    </svg>
  );
}

function CheckSquareIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="3" width="18" height="18" rx="3" />
      <path d="M8 12l3 3 5-6" />
    </svg>
  );
}

function CountIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <text x="12" y="16" textAnchor="middle" fontSize="10" fontWeight="700" fill="currentColor" stroke="none">#</text>
    </svg>
  );
}
