// Payroll Consolidation (2026-09-14) — nav + link-audit gate tests.
//
// These are static-shape tests. They lock in the founder-approved
// canonical architecture defined in docs/payroll/canonical-payroll-ui.md:
//
//   * Finance nav DOES expose "/app/admin/payroll" (canonical).
//   * Operations nav does NOT expose any payroll entries — the retired
//     legacy Ops route + the four canonical subroute nav entries are
//     removed from the Operations sidebar so the founder never has to
//     wonder which of two workspaces is authoritative.
//   * No production surface (src/**) still uses `payrollService` from
//     `@/lib/ops` — the legacy service is retained only for tests + seed
//     until a schema-rename slice deletes it.
//
// If any future slice reinstates a payroll nav entry under Operations
// or introduces a new consumer of `payrollService`, THESE tests fail.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ADMIN_SECTIONS } from "@/components/sidebar-nav-data";

describe("Payroll consolidation · nav + link audits", () => {
  it("Finance nav exposes the canonical /app/admin/payroll entry", () => {
    const finance = ADMIN_SECTIONS.find((s) => s.id === "finance");
    expect(finance).toBeDefined();
    const canonical = finance!.items.find((i) => i.href === "/app/admin/payroll");
    expect(canonical, "Finance nav must expose /app/admin/payroll").toBeDefined();
    expect(canonical!.label).toBe("Payroll");
  });

  it("Operations nav has ZERO payroll entries", () => {
    const ops = ADMIN_SECTIONS.find((s) => s.id === "operations");
    expect(ops).toBeDefined();
    const payrollHits = ops!.items.filter(
      (i) => /payroll/i.test(i.href) || /payroll/i.test(i.label),
    );
    expect(
      payrollHits,
      `Operations nav must expose no payroll entries. Found: ${JSON.stringify(payrollHits)}`,
    ).toEqual([]);
  });

  // Guard against any future re-introduction of the retired
  // /app/admin/ops/payroll route as a navigable entry.
  it("no nav entry (any section) points at /app/admin/ops/payroll", () => {
    const hits: string[] = [];
    for (const s of ADMIN_SECTIONS) {
      for (const i of s.items) {
        if (i.href === "/app/admin/ops/payroll") hits.push(`${s.id}: ${i.label}`);
      }
    }
    expect(hits).toEqual([]);
  });

  // The retired legacy service `payrollService` from `@/lib/ops` must
  // not have any production consumer other than the barrel re-export.
  // Tests + seed + the enforced-writer test are allowed.
  it("no new production consumer of legacy payrollService", () => {
    // Static scan of `src/**` — we grep by string to keep the test
    // hermetic. Anything under `src/lib/ops/**` or the barrel is allowed
    // (the service still lives there); the failure case is a `src/**`
    // file OUTSIDE those paths that imports it.
    const repoRoot = path.resolve(__dirname, "..");
    const searchRoot = path.join(repoRoot, "src");
    const allowedPrefixes = [
      path.join(searchRoot, "lib", "ops"),
    ];
    const disallowed = [] as string[];

    // Simple recursive fs walk. Tests should stay fast — src/ is bounded.
    const { readdirSync, statSync } = require("node:fs") as typeof import("node:fs");
    function walk(dir: string) {
      for (const name of readdirSync(dir)) {
        const p = path.join(dir, name);
        const st = statSync(p);
        if (st.isDirectory()) {
          if (name === "node_modules" || name.startsWith(".")) continue;
          walk(p);
          continue;
        }
        if (!/\.(tsx?|jsx?)$/.test(name)) continue;
        // Only .ts/.tsx source files; skip dist / build.
        const isAllowed = allowedPrefixes.some((prefix) => p.startsWith(prefix));
        if (isAllowed) continue;
        const src = readFileSync(p, "utf8");
        // Match the specific import (avoids false-positive substrings
        // like `payrollServices` — we look for the exact identifier).
        if (/from ["']@\/lib\/ops["']/.test(src) && /\bpayrollService\b/.test(src)) {
          disallowed.push(path.relative(repoRoot, p));
        }
      }
    }
    walk(searchRoot);

    expect(
      disallowed,
      `New production consumer of legacy payrollService detected: ${JSON.stringify(disallowed)}`,
    ).toEqual([]);
  });
});
