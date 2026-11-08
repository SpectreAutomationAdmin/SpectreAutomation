// EP-TRAIN-4Y-P §4 + §5 — AI-assisted suggestions, surfaced inline
// in the canonical course editor so a manager never needs to open
// the separate AI Workspace to discover what the pipeline produced.
//
// Server component. Reads `TrainingTranscriptBuild`,
// `TrainingQuestionAiGenerationRun`, and `TrainingQuestionAiDraft`
// via Prisma. Emits state tiles + a per-draft list with direct
// "Open review" links into the persisted-review surface — the
// surface the lifecycle + approval service already consume.
//
// No mutations. No bulk approval. No promotion. The reviewer still
// transitions each draft through the existing approval route.

import Link from "next/link";
import { prisma } from "@/lib/prisma";

export async function AiSuggestionsPanel({
  clubId,
  courseVersionId,
  canReview,
}: {
  readonly clubId: string;
  readonly courseVersionId: string;
  readonly canReview: boolean;
}): Promise<React.ReactElement> {
  // ─── Transcript state (via the latest build for this video SHA).
  const version = await prisma.trainingCourseVersion.findUnique({
    where: { id: courseVersionId },
    select: { videoSha256: true, videoDurationSec: true },
  });
  const latestBuild = version?.videoSha256
    ? await prisma.trainingTranscriptBuild.findFirst({
        where: { clubId, sourceVideoSha256: version.videoSha256 },
        orderBy: { producedAt: "desc" },
        select: {
          id: true,
          resolvedTranscriptBuildId: true,
          producedAt: true,
          transcriberName: true,
        },
      })
    : null;

  const segmentCount = latestBuild
    ? await prisma.trainingTranscriptSegment.count({
        where: { clubId, transcriptBuildId: latestBuild.id },
      })
    : 0;

  // ─── Generation runs on this version.
  const runs = await prisma.trainingQuestionAiGenerationRun.findMany({
    where: { clubId, courseVersionId },
    orderBy: { requestedAt: "desc" },
    select: {
      id: true,
      executionStatus: true,
      requestedAt: true,
      completedAt: true,
      _count: { select: { drafts: true } },
    },
    take: 4,
  });

  // ─── Drafts attached to this version (all runs).
  const drafts = await prisma.trainingQuestionAiDraft.findMany({
    where: { clubId, courseVersionId },
    select: {
      id: true,
      state: true,
      contentHash: true,
      draftJson: true,
      generatedAt: true,
      groundingProjectionId: true,
      generationRunId: true,
      promotion: { select: { id: true } },
      _count: { select: { validations: true } },
    },
    orderBy: { generatedAt: "desc" },
    take: 60,
  });

  // Group drafts by intended destination (checkpoint = has an atSec
  // in the candidate; final = otherwise). Since the TrainingQuestionAiDraft
  // model doesn't carry this on the row, we approximate by looking
  // at the destination-of-promotion if available, and otherwise fall
  // back to "proposed" counts from the generation run's plan. For
  // discovery purposes we show by STATE first.
  const byState = {
    REQUIRES_HUMAN_REVIEW: drafts.filter((d) => d.state === "REQUIRES_HUMAN_REVIEW"),
    APPROVED_DRAFT: drafts.filter((d) => d.state === "APPROVED_DRAFT"),
    REJECTED: drafts.filter((d) => d.state === "REJECTED"),
    EDITED_VALIDATION_STALE: drafts.filter((d) => d.state === "EDITED_VALIDATION_STALE"),
    OTHER: drafts.filter(
      (d) =>
        ![
          "REQUIRES_HUMAN_REVIEW",
          "APPROVED_DRAFT",
          "REJECTED",
          "EDITED_VALIDATION_STALE",
        ].includes(d.state),
    ),
  };

  const totalDrafts = drafts.length;
  const projectionBound = drafts.filter((d) => d.groundingProjectionId !== null).length;
  const validatedCount = drafts.filter((d) => d._count.validations > 0).length;
  const promotedCount = drafts.filter((d) => d.promotion !== null).length;

  const latestRun = runs[0];
  const transcriptReady = latestBuild !== null;

  return (
    <section
      className="card card-body space-y-4"
      data-testid="training-editor-ai-suggestions-panel"
    >
      <div className="flex items-baseline justify-between gap-3 flex-wrap">
        <h2 className="section-title text-lg">AI-assisted authoring</h2>
        <span className="text-xs text-stone-500">
          Transcription · assessment plan · draft questions. Independent reviewer approval required
          before any question can enter the course.
        </span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
        <StateTile
          label="Transcript"
          value={
            transcriptReady
              ? `READY · ${segmentCount} segments`
              : "Not yet transcribed"
          }
          tone={transcriptReady ? "emerald" : "stone"}
          sub={
            latestBuild
              ? `${latestBuild.transcriberName ?? "transcriber"} · ${formatDate(latestBuild.producedAt)}`
              : ""
          }
        />
        <StateTile
          label="Latest generation run"
          value={
            latestRun
              ? `${latestRun.executionStatus} · ${latestRun._count.drafts} drafts`
              : "No runs yet"
          }
          tone={
            latestRun?.executionStatus === "COMPLETED"
              ? "emerald"
              : latestRun?.executionStatus === "FAILED"
                ? "amber"
                : "stone"
          }
          sub={latestRun ? `${latestRun.id.slice(0, 20)}…` : ""}
        />
        <StateTile
          label="Drafts awaiting review"
          value={`${byState.REQUIRES_HUMAN_REVIEW.length} pending`}
          tone={byState.REQUIRES_HUMAN_REVIEW.length > 0 ? "amber" : "stone"}
          sub={`${byState.APPROVED_DRAFT.length} approved · ${byState.REJECTED.length} rejected`}
        />
        <StateTile
          label="Provenance"
          value={`${projectionBound}/${totalDrafts} projection · ${validatedCount}/${totalDrafts} validated`}
          tone={
            totalDrafts > 0 && projectionBound === totalDrafts && validatedCount === totalDrafts
              ? "emerald"
              : "amber"
          }
          sub={
            promotedCount > 0
              ? `${promotedCount} promoted into the course`
              : "No draft promoted yet"
          }
        />
      </div>

      {!canReview && (
        <p className="text-xs text-stone-500">
          You have read-only access to the AI-review queue; approvals require the
          <code className="mx-1 rounded bg-stone-100 px-1">hr:training:ai:approve</code>
          permission (Spectre training reviewer role).
        </p>
      )}

      {byState.REQUIRES_HUMAN_REVIEW.length > 0 && canReview && (
        <details className="group" open={false} data-testid="training-editor-ai-pending-list">
          <summary className="cursor-pointer text-sm text-stone-800 hover:text-club-ink">
            Review {byState.REQUIRES_HUMAN_REVIEW.length} pending AI-generated question
            {byState.REQUIRES_HUMAN_REVIEW.length === 1 ? "" : "s"}
          </summary>
          <ul className="mt-3 space-y-2">
            {byState.REQUIRES_HUMAN_REVIEW.slice(0, 20).map((d) => {
              let preview = "";
              try {
                const body = JSON.parse(d.draftJson);
                preview =
                  typeof body.questionText === "string"
                    ? body.questionText.replace(/\s+/g, " ").slice(0, 110) + "…"
                    : "";
              } catch {}
              return (
                <li
                  key={d.id}
                  className="flex items-start justify-between gap-3 rounded border border-stone-200 p-3"
                  data-testid={`training-editor-ai-draft-row-${d.id}`}
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-stone-800 truncate">{preview || "(no preview)"}</p>
                    <p className="mt-1 text-xs text-stone-500 font-mono">
                      hash {d.contentHash.slice(0, 10)}… ·{" "}
                      {d.groundingProjectionId ? "projection bound" : "projection missing"} ·{" "}
                      {d._count.validations > 0 ? "validated" : "unvalidated"}
                    </p>
                  </div>
                  <Link
                    href={`/app/admin/ai-training/review/persisted?candidate=${d.id}`}
                    className="btn btn-secondary btn-sm shrink-0"
                    data-testid={`training-editor-ai-open-review-${d.id}`}
                  >
                    Open review
                  </Link>
                </li>
              );
            })}
            {byState.REQUIRES_HUMAN_REVIEW.length > 20 && (
              <li className="text-xs text-stone-500">
                + {byState.REQUIRES_HUMAN_REVIEW.length - 20} more …
              </li>
            )}
          </ul>
        </details>
      )}

      {byState.APPROVED_DRAFT.length > 0 && (
        <p className="text-xs text-emerald-700">
          {byState.APPROVED_DRAFT.length} approved draft
          {byState.APPROVED_DRAFT.length === 1 ? "" : "s"} are ready to promote into the active
          course below.
        </p>
      )}
    </section>
  );
}

function StateTile({
  label,
  value,
  tone,
  sub,
}: {
  label: string;
  value: string;
  tone: "emerald" | "amber" | "stone";
  sub?: string;
}): React.ReactElement {
  const valueClass =
    tone === "emerald"
      ? "text-emerald-800"
      : tone === "amber"
        ? "text-amber-800"
        : "text-stone-700";
  return (
    <div className="rounded-md border border-stone-200 bg-stone-50/40 p-3">
      <p className="text-[10px] uppercase tracking-widest text-stone-500">{label}</p>
      <p className={`mt-1 text-sm font-medium ${valueClass}`}>{value}</p>
      {sub && <p className="mt-1 text-[11px] text-stone-500 truncate">{sub}</p>}
    </div>
  );
}

function formatDate(d: Date | null | undefined): string {
  if (!d) return "";
  try {
    return new Date(d).toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return String(d);
  }
}
