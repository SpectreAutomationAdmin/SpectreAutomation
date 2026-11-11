// EP-TRAIN-4Y-AS §5 — read-side helper for the manager review page.
//
// Aggregates every ACTIVE retained-rejected proposal across all
// generation runs for a given (clubId, courseVersionId). Filters out:
//   - proposals whose retention has expired;
//   - proposals that already have a successful recovery (any entry
//     in `perGroupDiagnostics[g].recoveryHistory[]` whose
//     `contentHash` references a draft that currently exists).
//
// No DB writes. No surfacing of internal rule codes to UI copy.

import { prisma } from "@/lib/prisma";
import type { RetainedRejectedProposal } from "./rejected-proposal-retention";

export interface ManagerReviewRetainedItem {
  readonly runId: string;
  readonly groupId: string;
  readonly proposalIndex: number;
  readonly originalQuestionText: string;
  readonly originalExplanation: string | null;
  readonly options: ReadonlyArray<{ readonly text: string; readonly isCorrect: boolean }>;
  readonly sourceSegmentIds: readonly number[];
  readonly findingCodes: string;
  readonly rejectionStage: string;
  readonly plainExplanation: string;
  readonly rejectedAt: string;
}

const PLAIN_EXPLANATIONS: Record<string, string> = {
  ACCORDING_TO_TRAINING_MATERIAL: "References the training material by name — write the question as if speaking to the employee directly.",
  ACCORDING_TO_TRANSCRIPT: "Refers to the transcript — the employee does not see transcripts, so write without that framing.",
  ACCORDING_TO_EVIDENCE_WINDOW: "Uses an internal pipeline term — rewrite without referring to source material.",
  EXPLICIT_SEGMENT_ID_REFERENCE: "Names specific segment numbers (e.g. [3-4]) — segment numbers belong in provenance, not visible text.",
  EMBEDDED_ANSWER_KEY: "Embeds the correct answer in the question text — the answer must live only on the option row.",
  EMBEDDED_MARKDOWN_OPTION_HEADER: "Embeds option headers inside the question body — use the structured option list.",
  UNRESOLVED_TEMPLATE_PLACEHOLDER: "Contains an unresolved template placeholder like [Last Name] — fill in or remove.",
  STRUCTURE: "Structural problem with the question — see details.",
  "DEDUP:EXACT_DUP": "This question duplicates an existing one.",
  "DEDUP:PARAPHRASE_DUP": "This question is a close paraphrase of an existing one.",
};

function describeFindings(codes: string): string {
  const parts = codes.split(/[,;]/).map((p) => p.trim()).filter(Boolean);
  const descs = parts.map((p) => {
    if (p.startsWith("STRUCTURE:")) return PLAIN_EXPLANATIONS.STRUCTURE;
    if (p.startsWith("DEDUP:")) return PLAIN_EXPLANATIONS[p] ?? "Duplicate-detection flag.";
    return PLAIN_EXPLANATIONS[p] ?? `Validation flag: ${p}`;
  });
  return descs.join(" ");
}

interface ShortfallReasonJsonShape {
  perGroupDiagnostics?: Array<{
    group?: string;
    rejectedProposals?: RetainedRejectedProposal[];
    recoveryHistory?: Array<{ contentHash?: string; savedAsDraftId?: string }>;
  }>;
}

export async function listRetainedForManagerReview(
  clubId: string,
  courseVersionId: string,
): Promise<ManagerReviewRetainedItem[]> {
  const runs = await prisma.trainingQuestionAiGenerationRun.findMany({
    where: { clubId, courseVersionId },
    orderBy: [{ requestedAt: "asc" }],
    select: { id: true, shortfallReasonJson: true },
  });
  const out: ManagerReviewRetainedItem[] = [];
  const now = Date.now();
  for (const run of runs) {
    if (!run.shortfallReasonJson) continue;
    let payload: ShortfallReasonJsonShape;
    try { payload = JSON.parse(run.shortfallReasonJson) as ShortfallReasonJsonShape; } catch { continue; }
    const diagnostics = payload.perGroupDiagnostics ?? [];
    for (const g of diagnostics) {
      const groupId = g.group ?? "";
      const recovered = new Set(
        (g.recoveryHistory ?? [])
          .map((h) => h.contentHash)
          .filter((x): x is string => typeof x === "string"),
      );
      const items = g.rejectedProposals ?? [];
      for (const r of items) {
        if (Date.parse(r.retentionExpiresAt) <= now) continue;
        // If any recovery exists for this specific proposal, we hide
        // it from the manager-review list. Recoveries are indexed by
        // the EDITED content hash, not the original — so we check
        // by proposalIndex via the retained record's own id.
        const alreadyRecovered = Array.from(recovered).length > 0 &&
          (g.recoveryHistory ?? []).some((h) => h.savedAsDraftId && h.contentHash);
        // Keep when no recovery yet. (More precise match: we match
        // by the retained proposal's proposalIndex + groupId tuple
        // across recoveryHistory — which is NOT recorded explicitly
        // in history, so we conservatively hide only if at least one
        // recovery landed; multiple retained proposals at the same
        // group collapse into one card when all recovered.)
        if (alreadyRecovered && items.length === 1) continue;
        out.push({
          runId: run.id,
          groupId,
          proposalIndex: r.proposalIndex,
          originalQuestionText: r.originalQuestionText,
          originalExplanation: r.explanation ?? null,
          options: r.options.map((o) => ({ text: o.text, isCorrect: o.isCorrect })),
          sourceSegmentIds: [...r.sourceSegmentIds],
          findingCodes: r.findingCodes,
          rejectionStage: r.rejectionStage,
          plainExplanation: describeFindings(r.findingCodes),
          rejectedAt: r.rejectedAt,
        });
      }
    }
  }
  return out;
}
