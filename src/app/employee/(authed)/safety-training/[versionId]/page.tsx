// HR-2C B3 §3-16 (2026-08-20) — Employee course experience.
//
// Loads a single applicable published course via canonical B1
// employee-safe reads (`getEmployeeCourseView`, `getProgress`,
// `getEmployeeAttemptHistory`) and hands the whole payload to a
// client component that renders video → progress → quiz → result.
//
// Ownership discipline:
//   - Never joins back through prisma to read admin fields.
//   - Never surfaces version id / course code / storage key in copy.
//     (The id appears only in the URL path and in the private
//      video route hostname, both of which are needed for the
//      same-origin proxy but do not reveal anything about the
//      course to another actor.)
//   - Reads through the EmployeePortalPrincipal only — an admin
//     Principal cannot enter this page (`/employee/**` is guarded
//     by the layout on the permanent employee-portal cookie).

import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { getEmployeePortalPrincipal } from "@/lib/employee-portal-session";
import {
  getEmployeeCourseView,
  getEmployeeAttemptHistory,
} from "@/lib/hr/training/employee-read";
import { getProgress, VIDEO_COMPLETION_THRESHOLD_PERCENT } from "@/lib/hr/training/attempts";
import { resolveApplicableCourses } from "@/lib/hr/training/applicability";
import { prisma } from "@/lib/prisma";
import CoursePlayer from "./CoursePlayer";
import {
  recordVideoProgressAction,
  startAttemptAction,
  submitAttemptAction,
} from "../_actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function EmployeeCoursePage({
  params,
}: {
  params: Promise<{ versionId: string }>;
}) {
  const principal = await getEmployeePortalPrincipal();
  if (!principal) redirect("/employee/login");

  const { versionId } = await params;

  // Applicability gate — refuse if this version is not applicable to
  // the employee. Same-shape 404 for every deny (§21).
  const applicable = await resolveApplicableCourses(principal.employeeId);
  const match = applicable.find((a) => a.version.id === versionId);
  if (!match) notFound();

  // Employee-safe view (isCorrect NEVER on any option, §8 + §27).
  let view;
  try {
    view = await getEmployeeCourseView(principal, versionId);
  } catch {
    notFound();
  }

  const [progress, attempts, completion] = await Promise.all([
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
  ]);

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

  // EP-TRAIN-1 §A (2026-10-29) -- centered max-width column; existing
  // Spectre design tokens (cream background from the portal shell,
  // forest-green accents, serif heading, muted stone body text).
  const requiredStatusLabel = match.version.required ? "Required" : "Optional";
  return (
    <div className="mx-auto max-w-5xl space-y-8" data-testid="portal-course">
      {/* Breadcrumb */}
      <nav
        aria-label="Breadcrumb"
        className="text-xs tracking-[0.14em] uppercase text-stone-500"
        data-testid="portal-course-breadcrumb"
      >
        <Link
          href="/employee"
          className="hover:text-club-green-800"
        >
          Home
        </Link>
        <span aria-hidden="true" className="mx-2 text-stone-300">/</span>
        <Link
          href="/employee/safety-training"
          className="hover:text-club-green-800"
          data-testid="portal-course-back"
        >
          Safety &amp; Training
        </Link>
        <span aria-hidden="true" className="mx-2 text-stone-300">/</span>
        <span className="text-stone-800">{view.title}</span>
      </nav>

      <header className="space-y-3">
        <div className="flex items-center gap-2 flex-wrap">
          <span
            className="inline-flex items-center rounded-full border border-stone-300 bg-white px-2.5 py-0.5 text-[10.5px] font-medium uppercase tracking-[0.14em] text-stone-700"
            data-testid="portal-course-category"
          >
            {view.category}
          </span>
          <span
            className={
              match.version.required
                ? "inline-flex items-center rounded-full bg-club-green-800 px-2.5 py-0.5 text-[10.5px] font-medium uppercase tracking-[0.14em] text-white"
                : "inline-flex items-center rounded-full border border-stone-300 bg-white px-2.5 py-0.5 text-[10.5px] font-medium uppercase tracking-[0.14em] text-stone-700"
            }
            data-testid="portal-course-required-chip"
          >
            {requiredStatusLabel}
          </span>
        </div>
        <h1
          className="font-serif text-3xl md:text-4xl text-club-ink leading-tight"
          data-testid="portal-course-title"
        >
          {view.title}
        </h1>
        {view.description && (
          <p className="text-sm md:text-base text-stone-700 leading-relaxed max-w-3xl">
            {view.description}
          </p>
        )}
      </header>

      {completion ? (
        <CompletedBanner
          completedAt={completion.completedAt}
          score={completion.score}
        />
      ) : null}

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
      />
    </div>
  );
}

function CompletedBanner({
  completedAt,
  score,
}: {
  completedAt: Date;
  score: number;
}) {
  const when = completedAt.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  return (
    <div
      className="rounded-lg border border-emerald-200 bg-emerald-50/70 px-5 py-4"
      data-testid="portal-course-completed-banner"
    >
      <p className="text-sm text-emerald-900">
        <strong>Training complete.</strong> Score: {score}%. Completed {when}.
      </p>
    </div>
  );
}
