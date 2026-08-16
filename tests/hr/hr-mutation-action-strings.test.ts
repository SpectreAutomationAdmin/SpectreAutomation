// HR-1 architect-slice source-contract pin (2026-08-16).
//
// Every HR mutation MUST audit itself with an action string of the
// form `hr.<entity>.<verb>`, where <verb> is a WRITE_INDICATOR word
// so the training-mode + support-readonly gates fire correctly (they
// substring-match on those verbs). Read-only helpers must not audit
// at all under this domain — reads are not audited.
//
// Passes trivially today (no src/lib/hr/** files yet). Locks the
// contract for the next-wave slices.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
import { describe, expect, it } from "vitest";

const HR_ROOT = resolve(__dirname, "..", "..", "src", "lib", "hr");

// Verbs recognised as writes by the posting-guard / support-readonly
// substring gate. Keep in lock-step with WRITE_INDICATORS in
// src/lib/posting-guard.ts and src/lib/support-readonly.ts.
const WRITE_INDICATORS = [
  "create", "update", "delete", "post",
  "approve", "void", "issue", "send",
  // HR-specific: reveal is a plaintext-access audited action (also
  // gated by assertSensitiveActionAllowed). Not a mutation of stored
  // state but it must audit.
  "reveal",
  // HR-specific writes/state transitions.
  "activate", "suspend", "terminate", "invite", "revoke", "redeem",
  "submit", "reject",
] as const;

const ACTION_STRING = /action\s*:\s*["'](hr\.[a-z0-9_.]+)["']/g;

function walkTs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walkTs(full));
    else if (st.isFile() && full.endsWith(".ts")) out.push(full);
  }
  return out;
}

describe("HR-1 · audit action strings contain a WRITE_INDICATOR", () => {
  it("every `action: 'hr.…'` literal under src/lib/hr/** matches a write verb", () => {
    const files = walkTs(HR_ROOT);
    const violations: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, "utf-8");
      for (const match of src.matchAll(ACTION_STRING)) {
        const action = match[1];
        const hit = WRITE_INDICATORS.some((v) => action.includes(v));
        if (!hit) {
          violations.push(`${file} — action="${action}" does not contain a write verb`);
        }
      }
    }
    expect(violations, `HR audit action strings must include a WRITE_INDICATOR:\n${violations.join("\n")}`).toEqual([]);
  });
});
