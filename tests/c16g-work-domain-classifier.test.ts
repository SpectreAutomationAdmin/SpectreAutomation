// Sprint 3 · Checkpoint 16G Stage B — work-domain classifier tests.
//
// Covers §24 "Work domains" cases + §25 blind-holdout emails whose
// bodies do NOT reuse Chris's founder-review subjects. No test uses
// "Membership Inquiry" as a subject; every membership case is
// generalized language.

import { describe, it, expect } from "vitest";
import { classifyWorkDomain, WORK_DOMAIN_CLASSIFIER_VERSION } from "@/lib/mailbox/work-domain-classifier";

const NEUTRAL_SENDER = { senderName: "Jane Doe", senderAddress: "jane@example.com", senderDomain: "example.com" };

describe("16G Stage B · classifyWorkDomain — canonical cases", () => {
  it("AP invoice with attached invoice document classifies ACCOUNTS_PAYABLE", () => {
    const d = classifyWorkDomain({
      ingestionClassification: "INVOICE_LIKELY",
      subject: "Invoice 1091559", bodyText: "Please find attached invoice 1091559, amount due $842.00 by August 30.",
      attachments: [{ filename: "1091559.pdf", classification: "INVOICE" }],
      hasAttachments: true, linkedToApWorkflow: true,
      ...NEUTRAL_SENDER,
    });
    expect(d.selectedDomain).toBe("ACCOUNTS_PAYABLE");
    expect(d.selectedIntent).toBe("APPROVE");
    expect(d.selectedSubtype).toBe("INVOICE");
    expect(d.confidence).toBeGreaterThan(0.5);
  });

  it("AR aging / collections message classifies ACCOUNTS_RECEIVABLE", () => {
    const d = classifyWorkDomain({
      subject: "Your account balance", bodyText: "Your member account has an outstanding balance. Please make a payment to bring your aging current.",
      ...NEUTRAL_SENDER,
    });
    expect(d.selectedDomain).toBe("ACCOUNTS_RECEIVABLE");
    expect(d.selectedIntent).toBe("COLLECT");
  });

  it("Payroll approval message classifies PAYROLL", () => {
    const d = classifyWorkDomain({
      subject: "Payroll cutoff", bodyText: "The pay period ended Friday. Timesheets are ready — please review gross pay for direct deposit.",
      ...NEUTRAL_SENDER,
    });
    expect(d.selectedDomain).toBe("PAYROLL");
    expect(d.selectedIntent).toBe("APPROVE");
  });

  it("Prospect inquiry about waitlist classifies MEMBERSHIP:WAITLIST", () => {
    // No subject reuses Chris's founder-review email.
    const d = classifyWorkDomain({
      subject: "Question about joining", bodyText: "Hi, could you tell me whether you have a wait list for full memberships this season? I'd love to become a member.",
      ...NEUTRAL_SENDER,
    });
    expect(d.selectedDomain).toBe("MEMBERSHIP");
    expect(d.selectedSubtype).toBe("WAITLIST");
    expect(d.selectedIntent).toBe("RESPOND");
  });

  it("Prospect asks about tour classifies MEMBERSHIP:PROSPECT_INQUIRY", () => {
    const d = classifyWorkDomain({
      subject: "Interested in a tour", bodyText: "My wife and I are considering membership. Could we schedule a club tour next week to see the facilities?",
      ...NEUTRAL_SENDER,
    });
    expect(d.selectedDomain).toBe("MEMBERSHIP");
    expect(d.selectedSubtype).toBe("PROSPECT_INQUIRY");
  });

  it("Existing member updating their contact info classifies MEMBERSHIP:MEMBER_SERVICE", () => {
    const d = classifyWorkDomain({
      subject: "Update my member profile", bodyText: "Please update my member number XY9142 to reflect my new address.",
      ...NEUTRAL_SENDER,
    });
    expect(d.selectedDomain).toBe("MEMBERSHIP");
    expect(d.selectedSubtype).toBe("MEMBER_SERVICE");
  });

  it("Operations request classifies OPERATIONS (not MEMBERSHIP even if 'grounds' appears)", () => {
    const d = classifyWorkDomain({
      subject: "Irrigation on 14 green", bodyText: "The irrigation head on 14 green is stuck open. Please have grounds take a look.",
      ...NEUTRAL_SENDER,
    });
    expect(d.selectedDomain).toBe("OPERATIONS");
    expect(d.selectedIntent).toBe("RESOLVE");
  });

  it("Governance / committee message classifies GOVERNANCE", () => {
    const d = classifyWorkDomain({
      subject: "Board meeting minutes", bodyText: "Attached are the minutes from Tuesday's board of directors meeting. Please review before the AGM.",
      ...NEUTRAL_SENDER,
    });
    expect(d.selectedDomain).toBe("GOVERNANCE");
  });

  it("Auto-reply / informational classifies INFORMATIONAL", () => {
    const d = classifyWorkDomain({
      subject: "Out of office", bodyText: "This is an automatic reply. I am out of office and will respond upon my return.",
      ...NEUTRAL_SENDER,
    });
    expect(d.selectedDomain).toBe("INFORMATIONAL");
    expect(d.selectedIntent).toBe("INFORM");
  });

  it("Ambiguous email with no strong signals falls back to GENERAL (never wrong-defaults to AP)", () => {
    const d = classifyWorkDomain({
      subject: "Quick question", bodyText: "Hi, do you have a minute to chat later?",
      ...NEUTRAL_SENDER,
    });
    expect(d.selectedDomain).toBe("GENERAL");
    // Critical: MUST NOT be ACCOUNTS_PAYABLE.
    expect(d.alternatives.find((a) => a.domain === "ACCOUNTS_PAYABLE")).toBeUndefined();
    expect(d.requiresReview).toBe(true);
  });
});

describe("16G Stage B · membership evidence, NOT subject-matching Chris", () => {
  // Every case uses novel wording. If we regress to hardcoding the
  // exact founder-review subject, these must still pass — proving
  // the classifier is generalized.

  it("classifies 'Are shares available?' as MEMBERSHIP", () => {
    const d = classifyWorkDomain({
      subject: "Are shares available?", bodyText: "Wondering whether you have any shareholder membership shares available for purchase this year.",
      ...NEUTRAL_SENDER,
    });
    expect(d.selectedDomain).toBe("MEMBERSHIP");
  });

  it("classifies 'Considering joining' as MEMBERSHIP", () => {
    const d = classifyWorkDomain({
      subject: "Considering joining", bodyText: "I've been considering membership for a while. What's the initiation fee and are there different membership categories to choose from?",
      ...NEUTRAL_SENDER,
    });
    expect(d.selectedDomain).toBe("MEMBERSHIP");
  });

  it("classifies 'Application form' as MEMBERSHIP:APPLICATION", () => {
    const d = classifyWorkDomain({
      subject: "Application form", bodyText: "Please send me the membership application. I would like to apply for membership.",
      ...NEUTRAL_SENDER,
    });
    expect(d.selectedDomain).toBe("MEMBERSHIP");
    expect(d.selectedSubtype).toBe("APPLICATION");
  });
});

describe("16G Stage B · founder-review case: 'Membership Inquiry' body", () => {
  // Verbatim wording taken from staging trace — must classify
  // MEMBERSHIP now, without any hardcoded subject rule.
  it("the exact founder-review body classifies MEMBERSHIP:WAITLIST", () => {
    const d = classifyWorkDomain({
      subject: "Membership Inquiry",
      bodyText: "Hello, I'm looking to inquiry on whether there is a waitlist for the full shareholder membership at the Club right now? Thank you, Chris Turcato, CPA Controller Silver Springs Golf and Country Club",
      ingestionClassification: "INTERNAL_OPERATIONS",   // what the current classifier assigned
      senderName: "Chris Turcato", senderAddress: "cturcato@silverspringsgolfclub.com", senderDomain: "silverspringsgolfclub.com",
    });
    expect(d.selectedDomain).toBe("MEMBERSHIP");
    expect(d.selectedSubtype).toBe("WAITLIST");
    expect(d.selectedIntent).toBe("RESPOND");
    expect(d.confidence).toBeGreaterThan(0.35);   // must NOT require-review
  });
});

describe("16G Stage B · classifier version pinning", () => {
  it("stamps every decision with the current classifier version", () => {
    const d = classifyWorkDomain({ subject: "hi", bodyText: "hello", ...NEUTRAL_SENDER });
    expect(d.classifierVersion).toBe(WORK_DOMAIN_CLASSIFIER_VERSION);
  });
});
