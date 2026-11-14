"use client";

// EP-TRAIN-4Y-AY §5 — Mandatory seven-stage preparation progress bars.
//
// Replaces the prior 4Y-S checklist (status-only) with a per-stage
// progress-bar surface. Every stage renders a visible bar:
//   - COMPLETED  → filled, green, with final percent
//   - RUNNING    → animated indeterminate when no measurable fraction,
//                  determinate bar when numerator/denominator exist
//   - QUEUED     → striped amber bar, "Waiting for worker"
//   - BLOCKED    → red bar with a blocked reason + recovery action
//   - FAILED     → red bar with failure reason + retry action
//   - WAITING    → thin outline bar, "Waiting on upstream"
//
// All data is server-derived from /preparation-status. The component
// never fabricates percents (§4 of the directive).

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

type StageId =
  | "upload"
  | "ingest"
  | "transcribe"
  | "objectives"
  | "checkpoints"
  | "assessment"
  | "ready";

type StageStatus =
  | "WAITING"
  | "QUEUED"
  | "RUNNING"
  | "COMPLETED"
  | "FAILED"
  | "BLOCKED";

interface StageProgressFraction {
  readonly numerator: number;
  readonly denominator: number;
  readonly percent: number;
  readonly unit: string;
}

interface Stage {
  readonly id: StageId;
  readonly label: string;
  readonly status: StageStatus;
  readonly progress: StageProgressFraction | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly lastActivityAt: string | null;
  readonly elapsedMs: number | null;
  readonly failureReason: string | null;
  readonly blockedReason: string | null;
  readonly canRecover: boolean;
  readonly measurementMethod: string;
}

interface PreparationProgress {
  readonly versionId: string;
  readonly overall: {
    readonly currentStageId: StageId;
    readonly currentStageStartedAt: string | null;
    readonly currentStageElapsedMs: number | null;
    readonly lastActivityAt: string | null;
    readonly completedStageCount: number;
    readonly totalStageCount: 7;
    readonly weightedPercent: number;
  };
  readonly stages: readonly Stage[];
}

interface Props {
  readonly versionId: string;
}

type FetchStatus =
  | { kind: "loading" }
  | { kind: "ok"; data: PreparationProgress }
  | { kind: "error"; message: string };

const POLL_MS = 5000;

function formatElapsed(ms: number | null): string {
  if (ms == null) return "";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s - m * 60;
  if (m < 60) return `${m}m ${rs}s`;
  const h = Math.floor(m / 60);
  const rm = m - h * 60;
  return `${h}h ${rm}m`;
}

function formatLastActivity(iso: string | null, now: Date): string {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "";
  const delta = Math.max(0, now.getTime() - then);
  if (delta < 10 * 1000) return "just now";
  if (delta < 60 * 1000) return `${Math.round(delta / 1000)}s ago`;
  return `${Math.round(delta / 60000)}m ago`;
}

export default function CoursePrepProgress({ versionId }: Props) {
  const router = useRouter();
  const [status, setStatus] = useState<FetchStatus>({ kind: "loading" });
  const [starting, setStarting] = useState<boolean>(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [nowTick, setNowTick] = useState<number>(Date.now());

  const refresh = useCallback(async () => {
    try {
      // EP-TRAIN-4Y-BA §3 — The 4Y-AZ orchestration-from-polling
      // approach has been reverted: polling MUST NOT trigger GPU-
      // generating side effects. The 4Y-AZ auto-prepare poll created
      // a runaway loop against the current course (one new FAILED
      // run every 5 seconds because FAILED wasn't in the "already
      // active" filter). The directive is explicit: "A GET request
      // or page render must never initiate new GPU expenditure."
      //
      // Server-side orchestration now lives in the transcription
      // worker's post-success handler (chains straight into
      // generation when an authorization record exists for the
      // version). The page is read-only.
      const resp = await fetch(
        `/api/admin/training/versions/${versionId}/preparation-status`,
        { cache: "no-store" },
      );
      if (!resp.ok) {
        setStatus({
          kind: "error",
          message:
            resp.status === 404
              ? "This course version was not found."
              : "Could not read preparation status.",
        });
        return;
      }
      const data = (await resp.json()) as PreparationProgress;
      setStatus({ kind: "ok", data });
      if (data.overall.currentStageId === "ready") {
        // Final stage done → refresh the server component below so the
        // editor renders.
        router.refresh();
      }
    } catch {
      setStatus({ kind: "error", message: "Network error. Retrying…" });
    }
  }, [versionId, router]);

  useEffect(() => {
    let cancelled = false;
    let t: NodeJS.Timeout | null = null;
    async function loop() {
      if (cancelled) return;
      await refresh();
      if (cancelled) return;
      t = setTimeout(loop, POLL_MS);
    }
    loop();
    return () => {
      cancelled = true;
      if (t) clearTimeout(t);
    };
  }, [refresh]);

  // Local ticker so the "running" elapsed time updates every second
  // between polls, without requiring a re-fetch.
  useEffect(() => {
    const id = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const handleStart = useCallback(async () => {
    setStarting(true);
    setStartError(null);
    try {
      // Explicit recovery: fire auto-prepare once synchronously. The
      // orchestration endpoint handles whichever stage is currently
      // BLOCKED (transcription or generation). Polling loop will pick
      // up the state change on the next tick.
      const resp = await fetch(
        `/api/admin/training/versions/${versionId}/auto-prepare`,
        { method: "POST", cache: "no-store" },
      );
      if (!resp.ok) {
        const body = await resp.json().catch(() => ({}));
        setStartError(
          body?.message ??
            `Could not start preparation (HTTP ${resp.status}).`,
        );
      } else {
        await refresh();
      }
    } catch {
      setStartError("Network error. Please try again.");
    } finally {
      setStarting(false);
    }
  }, [versionId, refresh]);

  if (status.kind === "loading") {
    return (
      <div
        className="card card-body text-sm text-stone-500"
        data-testid="training-prep-progress-loading"
      >
        Reading preparation status…
      </div>
    );
  }
  if (status.kind === "error") {
    return (
      <div
        className="card card-body text-sm text-red-700 border-red-200 bg-red-50"
        data-testid="training-prep-progress-error"
      >
        {status.message}
      </div>
    );
  }

  const { data } = status;
  const now = new Date(nowTick);
  // Work-time weighted overall %. Falls back to stage-count ratio if
  // an older server build didn't populate weightedPercent.
  const overallPct =
    typeof data.overall.weightedPercent === "number"
      ? data.overall.weightedPercent
      : Math.round(
          (data.overall.completedStageCount / data.overall.totalStageCount) * 100,
        );
  // Current-stage elapsed is live-ticked between polls when the stage
  // is RUNNING or QUEUED (the server's elapsedMs is a snapshot).
  const currentStage = data.stages.find(
    (s) => s.id === data.overall.currentStageId,
  );
  const liveElapsedMs =
    currentStage &&
    (currentStage.status === "RUNNING" || currentStage.status === "QUEUED") &&
    currentStage.startedAt
      ? Math.max(0, now.getTime() - new Date(currentStage.startedAt).getTime())
      : data.overall.currentStageElapsedMs;

  return (
    <section
      className="card card-body"
      data-testid="training-prep-progress"
      aria-live="polite"
    >
      <header className="flex items-start justify-between gap-4">
        <div>
          <h2 className="section-title text-lg">Preparing course</h2>
          <p className="mt-1 text-sm text-stone-500">
            Spectre is getting your course ready. You can leave this page and
            come back — progress is saved on the server.
          </p>
        </div>
        <div className="text-right">
          <div
            className="text-xs uppercase tracking-wide text-stone-500"
            data-testid="training-prep-overall-label"
          >
            Overall
          </div>
          <div
            className="text-2xl font-semibold text-club-ink tabular-nums"
            data-testid="training-prep-overall-percent"
          >
            {overallPct}%
          </div>
          <div
            className="text-xs text-stone-500 tabular-nums"
            data-testid="training-prep-overall-stage-count"
          >
            {data.overall.completedStageCount} of {data.overall.totalStageCount} stages
          </div>
          {currentStage && currentStage.status !== "COMPLETED" && (
            <div
              className="mt-1 text-xs text-stone-500 tabular-nums"
              data-testid="training-prep-active-op"
            >
              Active: <span className="font-medium text-stone-700">{currentStage.label}</span>
            </div>
          )}
        </div>
      </header>

      {/* Overall progress bar */}
      <div
        className="mt-4 h-2 w-full overflow-hidden rounded-full bg-stone-200"
        data-testid="training-prep-overall-bar"
      >
        <div
          className="h-full rounded-full bg-club-green transition-all duration-500"
          style={{ width: `${overallPct}%` }}
          data-testid="training-prep-overall-bar-fill"
          data-percent={overallPct}
        />
      </div>

      {/* Per-stage bars */}
      <ol className="mt-5 space-y-4">
        {data.stages.map((s) => (
          <StageRow key={s.id} stage={s} now={now} liveElapsedMs={s.id === data.overall.currentStageId ? liveElapsedMs : s.elapsedMs} />
        ))}
      </ol>

      {/* Controlled-recovery action — rendered whenever the current
          stage is BLOCKED and the server classifies it canRecover.
          Covers the transcribe gap (no transcription job yet) and the
          objectives gap (no generation run yet). The 4Y-AZ auto-prepare
          orchestration normally covers both automatically; this button
          is the explicit fallback. */}
      {currentStage?.status === "BLOCKED" &&
        currentStage.canRecover &&
        (currentStage.id === "transcribe" || currentStage.id === "objectives") && (
        <div
          className="mt-5 flex items-center justify-between gap-3 rounded-md border border-amber-200 bg-amber-50 p-4"
          data-testid="training-prep-recovery"
        >
          <div className="text-sm text-amber-900">
            <strong className="font-semibold">
              {currentStage.id === "transcribe"
                ? "Preparation hasn’t started yet."
                : "Analysis hasn’t started yet."}
            </strong>
            {" "}
            {currentStage.blockedReason ??
              (currentStage.id === "transcribe"
                ? "Click the button to begin transcription."
                : "Click the button to begin learning-objective analysis.")}
          </div>
          <button
            type="button"
            className="btn-primary btn-sm"
            onClick={handleStart}
            disabled={starting}
            data-testid="training-prep-start-button"
          >
            {starting ? "Starting…" : "Continue preparation"}
          </button>
        </div>
      )}
      {startError && (
        <p
          className="mt-2 text-sm text-red-700"
          role="alert"
          data-testid="training-prep-start-error"
        >
          {startError}
        </p>
      )}
    </section>
  );
}

function StageRow({
  stage,
  now,
  liveElapsedMs,
}: {
  readonly stage: Stage;
  readonly now: Date;
  readonly liveElapsedMs: number | null;
}) {
  const statusLabel = STATUS_LABEL[stage.status];
  const barFillPct = stage.progress?.percent ?? (stage.status === "COMPLETED" ? 100 : 0);
  const barClass = BAR_CLASSES[stage.status];
  const isIndeterminate =
    stage.status === "RUNNING" && !stage.progress;
  return (
    <li
      className="text-sm"
      data-testid={`training-prep-stage-${stage.id}`}
      data-state={stage.status}
    >
      <div className="flex items-baseline justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span
              className={`inline-flex h-4 w-4 flex-none items-center justify-center rounded-full text-[10px] ${
                STATUS_BADGE[stage.status]
              }`}
              aria-hidden
            >
              {STATUS_ICON[stage.status]}
            </span>
            <span className="font-medium text-stone-900 truncate">
              {stage.label}
            </span>
          </div>
          {stage.failureReason && (
            <p
              className="mt-1 text-xs text-red-700"
              data-testid={`training-prep-stage-${stage.id}-failure`}
            >
              {stage.failureReason}
            </p>
          )}
          {stage.blockedReason && stage.id !== "transcribe" && (
            <p
              className="mt-1 text-xs text-amber-800"
              data-testid={`training-prep-stage-${stage.id}-blocked`}
            >
              {stage.blockedReason}
            </p>
          )}
        </div>
        <div className="flex-none text-right">
          <span
            className={`text-xs uppercase tracking-wide ${STATUS_TEXT[stage.status]}`}
            data-testid={`training-prep-stage-${stage.id}-status`}
          >
            {statusLabel}
          </span>
          {stage.progress && (
            <div
              className="text-xs text-stone-600 tabular-nums"
              data-testid={`training-prep-stage-${stage.id}-fraction`}
            >
              {stage.progress.numerator} / {stage.progress.denominator} {stage.progress.unit}
            </div>
          )}
        </div>
      </div>

      <div
        className="mt-2 h-2 w-full overflow-hidden rounded-full bg-stone-200"
        data-testid={`training-prep-stage-${stage.id}-bar`}
      >
        {isIndeterminate ? (
          <div
            className="h-full w-1/3 animate-pulse rounded-full bg-amber-500"
            data-testid={`training-prep-stage-${stage.id}-bar-indeterminate`}
          />
        ) : (
          <div
            className={`h-full rounded-full ${barClass} transition-all duration-500`}
            style={{ width: `${barFillPct}%` }}
            data-testid={`training-prep-stage-${stage.id}-bar-fill`}
            data-percent={barFillPct}
          />
        )}
      </div>

      <div className="mt-1 flex items-center justify-between text-xs text-stone-500 tabular-nums">
        <span data-testid={`training-prep-stage-${stage.id}-elapsed`}>
          {stage.status === "COMPLETED"
            ? stage.elapsedMs != null
              ? `Done in ${formatElapsed(stage.elapsedMs)}`
              : "Done"
            : stage.status === "RUNNING" || stage.status === "QUEUED"
              ? `Elapsed ${formatElapsed(liveElapsedMs)}`
              : stage.status === "FAILED" || stage.status === "BLOCKED"
                ? stage.startedAt
                  ? `Stopped after ${formatElapsed(stage.elapsedMs)}`
                  : "Not started"
                : "Waiting on earlier stage"}
        </span>
        <span data-testid={`training-prep-stage-${stage.id}-heartbeat`}>
          {stage.lastActivityAt
            ? `Last activity ${formatLastActivity(stage.lastActivityAt, now)}`
            : ""}
        </span>
      </div>
    </li>
  );
}

const STATUS_LABEL: Record<StageStatus, string> = {
  WAITING: "Waiting",
  QUEUED: "Queued",
  RUNNING: "Running",
  COMPLETED: "Done",
  FAILED: "Failed",
  BLOCKED: "Blocked",
};

const STATUS_BADGE: Record<StageStatus, string> = {
  WAITING: "bg-stone-200 text-stone-500",
  QUEUED: "bg-amber-100 text-amber-800",
  RUNNING: "bg-amber-500 text-white",
  COMPLETED: "bg-club-green text-white",
  FAILED: "bg-red-600 text-white",
  BLOCKED: "bg-red-500 text-white",
};

const STATUS_TEXT: Record<StageStatus, string> = {
  WAITING: "text-stone-500",
  QUEUED: "text-amber-700",
  RUNNING: "text-amber-700",
  COMPLETED: "text-club-green",
  FAILED: "text-red-700",
  BLOCKED: "text-red-700",
};

const STATUS_ICON: Record<StageStatus, string> = {
  WAITING: "",
  QUEUED: "…",
  RUNNING: "…",
  COMPLETED: "✓",
  FAILED: "!",
  BLOCKED: "!",
};

const BAR_CLASSES: Record<StageStatus, string> = {
  WAITING: "bg-stone-300",
  QUEUED: "bg-amber-400",
  RUNNING: "bg-amber-500",
  COMPLETED: "bg-club-green",
  FAILED: "bg-red-500",
  BLOCKED: "bg-red-400",
};
