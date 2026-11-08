// EP-TRAIN-4Y-K §6 — dedicated round-trip regression: Python
// production `sign_response` → TypeScript production
// `verifyResponseSignature`, with realistic Whisper-shaped bodies
// that include whole-number floats (segment boundaries on exact
// seconds, confidence at clamp endpoints).
//
// Complements the fixture-based cross-language suite
// (tests/ep-train-4yb-cross-language.test.ts) by:
//  - exercising the FULL Python-signer → TS-verifier pipeline live
//    (not just comparing to a pre-computed fixture), and
//  - covering the exact failure modes that would regress the fix:
//    attacker tampering with body, signature, httpStatus, requestId,
//    or operation.
//
// Entirely local; zero Modal / Fly inference; no secrets exposed.

import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import {
  verifyResponseSignature,
} from "../src/lib/hr/training/modal-shared/response-verifier";
import { ModalContractError } from "../src/lib/hr/training/modal-shared";

const OP = "spectre.training.transcribe.v1";
const KEY = "ep-train-4y-k-roundtrip-not-a-real-secret-abcdef012345";

/** Serialise a value using Python's native `json.dumps` — this is what
 *  Modal actually puts on the wire. Whole-integer JS numbers that
 *  should be floats get coerced by `parse_int=float` so the Python-side
 *  body mirrors the Whisper response shape. */
function pySerialiseFloats(value: unknown): string {
  return execFileSync(
    "python",
    [
      "-c",
      `
import sys, json
parsed = json.loads(sys.stdin.read(), parse_int=float)
print(json.dumps(parsed, separators=(",", ":"), ensure_ascii=False))
`,
    ],
    { input: JSON.stringify(value), encoding: "utf-8" },
  ).trim();
}

/** Serialise a value with Python preserving ints as ints (for cases
 *  where we want specific fields to remain int rather than all-float). */
function pySerialiseExact(value: unknown): string {
  return execFileSync(
    "python",
    ["-c", `import sys, json; print(json.dumps(json.loads(sys.stdin.read()), separators=(",", ":"), ensure_ascii=False))`],
    { input: JSON.stringify(value), encoding: "utf-8" },
  ).trim();
}

/** Call production `modal_endpoints.shared.auth.sign_response` on a body. */
function pySignResponse(
  bodyText: string,
  opts: { operation: string; requestId: string; httpStatus: number; key: string },
): Record<string, string> {
  const out = execFileSync(
    "python",
    [
      "-c",
      `
import sys, json
sys.path.insert(0, ".")
from modal_endpoints.shared.auth import sign_response
hdrs = sign_response(
    operation=sys.argv[1],
    request_id=sys.argv[2],
    http_status=int(sys.argv[3]),
    body_text=sys.stdin.read(),
    response_hmac_key=sys.argv[4].encode("utf-8"),
)
print(json.dumps(hdrs))`,
      opts.operation, opts.requestId, String(opts.httpStatus), opts.key,
    ],
    { input: bodyText, encoding: "utf-8" },
  ).trim();
  return JSON.parse(out);
}

describe("EP-TRAIN-4Y-K — Python sign_response → TS verifyResponseSignature round-trip", () => {
  // Fail fast if Python or the shared module are missing.
  beforeAll(() => {
    try {
      execFileSync("python", ["-c", "import modal_endpoints.shared.auth"], {
        encoding: "utf-8", stdio: ["ignore", "ignore", "pipe"],
      });
    } catch (e) {
      throw new Error(`Python + modal_endpoints not importable: ${(e as Error).message}`);
    }
  });

  it("K1 — realistic Whisper response with whole-number float segments verifies end-to-end", () => {
    const rid = "r-k1-whole-float";
    const resp = {
      contractVersion: "4yb-v1",
      operation: OP,
      requestId: rid,
      modelVariant: "faster-whisper-large-v3",
      durationSec: 642,          // ← coerced to 642.0 by pySerialiseFloats
      audioSha256: "a".repeat(64),
      segments: [
        { id: 0, startSec: 0, endSec: 2, text: "welcome to orientation", avgConfidence: 1 },
        { id: 1, startSec: 2, endSec: 4.52, text: "today we review standards", avgConfidence: 0.93 },
      ],
      elapsedMs: { coldBoot: 10000, transcribe: 105700 },
    };
    const bodyText = pySerialiseFloats(resp);
    // Sanity check — body should actually contain `.0` floats (what
    // Modal puts on the wire). If this assertion fails the test lost
    // its reproduction of the bug.
    expect(bodyText).toContain("0.0");
    expect(bodyText).toContain("642.0");

    const hdrs = pySignResponse(bodyText, {
      operation: OP, requestId: rid, httpStatus: 200, key: KEY,
    });

    const parsed = verifyResponseSignature({
      headers: hdrs,
      bodyText,
      expectedOperation: OP,
      expectedRequestId: rid,
      httpStatus: 200,
      responseHmacKey: KEY,
    });
    expect(parsed).toBeTruthy();
    expect((parsed as { requestId: string }).requestId).toBe(rid);
  });

  it("K2 — empty transcript (durationSec:0.0, zero segments) verifies", () => {
    const rid = "r-k2-empty";
    const resp = {
      contractVersion: "4yb-v1",
      operation: OP,
      requestId: rid,
      modelVariant: "faster-whisper-large-v3",
      durationSec: 0,             // ← becomes 0.0 on the wire
      audioSha256: "b".repeat(64),
      segments: [],
      elapsedMs: { coldBoot: 1000, transcribe: 0 },
    };
    const bodyText = pySerialiseFloats(resp);
    const hdrs = pySignResponse(bodyText, {
      operation: OP, requestId: rid, httpStatus: 200, key: KEY,
    });
    const parsed = verifyResponseSignature({
      headers: hdrs, bodyText,
      expectedOperation: OP, expectedRequestId: rid,
      httpStatus: 200, responseHmacKey: KEY,
    });
    expect(parsed).toBeTruthy();
  });

  it("K3 — Unicode transcript (U+2028, U+2029, non-BMP emoji) verifies byte-identically", () => {
    const rid = "r-k3-unicode";
    const resp = {
      contractVersion: "4yb-v1",
      operation: OP,
      requestId: rid,
      modelVariant: "faster-whisper-large-v3",
      durationSec: 10,
      audioSha256: "c".repeat(64),
      segments: [
        { id: 0, startSec: 0, endSec: 10,
          text: "line sep paragraph ready 😀",
          avgConfidence: 1 },
      ],
      elapsedMs: { coldBoot: 100, transcribe: 100 },
    };
    const bodyText = pySerialiseFloats(resp);
    const hdrs = pySignResponse(bodyText, {
      operation: OP, requestId: rid, httpStatus: 200, key: KEY,
    });
    const parsed = verifyResponseSignature({
      headers: hdrs, bodyText,
      expectedOperation: OP, expectedRequestId: rid,
      httpStatus: 200, responseHmacKey: KEY,
    });
    expect(parsed).toBeTruthy();
  });

  it("K4 — signed ERROR response (500) verifies and TS accepts failure code from signed header", () => {
    const rid = "r-k4-error";
    const resp = {
      contractVersion: "4yb-v1",
      operation: OP,
      requestId: rid,
      error: { code: "REQUEST_BODY_INVALID", message: "something went wrong" },
    };
    const bodyText = pySerialiseExact(resp);  // no whole-float coercion
    const hdrs = pySignResponse(bodyText, {
      operation: OP, requestId: rid, httpStatus: 500, key: KEY,
    });
    const parsed = verifyResponseSignature({
      headers: hdrs, bodyText,
      expectedOperation: OP, expectedRequestId: rid,
      httpStatus: 500, responseHmacKey: KEY,
    });
    expect(parsed).toBeTruthy();
  });

  // ─── tamper variants ──────────────────────────────────────────────

  it("K5 — body tamper (single byte mutation) triggers MODAL_HMAC_INVALID", () => {
    const rid = "r-k5-body-tamper";
    const resp = { contractVersion: "4yb-v1", operation: OP, requestId: rid, audioSha256: "d".repeat(64), segments: [], elapsedMs: { coldBoot: 0, transcribe: 0 }, modelVariant: "x", durationSec: 0 };
    const bodyText = pySerialiseFloats(resp);
    const hdrs = pySignResponse(bodyText, { operation: OP, requestId: rid, httpStatus: 200, key: KEY });
    // Mutate one byte of the body AFTER signing.
    const tampered = bodyText.replace("audioSha256", "audioSHA256");
    expect(() =>
      verifyResponseSignature({
        headers: hdrs, bodyText: tampered,
        expectedOperation: OP, expectedRequestId: rid,
        httpStatus: 200, responseHmacKey: KEY,
      }),
    ).toThrow(ModalContractError);
  });

  it("K6 — signature tamper triggers MODAL_HMAC_INVALID", () => {
    const rid = "r-k6-sig-tamper";
    const resp = { contractVersion: "4yb-v1", operation: OP, requestId: rid, audioSha256: "e".repeat(64), segments: [], elapsedMs: { coldBoot: 0, transcribe: 0 }, modelVariant: "x", durationSec: 0 };
    const bodyText = pySerialiseFloats(resp);
    const hdrs = pySignResponse(bodyText, { operation: OP, requestId: rid, httpStatus: 200, key: KEY });
    const tampered = {
      ...hdrs,
      "x-spectre-response-signature": hdrs["x-spectre-response-signature"].slice(0, -1) + (hdrs["x-spectre-response-signature"].endsWith("A") ? "B" : "A"),
    };
    expect(() =>
      verifyResponseSignature({
        headers: tampered, bodyText,
        expectedOperation: OP, expectedRequestId: rid,
        httpStatus: 200, responseHmacKey: KEY,
      }),
    ).toThrow(ModalContractError);
  });

  it("K7 — httpStatus substitution (200→500) triggers MODAL_HMAC_INVALID", () => {
    const rid = "r-k7-status-tamper";
    const resp = { contractVersion: "4yb-v1", operation: OP, requestId: rid, audioSha256: "f".repeat(64), segments: [], elapsedMs: { coldBoot: 0, transcribe: 0 }, modelVariant: "x", durationSec: 0 };
    const bodyText = pySerialiseFloats(resp);
    const hdrs = pySignResponse(bodyText, { operation: OP, requestId: rid, httpStatus: 200, key: KEY });
    // Attacker swaps the 200 for 500 but keeps the 200-signed signature.
    expect(() =>
      verifyResponseSignature({
        headers: hdrs, bodyText,
        expectedOperation: OP, expectedRequestId: rid,
        httpStatus: 500,         // ← mismatched status
        responseHmacKey: KEY,
      }),
    ).toThrow(ModalContractError);
  });

  it("K8 — requestId mismatch triggers RESPONSE_REQUEST_ID_MISMATCH before HMAC check", () => {
    const signedRid = "r-k8-signed-rid";
    const resp = { contractVersion: "4yb-v1", operation: OP, requestId: signedRid, audioSha256: "9".repeat(64), segments: [], elapsedMs: { coldBoot: 0, transcribe: 0 }, modelVariant: "x", durationSec: 0 };
    const bodyText = pySerialiseFloats(resp);
    const hdrs = pySignResponse(bodyText, { operation: OP, requestId: signedRid, httpStatus: 200, key: KEY });
    expect(() =>
      verifyResponseSignature({
        headers: hdrs, bodyText,
        expectedOperation: OP,
        expectedRequestId: "r-k8-expected-different-rid",
        httpStatus: 200, responseHmacKey: KEY,
      }),
    ).toThrow(/RESPONSE_REQUEST_ID_MISMATCH|request-id/i);
  });

  it("K9 — operation mismatch triggers RESPONSE_OPERATION_MISMATCH", () => {
    const rid = "r-k9-op-tamper";
    const resp = { contractVersion: "4yb-v1", operation: OP, requestId: rid, audioSha256: "1".repeat(64), segments: [], elapsedMs: { coldBoot: 0, transcribe: 0 }, modelVariant: "x", durationSec: 0 };
    const bodyText = pySerialiseFloats(resp);
    const hdrs = pySignResponse(bodyText, { operation: OP, requestId: rid, httpStatus: 200, key: KEY });
    expect(() =>
      verifyResponseSignature({
        headers: hdrs, bodyText,
        expectedOperation: "spectre.training.generate.v1",   // ← wrong
        expectedRequestId: rid, httpStatus: 200, responseHmacKey: KEY,
      }),
    ).toThrow(/RESPONSE_OPERATION_MISMATCH|operation/i);
  });

  it("K10 — wrong secret triggers MODAL_HMAC_INVALID (worker-key / Modal-secret divergence)", () => {
    const rid = "r-k10-wrong-key";
    const resp = { contractVersion: "4yb-v1", operation: OP, requestId: rid, audioSha256: "2".repeat(64), segments: [], elapsedMs: { coldBoot: 0, transcribe: 0 }, modelVariant: "x", durationSec: 0 };
    const bodyText = pySerialiseFloats(resp);
    const hdrs = pySignResponse(bodyText, { operation: OP, requestId: rid, httpStatus: 200, key: KEY });
    expect(() =>
      verifyResponseSignature({
        headers: hdrs, bodyText,
        expectedOperation: OP, expectedRequestId: rid,
        httpStatus: 200,
        responseHmacKey: "a-DIFFERENT-key-than-Python-used",
      }),
    ).toThrow(ModalContractError);
  });
});
