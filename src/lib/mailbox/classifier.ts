// Sprint 2 B4 (2026-07-19) — Deterministic email classifier.
//
// Rule registry. Ordered — the first rule whose predicate returns
// true wins. Confidence describes the STRENGTH of the inference and
// is NEVER automatically 1.0 for a rule match (§9 of B4 directive).
// Rule keys and rule versions are recorded on the WorkIntakeItem so
// classification behaviour is auditable across releases.
//
// This is NOT AI. The classifier will grow to include AI-augmented
// narrative in a later sprint; for B4 it is auditable and rule-based.

import type { NormalizedEmail } from "./normalize";

export type ClassificationLabel =
  | "INVOICE_LIKELY"
  | "MEMBER_INQUIRY_LIKELY"
  | "VENDOR_COMMUNICATION"
  | "INTERNAL_OPERATIONS"
  | "HIGH_IMPORTANCE"
  | "INFORMATIONAL"
  | "LIKELY_NOISE"
  | "UNCLASSIFIED";

export interface ClassificationResult {
  label: ClassificationLabel;
  method: "RULE";
  ruleKey: string;
  ruleVersion: number;
  reason: string;
  confidence: number;
  /** Whether an intake item should be created. Suppressed noise
   *  creates no intake row (returns intakeAction "SUPPRESS"). */
  intakeAction: "CREATE_ACTIONABLE" | "CREATE_INFORMATIONAL" | "SUPPRESS";
}

export interface ClassifierRule {
  key: string;
  version: number;
  label: ClassificationLabel;
  reason: string;
  confidence: number;
  intakeAction: ClassificationResult["intakeAction"];
  matches(email: NormalizedEmail): boolean;
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------
function has(needle: string, hay: string): boolean {
  return hay.toLowerCase().includes(needle.toLowerCase());
}
function anyOf(needles: string[], hay: string): boolean {
  const h = hay.toLowerCase();
  return needles.some((n) => h.includes(n.toLowerCase()));
}
function hasPdfOrSpreadsheet(email: NormalizedEmail): boolean {
  // A rough signal used by the invoice rule below. Attachment MIME
  // types are looked up at materialiser time from `EmailAttachment`,
  // not from the raw Graph message. Since the classifier runs BEFORE
  // attachment metadata is stored, we rely on the presence-only
  // `hasAttachments` bit here and let the materialiser upgrade the
  // confidence when it sees a real PDF.
  // Rev-13 tri-state: `undefined` (Graph didn't assert) is treated
  // as "no attachments known" from the classifier's perspective —
  // same visible outcome as the old `?? false` coercion for this
  // read-only classifier consumer.
  return email.hasAttachments === true;
}
function isAutomatedSender(email: NormalizedEmail): boolean {
  const addr = email.senderAddress;
  return (
    /(^|\.)no-?reply@/i.test(addr) ||
    /^donotreply@/i.test(addr) ||
    /^mailer-daemon@/i.test(addr) ||
    /(^|\.)notifications@/i.test(addr)
  );
}
function hasAutoSubmittedHeader(email: NormalizedEmail): boolean {
  const v = (email.headers["auto-submitted"] ?? "").toLowerCase();
  return v && v !== "no" ? true : false;
}
function isListMail(email: NormalizedEmail): boolean {
  return "list-unsubscribe" in email.headers || "list-id" in email.headers;
}

// -----------------------------------------------------------------------------
// Rule registry — ordered. Add a version number when the predicate
// or reason text materially changes.
// -----------------------------------------------------------------------------
export const CLASSIFIER_RULES: ClassifierRule[] = [
  {
    key: "vendor_invoice_via_pdf_and_keywords",
    version: 1,
    label: "INVOICE_LIKELY",
    reason: "Sender looks like a vendor and the subject or body contains invoice keywords with a PDF-style attachment.",
    confidence: 0.85,
    intakeAction: "CREATE_ACTIONABLE",
    matches: (e) =>
      hasPdfOrSpreadsheet(e) &&
      anyOf(["invoice", "receipt", "statement", "past due", "past-due", "amount due"], e.subject + " " + e.preview),
  },
  {
    key: "invoice_keyword_only",
    version: 1,
    label: "INVOICE_LIKELY",
    reason: "Subject or preview contains invoice keywords but there is no supporting attachment.",
    confidence: 0.55,
    intakeAction: "CREATE_ACTIONABLE",
    matches: (e) =>
      anyOf(["invoice #", "invoice for", "please pay", "payment due"], e.subject + " " + e.preview),
  },
  {
    key: "member_inquiry_reservation",
    version: 1,
    label: "MEMBER_INQUIRY_LIKELY",
    reason: "Subject or body matches a common member-inquiry pattern.",
    confidence: 0.65,
    intakeAction: "CREATE_ACTIONABLE",
    matches: (e) =>
      anyOf(
        ["reservation", "tee time", "cancel", "reschedule", "member number", "please help", "question about my"],
        e.subject + " " + e.preview,
      ),
  },
  {
    key: "vendor_communication_domain",
    version: 1,
    label: "VENDOR_COMMUNICATION",
    reason: "Sender domain matches a known vendor pattern and does not look automated.",
    confidence: 0.55,
    intakeAction: "CREATE_ACTIONABLE",
    matches: (e) =>
      !isAutomatedSender(e) &&
      anyOf(
        ["sales@", "quotes@", "orders@", "accounting@", "billing@"],
        e.senderAddress,
      ),
  },
  {
    key: "internal_operations",
    version: 2,   // Sprint 3 · Checkpoint 16G Stage B — "membership" removed
    label: "INTERNAL_OPERATIONS",
    reason: "Sender domain matches a club or internal address; subject is operational.",
    confidence: 0.5,
    intakeAction: "CREATE_ACTIONABLE",
    matches: (e) =>
      // Sprint 3 · Checkpoint 16G Stage B (2026-08-04) — "membership"
      // removed from operations keywords. A prospect email asking
      // about waitlist / joining / share purchase must not be
      // treated as an operational facilities item. Domain routing
      // now runs through work-domain-classifier.ts which recognises
      // membership evidence positively.
      anyOf(
        ["irrigation", "kitchen", "clubhouse", "maintenance", "grounds", "pro shop"],
        e.subject + " " + e.preview,
      ),
  },
  {
    key: "high_importance_flag",
    version: 1,
    label: "HIGH_IMPORTANCE",
    reason: "Sender marked the message high importance.",
    confidence: 0.6,
    intakeAction: "CREATE_ACTIONABLE",
    matches: (e) => e.importance === "high",
  },
  // Sprint 3 · Checkpoint 16H rejection #4 (2026-08-06) — genuine
  // attachment-bearing emails must NOT terminate as Informational
  // before document analysis finishes (founder §4/§5/§7). This
  // rule provides the "provisional pending analysis" state that
  // sits between the specific-keyword rules above and the bulk /
  // no-reply / informational fallback below.
  //
  // Precedence:
  //   invoice_keyword / vendor rules  → real INVOICE_LIKELY (above)
  //   high_importance_flag           → HIGH_IMPORTANCE (above)
  //   THIS RULE (hasAttachments)     → ACTIONABLE pending analysis
  //   list_mail / no-reply / default → INFORMATIONAL
  //
  // Rationale: the document classifier
  // (src/lib/documents/classify.ts) now defaults any PDF/image
  // attachment to INVOICE so the AP materialiser runs OCR +
  // extraction on the CONTENT. This email-level rule ensures the
  // founder-visible card is NOT confidently labelled Informational
  // while that analysis is still in flight. Once ApIntakeSource
  // rows are written, `loadLinkedIntelligenceForEmailIntakes`
  // promotes the card to the AP invoice view via `invoiceSummary`.
  //
  // Attachment authority wins over list/no-reply/informational —
  // a real vendor invoice from a no-reply address must still route
  // to AP analysis, not a "no action" bucket.
  {
    key: "has_attachment_pending_analysis",
    version: 1,
    label: "INFORMATIONAL",
    reason: "Attachment present — document analysis pending. Card will refresh when OCR + extraction complete.",
    confidence: 0.5,
    intakeAction: "CREATE_ACTIONABLE",
    // Rev-13 tri-state: treat only explicit `true` as attachments present.
    matches: (e) => e.hasAttachments === true,
  },
  // Sprint 3 · Checkpoint 16H rejection #2 (2026-08-06) — bulk /
  // list / no-reply mail is INFORMATIONAL, never SUPPRESS. Founder
  // §4/§7: "No action required" is not an exclusion. A newsletter
  // still belongs in the Work Intake Feed. SUPPRESS is reserved for
  // narrow technical exclusions (junk / deleted-folder policy /
  // provider tombstone / user-created suppression) applied
  // BEFORE the classifier ever sees the message.
  {
    key: "list_mail_or_marketing",
    version: 2,
    label: "INFORMATIONAL",
    reason: "Bulk / list mail (List-Unsubscribe or List-Id header present) — informational, no action required.",
    confidence: 0.85,
    intakeAction: "CREATE_INFORMATIONAL",
    matches: (e) => isListMail(e),
  },
  {
    key: "automated_sender_pattern",
    version: 2,
    label: "INFORMATIONAL",
    reason: "Automated sender pattern (no-reply / notifications / mailer-daemon) — informational, no reply expected.",
    confidence: 0.75,
    intakeAction: "CREATE_INFORMATIONAL",
    matches: (e) => isAutomatedSender(e) || hasAutoSubmittedHeader(e),
  },
  {
    key: "informational_default",
    version: 2,   // Sprint 3 · Post-16H P0-hardening (2026-08-07)
    label: "INFORMATIONAL",
    reason: "No actionable signals found; kept as informational for the user's review.",
    confidence: 0.4,
    intakeAction: "CREATE_INFORMATIONAL",
    // Hard PDF-pending invariant (P0-hardening §2). If the email
    // carries a non-inline attachment, the classifier MUST NOT
    // finalize the WorkIntakeItem as ordinary INFORMATIONAL — even
    // if the attachment metadata / bytes / document ingest / analysis
    // hasn't completed yet. Force the earlier
    // `has_attachment_pending_analysis` rule to catch it (that rule
    // matches on `hasAttachments` too, but with intakeAction
    // CREATE_ACTIONABLE so downstream materialisation + reclassification
    // fires when analysis completes). This is a mechanical safeguard —
    // the founder's P0-hardening rule requires the classifier NOT
    // to lose a race against attachment ingestion.
    matches: (e) => !e.hasAttachments,
  },
];

export function classifyEmail(email: NormalizedEmail): ClassificationResult {
  for (const rule of CLASSIFIER_RULES) {
    if (rule.matches(email)) {
      return {
        label: rule.label,
        method: "RULE",
        ruleKey: rule.key,
        ruleVersion: rule.version,
        reason: rule.reason,
        confidence: rule.confidence,
        intakeAction: rule.intakeAction,
      };
    }
  }
  // Unreachable — the informational_default rule always matches — but
  // typescript wants a return.
  return {
    label: "UNCLASSIFIED",
    method: "RULE",
    ruleKey: "unclassified",
    ruleVersion: 1,
    reason: "No classification rule matched.",
    confidence: 0.1,
    intakeAction: "CREATE_INFORMATIONAL",
  };
}
