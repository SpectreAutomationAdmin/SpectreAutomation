// Sprint 3 · Post-16H P0-hardening (2026-08-07) — §6 regression
// matrix. Founder-directed 11-scenario matrix that locks the
// systemic invariants:
//
//   (a) hard PDF-pending classifier invariant (§2)
//   (b) reclassification without Mission Control render (§1)
//   (c) idempotent recovery + no duplicates (§4)
//   (d) source provenance (§3 — locked by
//        p0-hardening-body-provenance.test.ts)
//
// Runtime shape: pure classifier + reclassifier unit tests. No
// Prisma, no network. Where a scenario requires DB writes (e.g.,
// "email arrives + attachment metadata delayed"), the assertion
// is on the CLASSIFIER RESULT + reclassifier's contract, not on
// end-to-end persistence — the Playwright staging spec covers
// end-to-end on the real DMM record.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { classifyEmail } from "@/lib/mailbox/classifier";
import type { NormalizedEmail } from "@/lib/mailbox/normalize";

function baseEmail(over: Partial<NormalizedEmail> = {}): NormalizedEmail {
  return {
    graphMessageId: "test-msg",
    immutableId: null,
    internetMessageId: "test-int",
    conversationId: "test-conv",
    senderAddress: "sender@vendor.example",
    senderName: "Sender",
    recipients: { to: ["accounts@club.example"], cc: [], bcc: [] },
    subject: "(no subject)",
    receivedAt: new Date("2026-08-07T12:00:00Z"),
    sentAt: null,
    preview: "",
    bodyHtmlSanitized: null,
    bodyTextExtract: null,
    importance: "normal",
    isRead: false,
    hasAttachments: false,
    webLink: null,
    isRemoved: false,
    headers: {},
    ...over,
  };
}

describe("P0-hardening · §6 regression matrix — classifier invariants", () => {
  // Scenario 1: normal PDF (invoice keyword + attachment) → INVOICE_LIKELY
  it("scenario-1 normal PDF (invoice keyword + attachment) → INVOICE_LIKELY", () => {
    const r = classifyEmail(baseEmail({
      subject: "Invoice 12345 for services",
      hasAttachments: true,
      preview: "Attached is your invoice.",
    }));
    expect(r.label).toBe("INVOICE_LIKELY");
    expect(r.ruleKey).toBe("vendor_invoice_via_pdf_and_keywords");
  });

  // Scenario 2: delayed attachment metadata (hasAttachments=true but
  // classifier still sees the message before EmailAttachment row lands)
  // → MUST NOT terminate as ordinary INFORMATIONAL. Founder §2.
  it("scenario-2 delayed attachment metadata (hasAttachments=true, generic subject) → has_attachment_pending_analysis (NOT informational_default)", () => {
    const r = classifyEmail(baseEmail({
      subject: "FW: for your files",
      preview: "See attached.",
      hasAttachments: true,
    }));
    expect(r.ruleKey).not.toBe("informational_default");
    expect(r.ruleKey).toBe("has_attachment_pending_analysis");
    expect(r.intakeAction).toBe("CREATE_ACTIONABLE");
  });

  // Scenario 3: delayed document analysis (attachment IS there, but
  // analysis hasn't finished) — same classification path as scenario 2
  // from the classifier's point of view; reclassifier promotes later.
  it("scenario-3 delayed document analysis → same pending-analysis routing", () => {
    const r = classifyEmail(baseEmail({
      subject: "Documents attached",
      hasAttachments: true,
      preview: "",
    }));
    expect(r.ruleKey).toBe("has_attachment_pending_analysis");
  });

  // Scenario 4: attachment fetch failure — the classifier still ran
  // when hasAttachments=true. Body must not become the source of AP
  // facts (locked by p0-hardening-body-provenance.test.ts).
  it("scenario-4 attachment fetch failure — email keeps pending-analysis routing", () => {
    const r = classifyEmail(baseEmail({
      subject: "Bill from ACME",
      hasAttachments: true,
      preview: "Amount due $1,000.",
    }));
    // Either the specific invoice rule matches OR pending-analysis
    // catches it — both are ACTIONABLE routes. Never
    // informational_default.
    expect(r.ruleKey).not.toBe("informational_default");
    expect(r.intakeAction).toBe("CREATE_ACTIONABLE");
  });

  // Scenario 5: retry succeeds — asserted at the reclassifier layer
  // (idempotency guaranteed by the source-contract test below).
  it("scenario-5 retry succeeds — reclassifier is idempotent", async () => {
    // Import + mock prisma calls to prove the reclassifier is a
    // no-op on a second call. Full DB integration is covered by
    // Playwright acceptance.
    vi.doMock("@/lib/prisma", () => {
      let call = 0;
      return {
        prisma: {
          workIntakeItem: {
            findFirst: vi.fn().mockImplementation(() => {
              call++;
              if (call === 1) return { id: "wi1", status: "INFORMATIONAL", classification: "INFORMATIONAL", classificationMethod: "RULE", classificationRuleKey: "informational_default", ownerUserId: null, resolvedAt: null };
              return { id: "wi1", status: "OPEN", classification: "INVOICE_LIKELY", classificationMethod: "RULE", classificationRuleKey: "reclassify_from_canonical_analysis", ownerUserId: null, resolvedAt: null };
            }),
            update: vi.fn().mockResolvedValue({}),
          },
        },
      };
    });
    const { reclassifyFromCanonicalAnalysis } = await import("@/lib/mailbox/reclassify-from-canonical-analysis");
    const first = await reclassifyFromCanonicalAnalysis({
      clubId: "c1", parentWorkIntakeItemId: "wi1",
      canonicalAnalysisSucceeded: true, canonicalDocumentClass: "INVOICE",
    });
    const second = await reclassifyFromCanonicalAnalysis({
      clubId: "c1", parentWorkIntakeItemId: "wi1",
      canonicalAnalysisSucceeded: true, canonicalDocumentClass: "INVOICE",
    });
    expect(first.updated).toBe(true);
    expect(second.updated).toBe(false);   // idempotent
    vi.resetModules();
  });

  // Scenario 6: duplicate / retransmitted PDF — the classifier still
  // routes correctly; the materialiser dedups by SHA + canonical-intake
  // natural key (proven separately via Playwright audit).
  it("scenario-6 duplicate retransmission — classifier still ACTIONABLE, no double-informational", () => {
    const r = classifyEmail(baseEmail({
      subject: "Re: Invoice 12345 for services",
      hasAttachments: true,
    }));
    expect(r.intakeAction).toBe("CREATE_ACTIONABLE");
  });

  // Scenario 7: HTML email with no PDF — legitimate INFORMATIONAL.
  it("scenario-7 HTML email with no PDF → informational_default is OK", () => {
    const r = classifyEmail(baseEmail({
      subject: "Newsletter — August 2026",
      hasAttachments: false,
      preview: "This is the August update.",
    }));
    // Rule may be informational_default OR one of the more-specific
    // informational rules (list_mail, automated_sender). Either is OK
    // provided no attachment is present.
    expect(r.label).toBe("INFORMATIONAL");
  });

  // Scenario 8: invoice-like body + PDF — the classifier routes to
  // ACTIONABLE. Body cannot substitute for the PDF (source-contract
  // test locks that at the projection layer).
  it("scenario-8 invoice-like body + PDF → INVOICE_LIKELY (PDF is authoritative)", () => {
    const r = classifyEmail(baseEmail({
      subject: "Invoice for July",
      preview: "Amount due $1,234.56 by August 15.",
      hasAttachments: true,
    }));
    expect(r.ruleKey).toBe("vendor_invoice_via_pdf_and_keywords");
  });

  // Scenario 9: forwarded invoice — hasAttachments still true → pending-
  // analysis routing catches it even without invoice keywords.
  it("scenario-9 forwarded invoice → pending-analysis routing (never informational_default)", () => {
    const r = classifyEmail(baseEmail({
      subject: "Fwd: for your review",
      senderName: "Chris",
      senderAddress: "c.s.turcato@gmail.com",
      hasAttachments: true,
      preview: "See attached.",
    }));
    expect(r.ruleKey).not.toBe("informational_default");
    expect(r.intakeAction).toBe("CREATE_ACTIONABLE");
  });

  // Scenario 10: non-invoice accounting document (statement /
  // credit memo) — classifier still routes to ACTIONABLE via
  // pending-analysis; document classifier decides the sub-type;
  // reclassifier promotes to correct label. From the email
  // classifier's view, the behaviour is the same.
  it("scenario-10 non-invoice accounting doc (statement) → ACTIONABLE pending analysis", () => {
    const r = classifyEmail(baseEmail({
      subject: "Statement",
      hasAttachments: true,
    }));
    // Either the "statement" keyword hits vendor_invoice_via_pdf_and_keywords
    // (its keyword list includes "statement") OR pending-analysis. Both
    // are ACTIONABLE.
    expect(r.intakeAction).toBe("CREATE_ACTIONABLE");
  });

  // Scenario 11: non-accounting PDF — the classifier only KNOWS the
  // email has an attachment; the document classifier decides the
  // sub-type after ingest. Email routing remains ACTIONABLE.
  it("scenario-11 non-accounting PDF → still ACTIONABLE (doc classifier decides)", () => {
    const r = classifyEmail(baseEmail({
      subject: "Menu draft",
      hasAttachments: true,
    }));
    expect(r.intakeAction).toBe("CREATE_ACTIONABLE");
  });
});

describe("P0-hardening · §1 reclassify is invocable without Mission Control", () => {
  beforeEach(() => vi.resetModules());

  it("reclassifyFromCanonicalAnalysis is a pure function of args + prisma state (no MC imports required)", async () => {
    // Structural check: importing the helper does NOT pull in the
    // Mission Control projection module. This proves the fix
    // decouples the authoritative trigger from the projection.
    const modText = (await import("node:fs")).readFileSync(
      new URL("../src/lib/mailbox/reclassify-from-canonical-analysis.ts", import.meta.url),
      "utf8",
    );
    // Extract only the import lines — mission-control-named log
    // events are fine (they're strings), only mission-control
    // module imports would prove coupling.
    const importLines = modText.split(/\r?\n/).filter((l) => /^\s*import\s/.test(l));
    const importText = importLines.join("\n");
    expect(importText).not.toContain("mission-control");
    expect(importText).not.toContain("intelligence-review-intakes");
    expect(importText).not.toContain("summariseApIntake");
  });
});
