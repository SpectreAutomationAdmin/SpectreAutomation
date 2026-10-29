"use client";

// HR-2C B2 §quiz builder (2026-08-20) + EP-TRAIN-3 Slice 2 (2026-10-29)
// -- admin-side question editor.
//
// Shared editor used in two authoring surfaces:
//   - the FINAL ASSESSMENT section (checkpointId=null)
//   - per-checkpoint knowledge checks (checkpointId=<cp-id>)
//
// Supports three question types:
//   SINGLE_CHOICE  radio UI, exactly one correct option
//   MULTI_ANSWER   checkbox UI, >=1 correct and >=1 incorrect
//   TRUE_FALSE     two options forced to "True" / "False", one correct

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";

export type TrainingQuestionType = "SINGLE_CHOICE" | "MULTI_ANSWER" | "TRUE_FALSE";

export interface QuizQuestion {
  id: string;
  prompt: string;
  active: boolean;
  questionType: TrainingQuestionType;
  options: Array<{ id: string; text: string; isCorrect: boolean }>;
}

interface Props {
  courseId: string;
  versionId: string;
  /** Omitted / null => final-assessment questions. Non-null => bound to this checkpoint. */
  checkpointId?: string | null;
  questions: QuizQuestion[];
  disabled?: boolean;
  categorySuggestions: string[];
  createAction: (courseId: string, versionId: string, formData: FormData) => Promise<void>;
  updateAction: (courseId: string, versionId: string, questionId: string, formData: FormData) => Promise<void>;
  deleteAction: (courseId: string, versionId: string, questionId: string) => Promise<void>;
  /** Human label shown in the empty state ("final assessment" vs "checkpoint"). */
  surfaceLabel?: string;
}

export default function QuizEditor({
  courseId,
  versionId,
  checkpointId,
  questions,
  disabled,
  createAction,
  updateAction,
  deleteAction,
  surfaceLabel,
}: Props) {
  return (
    <div className="space-y-6" data-testid={`training-quiz-editor${checkpointId ? `-cp-${checkpointId}` : ""}`}>
      {questions.length === 0 && (
        <p className="text-sm text-stone-500" data-testid="training-quiz-empty">
          No questions yet. Add at least one so the {surfaceLabel ?? "assessment"} can test knowledge.
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
        <NewQuestionForm
          courseId={courseId}
          versionId={versionId}
          checkpointId={checkpointId ?? null}
          createAction={createAction}
        />
      )}
    </div>
  );
}

const QUESTION_TYPE_LABELS: Record<TrainingQuestionType, string> = {
  SINGLE_CHOICE: "Single answer",
  MULTI_ANSWER: "Multiple answers",
  TRUE_FALSE: "True / False",
};

function initialOptionsForType(type: TrainingQuestionType) {
  if (type === "TRUE_FALSE") {
    return [
      { text: "True", isCorrect: true },
      { text: "False", isCorrect: false },
    ];
  }
  return [
    { text: "", isCorrect: true },
    { text: "", isCorrect: false },
  ];
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
  const [questionType, setQuestionType] = useState<TrainingQuestionType>(question.questionType);
  const correctIndices = useMemo(
    () => options.map((o, i) => (o.isCorrect ? i : -1)).filter((i) => i >= 0),
    [options],
  );
  const [singleCorrect, setSingleCorrect] = useState<number>(correctIndices[0] ?? 0);
  const [multiCorrect, setMultiCorrect] = useState<Set<number>>(() => new Set(correctIndices));
  const router = useRouter();

  const action = updateAction.bind(null, courseId, versionId, question.id);
  const del = deleteAction.bind(null, courseId, versionId, question.id);

  function switchType(next: TrainingQuestionType) {
    setQuestionType(next);
    if (next === "TRUE_FALSE") {
      setOptions([
        { id: options[0]?.id ?? "", text: "True", isCorrect: true },
        { id: options[1]?.id ?? "", text: "False", isCorrect: false },
      ]);
      setSingleCorrect(0);
      setMultiCorrect(new Set([0]));
    } else if (next === "SINGLE_CHOICE") {
      setSingleCorrect(0);
    }
  }

  function addOption() {
    if (questionType === "TRUE_FALSE") return;
    setOptions((os) => [...os, { id: "", text: "", isCorrect: false }]);
  }
  function removeOption(i: number) {
    if (questionType === "TRUE_FALSE") return;
    setOptions((os) => os.filter((_, j) => j !== i));
    if (questionType === "SINGLE_CHOICE" && singleCorrect >= options.length - 1) setSingleCorrect(0);
    if (questionType === "MULTI_ANSWER") {
      const next = new Set<number>();
      [...multiCorrect].filter((x) => x !== i).forEach((x) => next.add(x > i ? x - 1 : x));
      setMultiCorrect(next);
    }
  }
  function updateText(i: number, text: string) {
    setOptions((os) => os.map((o, j) => (j === i ? { ...o, text } : o)));
  }
  function toggleMultiCorrect(i: number) {
    setMultiCorrect((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i); else next.add(i);
      return next;
    });
  }

  const correctAttr = questionType === "MULTI_ANSWER"
    ? Array.from(multiCorrect).sort((a, b) => a - b).join(",")
    : String(singleCorrect);

  return (
    <form action={action} className="rounded-md border border-stone-200 bg-white p-4 space-y-3" data-testid={`training-question-${question.id}`}>
      <input type="hidden" name="questionType" value={questionType} />
      {questionType === "MULTI_ANSWER" && (
        <input type="hidden" name="correctIdxs" value={correctAttr} />
      )}
      {questionType !== "MULTI_ANSWER" && (
        <input type="hidden" name="correctIdx" value={correctAttr} />
      )}
      <div className="flex items-baseline justify-between gap-3">
        <div className="flex items-baseline gap-3">
          <div className="text-[11px] uppercase tracking-[0.18em] text-stone-500">Question {index}</div>
          <select
            value={questionType}
            onChange={(e) => switchType(e.target.value as TrainingQuestionType)}
            disabled={disabled}
            className="input text-xs py-1 w-auto"
            data-testid={`training-question-${question.id}-type`}
            aria-label="Question type"
          >
            {Object.entries(QUESTION_TYPE_LABELS).map(([v, l]) => (
              <option key={v} value={v}>{l}</option>
            ))}
          </select>
        </div>
        {!disabled && (
          <button
            type="button"
            formAction={del}
            className="text-xs text-red-700 hover:text-red-900 underline underline-offset-4"
            data-testid={`training-question-${question.id}-delete`}
            onClick={(e) => {
              if (!window.confirm("Delete this question?")) e.preventDefault();
            }}
          >
            Delete
          </button>
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
            {questionType === "MULTI_ANSWER" ? (
              <input
                type="checkbox"
                checked={multiCorrect.has(i)}
                onChange={() => toggleMultiCorrect(i)}
                disabled={disabled}
                data-testid={`training-question-${question.id}-correct-${i}`}
                aria-label={`Mark option ${i + 1} correct`}
              />
            ) : (
              <input
                type="radio"
                name={`correctIdxUI-${question.id}`}
                checked={singleCorrect === i}
                onChange={() => setSingleCorrect(i)}
                disabled={disabled}
                data-testid={`training-question-${question.id}-correct-${i}`}
                aria-label={`Mark option ${i + 1} correct`}
              />
            )}
            <input type="hidden" name="optionId" value={o.id} />
            <input
              type="text"
              name="optionText"
              className="input flex-1"
              value={o.text}
              onChange={(e) => updateText(i, e.target.value)}
              disabled={disabled || questionType === "TRUE_FALSE"}
              placeholder={`Option ${i + 1}`}
              data-testid={`training-question-${question.id}-option-${i}`}
              maxLength={300}
            />
            {!disabled && questionType !== "TRUE_FALSE" && options.length > 2 && (
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
        {!disabled && questionType !== "TRUE_FALSE" && (
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
  checkpointId,
  createAction,
}: {
  courseId: string;
  versionId: string;
  checkpointId: string | null;
  createAction: Props["createAction"];
}) {
  const [questionType, setQuestionType] = useState<TrainingQuestionType>("SINGLE_CHOICE");
  const [options, setOptions] = useState(initialOptionsForType("SINGLE_CHOICE"));
  const [singleCorrect, setSingleCorrect] = useState(0);
  const [multiCorrect, setMultiCorrect] = useState<Set<number>>(new Set([0]));
  const action = createAction.bind(null, courseId, versionId);

  function switchType(next: TrainingQuestionType) {
    setQuestionType(next);
    setOptions(initialOptionsForType(next));
    setSingleCorrect(0);
    setMultiCorrect(new Set([0]));
  }
  function addOption() {
    if (questionType === "TRUE_FALSE") return;
    setOptions((os) => [...os, { text: "", isCorrect: false }]);
  }
  function removeOption(i: number) {
    if (questionType === "TRUE_FALSE") return;
    setOptions((os) => os.filter((_, j) => j !== i));
    if (singleCorrect >= options.length - 1) setSingleCorrect(0);
  }
  function toggleMultiCorrect(i: number) {
    setMultiCorrect((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i); else next.add(i);
      return next;
    });
  }

  const correctAttr = questionType === "MULTI_ANSWER"
    ? Array.from(multiCorrect).sort((a, b) => a - b).join(",")
    : String(singleCorrect);

  return (
    <form
      action={(fd) => {
        setTimeout(() => {
          setOptions(initialOptionsForType(questionType));
          setSingleCorrect(0);
          setMultiCorrect(new Set([0]));
        }, 0);
        return action(fd);
      }}
      className="rounded-md border border-dashed border-stone-300 bg-stone-50 p-4 space-y-3"
      data-testid={`training-question-new-form${checkpointId ? `-cp-${checkpointId}` : ""}`}
    >
      <input type="hidden" name="questionType" value={questionType} />
      {checkpointId && <input type="hidden" name="checkpointId" value={checkpointId} />}
      {questionType === "MULTI_ANSWER" && (
        <input type="hidden" name="correctIdxs" value={correctAttr} />
      )}
      {questionType !== "MULTI_ANSWER" && (
        <input type="hidden" name="correctIdx" value={correctAttr} />
      )}
      <div className="flex items-baseline justify-between gap-3">
        <div className="text-[11px] uppercase tracking-[0.18em] text-stone-500">New question</div>
        <select
          value={questionType}
          onChange={(e) => switchType(e.target.value as TrainingQuestionType)}
          className="input text-xs py-1 w-auto"
          data-testid="training-question-new-type"
          aria-label="Question type"
        >
          {Object.entries(QUESTION_TYPE_LABELS).map(([v, l]) => (
            <option key={v} value={v}>{l}</option>
          ))}
        </select>
      </div>
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
        {options.map((o, i) => (
          <div key={i} className="flex items-center gap-2">
            {questionType === "MULTI_ANSWER" ? (
              <input
                type="checkbox"
                checked={multiCorrect.has(i)}
                onChange={() => toggleMultiCorrect(i)}
                data-testid={`training-question-new-correct-${i}`}
                aria-label={`Mark option ${i + 1} correct`}
              />
            ) : (
              <input
                type="radio"
                name="correctIdxUI-new"
                checked={singleCorrect === i}
                onChange={() => setSingleCorrect(i)}
                data-testid={`training-question-new-correct-${i}`}
                aria-label={`Mark option ${i + 1} correct`}
              />
            )}
            <input
              type="text"
              name="optionText"
              className="input flex-1"
              required
              maxLength={300}
              placeholder={`Option ${i + 1}`}
              data-testid={`training-question-new-option-${i}`}
              defaultValue={questionType === "TRUE_FALSE" ? o.text : undefined}
              readOnly={questionType === "TRUE_FALSE"}
            />
            {questionType !== "TRUE_FALSE" && options.length > 2 && (
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
        {questionType !== "TRUE_FALSE" && (
          <button
            type="button"
            onClick={addOption}
            className="text-xs text-emerald-800 hover:text-emerald-900 underline underline-offset-4"
            data-testid="training-question-new-add-option"
          >
            + Add answer
          </button>
        )}
      </div>
      <div className="flex items-center justify-end">
        <button type="submit" className="btn btn-primary btn-sm" data-testid="training-question-new-submit">
          Add question
        </button>
      </div>
    </form>
  );
}
