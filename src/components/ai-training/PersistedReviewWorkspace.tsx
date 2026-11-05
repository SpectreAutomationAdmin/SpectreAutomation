"use client";

// EP-TRAIN-6D-4D — persisted-mode manager review workspace.
// EP-TRAIN-6D-4I — reviewer-first evidence layout + unified status
// hierarchy + de-duplicated question stem + queue summaries without
// truncated draft IDs. Approved global chrome (sidebar, typography,
// three-column layout) preserved verbatim.
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
//
// Evidence-fidelity rules (6D-4I):
//   - Transcript excerpts are NOT persisted on the AI-review schema.
//     The UI must NOT fabricate them; it shows an explicit
//     "transcript body not persisted in this slice" callout.
//   - Timestamps per cited segment are NOT persisted either; same
//     rule. The draft's `sourceSegmentIds` are reliable and are
//     displayed as segment numbers.
//   - Video playback / click-to-seek wiring is explicitly out of
//     scope; a plain-language unavailable notice is rendered.
//   - `groundingProjectionSha256` values of the form `fixture-...`
//     are historical fixture placeholders, NOT real SHAs. The UI
//     surfaces that provenance honestly rather than presenting
//     them as truncated hashes.

import { useState } from "react";
import type {
  CandidateDetail,
  CandidateQueueRow,
  LifecycleState,
  Verdict,
} from "@/lib/hr/training/ai-review/read-service";

const FOCUS_RING =
  "focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-stone-600";

function fmtDate(d: Date | string | null | undefined): string {
  if (!d) return "—";
  const dt = typeof d === "string" ? new Date(d) : d;
  if (Number.isNaN(dt.getTime())) return "—";
  return dt.toISOString().replace("T", " ").slice(0, 19) + "Z";
}

function fmtDateShort(d: Date | string | null | undefined): string {
  if (!d) return "—";
  const dt = typeof d === "string" ? new Date(d) : d;
  if (Number.isNaN(dt.getTime())) return "—";
  return dt.toISOString().slice(0, 10);
}

/**
 * Looks like a real SHA-256 fingerprint? 64 lowercase hex chars.
 * Historical fixtures (6C-9 / 6C-11) wrote `fixture-q1`, `fixture-q2`,
 * etc. into `approvedGroundingProjectionSha256` — those are placeholders,
 * not recoverable hashes. We flag them honestly.
 */
function isRealSha256(s: string | null | undefined): boolean {
  if (!s) return false;
  return /^[0-9a-f]{64}$/.test(s);
}

// ---------- Plain-language translations for validator codes ----------

/**
 * Map validator ERR_* codes to a short, plain-language sentence. We
 * fall back to the raw code + the raw message for codes we have not
 * explicitly curated — we never silently drop a validator error and
 * we never invent severity.
 */
const ERROR_CODE_LABELS: Readonly<Record<string, string>> = {
  ERR_CITATION_SEGMENT_UNAUTHORIZED:
    "A cited term or passage is not present in the authorised source segments.",
  ERR_UNSUPPORTED_REGULATORY_BODY:
    "Mentions a regulator or standard not referenced in the source material.",
  ERR_UNSUPPORTED_INSURANCE_REFERENCE:
    "Mentions an insurance entity not present in the source material.",
  ERR_UNSUPPORTED_YEAR_REFERENCE:
    "States a year or date not supported by the cited passages.",
  ERR_UNSUPPORTED_NAMED_ENTITY_SUBJECT:
    "Assigns the obligation to a named role the source material does not reference.",
};

const FLAG_LABELS: Readonly<Record<string, string>> = {
  FLAG_UNSUPPORTED_ANSWER_WORDS:
    "Answer wording introduces phrasing beyond what the cited passages support.",
  SOURCE_ORG_MISMATCH:
    "Question references an organisation different from the authoring club.",
  FLAG_AMBIGUOUS_SUBJECT_ATTRIBUTION:
    "Subject of the obligation is ambiguous — reviewer should confirm who is accountable.",
  FLAG_PRESCRIPTIVE_INSERTION:
    "Reviewer: the question adds a prescriptive directive not clearly in the source.",
};

function errorSummary(code: string, message: string): string {
  const label = ERROR_CODE_LABELS[code];
  if (label) return label;
  return message;
}

function flagSummary(code: string): string {
  return FLAG_LABELS[code] ?? code;
}

// ---------- Unified status hierarchy ----------

type StatusTone = "neutral" | "warning" | "danger" | "success";

interface UnifiedStatus {
  readonly primary: string;      // short, reviewer-facing primary label
  readonly tone: StatusTone;
  readonly subline: string;      // sub-explanation ("Needs human sign-off", etc.)
}

function computeStatus(detail: CandidateDetail): UnifiedStatus {
  const v = detail.latestValidation;
  const state = detail.state;
  const verdict: Verdict | null = v?.verdict ?? null;

  if (state === "REJECTED" || verdict === "REJECTED") {
    const n = v?.errors.length ?? 0;
    return {
      primary: "Rejected",
      tone: "danger",
      subline: n > 0
        ? `${n} hard validation error${n === 1 ? "" : "s"} — this candidate cannot be approved.`
        : "This candidate is rejected and cannot be approved.",
    };
  }
  if (state === "APPROVED_DRAFT") {
    return {
      primary: "Approved draft",
      tone: "success",
      subline: "Draft approved. Publication requires a separate authorised step.",
    };
  }
  if (state === "ARCHIVED") {
    return {
      primary: "Archived",
      tone: "neutral",
      subline: "Historical record — superseded or past retention.",
    };
  }
  if (state === "VALIDATION_FAILED") {
    return {
      primary: "Validation failed",
      tone: "danger",
      subline: "An internal validation run did not complete. Re-run required.",
    };
  }
  if (state === "VALIDATION_PENDING" || state === "GENERATED") {
    return {
      primary: "Awaiting validation",
      tone: "neutral",
      subline: "Validator has not produced a verdict for the current content yet.",
    };
  }
  if (state === "EDITED_VALIDATION_STALE") {
    return {
      primary: "Edited — revalidation needed",
      tone: "warning",
      subline: "The draft was edited after validation; current verdict is stale.",
    };
  }
  // REQUIRES_HUMAN_REVIEW (incl. REQUIRES_HUMAN_VERIFICATION verdict).
  const flagCount = v?.flags.length ?? 0;
  return {
    primary: "Needs reviewer decision",
    tone: "warning",
    subline: verdict === "REQUIRES_HUMAN_VERIFICATION"
      ? flagCount > 0
        ? `Validator passed hard checks but flagged ${flagCount} advisor${flagCount === 1 ? "y" : "ies"} for human confirmation. Not approved — not grounded.`
        : "Validator passed hard checks but defers to a human reviewer. Not approved — not grounded."
      : "Queued for human reviewer attention.",
  };
}

function statusBadgeClass(tone: StatusTone): string {
  switch (tone) {
    case "danger":  return "bg-rose-50 text-rose-900 border-rose-300";
    case "warning": return "bg-amber-50 text-amber-900 border-amber-300";
    case "success": return "bg-emerald-50 text-emerald-900 border-emerald-300";
    case "neutral":
    default:        return "bg-stone-50 text-stone-800 border-stone-300";
  }
}

// ---------- Queue row helpers ----------

/**
 * One compact signal per queue row (strongest wins): hard errors →
 * REJECTED without errors → advisories → clean. Matches the body
 * validation panel so the queue reads the same story.
 */
function queueSignal(r: CandidateQueueRow): { label: string; tone: StatusTone } {
  if (r.latestHardErrorCount > 0) {
    return { label: `${r.latestHardErrorCount} error${r.latestHardErrorCount === 1 ? "" : "s"}`, tone: "danger" };
  }
  if (r.state === "REJECTED") {
    return { label: "Rejected", tone: "danger" };
  }
  if (r.latestAdvisoryCount > 0) {
    return { label: `${r.latestAdvisoryCount} advisor${r.latestAdvisoryCount === 1 ? "y" : "ies"}`, tone: "warning" };
  }
  if (r.latestVerdict === "GROUNDED") {
    return { label: "Grounded", tone: "success" };
  }
  if (r.latestVerdict === null) {
    return { label: "Pending validation", tone: "neutral" };
  }
  return { label: "Clean", tone: "success" };
}

function queueStateLabel(s: LifecycleState): string {
  switch (s) {
    case "REQUIRES_HUMAN_REVIEW":     return "Needs review";
    case "REJECTED":                  return "Rejected";
    case "APPROVED_DRAFT":            return "Approved";
    case "ARCHIVED":                  return "Archived";
    case "VALIDATION_FAILED":         return "Validation failed";
    case "VALIDATION_PENDING":        return "Validating";
    case "GENERATED":                 return "Generated";
    case "EDITED_VALIDATION_STALE":   return "Edited (stale)";
    default:                          return s;
  }
}

/**
 * Extract a short human-facing question title from the raw topic.
 * Strips any `[TEST FIXTURE …]` prefix so the reviewer sees the real
 * question, keeps the first sentence or first 90 chars.
 */
function queueTitle(topic: string): string {
  const stripped = topic.replace(/^\s*\[TEST FIXTURE[^\]]*\]\s*/i, "").trim();
  if (stripped.length === 0) return topic;
  const firstBreak = stripped.search(/[?.!]/);
  if (firstBreak > 0 && firstBreak < 110) {
    return stripped.slice(0, firstBreak + 1);
  }
  return stripped.length > 90 ? stripped.slice(0, 90).trimEnd() + "…" : stripped;
}

// ---------- Component ----------

export interface PersistedReviewWorkspaceProps {
  readonly queue: readonly CandidateQueueRow[];
  readonly selectedDetail: CandidateDetail | null;
  readonly selectedDraftId: string | null;
  readonly clubLabel: string;
  readonly totalCount: number;
  readonly nextCursor: string | null;
  readonly isEmptyQueue: boolean;
  /** EP-TRAIN-6D-4I — course/version context supplied by the server page. */
  readonly sourceContext?: {
    readonly courseTitle: string | null;
    readonly versionTitle: string | null;
    readonly versionNumber: number | null;
    readonly videoStorageKeyPresent: boolean;
    readonly videoDurationSec: number | null;
  } | null;
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
                      {queueStateLabel(r.state)} · {queueTitle(r.topic)}
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
                <EvidencePanel
                  detail={props.selectedDetail}
                  sourceContext={props.sourceContext ?? null}
                />
              </div>
            )}

            <ReadOnlyControls
              showMutationHint={showMutationHint}
              onDismiss={() => setShowMutationHint(false)}
            />
          </main>

          <aside className="hidden lg:block" aria-label="Source evidence">
            {props.selectedDetail ? (
              <EvidencePanel
                detail={props.selectedDetail}
                sourceContext={props.sourceContext ?? null}
              />
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
          const title = queueTitle(r.topic);
          const stateLabel = queueStateLabel(r.state);
          const signal = queueSignal(r);
          return (
            <li key={r.draftId}>
              <a
                href={`./persisted?candidate=${encodeURIComponent(r.draftId)}`}
                aria-current={selected ? "page" : undefined}
                aria-label={`Open ${stateLabel}: ${title}`}
                title={r.draftId /* full id in tooltip only */}
                className={`block w-full text-left px-4 py-3 transition-colors ${FOCUS_RING} ${
                  selected ? "bg-[#f5f0e2]" : "hover:bg-stone-50"
                }`}
              >
                <div className="text-[15px] leading-snug text-stone-900 line-clamp-3">
                  {title}
                </div>
                <div className="mt-2 flex items-center justify-between gap-2 text-[11px]">
                  <span
                    className={`uppercase tracking-wider rounded-full border px-2 py-0.5 ${statusBadgeClass(toneForState(r.state))}`}
                  >
                    {stateLabel}
                  </span>
                  <span
                    className={`rounded-full border px-2 py-0.5 ${statusBadgeClass(signal.tone)}`}
                    aria-label={`Validation: ${signal.label}`}
                  >
                    {signal.label}
                  </span>
                </div>
                <div className="mt-1.5 text-[10px] text-stone-400">
                  Generated {fmtDateShort(r.generatedAt)}
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

function toneForState(s: LifecycleState): StatusTone {
  if (s === "REJECTED" || s === "VALIDATION_FAILED") return "danger";
  if (s === "REQUIRES_HUMAN_REVIEW" || s === "EDITED_VALIDATION_STALE") return "warning";
  if (s === "APPROVED_DRAFT") return "success";
  return "neutral";
}

// ---------- Detail body ----------

function DetailBody({
  detail,
  onAttemptMutation: _onAttemptMutation,
}: {
  detail: CandidateDetail;
  onAttemptMutation: () => void;
}) {
  const status = computeStatus(detail);
  const isSingleAnswer =
    detail.draft.questionType === "SINGLE_CHOICE" || detail.draft.questionType === "TRUE_FALSE";
  const optionsRole = isSingleAnswer ? "radiogroup" : "list";
  const optionItemRole = isSingleAnswer ? "radio" : "listitem";

  const questionTypeLabel =
    detail.draft.questionType === "SINGLE_CHOICE" ? "Single choice"
    : detail.draft.questionType === "TRUE_FALSE" ? "True / false"
    : detail.draft.questionType.replace(/_/g, " ").toLowerCase();

  return (
    <article
      className="rounded-lg bg-white shadow-sm border border-stone-200 overflow-hidden"
      aria-label="Question under review"
    >
      {/* Header — question-type eyebrow + unified status. NO duplicate
          question stem, NO raw draftId in the prominent position. */}
      <div className="px-6 py-4 border-b border-stone-200 flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="text-[11px] uppercase tracking-widest text-stone-500">
            {questionTypeLabel}
          </div>
          <div
            className={`mt-1 inline-flex items-baseline gap-2 rounded-full border px-3 py-1 ${statusBadgeClass(status.tone)}`}
            role="status"
            aria-live="polite"
          >
            <span className="font-medium text-[13px] uppercase tracking-wider">
              {status.primary}
            </span>
          </div>
          <p className="mt-2 max-w-[60ch] text-[12px] text-stone-600 leading-relaxed">
            {status.subline}
          </p>
        </div>
        <div className="text-right text-[11px] text-stone-500">
          <div>Generated {fmtDateShort(detail.generatedAt)}</div>
          <div className="text-[10px] text-stone-400 mt-0.5">
            v{detail.recordVersion}
          </div>
        </div>
      </div>

      {/* Question body — rendered ONCE, prominently. */}
      <div className="px-6 py-6">
        <div className="text-[11px] uppercase tracking-widest text-stone-400 mb-2">
          Question
        </div>
        <p className="text-stone-900 text-[18px] leading-relaxed font-serif">
          {detail.draft.questionText}
        </p>

        <div className="mt-6 text-[11px] uppercase tracking-widest text-stone-400 mb-2">
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

        <div className="mt-6 text-[11px] uppercase tracking-widest text-stone-400 mb-2">
          Model explanation
        </div>
        <p className="text-stone-700 text-[14px] leading-relaxed">
          {detail.draft.explanation}
        </p>

        {detail.reviews.length > 0 && (
          <div className="mt-8 border-t border-stone-200 pt-4">
            <div className="text-[11px] uppercase tracking-widest text-stone-400 mb-2">
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
                    <div className="ml-4 mt-0.5 text-stone-600 italic">&ldquo;{r.reviewerNote}&rdquo;</div>
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

function EvidencePanel({
  detail,
  sourceContext,
}: {
  detail: CandidateDetail;
  sourceContext: PersistedReviewWorkspaceProps["sourceContext"] | null | undefined;
}) {
  const v = detail.latestValidation;
  const flagSet = new Set<string>(v?.flags ?? []);
  const hasSourceOrgMismatch = flagSet.has("SOURCE_ORG_MISMATCH");
  const hasRealGrounding = isRealSha256(detail.groundingProjectionSha256);
  const groundingNote = hasRealGrounding
    ? null
    : "This candidate was imported from a historical pilot where the grounding projection hash was not retained. The cited segments and validation remain authoritative; the grounding fingerprint is a fixture placeholder.";

  return (
    <div className="sticky top-6 rounded-lg bg-white shadow-sm border border-stone-200 overflow-hidden">
      {/* Panel heading */}
      <div className="px-4 py-3 border-b border-stone-200">
        <div className="text-[11px] uppercase tracking-widest text-stone-500">Source evidence</div>
        <div className="mt-0.5 font-serif text-lg text-stone-900">What the model saw</div>
      </div>

      {/* Reviewer-first source narrative. Course + version come from the
          server; source organisation note is honest about what is and
          isn't persisted. */}
      <div className="px-4 py-3 border-b border-stone-200">
        <div className="text-[11px] uppercase tracking-widest text-stone-500">
          Source material
        </div>
        <dl className="mt-2 space-y-1.5 text-[13px] text-stone-800">
          <div className="flex items-baseline gap-2">
            <dt className="text-[11px] uppercase tracking-wider text-stone-500 w-24 shrink-0">Course</dt>
            <dd>
              {sourceContext?.courseTitle ?? (
                <span className="italic text-stone-500">Course title unavailable</span>
              )}
            </dd>
          </div>
          <div className="flex items-baseline gap-2">
            <dt className="text-[11px] uppercase tracking-wider text-stone-500 w-24 shrink-0">Version</dt>
            <dd>
              {sourceContext?.versionNumber != null
                ? `v${sourceContext.versionNumber}${sourceContext.versionTitle ? ` · ${sourceContext.versionTitle}` : ""}`
                : <span className="italic text-stone-500">Version metadata unavailable</span>}
            </dd>
          </div>
          <div className="flex items-baseline gap-2">
            <dt className="text-[11px] uppercase tracking-wider text-stone-500 w-24 shrink-0">Video</dt>
            <dd>
              {sourceContext?.videoStorageKeyPresent
                ? (
                  <span>
                    Uploaded
                    {sourceContext.videoDurationSec
                      ? ` · ${Math.round(sourceContext.videoDurationSec / 60)} min`
                      : ""}
                    <span className="block text-[11px] text-stone-500 italic">
                      Playback and click-to-seek arrive in a separately-authorised media slice.
                    </span>
                  </span>
                )
                : <span className="italic text-stone-500">No video attached to this version.</span>}
            </dd>
          </div>
        </dl>
        {hasSourceOrgMismatch && (
          <div
            role="alert"
            className="mt-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-[12px] text-amber-900"
          >
            <div className="font-semibold uppercase tracking-widest text-[10px]">
              Source-organisation mismatch
            </div>
            <p className="mt-1 leading-snug">
              The validator flagged that this question references an organisation name
              different from the authoring club. Confirm before approving; the question
              may need to be rewritten to the authoring club&rsquo;s identity.
            </p>
          </div>
        )}
      </div>

      {/* Cited segments — authoritative, but transcript body is NOT
          persisted on the AI-review schema. We say so explicitly. */}
      <div className="px-4 py-3 border-b border-stone-200">
        <div className="text-[11px] uppercase tracking-widest text-stone-500">
          Cited transcript segments
        </div>
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
            <li className="text-stone-500 italic">No segments cited.</li>
          )}
        </ul>
        <div className="mt-2 rounded-md border border-stone-200 bg-stone-50 px-3 py-2 text-[11px] text-stone-600 leading-snug">
          <span className="font-semibold uppercase tracking-widest text-[10px] text-stone-500">
            Transcript body
          </span>
          <span className="block mt-0.5">
            Not persisted on the AI-review schema in this slice. Reviewers must
            consult the source video / resolved transcript directly (via the
            separately-authorised media integration) to verify each cited segment
            matches the question.
          </span>
        </div>
        <div className="mt-2 text-[11px] text-stone-500 italic">
          Timestamps per cited segment are not persisted either.
        </div>
      </div>

      {/* Validation errors — plain-language labels, raw code preserved for audit. */}
      {v && v.errors.length > 0 && (
        <div role="alert" className="px-4 py-3 border-t border-rose-200 bg-rose-50">
          <div className="text-[11px] uppercase tracking-widest text-rose-800">
            Validation errors ({v.errors.length}) — this candidate cannot be approved
          </div>
          <ul className="mt-2 space-y-2 text-[12px] text-rose-900">
            {v.errors.map((e, i) => (
              <li key={i}>
                <div className="leading-snug">{errorSummary(e.code, e.message)}</div>
                <div className="font-mono text-[10px] text-rose-700 mt-0.5">{e.code}</div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Advisory flags — plain language. */}
      {v && v.flags.length > 0 && (
        <div role="note" className="px-4 py-3 border-t border-amber-200 bg-amber-50/60">
          <div className="text-[11px] uppercase tracking-widest text-amber-800">
            Advisories ({v.flags.length}) — reviewer judgement required
          </div>
          <ul className="mt-2 space-y-2 text-[12px] text-amber-900">
            {v.flags.map((f, i) => (
              <li key={i}>
                <div className="leading-snug">{flagSummary(f)}</div>
                <div className="font-mono text-[10px] text-amber-700 mt-0.5">{f}</div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* "Nothing to flag" — positive confirmation for the clean path. */}
      {v && v.errors.length === 0 && v.flags.length === 0 && (
        <div className="px-4 py-3 border-t border-emerald-200 bg-emerald-50/60 text-[12px] text-emerald-900">
          No validation errors and no advisories recorded on the latest run.
        </div>
      )}

      {/* Historical validations — short-form audit trail. */}
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

      {/* Collapsible technical provenance — hashes and IDs only. */}
      <details className="px-4 py-3 border-t border-stone-200 group">
        <summary className="cursor-pointer text-[11px] uppercase tracking-widest text-stone-500 marker:hidden list-none">
          <span className="font-medium">Technical provenance</span>
          <span className="ml-2 text-stone-400 group-open:hidden">(show hashes + IDs)</span>
          <span className="ml-2 text-stone-400 hidden group-open:inline">(hide)</span>
        </summary>
        <dl className="mt-3 space-y-1 font-mono text-[11px] text-stone-600">
          <div>
            <dt className="inline uppercase tracking-widest text-stone-400">Draft id</dt>
            <dd className="inline ml-2 break-all">{detail.draftId}</dd>
          </div>
          <div>
            <dt className="inline uppercase tracking-widest text-stone-400">Content hash</dt>
            <dd className="inline ml-2">{detail.contentHash}</dd>
          </div>
          <div>
            <dt className="inline uppercase tracking-widest text-stone-400">Course version</dt>
            <dd className="inline ml-2">{detail.courseVersionId}</dd>
          </div>
          <div>
            <dt className="inline uppercase tracking-widest text-stone-400">Video SHA-256</dt>
            <dd className="inline ml-2 break-all">{detail.sourceVideoSha256}</dd>
          </div>
          <div>
            <dt className="inline uppercase tracking-widest text-stone-400">Transcript build</dt>
            <dd className="inline ml-2 break-all">{detail.resolvedTranscriptBuildId}</dd>
          </div>
          <div>
            <dt className="inline uppercase tracking-widest text-stone-400">Grounding fingerprint</dt>
            <dd className="inline ml-2 break-all">
              {detail.groundingProjectionSha256}
              {!hasRealGrounding && (
                <span className="ml-2 inline-block rounded bg-amber-100 text-amber-800 border border-amber-300 px-1.5 py-0.5 text-[10px] uppercase tracking-widest">
                  fixture placeholder
                </span>
              )}
            </dd>
          </div>
          {v && (
            <>
              <div>
                <dt className="inline uppercase tracking-widest text-stone-400">Validator version</dt>
                <dd className="inline ml-2">{v.validatorVersion}</dd>
              </div>
              <div>
                <dt className="inline uppercase tracking-widest text-stone-400">Validator source</dt>
                <dd className="inline ml-2">{v.validatorSource}</dd>
              </div>
            </>
          )}
        </dl>
        {groundingNote && (
          <p className="mt-3 text-[11px] text-stone-600 italic leading-snug">
            {groundingNote}
          </p>
        )}
      </details>
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
