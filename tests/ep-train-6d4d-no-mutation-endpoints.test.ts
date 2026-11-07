// EP-TRAIN-6D-4D — static guard that NO UNAUTHORISED mutation
// endpoints exist under /api/admin/ai-training/drafts/**. The
// directive forbade mutations IN 4D; subsequent, separately-
// authorised slices may add exactly-named routes to the allowlist
// below as they ship.
//
// Current allowlist:
//   - GET  /api/admin/ai-training/drafts/            (4D queue read)
//   - GET  /api/admin/ai-training/drafts/[id]        (4D detail read)
//   - POST /api/admin/ai-training/drafts/[id]/approve (4N approval;
//                                                     consumed by 4P)
//   - POST /api/admin/ai-training/drafts/[id]/promote (4Y wrapper over
//                                                     the 4T promotion
//                                                     service; existing
//                                                     hr:training:write)
//
// The check:
//   1. Enumerate every file under src/app/api/admin/ai-training/.
//   2. Assert the file set matches the allowlist exactly.
//   3. For every route NOT on the mutation-allowlist, assert no
//      `export async function POST|PATCH|PUT|DELETE` is defined.

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

/** Routes allowed to export a mutation verb (POST/PATCH/PUT/DELETE).
 *  Every route NOT in this set must be GET-only. */
const MUTATION_ALLOWLIST: ReadonlySet<string> = new Set([
  "src/app/api/admin/ai-training/drafts/[id]/approve/route.ts", // 4N POST
  "src/app/api/admin/ai-training/drafts/[id]/promote/route.ts", // 4Y POST
]);

/** The full enumeration of route files under this tree. */
const ALL_ROUTE_FILES: readonly string[] = [
  "src/app/api/admin/ai-training/drafts/[id]/approve/route.ts",
  "src/app/api/admin/ai-training/drafts/[id]/promote/route.ts",
  "src/app/api/admin/ai-training/drafts/[id]/route.ts",
  "src/app/api/admin/ai-training/drafts/route.ts",
];

describe("ep-train-6d-4d · api surface guard", () => {
  it("file set matches the authorised allowlist exactly (no surprise routes)", () => {
    const files = listAllFiles(API_ROOT).map((f) => relative(process.cwd(), f).replace(/\\/g, "/"));
    expect(files.slice().sort()).toEqual(ALL_ROUTE_FILES.slice().sort());
  });

  it("every non-allowlisted route is GET-only — no POST/PATCH/PUT/DELETE handler", () => {
    const files = listAllFiles(API_ROOT);
    for (const f of files) {
      const rel = relative(process.cwd(), f).replace(/\\/g, "/");
      if (MUTATION_ALLOWLIST.has(rel)) continue;
      const src = readFileSync(f, "utf-8");
      for (const verb of ["POST", "PATCH", "PUT", "DELETE"]) {
        const re = new RegExp(`export\\s+(async\\s+)?(function|const)\\s+${verb}\\b`);
        expect(src).not.toMatch(re);
      }
    }
  });
});
