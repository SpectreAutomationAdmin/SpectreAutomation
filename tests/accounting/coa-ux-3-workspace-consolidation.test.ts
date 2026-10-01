// COA-UX-3 (2026-09-30) — workspace consolidation + commit progress.
//
// Structural guards that the COA import detail page conforms to the
// §3 / §4 / §5 / §8 / §12 / §14 directives: Inspector + bulk is the
// single per-row mapping surface; CoaErrorsCard owns validation
// navigation; CoaReplaceCommitButton exposes a double-submit-safe
// progress state on the direct-commit path.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..", "..");

const PAGE = readFileSync(path.join(REPO, "src", "app", "app", "admin", "imports", "[id]", "page.tsx"), "utf8");
const CTRL = readFileSync(path.join(REPO, "src", "app", "app", "admin", "imports", "[id]", "BulkCoaReviewControls.tsx"), "utf8");
const COMMIT_BTN = readFileSync(path.join(REPO, "src", "app", "app", "admin", "imports", "[id]", "CoaReplaceCommitButton.tsx"), "utf8");
const ERRORS_CARD = readFileSync(path.join(REPO, "src", "app", "app", "admin", "imports", "[id]", "CoaErrorsCard.tsx"), "utf8");

describe("COA-UX-3 · §3 + §4 — Advanced sections removed from the COA import detail page", () => {
  it("page.tsx does not import CoaMappingTable", () => {
    expect(PAGE).not.toMatch(/^import \{[^}]*CoaMappingTable[^}]*\} from "\.\/CoaMappingTable";/m);
  });
  it("page.tsx does not render <CoaMappingTable>", () => {
    expect(PAGE).not.toMatch(/<CoaMappingTable\b/);
  });
  it('page.tsx does not render the "Advanced grid" disclosure', () => {
    expect(PAGE).not.toMatch(/Advanced grid · full per-row mapping table/);
  });
  it('page.tsx does not render the "Advanced validation details" disclosure', () => {
    expect(PAGE).not.toMatch(/Advanced validation details/);
    expect(PAGE).not.toMatch(/data-testid="advanced-validation-details"/);
  });
});

describe("COA-UX-3 · §5 — error/warning navigation wires into BulkCoaReviewControls", () => {
  it("BulkCoaReviewControls listens to both CoaErrorsCard window events", () => {
    expect(CTRL).toMatch(/window\.addEventListener\("spectre:coa-next-error"/);
    expect(CTRL).toMatch(/window\.addEventListener\("spectre:coa-jump-to-row"/);
    expect(CTRL).toMatch(/window\.removeEventListener\("spectre:coa-next-error"/);
    expect(CTRL).toMatch(/window\.removeEventListener\("spectre:coa-jump-to-row"/);
  });
  it("BulkCoaReviewControls exposes errorRowNumbers on the props type (§5 + §6)", () => {
    expect(CTRL).toMatch(/errorRowNumbers\??:\s*number\[\]/);
  });
  it("BulkCoaReviewControls' jump handler sets inspectedId and clears blocking filters (§5)", () => {
    expect(CTRL).toMatch(/function jumpToRowNumber\(rowNumber: number\)/);
    expect(CTRL).toMatch(/setInspectedId\(row\.rowId\)/);
    // Filters are cleared when the targeted row would otherwise be
    // hidden — never jumps blindly off-screen without resetting the
    // query string.
    expect(CTRL).toMatch(/applyFilter\(props\.rows, filter\)[\s\S]{0,300}params\.delete\(k\)/);
  });
  it("page.tsx computes errorRowNumbers from batch.errors and passes them to BulkCoaReviewControls", () => {
    expect(PAGE).toMatch(/const coaErrorRowNumbers =[\s\S]*?batch\.errors\.map\(\(e\) => e\.rowNumber\)/);
    expect(PAGE).toMatch(/errorRowNumbers=\{coaErrorRowNumbers\}/);
  });
  it("left-grid <tr> rows carry data-row-id so the jump handler can scrollIntoView (§5)", () => {
    expect(CTRL).toMatch(/data-row-id=\{r\.rowId\}/);
    expect(CTRL).toMatch(/data-row-number=\{r\.rowNumber\}/);
    expect(CTRL).toMatch(/scrollIntoView\(\{ behavior: "smooth", block: "center" \}\)/);
  });
});

describe("COA-UX-3 · §14 — error-vs-warning label fidelity in CoaErrorsCard", () => {
  it('"Next" button swaps between "Next error" and "Next warning" based on hard-error count', () => {
    expect(ERRORS_CARD).toMatch(/hardErrors\.length > 0 \? "Next error →" : "Next warning →"/);
  });
  it('"See details" button swaps between error / warning labels', () => {
    expect(ERRORS_CARD).toMatch(/"See error details"[\s\S]{0,80}"See warning details"/);
    expect(ERRORS_CARD).toMatch(/"Hide error details"[\s\S]{0,80}"Hide warning details"/);
  });
  it("warning-only summary bar colors switch to amber", () => {
    // When hardErrors.length === 0, the summary bar + toggle use
    // amber-700 instead of red-700.
    expect(ERRORS_CARD).toMatch(/hardErrors\.length > 0 \? "text-red-700" : "text-amber-700"/);
  });
});

describe("COA-UX-3 · §8-11 — commit progress UX on the direct-commit button", () => {
  it("direct-commit button runs the server action inside a useTransition", () => {
    expect(COMMIT_BTN).toMatch(/startTransition\(async \(\)/);
    expect(COMMIT_BTN).toMatch(/isPending/);
  });
  it("label swaps to a processing message while pending (§8)", () => {
    expect(COMMIT_BTN).toMatch(/isPending \? "Importing chart of accounts…" : "Complete import"/);
  });
  it("exposes an aria-busy progressbar role with no fake percentage (§9)", () => {
    expect(COMMIT_BTN).toMatch(/role="progressbar"/);
    expect(COMMIT_BTN).toMatch(/aria-busy="true"/);
    // Hard assertion: no fabricated percentage in the pending state.
    expect(COMMIT_BTN).not.toMatch(/\b(17|42|83)%/);
  });
  it("button is disabled while pending (§12 double-submit guard)", () => {
    expect(COMMIT_BTN).toMatch(/disabled=\{isPending\}/);
    // onClick also guards with `if (isPending) return` as a belt-&-braces check.
    expect(COMMIT_BTN).toMatch(/if \(isPending\) return/);
  });
});

describe("COA-UX-3 · regression guards for the existing primary workspace (§15)", () => {
  it("Inspector still renders Classification / Department / Fund / Review sections", () => {
    expect(CTRL).toMatch(/<Section title="Classification">/);
    expect(CTRL).toMatch(/<Section title="Department">/);
    expect(CTRL).toMatch(/<Section title="Fund">/);
    expect(CTRL).toMatch(/<Section title="Review">/);
  });
  it("the bulk toolbar still exposes Classification / Department / Fund / Policy menus", () => {
    expect(CTRL).toMatch(/BulkMenu label="Classification"/);
    expect(CTRL).toMatch(/BulkMenu label="Department"/);
    expect(CTRL).toMatch(/BulkMenu label="Fund"/);
    expect(CTRL).toMatch(/BulkMenu label="Policy"/);
  });
  it("review filter preserves the attention / needs / done options", () => {
    expect(CTRL).toMatch(/\["ATTENTION", "attention"\]/);
    expect(CTRL).toMatch(/\["NOT_REVIEWED", "needs"\]/);
    expect(CTRL).toMatch(/\["REVIEWED", "done"\]/);
  });
});
