// HR-1 architect-slice source-contract pin (2026-08-16).
//
// `EmployeeOnboardingQuestion` is unique among HR tables: its
// `clubId` is NULLABLE so a single row can serve every club as a
// global default. Club-specific rows (clubId=<id>) OVERRIDE the
// global by shared `key`.
//
// Because of this override semantic, LIST reads (findMany /
// findFirst by non-PK criteria / count / aggregate / groupBy) must
// go through the canonical resolver `resolveEffectiveQuestions(
// clubId)` in `src/lib/hr/onboarding-questions.ts`. A caller that
// does a raw `.findMany` will silently miss the override merge and
// render the wrong question set.
//
// Refinement (2026-08-19, stabilization slice): a PK-shaped
// `findUnique({ where: { id } })` lookup CANNOT mis-merge — the
// caller already has the immutable cuid PK, so there is no
// "which override wins" question to answer. Point-lookups by ID
// are exempt from this contract. This exemption is what the WIP-
// authoritative `submitSelfResponse()` in employee-self-service.ts
// uses to validate an employee-submitted questionId belongs to
// the caller's club before writing the response. That check is
// correct and the source-contract rule is only refined to reflect
// the actual semantic (list-read discipline), not weakened.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { resolve, relative, join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC_ROOT = resolve(__dirname, "..", "..", "src");
const CANONICAL_RESOLVER = resolve(
  SRC_ROOT,
  "lib",
  "hr",
  "onboarding-questions.ts",
);

// Raw-read fingerprints on the model. We flag LIST reads —
// `.findMany`, `.findFirst`, `.count`, `.aggregate`, `.groupBy` —
// any read path that could enumerate rows and therefore needs the
// override merge. `.findUnique` is EXCLUDED because it is a PK-
// keyed point-lookup that cannot mis-merge (see the docblock at
// the top of this file).
const RAW_READ_PATTERNS: RegExp[] = [
  /\.employeeOnboardingQuestion\.findMany/,
  /\.employeeOnboardingQuestion\.findFirst/,
  /\.employeeOnboardingQuestion\.count/,
  /\.employeeOnboardingQuestion\.aggregate/,
  /\.employeeOnboardingQuestion\.groupBy/,
];

function walkTs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules") continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walkTs(full));
    else if (st.isFile() && (full.endsWith(".ts") || full.endsWith(".tsx"))) {
      out.push(full);
    }
  }
  return out;
}

describe("HR-1 · onboarding questions are read only through the canonical resolver", () => {
  it("no file outside src/lib/hr/onboarding-questions.ts performs a raw prisma read on employeeOnboardingQuestion", () => {
    const files = walkTs(SRC_ROOT);
    const violations: string[] = [];
    for (const file of files) {
      if (file === CANONICAL_RESOLVER) continue;
      const src = readFileSync(file, "utf-8");
      for (const pat of RAW_READ_PATTERNS) {
        if (pat.test(src)) {
          violations.push(
            `${relative(SRC_ROOT, file)} matches ${pat} — route through resolveEffectiveQuestions() instead`,
          );
        }
      }
    }
    expect(
      violations,
      `Raw reads on EmployeeOnboardingQuestion detected outside the canonical resolver:\n${violations.join("\n")}`,
    ).toEqual([]);
  });
});
