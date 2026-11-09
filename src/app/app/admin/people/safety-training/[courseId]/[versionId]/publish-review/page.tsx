// EP-TRAIN-4Y-T §9 — Final Publish review.
//
// A read-only summary of everything the manager has prepared, with
// the existing PublishPanel (or PublishRevisionDialog for revisions)
// as the one explicit publish action. Publication remains an
// explicit, authorised step. The server page reuses:
//   - checkPublishReadiness — never reimplemented
//   - publishDraftAction — the existing posting-gated service action
//   - PublishPanel / PublishRevisionDialog — unchanged
//
// Nothing here can auto-publish, auto-assign, or bypass the
// readiness check.

import Link from "next/link";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { hasPermission } from "@/lib/rbac";
import { checkPublishReadiness } from "@/lib/hr/training/courses";
import { listCheckpointsForVersion } from "@/lib/hr/training/checkpoints";
import { publishDraftAction } from "../../../_actions";
import PublishPanel from "../PublishPanel";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function PublishReviewPage({
  params,
}: {
  params: { courseId: string; versionId: string };
}) {
  const principal = await getCurrentPrincipal();
  if (!principal) redirect("/login");
  const clubId = await getActiveClubId({ clubId: principal.activeClubId ?? null, role: "" });
  if (!hasPermission(principal, clubId, "hr:training:read")) {
    redirect("/app/admin/people/employees");
  }
  const version = await prisma.trainingCourseVersion.findFirst({
    where: { id: params.versionId, course: { id: params.courseId, clubId } },
    include: {
      course: { select: { id: true, code: true, title: true } },
      _count: { select: { questions: true } },
    },
  });
  if (!version) redirect("/app/admin/people/safety-training");

  const canPublish = hasPermission(principal, clubId, "hr:training:publish");
  const readiness = await checkPublishReadiness(version.id);
  const checkpoints = await listCheckpointsForVersion(version.id);
  const finalAssessmentCount = await prisma.trainingQuestion.count({
    where: { courseVersionId: version.id, checkpointId: null },
  });

  const appliesToAll = !!version.appliesToAll;
  const deptIds = Array.isArray(version.appliesToDeptIds) ? version.appliesToDeptIds.length : 0;
  const positionIds = Array.isArray(version.appliesToPositionIds)
    ? version.appliesToPositionIds.length
    : 0;
  const audienceText = appliesToAll
    ? "Everyone at the Club"
    : deptIds > 0 || positionIds > 0
      ? `${deptIds} department(s) · ${positionIds} position(s)`
      : "Assigned individually";

  const publishAction = publishDraftAction.bind(null, version.courseId, version.id);

  return (
    <div className="max-w-[920px]">
      <Link
        href={`/app/admin/people/safety-training/${params.courseId}/${params.versionId}/training-requirements`}
        className="text-sm text-stone-500 hover:text-club-ink"
      >
        ← Training Requirements
      </Link>
      <div className="mt-3 mb-6">
        <h1 className="page-title">Final review</h1>
        <p className="mt-1 text-sm text-stone-500">
          Confirm every setting below is correct for{" "}
          <span className="font-medium text-stone-800">{version.course.title}</span>.
          Publication is explicit &mdash; nothing is sent to employees until you click Publish.
        </p>
      </div>

      <section className="card card-body space-y-3" data-testid="publish-review-course-identity">
        <h2 className="section-title text-sm">Course identity</h2>
        <dl className="grid grid-cols-[180px_minmax(0,1fr)] gap-y-1 text-sm">
          <dt className="text-stone-500">Title</dt>
          <dd data-testid="pr-title">{version.course.title}</dd>
          <dt className="text-stone-500">Course code</dt>
          <dd className="font-mono text-stone-700" data-testid="pr-code">{version.course.code}</dd>
          <dt className="text-stone-500">Description</dt>
          <dd className="text-stone-700" data-testid="pr-description">
            {version.description || <span className="text-stone-400">(empty)</span>}
          </dd>
        </dl>
      </section>

      <section className="card card-body space-y-3 mt-4" data-testid="publish-review-content">
        <h2 className="section-title text-sm">Content</h2>
        <dl className="grid grid-cols-[180px_minmax(0,1fr)] gap-y-1 text-sm">
          <dt className="text-stone-500">Training video</dt>
          <dd data-testid="pr-video">
            {version.videoSha256 ? (
              <>
                Uploaded ·{" "}
                <span className="font-mono text-xs text-stone-500">
                  sha256 {version.videoSha256.slice(0, 12)}…
                </span>
              </>
            ) : (
              <span className="text-amber-700">Not yet uploaded</span>
            )}
          </dd>
          <dt className="text-stone-500">Checkpoints</dt>
          <dd data-testid="pr-checkpoints">{checkpoints.length}</dd>
          <dt className="text-stone-500">Final-assessment questions</dt>
          <dd data-testid="pr-final-count">{finalAssessmentCount}</dd>
          <dt className="text-stone-500">Approval status</dt>
          <dd data-testid="pr-approval">
            {readiness.ready ? (
              <span className="text-green-700">Ready to publish</span>
            ) : (
              <span className="text-amber-700">
                {readiness.reasons.length} item(s) outstanding
              </span>
            )}
          </dd>
        </dl>
      </section>

      <section className="card card-body space-y-3 mt-4" data-testid="publish-review-requirements">
        <h2 className="section-title text-sm">Training Requirements</h2>
        <dl className="grid grid-cols-[180px_minmax(0,1fr)] gap-y-1 text-sm">
          <dt className="text-stone-500">Audience</dt>
          <dd data-testid="pr-audience">{audienceText}</dd>
          <dt className="text-stone-500">Passing grade</dt>
          <dd className="font-mono" data-testid="pr-passing-score">
            {version.passingScore ?? 80}%
          </dd>
          <dt className="text-stone-500">Required for scheduling</dt>
          <dd data-testid="pr-required">{version.required ? "Yes" : "No (optional)"}</dd>
          <dt className="text-stone-500">Retakes allowed</dt>
          <dd data-testid="pr-retakes">{version.retakesAllowed ? "Yes" : "No"}</dd>
          <dt className="text-stone-500">Knowledge test required</dt>
          <dd data-testid="pr-requires-kt">{version.requiresKnowledgeTest ? "Yes" : "No"}</dd>
        </dl>
        <Link
          href={`/app/admin/people/safety-training/${params.courseId}/${params.versionId}/training-requirements`}
          className="text-xs text-club-green hover:underline"
          data-testid="pr-edit-requirements"
        >
          Edit Training Requirements →
        </Link>
      </section>

      <section id="publish" className="card card-body space-y-4 mt-6">
        <h2 className="section-title text-lg">Publish</h2>
        <PublishPanel readiness={readiness} canPublish={canPublish} publishAction={publishAction} />
      </section>
    </div>
  );
}
