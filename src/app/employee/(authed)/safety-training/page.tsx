// HR-2C B3 §1-2, §14 (2026-08-20) — Employee Safety & Training dashboard.
//
// Replaces the placeholder from Group A. Reads the canonical
// applicability + eligibility resolver and groups the employee's
// applicable courses into a small, restrained hierarchy. Never
// exposes raw internal enums; course codes / version ids stay
// out of the visible copy (§1).
//
// The full course experience (video + quiz) lives in
// `./[versionId]/page.tsx`. This page is a directory index.

import { redirect } from "next/navigation";
import Link from "next/link";
import { getEmployeePortalPrincipal } from "@/lib/employee-portal-session";
import { resolveEmployeeSchedulingEligibility } from "@/lib/hr/training/applicability";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Applicable = Awaited<
  ReturnType<typeof resolveEmployeeSchedulingEligibility>
>["applicable"][number];

interface Bucketed {
  required: Applicable[];
  completed: Applicable[];
  optional: Applicable[];
}

function bucket(items: Applicable[]): Bucketed {
  const required: Applicable[] = [];
  const completed: Applicable[] = [];
  const optional: Applicable[] = [];
  for (const a of items) {
    if (a.completed) completed.push(a);
    else if (a.version.required) required.push(a);
    else optional.push(a);
  }
  // Deterministic ordering: newer completions first; required by title.
  required.sort((x, y) => x.title.localeCompare(y.title));
  optional.sort((x, y) => x.title.localeCompare(y.title));
  completed.sort((x, y) => {
    const xa = x.completedAt?.getTime() ?? 0;
    const ya = y.completedAt?.getTime() ?? 0;
    return ya - xa;
  });
  return { required, completed, optional };
}

function statusLabel(a: Applicable): {
  label: string;
  tone: "neutral" | "attention" | "success";
} {
  if (a.completed) return { label: "Completed", tone: "success" };
  const last = a.lastAttempt;
  if (last && last.submittedAt && !last.passed) {
    return { label: "Not passed", tone: "attention" };
  }
  // We can't know the exact video-progress state here without another
  // query per course — keep it to "Not started" vs "In progress" at
  // the course-page level where the progress row is loaded.
  return { label: "Not started", tone: "neutral" };
}

function formatCompleted(d: Date | null | undefined): string {
  if (!d) return "";
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

export default async function EmployeePortalSafetyTrainingPage() {
  const principal = await getEmployeePortalPrincipal();
  if (!principal) redirect("/employee/login");

  const eligibility = await resolveEmployeeSchedulingEligibility(
    principal.employeeId,
  );
  const { required, completed, optional } = bucket(eligibility.applicable);
  const outstandingCount = eligibility.outstandingTraining.length;

  const totalApplicable = eligibility.applicable.length;

  return (
    <div className="space-y-8" data-testid="portal-safety-training">
      <header>
        <h1 className="font-serif text-3xl text-club-ink">Safety &amp; Training</h1>
        <p className="mt-2 text-sm text-stone-500">
          Your Club&rsquo;s required training and safety courses. Complete
          each course to stay in good standing.
        </p>
      </header>

      {totalApplicable === 0 ? (
        <div
          className="rounded-lg border border-dashed border-stone-300 bg-white px-6 py-10 text-center"
          data-testid="portal-safety-training-empty"
        >
          <p className="text-sm text-stone-600">
            No training has been assigned to you yet.
          </p>
          <p className="mt-2 text-xs text-stone-500">
            When your Club assigns a course, it will appear here.
          </p>
        </div>
      ) : (
        <>
          {outstandingCount > 0 && (
            <div
              className="rounded-lg border border-amber-200 bg-amber-50/70 px-5 py-4"
              data-testid="portal-safety-training-outstanding-summary"
            >
              <p className="text-sm text-amber-900">
                You have{" "}
                <strong data-testid="portal-safety-training-outstanding-count">
                  {outstandingCount}
                </strong>{" "}
                required training {outstandingCount === 1 ? "course" : "courses"}{" "}
                to complete.
              </p>
            </div>
          )}

          {required.length > 0 && (
            <Section title="Required training" testId="portal-safety-training-required">
              <CourseList items={required} />
            </Section>
          )}

          {completed.length > 0 && (
            <Section title="Completed" testId="portal-safety-training-completed">
              <CourseList items={completed} />
            </Section>
          )}

          {optional.length > 0 && (
            <Section title="Optional training" testId="portal-safety-training-optional">
              <CourseList items={optional} />
            </Section>
          )}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Presentational bits
// ---------------------------------------------------------------------------

function Section({
  title,
  testId,
  children,
}: {
  title: string;
  testId: string;
  children: React.ReactNode;
}) {
  return (
    <section data-testid={testId}>
      <h2 className="text-[11px] uppercase tracking-[0.2em] text-stone-500">
        {title}
      </h2>
      <div className="mt-3 space-y-3">{children}</div>
    </section>
  );
}

function CourseList({ items }: { items: Applicable[] }) {
  return (
    <ul className="space-y-3">
      {items.map((a) => {
        const status = statusLabel(a);
        const href = `/employee/safety-training/${encodeURIComponent(a.version.id)}`;
        const testId = `portal-safety-training-course-${a.courseId}`;
        return (
          <li key={a.courseId}>
            <Link
              href={href}
              className="block rounded-lg border border-stone-200 bg-white px-5 py-4 hover:border-stone-300 hover:bg-stone-50 transition-colors"
              data-testid={testId}
            >
              <div className="flex items-baseline justify-between gap-4">
                <div className="min-w-0">
                  <div className="font-serif text-lg leading-tight text-club-ink truncate">
                    {a.title}
                  </div>
                  <div className="mt-1 text-[11px] uppercase tracking-[0.16em] text-stone-500">
                    {a.category}
                    {a.version.required ? " · Required" : " · Optional"}
                  </div>
                </div>
                <StatusBadge label={status.label} tone={status.tone} />
              </div>
              {a.completed && a.completedAt && (
                <div className="mt-2 text-xs text-stone-500">
                  Completed {formatCompleted(a.completedAt)}
                  {typeof a.lastAttempt?.attemptNumber === "number" && a.lastAttempt.passed
                    ? ""
                    : ""}
                </div>
              )}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

function StatusBadge({
  label,
  tone,
}: {
  label: string;
  tone: "neutral" | "attention" | "success";
}) {
  const classes =
    tone === "success"
      ? "bg-emerald-50 text-emerald-800 border border-emerald-200"
      : tone === "attention"
        ? "bg-amber-50 text-amber-800 border border-amber-200"
        : "bg-stone-100 text-stone-700 border border-stone-200";
  return (
    <span
      className={`shrink-0 rounded-full px-3 py-0.5 text-[11px] font-medium uppercase tracking-[0.1em] ${classes}`}
      data-testid={`training-status-${tone}`}
    >
      {label}
    </span>
  );
}
