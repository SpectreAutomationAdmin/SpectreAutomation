"use client";

// EP-TRAIN-6D-4D — persisted-mode manager review workspace.
//
// Reuses the visual language of the 6D-3 fixture preview but renders
// data from Spectre's persisted AI-review records. **Every mutation
// control is disabled by design** — approve / edit / reject /
// revalidate / regenerate all show a consistent "Disabled in read-only
// mode" message with a link to the server's persisted-read docs.
//
// The server is the authority for lifecycle state + validation. This
// client component does NOT:
//   - call `validateTrainingQuestion` on anything (that would imply
//     fresh validation — the UI must only show the persisted outcome)
//   - mutate any React state that could be mistaken for an approval
//     decision
//   - expose a "Request regeneration" or "Revalidate (fixture)" button
//     that does anything beyond informing the reviewer the control is
//     unavailable.

import { useState } from "react";
import type {
  CandidateDetail,
  CandidateQueueRow,
  LifecycleState,
} from "@/lib/hr/training/ai-review/read-service";

const FOCUS_RING =
  "focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-stone-600";

function fmtDate(d: Date | string | null | undefined): string {
  if (!d) return "—";
  const dt = typeof d === "string" ? new Date(d) : d;
  if (Number.isNaN(dt.getTime())) return "—";
  return dt.toISOString().replace("T", " ").slice(0, 19) + "Z";
}

function verdictBadgeClass(verdict: string | null): string {
  if (verdict === "REJECTED") return "bg-rose-100 text-rose-800 border-rose-200";
  if (verdict === "REQUIRES_HUMAN_VERIFICATION") return "bg-amber-50 text-amber-900 border-amber-200";
  if (verdict === "GROUNDED") return "bg-emerald-50 text-emerald-800 border-emerald-200";
  return "bg-stone-100 text-stone-700 border-stone-300";
}

function stateBadgeClass(s: LifecycleState | null | undefined): string {
  if (!s) return "bg-stone-100 text-stone-700 border border-stone-300";
  if (s === "APPROVED_DRAFT") return "bg-emerald-600 text-white";
  if (s === "REJECTED") return "bg-stone-700 text-white";
  if (s === "EDITED_VALIDATION_STALE") return "bg-sky-600 text-white";
  if (s === "VALIDATION_FAILED") return "bg-rose-600 text-white";
  if (s === "ARCHIVED") return "bg-stone-500 text-white";
  if (s === "VALIDATION_PENDING" || s === "GENERATED") return "bg-amber-500 text-white";
  return "bg-stone-100 text-stone-700 border border-stone-300";
}

export interface PersistedReviewWorkspaceProps {
  readonly queue: readonly CandidateQueueRow[];
  readonly selectedDetail: CandidateDetail | null;
  readonly selectedDraftId: string | null;
  readonly clubLabel: string;
  readonly totalCount: number;
  readonly nextCursor: string | null;
  readonly isEmptyQueue: boolean;
}

export default function PersistedReviewWorkspace(props: PersistedReviewWorkspaceProps) {
  const [showMutationHint, setShowMutationHint] = useState(false);

  if (props.isEmptyQueue && !props.selectedDetail) {
    return <EmptyState clubLabel={props.clubLabel} />;
  }

  return (
    <div className="min-h-screen bg-[#faf8f2]">
      <PersistedHeader clubLabel={props.clubLabel} queueCount={props.totalCount} />

      <div className="mx-auto max-w-[1600px] px-6 py-6">
        <div className="lg:grid lg:grid-cols-[280px_minmax(0,1fr)_380px] lg:gap-6">
          <aside className="hidden lg:block" aria-label="Review queue">
            <QueuePanel
              queue={props.queue}
              selectedDraftId={props.selectedDraftId}
              nextCursor={props.nextCursor}
            />
          </aside>

          <main className="mt-6 lg:mt-0 space-y-6" aria-label="Question detail">
            {/* Mobile queue selector */}
            {props.queue.length > 1 && (
              <div className="lg:hidden">
                <label htmlFor="pq" className="sr-only">
                  Candidate
                </label>
                <select
                  id="pq"
                  defaultValue={props.selectedDraftId ?? ""}
                  onChange={(e) => {
                    const v = e.target.value;
                    if (v) window.location.href = `./persisted?candidate=${encodeURIComponent(v)}`;
                  }}
                  className={`w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-sm ${FOCUS_RING}`}
                >
                  {props.queue.map((r) => (
                    <option key={r.draftId} value={r.draftId}>
                      {r.state} · {r.topic.slice(0, 60)}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {props.selectedDetail ? (
              <DetailBody
                detail={props.selectedDetail}
                onAttemptMutation={() => setShowMutationHint(true)}
              />
            ) : (
              <NoSelection />
            )}

            {/* Mobile evidence */}
            {props.selectedDetail && (
              <div className="lg:hidden">
                <EvidencePanel detail={props.selectedDetail} />
              </div>
            )}

            <ReadOnlyControls
              showMutationHint={showMutationHint}
              onDismiss={() => setShowMutationHint(false)}
            />
          </main>

          <aside className="hidden lg:block" aria-label="Source evidence">
            {props.selectedDetail ? (
              <EvidencePanel detail={props.selectedDetail} />
            ) : (
              <EvidenceEmpty />
            )}
          </aside>
        </div>
      </div>
    </div>
  );
}

// ---------- Header ----------

function PersistedHeader({ clubLabel, queueCount }: { clubLabel: string; queueCount: number }) {
  return (
    <header className="border-b border-stone-200 bg-white/70 backdrop-blur-sm">
      <div className="mx-auto max-w-[1600px] px-6 py-5">
        <div className="flex items-start justify-between gap-6 flex-wrap">
          <div>
            <div className="text-[11px] uppercase tracking-[0.18em] text-stone-500">
              AI-assisted training · manager review
            </div>
            <h1 className="mt-1 font-serif text-2xl leading-tight text-stone-900">
              {clubLabel}
            </h1>
            <div className="mt-1 text-sm text-stone-600">
              Persisted candidates <span className="mx-2 text-stone-300" aria-hidden>·</span>
              <span className="italic">read-only</span>
            </div>
          </div>
          <div className="text-right">
            <span className="inline-block text-[11px] uppercase tracking-widest rounded-full bg-sky-100 text-sky-900 border border-sky-200 px-3 py-1">
              Persisted review
            </span>
            <div className="mt-1 text-[10px] font-mono text-stone-400">
              {queueCount} candidate{queueCount === 1 ? "" : "s"} in queue
            </div>
          </div>
        </div>
        <div
          role="note"
          className="mt-3 rounded-md border border-sky-200 bg-sky-50/70 px-4 py-2 text-[12px] text-sky-900"
        >
          <span className="font-semibold uppercase tracking-widest text-[10px]">Mode notice:</span>{" "}
          You are inspecting <strong>persisted records</strong>. Every mutation (approve, edit,
          reject, revalidate, regenerate, publish) is disabled by design. Only a separately
          authorised slice will enable review mutations.
        </div>
      </div>
    </header>
  );
}

// ---------- Queue ----------

function QueuePanel(props: {
  queue: readonly CandidateQueueRow[];
  selectedDraftId: string | null;
  nextCursor: string | null;
}) {
  return (
    <div className="sticky top-6 rounded-lg bg-white shadow-sm border border-stone-200 overflow-hidden">
      <div className="px-4 py-3 border-b border-stone-200">
        <div className="text-[11px] uppercase tracking-widest text-stone-500">Review queue</div>
        <div className="mt-0.5 font-serif text-lg text-stone-900">
          {props.queue.length} candidate{props.queue.length === 1 ? "" : "s"}
        </div>
      </div>
      <ul className="divide-y divide-stone-100" role="list">
        {props.queue.map((r) => {
          const selected = r.draftId === props.selectedDraftId;
          return (
            <li key={r.draftId}>
              <a
                href={`./persisted?candidate=${encodeURIComponent(r.draftId)}`}
                aria-current={selected ? "page" : undefined}
                aria-label={`Open candidate ${r.draftId.slice(0, 8)}: ${r.topic}. State ${r.state}.`}
                className={`block w-full text-left px-4 py-3 transition-colors ${FOCUS_RING} ${
                  selected ? "bg-[#f5f0e2]" : "hover:bg-stone-50"
                }`}
              >
                <div className="flex items-baseline justify-between gap-2">
                  <div className="font-mono text-[11px] text-stone-500">
                    {r.draftId.slice(0, 8)}
                  </div>
                  <span
                    className={`text-[10px] uppercase tracking-wider rounded px-1.5 py-0.5 ${stateBadgeClass(r.state)}`}
                  >
                    {r.state}
                  </span>
                </div>
                <div className="mt-1 text-sm leading-snug text-stone-800 line-clamp-2">
                  {r.topic}
                </div>
                <div className="mt-1 flex items-center gap-2 text-[11px] text-stone-400">
                  <span>{fmtDate(r.generatedAt).slice(0, 10)}</span>
                  {r.latestVerdict && (
                    <span className={`inline-block rounded border px-1 text-[9px] uppercase tracking-wider ${verdictBadgeClass(r.latestVerdict)}`}>
                      {r.latestVerdict}
                    </span>
                  )}
                  {r.latestHardErrorCount > 0 && (
                    <span className="text-rose-600 font-medium">{r.latestHardErrorCount} err</span>
                  )}
                  {r.latestAdvisoryCount > 0 && (
                    <span className="text-amber-700">{r.latestAdvisoryCount} flag</span>
                  )}
                </div>
              </a>
            </li>
          );
        })}
      </ul>
      {props.nextCursor && (
        <div className="px-4 py-2 border-t border-stone-200 text-center">
          <a
            href={`./persisted?cursor=${encodeURIComponent(props.nextCursor)}`}
            className={`inline-block text-[11px] uppercase tracking-widest text-sky-800 hover:text-sky-900 ${FOCUS_RING}`}
          >
            Next page →
          </a>
        </div>
      )}
    </div>
  );
}

// ---------- Detail body ----------

function DetailBody({
  detail,
  onAttemptMutation,
}: {
  detail: CandidateDetail;
  onAttemptMutation: () => void;
}) {
  const v = detail.latestValidation;
  const isSingleAnswer =
    detail.draft.questionType === "SINGLE_CHOICE" || detail.draft.questionType === "TRUE_FALSE";
  const optionsRole = isSingleAnswer ? "radiogroup" : "list";
  const optionItemRole = isSingleAnswer ? "radio" : "listitem";

  return (
    <article
      className="rounded-lg bg-white shadow-sm border border-stone-200 overflow-hidden"
      aria-label="Question under review"
    >
      <div className="px-6 py-4 border-b border-stone-200 flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="text-[11px] uppercase tracking-widest text-stone-500">
            {detail.draft.questionType.replace("_", " ").toLowerCase()}
          </div>
          <h2 className="mt-0.5 font-serif text-xl text-stone-900 line-clamp-2">
            {detail.draft.questionText.slice(0, 120)}
          </h2>
          <div className="mt-1 text-[11px] text-stone-500">
            <span className="font-mono">{detail.draftId}</span>
            <span className="mx-2 text-stone-300" aria-hidden>·</span>
            v{detail.recordVersion}
            <span className="mx-2 text-stone-300" aria-hidden>·</span>
            hash {detail.contentHash.slice(0, 12)}…
          </div>
        </div>
        <div role="status" aria-live="polite" aria-label="Validation state">
          <div className="flex items-center gap-2 flex-wrap">
            <span
              className={`text-[11px] uppercase tracking-widest rounded-full border px-2.5 py-1 ${stateBadgeClass(detail.state)}`}
            >
              {detail.state.replace(/_/g, " ").toLowerCase()}
            </span>
            {v && (
              <span
                className={`text-[11px] uppercase tracking-widest rounded-full border px-2.5 py-1 ${verdictBadgeClass(v.verdict)}`}
              >
                {v.verdict.replace(/_/g, " ").toLowerCase()}
              </span>
            )}
            {v?.validatorSource === "fixture" && (
              <span className="text-[10px] uppercase tracking-widest rounded-full bg-amber-100 text-amber-900 border border-amber-300 px-2 py-0.5">
                fixture-sourced
              </span>
            )}
          </div>
        </div>
      </div>

      <div className="px-6 py-6">
        <div className="text-xs uppercase tracking-widest text-stone-400 mb-2">
          Model-generated question
        </div>
        <p className="text-stone-800 text-[17px] leading-relaxed font-serif">
          {detail.draft.questionText}
        </p>

        <div className="mt-6 text-xs uppercase tracking-widest text-stone-400 mb-2">
          Answer choices
        </div>
        <ol className="space-y-2" role={optionsRole} aria-label="Answer choices">
          {detail.draft.options.map((o, i) => (
            <li
              key={i}
              role={optionItemRole}
              aria-checked={isSingleAnswer ? o.isCorrect : undefined}
              className={`flex items-start gap-3 rounded-md px-3 py-2.5 border ${
                o.isCorrect
                  ? "bg-emerald-50/60 border-emerald-200"
                  : "bg-stone-50 border-stone-200"
              }`}
            >
              <span
                aria-hidden
                className={`mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-medium ${
                  o.isCorrect ? "bg-emerald-600 text-white" : "bg-stone-200 text-stone-600"
                }`}
              >
                {String.fromCharCode(65 + i)}
              </span>
              <span className="text-stone-800 text-[15px] leading-relaxed">{o.text}</span>
              {o.isCorrect && (
                <span className="ml-auto text-[10px] uppercase tracking-widest text-emerald-700 mt-1">
                  <span aria-hidden>Correct</span>
                  <span className="sr-only">Correct answer</span>
                </span>
              )}
            </li>
          ))}
        </ol>

        <div className="mt-6 text-xs uppercase tracking-widest text-stone-400 mb-2">
          Model explanation
        </div>
        <p className="text-stone-700 text-[14px] leading-relaxed italic">
          {detail.draft.explanation}
        </p>

        {detail.reviews.length > 0 && (
          <div className="mt-8 border-t border-stone-200 pt-4">
            <div className="text-xs uppercase tracking-widest text-stone-400 mb-2">
              Reviewer history ({detail.reviews.length})
            </div>
            <ul className="space-y-2 text-[12px] text-stone-700">
              {detail.reviews.map((r) => (
                <li key={r.id}>
                  <span className="font-mono text-[10px] text-stone-500">
                    {fmtDate(r.reviewedAt)}
                  </span>
                  <span className="mx-2 text-stone-300" aria-hidden>·</span>
                  <span className="uppercase tracking-widest text-[10px] text-stone-800">
                    {r.disposition}
                  </span>
                  <span className="mx-2 text-stone-300" aria-hidden>·</span>
                  <span className="text-[10px]">by {r.reviewedByUserId.slice(0, 8)}…</span>
                  {r.reviewerNote && (
                    <div className="ml-4 mt-0.5 text-stone-600 italic">"{r.reviewerNote}"</div>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </article>
  );
}

// ---------- Evidence panel ----------

function EvidencePanel({ detail }: { detail: CandidateDetail }) {
  const v = detail.latestValidation;
  return (
    <div className="sticky top-6 rounded-lg bg-white shadow-sm border border-stone-200 overflow-hidden">
      <div className="px-4 py-3 border-b border-stone-200">
        <div className="text-[11px] uppercase tracking-widest text-stone-500">Source evidence</div>
        <div className="mt-0.5 font-serif text-lg text-stone-900">Content binding</div>
      </div>

      <div className="px-4 py-3 border-b border-stone-200 bg-stone-50 text-[11px] text-stone-600">
        <dl className="space-y-1 font-mono">
          <div>
            <dt className="inline uppercase tracking-widest text-stone-400">Course version</dt>
            <dd className="inline ml-2">{detail.courseVersionId.slice(0, 16)}…</dd>
          </div>
          <div>
            <dt className="inline uppercase tracking-widest text-stone-400">Content hash</dt>
            <dd className="inline ml-2">{detail.contentHash.slice(0, 16)}…</dd>
          </div>
          <div>
            <dt className="inline uppercase tracking-widest text-stone-400">Video SHA</dt>
            <dd className="inline ml-2">{detail.sourceVideoSha256.slice(0, 16)}…</dd>
          </div>
          <div>
            <dt className="inline uppercase tracking-widest text-stone-400">Transcript</dt>
            <dd className="inline ml-2">{detail.resolvedTranscriptBuildId.slice(0, 16)}…</dd>
          </div>
          <div>
            <dt className="inline uppercase tracking-widest text-stone-400">Grounding</dt>
            <dd className="inline ml-2">{detail.groundingProjectionSha256.slice(0, 16)}…</dd>
          </div>
        </dl>
      </div>

      <div className="px-4 py-3 border-b border-stone-200">
        <div className="text-[11px] uppercase tracking-widest text-stone-500">Cited segments</div>
        <ul className="mt-1 flex flex-wrap gap-1 text-[11px]">
          {detail.draft.sourceSegmentIds.length > 0 ? (
            detail.draft.sourceSegmentIds.map((s) => (
              <li
                key={s}
                className="rounded bg-[#f5f0e2] border border-[#d9cf9f] px-2 py-0.5 font-mono"
              >
                seg {s}
              </li>
            ))
          ) : (
            <li className="text-stone-500 italic">No segments cited</li>
          )}
        </ul>
        <p className="mt-2 text-[10px] text-stone-500">
          Video playback is unavailable in this slice. Click-to-seek wiring arrives with the
          separately-authorised media integration slice.
        </p>
      </div>

      {v && v.errors.length > 0 && (
        <div role="alert" className="px-4 py-3 border-t border-rose-200 bg-rose-50">
          <div className="text-[11px] uppercase tracking-widest text-rose-800">
            Hard errors ({v.errors.length})
          </div>
          <ul className="mt-1 space-y-1 text-[12px] text-rose-900">
            {v.errors.map((e, i) => (
              <li key={i}>
                <div className="font-mono text-[10px] text-rose-700">{e.code}</div>
                <div>{e.message}</div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {v && v.flags.length > 0 && (
        <div role="note" className="px-4 py-3 border-t border-amber-200 bg-amber-50/60">
          <div className="text-[11px] uppercase tracking-widest text-amber-800">
            Advisory flags ({v.flags.length})
          </div>
          <ul className="mt-1 space-y-1 text-[12px] text-amber-900">
            {v.flags.map((f, i) => (
              <li key={i} className="font-mono text-[10px]">
                {f}
              </li>
            ))}
          </ul>
        </div>
      )}

      {detail.historicalValidations.length > 0 && (
        <div className="px-4 py-3 border-t border-stone-200">
          <div className="text-[11px] uppercase tracking-widest text-stone-500">
            Historical validations ({detail.historicalValidations.length})
          </div>
          <ul className="mt-1 space-y-1 text-[11px] text-stone-600 font-mono">
            {detail.historicalValidations.map((hv) => (
              <li key={hv.id}>
                {fmtDate(hv.runAt)} · {hv.verdict} · {hv.validatorSource} · v{hv.validatorVersion}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function EvidenceEmpty() {
  return (
    <div className="sticky top-6 rounded-lg bg-white shadow-sm border border-stone-200 p-6 text-sm text-stone-700">
      <div className="text-[11px] uppercase tracking-widest text-stone-500">Source evidence</div>
      <p className="mt-2 italic text-stone-500">Select a candidate from the queue to inspect.</p>
    </div>
  );
}

// ---------- Read-only control bar ----------

function ReadOnlyControls({
  showMutationHint,
  onDismiss,
}: {
  showMutationHint: boolean;
  onDismiss: () => void;
}) {
  const disabledStyle =
    "rounded-md bg-stone-200 text-stone-500 px-4 py-2 text-sm font-medium cursor-not-allowed";
  const disabledTitle = "Disabled in persisted read-only mode.";
  return (
    <div className="rounded-lg bg-white shadow-sm border border-stone-200 overflow-hidden">
      <div className="px-6 py-4 border-b border-stone-200">
        <div className="text-[11px] uppercase tracking-widest text-stone-500">
          Reviewer decision
        </div>
        <div className="mt-0.5 font-serif text-lg text-stone-900">
          Server-authoritative · read-only
        </div>
      </div>

      {showMutationHint && (
        <div role="alert" className="mx-6 mt-4 rounded-md border border-sky-300 bg-sky-50 px-4 py-3 text-[12px] text-sky-900">
          <div className="font-semibold uppercase tracking-widest text-[10px]">
            Mutations disabled
          </div>
          <p className="mt-1">
            Approve / edit / reject / revalidate / regenerate are all disabled in persisted
            read-only mode. The server remains the authority for lifecycle and validation state.
            Use the fixture preview for interaction demonstration.
          </p>
          <button
            onClick={onDismiss}
            className={`mt-2 text-[11px] uppercase tracking-widest text-sky-800 hover:text-sky-900 underline`}
          >
            Dismiss
          </button>
        </div>
      )}

      <div className="px-6 py-4 flex gap-2 flex-wrap">
        {["Approve", "Edit question", "Reject", "Revalidate", "Request regeneration"].map(
          (label) => (
            <button
              key={label}
              disabled
              aria-disabled
              className={disabledStyle}
              title={disabledTitle}
            >
              {label}
            </button>
          ),
        )}
      </div>

      <div className="px-6 py-3 border-t border-stone-200 bg-stone-50 text-[11px] text-stone-500">
        <span className="uppercase tracking-widest">Workflow</span>
        <span className="ml-2 font-medium text-stone-700">
          Generated → Validation → Manager review → Approved draft
        </span>
        <span className="mx-2 text-stone-300" aria-hidden>·</span>
        An approved draft remains an unpublished draft. Publication requires a separate
        authorised step.
      </div>
    </div>
  );
}

// ---------- Non-happy-path shells ----------

function EmptyState({ clubLabel }: { clubLabel: string }) {
  return (
    <div className="min-h-screen bg-[#faf8f2]">
      <PersistedHeader clubLabel={clubLabel} queueCount={0} />
      <div className="mx-auto max-w-[1600px] px-6 py-12">
        <div className="mx-auto max-w-xl rounded-lg border border-stone-200 bg-white p-8 text-stone-800 shadow-sm" role="status">
          <div className="text-[11px] uppercase tracking-widest">No persisted candidates</div>
          <div className="mt-2 font-serif text-xl">The review queue is empty.</div>
          <p className="mt-4 text-sm text-stone-500">
            No AI-generated training question candidates have been persisted for this club.
            New candidates will appear here once a separately-authorised generation run completes.
          </p>
        </div>
      </div>
    </div>
  );
}

function NoSelection() {
  return (
    <div
      role="status"
      className="rounded-lg border border-stone-200 bg-white p-8 text-stone-800 shadow-sm"
    >
      <div className="text-[11px] uppercase tracking-widest">No candidate selected</div>
      <div className="mt-2 font-serif text-xl">Pick a candidate from the queue</div>
      <p className="mt-4 text-sm text-stone-500">
        Select a persisted candidate from the review queue on the left to inspect its validation
        state + evidence metadata.
      </p>
    </div>
  );
}
