// EP-TRAIN-6D-4W — Modal /generate client contract tests. Fully mocked
// fetch. Zero Modal network call.

import { afterEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import {
  callModalGenerate,
  ModalGenerateClientError,
  PROPOSAL_SCHEMA_VERSION,
} from "@/lib/hr/training/generation/modal-client";

const URL = "https://modal.example/generate";
const TOKEN = "shared-token";

function signed(body: Record<string, unknown>): Response {
  const text = JSON.stringify(body);
  const sig = createHmac("sha256", TOKEN).update(text).digest("base64");
  return new Response(text, {
    status: 200,
    headers: { "content-type": "application/json", "x-spectre-signature": sig },
  });
}

const GOOD = {
  schemaVersion: PROPOSAL_SCHEMA_VERSION,
  modelVariant: "qwen-2.5-7b-instruct-awq",
  proposals: [
    {
      questionType: "SINGLE_CHOICE",
      questionText: "What is the escalation policy?",
      options: [
        { text: "Confront", isCorrect: false },
        { text: "Notify manager", isCorrect: true },
      ],
      explanation: "e",
      sourceSegmentIds: [0, 1],
    },
  ],
  elapsedMs: { coldBoot: 1000, generate: 2000 },
  tokenCounts: { prompt: 500, output: 100 },
};

afterEach(() => vi.restoreAllMocks());

describe("EP-TRAIN-6D-4W — Modal /generate client", () => {
  it("fail-closed when credentials absent", async () => {
    await expect(
      callModalGenerate(
        {
          requestId: "r",
          modelVariant: "x",
          promptSchemaVersion: PROPOSAL_SCHEMA_VERSION,
          systemPrompt: "p",
          transcript: "t",
          constraints: { proposalKind: "QUESTION_FINAL_ASSESSMENT", maxQuestions: 1, allowedQuestionTypes: ["SINGLE_CHOICE"], jsonSchema: {} },
        },
        { env: {} },
      ),
    ).rejects.toMatchObject({ code: "CREDENTIAL_ABSENT" });
  });

  it("happy path returns a verified body", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(signed(GOOD));
    const r = await callModalGenerate(
      {
        requestId: "r", modelVariant: "x", promptSchemaVersion: PROPOSAL_SCHEMA_VERSION,
        systemPrompt: "p", transcript: "t",
        constraints: { proposalKind: "QUESTION_FINAL_ASSESSMENT", maxQuestions: 1, allowedQuestionTypes: ["SINGLE_CHOICE"], jsonSchema: {} },
      },
      { env: { MODAL_GENERATE_URL: URL, MODAL_SPECTRE_SHARED_TOKEN: TOKEN }, fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(r.proposals.length).toBe(1);
  });

  it("non-2xx -> MODAL_HTTP_ERROR", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("err", { status: 502 }));
    await expect(
      callModalGenerate(
        {
          requestId: "r", modelVariant: "x", promptSchemaVersion: PROPOSAL_SCHEMA_VERSION,
          systemPrompt: "p", transcript: "t",
          constraints: { proposalKind: "QUESTION_FINAL_ASSESSMENT", maxQuestions: 1, allowedQuestionTypes: ["SINGLE_CHOICE"], jsonSchema: {} },
        },
        { env: { MODAL_GENERATE_URL: URL, MODAL_SPECTRE_SHARED_TOKEN: TOKEN }, fetchImpl: fetchImpl as unknown as typeof fetch },
      ),
    ).rejects.toMatchObject({ code: "MODAL_HTTP_ERROR" });
  });

  it("missing HMAC -> MODAL_HMAC_INVALID", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(GOOD), { status: 200, headers: { "content-type": "application/json" } }),
    );
    await expect(
      callModalGenerate(
        {
          requestId: "r", modelVariant: "x", promptSchemaVersion: PROPOSAL_SCHEMA_VERSION,
          systemPrompt: "p", transcript: "t",
          constraints: { proposalKind: "QUESTION_FINAL_ASSESSMENT", maxQuestions: 1, allowedQuestionTypes: ["SINGLE_CHOICE"], jsonSchema: {} },
        },
        { env: { MODAL_GENERATE_URL: URL, MODAL_SPECTRE_SHARED_TOKEN: TOKEN }, fetchImpl: fetchImpl as unknown as typeof fetch },
      ),
    ).rejects.toMatchObject({ code: "MODAL_HMAC_INVALID" });
  });

  it("wrong schemaVersion -> MODAL_BODY_INVALID", async () => {
    const bad = { ...GOOD, schemaVersion: "training-proposals-v2" };
    const fetchImpl = vi.fn().mockResolvedValue(signed(bad));
    await expect(
      callModalGenerate(
        {
          requestId: "r", modelVariant: "x", promptSchemaVersion: PROPOSAL_SCHEMA_VERSION,
          systemPrompt: "p", transcript: "t",
          constraints: { proposalKind: "QUESTION_FINAL_ASSESSMENT", maxQuestions: 1, allowedQuestionTypes: ["SINGLE_CHOICE"], jsonSchema: {} },
        },
        { env: { MODAL_GENERATE_URL: URL, MODAL_SPECTRE_SHARED_TOKEN: TOKEN }, fetchImpl: fetchImpl as unknown as typeof fetch },
      ),
    ).rejects.toMatchObject({ code: "MODAL_BODY_INVALID" });
  });

  it("invalid proposal shape -> MODAL_BODY_INVALID", async () => {
    const bad = { ...GOOD, proposals: [{ questionText: "no options" }] };
    const fetchImpl = vi.fn().mockResolvedValue(signed(bad));
    await expect(
      callModalGenerate(
        {
          requestId: "r", modelVariant: "x", promptSchemaVersion: PROPOSAL_SCHEMA_VERSION,
          systemPrompt: "p", transcript: "t",
          constraints: { proposalKind: "QUESTION_FINAL_ASSESSMENT", maxQuestions: 1, allowedQuestionTypes: ["SINGLE_CHOICE"], jsonSchema: {} },
        },
        { env: { MODAL_GENERATE_URL: URL, MODAL_SPECTRE_SHARED_TOKEN: TOKEN }, fetchImpl: fetchImpl as unknown as typeof fetch },
      ),
    ).rejects.toMatchObject({ code: "MODAL_BODY_INVALID" });
  });

  it("timeout -> MODAL_TIMEOUT", async () => {
    const fetchImpl = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          const e = new Error("aborted");
          (e as Error & { name: string }).name = "AbortError";
          reject(e);
        });
      });
    });
    await expect(
      callModalGenerate(
        {
          requestId: "r", modelVariant: "x", promptSchemaVersion: PROPOSAL_SCHEMA_VERSION,
          systemPrompt: "p", transcript: "t",
          constraints: { proposalKind: "QUESTION_FINAL_ASSESSMENT", maxQuestions: 1, allowedQuestionTypes: ["SINGLE_CHOICE"], jsonSchema: {} },
        },
        { env: { MODAL_GENERATE_URL: URL, MODAL_SPECTRE_SHARED_TOKEN: TOKEN }, fetchImpl: fetchImpl as unknown as typeof fetch, timeoutMs: 20 },
      ),
    ).rejects.toMatchObject({ code: "MODAL_TIMEOUT" });
  });
});
