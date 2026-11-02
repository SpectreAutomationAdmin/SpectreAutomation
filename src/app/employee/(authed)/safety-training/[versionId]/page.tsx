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
import Link from "next/link";
import { getEmployeePortalPrincipal } from "@/lib/employee-portal-session";
import {
  getEmployeeCourseView,
  getEmployeeAttemptHistory,
} from "@/lib/hr/training/employee-read";
import { getProgress, VIDEO_COMPLETION_THRESHOLD_PERCENT } from "@/lib/hr/training/attempts";
import {
  resolveApplicableCourses,
  resolveEmployeeSchedulingEligibility,
} from "@/lib/hr/training/applicability";
import { getPlayerState } from "@/lib/hr/training/attempts";
// EP-TRAIN-5C-3 (2026-11-02) -- obligation-aware state for the course
// page.  resolveActiveObligationForSession returns null when no
// OUTSTANDING obligation exists on (employee, courseVersion), so pre-
// 5B employees + employees on prod (where TrainingObligation is 0 rows
// pending 5C-4) see byte-for-byte the pre-5C-3 EP-UX-2D behavior.
import { resolveActiveObligationForSession } from "@/lib/hr/training/training-session";
import { isLikelyStagingFixtureText } from "@/lib/hr/training/employee-recommendations";
import { prisma } from "@/lib/prisma";
import CoursePlayer from "./CoursePlayer";
// EP-UX-2C §3 (2026-11-01) — the standalone Recommended Training
// section was removed from this page; the right-hand Required
// Training rail is now the sole secondary-course surface.
import { RegisterBreadcrumbLabel } from "@/components/spectre/breadcrumb-labels";
import TrainingTabs from "@/components/employee/safety-training/TrainingTabs";
import RequiredCardThumbnail from "@/components/employee/safety-training/RequiredCardThumbnail";
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

  // EP-TRAIN-5C-3C (2026-11-02) — resolve the active obligation FIRST
  // so the progress query that follows can be scoped to the right
  // row.  Without this, Keep Both employees (two OUTSTANDING
  // MANUAL_REINSTATE obligations) see the first obligation's SATISFIED
  // progress row (farthestSecond=42) picked by findFirst → second
  // lifecycle short-circuits to "in-progress" state + seeds the player
  // at the end of the video — CP1 overlay never fires.
  const activeObligation = await resolveActiveObligationForSession({
    employeeId: principal.employeeId,
    courseVersionId: versionId,
  });

  const [progress, attempts, completion, playerState, eligibility] = await Promise.all([
    getProgress(principal, versionId, { obligationId: activeObligation?.id ?? null }),
    getEmployeeAttemptHistory(principal, versionId),
    // EP-TRAIN-5A-1 (2026-11-01) -- the (employeeId, courseVersionId)
    // UNIQUE is lifted so a MANUAL_REINSTATE / REVISION retake can
    // produce a second legitimate completion.  For the course page
    // we want the LATEST completion (which drives the "already
    // completed" replay state the Training Status card renders).
    prisma.trainingCompletion.findFirst({
      where: { employeeId: principal.employeeId, courseVersionId: versionId },
      orderBy: { completedAt: "desc" },
      select: { id: true, completedAt: true, score: true },
    }),
    getPlayerState(principal, versionId),
    // EP-UX-2B (2026-11-01) — the Required Training rail reads from
    // the same server-authoritative eligibility resolver the dashboard
    // uses.  Only tenant-scoped, applicable, uncompleted, required
    // courses appear.
    resolveEmployeeSchedulingEligibility(principal.employeeId),
  ]);
  const initialClearedCheckpointIds = playerState.checkpoints.filter((c) => c.cleared).map((c) => c.id);

  const submittedAttempts = attempts.filter((a) => a.submittedAt !== null);
  // EP-TRAIN-5C-3 — when an active OUTSTANDING obligation exists, the
  // course is NOT "already completed" from the employee's current
  // compliance perspective (even if a historical completion row
  // exists).  Historical rows remain visible in Your Result + the
  // Training History display; this flag drives the player state only.
  const treatAsCurrentlyCompleted = activeObligation
    // An obligation satisfied mid-render (race) can also satisfy the
    // "already complete" short-circuit so the UI doesn't offer a new
    // attempt against a session that just resolved.
    ? false
    : completion !== null;
  const canRetake =
    view.version.retakesAllowed && !treatAsCurrentlyCompleted && submittedAttempts.length > 0;
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
  //
  // EP-TRAIN-5C-3 — when an active OUTSTANDING obligation exists it
  // takes precedence over any historical completion row.  The state
  // becomes "updated-required" (REVISION) / "retake-required"
  // (MANUAL_REINSTATE) / "initial-required" (INITIAL / fallback) or
  // "in-progress" when the retake session has already advanced.
  const state: "completed" | "in-progress" | "not-started" | "updated-required" | "retake-required" | "initial-required" =
    activeObligation
      ? (initialProgress.farthestSecond > 0 || submittedAttempts.some((a) => a.submittedAt !== null && (a as unknown as { obligationId?: string | null }).obligationId === activeObligation.id)
          ? "in-progress"
          : activeObligation.reason === "REVISION"
            ? "updated-required"
            : activeObligation.reason === "MANUAL_REINSTATE"
              ? "retake-required"
              : "initial-required")
      : completion !== null
        ? "completed"
        : initialProgress.farthestSecond > 0 || submittedAttempts.length > 0
          ? "in-progress"
          : "not-started";

  const durationLabel = formatDuration(view.version.videoDurationSec);
  const typeLabel = courseTypeLabel(view);

  // EP-UX-2B (2026-11-01) — outstanding required courses for the
  // right-hand rail.  Filter rules per directive §2:
  //   1. applicable (resolver guarantees tenant scope + applicability)
  //   2. required (not merely recommended)
  //   3. not completed
  //   4. not the currently viewed version
  //   5. deterministic ordering by title (no due-date model exists)
  const outstandingRequired = eligibility.applicable
    .filter((a) => a.version.required && !a.completed && a.version.id !== versionId)
    .sort((x, y) => x.title.localeCompare(y.title));
  // EP-UX-2C §4 (2026-11-01) — the empty-state wording must distinguish
  // "current course incomplete, no other required outstanding" from
  // "current course complete AND no other required outstanding" AND
  // from "no required courses applicable at all".  Compute all four
  // signals from the authoritative resolver.
  const currentApplicable = eligibility.applicable.find((a) => a.version.id === versionId) ?? null;
  const currentIsRequired = currentApplicable?.version.required === true;
  const currentIsCompleted = completion !== null;
  const hasAnyRequiredApplicable = eligibility.applicable.some((a) => a.version.required);
  // EP-UX-2C §1 (2026-11-01) — the "Continue to Next Training" button
  // inside the completion overlay navigates to the FIRST outstanding
  // required course (same ordering the rail uses, so the two surfaces
  // never disagree).  Null when nothing else is outstanding — the
  // overlay then shows only "Back to Safety & Training".
  const nextRequiredCourseHref = outstandingRequired.length > 0
    ? `/employee/safety-training/${encodeURIComponent(outstandingRequired[0].version.id)}`
    : null;

  return (
    <div
      className="w-full px-6 md:px-8 py-6 md:py-8 max-w-[1600px]"
      data-testid="portal-course"
    >
      <RegisterBreadcrumbLabel id={versionId} label={safeTitle} />

      {/* ------------------------------------------------------------
          §10 — Course header (back arrow + title + metadata chip row)
          EP-UX-2B (2026-11-01) — the play-circle has been replaced by
          an interactive back arrow that navigates to the Safety &
          Training dashboard.  Uses an explicit route (not
          router.back()) so a direct-link / email / bookmark landing
          still resolves correctly. */}
      <header className="mb-6" data-testid="portal-course-header">
        <h1
          className="font-serif text-3xl md:text-4xl text-club-ink leading-tight flex items-center gap-3"
          data-testid="portal-course-title"
        >
          <Link
            href="/employee/safety-training"
            aria-label="Back to Safety & Training"
            data-testid="portal-course-back-arrow"
            className="inline-flex items-center justify-center h-11 w-11 rounded-full text-club-green-800 hover:bg-club-green-50 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-club-gold shrink-0"
          >
            <BackArrowIcon />
          </Link>
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
          §11 — EP-UX-2B two-column layout.  Tabs now live INSIDE the
          left column (constrained to the video-column width) rather
          than spanning the whole content area.  The right column
          stacks the Training Status Panel + Required Training rail.
          Mobile stacks single-column; tablet single-column; desktop
          lg+ 70/30. */}
      <div
        id="course-video"
        className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_340px] xl:grid-cols-[minmax(0,1fr)_380px] gap-6 lg:gap-8 items-start"
      >
        {/* LEFT — CoursePlayer (EP-TRAIN-4E, unchanged props) + course tabs */}
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
            alreadyCompleted={treatAsCurrentlyCompleted}
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
            nextRequiredCourseHref={nextRequiredCourseHref}
          />

          {/* §14 — Course detail tabs — EP-UX-2B pulls these INTO the
             left column so they inherit the video's column width.
             The tabs no longer span under the right-hand rail. */}
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

        {/* RIGHT — Training Status Panel + Required Training rail,
           stacked vertically.  The rail extends naturally down the
           page independent of the left column's height. */}
        <div className="space-y-5 min-w-0">
          <TrainingStatusPanel
            state={state}
            completion={completion}
            progressPercent={initialProgress.percentComplete}
            attemptCount={submittedAttempts.length}
            passingScore={view.version.passingScore}
            thresholdPercent={VIDEO_COMPLETION_THRESHOLD_PERCENT}
            activeObligation={activeObligation}
          />
          <RequiredTrainingRail
            courses={outstandingRequired}
            currentIsRequired={currentIsRequired}
            currentIsCompleted={currentIsCompleted}
            hasAnyRequiredApplicable={hasAnyRequiredApplicable}
          />
        </div>
      </div>

      {/* EP-UX-2C §3 (2026-11-01) — Recommended Training removed.
         The right-hand Required Training rail is now the sole
         location for secondary training on this page. */}
    </div>
  );
}

// ---------------------------------------------------------------------------
// EP-UX-2B — Required Training rail (right column, below status panel)
// ---------------------------------------------------------------------------

type OutstandingItem = Awaited<ReturnType<typeof resolveEmployeeSchedulingEligibility>>["applicable"][number];

function RequiredTrainingRail({
  courses,
  currentIsRequired,
  currentIsCompleted,
  hasAnyRequiredApplicable,
}: {
  courses: OutstandingItem[];
  currentIsRequired: boolean;
  currentIsCompleted: boolean;
  hasAnyRequiredApplicable: boolean;
}) {
  // EP-UX-2C §4 (2026-11-01) — four distinct empty-state wordings
  // computed from authoritative training data, not just the card
  // count.
  //
  //   LIST          Other required courses remain (one or more cards)
  //   FINAL_IN_PROG Current course is the FINAL required one AND
  //                 incomplete.  Rail reads "Your Final Required
  //                 Course" rather than "all caught up".
  //   ALL_CAUGHT_UP Current course is complete AND no other
  //                 required remain.  Positive emerald state.
  //   NONE_ASSIGNED Employee has no applicable required training
  //                 at all.  Neutral stone state.

  if (courses.length > 0) {
    return (
      <aside
        className="space-y-3"
        data-testid="portal-course-required-rail"
        data-rail-state="list"
      >
        <h2 className="font-serif text-lg text-club-ink px-1">Up Next — Required Training</h2>
        {courses.map((c, i) => (
          <RequiredCourseCard key={c.version.id} course={c} index={i} />
        ))}
      </aside>
    );
  }

  if (currentIsRequired && !currentIsCompleted) {
    return (
      <aside
        className="rounded-xl border border-stone-200 bg-white p-5"
        data-testid="portal-course-required-rail"
        data-rail-state="final-in-progress"
      >
        <h2 className="font-serif text-lg text-club-ink">Your Final Required Course</h2>
        <div className="mt-4 flex items-start gap-3">
          <div className="h-9 w-9 rounded-full bg-amber-100 text-amber-800 flex items-center justify-center shrink-0">
            <FlagIcon />
          </div>
          <div className="min-w-0 text-sm text-stone-700">
            You’re working on your final required course. Complete this
            training to finish your current requirements.
          </div>
        </div>
      </aside>
    );
  }

  if (hasAnyRequiredApplicable) {
    return (
      <aside
        className="rounded-xl border border-emerald-200 bg-emerald-50/60 p-5"
        data-testid="portal-course-required-rail"
        data-rail-state="all-caught-up"
      >
        <h2 className="font-serif text-lg text-club-ink">Required Training</h2>
        <div className="mt-4 flex items-start gap-3">
          <div className="h-9 w-9 rounded-full bg-emerald-100 text-emerald-800 flex items-center justify-center shrink-0">
            <CheckIcon />
          </div>
          <div className="min-w-0">
            <div className="font-semibold text-emerald-900">You’re all caught up!</div>
            <div className="mt-1 text-sm text-stone-700">
              All current required training is complete.
            </div>
          </div>
        </div>
      </aside>
    );
  }

  return (
    <aside
      className="rounded-xl border border-stone-200 bg-white p-5"
      data-testid="portal-course-required-rail"
      data-rail-state="none-assigned"
    >
      <h2 className="font-serif text-lg text-club-ink">Required Training</h2>
      <p className="mt-3 text-sm text-stone-600">
        No required training is currently assigned.
      </p>
    </aside>
  );
}

function FlagIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 21V4" />
      <path d="M4 4h12l-2 4 2 4H4" />
    </svg>
  );
}

function RequiredCourseCard({ course, index }: { course: OutstandingItem; index: number }) {
  const href = `/employee/safety-training/${encodeURIComponent(course.version.id)}`;
  const hasVideo = typeof course.version.videoDurationSec === "number" && course.version.videoDurationSec > 0;
  const hasAssessment = course.version.requiresKnowledgeTest;
  const formatLabel = hasVideo && hasAssessment
    ? "Video + Assessment"
    : hasVideo
      ? "Video Only"
      : hasAssessment
        ? "Assessment"
        : "Course";
  const durationLabel = formatDuration(course.version.videoDurationSec);
  const started = course.lastAttempt !== null || (course.lastAttempt as unknown) !== undefined;
  const actionLabel = started ? "Continue Training" : "Start Training";
  // EP-UX-2C §2 (2026-11-01) — thumbnail URL points at the
  // authenticated per-version proxy.  Returns 404 when no thumbnail
  // has been extracted or when the caller lacks applicability — in
  // both cases the <img> onError hook falls back to the branded
  // placeholder below (CoursePlayerThumbnail client component).
  const thumbnailUrl = hasVideo
    ? `/api/hr/training/versions/${encodeURIComponent(course.version.id)}/thumbnail`
    : null;
  return (
    <Link
      href={href}
      className="group block rounded-xl border border-stone-200 bg-white overflow-hidden hover:border-stone-300 hover:shadow-sm transition-all"
      data-testid={`portal-course-required-card-${course.courseId}`}
      data-card-index={index}
    >
      <RequiredCardThumbnail thumbnailUrl={thumbnailUrl} />
      <div className="p-4">
        <div className="font-semibold text-club-ink leading-tight truncate" title={course.title}>
          {course.title}
        </div>
        <div className="mt-1 text-xs text-stone-500">
          {formatLabel}
          {durationLabel ? <> · {durationLabel}</> : null}
        </div>
        <div className="mt-3 inline-flex items-center gap-1.5 rounded-md bg-club-green-800 text-white group-hover:bg-club-green-900 text-xs font-semibold px-3 py-1.5">
          <PlayIcon /> {actionLabel}
        </div>
      </div>
    </Link>
  );
}

// ---------------------------------------------------------------------------
// Panels + reusable bits
// ---------------------------------------------------------------------------

function StatePill({ state }: { state: "completed" | "in-progress" | "not-started" | "updated-required" | "retake-required" | "initial-required" }) {
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
  // EP-TRAIN-5C-3 — obligation-aware labels.  Same amber palette as
  // Not Started / In Progress -- the EP-UX-2D visual system is
  // preserved; the LABEL is what the employee reads.
  if (state === "updated-required") {
    return (
      <span
        className="inline-flex items-center gap-1.5 rounded-full bg-amber-50 text-amber-800 border border-amber-200 px-2.5 py-0.5 text-xs font-semibold"
        data-testid="portal-course-state-pill"
      >
        Updated Training Required
      </span>
    );
  }
  if (state === "retake-required") {
    return (
      <span
        className="inline-flex items-center gap-1.5 rounded-full bg-amber-50 text-amber-800 border border-amber-200 px-2.5 py-0.5 text-xs font-semibold"
        data-testid="portal-course-state-pill"
      >
        Retake Required
      </span>
    );
  }
  if (state === "initial-required") {
    // EP-TRAIN-5C-4B-α (2026-11-02) -- `initial-required` is only
    // reached when a persisted OUTSTANDING INITIAL obligation exists
    // for this course version (see the state computation at the top
    // of this file; the inferred no-obligation case falls through to
    // "not-started" instead).  Promote to the amber obligation-aware
    // palette to match RETAKE_REQUIRED / UPDATED_REQUIRED precedent.
    return (
      <span
        className="inline-flex items-center gap-1.5 rounded-full bg-amber-50 text-amber-800 border border-amber-200 px-2.5 py-0.5 text-xs font-semibold"
        data-testid="portal-course-state-pill"
      >
        Initial Training Required
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
  activeObligation,
}: {
  state: "completed" | "in-progress" | "not-started" | "updated-required" | "retake-required" | "initial-required";
  completion: { id: string; completedAt: Date; score: number } | null;
  progressPercent: number;
  attemptCount: number;
  passingScore: number;
  thresholdPercent: number;
  // EP-TRAIN-5C-3 — the active obligation (if any) that drives the
  // retake / updated-training messaging.  Null when the pre-5C-3
  // legacy state applies.
  activeObligation: {
    id: string;
    reason: "INITIAL" | "REVISION" | "MANUAL_REINSTATE" | "RECERTIFICATION";
    issuedAt: Date;
    dueAt: Date | null;
    reasonNote: string | null;
  } | null;
}) {
  // EP-TRAIN-5C-3 — "Updated Training Required" variant.
  if (state === "updated-required" && activeObligation) {
    return (
      <aside
        className="h-fit rounded-xl border border-amber-200 bg-amber-50 p-6"
        data-testid="portal-course-status-panel"
        data-variant="updated-required"
      >
        <div className="flex items-center gap-3">
          <div className="h-9 w-9 rounded-full bg-amber-100 flex items-center justify-center text-amber-800">
            <CalendarIcon />
          </div>
          <h2 className="font-serif text-xl text-club-ink">Updated Training Required</h2>
        </div>
        <p className="mt-3 text-sm text-stone-700 leading-relaxed">
          An updated version of this training is required. Your previous
          completion remains on record.
        </p>
        {activeObligation.dueAt && (
          <p className="mt-2 text-xs text-stone-600" data-testid="portal-course-status-due">
            Please complete by {formatCompleted(activeObligation.dueAt)}.
          </p>
        )}
        <div className="my-5 h-px bg-amber-200" />
        {completion && (
          <>
            <MetricRow icon={<RibbonIcon />} label="Previous score" value={`${completion.score}%`} />
            <MetricRow icon={<CalendarIcon />} label="Previously completed" value={formatCompleted(completion.completedAt)} />
          </>
        )}
        <a
          href="#course-video"
          className="mt-5 w-full inline-flex items-center justify-center gap-2 rounded-md bg-club-green-800 hover:bg-club-green-900 text-white text-sm font-semibold px-4 py-2.5"
          data-testid="portal-course-start"
        >
          <PlayIcon /> Start Training
        </a>
      </aside>
    );
  }
  // EP-TRAIN-5C-3 — "Retake Required" variant.
  if (state === "retake-required" && activeObligation) {
    return (
      <aside
        className="h-fit rounded-xl border border-amber-200 bg-amber-50 p-6"
        data-testid="portal-course-status-panel"
        data-variant="retake-required"
      >
        <div className="flex items-center gap-3">
          <div className="h-9 w-9 rounded-full bg-amber-100 flex items-center justify-center text-amber-800">
            <CalendarIcon />
          </div>
          <h2 className="font-serif text-xl text-club-ink">Retake Required</h2>
        </div>
        <p className="mt-3 text-sm text-stone-700 leading-relaxed">
          Your club has requested that you repeat this training. Your previous
          completion remains in your training history.
        </p>
        {activeObligation.reasonNote && (
          <p className="mt-2 text-xs text-stone-600 italic" data-testid="portal-course-status-reason">
            {activeObligation.reasonNote.length > 140
              ? `${activeObligation.reasonNote.slice(0, 140).trim()}…`
              : activeObligation.reasonNote}
          </p>
        )}
        {activeObligation.dueAt && (
          <p className="mt-2 text-xs text-stone-600" data-testid="portal-course-status-due">
            Please complete by {formatCompleted(activeObligation.dueAt)}.
          </p>
        )}
        <div className="my-5 h-px bg-amber-200" />
        {completion && (
          <>
            <MetricRow icon={<RibbonIcon />} label="Previous score" value={`${completion.score}%`} />
            <MetricRow icon={<CalendarIcon />} label="Previously completed" value={formatCompleted(completion.completedAt)} />
          </>
        )}
        <a
          href="#course-video"
          className="mt-5 w-full inline-flex items-center justify-center gap-2 rounded-md bg-club-green-800 hover:bg-club-green-900 text-white text-sm font-semibold px-4 py-2.5"
          data-testid="portal-course-start"
        >
          <PlayIcon /> Start Training
        </a>
      </aside>
    );
  }
  // EP-TRAIN-5C-4B-α (2026-11-02) — "Initial Training Required" variant.
  // Only reached when a persisted OUTSTANDING INITIAL obligation exists
  // (the inferred no-obligation case produces state="not-started", not
  // "initial-required").  Mirrors the Retake / Updated panel pattern
  // minus the "previous completion" metrics (an INITIAL obligation
  // implies no completion exists).
  if (state === "initial-required" && activeObligation) {
    return (
      <aside
        className="h-fit rounded-xl border border-amber-200 bg-amber-50 p-6"
        data-testid="portal-course-status-panel"
        data-variant="initial-required"
      >
        <div className="flex items-center gap-3">
          <div className="h-9 w-9 rounded-full bg-amber-100 flex items-center justify-center text-amber-800">
            <CalendarIcon />
          </div>
          <h2 className="font-serif text-xl text-club-ink">Initial Training Required</h2>
        </div>
        <p className="mt-3 text-sm text-stone-700 leading-relaxed">
          Your club requires you to complete this training. Start the
          course to meet your current training requirement.
        </p>
        {activeObligation.reasonNote && (
          <p className="mt-2 text-xs text-stone-600 italic" data-testid="portal-course-status-reason">
            {activeObligation.reasonNote.length > 140
              ? `${activeObligation.reasonNote.slice(0, 140).trim()}…`
              : activeObligation.reasonNote}
          </p>
        )}
        {activeObligation.dueAt && (
          <p className="mt-2 text-xs text-stone-600" data-testid="portal-course-status-due">
            Please complete by {formatCompleted(activeObligation.dueAt)}.
          </p>
        )}
        <div className="my-5 h-px bg-amber-200" />
        <a
          href="#course-video"
          className="mt-5 w-full inline-flex items-center justify-center gap-2 rounded-md bg-club-green-800 hover:bg-club-green-900 text-white text-sm font-semibold px-4 py-2.5"
          data-testid="portal-course-start"
        >
          <PlayIcon /> Start Training
        </a>
      </aside>
    );
  }
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
  state: "completed" | "in-progress" | "not-started" | "updated-required" | "retake-required" | "initial-required";
  completion: { id: string; completedAt: Date; score: number } | null;
  attempts: AttemptSummary[];
  passingScore: number;
}) {
  // EP-TRAIN-5C-3 — when a retake / updated-training obligation is
  // active, Your Result still shows the historical completion the
  // employee EARNED, but with a clear "current requirement outstanding"
  // caption so the latest-historical-result is not confused with the
  // active obligation's status.
  if ((state === "updated-required" || state === "retake-required") && completion) {
    return (
      <div className="space-y-6 max-w-3xl" data-testid="portal-course-your-result-with-outstanding">
        <div className="rounded-xl border border-amber-200 bg-amber-50/60 p-5">
          <div className="flex items-center gap-3">
            <div className="h-9 w-9 rounded-full bg-amber-100 text-amber-800 flex items-center justify-center">
              <CalendarIcon />
            </div>
            <div>
              <div className="font-semibold text-amber-900">
                {state === "updated-required" ? "Updated training required" : "Retake required"}
              </div>
              <div className="text-sm text-amber-900/90">
                Your previous completion from {formatCompleted(completion.completedAt)} ({completion.score}%)
                remains on record. A new completion is required to satisfy the current requirement.
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }
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

function BackArrowIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <line x1="19" y1="12" x2="5" y2="12" />
      <polyline points="12 19 5 12 12 5" />
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
