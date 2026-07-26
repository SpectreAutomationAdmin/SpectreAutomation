// Founder rule 2026-07-11: when the operator clicks
// Dry-run / Validate and the server flags at least one row
// INVALID, the page must auto-scroll to the first error row
// during the SAME validation cycle — no hard refresh, no
// navigation, no manual interaction required.
//
// Root-cause of the bug this slice fixes:
//   The CoaMappingTable initializes its local `rows` state from
//   the `initialRows` prop via a useState initializer. That
//   initializer only runs on MOUNT. When the page revalidates
//   after the Validate server action, React passes new props but
//   the component is reused (same tree position) — the new
//   server statuses never reach local state, so the auto-scroll
//   effect's `errorRowIndices` stays empty. Hard refresh worked
//   because it re-mounted the component.
//
// The fix has two parts:
//   1. A reconciliation useEffect that watches a content-based
//      fingerprint of `initialRows` and merges the server-state
//      fields (serverStatus, errorMessage, errorCodes) back into
//      the local rows by rowId.
//   2. The scroll call is deferred to the next animation frame
//      so the row's <tr> is guaranteed mounted in the DOM
//      before scrollIntoView reads its bounding box.
//
// Source-contract tests (matches the established pattern for
// this component's other UX rules).

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const TABLE = fs.readFileSync(
  path.resolve(
    process.cwd(),
    "src/app/app/admin/imports/[id]/CoaMappingTable.tsx",
  ),
  "utf8",
);

const codeOnly = (s: string) =>
  s
    .split("\n")
    .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("/*") && !l.trim().startsWith("*"))
    .join("\n");

describe("Server-state reconciliation — initialRows → local rows", () => {
  it("builds a content-based fingerprint of initialRows (so re-renders with the same content don't re-fire)", () => {
    expect(TABLE).toContain("serverStateFingerprint");
    expect(TABLE).toMatch(
      /useMemo\(\s*\(\)\s*=>[\s\S]*?initialRows[\s\S]*?\.join\("\|"\)/,
    );
  });

  it("fingerprint includes serverStatus + errorMessage + errorCodes length per row", () => {
    expect(TABLE).toMatch(/r\.serverStatus \?\? ""/);
    expect(TABLE).toMatch(/r\.errorMessage \?\? ""/);
    expect(TABLE).toMatch(/r\.errorCodes \?\? \[\]\)\.length/);
  });

  it("reconcile effect runs on fingerprint change, NOT on the array reference", () => {
    const c = codeOnly(TABLE);
    // Should depend on the fingerprint string, not on initialRows
    // directly (which would re-fire every parent render and trample
    // operator edits).
    expect(c).toMatch(/useEffect\([\s\S]+?\}, \[serverStateFingerprint\]\)/);
  });

  it("reconcile merges by rowId — operator's in-flight edits (type/category/etc.) are preserved", () => {
    const c = codeOnly(TABLE);
    expect(c).toMatch(/byId = new Map\(initialRows\.map\(\(i\) => \[i\.rowId, i\]\)\)/);
    // Only the server-driven fields are overwritten; everything
    // else flows through `...r` first.
    expect(c).toMatch(
      /return \{\s*\.\.\.r,\s*serverStatus: fresh\.serverStatus,\s*errorMessage: fresh\.errorMessage,\s*errorCodes: fresh\.errorCodes,\s*\}/,
    );
  });
});

describe("Scroll is deferred until the row exists in the DOM", () => {
  it("scrollToErrorRow wraps its DOM work in requestAnimationFrame", () => {
    expect(TABLE).toMatch(/window\.requestAnimationFrame\(doScroll\)/);
  });

  it("if the row ref is missing on the first frame, retries once on the next frame before giving up", () => {
    const c = codeOnly(TABLE);
    // The retry path uses another rAF inside doScroll's miss branch.
    expect(c).toMatch(/window\.requestAnimationFrame\(\(\) => \{[\s\S]+?const retryNode/);
  });

  it("scroll math still respects the sticky-header height offset (regression guard)", () => {
    expect(TABLE).toMatch(/window\.scrollY \+ rect\.top - stickyHeaderHeight - 12/);
    expect(TABLE).toMatch(/behavior: "smooth"/);
  });

  it("flash class is still set + cleared after ~1.6s", () => {
    expect(TABLE).toMatch(/setFlashRowId\(rowId\)/);
    expect(TABLE).toMatch(/window\.setTimeout\([\s\S]+?1600\)/);
  });
});

describe("Auto-scroll effect re-fires when server-state changes", () => {
  it("the auto-scroll effect depends on serverStateFingerprint (so repeat-validate after a fix still scrolls)", () => {
    const c = codeOnly(TABLE);
    expect(c).toMatch(
      /useEffect\([\s\S]+?lastAutoScrollKey\.current[\s\S]+?\}, \[errorRowIndices, stickyHeaderHeight, serverStateFingerprint\]\)/,
    );
  });

  it("clears the de-dup key when the error set becomes empty (so a fresh error after a fix triggers a new scroll)", () => {
    const c = codeOnly(TABLE);
    expect(c).toMatch(
      /if \(errorRowIndices\.length === 0\) \{\s*lastAutoScrollKey\.current = "";\s*return;/,
    );
  });
});

describe("The original cosmetic + behavior contracts are unbroken", () => {
  it("status pill still reads 'Error' (never 'Ready') for INVALID rows", () => {
    expect(TABLE).toMatch(/>\s*Error\s*</);
    expect(TABLE).toMatch(
      /if \(r\.serverStatus === "INVALID" && !r\.dirtySinceValidation\) return "error"/,
    );
  });

  it("Next-error nav still cycles through errorRowIndices", () => {
    expect(TABLE).toContain("function jumpToNextError()");
    expect(TABLE).toMatch(/errorRowIndices\[nextErrorCursor % errorRowIndices\.length\]/);
  });

  it("error row keeps its permanent red-left-border + tint when isError", () => {
    expect(TABLE).toMatch(/isError \? "bg-red-50\/60 border-l-4 border-l-red-500" : ""/);
  });
});
