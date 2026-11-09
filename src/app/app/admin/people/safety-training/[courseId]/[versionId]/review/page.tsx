// EP-TRAIN-4Y-S §5+§6+§7+§8 — Manager Review (video-first authoring).
//
// Purpose: the manager-facing surface for an AI-prepared course. The
// existing admin editor page remains for deep authoring; this page is
// the one the founder's directive asks to lead with — a focused,
// guided review of the AI's proposals, one question at a time, with
// the video + timeline on the left and the question pane on the right.
//
// Data loaded server-side (tenant-scoped at every query):
//   - Course + version + checkpoints + (promoted) questions
//   - AI drafts for this version via the existing read service
//
// Actions on the client call the existing approve / reject / promote
// routes — no new mutation paths are introduced here. Separation of
// duties is unchanged: a CLUB_ADMIN promotes already-approved drafts
// but cannot approve; a TRAINING_AI_REVIEWER approves but cannot
// promote. Both can discard.

import Link from "next/link";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { hasPermission } from "@/lib/rbac";
import { listCheckpointsForVersion } from "@/lib/hr/training/checkpoints";
import ManagerReviewClient from "./ManagerReviewClient";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function ManagerReviewPage({
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
    },
  });
  if (!version) redirect("/app/admin/people/safety-training");

  const canApprove = hasPermission(principal, clubId, "hr:training:ai:approve");
  const canAuthor = hasPermission(principal, clubId, "hr:training:write");
  const canRead = hasPermission(principal, clubId, "hr:training:ai:read");

  const checkpoints = await listCheckpointsForVersion(version.id);

  // Pull AI drafts for this version. Tenant scope is enforced via the
  // (clubId, courseVersionId) filter; the state filter avoids rendering
  // archived / failed noise.
  type ClientDraft = {
    id: string;
    state: string;
    questionText: string;
    questionType: string;
    options: { optionText: string; isCorrect: boolean }[];
    sourceSegmentIds: number[];
    correctOptionIndex: number;
    isPromoted: boolean;
  };
  let drafts: ClientDraft[] = [];
  if (canRead) {
    const rows = await prisma.trainingQuestionAiDraft.findMany({
      where: {
        clubId,
        courseVersionId: version.id,
        state: {
          in: [
            "REQUIRES_HUMAN_REVIEW",
            "APPROVED_DRAFT",
            "REJECTED",
            "GENERATED",
            "VALIDATION_PENDING",
          ],
        },
      },
      orderBy: [{ generatedAt: "asc" }, { id: "asc" }],
      select: {
        id: true,
        state: true,
        draftJson: true,
        promotion: { select: { questionId: true } },
      },
      take: 100,
    });
    drafts = rows.map((d) => {
      let body: {
        questionText?: unknown;
        questionType?: unknown;
        options?: unknown;
        sourceSegmentIds?: unknown;
      } = {};
      try {
        body = JSON.parse(d.draftJson || "{}");
      } catch {}
      const options: { text?: string; isCorrect?: boolean }[] = Array.isArray(body.options)
        ? (body.options as { text?: string; isCorrect?: boolean }[])
        : [];
      let correctIndex = 0;
      for (let i = 0; i < options.length; i++) {
        if (options[i]?.isCorrect) {
          correctIndex = i;
          break;
        }
      }
      return {
        id: d.id,
        state: d.state,
        questionText: String(body.questionText ?? "(no question text)"),
        questionType: String(body.questionType ?? "MULTIPLE_CHOICE"),
        options: options.map((o) => ({
          optionText: String(o?.text ?? ""),
          isCorrect: !!o?.isCorrect,
        })),
        sourceSegmentIds: Array.isArray(body.sourceSegmentIds)
          ? (body.sourceSegmentIds as unknown[]).filter(
              (n): n is number => typeof n === "number",
            )
          : [],
        correctOptionIndex: correctIndex,
        isPromoted: d.state === "APPROVED_DRAFT" && !!d.promotion?.questionId,
      };
    });
  }

  return (
    <div className="max-w-[1400px]">
      <div className="flex items-center justify-between mb-6">
        <div>
          <Link
            href={`/app/admin/people/safety-training/${params.courseId}/${params.versionId}`}
            className="text-sm text-stone-500 hover:text-club-ink"
          >
            ← Course editor
          </Link>
          <h1 className="page-title mt-2">{version.course.title}</h1>
          <p className="text-sm text-stone-500 mt-1">
            Review the questions Spectre generated from your video. Accept
            what&apos;s correct; discard what doesn&apos;t fit.
          </p>
        </div>
      </div>
      <ManagerReviewClient
        versionId={version.id}
        courseTitle={version.course.title}
        courseDescription={version.description ?? ""}
        videoStorageKey={version.videoStorageKey ?? null}
        videoDurationSec={version.videoDurationSec ?? null}
        videoUrl={
          version.videoStorageKey
            ? `/api/hr/training/versions/${version.id}/video`
            : null
        }
        drafts={drafts}
        checkpoints={checkpoints.map((c) => ({
          id: c.id,
          title: c.label ?? `Checkpoint at ${Math.floor(c.atSecond / 60)}:${String(
            Math.floor(c.atSecond % 60),
          ).padStart(2, "0")}`,
          atSecond: c.atSecond,
        }))}
        canApprove={canApprove}
        canAuthor={canAuthor}
        courseId={params.courseId}
      />
    </div>
  );
}
