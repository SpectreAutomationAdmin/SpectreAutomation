"use client";

// EP-TRAIN-4Y-S §4 — plain-language AI-preparation progress for the
// manager. Polls the existing `transcription-status` +
// `generation-status` + auto-prepare endpoints and renders a 7-stage
// checklist so the manager can see where they are without needing to
// understand internal pipeline terminology.
//
// Durability: the progress is derived entirely from server-side state
// (DB rows), so the manager can refresh / leave / return without
// losing the display. `auto-prepare` is idempotent — no duplicate
// inference runs are started regardless of how many times the UI
// re-fires it.
//
// No false percentages: GPU time has no real client-visible progress,
// so we don't fabricate one. We show the current stage + the stages
// that have completed; everything upstream of the current stage is
// marked done.

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

interface Props {
  readonly versionId: string;
  readonly hasVideo: boolean;
}

type StageId =
  | "upload"
  | "ingest"
  | "transcribe"
  | "generate-objectives"
  | "generate-checkpoints"
  | "generate-assessment"
  | "ready";

interface Stage {
  readonly id: StageId;
  readonly label: string;
}

const STAGES: readonly Stage[] = [
  { id: "upload", label: "Uploading video" },
  { id: "ingest", label: "Preparing video" },
  { id: "transcribe", label: "Transcribing speech" },
  { id: "generate-objectives", label: "Identifying learning objectives" },
  { id: "generate-checkpoints", label: "Generating knowledge checkpoints" },
  { id: "generate-assessment", label: "Preparing final assessment" },
  { id: "ready", label: "Course ready for review" },
];

type FetchStatus =
  | { kind: "loading" }
  | { kind: "ok"; current: StageId; done: StageId[]; errorMessage?: string }
  | { kind: "error"; message: string };

const POLL_MS = 5000;

export default function CoursePrepProgress({ versionId, hasVideo }: Props) {
  const router = useRouter();
  const [status, setStatus] = useState<FetchStatus>({ kind: "loading" });

  const refresh = useCallback(async () => {
    try {
      // Kick the auto-prepare (idempotent) so transcribe + generate
      // are enqueued if they haven't been yet.
      const prep = await fetch(
        `/api/admin/training/versions/${versionId}/auto-prepare`,
        { method: "POST", cache: "no-store" },
      );
      if (!prep.ok) {
        setStatus({ kind: "error", message: "Could not start preparation." });
        return;
      }
      const prepBody = await prep.json();

      // Pull the authoritative per-stage states.
      const [tResp, gResp] = await Promise.all([
        fetch(
          `/api/admin/training/versions/${versionId}/transcription-status`,
          { cache: "no-store" },
        ),
        fetch(
          `/api/admin/training/versions/${versionId}/generation-status`,
          { cache: "no-store" },
        ),
      ]);
      const t = tResp.ok ? await tResp.json() : { state: "ERROR" };
      const g = gResp.ok ? await gResp.json() : { state: "ERROR" };

      const done: StageId[] = [];
      let current: StageId = "upload";

      if (!hasVideo || prepBody?.videoSha256 == null) {
        setStatus({ kind: "ok", current: "upload", done: [] });
        return;
      }
      done.push("upload");

      // Transcript: NOT_STARTED / QUEUED / RUNNING / WAITING_ON_INGEST / COMPLETED
      if (t.state === "NOT_STARTED" || t.state === "QUEUED") {
        current = "ingest";
      } else if (t.state === "RUNNING") {
        current = "transcribe";
      } else if (t.state === "WAITING_ON_INGEST") {
        done.push("ingest");
        done.push("transcribe");
        current = "generate-objectives";
      } else if (t.state === "COMPLETED") {
        done.push("ingest");
        done.push("transcribe");
        // EP-TRAIN-4Y-U §8 — fire grounded metadata generation as
        // soon as the transcript is COMPLETED, independent of
        // whether question generation has started or finished. The
        // deterministic metadata path only needs the transcript, so
        // title + description should populate even if generation
        // hasn't been queued yet. Idempotent on the server (returns
        // COURSE_ALREADY_FINALISED once the course has been edited).
        // The 4Y-T version only fired this after generation
        // COMPLETED — that left provisional courses with an empty
        // transcript-ready state showing "Untitled training course"
        // indefinitely when the generation queue was stuck.
        void fetch(
          `/api/admin/training/versions/${versionId}/generate-metadata`,
          { method: "POST", cache: "no-store" },
        ).catch(() => {
          /* non-fatal; the review surface can retrigger */
        });
        // Generation: NOT_STARTED / QUEUED / RUNNING / COMPLETED / FAILED
        if (g.state === "NOT_STARTED" || g.state === "QUEUED") {
          current = "generate-objectives";
        } else if (g.state === "RUNNING") {
          current = "generate-checkpoints";
        } else if (g.state === "COMPLETED") {
          done.push("generate-objectives");
          done.push("generate-checkpoints");
          done.push("generate-assessment");
          current = "ready";
          done.push("ready");
        } else {
          current = "generate-objectives";
        }
      }

      const errorMessage =
        t.state === "FAILED"
          ? "Transcription failed. Please retry or contact support."
          : g.state === "FAILED"
            ? "Question generation failed. Please retry or contact support."
            : undefined;

      setStatus({ kind: "ok", current, done, errorMessage });

      // When fully ready, let the editor re-render to pick up the
      // drafts + checkpoints that have now landed.
      if (current === "ready") router.refresh();
    } catch (_err) {
      setStatus({ kind: "error", message: "Network error. Retrying…" });
    }
  }, [versionId, hasVideo, router]);

  useEffect(() => {
    // Initial fetch + periodic poll until the course is ready. The
    // interval keeps running even when stages are complete so the
    // manager sees `ready` immediately when the worker finishes.
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

  if (status.kind === "loading") {
    return (
      <div
        className="card card-body text-sm text-stone-500"
        data-testid="training-prep-progress-loading"
      >
        Checking preparation status…
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

  // status.kind === "ok"
  const doneSet = new Set<StageId>(status.done);
  // EP-TRAIN-4Y-U §4 — transcript ready but generation hasn't been
  // enqueued. Show an explicit button so the manager can authorise
  // the Qwen run themselves, and surface "this is your next action"
  // messaging truthfully.
  const transcriptReady = doneSet.has("transcribe");
  const generationStuckAtObjectives =
    transcriptReady && status.current === "generate-objectives";
  return (
    <section
      className="card card-body"
      data-testid="training-prep-progress"
      aria-live="polite"
    >
      <h2 className="section-title text-lg">Preparing course</h2>
      <p className="mt-1 text-sm text-stone-500">
        Spectre is getting your course ready. You can leave this page and
        come back &mdash; progress is saved.
      </p>
      {generationStuckAtObjectives && (
        <ManualGenerationTrigger versionId={versionId} />
      )}
      <ol className="mt-4 space-y-2">
        {STAGES.map((s) => {
          const isDone = doneSet.has(s.id);
          const isCurrent = s.id === status.current && !isDone;
          return (
            <li
              key={s.id}
              className="flex items-center gap-3 text-sm"
              data-testid={`training-prep-stage-${s.id}`}
              data-state={isDone ? "done" : isCurrent ? "in-progress" : "pending"}
            >
              <span
                className={`inline-flex h-5 w-5 items-center justify-center rounded-full text-xs ${
                  isDone
                    ? "bg-club-green text-white"
                    : isCurrent
                      ? "bg-amber-500 text-white"
                      : "bg-stone-200 text-stone-500"
                }`}
                aria-hidden
              >
                {isDone ? "✓" : isCurrent ? "…" : ""}
              </span>
              <span className={isDone ? "text-stone-800" : isCurrent ? "text-stone-900 font-medium" : "text-stone-400"}>
                {s.label}
              </span>
            </li>
          );
        })}
      </ol>
      {status.errorMessage && (
        <p className="mt-3 text-sm text-red-700" role="alert">
          {status.errorMessage}
        </p>
      )}
    </section>
  );
}

// ──────────────────────────────────────────────────────────────────
// EP-TRAIN-4Y-U §4 — explicit manual trigger for AI question
// generation. Appears when the transcript has completed but no
// generation run has been queued yet. Calls the existing
// /versions/[id]/generate endpoint, which enqueues the real
// TRAINING_GENERATE_QUESTIONS job (same path used from the deep
// editor). The manager's click IS the authorisation moment for the
// GPU run — Spectre never auto-triggers Qwen without an explicit
// action.
// ──────────────────────────────────────────────────────────────────

function ManualGenerationTrigger({ versionId }: { versionId: string }) {
  const router = useRouter();
  const [status, setStatus] = useState<"idle" | "firing" | "queued" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);

  const fire = useCallback(async () => {
    setStatus("firing");
    setMessage(null);
    try {
      const resp = await fetch(
        `/api/admin/training/versions/${versionId}/generate`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        },
      );
      const body = await resp.json();
      if (!resp.ok) {
        setStatus("error");
        setMessage(body?.message ?? `Generation request failed (${resp.status}).`);
        return;
      }
      setStatus("queued");
      setMessage(
        body.idempotent
          ? "Generation is already underway."
          : "Question generation queued. This takes a few minutes — leave the tab open or come back later.",
      );
      router.refresh();
    } catch (err) {
      setStatus("error");
      setMessage((err as Error)?.message ?? "Network error.");
    }
  }, [versionId, router]);

  if (status === "queued") {
    return (
      <div
        className="mt-3 rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-800"
        data-testid="training-prep-generation-queued"
      >
        {message}
      </div>
    );
  }

  return (
    <div
      className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2"
      data-testid="training-prep-manual-generation"
    >
      <p className="text-sm text-amber-900">
        Transcript is ready. Click below to generate the knowledge-check and
        final-assessment questions. This uses Spectre&apos;s AI generator and
        takes a few minutes.
      </p>
      {message && status === "error" && (
        <p className="mt-2 text-sm text-red-700" role="alert">
          {message}
        </p>
      )}
      <button
        type="button"
        className="mt-2 btn btn-primary btn-sm"
        onClick={fire}
        disabled={status === "firing"}
        data-testid="training-prep-run-generation"
      >
        {status === "firing" ? "Queueing…" : "Begin AI question generation"}
      </button>
    </div>
  );
}
