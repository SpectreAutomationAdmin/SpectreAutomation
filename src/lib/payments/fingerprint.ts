// PAY-1A (2026-09-26) — deterministic payment fingerprints.
//
// Distinct from `calculationFingerprint` (which asserts payroll
// arithmetic is frozen). `paymentFingerprint` asserts that Spectre
// is authorized to move a specific set of funds from a specific
// funding account to a specific set of destinations on a specific
// date. Any change to any material field invalidates authorization.

import { createHash } from "node:crypto";
import type {
  PaymentInstructionMaterialFields,
  PaymentRunMaterialFields,
} from "./types";

// Canonical stringification: sort keys, no whitespace, stable float
// representation. Never call JSON.stringify directly on a Decimal —
// callers must pass amount as a string.
function canonicalise(o: unknown): string {
  if (o === null || o === undefined) return "null";
  if (typeof o === "number") {
    // Financial figures MUST be passed as strings — reject accidental
    // number-typed money.
    throw new Error("PAY-1A fingerprint: numeric type not permitted — pass Decimal-safe strings.");
  }
  if (typeof o === "string" || typeof o === "boolean") return JSON.stringify(o);
  if (Array.isArray(o)) return "[" + o.map(canonicalise).join(",") + "]";
  if (typeof o === "object") {
    const keys = Object.keys(o as Record<string, unknown>).sort();
    return (
      "{" +
      keys
        .map((k) => JSON.stringify(k) + ":" + canonicalise((o as Record<string, unknown>)[k]))
        .join(",") +
      "}"
    );
  }
  throw new Error("PAY-1A fingerprint: unsupported value type " + typeof o);
}

function sha256Hex(canonical: string): string {
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

export function instructionFingerprint(fields: PaymentInstructionMaterialFields): string {
  return "ifp-v1-" + sha256Hex(canonicalise(fields));
}

export function paymentFingerprint(fields: PaymentRunMaterialFields): string {
  // Sort instructionFingerprints to make ordering irrelevant.
  const canonicalFields: PaymentRunMaterialFields = {
    ...fields,
    instructionFingerprints: [...fields.instructionFingerprints].sort(),
  };
  return "pfp-v1-" + sha256Hex(canonicalise(canonicalFields));
}
