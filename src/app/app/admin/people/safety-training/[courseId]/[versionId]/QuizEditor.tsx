"use client";

// HR-2C B2 §quiz builder (2026-08-20) — admin-side question editor.
//
// Rendered on the DRAFT-version page (disabled on published /
// retired). Each question is a small self-contained form so the admin
// can save independently; the reorder happens via a client-side
// drag (not implemented here — B2 keeps to add/remove/edit/change
// correct answer; reorder API is available for B5+).
//
// Constraints enforced client-side (as UX guardrails) AND server-side
// (as invariants) via the B1 canonical services (§25). Publish
// readiness comes from `checkPublishReadiness` — never duplicated here.

import { useState } from "react";
import { useRouter } from "next/navigation";

export interface QuizQuestion {
  id: string;
  prompt: string;
  active: boolean;
  options: Array<{ id: string; text: string; isCorrect: boolean }>;
}

interface Props {
  courseId: string;
  versionId: string;
  questions: QuizQuestion[];
  disabled?: boolean;
  categorySuggestions: string[];
  createAction: (courseId: string, versionId: string, formData: FormData) => Promise<void>;
  updateAction: (courseId: string, versionId: string, questionId: string, formData: FormData) => Promise<void>;
  deleteAction: (courseId: string, versionId: string, questionId: string) => Promise<void>;
}

export default function QuizEditor({
  courseId,
  versionId,
  questions,
  disabled,
  createAction,
  updateAction,
  deleteAction,
}: Props) {
  return (
    <div className="space-y-6" data-testid="training-quiz-editor">
      {questions.length === 0 && (
        <p className="text-sm text-stone-500" data-testid="training-quiz-empty">
          No questions yet. Add at least one question so the employee can be tested.
        </p>
      )}
      {questions.map((q, i) => (
        <QuestionCard
          key={q.id}
          courseId={courseId}
          versionId={versionId}
          index={i + 1}
          question={q}
          disabled={disabled}
          updateAction={updateAction}
          deleteAction={deleteAction}
        />
      ))}
      {!disabled && (
        <NewQuestionForm courseId={courseId} versionId={versionId} createAction={createAction} />
      )}
    </div>
  );
}

function QuestionCard({
  courseId,
  versionId,
  index,
  question,
  disabled,
  updateAction,
  deleteAction,
}: {
  courseId: string;
  versionId: string;
  index: number;
  question: QuizQuestion;
  disabled?: boolean;
  updateAction: Props["updateAction"];
  deleteAction: Props["deleteAction"];
}) {
  const [options, setOptions] = useState(question.options);
  const [prompt, setPrompt] = useState(question.prompt);
  const [correctIdx, setCorrectIdx] = useState(() => {
    const idx = question.options.findIndex((o) => o.isCorrect);
    return idx >= 0 ? idx : 0;
  });
  const router = useRouter();

  const action = updateAction.bind(null, courseId, versionId, question.id);
  const del = deleteAction.bind(null, courseId, versionId, question.id);

  function addOption() { setOptions((os) => [...os, { id: "", text: "", isCorrect: false }]); }
  function removeOption(i: number) {
    setOptions((os) => os.filter((_, j) => j !== i));
    if (correctIdx >= options.length - 1) setCorrectIdx(0);
  }
  function updateText(i: number, text: string) {
    setOptions((os) => os.map((o, j) => (j === i ? { ...o, text } : o)));
  }

  return (
    <form action={action} className="rounded-md border border-stone-200 bg-white p-4 space-y-3" data-testid={`training-question-${question.id}`}>
      <div className="flex items-baseline justify-between gap-3">
        <div className="text-[11px] uppercase tracking-[0.18em] text-stone-500">Question {index}</div>
        {!disabled && (
          <form action={del}>
            <button
              type="submit"
              className="text-xs text-red-700 hover:text-red-900 underline underline-offset-4"
              data-testid={`training-question-${question.id}-delete`}
              onClick={(e) => {
                if (!window.confirm("Delete this question?")) e.preventDefault();
              }}
            >
              Delete
            </button>
          </form>
        )}
      </div>
      <textarea
        name="prompt"
        className="input"
        rows={2}
        maxLength={500}
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        disabled={disabled}
        data-testid={`training-question-${question.id}-prompt`}
        placeholder="What should the employee know?"
      />
      <div className="space-y-2">
        {options.map((o, i) => (
          <div key={o.id || `new-${i}`} className="flex items-center gap-2">
            <input
              type="radio"
              name="correctIdx"
              value={i}
              checked={correctIdx === i}
              onChange={() => setCorrectIdx(i)}
              disabled={disabled}
              data-testid={`training-question-${question.id}-correct-${i}`}
              aria-label={`Mark option ${i + 1} correct`}
            />
            <input type="hidden" name="optionId" value={o.id} />
            <input
              type="text"
              name="optionText"
              className="input flex-1"
              value={o.text}
              onChange={(e) => updateText(i, e.target.value)}
              disabled={disabled}
              placeholder={`Option ${i + 1}`}
              data-testid={`training-question-${question.id}-option-${i}`}
              maxLength={300}
            />
            {!disabled && options.length > 2 && (
              <button
                type="button"
                onClick={() => removeOption(i)}
                className="text-xs text-stone-500 hover:text-red-700 px-2"
                data-testid={`training-question-${question.id}-remove-${i}`}
                aria-label={`Remove option ${i + 1}`}
              >
                Remove
              </button>
            )}
          </div>
        ))}
        {!disabled && (
          <button
            type="button"
            onClick={addOption}
            className="text-xs text-emerald-800 hover:text-emerald-900 underline underline-offset-4"
            data-testid={`training-question-${question.id}-add-option`}
          >
            + Add answer
          </button>
        )}
      </div>
      {!disabled && (
        <div className="flex items-center justify-end">
          <button type="submit" className="btn btn-secondary btn-sm" data-testid={`training-question-${question.id}-save`}>
            Save question
          </button>
        </div>
      )}
    </form>
  );
}

function NewQuestionForm({
  courseId,
  versionId,
  createAction,
}: {
  courseId: string;
  versionId: string;
  createAction: Props["createAction"];
}) {
  const [options, setOptions] = useState([
    { text: "", isCorrect: true },
    { text: "", isCorrect: false },
  ]);
  const [correctIdx, setCorrectIdx] = useState(0);
  const action = createAction.bind(null, courseId, versionId);
  function addOption() { setOptions((os) => [...os, { text: "", isCorrect: false }]); }
  function removeOption(i: number) { setOptions((os) => os.filter((_, j) => j !== i)); if (correctIdx >= options.length - 1) setCorrectIdx(0); }
  return (
    <form
      action={(fd) => {
        // Reset local state after submission so the form can be reused.
        setTimeout(() => {
          setOptions([{ text: "", isCorrect: true }, { text: "", isCorrect: false }]);
          setCorrectIdx(0);
        }, 0);
        return action(fd);
      }}
      className="rounded-md border border-dashed border-stone-300 bg-stone-50 p-4 space-y-3"
      data-testid="training-question-new-form"
    >
      <div className="text-[11px] uppercase tracking-[0.18em] text-stone-500">New question</div>
      <textarea
        name="prompt"
        className="input"
        rows={2}
        required
        maxLength={500}
        data-testid="training-question-new-prompt"
        placeholder="Write the question here"
      />
      <div className="space-y-2">
        {options.map((_, i) => (
          <div key={i} className="flex items-center gap-2">
            <input
              type="radio"
              name="correctIdx"
              value={i}
              checked={correctIdx === i}
              onChange={() => setCorrectIdx(i)}
              data-testid={`training-question-new-correct-${i}`}
              aria-label={`Mark option ${i + 1} correct`}
            />
            <input
              type="text"
              name="optionText"
              className="input flex-1"
              required
              maxLength={300}
              placeholder={`Option ${i + 1}`}
              data-testid={`training-question-new-option-${i}`}
            />
            {options.length > 2 && (
              <button
                type="button"
                onClick={() => removeOption(i)}
                className="text-xs text-stone-500 hover:text-red-700 px-2"
                aria-label={`Remove option ${i + 1}`}
              >
                Remove
              </button>
            )}
          </div>
        ))}
        <button
          type="button"
          onClick={addOption}
          className="text-xs text-emerald-800 hover:text-emerald-900 underline underline-offset-4"
          data-testid="training-question-new-add-option"
        >
          + Add answer
        </button>
      </div>
      <div className="flex items-center justify-end">
        <button type="submit" className="btn btn-primary btn-sm" data-testid="training-question-new-submit">
          Add question
        </button>
      </div>
    </form>
  );
}
