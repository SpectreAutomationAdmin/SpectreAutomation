// HR-2C B2 (2026-08-20) — People → Safety & Training landing.
//
// Course catalogue for the current Club. Shows PUBLISHED / DRAFT
// state at a glance, category, required flag, and offers Create Course.
// Retired courses appear in a distinct group.
//
// Every read goes through canonical `listClubCourses` — no direct
// Prisma reads here. Every mutation goes through `_actions.ts`.

import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { hasPermission } from "@/lib/rbac";
import { listClubCourses } from "@/lib/hr/training/courses";
import SafetyTrainingTabs from "./_SafetyTrainingTabs";
import CourseRowActions from "./CourseRowActions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function SafetyTrainingCatalogue({
  searchParams,
}: {
  searchParams: Promise<{ err?: string; view?: string }>;
}) {
  const principal = await getCurrentPrincipal();
  if (!principal) redirect("/login");
  const clubId = await getActiveClubId({ clubId: principal.activeClubId ?? null, role: "" });
  if (!hasPermission(principal, clubId, "hr:training:read")) {
    redirect("/app/admin/people/employees");
  }
  const canAuthor = hasPermission(principal, clubId, "hr:training:write");
  const canReadCompliance = hasPermission(principal, clubId, "hr:training:compliance:read");
  const canArchive = hasPermission(principal, clubId, "hr:training:publish");
  const { err, view } = await searchParams;
  // EP-TRAIN-4E B5 (2026-10-31): default = Active.  ?view=archived
  // shows the archived catalogue so administrators can review +
  // restore.
  const archivedView = view === "archived";

  const courses = await listClubCourses(principal, clubId);
  const active = courses.filter((c) => !c.retiredAt);
  const retired = courses.filter((c) => c.retiredAt);

  return (
    <div>
      <Link href="/app/admin/people/employees" className="text-sm text-stone-500 hover:text-club-ink">
        ← People
      </Link>
      <div className="mt-3 mb-6 flex items-baseline justify-between gap-4">
        <div>
          <h1 className="page-title">Safety &amp; Training</h1>
          <p className="mt-1 text-sm text-stone-500 max-w-xl">
            Courses your team must complete before scheduling. Each course carries
            a training video and knowledge test; completion is tracked per employee.
          </p>
        </div>
        {canAuthor && (
          <Link
            href="/app/admin/people/safety-training/new"
            className="btn btn-primary"
            data-testid="training-create-course"
          >
            + Create course
          </Link>
        )}
      </div>

      <SafetyTrainingTabs canReadCompliance={canReadCompliance} />

      {err && (
        <div role="alert" className="mb-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {err}
        </div>
      )}

      {/* EP-TRAIN-4E B5 (2026-10-31): catalogue filter.  Default is
          Active; administrators switch to Archived to review + restore
          retired courses. */}
      <div
        className="mb-5 flex items-center gap-4 text-sm"
        data-testid="training-catalogue-view-toggle"
      >
        <Link
          href="/app/admin/people/safety-training"
          className={!archivedView ? "font-medium text-club-ink" : "text-stone-500 hover:text-club-ink"}
          data-testid="training-view-active"
        >
          Active <span className="text-stone-400">({active.length})</span>
        </Link>
        <Link
          href="/app/admin/people/safety-training?view=archived"
          className={archivedView ? "font-medium text-club-ink" : "text-stone-500 hover:text-club-ink"}
          data-testid="training-view-archived"
        >
          Archived <span className="text-stone-400">({retired.length})</span>
        </Link>
      </div>

      {!archivedView && (
        <section data-testid="training-active-courses">
          <h2 className="section-title text-lg mt-2 mb-3">Active courses</h2>
          {active.length === 0 ? (
            <div className="rounded-md border border-dashed border-stone-300 bg-white px-6 py-10 text-center">
              <p className="text-sm text-stone-600">No courses yet.</p>
              {canAuthor && (
                <p className="mt-2 text-xs text-stone-500">
                  Click <span className="font-medium">+ Create course</span> to author your first safety course.
                </p>
              )}
            </div>
          ) : (
            <table className="table-base w-full">
              <thead>
                <tr>
                  <th className="text-left">Course</th>
                  <th className="text-left">Category</th>
                  <th className="text-left">Required</th>
                  <th className="text-left">State</th>
                  <th className="text-right"> </th>
                </tr>
              </thead>
              <tbody>
                {active.map((c) => (
                  <CourseRow key={c.id} course={c} canAuthor={canAuthor} canArchive={canArchive} />
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}

      {archivedView && (
        <section data-testid="training-archived-courses">
          <h2 className="section-title text-lg mt-2 mb-3">Archived courses</h2>
          {retired.length === 0 ? (
            <div className="rounded-md border border-dashed border-stone-300 bg-white px-6 py-10 text-center">
              <p className="text-sm text-stone-600">No archived courses.</p>
              <p className="mt-2 text-xs text-stone-500">
                Archived courses show here so administrators can review their history or restore them.
              </p>
            </div>
          ) : (
            <table className="table-base w-full">
              <thead>
                <tr>
                  <th className="text-left">Course</th>
                  <th className="text-left">Category</th>
                  <th className="text-left">Archived</th>
                  <th className="text-right"> </th>
                </tr>
              </thead>
              <tbody>
                {retired.map((c) => (
                  <tr key={c.id} className="text-stone-500" data-testid={`training-archived-row-${c.id}`}>
                    <td>
                      <Link href={`/app/admin/people/safety-training/${c.id}`} className="text-club-ink hover:underline">
                        {c.title}
                      </Link>
                      <div className="text-xs text-stone-400 font-mono">{c.code}</div>
                    </td>
                    <td>{c.category}</td>
                    <td>{c.retiredAt?.toLocaleDateString() ?? ""}</td>
                    <td className="text-right">
                      {canArchive && (
                        <CourseRowActions
                          courseId={c.id}
                          courseCode={c.code}
                          courseTitle={c.title}
                          state="archived"
                          hasHistory={c.hasHistory}
                        />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}
    </div>
  );
}

function CourseRow({
  course,
  canAuthor,
  canArchive,
}: {
  course: Awaited<ReturnType<typeof listClubCourses>>[number];
  canAuthor: boolean;
  canArchive: boolean;
}) {
  const currentBadge = course.currentVersion
    ? { label: `Published · v${course.currentVersion.version}`, tone: "emerald" }
    : { label: "No published version yet", tone: "stone" };
  const draftBadge = course.draftVersion
    ? { label: `Draft · v${course.draftVersion.version}`, tone: "amber" }
    : null;
  const targetLink = course.draftVersion
    ? `/app/admin/people/safety-training/${course.id}/${course.draftVersion.id}`
    : course.currentVersion
      ? `/app/admin/people/safety-training/${course.id}`
      : `/app/admin/people/safety-training/${course.id}`;
  // EP-TRAIN-4E B1 (2026-10-31): classify the row for state-aware
  // action rendering.  "active-draft-only" means the course has
  // NEVER been published (hasHistory is false AND no currentVersion).
  //
  // EP-TRAIN-4Y-AC §3B (2026-11-10): "active-published-with-draft"
  // adds a new classifier for courses that have both a PUBLISHED
  // version AND an unpublished DRAFT version. The row renders a
  // version-scoped "Delete draft" action that removes only the draft
  // version — the published version + its employee-training evidence
  // are preserved untouched.
  const rowState: "active-draft-only" | "active-published" | "active-published-with-draft" =
    course.currentVersion
      ? course.draftVersion
        ? "active-published-with-draft"
        : "active-published"
      : "active-draft-only";
  return (
    <tr data-testid={`training-active-row-${course.id}`}>
      <td>
        <Link href={targetLink} className="text-club-ink hover:underline font-medium">
          {course.title}
        </Link>
        <div className="text-xs text-stone-400 font-mono">{course.code}</div>
      </td>
      <td>{course.category}</td>
      <td>{course.currentVersion?.required === false ? "Optional" : "Required"}</td>
      <td>
        <StateBadge {...currentBadge} />
        {draftBadge && <span className="ml-2"><StateBadge {...draftBadge} /></span>}
      </td>
      <td className="text-right">
        <div className="flex flex-col items-end gap-1">
          {canAuthor && (
            <Link
              href={targetLink}
              className="text-xs text-emerald-800 hover:text-emerald-900 underline underline-offset-4"
            >
              {course.draftVersion ? "Continue editing" : course.currentVersion ? "View" : "Open"}
            </Link>
          )}
          {canArchive && (
            <CourseRowActions
              courseId={course.id}
              courseCode={course.code}
              courseTitle={course.title}
              state={rowState}
              hasHistory={course.hasHistory}
              draftVersionId={course.draftVersion?.id ?? null}
            />
          )}
        </div>
      </td>
    </tr>
  );
}

function StateBadge({ label, tone }: { label: string; tone: string }) {
  const cls = tone === "emerald"
    ? "bg-emerald-50 text-emerald-800 border-emerald-200"
    : tone === "amber"
      ? "bg-amber-50 text-amber-800 border-amber-200"
      : "bg-stone-50 text-stone-600 border-stone-200";
  return <span className={"inline-block rounded border px-2 py-0.5 text-[11px] " + cls}>{label}</span>;
}
