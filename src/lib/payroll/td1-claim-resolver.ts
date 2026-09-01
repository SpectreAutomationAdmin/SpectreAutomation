// Payroll-3B-5B-2c CORRECTION (2026-09-01) — fail-closed TD1
// claim-value resolver used ONLY at batch preparation time.
//
// Rules (per the correction brief §9):
//
//   1. `claimZeroFederal` / `claimZeroProvincial === true` — skip
//      resolution entirely; the frozen numeric value is irrelevant
//      because the semantic boolean overrides in the calculator
//      (Scenario 4). Return { kind: "claimZero", value: "0" }.
//
//   2. Empty / null secretReference — the tax profile row exists
//      but has no protected value in this column. Treat as the
//      long-standing MISSING_*_TD1 warning path; return
//      { kind: "missing" } and let the caller emit its WARNING
//      + freeze the applicable BPA as the calculator default.
//
//   3. String starts with the canonical `enc:` KMS envelope prefix
//      → decrypt via the canonical `decryptSecret` service
//      (scope: "HR"). If decrypt throws OR the plaintext is not a
//      valid decimal → { kind: "decryptFailed" | "malformed" }.
//      On success → { kind: "resolved", value: plaintext }.
//
//   4. String is a bare decimal (test / transitional legacy value)
//      → parse and return { kind: "plainDecimal", value: input }.
//      Documented compromise while HR-side encryption rolls out;
//      NOT a silent behaviour — the caller can distinguish this
//      kind from `resolved` in audit / diagnostics.
//
//   5. Any other format (e.g. legacy "kms:test" placeholder that
//      never went through the canonical envelope) — the resolver
//      REFUSES with { kind: "unknownFormat" }. Batch preparation
//      converts this into a TD1_CLAIM_RESOLUTION_FAILED BLOCKER
//      per the correction brief §2 ("Never substitute … Fail closed").
//
// The resolver never logs plaintext or ciphertext. Callers are
// responsible for placing the resolved value into the protected
// `sourceFactsJson.tax` snapshot; the calculator later consumes
// ONLY that snapshot (see §4 — "resolve at preparation, not
// calculation").

import { decryptSecret, isEncryptedBlob, type KmsScope } from "../kms";

const SCOPE: KmsScope = "HR";
const DECIMAL_RE = /^-?\d+(\.\d+)?$/;

export type Td1ResolveKind =
  | "claimZero"
  | "missing"
  | "resolved"
  | "plainDecimal"
  | "decryptFailed"
  | "malformed"
  | "unknownFormat";

export interface Td1ResolveResult {
  kind: Td1ResolveKind;
  /** Frozen decimal string ready for `sourceFactsJson.tax`, when kind ∈ {resolved, plainDecimal, claimZero}. */
  value?: string;
  /** Non-sensitive audit label describing why resolution failed (kind ∈ {decryptFailed, malformed, unknownFormat}). No plaintext or ciphertext. */
  failureReason?: string;
}

export interface Td1ResolveInput {
  secretReference: string | null | undefined;
  ciphertext:      string | null | undefined;
  claimZero:       boolean;
}

/**
 * Resolve one TD1 claim column to a frozen numeric string.
 * NEVER falls back to a BPA / zero / prior value on decrypt failure.
 */
export async function resolveTd1ClaimAtPreparation(input: Td1ResolveInput): Promise<Td1ResolveResult> {
  if (input.claimZero) {
    // §8 — semantic override; numeric value is irrelevant.
    return { kind: "claimZero", value: "0" };
  }
  const raw = (input.ciphertext ?? "").trim();
  if (!raw) return { kind: "missing" };

  if (isEncryptedBlob(raw)) {
    const ref = input.secretReference?.trim() || "td1-claim";
    try {
      const plain = await decryptSecret({
        scope: SCOPE, secretReference: ref, ciphertext: raw,
      });
      if (!DECIMAL_RE.test(plain)) {
        return { kind: "malformed", failureReason: "decrypted TD1 claim is not a valid decimal string" };
      }
      return { kind: "resolved", value: plain };
    } catch (err) {
      // Do NOT propagate the underlying crypto message to callers /
      // audit surfaces — it may reveal envelope internals.
      return { kind: "decryptFailed", failureReason: "TD1 claim ciphertext could not be decrypted" };
    }
  }

  if (DECIMAL_RE.test(raw)) {
    // §9 — recognised transitional plain-decimal path (tests / legacy).
    return { kind: "plainDecimal", value: raw };
  }

  return {
    kind: "unknownFormat",
    failureReason: "TD1 claim reference is not a recognised envelope or plain decimal",
  };
}

/**
 * True when the resolver produced a value the calculator may consume.
 * The `missing` kind is deliberately NOT a resolved success — the
 * caller emits its MISSING_*_TD1 WARNING and freezes a default,
 * matching the pre-2c behaviour for tax profiles that lack a claim.
 */
export function isResolvedTd1(r: Td1ResolveResult): r is Td1ResolveResult & { value: string } {
  return r.kind === "claimZero" || r.kind === "resolved" || r.kind === "plainDecimal";
}

/** True when the resolver refused because the input format is inadmissible. */
export function isTd1ResolutionFailure(r: Td1ResolveResult): boolean {
  return r.kind === "decryptFailed" || r.kind === "malformed" || r.kind === "unknownFormat";
}
