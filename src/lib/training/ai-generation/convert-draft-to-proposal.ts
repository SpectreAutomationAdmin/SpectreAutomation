// EP-TRAIN-6C-10B — TypeScript port of the EP-TRAIN-6C-4 deterministic
// Lite-draft → authoritative-proposal converter.
//
// Design invariants (preserved verbatim from 6C-4 acceptance):
//   - The Lite schema has NO timestamp fields, NO quotation fields, NO
//     placement, NO groundingStatus, NO reviewStatus. The converter is
//     the single authority for every one of those. The model is never
//     trusted to produce them.
//   - Timestamps + quotations come from the grounding projection's
//     passages, keyed by sourceSegmentId.
//   - Excluded-segment refusal is a HARD invariant. Even if the model
//     cites a segment that happens to be in the projection, if the
//     pilot authorization lists it in excludedSegmentIds → REJECT.
//   - reviewStatus is a const "PENDING_REVIEW". Non-negotiable.
//   - groundingStatus is set to "REQUIRES_HUMAN_VERIFICATION" by the
//     converter itself; the grounding-validator's independent verdict
//     runs separately and will downgrade/upgrade accordingly.
//   - The converter NEVER fabricates evidence, timestamps or citations.

import { createHash } from "node:crypto";
import type {
  GroundingPassage,
  GroundingProjection,
  PilotAuthorizationV1,
  Placement,
  SupportingCitation,
  TrainingQuestionDraftLiteV1,
  TrainingQuestionProposalV1,
  ValidatorError,
} from "./types";
import { PROPOSAL_SCHEMA_VERSION } from "./types";

export const CONVERT_ERRORS = Object.freeze({
  DRAFT_MISSING: "ERR_CONVERT_DRAFT_MISSING",
  DRAFT_SCHEMA_INVALID: "ERR_CONVERT_DRAFT_SCHEMA_INVALID",
  DRAFT_FIELD_MISSING: "ERR_CONVERT_DRAFT_FIELD_MISSING",
  DRAFT_QTYPE_INVALID: "ERR_CONVERT_DRAFT_QTYPE_INVALID",
  DRAFT_OPTIONS_INVALID: "ERR_CONVERT_DRAFT_OPTIONS_INVALID",
  DRAFT_CORRECT_KEY_INVALID: "ERR_CONVERT_DRAFT_CORRECT_KEY_INVALID",
  DRAFT_TRUE_FALSE_SHAPE: "ERR_CONVERT_DRAFT_TRUE_FALSE_SHAPE",
  GROUNDING_MISSING: "ERR_CONVERT_GROUNDING_MISSING",
  AUTHORIZATION_MISSING: "ERR_CONVERT_AUTHORIZATION_MISSING",
  SEGMENT_NOT_IN_GROUNDING: "ERR_CONVERT_SEGMENT_NOT_IN_GROUNDING",
  SEGMENT_EXCLUDED_BY_PILOT: "ERR_CONVERT_SEGMENT_EXCLUDED_BY_PILOT",
  SEGMENT_PENDING_REVIEW: "ERR_CONVERT_SEGMENT_PENDING_REVIEW",
  DRAFT_PLACEMENT_INVALID: "ERR_CONVERT_DRAFT_PLACEMENT_INVALID",
  INTERNAL: "ERR_CONVERT_INTERNAL",
} as const);

export interface ConvertSuccess {
  readonly ok: true;
  readonly value: TrainingQuestionProposalV1;
  readonly propagatedSourceOrgFlags: readonly string[];
  readonly errors: readonly [];
}
export interface ConvertFailure {
  readonly ok: false;
  readonly errors: readonly ValidatorError[];
}
export type ConvertResult = ConvertSuccess | ConvertFailure;

function fail(errors: ValidatorError[], code: string, message: string, detail: Record<string, unknown> = {}): void {
  errors.push({ code, message, detail });
}

function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf-8").digest("hex");
}

function canonicalise(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(canonicalise).join(",") + "]";
  const keys = Object.keys(v as Record<string, unknown>).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalise((v as Record<string, unknown>)[k])).join(",") + "}";
}

function validateDraftShape(
  draft: TrainingQuestionDraftLiteV1 | null | undefined,
  errors: ValidatorError[],
): draft is TrainingQuestionDraftLiteV1 {
  if (!draft || typeof draft !== "object") {
    fail(errors, CONVERT_ERRORS.DRAFT_MISSING, "draft missing or not an object");
    return false;
  }
  const required = ["questionType", "questionText", "options", "explanation", "sourceSegmentIds"] as const;
  for (const k of required) {
    if (!(k in draft)) {
      fail(errors, CONVERT_ERRORS.DRAFT_FIELD_MISSING, `draft missing: ${k}`);
    }
  }
  if (errors.length) return false;
  if (!["SINGLE_CHOICE", "MULTI_ANSWER", "TRUE_FALSE"].includes(draft.questionType)) {
    fail(errors, CONVERT_ERRORS.DRAFT_QTYPE_INVALID, `unsupported questionType: ${draft.questionType}`);
    return false;
  }
  if (!Array.isArray(draft.options) || draft.options.length < 2 || draft.options.length > 6) {
    fail(errors, CONVERT_ERRORS.DRAFT_OPTIONS_INVALID, `options length out of range: ${draft.options?.length}`);
    return false;
  }
  for (const o of draft.options) {
    if (typeof o?.text !== "string" || o.text.length < 1 || typeof o?.isCorrect !== "boolean") {
      fail(errors, CONVERT_ERRORS.DRAFT_OPTIONS_INVALID, `malformed option: ${JSON.stringify(o)}`);
      return false;
    }
  }
  if (!Array.isArray(draft.sourceSegmentIds) || draft.sourceSegmentIds.length < 1 || draft.sourceSegmentIds.length > 5) {
    fail(errors, CONVERT_ERRORS.DRAFT_SCHEMA_INVALID, `sourceSegmentIds length out of range`);
    return false;
  }
  for (const sid of draft.sourceSegmentIds) {
    if (!Number.isInteger(sid) || sid < 0) {
      fail(errors, CONVERT_ERRORS.DRAFT_SCHEMA_INVALID, `sourceSegmentIds contains non-integer or negative: ${sid}`);
      return false;
    }
  }
  if (typeof draft.questionText !== "string" || draft.questionText.length < 1) {
    fail(errors, CONVERT_ERRORS.DRAFT_SCHEMA_INVALID, "questionText invalid");
    return false;
  }
  if (typeof draft.explanation !== "string" || draft.explanation.length < 1) {
    fail(errors, CONVERT_ERRORS.DRAFT_SCHEMA_INVALID, "explanation invalid");
    return false;
  }
  return true;
}

function validateCorrectAnswerKey(draft: TrainingQuestionDraftLiteV1, errors: ValidatorError[]): void {
  const corrects = draft.options.filter((o) => o.isCorrect === true);
  if (draft.questionType === "SINGLE_CHOICE") {
    if (corrects.length !== 1) {
      fail(errors, CONVERT_ERRORS.DRAFT_CORRECT_KEY_INVALID,
        `SINGLE_CHOICE requires exactly 1 correct option (got ${corrects.length})`);
    }
  } else if (draft.questionType === "MULTI_ANSWER") {
    if (corrects.length < 2) {
      fail(errors, CONVERT_ERRORS.DRAFT_CORRECT_KEY_INVALID,
        `MULTI_ANSWER requires >= 2 correct options (got ${corrects.length})`);
    }
    if (corrects.length === draft.options.length) {
      fail(errors, CONVERT_ERRORS.DRAFT_CORRECT_KEY_INVALID,
        `MULTI_ANSWER requires at least one incorrect option`);
    }
  } else if (draft.questionType === "TRUE_FALSE") {
    if (draft.options.length !== 2) {
      fail(errors, CONVERT_ERRORS.DRAFT_TRUE_FALSE_SHAPE,
        `TRUE_FALSE requires exactly 2 options (got ${draft.options.length})`);
    } else {
      const canon = (s: string): string => String(s).toLowerCase().replace(/[.?!,'"():;]/g, "").trim();
      const vals = draft.options.map((o) => canon(o.text));
      if (!vals.includes("true") || !vals.includes("false")) {
        fail(errors, CONVERT_ERRORS.DRAFT_TRUE_FALSE_SHAPE,
          `TRUE_FALSE options must be literally "True" and "False"`);
      }
    }
    if (corrects.length !== 1) {
      fail(errors, CONVERT_ERRORS.DRAFT_CORRECT_KEY_INVALID,
        `TRUE_FALSE requires exactly 1 correct option (got ${corrects.length})`);
    }
  }
}

function indexGroundingPassages(grounding: GroundingProjection | null | undefined): Map<number, GroundingPassage> {
  const map = new Map<number, GroundingPassage>();
  for (const p of grounding?.passages || []) {
    for (const sid of p.sourceSegmentIds || []) {
      map.set(sid, p);
    }
  }
  return map;
}

function buildProposalId(draft: TrainingQuestionDraftLiteV1, authorization: PilotAuthorizationV1): string {
  const payload = canonicalise({
    draft,
    authId: authorization.authorizationId,
    buildId: authorization.resolvedTranscriptBuildId,
  });
  const h = sha256Hex(payload).substring(0, 16);
  return `p-ep6c4-${h}`;
}

function truncateQuotation(text: string, maxLen = 1000): string {
  if (text.length <= maxLen) return text;
  return text.substring(0, maxLen);
}

export interface ConvertInput {
  readonly draft: TrainingQuestionDraftLiteV1 | null | undefined;
  readonly grounding: GroundingProjection | null | undefined;
  readonly authorization: PilotAuthorizationV1 | null | undefined;
  readonly placement?: Placement;
}

const DEFAULT_PLACEMENT: Placement = { kind: "FINAL_ASSESSMENT" };

export function convertDraftToProposal(input: ConvertInput): ConvertResult {
  const errors: ValidatorError[] = [];
  const { draft, grounding, authorization, placement = DEFAULT_PLACEMENT } = input;

  if (!validateDraftShape(draft, errors)) return { ok: false, errors };
  validateCorrectAnswerKey(draft, errors);
  if (errors.length) return { ok: false, errors };

  if (!grounding || !Array.isArray(grounding.passages)) {
    fail(errors, CONVERT_ERRORS.GROUNDING_MISSING, "grounding projection missing or malformed");
    return { ok: false, errors };
  }
  if (!authorization || !authorization.pilotRestrictions) {
    fail(errors, CONVERT_ERRORS.AUTHORIZATION_MISSING, "pilot authorization missing or malformed");
    return { ok: false, errors };
  }

  if (!placement || !placement.kind) {
    fail(errors, CONVERT_ERRORS.DRAFT_PLACEMENT_INVALID, "placement missing");
    return { ok: false, errors };
  }
  if (placement.kind === "CHECKPOINT" && (typeof placement.atSec !== "number" || placement.atSec < 0)) {
    fail(errors, CONVERT_ERRORS.DRAFT_PLACEMENT_INVALID, "CHECKPOINT placement requires numeric atSec >= 0");
    return { ok: false, errors };
  }
  if (!["CHECKPOINT", "FINAL_ASSESSMENT"].includes(placement.kind)) {
    fail(errors, CONVERT_ERRORS.DRAFT_PLACEMENT_INVALID, `unsupported placement.kind: ${placement.kind}`);
    return { ok: false, errors };
  }

  const excluded = new Set(authorization.pilotRestrictions.excludedSegmentIds || []);
  const passageById = indexGroundingPassages(grounding);

  const supportingCitations: SupportingCitation[] = [];
  const propagatedFlags = new Set<string>();
  for (const sid of draft.sourceSegmentIds) {
    if (excluded.has(sid)) {
      fail(errors, CONVERT_ERRORS.SEGMENT_EXCLUDED_BY_PILOT,
        `draft cites segment ${sid} which the pilot authorization excludes`);
      continue;
    }
    const passage = passageById.get(sid);
    if (!passage) {
      fail(errors, CONVERT_ERRORS.SEGMENT_NOT_IN_GROUNDING,
        `draft cites segment ${sid} not in authorized grounding projection`);
      continue;
    }
    const pendingReview = passage.flags?.pendingReview || [];
    if (pendingReview.length > 0) {
      fail(errors, CONVERT_ERRORS.SEGMENT_PENDING_REVIEW,
        `draft cites segment ${sid} that carries pending-review flag(s)`);
      continue;
    }
    for (const f of passage.flags?.sourceOrgMismatch || []) {
      propagatedFlags.add(f);
    }
    supportingCitations.push({
      segmentId: sid,
      startSec: passage.sourceStartSec,
      endSec: passage.sourceEndSec,
      quotation: truncateQuotation(passage.text, 1000),
    });
  }
  if (errors.length) return { ok: false, errors };
  if (supportingCitations.length === 0) {
    fail(errors, CONVERT_ERRORS.SEGMENT_NOT_IN_GROUNDING, "no valid supporting citations after resolution");
    return { ok: false, errors };
  }

  const proposalId = buildProposalId(draft, authorization);

  const proposal: TrainingQuestionProposalV1 = {
    schemaVersion: PROPOSAL_SCHEMA_VERSION,
    proposalId,
    placement,
    questionType: draft.questionType,
    questionText: draft.questionText,
    options: draft.options.map((o) => ({ text: o.text, isCorrect: Boolean(o.isCorrect) })),
    explanation: draft.explanation,
    supportingCitations,
    groundingStatus: "REQUIRES_HUMAN_VERIFICATION",
    reviewStatus: "PENDING_REVIEW",
  };

  return {
    ok: true,
    value: proposal,
    propagatedSourceOrgFlags: [...propagatedFlags],
    errors: [],
  };
}
