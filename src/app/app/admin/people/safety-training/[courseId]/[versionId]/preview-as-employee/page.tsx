// EP-TRAIN-4Y-Q §8 — Preview-as-employee surface.
//
// Reuses the existing employee CoursePlayer client component so the
// manager sees the EXACT runtime an employee would see — video gate,
// checkpoint interrupts, retry policy, seek-forward discipline, the
// pass/fail UX, the completion overlay — WITHOUT any database write
// against the TrainingCompletion / TrainingAttempt / TrainingProgress
// tables. The four server actions the player calls are no-ops
// defined in ./_actions.ts.
//
// Authorisation: `hr:training:read` on the active club. Preview mode
// is READ-ONLY. The founder authored the directive to make preview
// available to managers without requiring an employee login.
//
// Not navigable from the public employee surface. Linked only from
// the canonical editor.

import Link from "next/link";
import { redirect, notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { hasPermission } from "@/lib/rbac";
import CoursePlayer from "@/app/employee/(authed)/safety-training/[versionId]/CoursePlayer";
import {
  previewRecordProgressAction,
  previewStartAttemptAction,
  previewSubmitAttemptAction,
  previewStartCheckpointAttemptAction,
} from "./_actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function PreviewAsEmployeePage({
  params,
}: {
  params: Promise<{ courseId: string; versionId: string }>;
}): Promise<React.ReactElement> {
  const { courseId, versionId } = await params;
  const principal = await getCurrentPrincipal();
  if (!principal) redirect("/login");
  const clubId = await getActiveClubId({
    clubId: principal.activeClubId ?? null,
    role: "",
    id: principal.id,
  });
  if (!hasPermission(principal, clubId, "hr:training:read")) {
    redirect("/app/admin/people/employees");
  }

  const version = await prisma.trainingCourseVersion.findFirst({
    where: { id: versionId, course: { id: courseId, clubId } },
    include: {
      course: true,
      questions: {
        orderBy: { displayOrder: "asc" },
        include: { options: { orderBy: { displayOrder: "asc" } } },
      },
      checkpoints: {
        orderBy: { atSecond: "asc" },
        include: {
          questions: {
            where: { active: true },
            include: { options: { orderBy: { displayOrder: "asc" } } },
          },
        },
      },
    },
  });
  if (!version) notFound();

  // Shape to CoursePlayer's prop contract. Every question option's
  // `isCorrect` is INTENTIONALLY STRIPPED here — the client never sees
  // the correct answer; server-side grading is still simulated by
  // previewSubmitAttemptAction below.
  const checkpoints = version.checkpoints.map((c) => ({
    id: c.id,
    atSecond: c.atSecond,
    label: c.label,
    requiredToProceed: c.requiredToProceed,
    maxRetries: c.maxRetries,
    questions: c.questions.map((q) => ({
      id: q.id,
      prompt: q.prompt,
      questionType: q.questionType as "SINGLE_CHOICE" | "MULTI_ANSWER" | "TRUE_FALSE",
      options: q.options.map((o) => ({
        id: o.id,
        text: o.text,
        displayOrder: o.displayOrder,
      })),
    })),
  }));

  const finalQuestions = version.questions
    .filter((q) => q.checkpointId === null && q.active)
    .map((q) => ({
      id: q.id,
      prompt: q.prompt,
      questionType: q.questionType as "SINGLE_CHOICE" | "MULTI_ANSWER" | "TRUE_FALSE",
      options: q.options.map((o) => ({
        id: o.id,
        text: o.text,
        displayOrder: o.displayOrder,
      })),
    }));

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <Link
          href={`/app/admin/people/safety-training/${courseId}/${versionId}`}
          className="text-sm text-stone-500 hover:text-club-ink"
        >
          ← Back to editor
        </Link>
        <span
          className="inline-block rounded border px-3 py-1 text-xs font-medium bg-amber-50 text-amber-800 border-amber-200"
          data-testid="training-preview-mode-badge"
        >
          Preview as employee · no completion recorded
        </span>
      </div>

      <div
        className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900"
        role="status"
      >
        <strong>Preview mode.</strong> You are seeing the exact runtime an employee would see —
        video gate, checkpoint interrupts, retry policy, seek-forward discipline, final-assessment
        unlock. Every action in this preview is a no-op against the database: no{" "}
        <code>TrainingProgress</code>, <code>TrainingAttempt</code>, or{" "}
        <code>TrainingCompletion</code> row is written. Submit answers freely to test the flow.
      </div>

      <h1 className="page-title">{version.title}</h1>

      <CoursePlayer
        versionId={version.id}
        hasVideo={!!version.videoStorageKey}
        videoDurationSec={version.videoDurationSec}
        requiresKnowledgeTest={version.requiresKnowledgeTest}
        passingScore={version.passingScore}
        retakesAllowed={version.retakesAllowed}
        thresholdPercent={80}
        initialProgress={{ secondsWatched: 0, farthestSecond: 0, percentComplete: 0, videoCompleted: false }}
        questions={finalQuestions}
        checkpoints={checkpoints}
        initialClearedCheckpointIds={[]}
        alreadyCompleted={false}
        canRetake={false}
        blockingSubmittedAttempt={false}
        submittedAttempts={[]}
        recordProgressAction={previewRecordProgressAction}
        startAttemptAction={previewStartAttemptAction}
        submitAttemptAction={previewSubmitAttemptAction}
        startCheckpointAttemptAction={previewStartCheckpointAttemptAction}
        nextRequiredCourseHref={null}
      />
    </div>
  );
}
