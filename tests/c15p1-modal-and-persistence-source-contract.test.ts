// Sprint 3 · Checkpoint 15P-1 (2026-07-27) — source-contract
// locks for the corrective modal + persistence changes.
//
// Founder-observed defects on the pre-15P-1 staging modal:
//   1. Address section still blank on the real Microsoft invoice.
//   2. Profile hidden behind a radio-button — required a click to
//      even see the fields.
//   3. Source shown as plain text below the header — not clickable.
//   4. Modal required excessive vertical scrolling.
//   5. Redundant subheadings (ADDRESS above ADDRESS LINE 1, etc.).
//   6. Contact + AR + remittance emails collected but never persisted.
//
// This suite locks the corrections so a future refactor cannot
// silently regress them.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

function read(p: string) { return readFileSync(join(process.cwd(), p), "utf8"); }

const MODAL = read("src/components/mission-control/CreateVendorAndPostModal.tsx");
const STEP1 = read("src/app/app/admin/ap/_create-vendor-actions.ts");
const CSS   = read("src/app/globals.css");
const IRI   = read("src/lib/mission-control/intelligence-review-intakes.ts");

// ---------------------------------------------------------------------------
// Defect #2 — radio-button gate REMOVED
// ---------------------------------------------------------------------------

describe("15P-1 · defect 2 — no radio-button gate; profile visible on open", () => {
  it("vendorMode default is CREATE_NEW (not null)", () => {
    expect(MODAL).toMatch(/useState<"CREATE_NEW" \| "USE_EXISTING">\("CREATE_NEW"\)/);
  });
  it("the pre-15P-1 'cvap-choose-new' radio no longer exists", () => {
    expect(MODAL).not.toMatch(/data-testid="cvap-choose-new"/);
  });
  it("the profile section is NEVER hidden via a `hidden` attribute", () => {
    // hidden={vendorMode !== "CREATE_NEW"} was the gate; it must be gone.
    expect(MODAL).not.toMatch(/data-testid="cvap-profile"[^>]*hidden=/);
  });
  it("primary Step-1 label is 'Create vendor & continue' when creating new", () => {
    expect(MODAL).toMatch(/usingExisting \? "Use selected vendor" : "Create vendor & continue"/);
  });
});

// ---------------------------------------------------------------------------
// Defect #3 — Source is a clickable PDF-preview link
// ---------------------------------------------------------------------------

describe("15P-1 · defect 3 — Source is a clickable link to the invoice PDF", () => {
  it("modal imports DocumentPreviewModal", () => {
    expect(MODAL).toMatch(/import DocumentPreviewModal from ".\/DocumentPreviewModal"/);
  });
  it("modal renders a 'Source' link with the invoice filename", () => {
    expect(MODAL).toMatch(/data-testid="cvap-source-link"/);
    expect(MODAL).toMatch(/spectre-cvap-source-label/);
    expect(MODAL).toMatch(/spectre-cvap-source-filename/);
  });
  it("clicking the Source link opens the DocumentPreviewModal", () => {
    expect(MODAL).toMatch(/onClick=\{\(\) => setPreviewOpen\(true\)\}/);
    expect(MODAL).toMatch(/previewOpen && primaryDoc \? \(/);
    expect(MODAL).toMatch(/<DocumentPreviewModal[\s\S]{0,200}documentId=\{primaryDoc\.documentId\}[\s\S]{0,120}filename=\{primaryDoc\.filename\}/);
  });
  it("source link is styled as a pill chip that sits in the header title row", () => {
    // Header title row + chip class are what carry the visual identity.
    expect(MODAL).toMatch(/spectre-cvap-title-row/);
    expect(CSS).toMatch(/\.spectre-cvap-source-link\s*\{[\s\S]{0,600}border-radius: var\(--spectre-radius-pill\)/);
  });
});

// ---------------------------------------------------------------------------
// Defects #4 + #5 — modal is compressed; single 3-col grid
// ---------------------------------------------------------------------------

describe("15P-1 · defects 4-5 — modal compressed to a single 3-col grid", () => {
  it("dialog max-width widened from 780px to 1080px", () => {
    expect(CSS).toMatch(/\.spectre-cvap-dialog\s*\{[\s\S]{0,400}max-width: 1080px/);
  });
  it("profile grid uses 3 equal columns on wide viewports", () => {
    expect(CSS).toMatch(/\.spectre-cvap-profile-grid\s*\{[\s\S]{0,300}grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/);
  });
  it("profile grid falls back to 2-col at ≤900px and 1-col at ≤640px", () => {
    expect(CSS).toMatch(/@media \(max-width: 900px\)[\s\S]{0,200}grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
    expect(CSS).toMatch(/@media \(max-width: 640px\)[\s\S]{0,200}spectre-cvap-profile-grid[\s\S]{0,80}grid-template-columns: 1fr/);
  });
  it("pre-15P-1 ALL-CAPS section subheadings are removed (Identity / Address / Contact / Payment & tax / Notes)", () => {
    // The ProfileField labels remain; the spectre-cvap-subheading BLOCKS
    // above each cluster do not appear in Step 1 any more.
    const step1Body = MODAL.slice(MODAL.indexOf("function renderStep1"), MODAL.indexOf("function renderStep2"));
    expect(step1Body).not.toMatch(/spectre-cvap-subheading/);
  });
  it("ProfileField helper supports an explicit `span` prop (1|2|3) for the 3-col grid", () => {
    expect(MODAL).toMatch(/span\?: 1 \| 2 \| 3/);
    expect(MODAL).toMatch(/spectre-cvap-field--span2/);
    expect(MODAL).toMatch(/spectre-cvap-field--span3/);
  });
});

// ---------------------------------------------------------------------------
// Defect #6 — main contact + AR + remittance emails are PERSISTED
// ---------------------------------------------------------------------------

describe("15P-1 · defect 6 — vendor contact + AR + remittance emails are persisted to VendorContact", () => {
  it("Step 1 action inserts VendorContact rows inside the same transaction", () => {
    expect(STEP1).toMatch(/tx\.vendorContact\.create\(/);
  });
  it("main-contact fields become a VendorContact with isPrimary=true", () => {
    expect(STEP1).toMatch(/isPrimary: true/);
    expect(STEP1).toMatch(/mainContactName \|\| input\.vendorProfile\.mainContactEmail \|\| "Main contact"/);
  });
  it("AR email becomes a role='AR' contact", () => {
    expect(STEP1).toMatch(/name: "Accounts Receivable", role: "AR"/);
  });
  it("AP remittance email becomes a role='REMITTANCE' contact", () => {
    expect(STEP1).toMatch(/name: "AP Remittance", role: "REMITTANCE"/);
  });
  it("contact inserts are tenant-scoped (clubId) + cascade-delete via vendorId", () => {
    // clubId + vendorId are both threaded through the create data.
    const block = STEP1.slice(STEP1.indexOf("tx.vendorContact.create"));
    expect(block).toMatch(/clubId,\s*vendorId: created\.id/);
  });
});

// ---------------------------------------------------------------------------
// Cache invalidation — EXTRACTOR_VERSION baked into the AP projection key
// ---------------------------------------------------------------------------

describe("15P-1 · cache invalidation on redeploy", () => {
  it("apSummaryCacheKey embeds VENDOR_PROFILE_EXTRACTOR_VERSION", () => {
    expect(IRI).toMatch(/import \{ EXTRACTOR_VERSION as VENDOR_PROFILE_EXTRACTOR_VERSION \}/);
    expect(IRI).toMatch(/coa=\$\{coaRevision\}::vpx=\$\{VENDOR_PROFILE_EXTRACTOR_VERSION\}/);
  });
});
