// EP-TRAIN-6D-4D — static guard that NO mutation endpoints exist under
// /api/admin/ai-training/drafts/**. The directive forbids any
// POST/PATCH/DELETE/PUT handler in this slice; a follow-up slice will
// add them explicitly once review mutations are authorised.
//
// The check:
//   1. Enumerate every file under src/app/api/admin/ai-training/.
//   2. Assert the file set contains only the two GET-only route files
//      this slice shipped.
//   3. Open each file and assert `export async function POST|PATCH|
//      DELETE|PUT` is absent.

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync, existsSync } from "fs";
import { join, relative } from "path";

const API_ROOT = join(process.cwd(), "src/app/api/admin/ai-training");

function listAllFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...listAllFiles(full));
    } else {
      out.push(full);
    }
  }
  return out;
}

describe("ep-train-6d-4d · api surface guard", () => {
  it("contains exactly the two GET-only route files for the queue and detail", () => {
    const files = listAllFiles(API_ROOT).map((f) => relative(process.cwd(), f).replace(/\\/g, "/"));
    const sorted = files.slice().sort();
    expect(sorted).toEqual([
      "src/app/api/admin/ai-training/drafts/[id]/route.ts",
      "src/app/api/admin/ai-training/drafts/route.ts",
    ]);
  });

  it("neither route defines a POST/PATCH/PUT/DELETE handler", () => {
    const files = listAllFiles(API_ROOT);
    for (const f of files) {
      const src = readFileSync(f, "utf-8");
      for (const verb of ["POST", "PATCH", "PUT", "DELETE"]) {
        // Allow the verb as a substring (e.g., a code comment referring
        // to a verb), but FORBID an exported handler declaration.
        const re = new RegExp(`export\\s+(async\\s+)?(function|const)\\s+${verb}\\b`);
        expect(src).not.toMatch(re);
      }
    }
  });
});
