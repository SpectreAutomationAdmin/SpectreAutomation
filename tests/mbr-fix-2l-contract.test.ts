// MBR-FIX-2L (2026-10-11) — AR Aging import admin page contract.
//
// Verifies the founder-facing import UI reuses the existing
// `POST /api/admin/ar-aging-import` endpoint (preview + commit),
// requires explicit Controller authorization before committing,
// surfaces aging bucket totals + GL reconciliation + duplicate
// protection, and is discoverable from the Admin Imports hub.

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO = path.resolve(__dirname, "..");
const PAGE = path.join(REPO, "src/app/app/admin/imports/ar-aging/page.tsx");
const FORM = path.join(REPO, "src/app/app/admin/imports/ar-aging/ar-aging-import-form.tsx");
const HUB  = path.join(REPO, "src/app/app/admin/imports/page.tsx");

describe("MBR-FIX-2L §A — page exists + enforces principal / club / RBAC", () => {
  it("ar-aging page module exists", () => {
    expect(existsSync(PAGE)).toBe(true);
  });

  it("resolves principal + redirects anonymous to /login", () => {
    const src = readFileSync(PAGE, "utf8");
    expect(src).toMatch(/getCurrentPrincipal/);
    expect(src).toMatch(/redirect\("\/login"\)/);
  });

  it("resolves active clubId + enforces settings:write permission", () => {
    const src = readFileSync(PAGE, "utf8");
    expect(src).toMatch(/getActiveClubId/);
    expect(src).toMatch(/hasPermission\(principal, clubId, "settings:write"\)/);
  });

  it("renders batch history ordered newest-first + capped", () => {
    const src = readFileSync(PAGE, "utf8");
    expect(src).toMatch(/prisma\.arAgingImportBatch\.findMany/);
    expect(src).toMatch(/orderBy:\s*\{\s*uploadedAt:\s*"desc"\s*\}/);
    expect(src).toMatch(/take:\s*20/);
  });
});

describe("MBR-FIX-2L §B — form reuses the existing API endpoint", () => {
  it("preview POSTs multipart to /api/admin/ar-aging-import with action=preview", () => {
    const src = readFileSync(FORM, "utf8");
    expect(src).toMatch(/fetch\("\/api\/admin\/ar-aging-import"/);
    expect(src).toMatch(/form\.append\("action",\s*"preview"\)/);
  });

  it("commit POSTs the same endpoint with action=commit", () => {
    const src = readFileSync(FORM, "utf8");
    expect(src).toMatch(/form\.append\("action",\s*"commit"\)/);
  });

  it("passes clubId + sourceEffectiveDate + file as multipart fields", () => {
    const src = readFileSync(FORM, "utf8");
    expect(src).toMatch(/form\.append\("clubId",\s*clubId\)/);
    expect(src).toMatch(/form\.append\("sourceEffectiveDate",\s*effectiveDate\)/);
    expect(src).toMatch(/form\.append\("file",\s*file\)/);
  });

  it("accepts XLSX only (file input accept filter)", () => {
    const src = readFileSync(FORM, "utf8");
    expect(src).toMatch(/accept="\.xlsx,application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet"/);
  });

  it("validates sourceEffectiveDate is YYYY-MM-DD before submit", () => {
    const src = readFileSync(FORM, "utf8");
    expect(src).toMatch(/\/\^\\d\{4\}-\\d\{2\}-\\d\{2\}\$\//);
  });
});

describe("MBR-FIX-2L §C — commit requires explicit Controller authorization", () => {
  const src = readFileSync(FORM, "utf8");

  it("Commit button only renders when preview.commitEligible is true", () => {
    expect(src).toMatch(/preview\.commitEligible\s*&&\s*state\s*!==\s*"committed"/);
  });

  it("Commit button opens a confirmation modal (not a direct POST)", () => {
    expect(src).toMatch(/onClick=\{\(\) => setShowConfirm\(true\)\}/);
    expect(src).toMatch(/role="dialog"/);
  });

  it("confirmation modal names the row count + total + period end", () => {
    const idx = src.indexOf("ar-aging-commit-modal");
    expect(idx).toBeGreaterThan(0);
    const block = src.slice(idx, idx + 2000);
    expect(block).toMatch(/preview\.rowCount/);
    expect(block).toMatch(/preview\.totals\.totalAR/);
    expect(block).toMatch(/preview\.sourceEffectiveDate/);
  });

  it("Confirm button is the only path that calls onCommit", () => {
    const confirmIdx = src.indexOf("ar-aging-commit-confirm");
    expect(confirmIdx).toBeGreaterThan(0);
    // Window ±400 chars so attribute ordering doesn't matter.
    const near = src.slice(Math.max(0, confirmIdx - 400), confirmIdx + 400);
    expect(near).toMatch(/onClick=\{onCommit\}/);
    // Preview-time Commit button opens the modal, never calls
    // onCommit directly.
    const openIdx = src.indexOf("ar-aging-import-commit");
    expect(openIdx).toBeGreaterThan(0);
    const openNear = src.slice(Math.max(0, openIdx - 400), openIdx + 400);
    expect(openNear).toMatch(/onClick=\{\(\) => setShowConfirm\(true\)\}/);
    expect(openNear).not.toMatch(/onClick=\{onCommit\}/);
  });
});

describe("MBR-FIX-2L §D — preview surfaces required reconciliation evidence", () => {
  const src = readFileSync(FORM, "utf8");

  it("renders every aging bucket (current, 1 / 2 / 3 / 4+ months)", () => {
    expect(src).toMatch(/data-testid="ar-aging-bucket-current"/);
    expect(src).toMatch(/data-testid="ar-aging-bucket-one-month"/);
    expect(src).toMatch(/data-testid="ar-aging-bucket-two-months"/);
    expect(src).toMatch(/data-testid="ar-aging-bucket-three-months"/);
    expect(src).toMatch(/data-testid="ar-aging-bucket-over-four"/);
  });

  it("renders Total AR as a bolded sum row + current/non-current pct", () => {
    expect(src).toMatch(/data-testid="ar-aging-bucket-total"/);
    expect(src).toMatch(/currentPct/);
    expect(src).toMatch(/nonCurrentPct/);
  });

  it("renders GL reconciliation (control account, GL balance, subledger total, Δ, status)", () => {
    expect(src).toMatch(/data-testid="ar-aging-import-gl"/);
    expect(src).toMatch(/preview\.gl\.accountNumber/);
    expect(src).toMatch(/preview\.gl\.naturalBalance/);
    expect(src).toMatch(/preview\.gl\.subledgerTotal/);
    expect(src).toMatch(/preview\.gl\.difference/);
    expect(src).toMatch(/preview\.gl\.status/);
  });

  it("GL status badge colour switches on RECONCILED / OUT_OF_BALANCE", () => {
    expect(src).toMatch(/preview\.gl\.status === "RECONCILED"[\s\S]{0,80}badge-green/);
    expect(src).toMatch(/preview\.gl\.status === "OUT_OF_BALANCE"[\s\S]{0,80}badge-rose/);
  });

  it("displays warnings when preview.warnings is non-empty", () => {
    expect(src).toMatch(/preview\.warnings\.length > 0/);
  });

  it("renders eligibility notice (commitEligible branches)", () => {
    expect(src).toMatch(/data-testid="ar-aging-import-commit-eligibility"/);
  });
});

describe("MBR-FIX-2L §E — Admin Imports hub links to the AR Aging page", () => {
  const src = readFileSync(HUB, "utf8");

  it("hub renders a 'Historical imports' section", () => {
    expect(src).toMatch(/Historical imports/);
  });

  it("hub carries a link to /app/admin/imports/ar-aging", () => {
    expect(src).toMatch(/href="\/app\/admin\/imports\/ar-aging"/);
    expect(src).toMatch(/data-testid="imports-hub-ar-aging-link"/);
  });
});
