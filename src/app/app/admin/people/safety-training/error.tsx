"use client";

// EP-TRAIN-4Y-AC §6 (2026-11-10) — Safety & Training dashboard error
// boundary.
//
// Catches any error that escapes the server-render pipeline for this
// route segment (and its nested segments) and renders a recoverable
// page state instead of Next.js's default "Application error: a
// server-side exception has occurred" screen.
//
// Shows the digest + a correlation note so the manager has something
// actionable to share with support. The "Try again" button calls the
// `reset()` function Next.js provides, which re-mounts the segment
// and re-runs the server render — typical recovery path when the
// error was a transient data race or a now-fixed exception class.
//
// Why this exists: the pre-AC `deleteDraftCourseAction` rethrew
// un-mapped Prisma errors (notably the FK-RESTRICT crash from the
// AI-generation child tables), which Next.js caught at the server-
// render boundary and surfaced as a full-page error. That gave the
// manager no actionable feedback AND discarded whatever filter / tab
// state they had. The service + action fixes in this same slice
// should make this boundary rarely trigger, but when it does the
// surface stays readable.

import Link from "next/link";
import { useEffect } from "react";

export default function SafetyTrainingError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // eslint-disable-next-line no-console
    console.error("[safety-training] boundary caught", {
      digest: error.digest,
      name: error.name,
      message: error.message,
    });
  }, [error]);

  return (
    <div className="max-w-xl" data-testid="training-dashboard-error">
      <h1 className="page-title">Something went wrong on this page.</h1>
      <p className="mt-4 text-sm text-stone-700">
        Spectre couldn&apos;t render the Safety &amp; Training dashboard. The error has been logged and
        the operations team will take a look. If you need to share this with
        support, use the reference below.
      </p>
      <dl className="mt-6 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs font-mono">
        <dt className="text-stone-500">Reference</dt>
        <dd className="text-stone-800">{error.digest ?? "(no digest)"}</dd>
      </dl>
      <div className="mt-6 flex items-center gap-3">
        <button
          type="button"
          className="btn btn-primary btn-sm"
          onClick={() => reset()}
          data-testid="training-dashboard-error-retry"
        >
          Try again
        </button>
        <Link
          href="/app/admin/people/safety-training"
          className="btn btn-secondary btn-sm"
          data-testid="training-dashboard-error-back"
        >
          Back to Safety &amp; Training
        </Link>
      </div>
    </div>
  );
}
