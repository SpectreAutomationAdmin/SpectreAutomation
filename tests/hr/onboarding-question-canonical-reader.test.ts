// HR-1 architect-slice source-contract pin (2026-08-16).
//
// `EmployeeOnboardingQuestion` is unique among HR tables: its
// `clubId` is NULLABLE so a single row can serve every club as a
// global default. Club-specific rows (clubId=<id>) OVERRIDE the
// global by shared `key`.
//
// Because of this override semantic, *every* read must go through
// the canonical resolver `resolveEffectiveQuestions(clubId)` in
// `src/lib/hr/onboarding-questions.ts` (authored in the next-wave
// slice). A caller that does a raw `prisma.employeeOnboardingQuestion
// .find*` will silently miss the override merge and render the wrong
// question set.
//
// This test forbids raw prisma reads of the model anywhere OTHER
// than the canonical resolver file. Passes trivially today (no
// callers yet). Locks the contract for the next-wave slices.

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

// Raw-read fingerprints on the model. We flag `.find`, `.findMany`,
// `.findFirst`, `.findUnique`, `.count`, `.aggregate`, `.groupBy` —
// any read path that could return a question row.
const RAW_READ_PATTERNS: RegExp[] = [
  /\.employeeOnboardingQuestion\.find\w*/,
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
