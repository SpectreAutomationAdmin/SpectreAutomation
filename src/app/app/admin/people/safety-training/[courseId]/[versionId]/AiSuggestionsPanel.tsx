// EP-TRAIN-4Y-P §4+§5 + EP-TRAIN-4Y-Q §3+§4+§6+§7 — AI suggestions
// surface inside the canonical course editor.
//
// Server component. Reads TrainingTranscriptBuild,
// TrainingQuestionAiGenerationRun, TrainingQuestionAiDraft and (as of
// 4Y-Q) each draft's cited TrainingTranscriptSegment rows (for the
// per-segment `reviewerAttestedAt` fact) + the latest validation
// errors. Hands per-draft rendering off to `AiDraftInlineActions`
// (client component) so the manager can Attest / Revalidate /
// Reject / Approve / Promote inline without navigating away.

import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { AiDraftInlineActions } from "@/components/ai-training/AiDraftInlineActions";

export async function AiSuggestionsPanel({
  clubId,
  courseVersionId,
  canReview,
}: {
  readonly clubId: string;
  readonly courseVersionId: string;
  readonly canReview: boolean;
}): Promise<React.ReactElement> {
  // ─── Transcript state (latest build for this video SHA)
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

  // Available checkpoint destinations for promotion (editor-authored).
  const checkpoints = await prisma.trainingCheckpoint.findMany({
    where: { courseVersionId },
    select: { id: true, atSecond: true, label: true },
    orderBy: { atSecond: "asc" },
  });
  const checkpointOptions = checkpoints.map((c) => ({
    id: c.id,
    label: c.label ? `${c.label} · ${formatSec(c.atSecond)}` : formatSec(c.atSecond),
  }));

  // ─── Runs on this version (for the state tile).
  const runs = await prisma.trainingQuestionAiGenerationRun.findMany({
    where: { clubId, courseVersionId },
    orderBy: { requestedAt: "desc" },
    take: 4,
    select: {
      id: true,
      executionStatus: true,
      requestedAt: true,
      _count: { select: { drafts: true } },
    },
  });
  const latestRun = runs[0];

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

  // Aggregate counts by state.
  const totalDrafts = drafts.length;
  const projectionBound = drafts.filter((d) => d.groundingProjectionId !== null).length;
  const validatedCount = drafts.filter((d) => d._count.validations > 0).length;
  const promotedCount = drafts.filter((d) => d.promotion !== null).length;
  const byState = {
    REQUIRES_HUMAN_REVIEW: drafts.filter((d) => d.state === "REQUIRES_HUMAN_REVIEW"),
    APPROVED_DRAFT: drafts.filter((d) => d.state === "APPROVED_DRAFT"),
    REJECTED: drafts.filter((d) => d.state === "REJECTED"),
  };

  // ─── For each actionable draft, resolve cited segments + latest
  //     validation errors. We fetch these in parallel batches so the
  //     editor's SSR render time stays bounded even on 48+ drafts.
  const actionable = drafts
    .filter(
      (d) =>
        d.state === "REQUIRES_HUMAN_REVIEW" ||
        d.state === "APPROVED_DRAFT" ||
        d.state === "REJECTED",
    )
    .slice(0, 30); // cap so SSR doesn't balloon; "see more" link below for the full queue
  const actionableData = await Promise.all(
    actionable.map(async (d) => {
      const body = tryParseBody(d.draftJson);
      const sourceSegmentIds: number[] = Array.isArray(body?.sourceSegmentIds)
        ? body.sourceSegmentIds.filter((n: unknown) => typeof n === "number")
        : [];
      const [citedSegmentRows, latestValidation] = await Promise.all([
        latestBuild
          ? prisma.trainingTranscriptSegment.findMany({
              where: {
                clubId,
                transcriptBuildId: latestBuild.id,
                segmentIndex: { in: sourceSegmentIds },
              },
              select: {
                id: true,
                segmentIndex: true,
                text: true,
                reviewerAttestedAt: true,
              },
              orderBy: { segmentIndex: "asc" },
            })
          : Promise.resolve([]),
        prisma.trainingQuestionAiValidation.findFirst({
          where: { draftId: d.id, clubId },
          orderBy: { createdAt: "desc" },
          select: { verdict: true, errorsJson: true },
        }),
      ]);
      let latestValidationErrors: { code: string; message: string }[] = [];
      try {
        const parsed = JSON.parse(latestValidation?.errorsJson ?? "[]");
        if (Array.isArray(parsed)) {
          latestValidationErrors = parsed
            .filter((e) => typeof e?.code === "string")
            .map((e) => ({
              code: String(e.code),
              message: typeof e.message === "string" ? e.message : "",
            }));
        }
      } catch {}
      return {
        draft: d,
        body,
        sourceSegmentIds,
        citedSegmentRows: citedSegmentRows.map((s) => ({
          id: s.id,
          segmentIndex: s.segmentIndex,
          text: s.text.slice(0, 200),
          reviewerAttestedAt: s.reviewerAttestedAt?.toISOString() ?? null,
        })),
        latestVerdict: latestValidation?.verdict ?? null,
        latestValidationErrors,
      };
    }),
  );

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
          value={latestBuild ? `READY · ${segmentCount} segments` : "Not yet transcribed"}
          tone={latestBuild ? "emerald" : "stone"}
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
          sub={promotedCount > 0 ? `${promotedCount} promoted into the course` : "No draft promoted yet"}
        />
      </div>

      {!canReview && (
        <p className="text-xs text-stone-500">
          You have read-only access to the AI-review queue; approvals require the
          <code className="mx-1 rounded bg-stone-100 px-1">hr:training:ai:approve</code>
          permission (Spectre training reviewer role).
        </p>
      )}

      {/* EP-TRAIN-4Y-Q §3+§4 — inline action rows per draft */}
      {actionable.length > 0 && (
        <div className="space-y-2" data-testid="training-editor-ai-inline-rows">
          <p className="text-[11px] uppercase tracking-widest text-stone-500">
            Review actions · attest → revalidate → approve → promote
          </p>
          {actionableData.map(({ draft, body, sourceSegmentIds, citedSegmentRows, latestVerdict, latestValidationErrors }) => (
            <AiDraftInlineActions
              key={draft.id}
              draftId={draft.id}
              contentHash={draft.contentHash}
              state={draft.state}
              questionText={extractFirstSentence(body?.questionText) || "(no question text)"}
              options={Array.isArray(body?.options) ? body.options.slice(0, 4) : []}
              explanation={typeof body?.explanation === "string" ? body.explanation : ""}
              sourceSegmentIds={sourceSegmentIds}
              citedSegmentRows={citedSegmentRows}
              latestVerdict={latestVerdict}
              latestValidationErrors={latestValidationErrors}
              checkpointOptions={checkpointOptions}
              reviewUrl={`/app/admin/ai-training/review/persisted?candidate=${draft.id}`}
            />
          ))}
          {actionable.length < byState.REQUIRES_HUMAN_REVIEW.length + byState.APPROVED_DRAFT.length + byState.REJECTED.length && (
            <p className="text-[11px] text-stone-500">
              Showing first {actionable.length}. Total pending {byState.REQUIRES_HUMAN_REVIEW.length} ·
              approved {byState.APPROVED_DRAFT.length} · rejected {byState.REJECTED.length}.
              <Link
                href="/app/admin/ai-training/review/persisted"
                className="ml-2 underline underline-offset-4"
              >
                Full queue
              </Link>
            </p>
          )}
        </div>
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

function tryParseBody(j: string): any | null {
  try {
    return JSON.parse(j);
  } catch {
    return null;
  }
}

function extractFirstSentence(s: string | undefined | null): string {
  if (!s || typeof s !== "string") return "";
  const idx = s.search(/[.?!]\s/);
  const head = idx > 0 ? s.slice(0, idx + 1) : s;
  return head.replace(/\s+/g, " ").trim().slice(0, 200);
}

function formatSec(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
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
