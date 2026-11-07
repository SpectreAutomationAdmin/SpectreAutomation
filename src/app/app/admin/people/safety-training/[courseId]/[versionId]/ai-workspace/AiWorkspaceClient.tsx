"use client";

// EP-TRAIN-6D-4Y (2026-11-06) — AI workspace client shell.
//
// Owns the stepper + per-stage panels + live polling of the three
// new status endpoints. All stage state is read from authoritative
// endpoints; nothing is fabricated.
//
// Polling cadence:
//   - 5 s while a stage is RUNNING / REQUESTED / QUEUED
//   - stops immediately on a terminal state
//
// Composition pattern: each panel is a pure function of its props
// + the latest poll payload. No cross-stage state.

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type { CandidateQueueRow } from "@/lib/hr/training/ai-review/read-service";

type VersionState = "DRAFT" | "PUBLISHED" | "RETIRED";

interface VersionProps {
  readonly state: VersionState;
  readonly title: string;
  readonly videoSha256: string | null;
  readonly videoStorageKey: string | null;
  readonly videoDurationSec: number | null;
  readonly videoSizeBytes: number | null;
}

interface CheckpointOption {
  readonly id: string;
  readonly label: string;
  readonly atSecond: number;
}

interface PlanPreview {
  readonly kind: "topic-aware" | "baseline" | "none";
  readonly learningObjectiveCount: number;
  readonly checkpointCount: number;
  readonly finalAssessmentCount: number;
  readonly boundaries: Array<{ atSec: number; rationale: string }>;
}

interface ApprovedDraftRow {
  readonly id: string;
  readonly contentHash: string;
  readonly validationId: string | null;
  readonly verdict: string | null;
  readonly alreadyPromoted: boolean;
  readonly promotionDestinationKind: string | null;
}

interface AiWorkspaceClientProps {
  readonly courseId: string;
  readonly versionId: string;
  readonly clubWordmark: string;
  readonly version: VersionProps;
  readonly checkpoints: readonly CheckpointOption[];
  readonly latestBuildPresent: boolean;
  readonly latestBuildProducedAt: Date | null;
  readonly planPreview: PlanPreview;
  readonly candidates: readonly CandidateQueueRow[];
  readonly approvedDrafts: readonly ApprovedDraftRow[];
  readonly permissions: {
    readonly canAuthor: boolean;
    readonly canReview: boolean;
    readonly canPublish: boolean;
  };
}

type TranscriptionStatus =
  | { state: "NOT_STARTED"; reason?: string }
  | {
      state:
        | "REQUESTED"
        | "QUEUED"
        | "RUNNING"
        | "FAILED"
        | "CANCELLED"
        | "WAITING_ON_INGEST";
      jobId?: string;
      attempts?: number;
      maxAttempts?: number;
      failureCode?: string | null;
      failureMessage?: string | null;
      completedAt?: string | null;
      reason?: string;
    }
  | {
      state: "COMPLETED";
      jobId: string;
      completedAt: string;
      elapsedMsTotal: number | null;
      transcript: {
        buildId: string;
        resolvedTranscriptBuildId: string;
        producedAt: string;
        transcriberName: string;
        transcriberModelName: string;
        segmentCount: number;
      };
    };

type GenerationStatus =
  | { state: "NOT_STARTED" }
  | {
      state:
        | "REQUESTED"
        | "QUEUED"
        | "RUNNING"
        | "COMPLETED"
        | "FAILED"
        | "CANCELLED";
      runId: string;
      requestedAt: string;
      queuedAt: string | null;
      startedAt: string | null;
      completedAt: string | null;
      attempts: number;
      maxAttempts: number;
      leaseExpiresAt: string | null;
      executionErrorCode: string | null;
      executionErrorMessage: string | null;
      planIdentity: string | null;
      resolvedTranscriptBuildId: string;
      model: { name: string; backend: string };
      draftCount: number;
      draftBreakdown: Record<string, number>;
      shortfall: unknown;
    };

const STAGE_LABELS: readonly { key: string; label: string }[] = [
  { key: "video", label: "Video" },
  { key: "transcription", label: "Transcription" },
  { key: "plan", label: "Assessment plan" },
  { key: "generate", label: "Generate" },
  { key: "review", label: "Review" },
  { key: "assemble", label: "Course assembly" },
  { key: "preview", label: "Preview" },
  { key: "publish", label: "Publish" },
] as const;

export default function AiWorkspaceClient(
  props: AiWorkspaceClientProps,
): JSX.Element {
  const [transcription, setTranscription] =
    useState<TranscriptionStatus | null>(null);
  const [generation, setGeneration] = useState<GenerationStatus | null>(null);
  const [activeStage, setActiveStage] = useState<string>("video");
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);

  const refreshTranscription = useCallback(async () => {
    const res = await fetch(
      `/api/admin/training/versions/${props.versionId}/transcription-status`,
      { cache: "no-store" },
    );
    if (!res.ok) return;
    const data: TranscriptionStatus = await res.json();
    setTranscription(data);
  }, [props.versionId]);

  const refreshGeneration = useCallback(async () => {
    const res = await fetch(
      `/api/admin/training/versions/${props.versionId}/generation-status`,
      { cache: "no-store" },
    );
    if (!res.ok) return;
    const data: GenerationStatus = await res.json();
    setGeneration(data);
  }, [props.versionId]);

  useEffect(() => {
    void refreshTranscription();
    void refreshGeneration();
  }, [refreshTranscription, refreshGeneration]);

  // Poll non-terminal states every 5 s.
  useEffect(() => {
    const nonTerminalTranscription = new Set([
      "REQUESTED",
      "QUEUED",
      "RUNNING",
      "WAITING_ON_INGEST",
    ]);
    const nonTerminalGeneration = new Set(["REQUESTED", "QUEUED", "RUNNING"]);
    const shouldPoll =
      (transcription && nonTerminalTranscription.has(transcription.state)) ||
      (generation && nonTerminalGeneration.has(generation.state));
    if (!shouldPoll) return;
    const t = setInterval(() => {
      void refreshTranscription();
      void refreshGeneration();
    }, 5000);
    return () => clearInterval(t);
  }, [transcription, generation, refreshTranscription, refreshGeneration]);

  const startTranscription = async () => {
    setActionBusy("transcribe");
    setLastError(null);
    try {
      const res = await fetch(
        `/api/admin/training/versions/${props.versionId}/transcribe`,
        { method: "POST" },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setLastError(
          (body && (body.message || body.error)) ||
            `Transcription refused (${res.status})`,
        );
      }
      await refreshTranscription();
    } finally {
      setActionBusy(null);
    }
  };

  const startGeneration = async () => {
    setActionBusy("generate");
    setLastError(null);
    try {
      const res = await fetch(
        `/api/admin/training/versions/${props.versionId}/generate`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ targetTotalQuestions: 6 }),
        },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setLastError(
          (body && (body.message || body.error)) ||
            `Generation refused (${res.status})`,
        );
      }
      await refreshGeneration();
    } finally {
      setActionBusy(null);
    }
  };

  const videoReady = Boolean(
    props.version.videoSha256 &&
      props.version.videoStorageKey &&
      props.version.videoDurationSec,
  );
  const transcriptCompleted = transcription?.state === "COMPLETED";
  const planReady =
    transcriptCompleted && props.planPreview.kind !== "none";
  const generationTerminal =
    generation?.state === "COMPLETED" ||
    generation?.state === "FAILED" ||
    generation?.state === "CANCELLED";

  const approvedCount = props.candidates.filter(
    (c) => c.state === "APPROVED_DRAFT",
  ).length;

  const stageStates = useMemo(() => {
    return {
      video: videoReady ? "READY" : "MISSING",
      transcription: transcription?.state ?? "UNKNOWN",
      plan: planReady ? "READY" : "BLOCKED",
      generate: generation?.state ?? "UNKNOWN",
      review: props.candidates.length > 0 ? "READY" : "EMPTY",
      assemble: approvedCount > 0 ? "READY" : "BLOCKED",
      preview: generationTerminal ? "AVAILABLE" : "BLOCKED",
      publish: props.version.state,
    } as const;
  }, [
    videoReady,
    transcription,
    planReady,
    generation,
    props.candidates.length,
    approvedCount,
    generationTerminal,
    props.version.state,
  ]);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[220px_1fr] gap-6">
      <nav
        aria-label="Workspace stages"
        className="card card-body space-y-1 h-max sticky top-4"
        data-testid="ai-workspace-stepper"
      >
        {STAGE_LABELS.map((s, idx) => {
          const state = (stageStates as Record<string, string>)[s.key];
          const tone = stageToneFor(s.key, state);
          const isActive = activeStage === s.key;
          return (
            <button
              key={s.key}
              type="button"
              onClick={() => setActiveStage(s.key)}
              data-testid={`ai-workspace-stage-${s.key}`}
              data-state={state}
              className={
                "w-full text-left rounded px-3 py-2 text-sm transition " +
                (isActive
                  ? "bg-stone-100 text-club-ink"
                  : "text-stone-700 hover:bg-stone-50")
              }
            >
              <div className="flex items-center justify-between gap-2">
                <span>
                  <span className="text-xs text-stone-400 font-mono mr-2">
                    {String(idx + 1).padStart(2, "0")}
                  </span>
                  {s.label}
                </span>
                <span
                  className={
                    "inline-block rounded border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide " +
                    tone
                  }
                >
                  {humaniseState(state)}
                </span>
              </div>
            </button>
          );
        })}
      </nav>

      <div className="space-y-6">
        {lastError && (
          <div
            role="alert"
            className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
            data-testid="ai-workspace-error"
          >
            {lastError}
          </div>
        )}

        {activeStage === "video" && (
          <VideoPanel version={props.version} courseId={props.courseId} versionId={props.versionId} />
        )}

        {activeStage === "transcription" && (
          <TranscriptionPanel
            status={transcription}
            videoReady={videoReady}
            canAuthor={props.permissions.canAuthor}
            busy={actionBusy === "transcribe"}
            onStart={startTranscription}
            onRefresh={refreshTranscription}
            latestBuildPresent={props.latestBuildPresent}
            latestBuildProducedAt={props.latestBuildProducedAt}
          />
        )}

        {activeStage === "plan" && (
          <PlanPanel preview={props.planPreview} transcriptReady={transcriptCompleted} />
        )}

        {activeStage === "generate" && (
          <GeneratePanel
            status={generation}
            planReady={planReady}
            canAuthor={props.permissions.canAuthor}
            busy={actionBusy === "generate"}
            onStart={startGeneration}
            onRefresh={refreshGeneration}
          />
        )}

        {activeStage === "review" && (
          <ReviewPanel
            candidates={props.candidates}
            canReview={props.permissions.canReview}
          />
        )}

        {activeStage === "assemble" && (
          <AssemblyPanel
            candidates={props.candidates}
            approvedDrafts={props.approvedDrafts}
            checkpoints={props.checkpoints}
            canAuthor={props.permissions.canAuthor}
            versionState={props.version.state}
          />
        )}

        {activeStage === "preview" && (
          <PreviewPanel
            courseId={props.courseId}
            versionId={props.versionId}
            generationTerminal={generationTerminal}
          />
        )}

        {activeStage === "publish" && (
          <PublishPanel
            courseId={props.courseId}
            versionId={props.versionId}
            canPublish={props.permissions.canPublish}
            versionState={props.version.state}
          />
        )}
      </div>
    </div>
  );
}

function stageToneFor(stage: string, state: string): string {
  if (stage === "publish") {
    if (state === "PUBLISHED")
      return "bg-emerald-50 text-emerald-800 border-emerald-200";
    if (state === "RETIRED")
      return "bg-stone-100 text-stone-600 border-stone-200";
    return "bg-amber-50 text-amber-800 border-amber-200";
  }
  if (
    state === "COMPLETED" ||
    state === "READY" ||
    state === "AVAILABLE"
  )
    return "bg-emerald-50 text-emerald-800 border-emerald-200";
  if (state === "FAILED")
    return "bg-red-50 text-red-700 border-red-200";
  if (state === "CANCELLED")
    return "bg-stone-100 text-stone-600 border-stone-200";
  if (
    state === "REQUESTED" ||
    state === "QUEUED" ||
    state === "RUNNING" ||
    state === "WAITING_ON_INGEST"
  )
    return "bg-amber-50 text-amber-800 border-amber-200";
  return "bg-stone-50 text-stone-500 border-stone-200";
}

function humaniseState(state: string): string {
  if (state === "WAITING_ON_INGEST") return "ingesting";
  if (state === "NOT_STARTED") return "idle";
  if (state === "UNKNOWN") return "…";
  return state.replace(/_/g, " ").toLowerCase();
}

// ─── VIDEO PANEL ─────────────────────────────────────────────────────

function VideoPanel({
  version,
  courseId,
  versionId,
}: {
  version: VersionProps;
  courseId: string;
  versionId: string;
}) {
  if (!version.videoStorageKey || !version.videoSha256) {
    return (
      <section className="card card-body" data-testid="ai-workspace-video-panel">
        <h2 className="section-title text-lg">Video</h2>
        <p className="mt-2 text-sm text-stone-600">
          No source video is uploaded yet. The AI workspace requires an
          uploaded video with a recorded SHA-256 and duration before
          transcription can start.
        </p>
        <Link
          href={`/app/admin/people/safety-training/${courseId}/${versionId}`}
          className="btn btn-primary mt-4 inline-block"
        >
          Upload video in editor
        </Link>
      </section>
    );
  }
  return (
    <section className="card card-body" data-testid="ai-workspace-video-panel">
      <h2 className="section-title text-lg">Video</h2>
      <dl className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2 text-sm">
        <div>
          <dt className="text-stone-500">Source SHA-256</dt>
          <dd className="font-mono text-stone-800">
            {version.videoSha256?.slice(0, 12)}…
          </dd>
        </div>
        <div>
          <dt className="text-stone-500">Duration</dt>
          <dd className="text-stone-800">
            {version.videoDurationSec
              ? `${(version.videoDurationSec / 60).toFixed(1)} min`
              : "—"}
          </dd>
        </div>
        <div>
          <dt className="text-stone-500">Size</dt>
          <dd className="text-stone-800">
            {version.videoSizeBytes
              ? `${(version.videoSizeBytes / 1_048_576).toFixed(1)} MB`
              : "—"}
          </dd>
        </div>
        <div>
          <dt className="text-stone-500">Storage key</dt>
          <dd className="font-mono text-stone-800 truncate">
            {version.videoStorageKey}
          </dd>
        </div>
      </dl>
      <Link
        href={`/app/admin/people/safety-training/${courseId}/${versionId}`}
        className="btn btn-secondary btn-sm mt-4 inline-block"
      >
        Re-upload in editor
      </Link>
    </section>
  );
}

// ─── TRANSCRIPTION PANEL ─────────────────────────────────────────────

function TranscriptionPanel({
  status,
  videoReady,
  canAuthor,
  busy,
  onStart,
  onRefresh,
  latestBuildPresent,
  latestBuildProducedAt,
}: {
  status: TranscriptionStatus | null;
  videoReady: boolean;
  canAuthor: boolean;
  busy: boolean;
  onStart: () => void;
  onRefresh: () => void;
  latestBuildPresent: boolean;
  latestBuildProducedAt: Date | null;
}) {
  if (!status) {
    return (
      <section className="card card-body" data-testid="ai-workspace-transcription-panel">
        <h2 className="section-title text-lg">Transcription</h2>
        <p className="mt-2 text-sm text-stone-500">Loading current status…</p>
      </section>
    );
  }
  const state = status.state;
  return (
    <section className="card card-body" data-testid="ai-workspace-transcription-panel" data-state={state}>
      <div className="flex items-start justify-between gap-4">
        <h2 className="section-title text-lg">Transcription</h2>
        <button
          type="button"
          onClick={onRefresh}
          className="text-xs text-stone-500 hover:text-club-ink"
          data-testid="ai-workspace-transcription-refresh"
        >
          Refresh
        </button>
      </div>

      {state === "NOT_STARTED" && (
        <div className="mt-3">
          <p className="text-sm text-stone-600">
            {status.reason === "video_missing"
              ? "Upload a video before starting transcription."
              : latestBuildPresent
                ? "A completed transcript exists from an earlier job. Starting a new transcription is only required if the video has changed."
                : "No transcription has been requested for this video yet."}
          </p>
          {canAuthor && videoReady && (
            <button
              type="button"
              onClick={onStart}
              disabled={busy}
              className="btn btn-primary btn-sm mt-3"
              data-testid="ai-workspace-transcription-start"
            >
              {busy ? "Requesting…" : latestBuildPresent ? "Request again" : "Request transcription"}
            </button>
          )}
        </div>
      )}

      {(state === "REQUESTED" || state === "QUEUED" || state === "RUNNING") && (
        <div className="mt-3">
          <p className="text-sm text-stone-700">
            Transcription is <strong>{state.toLowerCase()}</strong>.
          </p>
          <p className="mt-1 text-xs text-stone-500">
            Attempt {status.attempts ?? 0} of {status.maxAttempts ?? 2}. Live
            status refreshes every five seconds.
          </p>
        </div>
      )}

      {state === "WAITING_ON_INGEST" && (
        <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          Modal reported completion but the transcript build has not been
          persisted yet. The workspace will not promote this to a
          completed state until ingestion has written the build row.
        </div>
      )}

      {state === "COMPLETED" && (
        <div className="mt-3 space-y-2">
          <p className="text-sm text-emerald-800 font-medium">
            Transcript ready.
          </p>
          <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1 text-sm">
            <div>
              <dt className="text-stone-500">Segments</dt>
              <dd>{status.transcript.segmentCount}</dd>
            </div>
            <div>
              <dt className="text-stone-500">Model</dt>
              <dd>{status.transcript.transcriberModelName}</dd>
            </div>
            <div className="sm:col-span-2">
              <dt className="text-stone-500">Build ID</dt>
              <dd className="font-mono truncate">
                {status.transcript.resolvedTranscriptBuildId.slice(0, 16)}…
              </dd>
            </div>
          </dl>
        </div>
      )}

      {state === "FAILED" && (
        <div className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          <strong>{status.failureCode ?? "FAILURE"}</strong>
          {status.failureMessage ? ` — ${status.failureMessage}` : ""}
          {canAuthor && (status.attempts ?? 0) < (status.maxAttempts ?? 2) && (
            <button
              type="button"
              onClick={onStart}
              disabled={busy}
              className="btn btn-secondary btn-sm mt-3 block"
              data-testid="ai-workspace-transcription-retry"
            >
              {busy ? "Retrying…" : "Retry transcription"}
            </button>
          )}
        </div>
      )}

      {state === "CANCELLED" && (
        <div className="mt-3 rounded-md border border-stone-200 bg-stone-50 px-3 py-2 text-sm text-stone-700">
          Transcription was cancelled.
        </div>
      )}
      {latestBuildProducedAt && (
        <p className="mt-3 text-xs text-stone-500">
          Latest transcript produced:{" "}
          {new Date(latestBuildProducedAt).toLocaleString()}
        </p>
      )}
    </section>
  );
}

// ─── PLAN PANEL ──────────────────────────────────────────────────────

function PlanPanel({
  preview,
  transcriptReady,
}: {
  preview: PlanPreview;
  transcriptReady: boolean;
}) {
  return (
    <section className="card card-body" data-testid="ai-workspace-plan-panel">
      <h2 className="section-title text-lg">Assessment plan preview</h2>
      {!transcriptReady && (
        <p className="mt-2 text-sm text-stone-500">
          Transcription must complete before a plan can be previewed.
        </p>
      )}
      {transcriptReady && preview.kind === "none" && (
        <p className="mt-2 text-sm text-stone-500">
          No plan could be built from the current transcript.
        </p>
      )}
      {transcriptReady && preview.kind !== "none" && (
        <div className="mt-3 space-y-3">
          <p className="text-sm text-stone-700">
            Using the{" "}
            <strong>
              {preview.kind === "topic-aware" ? "topic-aware" : "baseline"}
            </strong>{" "}
            plan builder.
          </p>
          <dl className="grid grid-cols-1 sm:grid-cols-3 gap-x-6 gap-y-2 text-sm">
            <div>
              <dt className="text-stone-500">Learning objectives</dt>
              <dd className="text-stone-800">{preview.learningObjectiveCount}</dd>
            </div>
            <div>
              <dt className="text-stone-500">Checkpoint groups</dt>
              <dd className="text-stone-800">{preview.checkpointCount}</dd>
            </div>
            <div>
              <dt className="text-stone-500">Final-assessment target</dt>
              <dd className="text-stone-800">{preview.finalAssessmentCount}</dd>
            </div>
          </dl>
          {preview.boundaries.length > 0 && (
            <div>
              <h3 className="text-sm font-medium text-stone-700 mt-3">
                Proposed checkpoint boundaries
              </h3>
              <ul className="mt-1 space-y-0.5 text-sm text-stone-600">
                {preview.boundaries.map((b, i) => (
                  <li key={`${i}-${b.atSec}`}>
                    <span className="font-mono text-stone-500 mr-2">
                      {b.atSec.toFixed(1)}s
                    </span>
                    {b.rationale}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

// ─── GENERATE PANEL ──────────────────────────────────────────────────

function GeneratePanel({
  status,
  planReady,
  canAuthor,
  busy,
  onStart,
  onRefresh,
}: {
  status: GenerationStatus | null;
  planReady: boolean;
  canAuthor: boolean;
  busy: boolean;
  onStart: () => void;
  onRefresh: () => void;
}) {
  if (!status) {
    return (
      <section className="card card-body" data-testid="ai-workspace-generate-panel">
        <h2 className="section-title text-lg">Generate</h2>
        <p className="mt-2 text-sm text-stone-500">Loading current status…</p>
      </section>
    );
  }
  const state = status.state;
  return (
    <section className="card card-body" data-testid="ai-workspace-generate-panel" data-state={state}>
      <div className="flex items-start justify-between gap-4">
        <h2 className="section-title text-lg">Generate</h2>
        <button
          type="button"
          onClick={onRefresh}
          className="text-xs text-stone-500 hover:text-club-ink"
          data-testid="ai-workspace-generate-refresh"
        >
          Refresh
        </button>
      </div>

      {state === "NOT_STARTED" && (
        <div className="mt-3">
          <p className="text-sm text-stone-600">
            No generation run has been requested yet.
          </p>
          {canAuthor && planReady && (
            <button
              type="button"
              onClick={onStart}
              disabled={busy}
              className="btn btn-primary btn-sm mt-3"
              data-testid="ai-workspace-generate-start"
            >
              {busy ? "Requesting…" : "Start generation"}
            </button>
          )}
          {!planReady && (
            <p className="mt-2 text-xs text-stone-500">
              Plan preview must be ready before generation can start.
            </p>
          )}
        </div>
      )}

      {state !== "NOT_STARTED" && (
        <div className="mt-3 space-y-2">
          <p className="text-sm text-stone-700">
            Status: <strong>{state.toLowerCase()}</strong>
          </p>
          <dl className="grid grid-cols-1 sm:grid-cols-3 gap-x-6 gap-y-1 text-sm">
            <div>
              <dt className="text-stone-500">Attempts</dt>
              <dd>
                {status.attempts}/{status.maxAttempts}
              </dd>
            </div>
            <div>
              <dt className="text-stone-500">Model</dt>
              <dd className="truncate">{status.model.name}</dd>
            </div>
            <div>
              <dt className="text-stone-500">Draft count</dt>
              <dd>{status.draftCount}</dd>
            </div>
          </dl>

          {(state === "COMPLETED" || status.draftCount > 0) && (
            <div className="mt-3">
              <h3 className="text-sm font-medium text-stone-700">
                Candidates by lifecycle state
              </h3>
              <ul
                className="mt-1 grid grid-cols-2 sm:grid-cols-3 gap-1 text-sm"
                data-testid="ai-workspace-generate-breakdown"
              >
                {Object.entries(status.draftBreakdown).map(([k, v]) => (
                  <li
                    key={k}
                    className="flex items-center justify-between rounded border border-stone-200 px-2 py-1"
                  >
                    <span className="text-stone-500 text-xs">
                      {k.replace(/_/g, " ").toLowerCase()}
                    </span>
                    <span className="font-mono text-stone-800">{v}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {state === "FAILED" && status.executionErrorCode && (
            <div className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              <strong>{status.executionErrorCode}</strong>
              {status.executionErrorMessage
                ? ` — ${status.executionErrorMessage}`
                : ""}
            </div>
          )}
          {Boolean(status.shortfall) && (
            <details className="mt-3">
              <summary className="text-xs text-stone-500 cursor-pointer">
                Shortfall / dedup log
              </summary>
              <pre
                className="mt-2 rounded bg-stone-50 border border-stone-200 p-2 text-xs text-stone-700 overflow-x-auto"
                data-testid="ai-workspace-generate-shortfall"
              >
                {JSON.stringify(status.shortfall, null, 2)}
              </pre>
            </details>
          )}
        </div>
      )}
    </section>
  );
}

// ─── REVIEW PANEL ────────────────────────────────────────────────────

function dedupVerdictForRow(_c: CandidateQueueRow): string | null {
  // The 4X verdict lives in the shortfall log on the generation run,
  // not on each draft row (per the 4Y design the workspace surfaces
  // the per-row verdict from the Stage 4 payload). The REVIEW panel
  // displays the lifecycle state and defers detailed verdicts to the
  // persisted review surface.
  return null;
}

function ReviewPanel({
  candidates,
  canReview,
}: {
  candidates: readonly CandidateQueueRow[];
  canReview: boolean;
}) {
  if (!canReview) {
    return (
      <section className="card card-body" data-testid="ai-workspace-review-panel">
        <h2 className="section-title text-lg">Review</h2>
        <p className="mt-2 text-sm text-stone-500">
          You do not have permission to review candidates.
        </p>
      </section>
    );
  }
  return (
    <section className="card card-body" data-testid="ai-workspace-review-panel">
      <h2 className="section-title text-lg">Review</h2>
      {candidates.length === 0 && (
        <p className="mt-2 text-sm text-stone-500">
          No candidates have been generated for this version yet.
        </p>
      )}
      {candidates.length > 0 && (
        <table className="table-base mt-3">
          <thead>
            <tr>
              <th>Topic</th>
              <th>State</th>
              <th>Validation</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {candidates.map((c) => {
              dedupVerdictForRow(c); // keep fn referenced for future row verdict display
              return (
                <tr key={c.draftId} data-testid={`ai-workspace-review-row-${c.draftId}`}>
                  <td className="truncate max-w-[26rem]">{c.topic}</td>
                  <td>
                    <span className="inline-block rounded border border-stone-200 bg-stone-50 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide">
                      {c.state.replace(/_/g, " ").toLowerCase()}
                    </span>
                  </td>
                  <td className="text-xs text-stone-600">
                    {c.latestVerdict ?? "—"}
                    {c.latestHardErrorCount > 0
                      ? ` · ${c.latestHardErrorCount} err`
                      : ""}
                  </td>
                  <td>
                    <Link
                      href={`/app/admin/ai-training/review/persisted?candidate=${c.draftId}`}
                      className="btn btn-secondary btn-sm"
                    >
                      Open review
                    </Link>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}

// ─── COURSE ASSEMBLY PANEL ───────────────────────────────────────────

function AssemblyPanel({
  candidates,
  approvedDrafts,
  checkpoints,
  canAuthor,
  versionState,
}: {
  candidates: readonly CandidateQueueRow[];
  approvedDrafts: readonly ApprovedDraftRow[];
  checkpoints: readonly CheckpointOption[];
  canAuthor: boolean;
  versionState: VersionState;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [rowError, setRowError] = useState<Record<string, string>>({});
  const [rowSuccess, setRowSuccess] = useState<Record<string, string>>({});

  const approvedById = useMemo(() => {
    const m = new Map<string, ApprovedDraftRow>();
    for (const d of approvedDrafts) m.set(d.id, d);
    return m;
  }, [approvedDrafts]);

  const promote = async (
    draftId: string,
    expectedDraftContentHash: string,
    expectedValidationId: string,
    destination:
      | { kind: "CHECKPOINT"; checkpointId: string }
      | { kind: "FINAL_ASSESSMENT" },
  ) => {
    setBusy(draftId);
    setRowError((e) => ({ ...e, [draftId]: "" }));
    setRowSuccess((s) => ({ ...s, [draftId]: "" }));
    try {
      const res = await fetch(
        `/api/admin/ai-training/drafts/${draftId}/promote`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            destination,
            expectedDraftContentHash,
            expectedValidationId,
          }),
        },
      );
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setRowError((e) => ({
          ...e,
          [draftId]:
            (body && (body.message || body.rejectionCode || body.error)) ||
            `Promotion refused (${res.status})`,
        }));
      } else {
        setRowSuccess((s) => ({
          ...s,
          [draftId]: body.replay
            ? `Already promoted (replay). ${body.destinationKind}`
            : `Promoted. ${body.destinationKind}`,
        }));
      }
    } finally {
      setBusy(null);
    }
  };

  if (versionState !== "DRAFT") {
    return (
      <section className="card card-body" data-testid="ai-workspace-assemble-panel">
        <h2 className="section-title text-lg">Course assembly</h2>
        <p className="mt-2 text-sm text-stone-600">
          This version is <strong>{versionState.toLowerCase()}</strong>.
          Promotion is only available on DRAFT versions.
        </p>
      </section>
    );
  }

  const approvedCandidates = candidates.filter(
    (c) => c.state === "APPROVED_DRAFT",
  );

  return (
    <section className="card card-body" data-testid="ai-workspace-assemble-panel">
      <h2 className="section-title text-lg">Course assembly</h2>
      <p className="mt-1 text-sm text-stone-600">
        Promote approved drafts into publishable questions. The server
        re-verifies evidence, verified answer, and content hash on every
        call. Historical, unapproved, or evidence-integrity-failed
        drafts cannot be promoted.
      </p>
      {approvedCandidates.length === 0 && (
        <p className="mt-3 text-sm text-stone-500">
          No APPROVED_DRAFT candidates for this version yet.
        </p>
      )}
      <ul className="mt-3 space-y-3">
        {approvedCandidates.map((c) => {
          const approved = approvedById.get(c.draftId);
          const disabled =
            !canAuthor ||
            !approved?.validationId ||
            approved.alreadyPromoted ||
            busy === c.draftId;
          return (
            <li
              key={c.draftId}
              className="rounded border border-stone-200 p-3"
              data-testid={`ai-workspace-assemble-row-${c.draftId}`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm text-stone-800 truncate">{c.topic}</p>
                  <p className="mt-1 text-xs text-stone-500">
                    hash {c.contentHash.slice(0, 10)}…
                  </p>
                </div>
                <PromoteControls
                  disabled={disabled}
                  checkpoints={checkpoints}
                  alreadyPromoted={approved?.alreadyPromoted ?? false}
                  promotedDestination={approved?.promotionDestinationKind ?? null}
                  onPromote={(destination) => {
                    if (!approved?.validationId) return;
                    void promote(
                      c.draftId,
                      c.contentHash,
                      approved.validationId,
                      destination,
                    );
                  }}
                  busy={busy === c.draftId}
                />
              </div>
              {rowError[c.draftId] && (
                <p
                  className="mt-2 text-xs text-red-700"
                  data-testid={`ai-workspace-assemble-error-${c.draftId}`}
                >
                  {rowError[c.draftId]}
                </p>
              )}
              {rowSuccess[c.draftId] && (
                <p
                  className="mt-2 text-xs text-emerald-700"
                  data-testid={`ai-workspace-assemble-success-${c.draftId}`}
                >
                  {rowSuccess[c.draftId]}
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function PromoteControls({
  disabled,
  checkpoints,
  alreadyPromoted,
  promotedDestination,
  onPromote,
  busy,
}: {
  disabled: boolean;
  checkpoints: readonly CheckpointOption[];
  alreadyPromoted: boolean;
  promotedDestination: string | null;
  onPromote: (
    d:
      | { kind: "CHECKPOINT"; checkpointId: string }
      | { kind: "FINAL_ASSESSMENT" },
  ) => void;
  busy: boolean;
}) {
  const [checkpointId, setCheckpointId] = useState<string>(
    checkpoints[0]?.id ?? "",
  );

  if (alreadyPromoted) {
    return (
      <span className="text-xs text-stone-500">
        Already promoted · {promotedDestination?.toLowerCase().replace(/_/g, " ")}
      </span>
    );
  }
  return (
    <div className="flex items-center gap-2">
      {checkpoints.length > 0 && (
        <>
          <select
            className="input !py-1 !text-xs"
            value={checkpointId}
            onChange={(e) => setCheckpointId(e.target.value)}
            disabled={disabled}
            data-testid="ai-workspace-assemble-checkpoint-select"
          >
            {checkpoints.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={disabled || !checkpointId}
            data-testid="ai-workspace-assemble-promote-checkpoint"
            onClick={() =>
              onPromote({ kind: "CHECKPOINT", checkpointId })
            }
          >
            {busy ? "…" : "Promote to checkpoint"}
          </button>
        </>
      )}
      <button
        type="button"
        className="btn btn-secondary btn-sm"
        disabled={disabled}
        data-testid="ai-workspace-assemble-promote-final"
        onClick={() => onPromote({ kind: "FINAL_ASSESSMENT" })}
      >
        {busy ? "…" : "Promote to final"}
      </button>
    </div>
  );
}

// ─── PREVIEW PANEL ───────────────────────────────────────────────────

function PreviewPanel({
  courseId,
  versionId,
  generationTerminal,
}: {
  courseId: string;
  versionId: string;
  generationTerminal: boolean;
}) {
  return (
    <section className="card card-body" data-testid="ai-workspace-preview-panel">
      <h2 className="section-title text-lg">Preview</h2>
      <p className="mt-2 text-sm text-stone-600">
        Preview as an employee from the editor to verify checkpoints,
        questions, and video playback work end-to-end before publishing.
      </p>
      {!generationTerminal && (
        <p className="mt-2 text-xs text-stone-500">
          Generation has not yet reached a terminal state. Preview any
          existing content from the editor at your own discretion.
        </p>
      )}
      <Link
        href={`/app/admin/people/safety-training/${courseId}/${versionId}`}
        className="btn btn-primary mt-3 inline-block"
      >
        Open editor to preview
      </Link>
    </section>
  );
}

// ─── PUBLISH PANEL ───────────────────────────────────────────────────

function PublishPanel({
  courseId,
  versionId,
  canPublish,
  versionState,
}: {
  courseId: string;
  versionId: string;
  canPublish: boolean;
  versionState: VersionState;
}) {
  return (
    <section className="card card-body" data-testid="ai-workspace-publish-panel">
      <h2 className="section-title text-lg">Publish</h2>
      {versionState !== "DRAFT" ? (
        <p className="mt-2 text-sm text-stone-600">
          This version is <strong>{versionState.toLowerCase()}</strong>.
        </p>
      ) : (
        <>
          <p className="mt-2 text-sm text-stone-600">
            Publication is performed from the existing editor so the
            same readiness checks, revision dialog, and audit paths
            apply. The workspace does not render a parallel publish
            button.
          </p>
          <Link
            href={`/app/admin/people/safety-training/${courseId}/${versionId}`}
            className={
              "btn btn-primary mt-3 inline-block " +
              (canPublish ? "" : "pointer-events-none opacity-50")
            }
          >
            {canPublish ? "Return to editor to publish" : "Publish permission required"}
          </Link>
        </>
      )}
    </section>
  );
}
