// Sprint 3 · Checkpoint 16G Stage D (2026-08-04) — per-domain view
// models for the Mission Control card renderer.
//
// The card shell (Variant D / Instrument) remains one component; the
// domain view-model tells it which fields to show, which primary
// action to offer, and which tabs to expose.
//
// Founder rules:
//   - AP fields (VENDOR / INVOICE / AP STATUS / AMOUNT) must NEVER
//     appear on non-AP cards.
//   - Membership card fields: PROSPECT / CONTACT, INQUIRY TYPE,
//     RECEIVED, RESPONSE STATUS.
//   - The sender is not a "Vendor" — the general "Sender" label is
//     used on non-AP cards.
//
// This module is pure — no DB access. Feeds the client card via
// props from the loader.

export type DomainCardTab =
  | "conversation"
  | "attachments"
  | "invoice"           // AP only
  | "statement"         // AP only
  | "related_member"    // MEMBERSHIP / AR
  | "account_activity"  // AR
  | "aging"             // AR
  | "activity";

export interface DomainField {
  label: string;
  value: string;
  state?: "found" | "ambiguous" | "not_found" | "not_extracted" | "extracted" | "duplicate" | "no_data";
}

export interface DomainAction {
  key: string;
  label: string;
  kind: "primary" | "secondary" | "tertiary";
}

export interface DomainCardViewModel {
  domain: string;
  domainLabel: string;
  domainIconKey: "clipboard" | "user" | "calendar" | "coins" | "mail" | "flag" | "wrench" | "notepad";
  fields: DomainField[];
  primaryActions: DomainAction[];
  tabs: DomainCardTab[];
  /** True → the card renderer must NOT show the AP invoice-summary
   *  grid or any AP-only tabs (Invoice Review / Statement Review). */
  suppressApRenderer: boolean;
}

/**
 * Build the per-domain view model. Consumers pass the raw
 * workDomain / workSubtype / workIntent from the WI + a small
 * evidence bag (received time, sender name, response status).
 */
export function buildDomainViewModel(input: {
  workDomain?: string | null;
  workSubtype?: string | null;
  workIntent?: string | null;
  senderDisplay?: string | null;
  receivedLabel?: string | null;
  responseStatus?: string | null;
  linkedIntelligenceInvoiceCount?: number;
  linkedIntelligenceStatementCount?: number;
  linkedIntelligenceAttachmentCount?: number;
}): DomainCardViewModel {
  const domain = (input.workDomain ?? "GENERAL").toUpperCase();
  const senderDisplay = input.senderDisplay ?? "Sender";
  const received = input.receivedLabel ?? "—";
  const responseStatus = input.responseStatus ?? "Awaiting reply";

  switch (domain) {
    case "MEMBERSHIP": {
      const subtypeLabel = membershipSubtypeLabel(input.workSubtype);
      return {
        domain,
        domainLabel: "Membership",
        domainIconKey: "user",
        fields: [
          { label: "Prospect / contact", value: senderDisplay },
          { label: "Inquiry type", value: subtypeLabel },
          { label: "Received", value: received },
          { label: "Response status", value: responseStatus },
        ],
        primaryActions: [
          { key: "reply", label: "Review & reply", kind: "primary" },
          { key: "assign", label: "Assign", kind: "secondary" },
          { key: "defer", label: "Defer", kind: "tertiary" },
        ],
        tabs: ["conversation", "related_member", "activity"],
        suppressApRenderer: true,
      };
    }
    case "ACCOUNTS_PAYABLE": {
      const hasInvoice = (input.linkedIntelligenceInvoiceCount ?? 0) > 0;
      const hasStatement = (input.linkedIntelligenceStatementCount ?? 0) > 0;
      const tabs: DomainCardTab[] = ["conversation"];
      if ((input.linkedIntelligenceAttachmentCount ?? 0) > 0) tabs.push("attachments");
      if (hasInvoice) tabs.push("invoice");
      if (hasStatement) tabs.push("statement");
      tabs.push("activity");
      return {
        domain,
        domainLabel: hasStatement && !hasInvoice ? "Vendor statement" : "Accounts payable",
        domainIconKey: "coins",
        // AP fields are NOT rendered here — the AP renderer inside
        // EmailIntakeCard has its own richer projection. This exists
        // only for symmetry; the card is instructed to use its AP
        // path when suppressApRenderer=false.
        fields: [],
        primaryActions: [
          { key: hasInvoice ? "approve_post" : "review", label: hasInvoice ? "Review AP invoice" : "Review", kind: "primary" },
          { key: "assign", label: "Assign", kind: "secondary" },
          { key: "defer", label: "Defer", kind: "tertiary" },
        ],
        tabs,
        suppressApRenderer: false,
      };
    }
    case "ACCOUNTS_RECEIVABLE": {
      return {
        domain,
        domainLabel: "Accounts receivable",
        domainIconKey: "flag",
        fields: [
          { label: "Member / account", value: senderDisplay },
          { label: "Balance", value: "—" },
          { label: "Aging", value: "—" },
          { label: "Policy status", value: "—" },
        ],
        primaryActions: [
          { key: "review_account", label: "Review account", kind: "primary" },
          { key: "contact", label: "Contact member", kind: "secondary" },
          { key: "defer", label: "Defer", kind: "tertiary" },
        ],
        tabs: ["conversation", "related_member", "account_activity", "aging", "activity"],
        suppressApRenderer: true,
      };
    }
    case "PAYROLL":
      return {
        domain,
        domainLabel: "Payroll",
        domainIconKey: "clipboard",
        fields: [
          { label: "Pay period", value: "—" },
          { label: "Gross / net total", value: "—" },
          { label: "Employees", value: "—" },
          { label: "Approval status", value: "—" },
        ],
        primaryActions: [
          { key: "review_payroll", label: "Review payroll", kind: "primary" },
          { key: "approve", label: "Approve", kind: "secondary" },
          { key: "defer", label: "Defer", kind: "tertiary" },
        ],
        tabs: ["conversation", "activity"],
        suppressApRenderer: true,
      };
    case "COMMUNICATIONS":
      return {
        domain,
        domainLabel: "Communications",
        domainIconKey: "mail",
        fields: [
          { label: "Contact", value: senderDisplay },
          { label: "Subject", value: input.senderDisplay ?? "—" },
          { label: "Channel", value: "Email" },
          { label: "Response status", value: responseStatus },
        ],
        primaryActions: [
          { key: "reply", label: "Review & reply", kind: "primary" },
          { key: "assign", label: "Assign", kind: "secondary" },
          { key: "defer", label: "Defer", kind: "tertiary" },
        ],
        tabs: ["conversation", "activity"],
        suppressApRenderer: true,
      };
    case "GOVERNANCE":
      return {
        domain,
        domainLabel: "Governance",
        domainIconKey: "notepad",
        fields: [
          { label: "Committee / board", value: "—" },
          { label: "Matter", value: senderDisplay },
          { label: "Due date", value: "—" },
          { label: "Decision status", value: "—" },
        ],
        primaryActions: [
          { key: "review", label: "Review agenda", kind: "primary" },
          { key: "assign", label: "Assign", kind: "secondary" },
          { key: "defer", label: "Defer", kind: "tertiary" },
        ],
        tabs: ["conversation", "activity"],
        suppressApRenderer: true,
      };
    case "OPERATIONS":
    case "HOSPITALITY":
      return {
        domain,
        domainLabel: domain === "HOSPITALITY" ? "Hospitality" : "Operations",
        domainIconKey: "wrench",
        fields: [
          { label: "Area", value: "—" },
          { label: "Issue / request", value: senderDisplay },
          { label: "Timing", value: received },
          { label: "Owner / status", value: "Unassigned" },
        ],
        primaryActions: [
          { key: "resolve", label: "Resolve", kind: "primary" },
          { key: "assign", label: "Assign", kind: "secondary" },
          { key: "defer", label: "Defer", kind: "tertiary" },
        ],
        tabs: ["conversation", "activity"],
        suppressApRenderer: true,
      };
    case "INFORMATIONAL":
      return {
        domain,
        domainLabel: "Informational",
        domainIconKey: "mail",
        fields: [
          { label: "Sender", value: senderDisplay },
          { label: "Received", value: received },
        ],
        primaryActions: [
          { key: "acknowledge", label: "Mark reviewed", kind: "primary" },
          { key: "defer", label: "Defer", kind: "tertiary" },
        ],
        tabs: ["conversation", "activity"],
        suppressApRenderer: true,
      };
    case "GENERAL":
    default:
      return {
        domain: "GENERAL",
        domainLabel: "General",
        domainIconKey: "mail",
        fields: [
          { label: "Sender", value: senderDisplay },
          { label: "Received", value: received },
          { label: "Response status", value: responseStatus },
        ],
        primaryActions: [
          { key: "review", label: "Review", kind: "primary" },
          { key: "reply", label: "Reply", kind: "secondary" },
          { key: "defer", label: "Defer", kind: "tertiary" },
        ],
        tabs: ["conversation", "activity"],
        suppressApRenderer: true,
      };
  }
}

function membershipSubtypeLabel(subtype?: string | null): string {
  switch ((subtype ?? "").toUpperCase()) {
    case "PROSPECT_INQUIRY": return "Prospect inquiry";
    case "APPLICATION": return "Application";
    case "WAITLIST": return "Waitlist";
    case "MEMBER_SERVICE": return "Member service";
    case "SHARE_TRANSFER": return "Share transfer";
    case "RESIGNATION": return "Resignation";
    default: return "Membership";
  }
}
