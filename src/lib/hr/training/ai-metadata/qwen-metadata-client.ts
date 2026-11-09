// EP-TRAIN-4Y-V §4 (2026-11-09) — Qwen-sourced course metadata.
//
// Reuses the deployed `spectre-training-generate` Modal app (Qwen 2.5
// 7B Instruct AWQ on A10G) with a specialised system prompt that
// produces ONE "proposal" whose `questionText` is the course title
// and whose `explanation` is the course description. This avoids a
// second Modal deploy — the shared Qwen container simply gets a
// different prompt and a `maxQuestions: 1` constraint.
//
// The LMFE-enforced JSON schema on the Modal side requires a
// `proposals[].options[]` array, so we tell Qwen to emit two
// throwaway options and ignore them server-side.
//
// Pilot authorization: issued per call with `operation:
// GENERATE_DRAFT_QUESTIONS` (the only generate-side operation Modal
// accepts) and `scope: "metadata:<versionId>"` so audit + replay
// can distinguish metadata calls from question-generation calls.

import { randomBytes } from "node:crypto";
import {
  callModalGenerate,
  type ModalGenerateInput,
} from "@/lib/hr/training/generation/modal-client";
import {
  issuePilotAuthorization,
  ENV_FINGERPRINT_SECRET,
} from "@/lib/hr/training/modal-shared";

export interface QwenMetadataInput {
  readonly clubId: string;
  readonly courseId: string;
  readonly courseVersionId: string;
  readonly sourceVideoSha256: string;
  readonly resolvedTranscriptBuildId: string;
  readonly approvedGroundingProjectionSha256: string;
  /** Flat transcript text used as the Qwen input. Caller is expected
   *  to have already filtered pending-review / hallucination segments
   *  before flattening. */
  readonly transcriptText: string;
  /** Short club name for prompt framing. Optional. */
  readonly clubName?: string;
}

export interface QwenMetadataResult {
  readonly title: string;
  readonly description: string;
  readonly modalRequestId: string;
  readonly modalElapsedMsTotal: number;
  readonly modalPromptTokens: number;
  readonly modalOutputTokens: number;
}

const QWEN_PLACEHOLDER_GROUNDING_SHA_FOR_METADATA_PRECOMPUTE = "a".repeat(64);

function buildMetadataSystemPrompt(clubName?: string): string {
  const who = clubName
    ? `the ${clubName} team — a private club`
    : "a private country-club team";
  return [
    `You are helping prepare a staff training course for ${who}.`,
    "",
    "The user will provide a flat transcript of the course video.",
    "You must propose course metadata by returning EXACTLY ONE proposal",
    "formatted as a JSON object inside the required `proposals` array.",
    "",
    "The proposal fields are REPURPOSED for metadata:",
    "- questionType: MUST be \"SINGLE_CHOICE\".",
    "- questionText: the course title. Concise, professional, Title",
    "  Case, 3-10 words, 10-80 characters. NO leading verb like",
    "  \"Welcome to\" or \"Introduction to\". Represent the actual",
    "  subject of the course (e.g. \"Workplace Safety Orientation\").",
    "- options: emit exactly 2 placeholder options",
    "  [{\"text\":\"placeholder-a\",\"isCorrect\":true},",
    "   {\"text\":\"placeholder-b\",\"isCorrect\":false}].",
    "  These are discarded by the caller and do not become visible.",
    "- explanation: the course description. 1-3 complete sentences.",
    "  Describe the key learning objectives the course covers.",
    "  120-320 characters. Executive, not promotional.",
    "- sourceSegmentIds: an array of up to 5 integer segment indices",
    "  from the transcript that most strongly anchor the title.",
    "",
    "Return ONLY valid JSON matching the proposals schema. Do not add",
    "commentary or markdown around the JSON.",
  ].join("\n");
}

function sanitiseTitle(raw: string): string {
  const trimmed = raw.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
  const noQuotes = trimmed.replace(/^["']+|["']+$/g, "");
  const noTrailingPunct = noQuotes.replace(/[.!?,;:]+$/g, "");
  return noTrailingPunct.slice(0, 80);
}

function sanitiseDescription(raw: string): string {
  const trimmed = raw.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
  return trimmed.slice(0, 320);
}

/** Perform one Modal GENERATE call tuned for course metadata.
 *  Returns parsed title + description or throws on failure. */
export async function callQwenForCourseMetadata(
  input: QwenMetadataInput,
  opts: {
    readonly fetchImpl?: typeof fetch;
    readonly env?: NodeJS.ProcessEnv;
  } = {},
): Promise<QwenMetadataResult> {
  const env = opts.env ?? process.env;
  const fingerprintSecret = env[ENV_FINGERPRINT_SECRET];
  if (!fingerprintSecret) {
    throw new Error(
      `[qwen-metadata] missing ${ENV_FINGERPRINT_SECRET} — refusing to call Modal without fingerprint secret.`,
    );
  }

  const requestId = `md-${input.courseVersionId}-${randomBytes(10).toString("hex")}`;
  const pilotAuth = issuePilotAuthorization({
    tenantId: input.clubId,
    courseId: `course:${input.courseId}`,
    versionId: input.courseVersionId,
    sourceVideoSha256: input.sourceVideoSha256,
    resolvedTranscriptBuildId: input.resolvedTranscriptBuildId,
    approvedGroundingProjectionSha256:
      input.approvedGroundingProjectionSha256 ??
      QWEN_PLACEHOLDER_GROUNDING_SHA_FOR_METADATA_PRECOMPUTE,
    operation: "GENERATE_DRAFT_QUESTIONS",
    maxRequestedQuestions: 1,
    pilotRestrictions: {
      publicationProhibited: true,
      employeeAssignmentProhibited: true,
      databaseWritesProhibited: false,
      automaticRetriesProhibited: true,
      excludedSegmentIds: [],
      scope: `metadata:${input.courseVersionId}`,
    },
    ttlSec: 3600,
    issuedBy: `system:training-metadata:${input.clubId}`,
    fingerprintSecret,
  });

  const call: ModalGenerateInput = {
    requestId,
    pilotAuthorization: pilotAuth,
    modelVariant: "qwen-2.5-7b-instruct-awq",
    systemPrompt: buildMetadataSystemPrompt(input.clubName),
    transcript: input.transcriptText,
    constraints: {
      // QUESTION_CHECKPOINT_BOUND is one of the two allowed values.
      // Modal doesn't branch on this field — it's enforced by the
      // enum on the auth payload only. We tag metadata calls via the
      // pilotRestrictions.scope above; `proposalKind` here is
      // required by the schema but behaviourally benign.
      proposalKind: "QUESTION_CHECKPOINT_BOUND",
      maxQuestions: 1,
      allowedQuestionTypes: ["SINGLE_CHOICE"],
      jsonSchema: {},
    },
  };

  const resp = await callModalGenerate(call, {
    fetchImpl: opts.fetchImpl,
    env: opts.env,
  });

  const proposal = resp.proposals?.[0];
  if (!proposal || typeof proposal.questionText !== "string") {
    throw new Error(
      `[qwen-metadata] Modal returned no usable proposal (proposals=${resp.proposals?.length ?? 0}).`,
    );
  }
  const title = sanitiseTitle(proposal.questionText);
  const description = sanitiseDescription(
    typeof proposal.explanation === "string" ? proposal.explanation : "",
  );
  if (title.length < 3) {
    throw new Error(
      `[qwen-metadata] Modal produced an empty or too-short title (got ${JSON.stringify(proposal.questionText)}).`,
    );
  }
  if (description.length < 10) {
    throw new Error(
      `[qwen-metadata] Modal produced an empty or too-short description (got ${JSON.stringify(proposal.explanation)}).`,
    );
  }
  return {
    title,
    description,
    modalRequestId: requestId,
    modalElapsedMsTotal:
      (resp.elapsedMs?.coldBoot ?? 0) + (resp.elapsedMs?.generate ?? 0),
    modalPromptTokens: resp.tokenCounts?.prompt ?? 0,
    modalOutputTokens: resp.tokenCounts?.output ?? 0,
  };
}

// Exported for unit tests — asserts basic prompt invariants.
export const __test__ = {
  buildMetadataSystemPrompt,
  sanitiseTitle,
  sanitiseDescription,
};
