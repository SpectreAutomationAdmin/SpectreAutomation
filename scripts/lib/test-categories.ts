// Test categorization — kept as a single shared list so `test:unit:fast`
// and `test:db:serial` cannot drift. Files that DO NOT touch the test
// DB are listed here; everything else is treated as DB-using.
//
// Verification command (manual; run if you add a new test file):
//   grep -L "resetDb|seedRbac|prisma\.|@/lib/prisma" tests/*.test.ts
//
// Files that return as "no-match" are pure source-contract or pure
// unit tests safe to add to NO_DB_FILES.

import path from "node:path";

export const NO_DB_FILES: ReadonlyArray<string> = [
  "tests/lib",  // entire directory — currently just attention-engine.test.ts
  "tests/finance.test.ts",
  "tests/floor-plan-editor-drag.test.ts",
  "tests/floor-plan-geometry.test.ts",
  "tests/greeting.test.ts",
  "tests/logout-redirect.test.ts",
  "tests/menu-density.test.ts",
  "tests/menu-description-typography.test.ts",
  "tests/navigation.test.ts",
  "tests/seatpos-layout.test.ts",
  "tests/seatpos-menu-tile-density.test.ts",
];

/**
 * Vitest --exclude patterns for the DB-serial run (the no-DB files,
 * expressed as glob patterns Vitest accepts).
 */
export function noDbExcludePatterns(): string[] {
  return NO_DB_FILES.map((p) => {
    // `tests/lib` → `tests/lib/**`, otherwise pass through.
    return p.endsWith(".ts") ? p : `${p.replace(/\/+$/, "")}/**`;
  });
}

export function projectRoot(): string {
  return path.resolve(__dirname, "..", "..");
}
