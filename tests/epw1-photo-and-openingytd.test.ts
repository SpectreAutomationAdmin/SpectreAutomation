// EPW-1 hotfix (2026-09-20) — regression tests for the employee-payroll
// workspace hotfix. Covers:
//   * `optionalImport` static-specifier dispatch (photo pipeline regression
//     root cause): non-installed SDKs return null; installed SDKs load.
//   * The obsolete outbound Opening-YTD anchor
//     (/app/admin/payroll/opening-balances?employeeId=...) is gone from
//     the workspace component.

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { optionalImport } from "@/lib/integrations/optional-import";

const REPO = path.resolve(process.cwd());

describe("EPW-1 hotfix — optionalImport dispatch", () => {
  it("Unknown specifier returns null without throwing", async () => {
    const r = await optionalImport("this-package-does-not-exist");
    expect(r).toBeNull();
  });

  it("Installed SDK loads: @aws-sdk/client-s3 exports S3Client", async () => {
    const mod = await optionalImport("@aws-sdk/client-s3");
    expect(mod).not.toBeNull();
    expect(typeof (mod as { S3Client?: unknown }).S3Client).toBe("function");
  });

  it("Installed SDK loads: @aws-sdk/client-kms exports KMSClient", async () => {
    const mod = await optionalImport("@aws-sdk/client-kms");
    expect(mod).not.toBeNull();
    expect(typeof (mod as { KMSClient?: unknown }).KMSClient).toBe("function");
  });

  it("Installed SDK loads: nodemailer has createTransport", async () => {
    const mod = await optionalImport("nodemailer");
    expect(mod).not.toBeNull();
    const nm = (mod as { default?: unknown; createTransport?: unknown });
    const create =
      (nm.createTransport as unknown)
      ?? (nm.default as { createTransport?: unknown } | undefined)?.createTransport;
    expect(typeof create).toBe("function");
  });

  it("Installed SDK loads: bullmq exports Queue", async () => {
    const mod = await optionalImport("bullmq");
    expect(mod).not.toBeNull();
    expect(typeof (mod as { Queue?: unknown }).Queue).toBe("function");
  });

  it("Every dispatch specifier is a literal string call to import()", () => {
    // Structural guard against regressing to `new Function(...)` — the tracer
    // must be able to see every import specifier as a string literal.
    const src = fs.readFileSync(
      path.join(REPO, "src", "lib", "integrations", "optional-import.ts"),
      "utf8",
    );
    // Strip block+line comments before checking so historical commentary
    // in the file header doesn't false-fail the regression guard.
    const codeOnly = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .map(l => l.replace(/\/\/.*$/, ""))
      .join("\n");
    expect(codeOnly).not.toMatch(/new\s+Function\s*\(/);
    // Each dispatch entry must appear as `() => import("<literal>")`.
    const matches = src.match(/=>\s*import\("([^"]+)"\)/g);
    expect(matches, "at least one dispatch entry must exist").toBeTruthy();
    expect(matches!.length).toBeGreaterThanOrEqual(6);
  });
});

describe("EPW-1 hotfix — Opening YTD 404 nav removed", () => {
  it("Employee Payroll workspace no longer contains the broken /opening-balances?employeeId anchor", () => {
    const src = fs.readFileSync(
      path.join(REPO, "src", "components", "hr", "EmployeePayrollWorkspaceSection.tsx"),
      "utf8",
    );
    // Strip comments so historical reference in commentary doesn't trip.
    const codeOnly = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\r\n]*/g, "");
    // The whole point of the fix: no outbound anchor to the broken route.
    expect(codeOnly).not.toMatch(/\/app\/admin\/payroll\/opening-balances\?employeeId=/);
    // And an inline slot exists to render the editor.
    expect(src).toMatch(/opening-ytd-editor-slot/);
  });

  it("Inline editor component exposes save-draft / validate / activate actions", () => {
    const src = fs.readFileSync(
      path.join(REPO, "src", "components", "hr", "OpeningYtdInlineEditor.tsx"),
      "utf8",
    );
    expect(src).toMatch(/opening-ytd-save-draft/);
    expect(src).toMatch(/opening-ytd-validate/);
    expect(src).toMatch(/opening-ytd-activate/);
    // Modal renders inside the employee page — no navigation away.
    expect(src).toMatch(/opening-ytd-modal/);
  });

  it("Employee-scoped server actions redirect back to the employee profile", () => {
    const src = fs.readFileSync(
      path.join(REPO, "src", "app", "app", "admin", "people", "employees", "[id]", "_opening-ytd-actions.ts"),
      "utf8",
    );
    expect(src).toMatch(/backToEmployee/);
    expect(src).toMatch(/\/app\/admin\/people\/employees\/\$\{employeeId\}/);
  });
});
