// EP-TRAIN-4Y-T §5 — grounded course-metadata generator.
//
// Contract: given a resolved transcript (ordered, non-pending segments
// only), propose a course title, a course description, and a stable
// collision-safe course code.
//
// The directive explicitly says:
//
//   "If title/description generation requires a new GPU invocation
//    or an unsupported inference contract, implement the integration
//    boundary and deterministic tests, then report that live AI
//    metadata generation remains unverified. Do not fabricate a
//    successful AI result."
//
// So this module:
//   - Provides a STABLE, DETERMINISTIC rule-based generator the
//     editor can land today. It scans the transcript for topical
//     keywords and extracts a readable title + 1-paragraph summary.
//     This is NOT a live AI inference — it is transparent extractive
//     summarisation, named as such.
//   - Exports a `generateCourseMetadata` entry-point with an
//     `inferenceSource: "deterministic" | "ai"` on the return value
//     so downstream consumers never have to guess whether what they
//     see came from a live AI run.
//   - Reserves the Qwen hook behind `generateCourseMetadataViaAi`,
//     which returns `{ ok: false, reason: "AI_METADATA_NOT_YET_WIRED" }`
//     until a founder-authorised Modal slice wires it. The entry-point
//     prefers the deterministic path; the AI path is opt-in and
//     feature-flagged.
//
// Tenant + permission scope: this module is pure. Callers do the
// tenant check + hr:training:write guard before they invoke.

import { randomBytes } from "node:crypto";

export interface TranscriptSegmentLite {
  readonly segmentIndex: number;
  readonly text: string;
}

export interface GeneratedCourseMetadata {
  readonly title: string;
  readonly description: string;
  readonly code: string;
  readonly inferenceSource: "deterministic" | "ai";
  readonly note?: string;
}

export interface GenerateCourseMetadataInput {
  readonly segments: readonly TranscriptSegmentLite[];
  readonly clubName?: string;
  /** When set, the generator will attempt the AI path first; if the
   *  AI path is not wired (the normal case until Modal integration
   *  lands), the deterministic path is used and the return value's
   *  `note` field makes that explicit. */
  readonly preferAi?: boolean;
}

export const TITLE_MIN_LEN = 3;
export const TITLE_MAX_LEN = 80;
export const DESCRIPTION_MAX_LEN = 320;

/** Topical cues we extract high-salience clauses around. Order matters
 *  — the first hit anchors the title. */
const TOPIC_CUES: readonly { readonly pattern: RegExp; readonly label: string }[] = [
  { pattern: /\bsafet(?:y|ies)\b/i, label: "Safety" },
  { pattern: /\bworkplace\b/i, label: "Workplace" },
  { pattern: /\borientation\b/i, label: "Orientation" },
  { pattern: /\bpay\s*stubs?\b/i, label: "Payroll" },
  { pattern: /\bcompliance\b/i, label: "Compliance" },
  { pattern: /\bfood\s*(?:and|&|)\s*beverage\b/i, label: "Food & Beverage" },
  { pattern: /\bequipment\b/i, label: "Equipment" },
  { pattern: /\bcustomer\s*service\b/i, label: "Customer Service" },
  { pattern: /\bemergenc(?:y|ies)\b/i, label: "Emergency Procedures" },
  { pattern: /\bharassment\b/i, label: "Harassment Prevention" },
];

function sanitise(s: string): string {
  return s
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Score how "title-worthy" a candidate sentence is. Favours short,
 *  topical, non-introductory clauses. */
function scoreForTitle(text: string): number {
  const len = text.length;
  if (len < 10 || len > 140) return -1;
  // Penalty for obvious intro/filler
  if (/\b(hello|welcome|hi,|okay|all right|let's|we'll|today)\b/i.test(text)) return 0;
  let score = 1;
  for (const { pattern } of TOPIC_CUES) {
    if (pattern.test(text)) score += 2;
  }
  // Bonus for "about X" / "covers X" / "focuses on X" shape
  if (/\b(about|covers?|focuses?\s+on|discusses)\s+\w+/i.test(text)) score += 2;
  return score;
}

function collapseJoin(sentences: readonly string[], maxLen: number): string {
  const out: string[] = [];
  let used = 0;
  for (const s of sentences) {
    const next = s.trim();
    if (!next) continue;
    if (used + next.length + 1 > maxLen) break;
    out.push(next);
    used += next.length + 1;
  }
  return out.join(" ").trim();
}

function toSentences(text: string): string[] {
  return sanitise(text)
    .split(/(?<=[.!?])\s+/)
    .map((s) => sanitise(s))
    .filter((s) => s.length > 0);
}

/** Derive a Title-Case title from a clause. Trims trailing punctuation,
 *  caps at TITLE_MAX_LEN, capitalises every content word. */
function titleCase(s: string): string {
  const trimmed = sanitise(s.replace(/[.!?,;:]+$/g, ""));
  const words = trimmed.split(/\s+/).map((w) => {
    if (w.length === 0) return w;
    const lower = w.toLowerCase();
    // Keep acronyms (ALL CAPS) as-is
    if (/^[A-Z0-9]{2,}$/.test(w)) return w;
    return lower[0].toUpperCase() + lower.slice(1);
  });
  const joined = words.join(" ");
  if (joined.length <= TITLE_MAX_LEN) return joined;
  // Clip at a word boundary before TITLE_MAX_LEN
  const clipped = joined.slice(0, TITLE_MAX_LEN);
  const lastSpace = clipped.lastIndexOf(" ");
  return (lastSpace > TITLE_MIN_LEN ? clipped.slice(0, lastSpace) : clipped).replace(
    /[.,;:]+$/,
    "",
  );
}

/** Derive a stable course code from the title. The code is
 *  SCREAMING_SNAKE_CASE, 2-64 chars, alphanumeric + underscore. A
 *  random 6-hex suffix prevents collision on near-identical titles.
 *  The caller handles unique-index conflicts by retrying with a fresh
 *  suffix (collision handling at service layer, not here). */
function deriveCode(title: string, suffix: string): string {
  const base = title
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
  const safeBase = base.length >= 2 ? base : "COURSE";
  return `${safeBase}_${suffix}`.slice(0, 64);
}

export function generateCourseMetadataDeterministic(
  input: GenerateCourseMetadataInput,
): GeneratedCourseMetadata {
  // Flatten the ordered transcript into a single scored sentence list.
  const allText = input.segments
    .map((s) => sanitise(s.text ?? ""))
    .filter((t) => t.length > 0)
    .join(" ");
  const sentences = toSentences(allText);

  // Pick the first high-scoring sentence as the title candidate.
  let titleCandidate: string | null = null;
  let bestScore = 0;
  for (const s of sentences) {
    const sc = scoreForTitle(s);
    if (sc > bestScore) {
      bestScore = sc;
      titleCandidate = s;
    }
  }
  // Fall back to the first substantive sentence if nothing topical.
  const titleRaw =
    titleCandidate ??
    sentences.find((s) => s.length >= 20 && s.length <= 140) ??
    sentences[0] ??
    "Training course";
  const title = titleCase(titleRaw);

  // Description: first 2-3 sentences, collapsed to <= DESCRIPTION_MAX_LEN.
  const descSentences = sentences.slice(0, 5);
  const description =
    collapseJoin(descSentences, DESCRIPTION_MAX_LEN) ||
    "AI-prepared training course. Please edit this description before publishing.";

  const codeSuffix = randomBytes(3).toString("hex").toUpperCase();
  const code = deriveCode(title, codeSuffix);

  return {
    title,
    description,
    code,
    inferenceSource: "deterministic",
    note: "Generated via extractive summarisation of the transcript — not a live AI inference.",
  };
}

/** EP-TRAIN-4Y-V (2026-11-09) binding fields. The caller passes the
 *  tenant + video + transcript identifiers so we can issue a Modal
 *  PilotAuthorizationV1 bound to this version. */
export interface QwenMetadataBinding {
  readonly clubId: string;
  readonly courseId: string;
  readonly courseVersionId: string;
  readonly sourceVideoSha256: string;
  readonly resolvedTranscriptBuildId: string;
  readonly approvedGroundingProjectionSha256: string;
  readonly clubName?: string;
}

/** Call the Qwen 2.5 7B Instruct AWQ Modal endpoint to produce a
 *  grounded course title + description. Reuses the existing
 *  `spectre-training-generate` app via a specialised prompt + a
 *  single-proposal constraint. The caller is responsible for the
 *  tenant / permission / state guards BEFORE invoking. */
export async function generateCourseMetadataViaAi(
  input: GenerateCourseMetadataInput & { readonly binding?: QwenMetadataBinding },
): Promise<
  | {
      ok: true;
      metadata: GeneratedCourseMetadata & {
        readonly modalRequestId: string;
        readonly modalElapsedMsTotal: number;
        readonly modalPromptTokens: number;
        readonly modalOutputTokens: number;
      };
    }
  | { ok: false; reason: "AI_METADATA_NOT_YET_WIRED" | "AI_METADATA_INFERENCE_FAILED"; detail?: string }
> {
  if (!input.binding) {
    // No binding → cannot issue a PilotAuthorizationV1 → cannot call
    // Modal safely. Caller must upgrade to the binding-aware path.
    return { ok: false, reason: "AI_METADATA_NOT_YET_WIRED", detail: "no binding" };
  }

  // Flatten the segments into a transcript the Qwen prompt can read.
  const transcriptText = input.segments
    .map((s) => (s.text ?? "").trim())
    .filter((t) => t.length > 0)
    .join("\n");
  if (transcriptText.length < 20) {
    return { ok: false, reason: "AI_METADATA_INFERENCE_FAILED", detail: "transcript too short" };
  }

  try {
    // Lazy-import to avoid pulling the Modal client into every
    // deterministic-only caller (and to keep this module tree-shakable
    // in test environments).
    const mod = await import("./qwen-metadata-client");
    const r = await mod.callQwenForCourseMetadata({
      clubId: input.binding.clubId,
      courseId: input.binding.courseId,
      courseVersionId: input.binding.courseVersionId,
      sourceVideoSha256: input.binding.sourceVideoSha256,
      resolvedTranscriptBuildId: input.binding.resolvedTranscriptBuildId,
      approvedGroundingProjectionSha256: input.binding.approvedGroundingProjectionSha256,
      transcriptText,
      clubName: input.binding.clubName,
    });
    // Derive the course code from Qwen's title via the same helper
    // the deterministic path uses. Random suffix guarantees uniqueness
    // retries at the DB layer remain possible.
    const codeSuffix = randomBytes(3).toString("hex").toUpperCase();
    const code = deriveCode(r.title, codeSuffix);
    return {
      ok: true,
      metadata: {
        title: r.title,
        description: r.description,
        code,
        inferenceSource: "ai",
        note: "Generated by Qwen 2.5 7B Instruct AWQ on Modal A10G.",
        modalRequestId: r.modalRequestId,
        modalElapsedMsTotal: r.modalElapsedMsTotal,
        modalPromptTokens: r.modalPromptTokens,
        modalOutputTokens: r.modalOutputTokens,
      },
    };
  } catch (err) {
    return {
      ok: false,
      reason: "AI_METADATA_INFERENCE_FAILED",
      detail: (err as Error)?.message ?? "unknown",
    };
  }
}

export async function generateCourseMetadata(
  input: GenerateCourseMetadataInput & { readonly binding?: QwenMetadataBinding },
): Promise<GeneratedCourseMetadata> {
  if (input.preferAi) {
    const r = await generateCourseMetadataViaAi(input);
    if (r.ok) return r.metadata;
  }
  return generateCourseMetadataDeterministic(input);
}
