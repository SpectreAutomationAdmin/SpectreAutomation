// EP-TRAIN-4Y-BE — deterministic mock inference for ORCHESTRATION
// acceptance tests on staging. It proves the pipeline (enqueue → worker
// → grounding → sanitiser → dedup → persistence → review) without any
// billable GPU call. It does NOT prove that real AI generation works.
//
// Every mock question is visibly labelled "MOCK INFERENCE" in its stem
// and explanation so it can never be mistaken for real course content.
// The worker only reaches this module when the version's authorization
// asked for MOCK and TRAINING_MOCK_INFERENCE_ALLOWED=true (never set in
// production).

import type { ModalGenerateProposal } from "./modal-client";

export const MOCK_INFERENCE_LABEL = "MOCK INFERENCE";

const HEAD_WORDS = 16;
const TAIL_WORDS = 8;

function clean(text: string): string {
  return text.replace(/["“”()\[\]]/g, "").replace(/\s+/g, " ").trim();
}

/** Text we must not echo into employee-facing fields: digits and the
 *  words the text-purity sanitiser rejects. */
function usable(text: string): boolean {
  return !/\d|segment|transcript|according to|correct answer/i.test(text);
}

export function buildMockProposals(args: {
  readonly target: number;
  readonly windowSegmentIds: readonly number[];
  /** Eligible segments, any order. */
  readonly segments: readonly { readonly segmentIndex: number; readonly text: string }[];
  /** Segment indices already cited by earlier mock questions in this
   *  run. Mutated — keeps every question on distinct evidence. */
  readonly usedSegmentIndices: Set<number>;
}): ModalGenerateProposal[] {
  const byIndex = new Map(args.segments.map((s) => [s.segmentIndex, clean(s.text)]));
  const window = new Set(args.windowSegmentIds);

  interface Pair { readonly a: number; readonly b: number; readonly head: string; readonly tail: string }
  const pairFor = (a: number): Pair | null => {
    const b = a + 1;
    const ta = byIndex.get(a);
    const tb = byIndex.get(b);
    if (!ta || !tb || !usable(ta) || !usable(tb)) return null;
    const words = `${ta} ${tb}`.split(" ");
    if (words.length < HEAD_WORDS + TAIL_WORDS) return null;
    return {
      a,
      b,
      head: words.slice(0, HEAD_WORDS).join(" "),
      tail: words.slice(HEAD_WORDS, HEAD_WORDS + TAIL_WORDS).join(" "),
    };
  };

  const inWindow: Pair[] = [];
  for (const a of [...window].sort((x, y) => x - y)) {
    if (!window.has(a + 1)) continue;
    const p = pairFor(a);
    if (p) inWindow.push(p);
  }
  const everyPair: Pair[] = [];
  for (const a of [...byIndex.keys()].sort((x, y) => x - y)) {
    const p = pairFor(a);
    if (p) everyPair.push(p);
  }

  const proposals: ModalGenerateProposal[] = [];
  for (const p of inWindow) {
    if (proposals.length >= args.target) break;
    if (args.usedSegmentIndices.has(p.a) || args.usedSegmentIndices.has(p.b)) continue;
    const distractors: string[] = [];
    for (const other of everyPair) {
      if (distractors.length >= 3) break;
      if (Math.abs(other.a - p.a) < 4) continue;
      const lower = other.tail.toLowerCase();
      if (lower === p.tail.toLowerCase() || distractors.some((d) => d.toLowerCase() === lower)) continue;
      if (p.head.includes(other.tail)) continue;
      distractors.push(other.tail);
    }
    if (distractors.length < 3) continue;
    args.usedSegmentIndices.add(p.a);
    args.usedSegmentIndices.add(p.b);
    proposals.push({
      questionType: "SINGLE_CHOICE",
      questionText: `${p.head}… ${MOCK_INFERENCE_LABEL}: how does this line continue?`,
      options: [
        { text: distractors[0], isCorrect: false },
        { text: p.tail, isCorrect: true },
        { text: distractors[1], isCorrect: false },
        { text: distractors[2], isCorrect: false },
      ],
      explanation: `${MOCK_INFERENCE_LABEL}. The line continues: ${p.tail}.`,
      sourceSegmentIds: [p.a, p.b],
    });
  }
  return proposals;
}

/** EP-TRAIN-4Y-BF — decorate simulated proposals with the three
 *  formatting defects observed in real model output, so the
 *  deterministic normaliser can be exercised end to end without a
 *  provider call:
 *    - "… according to the training material?" in the stem;
 *    - "This aligns with segment [N]." in the explanation (N is one of
 *      the proposal's own source segments);
 *    - a "(Correct Answer: …)" note on every option.
 *  Without normalisation every one of these is rejected by the
 *  employee-facing text sanitiser. */
export function withFormattingDefects(proposals: readonly ModalGenerateProposal[]): ModalGenerateProposal[] {
  return proposals.map((p) => ({
    ...p,
    questionText: p.questionText.replace(/\?\s*$/, " according to the training material?"),
    options: p.options.map((o) => ({
      ...o,
      text: `${o.text} (Correct Answer: simulated note, ${o.isCorrect ? "this is the continuation" : "this is a different line"}.)`,
    })),
    explanation: `${p.explanation ?? ""} This aligns with segment [${p.sourceSegmentIds[0]}].`.trim(),
  }));
}
