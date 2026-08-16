// HR-1 cross-cutting drift-detection · Employee.payRate exclusive-writer
// pin.
//
// Contract: after the HR-1 refactor, `Employee.payRate` is a LEGACY
// column whose canonical source of truth is `EmployeeCompensation`.
// The compensation service (`src/lib/hr/compensation.ts`) is the ONLY
// path allowed to UPDATE `payRate` on an existing employee — it
// shadow-writes the value inside the same transaction that opens a new
// `EmployeeCompensation` row, so legacy `PayrollLine.grossPay`
// consumers stay in step.
//
// Initial employee creation is allowed to seed a default value from
// two places:
//   - `src/lib/hr/employees.ts` — the canonical HR create path; a new
//     Employee must carry SOME initial rate (default 0). Subsequent
//     changes flow through `changeCompensation`.
//   - `src/lib/ops/payroll.ts` — the LEGACY payroll ops module still
//     runs `payrollService.createEmployee` from `prisma/seed.ts` and
//     the `/app/admin/ops/payroll` page. HR-2 obligation is to
//     converge this path onto `src/lib/hr/employees.createEmployee` so
//     the shadow-write invariant is unambiguous. Whitelisted here as
//     a pre-existing legacy writer, NOT as an approved design.
//
// This test walks every `src/**/*.ts` (excluding test files, node_modules,
// and generated Prisma files) and flags any file that appears in a
// `data:` block on `prisma.employee.{create,update,upsert}` or
// `tx.employee.{create,update,upsert}` while writing a `payRate:`
// key. Anything NOT on the whitelist fails the test with a diff of
// (file:line).
//
// Adding a new writer without updating the whitelist is a violation
// of the shadow-write invariant. If a legitimate second update-writer
// ever appears (unlikely — the compensation service is designed to be
// the singleton), it MUST come with an accompanying source-code note
// explaining why, and this whitelist must be extended in the same
// change.

import { readFileSync } from "node:fs";
import { resolve, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { glob } from "glob";

const REPO_ROOT = resolve(__dirname, "..", "..", "..");
const SRC_ROOT = resolve(REPO_ROOT, "src");

// Files allowed to write `payRate` in a Prisma data block. Paths are
// stored as POSIX-relative-to-repo so they compare cleanly on both
// Windows and *nix.
const WRITE_ALLOWLIST = new Set<string>([
  "src/lib/hr/compensation.ts",
  "src/lib/hr/employees.ts",
  "src/lib/ops/payroll.ts",
]);

// Pattern: a `data:` block (or `create:` / `update:` block inside an
// upsert) containing `payRate` somewhere within the same object
// literal. We look for `\bpayRate\s*:` at the LEFT of an assignment
// (data-payload key), which cleanly excludes `.payRate` accesses on
// the right-hand side (reads).
const PAYRATE_KEY = /^\s*payRate\s*:/m;

// A rough Prisma write-call fingerprint. We grep for
// `(prisma|tx)\.employee\.(create|update|upsert)\s*\(` and then scan
// the following object literal to see whether a `payRate` key appears
// before the matching close-paren depth returns to 0.
const CALL_FINGERPRINT =
  /(prisma|tx)\s*\.\s*employee\s*\.\s*(create|update|upsert)\s*\(/g;

function toPosix(rel: string): string {
  return rel.split(sep).join("/");
}

/** Return true iff the object literal starting at `open` (index of
 *  its opening `(`) contains a `payRate:` key before its matching
 *  `)`. Cheap paren-depth walk; string/comment nesting is not
 *  handled but is not needed for this pattern in the current codebase. */
function callBodyContainsPayRate(src: string, open: number): boolean {
  let depth = 0;
  let i = open;
  const end = src.length;
  for (; i < end; i++) {
    const c = src[i];
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) break;
    }
  }
  const body = src.slice(open, Math.min(i, end));
  return PAYRATE_KEY.test(body);
}

interface Violation {
  file: string;
  line: number;
  call: string;
}

function scanFile(absPath: string, repoRel: string): Violation[] {
  const src = readFileSync(absPath, "utf-8");
  const out: Violation[] = [];
  for (const m of src.matchAll(CALL_FINGERPRINT)) {
    const paramOpenIdx = m.index! + m[0].length - 1; // the `(` at the end of the match
    if (!callBodyContainsPayRate(src, paramOpenIdx)) continue;
    // Compute 1-based line number of the match start.
    const line = src.slice(0, m.index).split("\n").length;
    out.push({ file: repoRel, line, call: `${m[1]}.employee.${m[2]}` });
  }
  return out;
}

describe("HR-1 cross-cutting · Employee.payRate exclusive-writer pin", () => {
  it("only whitelisted files write Employee.payRate via Prisma", async () => {
    const files = await glob("**/*.ts", {
      cwd: SRC_ROOT,
      ignore: ["**/*.test.ts", "**/*.d.ts", "**/node_modules/**"],
      absolute: true,
    });

    const unauthorised: Violation[] = [];
    for (const abs of files) {
      const repoRel = toPosix(relative(REPO_ROOT, abs));
      const hits = scanFile(abs, repoRel);
      for (const hit of hits) {
        if (!WRITE_ALLOWLIST.has(hit.file)) {
          unauthorised.push(hit);
        }
      }
    }

    expect(
      unauthorised,
      unauthorised.length
        ? "Unauthorised Employee.payRate writer(s) detected — either route the write through " +
            "`src/lib/hr/compensation.ts::changeCompensation` OR add the file to WRITE_ALLOWLIST " +
            "with a written justification.\n" +
            unauthorised.map((v) => `  - ${v.file}:${v.line}  (${v.call})`).join("\n")
        : "",
    ).toEqual([]);
  });

  it("`src/lib/ops/payroll.ts` has exactly ONE Prisma write of Employee.payRate", () => {
    // This file is on the allowlist ONLY because
    // `payrollService.createEmployee` still runs at seed time (see
    // prisma/seed.ts) and behind the legacy /app/admin/ops/payroll
    // page. Pin the count at 1 so a NEW Prisma write inside this
    // legacy module gets caught immediately — HR-2's obligation is
    // to shrink this count to zero by converging seed + admin page
    // onto `src/lib/hr/employees.createEmployee`.
    //
    // Note: this file also declares `payRate: z.number()...` in a
    // zod schema (a validator field, not a Prisma data block); zod
    // schema fields are NOT counted here because they do not write
    // to the database — `callBodyContainsPayRate` only inspects the
    // body of a Prisma call.
    const abs = resolve(SRC_ROOT, "lib", "ops", "payroll.ts");
    const src = readFileSync(abs, "utf-8");
    const writeHits: number[] = [];
    for (const m of src.matchAll(CALL_FINGERPRINT)) {
      const paramOpenIdx = m.index! + m[0].length - 1;
      if (callBodyContainsPayRate(src, paramOpenIdx)) {
        writeHits.push(m.index!);
      }
    }
    expect(
      writeHits.length,
      `Expected exactly 1 Prisma Employee.payRate write in src/lib/ops/payroll.ts (the legacy createEmployee); found ${writeHits.length}. A new writer in this file is a regression.`,
    ).toBe(1);
  });
});
