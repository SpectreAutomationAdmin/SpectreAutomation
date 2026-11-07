// EP-TRAIN-4Y-C §3 — signed-error-response verification.
//
// After this slice, the TS Modal clients verify response signatures
// on BOTH success and error responses when the signed-response
// headers are present. These tests exercise five behaviours:
//
//   C3-1 valid signed error response is classified by failure-code.
//   C3-2 TAMPERED signature on a signed error → MODAL_HMAC_INVALID,
//        not the failure-code header (attacker cannot forge codes).
//   C3-3 Unsigned non-2xx → MODAL_HTTP_ERROR regardless of
//        failure-code header (no header trust without signature).
//   C3-4 Signed error with WRONG requestId → RESPONSE_REQUEST_ID_MISMATCH.
//   C3-5 Signed error with TAMPERED body → MODAL_HMAC_INVALID.
//
// Together these prove §3 of the directive: the client validates
// response signatures for all applicable authenticated responses.

import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import {
  CONTRACT_VERSION,
  OPERATION_TRANSCRIBE,
  issuePilotAuthorization,
  signResponse,
  TRANSCRIBE_PLACEHOLDER_TRANSCRIPT_BUILD_ID,
  TRANSCRIBE_PLACEHOLDER_GROUNDING_SHA,
  ModalContractError,
  type Clock,
} from "../src/lib/hr/training/modal-shared";
import { callModalTranscribe } from "../src/lib/hr/training/transcription/modal-client";

const HMAC_KEY = "test-hmac-key-32-bytes-0000000000";
const FINGERPRINT = "test-fingerprint-secret-00000000";
const RESPONSE_KEY = "test-response-hmac-key-0000000000";
const URL = "https://mocked-modal.example/endpoint";

function fixedClock(nowMs: number = 1_765_000_000_000): Clock {
  return { nowMs: () => nowMs, nowUtcIso: () => new Date(nowMs).toISOString() };
}

function env() {
  return {
    MODAL_KEY: "k",
    MODAL_SECRET: "s",
    MODAL_SPECTRE_HMAC_KEY: HMAC_KEY,
    SPECTRE_PILOT_AUTH_FINGERPRINT_SECRET: FINGERPRINT,
    MODAL_SPECTRE_RESPONSE_HMAC_KEY: RESPONSE_KEY,
    MODAL_TRANSCRIBE_URL: URL,
    MODAL_GENERATE_URL: URL,
  } satisfies NodeJS.ProcessEnv;
}

function auth() {
  return issuePilotAuthorization({
    tenantId: "club-silver-springs",
    courseId: "course:v1",
    versionId: "v1",
    sourceVideoSha256: "d".repeat(64),
    resolvedTranscriptBuildId: TRANSCRIBE_PLACEHOLDER_TRANSCRIPT_BUILD_ID,
    approvedGroundingProjectionSha256: TRANSCRIBE_PLACEHOLDER_GROUNDING_SHA,
    operation: "TRANSCRIBE_VIDEO",
    maxRequestedQuestions: 1,
    pilotRestrictions: {
      publicationProhibited: true,
      employeeAssignmentProhibited: true,
      databaseWritesProhibited: false,
      automaticRetriesProhibited: false,
      excludedSegmentIds: [],
      scope: "c3-test",
    },
    ttlSec: 3600,
    issuedBy: "system:test",
    fingerprintSecret: FINGERPRINT,
    clock: fixedClock(),
  });
}

/** Build a fetch impl that always returns the given response, letting
 *  us construct arbitrary (headers, status, body) triples without
 *  going through the full mock server. */
function stubFetch(resp: { status: number; headers: Record<string, string>; body: string }): typeof fetch {
  return async () => new Response(resp.body, { status: resp.status, headers: resp.headers });
}

function signedErrorResponse(opts: {
  code: string;
  message?: string;
  requestId: string;
  status: number;
  tamperSignature?: boolean;
  tamperBody?: boolean;
  wrongRequestIdInSignature?: boolean;
}) {
  const body = {
    contractVersion: CONTRACT_VERSION,
    operation: OPERATION_TRANSCRIBE,
    requestId: opts.requestId,
    error: { code: opts.code, message: opts.message ?? "" },
  };
  const bodyText = JSON.stringify(body);
  const sigReqId = opts.wrongRequestIdInSignature ? opts.requestId + "-other" : opts.requestId;
  const sigHdrs = signResponse({
    operation: OPERATION_TRANSCRIBE,
    requestId: sigReqId,
    httpStatus: opts.status,
    bodyText,
    responseHmacKey: RESPONSE_KEY,
  });
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-spectre-failure-code": opts.code,
    ...sigHdrs,
  };
  if (opts.tamperSignature) {
    headers["x-spectre-response-signature"] = "X".repeat(43);
  }
  const finalBody = opts.tamperBody ? bodyText.replace(opts.code, "TAMPERED") : bodyText;
  return { status: opts.status, headers, body: finalBody };
}

describe("EP-TRAIN-4Y-C §3 — signed-error-response verification", () => {
  it("C3-1 — valid signed error response classified by failure-code", async () => {
    const requestId = "req-c3-1";
    const fetchImpl = stubFetch(
      signedErrorResponse({ code: "PILOT_AUTH_EXPIRED", requestId, status: 400 }),
    );
    await expect(
      callModalTranscribe(
        {
          requestId,
          audioUrl: "x",
          languageCode: "en",
          modelVariant: "x",
          pilotAuthorization: auth(),
        },
        { fetchImpl, env: env(), clock: fixedClock() },
      ),
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof ModalContractError && e.code === "PILOT_AUTH_EXPIRED",
    );
  });

  it("C3-2 — tampered signature on a signed error → MODAL_HMAC_INVALID", async () => {
    const requestId = "req-c3-2";
    const fetchImpl = stubFetch(
      signedErrorResponse({
        code: "PILOT_AUTH_EXPIRED",
        requestId,
        status: 400,
        tamperSignature: true,
      }),
    );
    await expect(
      callModalTranscribe(
        {
          requestId,
          audioUrl: "x",
          languageCode: "en",
          modelVariant: "x",
          pilotAuthorization: auth(),
        },
        { fetchImpl, env: env(), clock: fixedClock() },
      ),
    ).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof ModalContractError &&
        e.code === "MODAL_HMAC_INVALID",
      "attacker-forged failure-code must be rejected",
    );
  });

  it("C3-3 — unsigned non-2xx → MODAL_HTTP_ERROR, failure-code ignored", async () => {
    const requestId = "req-c3-3";
    // No signed-response headers at all.
    const fetchImpl = stubFetch({
      status: 500,
      headers: {
        "Content-Type": "application/json",
        "x-spectre-failure-code": "PILOT_AUTH_EXPIRED", // attacker-planted
      },
      body: JSON.stringify({ error: "unsigned" }),
    });
    await expect(
      callModalTranscribe(
        {
          requestId,
          audioUrl: "x",
          languageCode: "en",
          modelVariant: "x",
          pilotAuthorization: auth(),
        },
        { fetchImpl, env: env(), clock: fixedClock() },
      ),
    ).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof ModalContractError && e.code === "MODAL_HTTP_ERROR",
    );
  });

  it("C3-4 — signed error with WRONG requestId in signature → RESPONSE_REQUEST_ID_MISMATCH", async () => {
    const requestId = "req-c3-4";
    const fetchImpl = stubFetch(
      signedErrorResponse({
        code: "PILOT_AUTH_EXPIRED",
        requestId,
        status: 400,
        wrongRequestIdInSignature: true,
      }),
    );
    await expect(
      callModalTranscribe(
        {
          requestId,
          audioUrl: "x",
          languageCode: "en",
          modelVariant: "x",
          pilotAuthorization: auth(),
        },
        { fetchImpl, env: env(), clock: fixedClock() },
      ),
    ).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof ModalContractError &&
        e.code === "RESPONSE_REQUEST_ID_MISMATCH",
    );
  });

  it("C3-5 — signed error with TAMPERED body → MODAL_HMAC_INVALID", async () => {
    const requestId = "req-c3-5";
    const fetchImpl = stubFetch(
      signedErrorResponse({
        code: "PILOT_AUTH_EXPIRED",
        requestId,
        status: 400,
        tamperBody: true,
      }),
    );
    await expect(
      callModalTranscribe(
        {
          requestId,
          audioUrl: "x",
          languageCode: "en",
          modelVariant: "x",
          pilotAuthorization: auth(),
        },
        { fetchImpl, env: env(), clock: fixedClock() },
      ),
    ).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof ModalContractError &&
        e.code === "MODAL_HMAC_INVALID",
    );
  });

  it("C3-6 — network error (no response at all) → MODAL_HTTP_ERROR (safe handling preserved)", async () => {
    const fetchImpl: typeof fetch = async () => {
      throw new Error("ECONNREFUSED");
    };
    await expect(
      callModalTranscribe(
        {
          requestId: "req-c3-6",
          audioUrl: "x",
          languageCode: "en",
          modelVariant: "x",
          pilotAuthorization: auth(),
        },
        { fetchImpl, env: env(), clock: fixedClock() },
      ),
    ).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof ModalContractError && e.code === "MODAL_HTTP_ERROR",
      "network failures preserved as MODAL_HTTP_ERROR",
    );
  });
});
