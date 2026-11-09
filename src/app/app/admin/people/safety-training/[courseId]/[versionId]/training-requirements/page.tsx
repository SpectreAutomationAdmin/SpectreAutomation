// EP-TRAIN-4Y-T §8 — Training Requirements step.
//
// Dedicated step positioned immediately before Publish. Consolidates
// the publication-affecting fields the 4Y-S editor spread across
// several sections:
//   - Training audience: everyone / selected departments or
//     positions / individual employees
//   - Required versus optional
//   - Passing grade
//   - Retakes allowed
//   - Knowledge-test-required (existing scheduling restriction)
//
// Persistence: posts to the existing `updateDraftAction` server
// action — same tenant + `hr:training:write` + DRAFT-state guards,
// same audit. No new mutation primitives.
//
// Explicit audience confirmation (directive §8 "Require the manager
// to explicitly confirm the audience before publishing"): a
// mandatory checkbox gates the Continue button.

import Link from "next/link";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { hasPermission } from "@/lib/rbac";
import ApplicabilityPicker from "../ApplicabilityPicker";
import { updateDraftAction } from "../../../_actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function TrainingRequirementsPage({
  params,
}: {
  params: { courseId: string; versionId: string };
}) {
  const principal = await getCurrentPrincipal();
  if (!principal) redirect("/login");
  const clubId = await getActiveClubId({ clubId: principal.activeClubId ?? null, role: "" });
  if (!hasPermission(principal, clubId, "hr:training:write")) {
    redirect("/app/admin/people/safety-training");
  }
  const version = await prisma.trainingCourseVersion.findFirst({
    where: { id: params.versionId, course: { id: params.courseId, clubId } },
    include: { course: { select: { id: true, title: true } } },
  });
  if (!version) redirect("/app/admin/people/safety-training");

  const [departments, positions] = await Promise.all([
    prisma.department.findMany({
      where: { clubId, isActive: true },
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    }),
    prisma.organizationalPosition.findMany({
      where: { clubId, isActive: true },
      orderBy: { name: "asc" },
      select: { id: true, name: true, departmentId: true },
    }),
  ]);

  const appliesToAll = !!version.appliesToAll;
  const selectedDeptIds = Array.isArray(version.appliesToDeptIds)
    ? (version.appliesToDeptIds as string[])
    : [];
  const selectedPosIds = Array.isArray(version.appliesToPositionIds)
    ? (version.appliesToPositionIds as string[])
    : [];
  const initialMode: "everyone" | "scoped" | "explicit" = appliesToAll
    ? "everyone"
    : selectedDeptIds.length > 0 || selectedPosIds.length > 0
      ? "scoped"
      : "explicit";

  const action = updateDraftAction.bind(null, version.courseId, version.id);

  return (
    <div className="max-w-[720px]">
      <Link
        href={`/app/admin/people/safety-training/${params.courseId}/${params.versionId}/review`}
        className="text-sm text-stone-500 hover:text-club-ink"
      >
        ← Back to review
      </Link>
      <div className="mt-3 mb-6">
        <h1 className="page-title">Training Requirements</h1>
        <p className="mt-1 text-sm text-stone-500">
          Confirm the audience and scoring rules for{" "}
          <span className="font-medium text-stone-800">{version.course.title}</span>{" "}
          before publishing. These settings stay editable until you publish.
        </p>
      </div>

      <form action={action} className="space-y-6" data-testid="training-requirements-form">
        <input
          type="hidden"
          name="_nextHref"
          value={`/app/admin/people/safety-training/${params.courseId}/${params.versionId}/publish-review`}
        />
        <section className="card card-body space-y-4">
          <h2 className="section-title text-lg">Audience</h2>
          <ApplicabilityPicker
            initialMode={initialMode}
            departments={departments}
            positions={positions.map((p: { id: string; name: string; departmentId: string | null }) => ({
              id: p.id,
              name: p.name,
              departmentId: p.departmentId ?? null,
            }))}
            selectedDeptIds={selectedDeptIds}
            selectedPosIds={selectedPosIds}
          />
          <label className="flex items-start gap-3 pt-2 border-t border-stone-200">
            <input
              type="checkbox"
              name="audienceConfirmed"
              required
              className="mt-1"
              data-testid="training-requirements-audience-confirm"
            />
            <span className="text-sm text-stone-800">
              <span className="font-medium">I&apos;ve confirmed the audience above.</span>
              <span className="block text-xs text-stone-500 mt-0.5">
                Spectre doesn&apos;t default this to Everyone &mdash; please check
                the selection matches who you intend to assign.
              </span>
            </span>
          </label>
        </section>

        <section className="card card-body space-y-4">
          <h2 className="section-title text-lg">Grading</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="label" htmlFor="passingScore">Passing grade</label>
              <input
                id="passingScore"
                name="passingScore"
                type="number"
                min={0}
                max={100}
                defaultValue={version.passingScore ?? 80}
                className="input font-mono"
                data-testid="training-requirements-passing-score"
              />
              <p className="mt-1 text-xs text-stone-500">
                Percentage required to pass the final assessment.
              </p>
            </div>
            <div className="flex items-end gap-3">
              <label className="flex items-start gap-3 text-sm">
                <input
                  type="checkbox"
                  name="retakesAllowed"
                  defaultChecked={!!version.retakesAllowed}
                  className="mt-1"
                  data-testid="training-requirements-retakes"
                />
                <span>
                  <span className="font-medium">Allow retakes</span>
                  <span className="block text-xs text-stone-500">
                    Employees who fail can try again.
                  </span>
                </span>
              </label>
            </div>
          </div>
        </section>

        <section className="card card-body space-y-4">
          <h2 className="section-title text-lg">Compliance</h2>
          <label className="flex items-start gap-3">
            <input
              type="checkbox"
              name="required"
              defaultChecked={!!version.required}
              className="mt-1"
              data-testid="training-requirements-required"
            />
            <span className="text-sm text-stone-800">
              <span className="font-medium">Required for scheduling</span>
              <span className="block text-xs text-stone-500 mt-0.5">
                Employees cannot submit availability or be scheduled until they
                complete this course. Uncheck for optional training.
              </span>
            </span>
          </label>
          <label className="flex items-start gap-3">
            <input
              type="checkbox"
              name="requiresKnowledgeTest"
              defaultChecked={!!version.requiresKnowledgeTest}
              className="mt-1"
              data-testid="training-requirements-requires-knowledge-test"
            />
            <span className="text-sm text-stone-800">
              <span className="font-medium">Requires knowledge test</span>
              <span className="block text-xs text-stone-500 mt-0.5">
                The course includes checkpoints + a final assessment the employee must pass.
              </span>
            </span>
          </label>
        </section>

        <div className="flex items-center justify-between gap-3">
          <Link
            href={`/app/admin/people/safety-training/${params.courseId}/${params.versionId}/review`}
            className="text-sm text-stone-500 hover:text-club-ink"
          >
            ← Back
          </Link>
          <button
            type="submit"
            className="btn btn-primary"
            data-testid="training-requirements-save"
          >
            Save &amp; continue to publish review →
          </button>
        </div>
      </form>
    </div>
  );
}
