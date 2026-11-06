// EP-TRAIN-6D-4W (2026-11-06) — Modal /generate HTTPS client (Qwen 2.5
// 7B Instruct AWQ with LM Format Enforcer).
//
// Mirrors the 4V transcription client's security envelope:
//   - Bearer token auth via MODAL_SPECTRE_SHARED_TOKEN.
//   - HMAC-SHA-256 response verification.
//   - Bounded wall-clock via AbortController.
//   - Classified error codes.
//   - No Modal network call in offline tests (fetch is injected).

import { createHmac, timingSafeEqual } from "node:crypto";

export const PROPOSAL_SCHEMA_VERSION = "training-proposals-v1" as const;

export interface ModalGenerateConstraints {
  readonly proposalKind: "QUESTION_CHECKPOINT_BOUND" | "QUESTION_FINAL_ASSESSMENT";
  readonly maxQuestions: number;
  readonly allowedQuestionTypes: readonly ("SINGLE_CHOICE" | "MULTI_ANSWER" | "TRUE_FALSE")[];
  readonly jsonSchema: Record<string, unknown>;
}

export interface ModalGenerateRequest {
  readonly requestId: string;
  readonly modelVariant: string;
  readonly promptSchemaVersion: typeof PROPOSAL_SCHEMA_VERSION;
  readonly systemPrompt: string;
  readonly transcript: string;
  readonly constraints: ModalGenerateConstraints;
}

export interface ModalGenerateOption {
  readonly text: string;
  readonly isCorrect: boolean;
}

export interface ModalGenerateProposal {
  readonly questionType: "SINGLE_CHOICE" | "MULTI_ANSWER" | "TRUE_FALSE";
  readonly questionText: string;
  readonly options: readonly ModalGenerateOption[];
  readonly explanation: string;
  readonly sourceSegmentIds: readonly number[];
}

export interface ModalGenerateResponse {
  readonly schemaVersion: typeof PROPOSAL_SCHEMA_VERSION;
  readonly modelVariant: string;
  readonly proposals: readonly ModalGenerateProposal[];
  readonly elapsedMs: { readonly coldBoot: number; readonly generate: number };
  readonly tokenCounts: { readonly prompt: number; readonly output: number };
}

export class ModalGenerateClientError extends Error {
  readonly code:
    | "MODAL_HTTP_ERROR"
    | "MODAL_TIMEOUT"
    | "MODAL_HMAC_INVALID"
    | "MODAL_BODY_INVALID"
    | "CREDENTIAL_ABSENT";
  constructor(code: ModalGenerateClientError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

export interface ModalGenerateClientOptions {
  readonly fetchImpl?: typeof fetch;
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
}

export async function callModalGenerate(
  request: ModalGenerateRequest,
  opts: ModalGenerateClientOptions = {},
): Promise<ModalGenerateResponse> {
  const env = opts.env ?? process.env;
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as typeof fetch);
  const url = env.MODAL_GENERATE_URL;
  const token = env.MODAL_SPECTRE_SHARED_TOKEN;

  if (!url || !token) {
    throw new ModalGenerateClientError("CREDENTIAL_ABSENT", "Modal generate credentials not configured.");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 10 * 60 * 1000);

  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(request),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if ((err as Error)?.name === "AbortError") {
      throw new ModalGenerateClientError("MODAL_TIMEOUT", "Modal request timed out.");
    }
    throw new ModalGenerateClientError("MODAL_HTTP_ERROR", `Modal request failed: ${(err as Error)?.message ?? String(err)}`);
  }
  clearTimeout(timer);

  if (!res.ok) {
    throw new ModalGenerateClientError("MODAL_HTTP_ERROR", `Modal returned HTTP ${res.status}.`);
  }

  const bodyText = await res.text();
  const signatureHeader = res.headers.get("x-spectre-signature");
  if (!signatureHeader) {
    throw new ModalGenerateClientError("MODAL_HMAC_INVALID", "Missing HMAC header.");
  }
  const expected = createHmac("sha256", token).update(bodyText, "utf-8").digest();
  let supplied: Buffer;
  try {
    supplied = Buffer.from(signatureHeader, "base64");
  } catch {
    throw new ModalGenerateClientError("MODAL_HMAC_INVALID", "HMAC not valid base64.");
  }
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    throw new ModalGenerateClientError("MODAL_HMAC_INVALID", "HMAC did not verify.");
  }

  let body: ModalGenerateResponse;
  try {
    body = JSON.parse(bodyText) as ModalGenerateResponse;
  } catch {
    throw new ModalGenerateClientError("MODAL_BODY_INVALID", "Response body is not valid JSON.");
  }
  if (body.schemaVersion !== PROPOSAL_SCHEMA_VERSION) {
    throw new ModalGenerateClientError("MODAL_BODY_INVALID", `Unexpected schemaVersion: ${body.schemaVersion}`);
  }
  if (!Array.isArray(body.proposals)) {
    throw new ModalGenerateClientError("MODAL_BODY_INVALID", "proposals is not an array.");
  }
  for (const p of body.proposals) {
    if (!p || typeof p.questionText !== "string" || !Array.isArray(p.options) || !Array.isArray(p.sourceSegmentIds)) {
      throw new ModalGenerateClientError("MODAL_BODY_INVALID", "proposal shape invalid.");
    }
  }
  return body;
}
