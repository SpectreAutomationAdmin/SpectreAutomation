// Sprint 3 · Checkpoint 16H rejection #4 (2026-08-06) — attachment
// authority + AP promotion lifecycle. Covers founder §17 acceptance
// rules at unit-test scope. Full pipeline runs via staging repair.

import { describe, it, expect } from "vitest";
import { classifyEmail, CLASSIFIER_RULES } from "@/lib/mailbox/classifier";
import { classifyDocument, CLASSIFY_RULES_VERSION } from "@/lib/documents/classify";
import type { NormalizedEmail } from "@/lib/mailbox/normalize";

function makeEmail(overrides: Partial<NormalizedEmail> = {}): NormalizedEmail {
  return {
    graphMessageId: "gm-1", immutableId: null, internetMessageId: null,
    conversationId: "conv-1",
    senderAddress: "chris@example.com", senderName: "Chris",
    recipients: { to: [], cc: [], bcc: [] },
    subject: "For your review",
    receivedAt: new Date("2026-08-05T13:20:23Z"),
    sentAt: new Date("2026-08-05T13:20:15Z"),
    preview: "",
    bodyHtmlSanitized: null, bodyTextExtract: null,
    importance: "normal", isRead: false, hasAttachments: false,
    webLink: null, isRemoved: false, headers: {},
    ...overrides,
  };
}

describe("16H rejection #4 · email classifier — attachment authority", () => {
  it("vague email body + PDF attachment → CREATE_ACTIONABLE (not Informational)", () => {
    const c = classifyEmail(makeEmail({
      subject: "For your review",
      bodyTextExtract: "",
      hasAttachments: true,
    }));
    // Founder §4/§5: attachment authority wins over vague body.
    // The email card is NOT terminally Informational while analysis
    // is still pending.
    expect(c.intakeAction).toBe("CREATE_ACTIONABLE");
    expect(c.ruleKey).toBe("has_attachment_pending_analysis");
  });

  it("HTML newsletter with NO attachment stays Informational (no false AP)", () => {
    const c = classifyEmail(makeEmail({
      senderAddress: "noreply@silverspringsgolfclub.com",
      subject: "Weekly Update",
      hasAttachments: false,
      headers: { "list-unsubscribe": "<mailto:x@list.test>" },
    }));
    expect(c.intakeAction).toBe("CREATE_INFORMATIONAL");
  });

  it("no-reply address + PDF attachment → attachment wins over no-reply", () => {
    // A real vendor invoice can arrive from a no-reply sender with
    // a vague subject that carries no invoice/vendor keyword. Prior
    // to this fix that combination fell through to
    // automated_sender_pattern → INFORMATIONAL. Now attachment
    // authority runs first and produces a provisional ACTIONABLE.
    const c = classifyEmail(makeEmail({
      senderAddress: "noreply@vendor.example",
      subject: "Attached document",
      hasAttachments: true,
    }));
    expect(c.intakeAction).toBe("CREATE_ACTIONABLE");
    expect(c.ruleKey).toBe("has_attachment_pending_analysis");
  });

  it("invoice-keyword email still classifies as INVOICE_LIKELY (earlier rule wins)", () => {
    const c = classifyEmail(makeEmail({
      subject: "Invoice #4321 — please pay",
      hasAttachments: true,
    }));
    expect(c.label).toBe("INVOICE_LIKELY");
    expect(c.intakeAction).toBe("CREATE_ACTIONABLE");
  });

  it("informational_default remains terminal only when there are NO attachments", () => {
    const c = classifyEmail(makeEmail({ hasAttachments: false }));
    expect(c.ruleKey).toBe("informational_default");
    expect(c.intakeAction).toBe("CREATE_INFORMATIONAL");
  });
});

describe("16H rejection #4 · document classifier — mime-default INVOICE fallback", () => {
  it("PDF filename with NO invoice keyword defaults to INVOICE (candidate)", () => {
    const out = classifyDocument({
      filename: "b0037fc.pdf",
      originalFilename: "B0037FC.PDF",
      mimeType: "application/pdf",
      emailSubject: "For your review",
      emailBodyExcerpt: "",
    });
    expect(out.classification).toBe("INVOICE");
    expect(out.ruleKey).toBe("mime.pdf_or_image_default_invoice");
  });

  it("JPEG image (phone snapshot invoice) defaults to INVOICE", () => {
    const out = classifyDocument({
      filename: "img_1234.jpg",
      originalFilename: "IMG_1234.jpg",
      mimeType: "image/jpeg",
      emailSubject: "here it is",
      emailBodyExcerpt: "",
    });
    expect(out.classification).toBe("INVOICE");
    expect(out.ruleKey).toBe("mime.pdf_or_image_default_invoice");
  });

  it("keyword-tagged filename beats mime fallback (purchase-order)", () => {
    const out = classifyDocument({
      filename: "purchase-order-42.pdf",
      originalFilename: "purchase-order-42.pdf",
      mimeType: "application/pdf",
      emailSubject: "PO",
      emailBodyExcerpt: "",
    });
    expect(out.classification).toBe("PURCHASE_ORDER");
    expect(out.ruleKey).toBe("filename.purchase_order");
  });

  it("keyword-tagged filename beats mime fallback (statement)", () => {
    const out = classifyDocument({
      filename: "statement.pdf",
      originalFilename: "statement.pdf",
      mimeType: "application/pdf",
      emailSubject: "",
      emailBodyExcerpt: "",
    });
    expect(out.classification).toBe("STATEMENT");
  });

  it("non-invoice mime (application/msword) does NOT default to INVOICE", () => {
    const out = classifyDocument({
      filename: "notes.docx",
      originalFilename: "notes.docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      emailSubject: "",
      emailBodyExcerpt: "",
    });
    expect(out.classification).toBe("UNKNOWN");
  });

  it("classifier rules version was bumped for the mime-default addition", () => {
    expect(CLASSIFY_RULES_VERSION).toBe(2);
  });
});

describe("16H rejection #4 · precedence + hardcoding guard", () => {
  it("no email-classifier rule hardcodes a subject, sender, or filename literal specific to the founder", () => {
    // Founder §11 / §14: no subject-specific / sender-specific / vendor-specific hardcoding.
    for (const rule of CLASSIFIER_RULES) {
      const reason = (rule.reason ?? "").toLowerCase();
      expect(reason, `rule ${rule.key} must not reference a specific sender`).not.toContain("silverspringsgolfclub");
      expect(reason).not.toContain("cturcato");
      expect(reason).not.toContain("weekly update");
      expect(reason).not.toContain("for your review");
      expect(reason).not.toContain("b0037fc");
      expect(reason).not.toContain("membership inquiry");
    }
  });

  it("has_attachment_pending_analysis runs BEFORE list_mail_or_marketing in the ordered registry", () => {
    const idxAttachment = CLASSIFIER_RULES.findIndex((r) => r.key === "has_attachment_pending_analysis");
    const idxList = CLASSIFIER_RULES.findIndex((r) => r.key === "list_mail_or_marketing");
    expect(idxAttachment).toBeGreaterThan(-1);
    expect(idxList).toBeGreaterThan(-1);
    expect(idxAttachment, "attachment authority must precede list_mail").toBeLessThan(idxList);
  });

  it("has_attachment_pending_analysis runs BEFORE automated_sender_pattern", () => {
    const idxAttachment = CLASSIFIER_RULES.findIndex((r) => r.key === "has_attachment_pending_analysis");
    const idxAuto = CLASSIFIER_RULES.findIndex((r) => r.key === "automated_sender_pattern");
    expect(idxAttachment).toBeLessThan(idxAuto);
  });

  it("informational_default remains last so it only catches truly unclassified messages", () => {
    const idxLast = CLASSIFIER_RULES.findIndex((r) => r.key === "informational_default");
    expect(idxLast).toBe(CLASSIFIER_RULES.length - 1);
  });
});
