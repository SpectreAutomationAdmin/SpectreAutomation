// Founder rule 2026-07-13 v15.14 — Statement of Financial Position
// web renderer source contract.
//
// Locks the renderer-level guarantees the SOFP FS-Group
// summarisation slice depends on:
//
//   • The FS-Group summary row + optional client-side disclosure
//     island renders through a dedicated Client Component so no
//     `use client` boundary is silently crossed with a function
//     prop.
//   • The disclosure control uses a real `<button>` with
//     `aria-expanded` + `aria-controls` (keyboard-accessible per
//     the founder's spec).
//   • The renderer branches on the presence of `row.accounts` —
//     so Board / member / PDF payloads (which never carry
//     `accounts`) NEVER see the disclosure control.
//   • The parent panel appends the Unmapped Balance Sheet Accounts
//     band only when `sofp.showAccountDetail` is true AND there
//     are unmapped accounts.

import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";

const disclosureIsland = fs.readFileSync(
  path.resolve(
    process.cwd(),
    "src/app/app/admin/reporting/monthly/SoFPFsGroupExpandable.tsx",
  ),
  "utf8",
);
const monthlyBody = fs.readFileSync(
  path.resolve(
    process.cwd(),
    "src/app/app/admin/reporting/monthly/MonthlyReportingPackageBody.tsx",
  ),
  "utf8",
);

describe("v15.14 SoFPFsGroupExpandable — client island for FS-Group drill-down", () => {
  it("is marked \"use client\" (the disclosure needs local state)", () => {
    expect(disclosureIsland.split("\n")[0]).toMatch(/^"use client"/);
  });

  it("keyboard-accessible <button> disclosure with aria-expanded + aria-controls", () => {
    expect(disclosureIsland).toMatch(/type="button"/);
    expect(disclosureIsland).toMatch(/aria-expanded=\{expanded\}/);
    expect(disclosureIsland).toMatch(/aria-controls=\{detailRegionId\}/);
    // An accessible label describes what the toggle does — this
    // covers the founder's "include aria-expanded and an accessible
    // label" acceptance criterion.
    expect(disclosureIsland).toMatch(/aria-label=/);
  });

  it("uses local state — expansion is never persisted to the server", () => {
    // React `useState` only; no fetch call, no cookie, no
    // localStorage. Guards against a future edit that decides to
    // sync expansion to the server (which would also require
    // adding a permission-gated API endpoint).
    expect(disclosureIsland).toMatch(/useState\(false\)/);
    expect(disclosureIsland).not.toMatch(/localStorage\.setItem/);
    expect(disclosureIsland).not.toMatch(/fetch\(/);
  });

  it("consumes SoFPRow.accounts to render the detail region (never invents accounts on the client)", () => {
    // The disclosure control renders EXACTLY the accounts array
    // the server-side view model attached. No client-side fetch of
    // GL detail exists — a Board viewer whose payload lacks
    // accounts sees no disclosure at all, and no client code path
    // could fetch them separately.
    expect(disclosureIsland).toMatch(/row\.accounts/);
    expect(disclosureIsland).toMatch(/accounts\.map\(/);
  });

  it("no functions are passed as props into the island (RSC serialisation guard)", () => {
    // The island's exported function signature accepts only
    // `{ row: SoFPRow }`. `SoFPRow.accounts` is a data array with
    // primitives only. This test locks the shape at the type
    // level via source-contract regex.
    expect(disclosureIsland).toMatch(/export function SoFPFsGroupExpandable\(\{\s*row\s*\}:\s*\{\s*row:\s*SoFPRow\s*\}\)/);
  });
});

describe("v15.14 StatementOfFinancialPositionPanel — renderer contract", () => {
  it("SoFPRowRender switch handles the new `fs-group` kind explicitly", () => {
    expect(monthlyBody).toMatch(/case "fs-group":/);
  });

  it("only mounts the disclosure island when `row.accounts` is populated (Board / PDF / member safety)", () => {
    // The renderer decides between "static summary row" and
    // "client-side expandable island" based on whether the payload
    // carries account detail. Board / member / PDF payloads omit
    // `accounts` entirely, so their rows never mount the client
    // island → no disclosure control appears in the DOM.
    expect(monthlyBody).toMatch(/const hasAccounts = row\.accounts !== undefined && row\.accounts\.length > 0/);
    expect(monthlyBody).toMatch(/if \(!hasAccounts\)/);
    expect(monthlyBody).toMatch(/<SoFPFsGroupExpandable row=\{row\}/);
  });

  it("Unmapped Balance Sheet Accounts band renders ONLY when `showAccountDetail` is true AND there are unmapped accounts", () => {
    expect(monthlyBody).toMatch(
      /sofp\.showAccountDetail && sofp\.unmappedAccounts\.length > 0/,
    );
    // The band label matches the founder's spec verbatim.
    expect(monthlyBody).toMatch(/Unmapped Balance Sheet Accounts/);
  });

  it("renders the same summary row layout for `fs-group` and legacy `detail` rows (backward-compat with archived payloads)", () => {
    // The legacy default branch survives — a legacy `packagePayloadJson`
    // that emits only `detail` rows still renders correctly.
    expect(monthlyBody).toMatch(/case "detail":/);
  });
});

describe("v15.14 admin route — coa:read gates viewerCanDrillDown, PDF + publish paths always false", () => {
  const adminPage = fs.readFileSync(
    path.resolve(
      process.cwd(),
      "src/app/app/admin/reporting/monthly/page.tsx",
    ),
    "utf8",
  );
  const printPage = fs.readFileSync(
    path.resolve(
      process.cwd(),
      "src/app/app/print/monthly-package/page.tsx",
    ),
    "utf8",
  );
  const publishPath = fs.readFileSync(
    path.resolve(
      process.cwd(),
      "src/lib/reporting/monthly-package-lifecycle.ts",
    ),
    "utf8",
  );

  it("admin route derives viewerCanDrillDown from `hasPermission(principal, clubId, \"coa:read\")`", () => {
    expect(adminPage).toMatch(/hasPermission\(principal,\s*clubId,\s*"coa:read"\)/);
    expect(adminPage).toMatch(/viewerCanDrillDown/);
  });

  it("PDF / print route hardcodes viewerCanDrillDown: false", () => {
    expect(printPage).toMatch(/viewerCanDrillDown:\s*false/);
  });

  it("publish path hardcodes viewerCanDrillDown: false so no archived payload can leak accounts", () => {
    expect(publishPath).toMatch(/viewerCanDrillDown:\s*false/);
  });
});
