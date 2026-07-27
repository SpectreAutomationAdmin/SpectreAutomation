// Sprint 3 · Checkpoint 15P-3 (2026-07-27) — source-contract locks
// for the vendor-search API rewrite + the modal chip changes.
//
// Founder rule (§Delivery): "Do not finish with a mock or source-
// contract-only implementation." The FULL correction ships in
// c15p3-vendor-matching-*.test.ts (unit) plus real staging
// verification against the Microsoft record. This suite locks the
// SHAPE so a future refactor can't silently regress the API contract
// or the "no percentage in the chip" UI rule.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

function read(p: string) { return readFileSync(join(process.cwd(), p), "utf8"); }

const ROUTE       = read("src/app/api/vendors/search/route.ts");
const RETRIEVE    = read("src/lib/vendor-matching/retrieve.ts");
const MODAL       = read("src/components/mission-control/CreateVendorAndPostModal.tsx");
const CSS         = read("src/app/globals.css");

// ---------------------------------------------------------------------------
// API rewrite — POST + typed body + evidence response
// ---------------------------------------------------------------------------

describe("15P-3 · API: POST /api/vendors/search with typed body", () => {
  it("route exports POST — no more GET-with-?q= endpoint", () => {
    expect(ROUTE).toMatch(/export async function POST\(req: Request\)/);
    expect(ROUTE).not.toMatch(/export async function GET\b/);
  });
  it("Zod schema accepts the full extracted vendor profile shape", () => {
    for (const f of [
      "legalName","operatingName","addressLine1","addressLine2","city",
      "provinceState","postalCode","country","phone","website",
      "email","arEmail","apRemittanceEmail","taxRegistrationNumber",
      "paymentTermsDays","mainContactName","mainContactEmail",
    ]) {
      expect(ROUTE).toMatch(new RegExp(`\\b${f}:\\s*z\\.`));
    }
  });
  it("returns 401 without a principal (tenant + auth preserved)", () => {
    expect(ROUTE).toMatch(/if \(!principal\) return NextResponse\.json\(\{ matches: \[\] \}, \{ status: 401 \}\)/);
  });
  it("clubId is threaded from principal.activeClubId — never trusted from body", () => {
    expect(ROUTE).toMatch(/const clubId = principal\.activeClubId/);
    expect(ROUTE).toMatch(/retrieveCandidates\(\{ clubId, extracted \}\)/);
  });
  it("hardcoded reason-tier lookup (65 / 80 / 85 / 98) is REMOVED", () => {
    expect(ROUTE).not.toMatch(/evidence\.includes\("name"\)\s*\?\s*65/);
    expect(ROUTE).not.toMatch(/evidence\.includes\("tax id"\)\s*\?\s*98/);
    // No hardcoded confidence tiers whatsoever.
    expect(ROUTE).not.toMatch(/const confidence =\s*evidence\.includes/);
  });
  it("evaluator is called on every candidate", () => {
    expect(ROUTE).toMatch(/import \{ evaluateVendorMatch \}/);
    expect(ROUTE).toMatch(/const ev = evaluateVendorMatch\(extracted, c\.profile\)/);
  });
  it("response shape includes matched / differed / notComparable + classification", () => {
    for (const f of ["classification","matchedFields","differedFields","notComparableFields","fieldsCompared","matchedWeight","rankingScore"]) {
      expect(ROUTE).toMatch(new RegExp(`\\b${f}:`));
    }
  });
});

// ---------------------------------------------------------------------------
// Candidate retrieval — no bank fields
// ---------------------------------------------------------------------------

describe("15P-3 · candidate retrieval never touches banking data", () => {
  it("select clause has no banking / EFT / processor fields", () => {
    const selectBlock = RETRIEVE.slice(RETRIEVE.indexOf("select: {"), RETRIEVE.indexOf("take: limit * 2"));
    // Strip block comments before scanning — the safety comment IS
    // allowed to name what's forbidden, but the actual `select`
    // fields must never include them.
    const withoutComments = selectBlock.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(withoutComments).not.toMatch(/bankingProfile|processorToken|iban|routing|accountLastFour|pennyTest/i);
  });
  it("VendorContact select ONLY returns role / name / email / isPrimary — never bank fields", () => {
    const contactsBlock = RETRIEVE.slice(RETRIEVE.indexOf("contacts: {"));
    expect(contactsBlock).toMatch(/role: true,\s*name: true,\s*email: true,\s*isPrimary: true/);
    expect(contactsBlock).not.toMatch(/routing|iban|accountLastFour/i);
  });
  it("retrieval uses identifying signals, does not require every signal", () => {
    for (const sig of ["legalName","operatingName","taxRegistrationNumber","email","phone","website","postalCode"]) {
      // Each signal appears at least once in the query builder.
      expect(RETRIEVE).toMatch(new RegExp(`\\b${sig}\\b`));
    }
    // Explicitly returns [] when no signal is present — never
    // fetches every vendor unfiltered.
    expect(RETRIEVE).toMatch(/if \(or\.length === 0\) return \[\]/);
  });
  it("tenant scope: every candidate query is clubId-filtered", () => {
    expect(RETRIEVE).toMatch(/where: \{ clubId: args\.clubId, OR: or \}/);
    expect(RETRIEVE).toMatch(/where: \{ clubId: args\.clubId, vendorId: v\.id \}/);
  });
});

// ---------------------------------------------------------------------------
// Modal — POST body + evidence-based chip + NO percentage
// ---------------------------------------------------------------------------

describe("15P-3 · modal: POST body carries the extracted profile", () => {
  it("loadMatches POSTs to /api/vendors/search with a typed body", () => {
    expect(MODAL).toMatch(/fetch\(`\/api\/vendors\/search`, \{\s*method: "POST"/);
    expect(MODAL).toMatch(/body: JSON\.stringify\(body\)/);
  });
  it("body carries every extractable field (address, phone, website, tax id, emails, terms)", () => {
    for (const f of [
      "legalName","addressLine1","addressLine2","city","provinceState","postalCode",
      "country","phone","website","email","arEmail","apRemittanceEmail",
      "taxRegistrationNumber","paymentTermsDays","mainContactName","mainContactEmail",
    ]) {
      expect(MODAL).toMatch(new RegExp(`\\b${f}:\\s`));
    }
  });
  it("PossibleMatch interface no longer carries a `confidence` numeric field", () => {
    // Regex targets the interface block specifically to avoid a
    // false hit on the internal field-provenance `confidence`.
    const ifaceStart = MODAL.indexOf("interface PossibleMatch {");
    const ifaceEnd = MODAL.indexOf("}", ifaceStart);
    const iface = MODAL.slice(ifaceStart, ifaceEnd);
    expect(iface).not.toMatch(/\bconfidence:\s*number/);
    // Evidence-based fields ARE present.
    expect(iface).toMatch(/classification:/);
    expect(iface).toMatch(/matchedFields: string\[\]/);
    expect(iface).toMatch(/differedFields: string\[\]/);
    expect(iface).toMatch(/notComparableFields: string\[\]/);
  });
  it("the chip renders NO percentage — the `{m.confidence}%` render is removed", () => {
    expect(MODAL).not.toMatch(/\{m\.confidence\}%/);
    expect(MODAL).not.toMatch(/\{match\.confidence\}%/);
    // The new copy is evidence-oriented.
    expect(MODAL).toMatch(/Exact match/);
    expect(MODAL).toMatch(/Strong match/);
    expect(MODAL).toMatch(/Possible match/);
  });
  it("chip carries a data-classification attribute for CSS + tests", () => {
    expect(MODAL).toMatch(/data-classification=\{match\.classification\}/);
  });
  it("disclosure lists matched + differed + notCompared field lists", () => {
    expect(MODAL).toMatch(/<summary>Evidence<\/summary>/);
    expect(MODAL).toMatch(/data-testid=\{`cvap-match-matched-\$\{match\.id\}`\}/);
  });
});

// ---------------------------------------------------------------------------
// CSS: classification color mapping (green / warning) exists
// ---------------------------------------------------------------------------

describe("15P-3 · CSS: classification color mapping", () => {
  it("exact match uses the success color", () => {
    expect(CSS).toMatch(/\.classification-exact\s*\{[\s\S]{0,80}var\(--spectre-status-success\)/);
  });
  it("conflicting match uses the warning color", () => {
    expect(CSS).toMatch(/\.classification-conflicting\s*\{[\s\S]{0,80}var\(--spectre-status-warning\)/);
  });
});
