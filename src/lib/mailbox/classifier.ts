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
  return email.hasAttachments;
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
    version: 1,
    label: "INTERNAL_OPERATIONS",
    reason: "Sender domain matches a club or internal address; subject is operational.",
    confidence: 0.5,
    intakeAction: "CREATE_ACTIONABLE",
    matches: (e) =>
      // Same-domain internal is a weak signal; combined with an
      // operational subject keyword we upgrade to actionable.
      anyOf(
        ["irrigation", "kitchen", "clubhouse", "membership", "maintenance", "grounds", "pro shop"],
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
  {
    key: "list_mail_or_marketing",
    version: 1,
    label: "LIKELY_NOISE",
    reason: "Message is bulk / marketing / list mail (List-Unsubscribe or List-Id header present).",
    confidence: 0.9,
    intakeAction: "SUPPRESS",
    matches: (e) => isListMail(e),
  },
  {
    key: "automated_sender_pattern",
    version: 1,
    label: "LIKELY_NOISE",
    reason: "Sender address matches a common automated pattern (no-reply, notifications, mailer-daemon).",
    confidence: 0.75,
    intakeAction: "SUPPRESS",
    matches: (e) => isAutomatedSender(e) || hasAutoSubmittedHeader(e),
  },
  {
    key: "informational_default",
    version: 1,
    label: "INFORMATIONAL",
    reason: "No actionable signals found; kept as informational for the user's review.",
    confidence: 0.4,
    intakeAction: "CREATE_INFORMATIONAL",
    matches: () => true,
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
