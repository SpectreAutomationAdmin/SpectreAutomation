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
//
// HR-2C B6.1 — the `/\.role\s*===/` bare-attribute pattern is too
// broad: it also matches legitimate DOMAIN role fields such as
// `EmployeeEmploymentAssignment.role === "PRIMARY"` (HR-2C multi-
// role), which are NOT authorization decisions. The domain-role
// fields the multi-role architecture introduces are enumerated in
// DOMAIN_ROLE_FIELDS below; the guard still refuses any
// `principal.role`/`.roleKey`-style authorization branching.
const BANNED_PATTERNS: RegExp[] = [
  /principal\.role\b/,           // principal.role === "X"
  /\.roleKey\s*===/,             // membership.roleKey === "X"
  /roleKey\s*===\s*["']/,        // roleKey === "X"
];

// Domain-role field references that use `.role === "..."` but do
// NOT constitute an authorization decision. Each string appears in a
// legitimate multi-role assignment branch (HR-2C Employment 2026-08-
// 24). Adding to this list requires the entry to reference a
// non-Principal domain field. Cross-check with a comment showing the
// origin before extending.
const DOMAIN_ROLE_ALLOWED_STRINGS: string[] = [
  // src/lib/hr/employment-assignments.ts — EmployeeEmploymentAssignment.role
  //   distinguishes PRIMARY vs ADDITIONAL role assignments; these are
  //   role-catalog entries on the assignment row, not principal roles.
  '.role === "PRIMARY"',
  '.role === "ADDITIONAL"',
];

// Widened check: additionally scan for `.role === "..."` that is
// NOT one of the allowed domain-role literals. If we ever have a
// service code path that says `principal.role === "X"` or
// `caller.role === "CLUB_ADMIN"`, it will fail here.
const DOMAIN_ROLE_RE = /\.role\s*===\s*"([^"]+)"/g;

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
      // Additionally scan for `.role === "..."` comparisons and
      // refuse any that are NOT a documented domain-role literal.
      for (const match of src.matchAll(DOMAIN_ROLE_RE)) {
        const literal = `.role === "${match[1]}"`;
        if (!DOMAIN_ROLE_ALLOWED_STRINGS.includes(literal)) {
          violations.push(`${file} matches ${literal} (undocumented .role comparison — if this is a domain field, add to DOMAIN_ROLE_ALLOWED_STRINGS with rationale; if it is a Principal role check, replace with a hr:* permission gate)`);
        }
      }
    }
    expect(violations, `HR services must gate on permissions, not roles:\n${violations.join("\n")}`).toEqual([]);
  });
});
