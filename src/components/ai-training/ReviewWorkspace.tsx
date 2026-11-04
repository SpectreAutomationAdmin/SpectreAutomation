"use client";

// EP-TRAIN-6D-3 — hardened manager review workspace.
//
// Fixture-driven. No live inference. No DB writes. No cross-tenant exposure.
// All review actions operate on LOCAL REACT STATE ONLY. The "Request
// regeneration" control is disabled because a separately authorised
// generation workflow does not yet exist (6D-1 §B2).
//
// 6D-3 additions over the 6D-1 baseline:
//
//   G-1   Approval guard — a single authoritative pure function
//         (`evaluateApproval`) is called both to compute the Approve
//         button's `disabled` state AND inside the Approve action handler,
//         so no stale-state or DOM-tampering path can bypass it.
//
//   Stale-after-edit flow — editing a question does NOT silently re-run
//         validation. The previous validation result is preserved as
//         historical evidence; validation status flips to "stale". The
//         reviewer must click "Revalidate (fixture)" which applies a
//         pre-determined outcome from the fixture file (NOT a live
//         pipeline call on arbitrary edited content — this slice is
//         offline only).
//
//   D-2   Loading / empty / no-selection / missing-evidence /
//         failed-fixture / validation-unavailable states, all rendered
//         in Spectre's approved visual language. Triggerable via the
//         `demoState` prop for screenshot capture.
//
//   D-3   Accessibility:
//           - aria-label on queue buttons + aria-current on the selected row
//           - role="radiogroup"/role="radio" on TRUE_FALSE + SINGLE_CHOICE
//           - role="list" on MULTI_ANSWER / passages
//           - role="alert" on hard-error panel + stale banner
//           - role="status" / aria-live="polite" on verdict row
//           - focus-visible:ring styles on every interactive
//           - aria-describedby wiring Approve → block-reason text
//           - aria-disabled on disabled controls with inline explanation
//
//   Placeholder honesty — the video tile + citation list now carry
//         explicit "not connected in fixture mode" labels and a
//         wire-up-pending note. No visual affordance implies click-to-seek
//         works.

import { useState } from "react";
import {
  validateTrainingQuestion,
  type PipelineResult,
  type TrainingQuestionDraftLiteV1,
} from "@/lib/training/ai-generation";
import { evaluateApproval, type ValidationStatus } from "./approval-guard";
import { FIXTURES, COURSE_CONTEXT, type Fixture, type FixtureRevalidationOutcome } from "./fixtures";

type ReviewDisposition = "pending" | "approved" | "edited" | "rejected";

interface ReviewState {
  readonly disposition: ReviewDisposition;
  readonly editedDraft?: TrainingQuestionDraftLiteV1;
  readonly latestValidation: PipelineResult | null;
  readonly validationStatus: ValidationStatus;
  readonly previousValidation?: PipelineResult | null;
  readonly reviewerNote?: string;
}

function fmtTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function verdictBadgeClass(verdict: string): string {
  if (verdict === "REJECTED") return "bg-rose-100 text-rose-800 border-rose-200";
  if (verdict === "REQUIRES_HUMAN_VERIFICATION") return "bg-amber-50 text-amber-900 border-amber-200";
  return "bg-emerald-50 text-emerald-800 border-emerald-200";
}

function dispositionBadgeClass(d: ReviewDisposition): string {
  switch (d) {
    case "approved": return "bg-emerald-600 text-white";
    case "edited": return "bg-sky-600 text-white";
    case "rejected": return "bg-stone-700 text-white";
    case "pending": return "bg-stone-100 text-stone-700 border border-stone-300";
  }
}

const FOCUS_RING = "focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-stone-600";

// ------------------------------------------------------------------
// Workspace props
// ------------------------------------------------------------------

export type DemoState =
  | "loading"
  | "empty"
  | "no-selection"
  | "missing-evidence"
  | "failed-fixture"
  | "validation-unavailable";

export interface ReviewWorkspaceProps {
  /** Optional pre-set initial selection / review states. Used by the
   *  static preview renderer to produce deterministic screenshots. */
  readonly initial?: {
    readonly selectedLabel?: string;
    readonly reviewStates?: Readonly<Record<string, ReviewState>>;
    readonly editOpen?: boolean;
  };
  /** Force a non-happy-path state for screenshot capture / documentation.
   *  Overrides any `initial` selection when set. */
  readonly demoState?: DemoState;
}

export default function ReviewWorkspace({ initial, demoState }: ReviewWorkspaceProps = {}) {
  // Initialise local state. Every fixture gets its initial validation
  // computed once at mount; subsequent edits mark it stale.
  const [selectedLabel, setSelectedLabel] = useState<string>(
    initial?.selectedLabel ?? FIXTURES[0]?.label ?? "",
  );
  const [reviewStates, setReviewStates] = useState<Record<string, ReviewState>>(() => {
    const out: Record<string, ReviewState> = {};
    for (const f of FIXTURES) {
      const initRes = validateTrainingQuestion({
        draft: f.draft,
        grounding: f.grounding,
        authorization: f.authorization,
      });
      out[f.label] = {
        disposition: "pending",
        latestValidation: initRes,
        validationStatus: "complete",
      };
    }
    if (initial?.reviewStates) {
      for (const [k, v] of Object.entries(initial.reviewStates)) {
        out[k] = { ...out[k], ...v };
      }
    }
    return out;
  });

  if (demoState === "loading") return <LoadingShell />;
  if (demoState === "empty") return <EmptyQueueShell />;
  if (demoState === "failed-fixture") return <FailedFixtureShell />;

  const selected = FIXTURES.find((f) => f.label === selectedLabel);
  if (demoState === "no-selection" || !selected) {
    return <NoSelectionShell onSelect={setSelectedLabel} />;
  }

  const reviewState = reviewStates[selected.label];
  const effectiveDraft = reviewState.editedDraft ?? selected.draft;
  const result = reviewState.latestValidation;

  function setStateFor(label: string, next: Partial<ReviewState>) {
    setReviewStates((prev) => ({ ...prev, [label]: { ...prev[label], ...next } }));
  }

  const approvalGuard = evaluateApproval({
    latestValidation: result,
    validationStatus: reviewState.validationStatus,
  });

  function handleApprove() {
    // Double-gate: re-evaluate at click time so DOM tampering or stale
    // UI state cannot bypass the guard.
    const guard = evaluateApproval({
      latestValidation: reviewStates[selected!.label].latestValidation,
      validationStatus: reviewStates[selected!.label].validationStatus,
    });
    if (!guard.allowed) return;
    setStateFor(selected!.label, { disposition: "approved" });
  }

  function handleReject() {
    setStateFor(selected!.label, { disposition: "rejected" });
  }

  function handleEditSave(edited: TrainingQuestionDraftLiteV1) {
    setStateFor(selected!.label, {
      disposition: "edited",
      editedDraft: edited,
      previousValidation: reviewState.latestValidation,
      validationStatus: "stale",
    });
  }

  function handleRevalidateFixture() {
    const outcome = selected!.revalidationDemo;
    setStateFor(selected!.label, {
      latestValidation: outcome.result,
      validationStatus: "complete",
      previousValidation: reviewState.latestValidation,
    });
  }

  return (
    <div className="min-h-screen bg-[#faf8f2]">
      <Header />
      <div className="mx-auto max-w-[1600px] px-6 py-6">
        <div className="lg:grid lg:grid-cols-[280px_minmax(0,1fr)_380px] lg:gap-6">
          <aside className="hidden lg:block" aria-label="Review queue">
            <QueuePanel
              fixtures={FIXTURES}
              selectedLabel={selected.label}
              onSelect={setSelectedLabel}
              reviewStates={reviewStates}
            />
          </aside>

          <main className="mt-6 lg:mt-0 space-y-6" aria-label="Question review">
            <div className="lg:hidden">
              <label htmlFor="review-queue-mobile" className="sr-only">Candidate</label>
              <select
                id="review-queue-mobile"
                value={selected.label}
                onChange={(e) => setSelectedLabel(e.target.value)}
                className={`w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-sm ${FOCUS_RING}`}
              >
                {FIXTURES.map((f) => (
                  <option key={f.label} value={f.label}>{f.label} — {f.topic.slice(0, 40)}</option>
                ))}
              </select>
            </div>

            <ValidationStatusBanner
              status={reviewState.validationStatus}
              fixture={selected}
              onRevalidateFixture={handleRevalidateFixture}
            />

            <QuestionCard
              fixture={selected}
              effectiveDraft={effectiveDraft}
              result={result}
              status={reviewState.validationStatus}
            />

            <div className="lg:hidden">
              <EvidencePanel
                fixture={selected}
                result={result}
                missing={demoState === "missing-evidence"}
                unavailable={demoState === "validation-unavailable"}
              />
            </div>

            <ReviewControls
              fixture={selected}
              effectiveDraft={effectiveDraft}
              state={reviewState}
              guard={approvalGuard}
              initialEditOpen={initial?.editOpen ?? false}
              onApprove={handleApprove}
              onReject={handleReject}
              onEditSave={handleEditSave}
              onRevalidateFixture={handleRevalidateFixture}
            />
          </main>

          <aside className="hidden lg:block" aria-label="Source evidence">
            <EvidencePanel
              fixture={selected}
              result={result}
              missing={demoState === "missing-evidence"}
              unavailable={demoState === "validation-unavailable"}
            />
          </aside>
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------
// Header
// ------------------------------------------------------------------

function Header() {
  return (
    <header className="border-b border-stone-200 bg-white/70 backdrop-blur-sm">
      <div className="mx-auto max-w-[1600px] px-6 py-5">
        <div className="flex items-start justify-between gap-6 flex-wrap">
          <div>
            <div className="text-[11px] uppercase tracking-[0.18em] text-stone-500">AI-assisted training · manager review</div>
            <h1 className="mt-1 font-serif text-2xl leading-tight text-stone-900">{COURSE_CONTEXT.title}</h1>
            <div className="mt-1 text-sm text-stone-600">
              {COURSE_CONTEXT.clubName} <span className="mx-2 text-stone-300" aria-hidden>·</span>
              <span className="italic">{COURSE_CONTEXT.tenantLabel}</span>
            </div>
          </div>
          <div className="text-right">
            <span className="inline-block text-[11px] uppercase tracking-widest rounded-full bg-amber-100 text-amber-900 border border-amber-200 px-3 py-1">
              Fixture preview
            </span>
            <div className="mt-1 font-mono text-[10px] text-stone-400">
              build {COURSE_CONTEXT.resolvedTranscriptBuildId.slice(0, 12)}…
            </div>
            <a
              href="/app/admin/ai-training/review/persisted"
              className={`mt-2 inline-block text-[11px] uppercase tracking-widest text-sky-800 hover:text-sky-900 underline ${FOCUS_RING}`}
            >
              Switch to persisted review →
            </a>
          </div>
        </div>
        <div
          role="note"
          className="mt-3 rounded-md border border-amber-200 bg-amber-50/70 px-4 py-2 text-[12px] text-amber-900"
        >
          <span className="font-semibold uppercase tracking-widest text-[10px]">Mode notice:</span>{" "}
          This is a <strong>fixture preview</strong>. All data is non-persistent
          demonstration content. For persisted database records, use the persisted-review surface.
        </div>
      </div>
    </header>
  );
}

// ------------------------------------------------------------------
// Validation-status banner — explicit staleness messaging
// ------------------------------------------------------------------

function ValidationStatusBanner(props: {
  status: ValidationStatus;
  fixture: Fixture;
  onRevalidateFixture: () => void;
}) {
  if (props.status === "complete") return null;
  const palette =
    props.status === "stale"
      ? "bg-sky-50 border-sky-200 text-sky-900"
      : props.status === "failed"
        ? "bg-rose-50 border-rose-200 text-rose-900"
        : props.status === "pending"
          ? "bg-amber-50 border-amber-200 text-amber-900"
          : "bg-stone-100 border-stone-300 text-stone-800";
  const title =
    props.status === "stale" ? "Validation is stale"
      : props.status === "failed" ? "Validation failed"
      : props.status === "pending" ? "Validation in progress"
      : "Validation state unknown";
  const body =
    props.status === "stale"
      ? "The content was edited after the last validation. Re-run validation before approving — the previous result is preserved below as historical evidence."
      : props.status === "failed"
        ? "The pipeline failed to produce a result. Approval is blocked until a fresh validation succeeds."
        : props.status === "pending"
          ? "Validation is in progress. Approval is blocked until it finishes."
          : "No validation state is available for this candidate. Approval is blocked.";
  return (
    <div role="alert" className={`rounded-lg border p-4 ${palette}`}>
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="min-w-0">
          <div className="text-[11px] uppercase tracking-widest font-medium">{title}</div>
          <div className="mt-1 text-sm leading-relaxed">{body}</div>
        </div>
        {props.status === "stale" && (
          <button
            onClick={props.onRevalidateFixture}
            className={`shrink-0 rounded-md bg-sky-700 text-white px-4 py-2 text-sm font-medium hover:bg-sky-800 ${FOCUS_RING}`}
          >
            Revalidate (fixture)
          </button>
        )}
      </div>
      {props.status === "stale" && (
        <p className="mt-2 text-[11px] text-sky-800">
          <span className="font-semibold uppercase tracking-widest">Fixture outcome:</span>{" "}
          {props.fixture.revalidationDemo.scenarioDescription}
        </p>
      )}
    </div>
  );
}

// ------------------------------------------------------------------
// Queue
// ------------------------------------------------------------------

function QueuePanel(props: {
  fixtures: readonly Fixture[];
  selectedLabel: string;
  onSelect: (label: string) => void;
  reviewStates: Record<string, ReviewState>;
}) {
  return (
    <div className="sticky top-6 rounded-lg bg-white shadow-sm border border-stone-200 overflow-hidden">
      <div className="px-4 py-3 border-b border-stone-200">
        <div className="text-[11px] uppercase tracking-widest text-stone-500">Review queue</div>
        <div className="mt-0.5 font-serif text-lg text-stone-900">{props.fixtures.length} candidates</div>
      </div>
      <ul className="divide-y divide-stone-100" role="list">
        {props.fixtures.map((f) => {
          const state = props.reviewStates[f.label];
          const selected = f.label === props.selectedLabel;
          return (
            <li key={f.label}>
              <button
                onClick={() => props.onSelect(f.label)}
                aria-current={selected ? "page" : undefined}
                aria-label={`Open candidate ${f.label}: ${f.topic}. Current disposition ${state.disposition}.`}
                className={`w-full text-left px-4 py-3 transition-colors ${FOCUS_RING} ${selected ? "bg-[#f5f0e2]" : "hover:bg-stone-50"}`}
              >
                <div className="flex items-baseline justify-between gap-2">
                  <div className="font-mono text-[11px] text-stone-500">{f.label.slice(0, 2).toUpperCase()}</div>
                  <span className={`text-[10px] uppercase tracking-wider rounded px-1.5 py-0.5 ${dispositionBadgeClass(state.disposition)}`}>
                    {state.disposition}
                  </span>
                </div>
                <div className="mt-1 text-sm leading-snug text-stone-800 line-clamp-2">{f.topic}</div>
                <div className="mt-1 text-[11px] text-stone-400">{fmtTime(f.sourceWindow.startSec)}–{fmtTime(f.sourceWindow.endSec)}</div>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ------------------------------------------------------------------
// Question card
// ------------------------------------------------------------------

function QuestionCard(props: {
  fixture: Fixture;
  effectiveDraft: TrainingQuestionDraftLiteV1;
  result: PipelineResult | null;
  status: ValidationStatus;
}) {
  const { fixture, effectiveDraft, result, status } = props;
  const isEdited = effectiveDraft !== fixture.draft;
  const questionLabel = isEdited ? "Reviewer-edited question" : "Model-generated question";
  const explanationLabel = isEdited ? "Reviewer-edited explanation" : "Model explanation";

  const isSingleAnswer =
    effectiveDraft.questionType === "SINGLE_CHOICE" || effectiveDraft.questionType === "TRUE_FALSE";
  const optionsRole = isSingleAnswer ? "radiogroup" : "list";
  const optionItemRole = isSingleAnswer ? "radio" : "listitem";

  return (
    <article className="rounded-lg bg-white shadow-sm border border-stone-200 overflow-hidden" aria-label="Question under review">
      <div className="px-6 py-4 border-b border-stone-200 flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="text-[11px] uppercase tracking-widest text-stone-500">{effectiveDraft.questionType.replace("_", " ").toLowerCase()}</div>
          <h2 className="mt-0.5 font-serif text-xl text-stone-900">{fixture.topic}</h2>
        </div>
        <div role="status" aria-live="polite" aria-label="Validation state">
          <ValidationBadges result={result} status={status} />
        </div>
      </div>
      <div className="px-6 py-6">
        <div className="text-xs uppercase tracking-widest text-stone-400 mb-2">{questionLabel}</div>
        <p className={`text-stone-800 text-[17px] leading-relaxed font-serif ${isEdited ? "border-l-4 border-sky-300 pl-3" : ""}`}>
          {effectiveDraft.questionText}
        </p>
        {isEdited && (
          <details className="mt-3 text-[12px] text-stone-500">
            <summary className="cursor-pointer uppercase tracking-widest text-[10px] text-stone-400">Show model original</summary>
            <p className="mt-2 pl-3 border-l-2 border-stone-200 italic text-stone-500">{fixture.draft.questionText}</p>
          </details>
        )}

        <div className="mt-6 text-xs uppercase tracking-widest text-stone-400 mb-2">Answer choices</div>
        <ol className="space-y-2" role={optionsRole} aria-label="Answer choices">
          {effectiveDraft.options.map((o, i) => (
            <li
              key={i}
              role={optionItemRole}
              aria-checked={isSingleAnswer ? o.isCorrect : undefined}
              aria-label={o.isCorrect ? `${o.text}. Correct answer.` : o.text}
              className={`flex items-start gap-3 rounded-md px-3 py-2.5 border ${
                o.isCorrect ? "bg-emerald-50/60 border-emerald-200" : "bg-stone-50 border-stone-200"
              }`}
            >
              <span aria-hidden className={`mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-medium ${
                o.isCorrect ? "bg-emerald-600 text-white" : "bg-stone-200 text-stone-600"
              }`}>
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

        <div className="mt-6 text-xs uppercase tracking-widest text-stone-400 mb-2">{explanationLabel}</div>
        <p className={`text-stone-700 text-[14px] leading-relaxed italic ${isEdited ? "border-l-4 border-sky-300 pl-3" : ""}`}>
          {effectiveDraft.explanation}
        </p>
        {isEdited && effectiveDraft.explanation !== fixture.draft.explanation && (
          <details className="mt-2 text-[12px] text-stone-500">
            <summary className="cursor-pointer uppercase tracking-widest text-[10px] text-stone-400">Show model original</summary>
            <p className="mt-2 pl-3 border-l-2 border-stone-200 italic text-stone-500">{fixture.draft.explanation}</p>
          </details>
        )}
      </div>
    </article>
  );
}

// ------------------------------------------------------------------
// Validation badges
// ------------------------------------------------------------------

function ValidationBadges({ result, status }: { result: PipelineResult | null; status: ValidationStatus }) {
  const flagLabels: Record<string, string> = {
    FLAG_UNSUPPORTED_ANSWER_WORDS: "Unsupported words",
    SOURCE_ORG_MISMATCH: "Source-org mismatch",
    FLAG_PRESCRIPTIVE_INSERTION: "Prescriptive insertion",
    FLAG_UNSUPPORTED_QUANTITY: "Unsupported quantity",
    FLAG_POTENTIAL_INVENTED_POLICY_TERM: "Potential policy invention",
    FLAG_AMBIGUOUS_CORRECT_ANSWER: "Ambiguous correct answer",
    FLAG_AMBIGUOUS_FACTUAL_CLAIM: "Ambiguous factual claim",
    FLAG_PROPOSAL_DUPLICATE: "Duplicate",
  };
  if (!result) {
    return (
      <span className="text-[11px] uppercase tracking-widest rounded-full border px-2.5 py-1 bg-stone-100 text-stone-700 border-stone-300">
        validation unavailable
      </span>
    );
  }
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <span className={`text-[11px] uppercase tracking-widest rounded-full border px-2.5 py-1 ${verdictBadgeClass(result.verdict)}`}>
        {result.verdict.replace(/_/g, " ").toLowerCase()}
      </span>
      {status === "stale" && (
        <span className="text-[10px] uppercase tracking-widest rounded-full bg-sky-100 text-sky-800 border border-sky-200 px-2 py-0.5">
          stale (pre-edit result)
        </span>
      )}
      {[...new Set(result.flags)].map((f) => (
        <span key={f} className="text-[10px] uppercase tracking-widest rounded-full bg-amber-50 text-amber-800 border border-amber-200 px-2 py-0.5">
          {flagLabels[f] ?? f}
        </span>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------
// Evidence panel
// ------------------------------------------------------------------

function EvidencePanel(props: {
  fixture: Fixture;
  result: PipelineResult | null;
  missing: boolean;
  unavailable: boolean;
}) {
  if (props.missing) {
    return (
      <div className="sticky top-6 rounded-lg bg-white shadow-sm border border-stone-200 p-6 text-sm text-stone-700">
        <div className="text-[11px] uppercase tracking-widest text-stone-500">Source evidence</div>
        <h3 className="mt-0.5 font-serif text-lg text-stone-900">Transcript missing</h3>
        <p className="mt-2 text-stone-600 leading-relaxed">
          Spectre has no authorised transcript window for this candidate. Running the
          transcript resolver against the source video is required before the reviewer
          can see citations.
        </p>
      </div>
    );
  }
  if (props.unavailable) {
    return (
      <div className="sticky top-6 rounded-lg bg-white shadow-sm border border-stone-200 p-6 text-sm text-stone-700">
        <div className="text-[11px] uppercase tracking-widest text-stone-500">Validation</div>
        <h3 className="mt-0.5 font-serif text-lg text-stone-900">Validation unavailable</h3>
        <p className="mt-2 text-stone-600 leading-relaxed">
          The pipeline did not return a result for this candidate. Approval is blocked
          by the guard until a fresh validation succeeds.
        </p>
      </div>
    );
  }

  const citedSegmentIds = new Set(props.fixture.draft.sourceSegmentIds);
  const { fixture, result } = props;
  return (
    <div className="sticky top-6 rounded-lg bg-white shadow-sm border border-stone-200 overflow-hidden">
      <div className="px-4 py-3 border-b border-stone-200 flex items-baseline justify-between gap-2">
        <div>
          <div className="text-[11px] uppercase tracking-widest text-stone-500">Source evidence</div>
          <div className="mt-0.5 font-serif text-lg text-stone-900">Transcript window</div>
        </div>
        <span className="font-mono text-[10px] text-stone-400">
          {fmtTime(fixture.sourceWindow.startSec)}–{fmtTime(fixture.sourceWindow.endSec)}
        </span>
      </div>

      <div className="px-4 py-3 border-b border-stone-200 bg-stone-50">
        <div
          className="aspect-video rounded-md bg-stone-900 flex items-center justify-center text-stone-400 text-xs"
          role="img"
          aria-label={`Video placeholder for ${COURSE_CONTEXT.sourceVideoName}. Playback is disabled in fixture mode.`}
        >
          <div className="text-center px-4">
            <div className="font-serif text-lg text-stone-300 italic">{COURSE_CONTEXT.sourceVideoName}</div>
            <div className="mt-1 text-[11px] uppercase tracking-widest">video not connected in fixture mode</div>
          </div>
        </div>
        <p className="mt-2 text-[11px] text-stone-500 leading-relaxed">
          <span className="font-semibold uppercase tracking-widest">Placeholder notice:</span>{" "}
          Click-to-seek from a cited passage to the video player arrives with the live wire-up slice.
          Fixture mode shows cited passages visually but does not play back the video.
        </p>
      </div>

      <div className="px-4 py-3">
        <div className="text-xs uppercase tracking-widest text-stone-400 mb-2">Authorised passages</div>
        <ul className="space-y-2" role="list">
          {fixture.grounding.passages.map((p) => {
            const cited = citedSegmentIds.has(p.passageId);
            return (
              <li
                key={p.passageId}
                className={`rounded-md p-3 border text-[13px] leading-relaxed ${
                  cited ? "bg-[#f5f0e2] border-[#d9cf9f]" : "bg-white border-stone-200"
                }`}
              >
                <div className="flex items-baseline justify-between gap-2 text-[11px] text-stone-500">
                  <span className="font-mono">seg {p.passageId}</span>
                  <span className="font-mono">{fmtTime(p.sourceStartSec)}–{fmtTime(p.sourceEndSec)}</span>
                </div>
                <div className={`mt-1 ${cited ? "text-stone-900" : "text-stone-600"}`}>{p.text}</div>
                {cited && (
                  <div className="mt-1 text-[10px] uppercase tracking-widest text-[#8a7a2a]">
                    cited by this question
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </div>

      {result && result.errors.length > 0 && (
        <div role="alert" className="px-4 py-3 border-t border-rose-200 bg-rose-50">
          <div className="text-[11px] uppercase tracking-widest text-rose-800">Hard errors ({result.errors.length})</div>
          <ul className="mt-1 space-y-1 text-[12px] text-rose-900">
            {result.errors.map((e, i) => (
              <li key={i}>
                <div className="font-mono text-[10px] text-rose-700">{e.code}</div>
                <div>{e.message}</div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {result && result.flags.length > 0 && (
        <div role="note" className="px-4 py-3 border-t border-amber-200 bg-amber-50/60">
          <div className="text-[11px] uppercase tracking-widest text-amber-800">Unresolved advisories ({new Set(result.flags).size})</div>
          <ul className="mt-1 space-y-1 text-[12px] text-amber-900">
            {[...new Set(result.flags)].map((f, i) => (
              <li key={i} className="font-mono text-[10px]">{f}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------
// Review controls
// ------------------------------------------------------------------

function ReviewControls(props: {
  fixture: Fixture;
  effectiveDraft: TrainingQuestionDraftLiteV1;
  state: ReviewState;
  guard: ReturnType<typeof evaluateApproval>;
  initialEditOpen?: boolean;
  onApprove: () => void;
  onReject: () => void;
  onEditSave: (edited: TrainingQuestionDraftLiteV1) => void;
  onRevalidateFixture: () => void;
}) {
  const { fixture, effectiveDraft, state, guard } = props;
  const [editing, setEditing] = useState(props.initialEditOpen ?? false);
  const [editedText, setEditedText] = useState(effectiveDraft.questionText);
  const [editedExplanation, setEditedExplanation] = useState(effectiveDraft.explanation);

  function commitEdit() {
    props.onEditSave({
      ...fixture.draft,
      questionText: editedText,
      explanation: editedExplanation,
    });
    setEditing(false);
  }

  const approveMessageId = "approve-block-reason";

  return (
    <div className="rounded-lg bg-white shadow-sm border border-stone-200 overflow-hidden">
      <div className="px-6 py-4 border-b border-stone-200 flex items-baseline justify-between gap-2">
        <div>
          <div className="text-[11px] uppercase tracking-widest text-stone-500">Reviewer decision</div>
          <div className="mt-0.5 font-serif text-lg text-stone-900">
            Current:
            <span className={`ml-2 text-xs uppercase tracking-widest rounded-full px-2.5 py-1 ${dispositionBadgeClass(state.disposition)}`}>
              {state.disposition}
            </span>
          </div>
        </div>
      </div>

      {editing && (
        <div className="px-6 py-4 border-b border-stone-200 space-y-3 bg-sky-50/40">
          <div>
            <label htmlFor="edit-question" className="text-[11px] uppercase tracking-widest text-sky-900">Question text</label>
            <textarea
              id="edit-question"
              className={`mt-1 w-full rounded-md border border-sky-200 bg-white px-3 py-2 text-sm font-serif ${FOCUS_RING}`}
              rows={3}
              value={editedText}
              onChange={(e) => setEditedText(e.target.value)}
            />
          </div>
          <div>
            <label htmlFor="edit-explanation" className="text-[11px] uppercase tracking-widest text-sky-900">Explanation</label>
            <textarea
              id="edit-explanation"
              className={`mt-1 w-full rounded-md border border-sky-200 bg-white px-3 py-2 text-sm italic ${FOCUS_RING}`}
              rows={3}
              value={editedExplanation}
              onChange={(e) => setEditedExplanation(e.target.value)}
            />
          </div>
          <div className="flex gap-2">
            <button onClick={commitEdit} className={`rounded-md bg-sky-700 text-white px-4 py-2 text-sm font-medium hover:bg-sky-800 ${FOCUS_RING}`}>
              Save edit
            </button>
            <button onClick={() => setEditing(false)} className={`rounded-md border border-stone-300 bg-white text-stone-700 px-4 py-2 text-sm hover:bg-stone-50 ${FOCUS_RING}`}>
              Cancel
            </button>
          </div>
          <p className="text-[11px] text-stone-500">
            Edits are local only. No database write. No employee assignment. Saving marks the previous validation stale; you must re-run validation (fixture outcome in this slice) before the candidate becomes approvable.
          </p>
        </div>
      )}

      {!guard.allowed && (
        <div id={approveMessageId} role="alert" className="mx-6 mt-4 rounded-md border border-stone-300 bg-stone-50 px-4 py-3 text-[12px] text-stone-800">
          <div className="font-semibold uppercase tracking-widest text-[10px] text-stone-500">Approval blocked</div>
          <p className="mt-1">{guard.message}</p>
          {guard.reasons.length > 1 && (
            <ul className="mt-1 list-disc list-inside text-[11px] text-stone-600">
              {guard.reasons.map((r) => <li key={r} className="font-mono">{r}</li>)}
            </ul>
          )}
        </div>
      )}

      <div className="px-6 py-4 flex gap-2 flex-wrap">
        <button
          onClick={props.onApprove}
          disabled={!guard.allowed}
          aria-disabled={!guard.allowed}
          aria-describedby={!guard.allowed ? approveMessageId : undefined}
          className={`rounded-md px-4 py-2 text-sm font-medium ${FOCUS_RING} ${
            guard.allowed
              ? "bg-emerald-700 text-white hover:bg-emerald-800"
              : "bg-stone-200 text-stone-500 cursor-not-allowed"
          }`}
          title={guard.allowed ? undefined : guard.message}
        >
          Approve
        </button>
        <button onClick={() => setEditing((v) => !v)} className={`rounded-md bg-sky-700 text-white px-4 py-2 text-sm font-medium hover:bg-sky-800 ${FOCUS_RING}`}>
          {editing ? "Close editor" : "Edit question"}
        </button>
        <button onClick={props.onReject} className={`rounded-md bg-stone-700 text-white px-4 py-2 text-sm font-medium hover:bg-stone-800 ${FOCUS_RING}`}>
          Reject
        </button>
        {state.validationStatus === "stale" && (
          <button onClick={props.onRevalidateFixture} className={`rounded-md border border-sky-300 bg-white text-sky-900 px-4 py-2 text-sm font-medium hover:bg-sky-50 ${FOCUS_RING}`}>
            Revalidate (fixture)
          </button>
        )}
        <span className="relative group">
          <button disabled aria-disabled className="rounded-md bg-stone-200 text-stone-500 px-4 py-2 text-sm font-medium cursor-not-allowed"
            title="Regeneration requires a separately authorised generation workflow that does not yet exist.">
            Request regeneration
          </button>
          <span className="pointer-events-none absolute left-0 top-full mt-1 whitespace-nowrap rounded-md bg-stone-900 px-3 py-1.5 text-[11px] text-stone-100 opacity-0 group-hover:opacity-100 transition-opacity z-10">
            Regeneration requires a separate authorised generation workflow (not yet implemented).
          </span>
        </span>
      </div>

      <div className="px-6 py-3 border-t border-stone-200 bg-stone-50 text-[11px] text-stone-500">
        <span className="uppercase tracking-widest">Workflow</span>
        <span className="ml-2 font-medium text-stone-700">Generated → Validation → Manager review → Approved draft</span>
        <span className="mx-2 text-stone-300" aria-hidden>·</span>
        An approved draft remains an unpublished draft. Publication requires a separate authorised step.
      </div>
    </div>
  );
}

// ------------------------------------------------------------------
// Non-happy-path shells
// ------------------------------------------------------------------

function CenteredShell(props: { title: string; body: React.ReactNode; tone?: "neutral" | "warn" | "error" }) {
  const tone = props.tone ?? "neutral";
  const palette =
    tone === "error" ? "border-rose-200 bg-rose-50 text-rose-900"
    : tone === "warn" ? "border-amber-200 bg-amber-50 text-amber-900"
    : "border-stone-200 bg-white text-stone-800";
  return (
    <div className="min-h-screen bg-[#faf8f2]">
      <Header />
      <div className="mx-auto max-w-[1600px] px-6 py-12">
        <div className={`mx-auto max-w-xl rounded-lg border p-8 shadow-sm ${palette}`} role="status">
          <div className="text-[11px] uppercase tracking-widest font-medium">{props.title}</div>
          <div className="mt-2 font-serif text-xl">{props.body}</div>
        </div>
      </div>
    </div>
  );
}

function LoadingShell() {
  return (
    <CenteredShell
      title="Loading review queue"
      body={
        <div>
          <p>Loading candidates…</p>
          <div className="mt-6 space-y-2" aria-hidden>
            <div className="h-3 w-3/4 animate-pulse rounded bg-stone-200" />
            <div className="h-3 w-5/6 animate-pulse rounded bg-stone-200" />
            <div className="h-3 w-2/3 animate-pulse rounded bg-stone-200" />
          </div>
          <p className="mt-4 text-sm text-stone-500 italic">
            The review surface will appear once the queue finishes loading.
          </p>
        </div>
      }
    />
  );
}

function EmptyQueueShell() {
  return (
    <CenteredShell
      title="No candidates to review"
      body={
        <div>
          <p>The review queue is empty.</p>
          <p className="mt-4 text-sm text-stone-500">
            There are no AI-generated training questions waiting for manager review.
            New candidates will appear here once generation runs (separately authorised).
          </p>
        </div>
      }
    />
  );
}

function NoSelectionShell({ onSelect }: { onSelect: (label: string) => void }) {
  return (
    <div className="min-h-screen bg-[#faf8f2]">
      <Header />
      <div className="mx-auto max-w-[1600px] px-6 py-6">
        <div className="lg:grid lg:grid-cols-[280px_minmax(0,1fr)] lg:gap-6">
          <aside aria-label="Review queue">
            <QueuePanel
              fixtures={FIXTURES}
              selectedLabel=""
              onSelect={onSelect}
              reviewStates={Object.fromEntries(FIXTURES.map((f) => [f.label, { disposition: "pending" as const, latestValidation: null, validationStatus: "unknown" as const }]))}
            />
          </aside>
          <main className="mt-6 lg:mt-0">
            <CenteredShell
              title="Select a candidate"
              body={<p>Pick a candidate from the queue on the left to begin review.</p>}
            />
          </main>
        </div>
      </div>
    </div>
  );
}

function FailedFixtureShell() {
  return (
    <CenteredShell
      tone="error"
      title="Fixture load failed"
      body={
        <div>
          <p>Spectre could not load the fixture data for this review session.</p>
          <p className="mt-4 text-sm text-rose-900/80">
            The underlying error has been recorded. Reload the page to retry.
            Approval is disabled by the guard until validation succeeds.
          </p>
        </div>
      }
    />
  );
}

// Re-export for other modules that may want to construct fixture outcomes.
export type { FixtureRevalidationOutcome };
