"use client";

// EP-TRAIN-6D-1 — manager review workspace.
//
// Fixture-driven. No live inference. No DB writes. No cross-tenant
// exposure. All review actions (approve / edit / reject) operate on
// LOCAL REACT STATE ONLY. The "Request regeneration" control is
// disabled with a tooltip because a separately authorised generation
// workflow does not yet exist (per directive §B2).
//
// Visual language: deep green / ivory / muted gold Spectre palette,
// serif display headings, intentional whitespace — not a chatbot.

import { useMemo, useState } from "react";
import {
  validateTrainingQuestion,
  type PipelineResult,
  type TrainingQuestionDraftLiteV1,
} from "@/lib/training/ai-generation";
import { FIXTURES, COURSE_CONTEXT, type Fixture } from "./fixtures";

type ReviewDisposition = "pending" | "approved" | "edited" | "rejected";

interface ReviewState {
  readonly disposition: ReviewDisposition;
  readonly editedDraft?: TrainingQuestionDraftLiteV1;
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

export interface ReviewWorkspaceProps {
  /** Optional initial selection + review states — used by the static-preview
   * render script to pre-populate deterministic screenshots. In normal
   * runtime this prop is omitted and the hooks fall back to "Q1 pending". */
  readonly initial?: {
    readonly selectedLabel?: string;
    readonly reviewStates?: Readonly<Record<string, ReviewState>>;
    readonly editOpen?: boolean;
  };
}

export default function ReviewWorkspace({ initial }: ReviewWorkspaceProps = {}) {
  const [selectedLabel, setSelectedLabel] = useState<string>(
    initial?.selectedLabel ?? FIXTURES[0].label,
  );
  const [reviewStates, setReviewStates] = useState<Record<string, ReviewState>>(() => {
    const init: Record<string, ReviewState> = {};
    for (const f of FIXTURES) init[f.label] = { disposition: "pending" };
    if (initial?.reviewStates) {
      for (const [k, v] of Object.entries(initial.reviewStates)) {
        init[k] = v;
      }
    }
    return init;
  });

  const selected = FIXTURES.find((f) => f.label === selectedLabel) ?? FIXTURES[0];
  const reviewState = reviewStates[selected.label];
  const effectiveDraft = reviewState.editedDraft ?? selected.draft;

  const result: PipelineResult = useMemo(
    () => validateTrainingQuestion({
      draft: effectiveDraft,
      grounding: selected.grounding,
      authorization: selected.authorization,
    }),
    [effectiveDraft, selected.grounding, selected.authorization],
  );

  function setDisposition(label: string, next: ReviewState) {
    setReviewStates((prev) => ({ ...prev, [label]: { ...prev[label], ...next } }));
  }

  return (
    <div className="min-h-screen bg-[#faf8f2]">
      {/* Top bar — course context */}
      <header className="border-b border-stone-200 bg-white/70 backdrop-blur-sm">
        <div className="mx-auto max-w-[1600px] px-6 py-5">
          <div className="flex items-start justify-between gap-6 flex-wrap">
            <div>
              <div className="text-[11px] uppercase tracking-[0.18em] text-stone-500">AI-assisted training · manager review</div>
              <h1 className="mt-1 font-serif text-2xl leading-tight text-stone-900">
                {COURSE_CONTEXT.title}
              </h1>
              <div className="mt-1 text-sm text-stone-600">
                {COURSE_CONTEXT.clubName} <span className="mx-2 text-stone-300">·</span>
                <span className="italic">{COURSE_CONTEXT.tenantLabel}</span>
              </div>
            </div>
            <div className="text-right text-[11px] uppercase tracking-widest text-stone-500">
              <div>Fixture mode</div>
              <div className="mt-0.5 font-mono text-[10px] normal-case tracking-normal text-stone-400">
                build {COURSE_CONTEXT.resolvedTranscriptBuildId.slice(0, 12)}…
              </div>
            </div>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-[1600px] px-6 py-6">
        <div className="lg:grid lg:grid-cols-[280px_minmax(0,1fr)_380px] lg:gap-6">
          {/* Queue */}
          <aside className="hidden lg:block">
            <QueuePanel
              fixtures={FIXTURES}
              selectedLabel={selectedLabel}
              onSelect={setSelectedLabel}
              reviewStates={reviewStates}
            />
          </aside>

          {/* Question + review controls */}
          <main className="mt-6 lg:mt-0 space-y-6">
            {/* Mobile-only compact fixture selector */}
            <div className="lg:hidden">
              <select
                value={selectedLabel}
                onChange={(e) => setSelectedLabel(e.target.value)}
                className="w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-sm"
              >
                {FIXTURES.map((f) => (
                  <option key={f.label} value={f.label}>{f.label} — {f.topic.slice(0, 40)}</option>
                ))}
              </select>
            </div>

            <QuestionCard
              fixture={selected}
              effectiveDraft={effectiveDraft}
              result={result}
              disposition={reviewState.disposition}
            />

            {/* Mobile-only source evidence directly after the card */}
            <div className="lg:hidden">
              <EvidencePanel fixture={selected} result={result} />
            </div>

            <ReviewControls
              fixture={selected}
              result={result}
              state={reviewState}
              initialEditOpen={initial?.editOpen ?? false}
              onChange={(next) => setDisposition(selected.label, next)}
            />
          </main>

          {/* Evidence sidebar (desktop) */}
          <aside className="hidden lg:block">
            <EvidencePanel fixture={selected} result={result} />
          </aside>
        </div>
      </div>
    </div>
  );
}

// ---------------- Queue ----------------

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
        <div className="mt-0.5 font-serif text-lg text-stone-900">8 candidates</div>
      </div>
      <ul className="divide-y divide-stone-100">
        {props.fixtures.map((f) => {
          const state = props.reviewStates[f.label];
          const selected = f.label === props.selectedLabel;
          return (
            <li key={f.label}>
              <button
                onClick={() => props.onSelect(f.label)}
                className={`w-full text-left px-4 py-3 transition-colors ${
                  selected ? "bg-[#f5f0e2]" : "hover:bg-stone-50"
                }`}
              >
                <div className="flex items-baseline justify-between gap-2">
                  <div className="font-mono text-[11px] text-stone-500">
                    {f.label.slice(0, 2).toUpperCase()}
                  </div>
                  <span className={`text-[10px] uppercase tracking-wider rounded px-1.5 py-0.5 ${dispositionBadgeClass(state.disposition)}`}>
                    {state.disposition}
                  </span>
                </div>
                <div className="mt-1 text-sm leading-snug text-stone-800 line-clamp-2">
                  {f.topic}
                </div>
                <div className="mt-1 text-[11px] text-stone-400">
                  {fmtTime(f.sourceWindow.startSec)}–{fmtTime(f.sourceWindow.endSec)}
                </div>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ---------------- Question card ----------------

function QuestionCard(props: {
  fixture: Fixture;
  effectiveDraft: TrainingQuestionDraftLiteV1;
  result: PipelineResult;
  disposition: ReviewDisposition;
}) {
  const { fixture, effectiveDraft, result } = props;
  const isEdited = effectiveDraft !== fixture.draft;
  const questionLabel = isEdited ? "Reviewer-edited question" : "Model-generated question";
  const explanationLabel = isEdited ? "Reviewer-edited explanation" : "Model explanation";
  return (
    <article className="rounded-lg bg-white shadow-sm border border-stone-200 overflow-hidden">
      <div className="px-6 py-4 border-b border-stone-200 flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="text-[11px] uppercase tracking-widest text-stone-500">{effectiveDraft.questionType.replace("_", " ").toLowerCase()}</div>
          <h2 className="mt-0.5 font-serif text-xl text-stone-900">{fixture.topic}</h2>
        </div>
        <ValidationBadges result={result} />
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
        <ol className="space-y-2">
          {effectiveDraft.options.map((o, i) => (
            <li key={i}
              className={`flex items-start gap-3 rounded-md px-3 py-2.5 border ${
                o.isCorrect ? "bg-emerald-50/60 border-emerald-200" : "bg-stone-50 border-stone-200"
              }`}>
              <span className={`mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-medium ${
                o.isCorrect ? "bg-emerald-600 text-white" : "bg-stone-200 text-stone-600"
              }`}>
                {String.fromCharCode(65 + i)}
              </span>
              <span className="text-stone-800 text-[15px] leading-relaxed">{o.text}</span>
              {o.isCorrect && <span className="ml-auto text-[10px] uppercase tracking-widest text-emerald-700 mt-1">Correct</span>}
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

// ---------------- Validation badges ----------------

function ValidationBadges({ result }: { result: PipelineResult }) {
  // Forward-compatible label map: keys are raw validator flag codes (string
  // literals) so this UI continues to work even when the underlying
  // VALIDATOR_FLAGS object gains new entries in later slices (e.g.
  // FLAG_PRESCRIPTIVE_INSERTION from EP-TRAIN-6C-10C on its own branch).
  // Unknown flag codes fall through to the raw code via `?? f`.
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
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <span className={`text-[11px] uppercase tracking-widest rounded-full border px-2.5 py-1 ${verdictBadgeClass(result.verdict)}`}>
        {result.verdict.replace(/_/g, " ").toLowerCase()}
      </span>
      {[...new Set(result.flags)].map((f) => (
        <span key={f} className="text-[10px] uppercase tracking-widest rounded-full bg-amber-50 text-amber-800 border border-amber-200 px-2 py-0.5">
          {flagLabels[f] ?? f}
        </span>
      ))}
    </div>
  );
}

// ---------------- Evidence panel ----------------

function EvidencePanel({ fixture, result }: { fixture: Fixture; result: PipelineResult }) {
  const citedSegmentIds = new Set(fixture.draft.sourceSegmentIds);
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

      {/* Video preview placeholder — shows duration + video filename to ground the manager */}
      <div className="px-4 py-3 border-b border-stone-200 bg-stone-50">
        <div className="aspect-video rounded-md bg-stone-900 flex items-center justify-center text-stone-400 text-xs">
          <div className="text-center">
            <div className="font-serif text-lg text-stone-300 italic">{COURSE_CONTEXT.sourceVideoName}</div>
            <div className="mt-1 text-[11px] uppercase tracking-widest">preview disabled in fixture mode</div>
          </div>
        </div>
      </div>

      <div className="px-4 py-3">
        <div className="text-xs uppercase tracking-widest text-stone-400 mb-2">Authorised passages</div>
        <ul className="space-y-2">
          {fixture.grounding.passages.map((p) => {
            const cited = citedSegmentIds.has(p.passageId);
            return (
              <li key={p.passageId}
                className={`rounded-md p-3 border text-[13px] leading-relaxed ${
                  cited ? "bg-[#f5f0e2] border-[#d9cf9f]" : "bg-white border-stone-200"
                }`}>
                <div className="flex items-baseline justify-between gap-2 text-[11px] text-stone-500">
                  <span className="font-mono">seg {p.passageId}</span>
                  <span className="font-mono">{fmtTime(p.sourceStartSec)}–{fmtTime(p.sourceEndSec)}</span>
                </div>
                <div className={`mt-1 ${cited ? "text-stone-900" : "text-stone-600"}`}>{p.text}</div>
                {cited && <div className="mt-1 text-[10px] uppercase tracking-widest text-[#8a7a2a]">cited by this question</div>}
              </li>
            );
          })}
        </ul>
      </div>

      {result.errors.length > 0 && (
        <div className="px-4 py-3 border-t border-rose-200 bg-rose-50">
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

      {result.flags.length > 0 && (
        <div className="px-4 py-3 border-t border-amber-200 bg-amber-50/60">
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

// ---------------- Review controls ----------------

function ReviewControls(props: {
  fixture: Fixture;
  result: PipelineResult;
  state: ReviewState;
  initialEditOpen?: boolean;
  onChange: (next: ReviewState) => void;
}) {
  const { fixture, state, onChange } = props;
  const [editing, setEditing] = useState(props.initialEditOpen ?? false);
  const [editedText, setEditedText] = useState(state.editedDraft?.questionText ?? fixture.draft.questionText);
  const [editedExplanation, setEditedExplanation] = useState(state.editedDraft?.explanation ?? fixture.draft.explanation);

  function commitEdit() {
    onChange({
      disposition: "edited",
      editedDraft: {
        ...fixture.draft,
        questionText: editedText,
        explanation: editedExplanation,
      },
    });
    setEditing(false);
  }

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
            <label className="text-[11px] uppercase tracking-widest text-sky-900">Question text</label>
            <textarea className="mt-1 w-full rounded-md border border-sky-200 bg-white px-3 py-2 text-sm font-serif" rows={3}
              value={editedText} onChange={(e) => setEditedText(e.target.value)} />
          </div>
          <div>
            <label className="text-[11px] uppercase tracking-widest text-sky-900">Explanation</label>
            <textarea className="mt-1 w-full rounded-md border border-sky-200 bg-white px-3 py-2 text-sm italic" rows={3}
              value={editedExplanation} onChange={(e) => setEditedExplanation(e.target.value)} />
          </div>
          <div className="flex gap-2">
            <button onClick={commitEdit} className="rounded-md bg-sky-700 text-white px-4 py-2 text-sm font-medium hover:bg-sky-800">
              Save edit
            </button>
            <button onClick={() => setEditing(false)} className="rounded-md border border-stone-300 bg-white text-stone-700 px-4 py-2 text-sm hover:bg-stone-50">
              Cancel
            </button>
          </div>
          <p className="text-[11px] text-stone-500">
            Edits are local only. No database write. No employee assignment.
          </p>
        </div>
      )}

      <div className="px-6 py-4 flex gap-2 flex-wrap">
        <button
          onClick={() => onChange({ disposition: "approved" })}
          className="rounded-md bg-emerald-700 text-white px-4 py-2 text-sm font-medium hover:bg-emerald-800"
        >
          Approve
        </button>
        <button
          onClick={() => setEditing((v) => !v)}
          className="rounded-md bg-sky-700 text-white px-4 py-2 text-sm font-medium hover:bg-sky-800"
        >
          {editing ? "Close editor" : "Edit question"}
        </button>
        <button
          onClick={() => onChange({ disposition: "rejected" })}
          className="rounded-md bg-stone-700 text-white px-4 py-2 text-sm font-medium hover:bg-stone-800"
        >
          Reject
        </button>
        <span className="relative group">
          <button
            disabled
            className="rounded-md bg-stone-200 text-stone-500 px-4 py-2 text-sm font-medium cursor-not-allowed"
            title="Regeneration requires a separately authorised generation workflow that does not yet exist."
            aria-disabled
          >
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
        <span className="mx-2 text-stone-300">·</span>
        An approved draft remains an unpublished draft. Publication requires a separate authorised step.
      </div>
    </div>
  );
}
