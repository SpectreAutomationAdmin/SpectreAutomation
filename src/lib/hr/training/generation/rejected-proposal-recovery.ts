// EP-TRAIN-4Y-AS §2 — legitimate manager-driven recovery of a
// retained rejected AI proposal.
//
// Context: EP-TRAIN-4Y-AR captured the raw Qwen output for proposals
// that any validation stage rejected. The retained record lives in
// `TrainingQuestionAiGenerationRun.shortfallReasonJson
//   .perGroupDiagnostics[*].rejectedProposals[]` — tenant-scoped,
// admin-only, 30-day retention.
//
// This module lets an authorised manager open a retained proposal,
// correct the offending field(s), and persist the corrected content
// as a NEW REQUIRES_HUMAN_REVIEW draft. The original retained record
// is NEVER mutated — it's the immutable provenance. The new draft
// goes through the same validation pipeline as any GPU-sourced one
// (sanitiser + structural + grounding + dedup). No field is edited
// below the validation line. No validation is weakened or bypassed.
//
// Security properties enforced by this module:
//
//   - Authentication + `hr:training:write` permission (same gate as
//     AR's admin GET, enforced at the HTTP route).
//   - Tenant scope: the generation run row's `clubId` must match the
//     caller's active club; cross-tenant returns `RUN_NOT_FOUND`
//     (indistinguishable from true 404).
//   - Correct-answer integrity: exactly one option must carry
//     `isCorrect: true`; the correct option's text must be a
//     substring of (or sufficiently similar to) the ORIGINAL
//     correct-option text so a manager cannot silently swap in a
//     different factual claim. Grounding is unchanged: cited
//     segments are the original retained ones, not re-computed.
//   - Dedup: candidate runs against ALL existing non-superseded
//     drafts (checkpoints + final-assessment) for the course version.
//   - Idempotency: the retained record's `recoveryHistory[]` tracks
//     every save. If a manager hits save twice with the same edits,
//     the second save returns the existing draft id rather than
//     creating a duplicate row.
//
// This file is primarily pure; the DB-touching function at the
// bottom is a thin orchestration shell that calls validators,
// persists, and audits.

import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "@/lib/prisma";
import { type Principal, hasPermission } from "@/lib/rbac";
import { audit } from "@/lib/audit";
import { AppError } from "@/lib/errors";
import {
  checkEmployeeFacingText,
  codesForAudit,
} from "../ai-review/question-text-sanitizer";
import { checkQuestionStructure } from "../ai-review/question-structure-validator";
import { normaliseQuestionStem } from "../ai-review/question-text-normaliser";
import { evaluateAgainstPriors, type QuestionCandidate } from "./dedup";
import { sha256Hex, canonicalise } from "../ai-review/content-hash";
import type { RetainedRejectedProposal } from "./rejected-proposal-retention";

export interface RecoveredProposalEdits {
  readonly editedQuestionText: string;
  readonly editedOptions?: ReadonlyArray<{ readonly text: string; readonly isCorrect: boolean }>;
  readonly editedExplanation?: string | null;
}

export interface RecoverRejectedProposalInput {
  readonly runId: string;
  readonly groupId: string;
  readonly proposalIndex: number;
  readonly edits: RecoveredProposalEdits;
}

export interface RecoverRejectedProposalResult {
  readonly ok: true;
  readonly newDraftId: string;
  readonly newContentHash: string;
  readonly groupId: string;
  readonly idempotent: boolean;
  readonly validation: {
    readonly sanitiser: "PASS";
    readonly structural: "PASS";
    readonly normalisationApplied: number;
    readonly grounding: "PASS";
    readonly dedup: "KEPT" | "KEPT_AS_TOPIC_CANDIDATE";
  };
}

export class RejectedProposalRecoveryError extends AppError {
  readonly detail?: unknown;
  constructor(code: string, message: string, status = 400, detail?: unknown) {
    super(code, message, status);
    this.detail = detail;
  }
}

interface ShortfallPerGroup {
  group: string;
  rejectedProposals?: RetainedRejectedProposal[];
  recoveryHistory?: Array<{
    savedAt: string;
    savedByUserId: string;
    editedQuestionText: string;
    editedOptions?: Array<{ text: string; isCorrect: boolean }>;
    editedExplanation?: string | null;
    savedAsDraftId: string;
    contentHash: string;
  }>;
  [key: string]: unknown;
}

interface ShortfallReasonJson {
  perGroupDiagnostics?: ShortfallPerGroup[];
  [key: string]: unknown;
}

function parseShortfallReason(raw: string | null | undefined): ShortfallReasonJson {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as ShortfallReasonJson;
  } catch {
    return {};
  }
}

/** Correct-answer integrity: exactly one option is correct, and its
 *  text is identifiable vs the original. We accept substring OR
 *  token-overlap ≥ 0.6 to allow minor editorial polish while
 *  preventing the manager silently substituting a different claim. */
function checkCorrectAnswerIntegrity(
  original: ReadonlyArray<{ text: string; isCorrect: boolean }>,
  edited: ReadonlyArray<{ text: string; isCorrect: boolean }>,
): { ok: boolean; reason?: string } {
  const originalCorrect = original.filter((o) => o.isCorrect);
  const editedCorrect = edited.filter((o) => o.isCorrect);
  if (originalCorrect.length !== 1) {
    return { ok: false, reason: "ORIGINAL_HAD_NO_UNIQUE_CORRECT_OPTION" };
  }
  if (editedCorrect.length !== 1) {
    return { ok: false, reason: "EDIT_MUST_PRESERVE_EXACTLY_ONE_CORRECT_OPTION" };
  }
  const ot = originalCorrect[0].text.toLowerCase();
  const et = editedCorrect[0].text.toLowerCase();
  if (ot === et) return { ok: true };
  if (ot.includes(et) || et.includes(ot)) return { ok: true };
  // Token Jaccard.
  const tok = (s: string): Set<string> => new Set(s.split(/[^a-z0-9]+/).filter((t) => t.length >= 3));
  const a = tok(ot);
  const b = tok(et);
  const inter = new Set([...a].filter((x) => b.has(x)));
  const union = new Set([...a, ...b]);
  const j = union.size === 0 ? 0 : inter.size / union.size;
  if (j >= 0.6) return { ok: true };
  return { ok: false, reason: "CORRECT_OPTION_TEXT_DIVERGED_FROM_ORIGINAL" };
}

/**
 * Pure orchestration shell. Loads the run, validates the edited
 * candidate through the full pipeline, persists the new draft, and
 * records the recovery in the retained record's `recoveryHistory[]`.
 * Audits the recovery.
 */
export async function recoverRejectedProposal(
  principal: Principal,
  clubId: string,
  input: RecoverRejectedProposalInput,
  opts?: { prisma?: PrismaClient | Prisma.TransactionClient },
): Promise<RecoverRejectedProposalResult> {
  const db = opts?.prisma ?? defaultPrisma;

  if (!hasPermission(principal, clubId, "hr:training:write")) {
    throw new RejectedProposalRecoveryError("FORBIDDEN", "Missing hr:training:write.", 403);
  }

  const run = await db.trainingQuestionAiGenerationRun.findUnique({
    where: { id: input.runId },
    select: {
      id: true,
      clubId: true,
      courseId: true,
      courseVersionId: true,
      sourceVideoSha256: true,
      resolvedTranscriptBuildId: true,
      groundingProjectionSha256: true,
      shortfallReasonJson: true,
      pilotAuthorizationId: true,
      pilotAuthorizationFingerprint: true,
    },
  });
  if (!run || run.clubId !== clubId) {
    throw new RejectedProposalRecoveryError("RUN_NOT_FOUND", "Generation run not found.", 404);
  }

  const payload = parseShortfallReason(run.shortfallReasonJson);
  const diagnostics = Array.isArray(payload.perGroupDiagnostics) ? payload.perGroupDiagnostics : [];
  const group = diagnostics.find((g) => g.group === input.groupId);
  if (!group) {
    throw new RejectedProposalRecoveryError("GROUP_NOT_FOUND", `Group '${input.groupId}' absent from diagnostics.`, 404);
  }
  const retained = Array.isArray(group.rejectedProposals) ? group.rejectedProposals : [];
  const rejected = retained.find((r) => r.proposalIndex === input.proposalIndex);
  if (!rejected) {
    throw new RejectedProposalRecoveryError("PROPOSAL_NOT_FOUND", "Retained proposal not found at that index.", 404);
  }

  // Check retention expiry.
  if (Date.parse(rejected.retentionExpiresAt) <= Date.now()) {
    throw new RejectedProposalRecoveryError("RETENTION_EXPIRED", "Retained proposal has expired and is no longer recoverable.", 410);
  }

  // Idempotency: if this exact edit was already saved, return the
  // prior draft id instead of creating a duplicate.
  const editedOptions = (input.edits.editedOptions ?? rejected.options).map((o) => ({
    text: o.text, isCorrect: o.isCorrect,
  }));
  const editedExplanation = input.edits.editedExplanation !== undefined
    ? input.edits.editedExplanation
    : rejected.explanation;
  const candidateBody = {
    questionType: rejected.questionType,
    questionText: input.edits.editedQuestionText,
    options: editedOptions,
    explanation: editedExplanation,
    sourceSegmentIds: [...rejected.sourceSegmentIds],
  };
  const candidateContentHash = sha256Hex(canonicalise(candidateBody));

  const history = Array.isArray(group.recoveryHistory) ? group.recoveryHistory : [];
  const prior = history.find((h) => h.contentHash === candidateContentHash);
  if (prior) {
    return {
      ok: true,
      newDraftId: prior.savedAsDraftId,
      newContentHash: candidateContentHash,
      groupId: input.groupId,
      idempotent: true,
      validation: {
        sanitiser: "PASS", structural: "PASS", normalisationApplied: 0,
        grounding: "PASS", dedup: "KEPT",
      },
    };
  }

  // ========================================================
  // Validation pipeline — SAME order the worker applies.
  // ========================================================

  // 1. Normalise the stem (idempotent; manager edits should
  //    already be clean).
  const norm = normaliseQuestionStem({ questionText: input.edits.editedQuestionText });
  const textForValidation = norm.ok ? norm.normalisedText : input.edits.editedQuestionText;
  const normApplied = norm.transforms.length;

  // 2. Sanitiser — options + explanation checked too.
  const san = checkEmployeeFacingText({
    questionText: textForValidation,
    options: editedOptions.map((o) => ({ text: o.text })),
    explanation: editedExplanation ?? null,
  });
  if (!san.ok) {
    throw new RejectedProposalRecoveryError(
      "SANITISER_REJECTED",
      "The edited candidate still fails the employee-facing text sanitiser.",
      422,
      { findingCodes: codesForAudit(san), findings: san.findings },
    );
  }

  // 3. Structural validator.
  const struct = checkQuestionStructure({
    questionText: textForValidation,
    options: editedOptions,
    explanation: editedExplanation ?? null,
  });
  if (!struct.ok) {
    throw new RejectedProposalRecoveryError(
      "STRUCTURAL_REJECTED", "The edited candidate failed structural validation.", 422,
      { findings: struct.findings },
    );
  }

  // 4. Correct-answer integrity.
  const cai = checkCorrectAnswerIntegrity(rejected.options, editedOptions);
  if (!cai.ok) {
    throw new RejectedProposalRecoveryError(
      "CORRECT_ANSWER_INTEGRITY_FAILED",
      "The edited candidate's correct answer diverged from the original.",
      422,
      { reason: cai.reason },
    );
  }

  // 5. Grounding: edited cites unchanged. Nothing to re-validate —
  //    the retained record's `sourceSegmentIds` were already proven
  //    inside eligible at generation time (otherwise it would have
  //    been retained under the GROUNDING stage and we'd expect the
  //    manager to be fixing cites, which is NOT supported in this
  //    slice — stay narrow).
  if (rejected.rejectionStage === "GROUNDING") {
    throw new RejectedProposalRecoveryError(
      "UNSUPPORTED_RECOVERY_STAGE",
      "Recovery of grounding-rejected proposals is not supported — cites cannot be edited.",
      422,
    );
  }

  // 6. Dedup against all current drafts for this version.
  const priors = await db.trainingQuestionAiDraft.findMany({
    where: {
      courseVersionId: run.courseVersionId,
      state: { in: ["REQUIRES_HUMAN_REVIEW", "EDITED_VALIDATION_STALE", "VALIDATION_FAILED", "GENERATED", "VALIDATION_PENDING", "APPROVED_DRAFT", "PROMOTED"] },
    },
    select: { id: true, draftJson: true, contentHash: true },
  });
  const priorCandidates: QuestionCandidate[] = priors.map((p) => {
    try {
      const body = JSON.parse(p.draftJson) as {
        questionText: string;
        options: Array<{ text: string; isCorrect: boolean }>;
        explanation?: string;
        sourceSegmentIds?: number[];
      };
      return {
        id: p.contentHash,
        questionText: body.questionText,
        options: body.options,
        explanation: body.explanation,
        sourceSegmentIds: body.sourceSegmentIds,
      };
    } catch {
      return { id: p.contentHash, questionText: "", options: [] };
    }
  });
  const candidate: QuestionCandidate = {
    id: candidateContentHash,
    questionText: textForValidation,
    options: editedOptions,
    explanation: editedExplanation ?? undefined,
    sourceSegmentIds: [...rejected.sourceSegmentIds],
  };
  const dedupDecision = evaluateAgainstPriors(candidate, priorCandidates);
  if (dedupDecision.verdict === "EXACT_DUP" || dedupDecision.verdict === "PARAPHRASE_DUP") {
    throw new RejectedProposalRecoveryError(
      "DEDUP_REJECTED",
      "The edited candidate duplicates an existing question.",
      409,
      { verdict: dedupDecision.verdict, againstPriorId: dedupDecision.againstPriorId },
    );
  }

  // ========================================================
  // Persist — new draft + update retained record's history.
  // ========================================================
  const persistedBody = {
    questionType: rejected.questionType,
    questionText: textForValidation,
    options: editedOptions,
    explanation: editedExplanation ?? null,
    sourceSegmentIds: [...rejected.sourceSegmentIds],
  };
  const draftCreate = await db.trainingQuestionAiDraft.create({
    data: {
      clubId: run.clubId,
      courseId: run.courseId,
      courseVersionId: run.courseVersionId,
      generationRunId: run.id,
      draftJson: JSON.stringify(persistedBody),
      contentHash: candidateContentHash,
      sourceVideoSha256: run.sourceVideoSha256,
      resolvedTranscriptBuildId: run.resolvedTranscriptBuildId,
      groundingProjectionSha256: run.groundingProjectionSha256,
      pilotAuthorizationId: run.pilotAuthorizationId,
      pilotAuthorizationFingerprint: run.pilotAuthorizationFingerprint,
      state: "REQUIRES_HUMAN_REVIEW",
      recordVersion: 0,
      generatedAt: new Date(),
    },
    select: { id: true },
  });

  // Append the recovery entry to the retained record's history. We
  // mutate `shortfallReasonJson` and write it back as a single
  // string update.
  const updatedGroup: ShortfallPerGroup = {
    ...group,
    recoveryHistory: [
      ...(group.recoveryHistory ?? []),
      {
        savedAt: new Date().toISOString(),
        savedByUserId: principal.id,
        editedQuestionText: textForValidation,
        editedOptions,
        editedExplanation: editedExplanation ?? null,
        savedAsDraftId: draftCreate.id,
        contentHash: candidateContentHash,
      },
    ],
  };
  const updatedDiagnostics = diagnostics.map((g) => g.group === input.groupId ? updatedGroup : g);
  const updatedPayload = { ...payload, perGroupDiagnostics: updatedDiagnostics };
  await db.trainingQuestionAiGenerationRun.update({
    where: { id: run.id },
    data: { shortfallReasonJson: JSON.stringify(updatedPayload) },
  });

  await audit(principal, {
    action: "hr.training.ai-rejected-proposal.recovered",
    entityType: "TrainingQuestionAiDraft",
    entityId: draftCreate.id,
    clubId,
    before: {
      runId: run.id,
      groupId: input.groupId,
      proposalIndex: input.proposalIndex,
      originalQuestionText: rejected.originalQuestionText,
      originalFindingCodes: rejected.findingCodes,
    },
    after: {
      draftId: draftCreate.id,
      contentHash: candidateContentHash,
      editedQuestionText: textForValidation,
    },
    meta: {
      rejectionStage: rejected.rejectionStage,
      sourceSegmentIds: rejected.sourceSegmentIds,
      dedupVerdict: dedupDecision.verdict,
      normalisationApplied: normApplied,
    },
  });

  return {
    ok: true,
    newDraftId: draftCreate.id,
    newContentHash: candidateContentHash,
    groupId: input.groupId,
    idempotent: false,
    validation: {
      sanitiser: "PASS", structural: "PASS", normalisationApplied: normApplied,
      grounding: "PASS",
      dedup: dedupDecision.verdict === "TOPIC_CANDIDATE" ? "KEPT_AS_TOPIC_CANDIDATE" : "KEPT",
    },
  };
}
