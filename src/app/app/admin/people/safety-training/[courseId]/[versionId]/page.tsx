// HR-2C B2 (2026-08-20) — Course version editor / viewer.
//
// DRAFT versions render the full editor (title/description/passing
// score/retakes/knowledge-test-required/applicability/video upload/
// quiz builder + Publish panel).
//
// PUBLISHED and RETIRED versions render a read-only view with a link
// to "Start new draft" (routed from the course-detail page).
//
// Every mutation goes through the server actions in `../_actions.ts`,
// which delegate to the B1 canonical services. Publish readiness is
// computed by `checkPublishReadiness` from the B1 service — never
// duplicated in the React layer (§25 explicit).

import Link from "next/link";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { hasPermission } from "@/lib/rbac";
import {
  checkPublishReadiness,
  TRAINING_COURSE_CATEGORIES,
} from "@/lib/hr/training/courses";
import {
  updateDraftAction,
  publishDraftAction,
  createQuestionAction,
  updateQuestionAction,
  deleteQuestionAction,
} from "../../_actions";
import VideoUploader from "./VideoUploader";
import QuizEditor from "./QuizEditor";
import ApplicabilityPicker from "./ApplicabilityPicker";
import PublishPanel from "./PublishPanel";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function VersionEditorPage({
  params,
  searchParams,
}: {
  params: { courseId: string; versionId: string };
  searchParams: Promise<{ err?: string }>;
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
      course: true,
      questions: {
        orderBy: { displayOrder: "asc" },
        include: { options: { orderBy: { displayOrder: "asc" } } },
      },
    },
  });
  if (!version) redirect("/app/admin/people/safety-training");
  const canAuthor = hasPermission(principal, clubId, "hr:training:write");
  const canPublish = hasPermission(principal, clubId, "hr:training:publish");
  const { err } = await searchParams;

  const [departments, positions] = await Promise.all([
    prisma.department.findMany({
      where: { clubId, isActive: true },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
    prisma.employeePosition.findMany({
      where: { clubId, isActive: true },
      select: { id: true, name: true, departmentId: true },
      orderBy: { name: "asc" },
    }),
  ]);
  const selectedDeptIds: string[] = version.appliesToDeptIds
    ? (JSON.parse(version.appliesToDeptIds) as string[])
    : [];
  const selectedPosIds: string[] = version.appliesToPositionIds
    ? (JSON.parse(version.appliesToPositionIds) as string[])
    : [];
  const applicabilityMode: "everyone" | "scoped" | "explicit" = version.appliesToAll
    ? "everyone"
    : (selectedDeptIds.length > 0 || selectedPosIds.length > 0)
      ? "scoped"
      : "explicit";

  const readiness = version.state === "DRAFT"
    ? await checkPublishReadiness(version.id)
    : { ready: true, reasons: [] as string[] };

  const stateBadge = version.state === "PUBLISHED"
    ? { label: `Published v${version.version}`, tone: "emerald" }
    : version.state === "DRAFT"
      ? { label: `Draft v${version.version}`, tone: "amber" }
      : { label: `Retired v${version.version}`, tone: "stone" };

  const updateAction = updateDraftAction.bind(null, params.courseId, params.versionId);
  const publishAction = publishDraftAction.bind(null, params.courseId, params.versionId);
  const isDraft = version.state === "DRAFT";
  const readOnly = !isDraft || !canAuthor;

  return (
    <div>
      <Link href={`/app/admin/people/safety-training/${params.courseId}`} className="text-sm text-stone-500 hover:text-club-ink">
        ← {version.course.title}
      </Link>
      <div className="mt-3 mb-6 flex items-baseline justify-between gap-4">
        <div>
          <h1 className="page-title">{version.title}</h1>
          <p className="mt-1 text-xs text-stone-500 font-mono">{version.course.code}</p>
        </div>
        <span className={
          "inline-block rounded border px-3 py-1 text-xs font-medium " +
          (stateBadge.tone === "emerald"
            ? "bg-emerald-50 text-emerald-800 border-emerald-200"
            : stateBadge.tone === "amber"
              ? "bg-amber-50 text-amber-800 border-amber-200"
              : "bg-stone-100 text-stone-600 border-stone-200")
        } data-testid="training-version-state">
          {stateBadge.label}
        </span>
      </div>

      {err && (
        <div role="alert" className="mb-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700" data-testid="training-editor-error">
          {err}
        </div>
      )}

      {!isDraft && (
        <div className="mb-6 rounded-md border border-stone-200 bg-stone-50 px-4 py-3 text-sm text-stone-700">
          This version is {version.state.toLowerCase()}. To edit content,
          <Link href={`/app/admin/people/safety-training/${params.courseId}`} className="ml-1 underline underline-offset-4">
            open the course
          </Link>{" "}
          and start a new draft.
        </div>
      )}

      <form action={updateAction} className="space-y-6" data-testid="training-editor-form">
        <section className="card card-body space-y-4">
          <h2 className="section-title text-lg">Course content</h2>
          <div>
            <label className="label" htmlFor="title">Course title</label>
            <input
              id="title"
              name="title"
              className="input"
              required
              maxLength={200}
              defaultValue={version.title}
              disabled={readOnly}
              data-testid="training-editor-title"
            />
          </div>
          <div>
            <label className="label" htmlFor="description">Description</label>
            <textarea
              id="description"
              name="description"
              className="input"
              rows={3}
              maxLength={500}
              defaultValue={version.description ?? ""}
              disabled={readOnly}
              data-testid="training-editor-description"
            />
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label className="label" htmlFor="passingScore">Passing score</label>
              <div className="flex items-center gap-2">
                <input
                  id="passingScore"
                  name="passingScore"
                  type="number"
                  min={0}
                  max={100}
                  step={1}
                  className="input"
                  defaultValue={version.passingScore}
                  disabled={readOnly}
                  data-testid="training-editor-passing-score"
                />
                <span className="text-stone-500 text-sm">%</span>
              </div>
            </div>
            <div className="flex items-start gap-3 mt-2">
              <input
                type="checkbox"
                id="retakesAllowed"
                name="retakesAllowed"
                defaultChecked={version.retakesAllowed}
                disabled={readOnly}
                className="mt-1"
                data-testid="training-editor-retakes"
              />
              <label htmlFor="retakesAllowed" className="text-sm text-stone-800">
                Retakes allowed
                <span className="block text-xs text-stone-500">
                  When off, an employee has one attempt only.
                </span>
              </label>
            </div>
            <div className="flex items-start gap-3 mt-2">
              <input
                type="checkbox"
                id="requiresKnowledgeTest"
                name="requiresKnowledgeTest"
                defaultChecked={version.requiresKnowledgeTest}
                disabled={readOnly}
                className="mt-1"
                data-testid="training-editor-requires-quiz"
              />
              <label htmlFor="requiresKnowledgeTest" className="text-sm text-stone-800">
                Include knowledge test
                <span className="block text-xs text-stone-500">
                  When off, completion is granted at video threshold.
                </span>
              </label>
            </div>
          </div>
          <div className="flex items-start gap-3">
            <input
              type="checkbox"
              name="required"
              id="required"
              defaultChecked={version.required}
              disabled={readOnly}
              className="mt-1"
              data-testid="training-editor-required"
            />
            <label htmlFor="required" className="text-sm text-stone-800">
              <span className="font-medium">Required for scheduling</span>
              <span className="block text-xs text-stone-500">
                Uncheck for optional courses. Optional courses do not block Availability.
              </span>
            </label>
          </div>
        </section>

        <section className="card card-body space-y-4">
          <h2 className="section-title text-lg">Who needs to complete this?</h2>
          <ApplicabilityPicker
            initialMode={applicabilityMode}
            departments={departments}
            positions={positions}
            selectedDeptIds={selectedDeptIds}
            selectedPosIds={selectedPosIds}
            disabled={readOnly}
          />
        </section>

        {isDraft && canAuthor && (
          <div className="flex items-center justify-end">
            <button type="submit" className="btn btn-primary" data-testid="training-editor-save">
              Save draft
            </button>
          </div>
        )}
      </form>

      <section className="card card-body space-y-4 mt-8" data-testid="training-editor-video-section">
        <h2 className="section-title text-lg">Training video</h2>
        <VideoUploader
          versionId={version.id}
          currentSha256={version.videoSha256}
          currentMimeType={version.videoMimeType}
          currentSizeBytes={version.videoSizeBytes}
          durationSec={version.videoDurationSec}
          disabled={readOnly}
        />
      </section>

      <section className="card card-body space-y-4 mt-8" data-testid="training-editor-quiz-section">
        <h2 className="section-title text-lg">Knowledge test</h2>
        {!version.requiresKnowledgeTest && (
          <p className="text-sm text-stone-600">
            This course does not include a knowledge test. Employees complete the course
            when the video threshold is met.
          </p>
        )}
        <QuizEditor
          courseId={params.courseId}
          versionId={version.id}
          questions={version.questions.map((q) => ({
            id: q.id,
            prompt: q.prompt,
            active: q.active,
            options: q.options.map((o) => ({
              id: o.id,
              text: o.text,
              isCorrect: o.isCorrect,
            })),
          }))}
          disabled={readOnly}
          categorySuggestions={[...TRAINING_COURSE_CATEGORIES]}
          createAction={createQuestionAction}
          updateAction={updateQuestionAction}
          deleteAction={deleteQuestionAction}
        />
      </section>

      {isDraft && (
        <section className="card card-body space-y-4 mt-8">
          <h2 className="section-title text-lg">Publish</h2>
          <PublishPanel
            readiness={readiness}
            canPublish={canPublish}
            publishAction={publishAction}
          />
        </section>
      )}
    </div>
  );
}
