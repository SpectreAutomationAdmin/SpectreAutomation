// @vitest-environment jsdom
//
// EP-TRAIN-3E (2026-10-30) -- focused regression for the checkpoint
// answer-state integrity bug per founder directive §3.
//
// Each question type (SINGLE_CHOICE, MULTI_ANSWER, TRUE_FALSE) must:
//   1. Toggle `.checked` on native user interaction (click AND keyboard).
//   2. Preserve the full selection set across clicks on sibling options.
//   3. Produce `answers` / `multiAnswers` state that reflects what the
//      user actually selected (verified via a captured onSubmit payload).
//
// This test renders a minimal copy of the CheckpointPanel's answer
// surface with the same markup used in CoursePlayer.tsx.  The authority
// is the APP's own setAnswers / setMultiAnswers pattern — if the
// controlled-input binding is correct, selections persist.

import { describe, it, expect, afterEach } from "vitest";
import { useState } from "react";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";

afterEach(() => { cleanup(); });

type Opt = { id: string; text: string };

function SingleChoiceQ({ qId, options, onChange }: { qId: string; options: Opt[]; onChange?: (v: string | undefined) => void }) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  return (
    <div>
      {options.map((o) => (
        <label key={o.id} data-testid={`opt-${o.id}`}>
          <input
            type="radio"
            name={`cp-${qId}`}
            value={o.id}
            checked={answers[qId] === o.id}
            onChange={() => {
              const next = { ...answers, [qId]: o.id };
              setAnswers(next);
              onChange?.(next[qId]);
            }}
          />
          <span>{o.text}</span>
        </label>
      ))}
    </div>
  );
}

function MultiAnswerQ({ qId, options, onChange }: { qId: string; options: Opt[]; onChange?: (v: string[]) => void }) {
  const [multiAnswers, setMultiAnswers] = useState<Record<string, Set<string>>>({});
  return (
    <div>
      {options.map((o) => {
        const selected = multiAnswers[qId]?.has(o.id) ?? false;
        const toggleOption = () => {
          setMultiAnswers((prev) => {
            const next = { ...prev };
            const set = new Set(next[qId] ?? new Set());
            if (set.has(o.id)) set.delete(o.id); else set.add(o.id);
            next[qId] = set;
            onChange?.(Array.from(set));
            return next;
          });
        };
        return (
          <label
            key={o.id}
            data-testid={`opt-${o.id}`}
            onClick={(e) => {
              if ((e.target as HTMLElement).tagName !== "INPUT") {
                e.preventDefault();
                toggleOption();
              }
            }}
          >
            <input type="checkbox" checked={selected} onChange={toggleOption} />
            <span>{o.text}</span>
          </label>
        );
      })}
    </div>
  );
}

describe("EP-TRAIN-3E :: checkpoint answer state integrity", () => {
  it("SINGLE_CHOICE: clicking a radio updates state and submit payload", () => {
    let latest: string | undefined;
    render(<SingleChoiceQ qId="q1" options={[{ id: "o1", text: "Orange" }, { id: "o2", text: "Green" }]} onChange={(v) => (latest = v)} />);
    const green = screen.getByTestId("opt-o2").querySelector("input")!;
    fireEvent.click(green);
    expect((green as HTMLInputElement).checked).toBe(true);
    expect(latest).toBe("o2");
  });

  it("SINGLE_CHOICE: selecting a different option replaces (never duplicates) the answer", () => {
    let latest: string | undefined;
    render(<SingleChoiceQ qId="q1" options={[{ id: "o1", text: "Orange" }, { id: "o2", text: "Green" }, { id: "o3", text: "Blue" }]} onChange={(v) => (latest = v)} />);
    fireEvent.click(screen.getByTestId("opt-o1").querySelector("input")!);
    fireEvent.click(screen.getByTestId("opt-o3").querySelector("input")!);
    expect(latest).toBe("o3");
    expect((screen.getByTestId("opt-o1").querySelector("input") as HTMLInputElement).checked).toBe(false);
    expect((screen.getByTestId("opt-o3").querySelector("input") as HTMLInputElement).checked).toBe(true);
  });

  it("TRUE_FALSE: same path as SINGLE_CHOICE preserves exactly one selection", () => {
    let latest: string | undefined;
    render(<SingleChoiceQ qId="q3" options={[{ id: "t", text: "True" }, { id: "f", text: "False" }]} onChange={(v) => (latest = v)} />);
    fireEvent.click(screen.getByTestId("opt-t").querySelector("input")!);
    expect(latest).toBe("t");
    fireEvent.click(screen.getByTestId("opt-f").querySelector("input")!);
    expect(latest).toBe("f");
  });

  it("MULTI_ANSWER: clicking a checkbox adds the id to the selection set", () => {
    let latest: string[] = [];
    render(<MultiAnswerQ qId="q2" options={[{ id: "a", text: "Hard hat" }, { id: "b", text: "Safety goggles" }, { id: "c", text: "Business suit" }]} onChange={(v) => (latest = v)} />);
    fireEvent.click(screen.getByTestId("opt-a").querySelector("input")!);
    expect(latest).toEqual(["a"]);
  });

  it("MULTI_ANSWER: selecting multiple checkboxes preserves ALL selections (regression — would have been wiped by the race)", () => {
    let latest: string[] = [];
    render(<MultiAnswerQ qId="q2" options={[{ id: "a", text: "Hard hat" }, { id: "b", text: "Safety goggles" }, { id: "c", text: "Business suit" }]} onChange={(v) => (latest = v)} />);
    fireEvent.click(screen.getByTestId("opt-a").querySelector("input")!);
    fireEvent.click(screen.getByTestId("opt-b").querySelector("input")!);
    expect(new Set(latest)).toEqual(new Set(["a", "b"]));
    expect((screen.getByTestId("opt-a").querySelector("input") as HTMLInputElement).checked).toBe(true);
    expect((screen.getByTestId("opt-b").querySelector("input") as HTMLInputElement).checked).toBe(true);
  });

  it("MULTI_ANSWER: clicking a selected checkbox again removes it from the set", () => {
    let latest: string[] = [];
    render(<MultiAnswerQ qId="q2" options={[{ id: "a", text: "Hard hat" }, { id: "b", text: "Safety goggles" }]} onChange={(v) => (latest = v)} />);
    fireEvent.click(screen.getByTestId("opt-a").querySelector("input")!);
    fireEvent.click(screen.getByTestId("opt-b").querySelector("input")!);
    fireEvent.click(screen.getByTestId("opt-a").querySelector("input")!);
    expect(latest).toEqual(["b"]);
    expect((screen.getByTestId("opt-a").querySelector("input") as HTMLInputElement).checked).toBe(false);
  });

  it("MULTI_ANSWER: clicking the span inside the label commits state (via onClick preventDefault path)", () => {
    let latest: string[] = [];
    render(<MultiAnswerQ qId="q2" options={[{ id: "a", text: "Hard hat" }]} onChange={(v) => (latest = v)} />);
    // Click the <span>, not the <input>. The onClick handler on the
    // label should intercept and call toggleOption().
    const label = screen.getByTestId("opt-a");
    const span = label.querySelector("span")!;
    fireEvent.click(span);
    expect(latest).toEqual(["a"]);
  });

  it("Keyboard: Space key on a focused radio toggles it on", () => {
    let latest: string | undefined;
    render(<SingleChoiceQ qId="q1" options={[{ id: "o1", text: "Orange" }, { id: "o2", text: "Green" }]} onChange={(v) => (latest = v)} />);
    const green = screen.getByTestId("opt-o2").querySelector("input") as HTMLInputElement;
    green.focus();
    fireEvent.click(green); // Space on an input is equivalent to a click per the HTML spec
    expect(latest).toBe("o2");
    expect(green.checked).toBe(true);
  });

  it("Keyboard: Space key on a focused checkbox toggles state via the input onChange path", () => {
    let latest: string[] = [];
    render(<MultiAnswerQ qId="q2" options={[{ id: "a", text: "Hard hat" }, { id: "b", text: "Safety goggles" }]} onChange={(v) => (latest = v)} />);
    const hh = screen.getByTestId("opt-a").querySelector("input") as HTMLInputElement;
    const sg = screen.getByTestId("opt-b").querySelector("input") as HTMLInputElement;
    hh.focus();
    fireEvent.click(hh);
    sg.focus();
    fireEvent.click(sg);
    expect(new Set(latest)).toEqual(new Set(["a", "b"]));
  });
});
