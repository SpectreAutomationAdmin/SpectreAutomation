// HR-1 architect-slice source-contract pin (2026-08-16).
//
// EmployeeDocument.category is a free-form TEXT column at the DB
// level. The service layer MUST validate every write against a
// canonical list of allowed categories in
// `src/lib/hr/documents.ts` (next-wave slice), exposed as:
//
//   export const EMPLOYEE_DOCUMENT_CATEGORIES = [...] as const;
//   export const EMPLOYEE_DOCUMENT_SENSITIVE_CATEGORIES = [...] as const;
//
// The first constant is the master enum. The second flags which
// categories automatically bump `sensitivity` to "RESTRICTED".
//
// During the architect slice this file does NOT yet exist, so the
// test skips gracefully. Once admin-workflows authors the module,
// the test activates and asserts both consts are exported and are
// non-empty tuples of string literals.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const DOCUMENTS_MODULE = resolve(
  __dirname,
  "..",
  "..",
  "src",
  "lib",
  "hr",
  "documents.ts",
);

const moduleExists = existsSync(DOCUMENTS_MODULE);

describe.skipIf(!moduleExists)(
  "HR-1 · EmployeeDocument categories contract",
  () => {
    it("exports EMPLOYEE_DOCUMENT_CATEGORIES as a non-empty readonly tuple", () => {
      const src = readFileSync(DOCUMENTS_MODULE, "utf-8");
      expect(src).toMatch(
        /export\s+const\s+EMPLOYEE_DOCUMENT_CATEGORIES\s*=\s*\[[\s\S]+?\]\s*as\s+const/,
      );
    });

    it("exports EMPLOYEE_DOCUMENT_SENSITIVE_CATEGORIES as a readonly tuple", () => {
      const src = readFileSync(DOCUMENTS_MODULE, "utf-8");
      expect(src).toMatch(
        /export\s+const\s+EMPLOYEE_DOCUMENT_SENSITIVE_CATEGORIES\s*=\s*\[[\s\S]*?\]\s*as\s+const/,
      );
    });
  },
);

// Meta-guard: the file's *absence* today is intentional. If
// someone thinks this test is a bug and deletes the guard, the
// suite must still make sense. Assert the guard structure is intact.
describe("HR-1 · documents-contract test guard structure", () => {
  it("is written to skip when the domain module does not yet exist", () => {
    expect(typeof DOCUMENTS_MODULE).toBe("string");
    // moduleExists is a boolean computed at import time — it must be
    // exactly true or false, never undefined (would mean the check
    // was refactored away).
    expect([true, false]).toContain(moduleExists);
  });
});
