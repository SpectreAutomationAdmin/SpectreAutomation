// EP-TRAIN-4Y-T §2+§3+§4 — upload-first screen for a provisional
// with-video draft. Renders prominently as the manager's first visible
// action after picking "With video" on the format-selection card.
//
// Behaviour:
//   - If the version already has a video (sha256 present), redirect
//     straight to the Manager Review surface — upload is done.
//   - Otherwise, render the existing VideoUploader prominently + the
//     plain-language CoursePrepProgress placeholder (stages below the
//     dropzone update once upload completes).
//
// The dropzone + progress components are reused from 4Y-S; no new
// upload service, no new storage path. The directive explicitly
// preserves the Spectre visual language.

import Link from "next/link";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { hasPermission } from "@/lib/rbac";
import VideoUploader from "../VideoUploader";
import CoursePrepProgress from "../CoursePrepProgress";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function CourseUploadEntry({
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
    include: { course: { select: { id: true, code: true } } },
  });
  if (!version) redirect("/app/admin/people/safety-training");

  // EP-TRAIN-4Y-U §6 — only auto-redirect to review once AI
  // preparation has actually produced reviewable drafts. If the
  // video is uploaded but generation hasn't produced drafts, stay
  // on the preparation page so the manager sees the real pipeline
  // state (CoursePrepProgress below the dropzone).
  const draftCount = version.videoSha256
    ? await prisma.trainingQuestionAiDraft.count({
        where: { clubId, courseVersionId: version.id },
      })
    : 0;
  if (version.videoSha256 && draftCount > 0) {
    redirect(
      `/app/admin/people/safety-training/${params.courseId}/${params.versionId}/review`,
    );
  }

  const videoPresent = !!version.videoSha256;

  return (
    <div className="max-w-[920px]">
      <Link
        href="/app/admin/people/safety-training/new"
        className="text-sm text-stone-500 hover:text-club-ink"
      >
        ← Choose format
      </Link>
      <div className="mt-3 mb-6">
        <h1 className="page-title">
          {videoPresent ? "Preparing your course" : "Upload your training video"}
        </h1>
        <p className="mt-1 text-sm text-stone-500">
          {videoPresent ? (
            <>
              The video has uploaded. Spectre is preparing the course now &mdash;
              transcription, title and description, knowledge checkpoints, and
              final-assessment questions. You can leave this page and come back;
              progress is saved.
            </>
          ) : (
            <>
              Drag a video onto the dropzone below or click to browse. Spectre will
              transcribe the video and prepare the course automatically &mdash; you&apos;ll
              review the generated title, description, and questions in the next step.
            </>
          )}
        </p>
      </div>

      {!videoPresent && (
        <section className="card card-body" data-testid="training-upload-entry-dropzone-section">
          <VideoUploader
            versionId={version.id}
            currentSha256={null}
            currentMimeType={null}
            currentSizeBytes={null}
            durationSec={null}
            disabled={false}
          />
        </section>
      )}

      <div
        className={videoPresent ? "" : "mt-6"}
        data-testid="training-upload-entry-prep-placeholder"
      >
        <CoursePrepProgress versionId={version.id} />
      </div>

      <p className="mt-4 text-xs text-stone-500">
        Internal reference: <span className="font-mono">{version.course.code}</span>.
        {" "}The real course code is generated from the AI title after preparation.
      </p>
    </div>
  );
}
