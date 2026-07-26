// Sprint 3 Checkpoint 15H Remediation (2026-07-25) — Source-contract
// locks for the founder-acceptance remediation. Verifies:
//   * parser vendor-name skips date-like lines + prefers corporate-suffix line
//   * subtotal label list includes "Charges" (Microsoft terminology)
//   * PO regex requires digits (not the label word)
//   * email sender is provenance-only in extraction; never a vendor signal
//   * validate emits missing_invoice_number + missing_total + missing_vendor
//     at HIGH severity (so the AP card issue count is honest)
//   * mailbox-attachment-ingest auto-materialises AP + Statement intakes
//   * AP materialiser exports materialiseSingleInvoiceDocument
//   * Statement materialiser exports materialiseSingleStatementDocument
//   * MC loaders set sortTimestamp = ingestedDocument.receivedAt
//   * MC page sorts merged workItems reverse-chronological on sortTimestamp
//   * work-type eyebrow labels rendered on all three card renderers
//   * AP evidence route surfaces sourceCorrespondence for the source email

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const PARSE = readFileSync(join(process.cwd(), "src/lib/ap-intelligence/parse-invoice.ts"), "utf8");
const VALIDATE = readFileSync(join(process.cwd(), "src/lib/ap-intelligence/validate.ts"), "utf8");
const MBOX_INGEST = readFileSync(join(process.cwd(), "src/lib/documents/mailbox-attachment-ingest.ts"), "utf8");
const AP_MATERIAL = readFileSync(join(process.cwd(), "src/lib/ap-intelligence/materialise.ts"), "utf8");
const STMT_MATERIAL = readFileSync(join(process.cwd(), "src/lib/ap-statement-intelligence/materialise.ts"), "utf8");
const AP_EVIDENCE = readFileSync(join(process.cwd(), "src/app/api/mission-control/work-intake/[id]/ap-evidence/route.ts"), "utf8");
const MC_INDEX = readFileSync(join(process.cwd(), "src/lib/mission-control/index.ts"), "utf8");
const MC_LOADERS = readFileSync(join(process.cwd(), "src/lib/mission-control/intelligence-review-intakes.ts"), "utf8");
const EMAIL_LOADER = readFileSync(join(process.cwd(), "src/lib/mission-control/email-intake.ts"), "utf8");
const REVIEW_CARD = readFileSync(join(process.cwd(), "src/components/mission-control/IntelligenceReviewCard.tsx"), "utf8");
const EMAIL_CARD = readFileSync(join(process.cwd(), "src/components/mission-control/EmailIntakeCard.tsx"), "utf8");
const MC_PAGE = readFileSync(join(process.cwd(), "src/app/app/admin/page.tsx"), "utf8");

describe("parse-invoice — vendor name skips dates + prefers corporate suffix", () => {
  it("has a corporate-suffix rule and runs it BEFORE the header-line fallback", () => {
    expect(PARSE).toMatch(/CORP_SUFFIX_LINE/);
    expect(PARSE).toMatch(/vendor\.name\.corp_suffix/);
    const suffixIdx = PARSE.indexOf("CORP_SUFFIX_LINE");
    const fallbackIdx = PARSE.indexOf("vendor.name.first_company_line");
    expect(suffixIdx).toBeGreaterThan(-1);
    expect(fallbackIdx).toBeGreaterThan(-1);
    expect(suffixIdx).toBeLessThan(fallbackIdx);
  });
  it("skips date-like, year-only, and month-name lines in the header fallback", () => {
    expect(PARSE).toMatch(/monthNames/);
    expect(PARSE).toMatch(/dateLike/);
    expect(PARSE).toMatch(/yearOnly/);
  });
});

describe("parse-invoice — Microsoft-compatible label lists", () => {
  it("subtotal accepts 'Charges' (Microsoft terminology)", () => {
    expect(PARSE).toMatch(/extractMoney\(text, \[[^\]]*"Charges"/);
  });
});

describe("parse-invoice — PO requires a digit + not the label word", () => {
  it("has a notLabel guard that requires at least one digit", () => {
    expect(PARSE).toMatch(/notLabel = \(v: string\) =>/);
    expect(PARSE).toMatch(/\/\\d\/\.test\(v\)/);
    expect(PARSE).toMatch(/\^\(number\|no\\.\?\|#\)\$/);
  });
});

describe("parse-invoice — email sender is provenance only, never a vendor signal", () => {
  it("does NOT fall back to args.emailSenderAddress for vendor.guessedEmail", () => {
    // The old code was: `const emailAddress = vendorEmail ?? (args.emailSenderAddress?.match(...)`
    // The new code assigns vendorEmail directly to emailAddress with a
    // separate `providenceEmail` for the remittance/context slot.
    expect(PARSE).toMatch(/providenceEmail/);
    expect(PARSE).toMatch(/guessedEmail: emailAddress/);
    // Extraction.remittance.email captures the sender for provenance,
    // NOT vendor.guessedEmail.
    expect(PARSE).toMatch(/remittance:\s*\{\s*address:\s*null,\s*email:\s*providenceEmail\s*\}/);
  });
});

describe("validate — honest issue count via missing-field findings", () => {
  it("emits missing_invoice_number at HIGH severity", () => {
    expect(VALIDATE).toMatch(/"ap\.invoice\.missing_invoice_number"/);
    const idx = VALIDATE.indexOf("missing_invoice_number");
    const block = VALIDATE.slice(idx, idx + 400);
    expect(block).toMatch(/severity:\s*"HIGH"/);
  });
  it("emits missing_total at HIGH severity", () => {
    expect(VALIDATE).toMatch(/"ap\.invoice\.missing_total"/);
    const idx = VALIDATE.indexOf("missing_total");
    const block = VALIDATE.slice(idx, idx + 400);
    expect(block).toMatch(/severity:\s*"HIGH"/);
  });
  it("emits missing_vendor_identity at HIGH severity", () => {
    expect(VALIDATE).toMatch(/"ap\.invoice\.missing_vendor_identity"/);
  });
  it("emits unreadable when extraction state is DOCUMENT_UNREADABLE", () => {
    expect(VALIDATE).toMatch(/"ap\.invoice\.unreadable"/);
    expect(VALIDATE).toMatch(/invoice\.state === "DOCUMENT_UNREADABLE"/);
  });
});

describe("mailbox-attachment-ingest — auto-materialise AP + Statement intakes", () => {
  it("calls materialiseSingleInvoiceDocument when classification is INVOICE", () => {
    expect(MBOX_INGEST).toMatch(/classification === "INVOICE"/);
    expect(MBOX_INGEST).toMatch(/materialiseSingleInvoiceDocument\(\{/);
  });
  it("calls materialiseSingleStatementDocument when classification is STATEMENT", () => {
    expect(MBOX_INGEST).toMatch(/classification === "STATEMENT"/);
    expect(MBOX_INGEST).toMatch(/materialiseSingleStatementDocument\(\{/);
  });
  it("catches errors so mailbox sync never fails on materialiser failure", () => {
    expect(MBOX_INGEST).toMatch(/ap_materialise_failed/);
    expect(MBOX_INGEST).toMatch(/statement_materialise_failed/);
  });
  it("also fires when the attachment is already stored (before the early return)", () => {
    // Founder-remediation upgrade: the hook must fire on re-enqueue so
    // docs that landed BEFORE the hook shipped can still materialise.
    // The shared helper `maybeMaterialiseInvoiceOrStatement` runs on
    // the SKIPPED_ALREADY_STORED early-return path AND on the normal
    // post-ingest path.
    const idxShort = MBOX_INGEST.indexOf('return { outcome: "SKIPPED_ALREADY_STORED"');
    expect(idxShort).toBeGreaterThan(-1);
    const idxHook = MBOX_INGEST.lastIndexOf("maybeMaterialiseInvoiceOrStatement", idxShort);
    expect(idxHook).toBeGreaterThan(-1);
    expect(idxHook).toBeLessThan(idxShort);
  });
});

describe("Materialisers — export single-document wrappers for the mailbox hook", () => {
  it("AP exports materialiseSingleInvoiceDocument", () => {
    expect(AP_MATERIAL).toMatch(/export async function materialiseSingleInvoiceDocument/);
  });
  it("Statement exports materialiseSingleStatementDocument", () => {
    expect(STMT_MATERIAL).toMatch(/export async function materialiseSingleStatementDocument/);
  });
});

describe("MC loaders — reverse-chronological ordering via sortTimestamp", () => {
  it("WorkItem type carries a sortTimestamp field", () => {
    expect(MC_INDEX).toMatch(/sortTimestamp\?:\s*string/);
  });
  it("MC snapshot sorts the merged feed by sortTimestamp DESC (newest first)", () => {
    expect(MC_INDEX).toMatch(/newest first/);
    // The sort compare must return `bt.localeCompare(at)` for desc.
    expect(MC_INDEX).toMatch(/bt\.localeCompare\(at\)/);
  });
  it("AP + Statement loaders set sortTimestamp = ingestedDocument.receivedAt", () => {
    const apBlock = MC_LOADERS.slice(MC_LOADERS.indexOf("loadApReviewIntakeItems"));
    const stmtBlock = MC_LOADERS.slice(MC_LOADERS.indexOf("loadStatementReviewIntakeItems"));
    expect(apBlock).toMatch(/sortTimestamp:\s*doc\.receivedAt\.toISOString\(\)/);
    expect(stmtBlock).toMatch(/sortTimestamp:\s*doc\.receivedAt\.toISOString\(\)/);
  });
  it("Email loader sets sortTimestamp = newest message.receivedAt", () => {
    expect(EMAIL_LOADER).toMatch(/sortTimestamp:\s*newestEmail\.receivedAt\.toISOString\(\)/);
  });
});

describe("Work-type visual system — category communicated via .spectre-mc-pill (Variant D)", () => {
  // Sprint 3 Checkpoint 15I (2026-07-26) — the founder-approved
  // Variant D design REMOVED the `.spectre-mc-worktype` eyebrow. The
  // pill (`.spectre-mc-pill --judgment|approval|comm|info|auto`)
  // communicates the category directly. The prior 15H eyebrow class
  // is deliberately absent from both cards.
  it("IntelligenceReviewCard uses .spectre-mc-pill for category (no worktype eyebrow)", () => {
    expect(REVIEW_CARD).toMatch(/spectre-mc-pill/);
    expect(REVIEW_CARD).not.toMatch(/spectre-mc-worktype/);
  });
  it("EmailIntakeCard uses .spectre-mc-pill for category (no worktype eyebrow)", () => {
    expect(EMAIL_CARD).toMatch(/spectre-mc-pill/);
    expect(EMAIL_CARD).not.toMatch(/spectre-mc-worktype/);
  });
  it("FeedItem (legacy system-generated) still picks a work-type slug from classification / idTag prefix", () => {
    expect(MC_PAGE).toMatch(/feedItemWorkTypeSlug/);
    expect(MC_PAGE).toMatch(/AP INVOICE/);
    expect(MC_PAGE).toMatch(/AR COLLECTIONS/);
  });
});

describe("AP evidence route — cross-links to source email correspondence", () => {
  it("resolves EmailAttachment → EmailMessage → primary intake", () => {
    expect(AP_EVIDENCE).toMatch(/attachment\.emailMessage/);
    expect(AP_EVIDENCE).toMatch(/workIntakeOrigins/);
  });
  it("surfaces sourceCorrespondence in the response payload", () => {
    expect(AP_EVIDENCE).toMatch(/sourceCorrespondence/);
  });
  it("never exposes the underlying attachment ID or storage key in the correspondence block", () => {
    // The sourceCorrespondence typed block must only carry
    // emailIntakeId + emailMessageId + sender + subject + receivedAt.
    // No graphAttachmentId, no storageKey, no storageBucket.
    const srcBlock = AP_EVIDENCE.slice(AP_EVIDENCE.indexOf("let sourceCorrespondence"));
    expect(srcBlock).not.toMatch(/storageKey/);
    expect(srcBlock).not.toMatch(/storageBucket/);
    expect(srcBlock).not.toMatch(/graphAttachmentId/);
  });
});

describe("Card primary action — queue-level (Variant D §3.4 supersedes label wording)", () => {
  // Sprint 3 Checkpoint 15I (2026-07-26) — the loader no longer
  // emits `actions: [{ label: "Review invoice" }]` etc. The Variant
  // D card synthesises queue-level actions (Resolve) at UI level
  // from workIntakeStatus. Domain actions live inside the expanded
  // tabs. See §3.4 of the founder brief.
  it("AP loader emits no card-level actions (actions synthesised by the card)", () => {
    // The AP loader block ends with `actions: [],` — the card
    // provides Resolve via `<button data-testid=\"card-resolve\">`.
    const apBlock = MC_LOADERS.slice(MC_LOADERS.indexOf("classification: \"AP_INVOICE_REVIEW\""));
    expect(apBlock).toMatch(/actions:\s*\[\]/);
  });
  it("Statement loader emits no card-level actions (actions synthesised by the card)", () => {
    const stBlock = MC_LOADERS.slice(MC_LOADERS.indexOf("classification: \"VENDOR_STATEMENT_REVIEW\""));
    expect(stBlock).toMatch(/actions:\s*\[\]/);
  });
  it("(rev) loader-emitted 'Review invoice' + 'Reconcile statement' labels removed", () => {
    expect(MC_LOADERS).not.toMatch(/label:\s*"Review invoice"/);
    expect(MC_LOADERS).not.toMatch(/label:\s*"Reconcile statement"/);
  });
});
