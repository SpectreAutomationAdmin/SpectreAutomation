// HR-2C B2 (2026-08-20) — Course detail: version list + lifecycle actions.
//
// Lists every version of the course with lifecycle state, offers
// "Start new draft" (from the current PUBLISHED) and "Retire course".
// The DRAFT / PUBLISHED editor / viewer lives one level deeper at
// [courseId]/[versionId]/page.tsx.

import Link from "next/link";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { hasPermission } from "@/lib/rbac";
import { startNewDraftAction, retireCourseAction } from "../_actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function CourseDetailPage({
  params,
  searchParams,
}: {
  params: { courseId: string };
  searchParams: Promise<{ err?: string }>;
}) {
  const principal = await getCurrentPrincipal();
  if (!principal) redirect("/login");
  const clubId = await getActiveClubId({ clubId: principal.activeClubId ?? null, role: "" });
  if (!hasPermission(principal, clubId, "hr:training:read")) {
    redirect("/app/admin/people/employees");
  }
  const course = await prisma.trainingCourse.findFirst({
    where: { id: params.courseId, clubId },
    include: {
      versions: { orderBy: { version: "desc" } },
    },
  });
  if (!course) redirect("/app/admin/people/safety-training");
  const { err } = await searchParams;
  const canAuthor = hasPermission(principal, clubId, "hr:training:write");
  const canPublish = hasPermission(principal, clubId, "hr:training:publish");
  const currentPublished = course.versions.find((v) => v.state === "PUBLISHED") ?? null;
  const openDraft = course.versions.find((v) => v.state === "DRAFT") ?? null;
  const startNewDraft = startNewDraftAction.bind(null, course.id);
  const retireAction = retireCourseAction.bind(null, course.id);

  return (
    <div>
      <Link href="/app/admin/people/safety-training" className="text-sm text-stone-500 hover:text-club-ink">
        ← Safety &amp; Training
      </Link>
      <div className="mt-3 mb-6 flex items-baseline justify-between gap-4">
        <div>
          <h1 className="page-title">{course.title}</h1>
          <p className="mt-1 text-xs text-stone-500 font-mono">{course.code}</p>
          <p className="mt-2 text-sm text-stone-500">{course.description ?? ""}</p>
        </div>
        <div className="flex items-center gap-2">
          {course.retiredAt && (
            <span className="text-xs text-stone-500">
              Retired {course.retiredAt.toLocaleDateString()}
            </span>
          )}
          {canAuthor && !course.retiredAt && !openDraft && (
            <form action={startNewDraft}>
              <button type="submit" className="btn btn-secondary btn-sm" data-testid="training-start-new-draft">
                Start new draft
              </button>
            </form>
          )}
          {canPublish && !course.retiredAt && (
            <form action={retireAction}>
              <button
                type="submit"
                className="btn btn-secondary btn-sm text-red-700"
                data-testid="training-retire-course"
                onClick={undefined}
              >
                Retire course
              </button>
            </form>
          )}
        </div>
      </div>

      {err && (
        <div role="alert" className="mb-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {err}
        </div>
      )}

      {openDraft && (
        <div className="mb-6 rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800" data-testid="training-open-draft-banner">
          <span className="font-medium">Version {openDraft.version} is a draft.</span>{" "}
          Continue authoring the video + quiz before publishing.{" "}
          <Link
            href={`/app/admin/people/safety-training/${course.id}/${openDraft.id}`}
            className="underline underline-offset-4"
            data-testid="training-open-draft-link"
          >
            Open draft
          </Link>
        </div>
      )}

      <section>
        <h2 className="section-title text-lg mb-3">Versions</h2>
        <table className="table-base w-full">
          <thead>
            <tr>
              <th className="text-left">Version</th>
              <th className="text-left">State</th>
              <th className="text-left">Published</th>
              <th className="text-left">Retired</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {course.versions.map((v) => (
              <tr key={v.id} data-testid={`training-version-${v.version}`}>
                <td>v{v.version}</td>
                <td>
                  <span className={
                    "inline-block rounded border px-2 py-0.5 text-[11px] " +
                    (v.state === "PUBLISHED"
                      ? "bg-emerald-50 text-emerald-800 border-emerald-200"
                      : v.state === "DRAFT"
                        ? "bg-amber-50 text-amber-800 border-amber-200"
                        : "bg-stone-100 text-stone-600 border-stone-200")
                  }>
                    {v.state}
                  </span>
                </td>
                <td>{v.publishedAt ? v.publishedAt.toLocaleDateString() : "—"}</td>
                <td>{v.retiredAt ? v.retiredAt.toLocaleDateString() : "—"}</td>
                <td className="text-right">
                  <Link
                    href={`/app/admin/people/safety-training/${course.id}/${v.id}`}
                    className="text-xs text-emerald-800 hover:text-emerald-900 underline underline-offset-4"
                  >
                    {v.state === "DRAFT" ? "Edit" : "View"}
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {currentPublished && (
        <p className="mt-6 text-xs text-stone-500">
          Currently published: v{currentPublished.version}. Publishing a new
          draft will retire the previous version. Historical completions
          remain valid against the version they were earned against.
        </p>
      )}
    </div>
  );
}
