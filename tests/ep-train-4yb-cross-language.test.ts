// EP-TRAIN-4Y-B-VERIFY §4 — cross-language test vectors (TypeScript side).
//
// Loads tests/fixtures/ep-train-4yb-cross-language-vectors.json and
// asserts that the PRODUCTION TypeScript implementation (modal-shared
// canonicalise / request-signer / response-verifier / pilot-authorization)
// produces output byte-identical to the fixture's pre-computed values.
//
// The fixture was produced OFFLINE by `tests/fixtures/gen-cross-language-vectors.py`
// using Python stdlib JCS canonicalisation — NEVER using either
// production implementation. That makes this test a true third-party
// ground-truth check, not a self-comparison.
//
// The sibling Python suite (modal/tests/test_cross_language.py) loads
// the SAME fixture and runs the SAME assertions against the production
// Python implementation. If both pass, TS + Python are byte-compatible
// for every covered scenario.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { createHash, createHmac } from "node:crypto";
import * as path from "node:path";
import {
  canonicalise,
  sha256HexOfCanonicalSync,
  assertPrintableAscii,
} from "../src/lib/hr/training/modal-shared/canonicalise";
import { signRequest, verifyRequestSignature } from "../src/lib/hr/training/modal-shared/request-signer";
import { signResponse, verifyResponseSignature } from "../src/lib/hr/training/modal-shared/response-verifier";
import {
  verifyPilotAuthorizationFingerprint,
  type IssuePilotAuthorizationInput,
} from "../src/lib/hr/training/modal-shared/pilot-authorization";
import type {
  ModalRequestBody,
  PilotAuthorizationV1,
  OperationId,
} from "../src/lib/hr/training/modal-shared/types";
import { CONTRACT_VERSION } from "../src/lib/hr/training/modal-shared/types";

type Fixture = {
  fixtureVersion: string;
  contractVersion: string;
  canonicalisationVectors: Array<{
    name: string;
    description: string;
    input: unknown;
    expectedCanonical: string;
    expectedSha256Hex: string;
  }>;
  fingerprintVectors: Array<{
    name: string;
    description: string;
    input: { authWithoutFingerprint: Record<string, unknown>; fingerprintSecretB64: string };
    expectedCanonicalAuth: string;
    expectedFingerprint: string;
  }>;
  requestSigningVectors: Array<{
    name: string;
    description: string;
    input: {
      body: ModalRequestBody<Record<string, unknown>>;
      operation: OperationId;
      requestId: string;
      timestampSec: number;
      hmacKeyB64: string;
    };
    expectedCanonicalBody: string;
    expectedBodyDigest: string;
    expectedSignedMessage: string;
    expectedSignature: string;
  }>;
  responseSigningVectors: Array<{
    name: string;
    description: string;
    input: {
      responseBody: Record<string, unknown>;
      operation: OperationId;
      requestId: string;
      httpStatus: number;
      responseHmacKeyB64: string;
    };
    expectedCanonicalResponseBody: string;
    expectedResponseBodyDigest: string;
    expectedResponseSignedMessage: string;
    expectedResponseSignature: string;
  }>;
  timestampBoundaryVectors: Array<{
    name: string;
    signedTimestampSec: number;
    verifierNowSec: number;
    expectedValid: boolean;
  }>;
  tamperVectors: Array<Record<string, unknown>>;
  syntheticKeys: { hmacKeyB64: string; responseHmacKeyB64: string; fingerprintSecretB64: string };
};

const fixturePath = path.join(__dirname, "fixtures", "ep-train-4yb-cross-language-vectors.json");
const fixture: Fixture = JSON.parse(readFileSync(fixturePath, "utf8"));

function fromB64(s: string): Buffer {
  return Buffer.from(s, "base64");
}

describe("EP-TRAIN-4Y-B-VERIFY §4 — cross-language vectors (TypeScript)", () => {
  it("fixture is the versioned one this test is pinned against", () => {
    expect(fixture.fixtureVersion).toBe("4yk-v1");
    expect(fixture.contractVersion).toBe(CONTRACT_VERSION);
  });

  describe("canonicalisation", () => {
    for (const v of fixture.canonicalisationVectors) {
      it(`${v.name}: ${v.description}`, () => {
        const produced = canonicalise(v.input);
        expect(produced).toBe(v.expectedCanonical);
        expect(sha256HexOfCanonicalSync(v.input)).toBe(v.expectedSha256Hex);
      });
    }
  });

  describe("fingerprint", () => {
    for (const v of fixture.fingerprintVectors) {
      it(`${v.name}: ${v.description}`, () => {
        // Independent recomputation using the SAME secret.
        const key = fromB64(v.input.fingerprintSecretB64);
        const produced = createHmac("sha256", key)
          .update(canonicalise(v.input.authWithoutFingerprint), "utf-8")
          .digest("base64url");
        expect(canonicalise(v.input.authWithoutFingerprint)).toBe(v.expectedCanonicalAuth);
        expect(produced).toBe(v.expectedFingerprint);

        // And the production verifier accepts it.
        const auth = {
          ...(v.input.authWithoutFingerprint as unknown as PilotAuthorizationV1),
          fingerprint: produced,
        };
        expect(verifyPilotAuthorizationFingerprint(auth, key.toString("utf8"))).toBe(true);
      });
    }
  });

  describe("request signing", () => {
    for (const v of fixture.requestSigningVectors) {
      it(`${v.name}: ${v.description}`, () => {
        const key = fromB64(v.input.hmacKeyB64);
        const signed = signRequest({
          operation: v.input.operation,
          requestId: v.input.requestId,
          hmacKey: key.toString("utf8"),
          body: v.input.body,
          clock: { nowMs: () => v.input.timestampSec * 1000, nowUtcIso: () => new Date(v.input.timestampSec * 1000).toISOString() },
          timestampOverrideSec: v.input.timestampSec,
        });

        expect(signed.bodyText).toBe(v.expectedCanonicalBody);
        expect(signed.headers["x-spectre-body-digest"]).toBe(v.expectedBodyDigest);
        expect(signed.headers["x-spectre-signature"]).toBe(v.expectedSignature);

        // Round-trip verification via production verifier.
        const verify = verifyRequestSignature({
          headers: signed.headers as unknown as Record<string, string>,
          bodyText: signed.bodyText,
          hmacKey: key.toString("utf8"),
          clock: { nowMs: () => v.input.timestampSec * 1000, nowUtcIso: () => new Date(v.input.timestampSec * 1000).toISOString() },
          timestampSkewSec: 300,
        });
        expect(verify.ok).toBe(true);
      });
    }
  });

  describe("response signing", () => {
    for (const v of fixture.responseSigningVectors) {
      it(`${v.name}: ${v.description}`, () => {
        const key = fromB64(v.input.responseHmacKeyB64);
        const bodyText = canonicalise(v.input.responseBody);
        expect(bodyText).toBe(v.expectedCanonicalResponseBody);
        const bodyDigest = createHash("sha256").update(bodyText, "utf-8").digest("hex");
        expect(bodyDigest).toBe(v.expectedResponseBodyDigest);

        const hdrs = signResponse({
          operation: v.input.operation,
          requestId: v.input.requestId,
          httpStatus: v.input.httpStatus,
          bodyText,
          responseHmacKey: key.toString("utf8"),
        });
        expect(hdrs["x-spectre-response-signature"]).toBe(v.expectedResponseSignature);

        // Verify round-trip via production verifier.
        const parsed = verifyResponseSignature({
          headers: hdrs as unknown as Record<string, string>,
          bodyText,
          expectedOperation: v.input.operation,
          expectedRequestId: v.input.requestId,
          httpStatus: v.input.httpStatus,
          responseHmacKey: key.toString("utf8"),
        });
        expect(parsed).toBeTruthy();
      });
    }
  });

  describe("timestamp boundary", () => {
    for (const v of fixture.timestampBoundaryVectors) {
      it(`${v.name}: signedAt=${v.signedTimestampSec} verifierNow=${v.verifierNowSec} → ${v.expectedValid ? "ACCEPT" : "REJECT"}`, () => {
        // Build a minimal request at `signedTimestampSec`, then verify it
        // with `verifierNowSec` as the server clock. Use the TRANSCRIBE
        // operation since it accepts arbitrary bodies.
        const key = Buffer.from(fixture.syntheticKeys.hmacKeyB64, "base64").toString("utf8");
        const body = {
          contractVersion: "4yb-v1" as const,
          operation: "spectre.training.transcribe.v1" as const,
          requestId: "r-ts-boundary",
          timestamp: String(v.signedTimestampSec),
          pilotAuthorization: {} as unknown as PilotAuthorizationV1,
          payload: { audioUrl: "x", languageCode: "en", modelVariant: "x" },
        };
        const signed = signRequest({
          operation: "spectre.training.transcribe.v1",
          requestId: "r-ts-boundary",
          hmacKey: key,
          body,
          clock: { nowMs: () => v.signedTimestampSec * 1000, nowUtcIso: () => "" },
          timestampOverrideSec: v.signedTimestampSec,
        });
        const result = verifyRequestSignature({
          headers: signed.headers as unknown as Record<string, string>,
          bodyText: signed.bodyText,
          hmacKey: key,
          clock: { nowMs: () => v.verifierNowSec * 1000, nowUtcIso: () => "" },
          timestampSkewSec: 300,
        });
        if (v.expectedValid) {
          expect(result.ok).toBe(true);
        } else {
          expect(result.ok).toBe(false);
          if (!result.ok) expect(result.code).toBe("TIMESTAMP_SKEW_EXCEEDED");
        }
      });
    }
  });

  describe("tamper", () => {
    it("t1 — mutated body produces different sha256", () => {
      const original = sha256HexOfCanonicalSync({ a: 1, b: 2 });
      const mutated = sha256HexOfCanonicalSync({ a: 1, b: 3 });
      expect(original).not.toBe(mutated);
    });
    it("t2 — NaN rejected by canonicalise", () => {
      expect(() => canonicalise({ bad: Number.NaN })).toThrow();
      expect(() => canonicalise({ bad: Number.POSITIVE_INFINITY })).toThrow();
    });
    it("em-dash rejected by assertPrintableAscii (identity-scope)", () => {
      expect(() => assertPrintableAscii("pilotRestrictions.scope", "EP — em-dash")).toThrow();
    });
  });
});
