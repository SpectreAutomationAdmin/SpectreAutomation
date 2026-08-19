// HR-1 architect-slice source-contract pin (2026-08-16).
//
// The HR domain services (src/lib/hr/**) are being authored by the
// security-compliance / admin-workflows / financial-systems
// subagents in the next wave. They MUST gate every action on a
// `hr:*` permission key (via `requirePermission` / `principalHas`),
// NEVER on `principal.role`. Role checks in service code bypass
// the permission catalogue and freeze RBAC into hard-coded strings
// that cannot be re-tuned without a code change.
//
// Passes trivially today (no src/lib/hr/** files yet). Catches
// regressions the moment the next-wave slices land.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
import { describe, expect, it } from "vitest";

const HR_ROOT = resolve(__dirname, "..", "..", "src", "lib", "hr");

// Patterns that indicate a role check is being performed at the
// service layer (banned). Deliberately narrow — we don't want to
// flag legit strings like "role" in a display name.
const BANNED_PATTERNS: RegExp[] = [
  /principal\.role\b/,           // principal.role === "X"
  /\.role\s*===/,                // <anything>.role === (defensive)
  /\.roleKey\s*===/,             // membership.roleKey === "X"
  /roleKey\s*===\s*["']/,        // roleKey === "X"
];

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

describe("HR-1 · service layer uses permission keys, not role checks", () => {
  it("no file under src/lib/hr/** performs a role-based branch", () => {
    const files = walkTs(HR_ROOT);
    const violations: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, "utf-8");
      for (const pat of BANNED_PATTERNS) {
        if (pat.test(src)) {
          violations.push(`${file} matches ${pat}`);
        }
      }
    }
    expect(violations, `HR services must gate on permissions, not roles:\n${violations.join("\n")}`).toEqual([]);
  });
});
