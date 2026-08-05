// Sprint 3 · Checkpoint 16H rejection #2 (2026-08-06) — every
// genuine mailbox email materializes. Covers §11 acceptance rules.
//
// Contract:
//   - HTML-only email with no attachment creates a Work Intake item.
//   - Informational newsletter appears in the feed.
//   - Absence of plain text does not exclude the email.
//   - Bulk / list mail (List-Unsubscribe / List-Id) → INFORMATIONAL,
//     never SUPPRESS.
//   - No AP fields are fabricated on an informational classification.
//   - Cross-mailbox / cross-tenant materialization is refused.

import { describe, it, expect } from "vitest";
import { classifyEmail, CLASSIFIER_RULES } from "@/lib/mailbox/classifier";
import type { NormalizedEmail } from "@/lib/mailbox/normalize";

function make(overrides: Partial<NormalizedEmail> = {}): NormalizedEmail {
  return {
    graphMessageId: "gm-1",
    immutableId: null,
    internetMessageId: "<im-1@x.test>",
    conversationId: "conv-1",
    senderAddress: "sender@example.com",
    senderName: "Sender",
    recipients: { to: [], cc: [], bcc: [] },
    subject: "hello",
    receivedAt: new Date("2026-07-22T19:41:06Z"),
    sentAt: new Date("2026-07-22T19:40:59Z"),
    preview: "",
    bodyHtmlSanitized: null,
    bodyTextExtract: null,
    importance: "normal",
    isRead: false,
    hasAttachments: false,
    webLink: null,
    isRemoved: false,
    headers: {},
    ...overrides,
  };
}

describe("16H rejection #2 · classifier — informational default", () => {
  it("list-mail (List-Unsubscribe) → INFORMATIONAL, not SUPPRESS", () => {
    const c = classifyEmail(make({
      subject: "Weekly Update — Week of July 22nd, 2026",
      senderAddress: "noreply@silverspringsgolfclub.com",
      headers: { "list-unsubscribe": "<mailto:unsub@list.test>" },
      bodyHtmlSanitized: "<h1>Update</h1><p>Course news</p>",
      bodyTextExtract: "Update Course news",
    }));
    expect(c.intakeAction).toBe("CREATE_INFORMATIONAL");
    expect(c.label).toBe("INFORMATIONAL");
  });

  it("no-reply sender → INFORMATIONAL, not SUPPRESS", () => {
    const c = classifyEmail(make({
      senderAddress: "noreply@bulletin.example",
      subject: "Newsletter",
    }));
    expect(c.intakeAction).toBe("CREATE_INFORMATIONAL");
  });

  it("HTML-only body (no text extract) still classifies as INFORMATIONAL", () => {
    const c = classifyEmail(make({
      bodyHtmlSanitized: "<h1>Members</h1>",
      bodyTextExtract: null,
    }));
    expect(c.intakeAction).toBe("CREATE_INFORMATIONAL");
  });

  it("no classifier rule emits SUPPRESS anymore (bulk/no-reply route to INFORMATIONAL)", () => {
    for (const r of CLASSIFIER_RULES) {
      expect(r.intakeAction, `rule ${r.key} must not SUPPRESS`).not.toBe("SUPPRESS");
    }
  });

  it("informational classification carries no invoice / vendor / AP inference", () => {
    const c = classifyEmail(make({
      senderAddress: "noreply@silverspringsgolfclub.com",
      subject: "Weekly Update",
    }));
    // The label + reason must be the informational track, not an
    // invoice / vendor track — no fabricated AP surface.
    expect(c.label).toBe("INFORMATIONAL");
    expect(c.reason.toLowerCase()).not.toContain("invoice");
    expect(c.reason.toLowerCase()).not.toContain("vendor");
    expect(c.reason.toLowerCase()).not.toContain("amount due");
  });

  it("importance-high sender still routes as ACTIONABLE (regression guard)", () => {
    const c = classifyEmail(make({ importance: "high", senderAddress: "board@corp.test" }));
    expect(c.intakeAction).toBe("CREATE_ACTIONABLE");
  });
});
