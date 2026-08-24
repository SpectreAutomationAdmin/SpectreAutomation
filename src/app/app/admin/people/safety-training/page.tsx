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

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function SafetyTrainingCatalogue({
  searchParams,
}: {
  searchParams: Promise<{ err?: string }>;
}) {
  const principal = await getCurrentPrincipal();
  if (!principal) redirect("/login");
  const clubId = await getActiveClubId({ clubId: principal.activeClubId ?? null, role: "" });
  if (!hasPermission(principal, clubId, "hr:training:read")) {
    redirect("/app/admin/people/employees");
  }
  const canAuthor = hasPermission(principal, clubId, "hr:training:write");
  const canReadCompliance = hasPermission(principal, clubId, "hr:training:compliance:read");
  const { err } = await searchParams;

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
                <th className="text-left"> </th>
              </tr>
            </thead>
            <tbody>
              {active.map((c) => (
                <CourseRow key={c.id} course={c} canAuthor={canAuthor} />
              ))}
            </tbody>
          </table>
        )}
      </section>

      {retired.length > 0 && (
        <section className="mt-10" data-testid="training-retired-courses">
          <h2 className="section-title text-lg mt-2 mb-3">Retired courses</h2>
          <table className="table-base w-full">
            <thead>
              <tr>
                <th className="text-left">Course</th>
                <th className="text-left">Category</th>
                <th className="text-left">Retired</th>
              </tr>
            </thead>
            <tbody>
              {retired.map((c) => (
                <tr key={c.id} className="text-stone-500">
                  <td>
                    <Link href={`/app/admin/people/safety-training/${c.id}`} className="text-club-ink hover:underline">
                      {c.title}
                    </Link>
                    <div className="text-xs text-stone-400 font-mono">{c.code}</div>
                  </td>
                  <td>{c.category}</td>
                  <td>{c.retiredAt?.toLocaleDateString() ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}

function CourseRow({
  course,
  canAuthor,
}: {
  course: Awaited<ReturnType<typeof listClubCourses>>[number];
  canAuthor: boolean;
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
  return (
    <tr>
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
        {canAuthor && (
          <Link
            href={targetLink}
            className="text-xs text-emerald-800 hover:text-emerald-900 underline underline-offset-4"
          >
            {course.draftVersion ? "Continue editing" : course.currentVersion ? "View" : "Open"}
          </Link>
        )}
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
