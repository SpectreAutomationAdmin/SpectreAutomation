// Sprint 3 · Checkpoint 16G Stage B (2026-08-04) — work-domain
// classifier. Deterministic, evidence-based, generalized. Never
// hard-codes a specific sender/subject.
//
// Key rules per founder:
//   1. A message is fixture / operational-AP / membership / etc.
//      because of POSITIVE evidence in the message, not because a
//      subject string happens to contain a keyword like "membership".
//   2. Vendor context requires positive AP evidence — do not treat
//      every sender as a vendor.
//   3. When uncertain, use GENERAL rather than misrouting to AP.
//   4. Emit alternatives + supporting evidence for the audit trail.
//
// The classifier consumes a normalised evidence snapshot the
// materialiser assembles from the raw EmailMessage + attachments +
// existing ingestion classification. It returns a WorkDomainDecision
// the persistor writes to the WorkIntakeItem row.

export const WORK_DOMAIN_CLASSIFIER_VERSION = "16g-b-v1";

export type WorkDomain =
  | "ACCOUNTS_PAYABLE"
  | "ACCOUNTS_RECEIVABLE"
  | "PAYROLL"
  | "MEMBERSHIP"
  | "COMMUNICATIONS"
  | "GOVERNANCE"
  | "OPERATIONS"
  | "HOSPITALITY"
  | "INFORMATIONAL"
  | "GENERAL";

export type WorkIntent =
  | "REVIEW"
  | "APPROVE"
  | "RESPOND"
  | "COLLECT"
  | "RESOLVE"
  | "INFORM"
  | "SCHEDULE"
  | "CREATE_RECORD"
  | "POST"
  | "OTHER";

export type MembershipSubtype =
  | "PROSPECT_INQUIRY"
  | "APPLICATION"
  | "WAITLIST"
  | "MEMBER_SERVICE"
  | "SHARE_TRANSFER"
  | "RESIGNATION"
  | "OTHER";

export interface WorkDomainClassifierInput {
  /** Existing ingestion classification (INVOICE_LIKELY, INTERNAL_OPERATIONS, MEMBER_INQUIRY_LIKELY, etc.). */
  ingestionClassification?: string | null;
  ingestionClassificationRuleKey?: string | null;
  ingestionClassificationConfidence?: number | null;
  /** Email subject + body preview + full body (never null-checked in isolation). */
  subject?: string | null;
  bodyText?: string | null;
  senderName?: string | null;
  senderAddress?: string | null;
  senderDomain?: string | null;
  importance?: string | null;
  /** True if the message has any attachments. */
  hasAttachments?: boolean;
  /** For each attachment: filename + optional pre-classification result (INVOICE / STATEMENT / OTHER / UNKNOWN). */
  attachments?: Array<{ filename?: string | null; classification?: string | null }>;
  /** Was this message threaded into an existing AP invoice review? (Set by the materialiser when it links a document to an AP intake.) */
  linkedToApWorkflow?: boolean;
}

export type Evidence = {
  code: string;
  weight: number;   // positive → supports this candidate; negative → contradicts
  detail?: string;
};

export interface WorkDomainDecision {
  selectedDomain: WorkDomain;
  selectedSubtype?: string;
  selectedIntent: WorkIntent;
  confidence: number;                 // 0..1
  supportingEvidence: Evidence[];     // for the selected domain
  contradictoryEvidence: Evidence[];  // pointing to alternatives
  alternatives: Array<{ domain: WorkDomain; confidence: number }>;
  requiresReview: boolean;
  classifierVersion: string;
}

// ---------------------------------------------------------------------------
// Evidence rules (generalized, not subject-specific). Each rule sees the
// normalised input and pushes evidence into a shared record. The domain
// with the highest positive score wins; ties break to GENERAL.
// ---------------------------------------------------------------------------

const AP_INVOICE_TERMS = [
  "invoice", "invoice #", "invoice number", "invoice date", "due date",
  "amount due", "balance due", "total due", "remit to", "payable to",
  "payment due", "past due", "past-due", "past  due", "overdue",
  "bill to", "billed to", "vendor invoice", "purchase order", "po number",
];
const AP_STATEMENT_TERMS = [
  "statement", "vendor statement", "monthly statement", "account statement",
  "statement of account", "outstanding balance",
];
const AR_TERMS = [
  "member account", "account balance", "your balance", "your account",
  "past due balance", "outstanding balance", "make a payment",
  "aging", "sixty day", "ninety day", "hundred twenty day",
];
const PAYROLL_TERMS = [
  "payroll", "pay period", "gross pay", "net pay", "employee",
  "timesheet", "time sheet", "hours worked", "direct deposit",
  "cra remittance", "source deductions", "t4", "roe ",
];
const MEMBERSHIP_TERMS = [
  // Application / joining
  "membership application", "join the club", "apply for membership",
  "become a member", "prospective member", "prospective membership",
  "membership inquiry", "inquire about membership", "inquiring about membership",
  "interested in membership", "considering membership",
  // Waitlist
  "waitlist", "wait list", "waiting list", "waitlisted",
  // Categories / tiers / shares
  "shareholder membership", "full membership", "corporate membership",
  "junior membership", "social membership", "share purchase",
  "membership category", "membership categories", "membership tier",
  // Fees / entrance
  "initiation fee", "entrance fee", "joining fee",
  // Tour / info
  "club tour", "tour of the club", "come by for a tour", "site visit",
  "how do i join", "how would i become",
  // Resignation / transfer
  "resign my membership", "transfer my membership", "membership transfer",
  // Member service
  "member number", "reset my member", "update my member",
];
const GOVERNANCE_TERMS = [
  "board of directors", "committee meeting", "agenda", "minutes",
  "annual general meeting", "AGM", "special resolution", "governance policy",
  "board meeting",
];
const HOSPITALITY_TERMS = [
  "reservation", "dining reservation", "tee time", "cancel my reservation",
  "reschedule my reservation", "dinner", "lounge", "menu",
];
const OPERATIONS_TERMS = [
  "irrigation", "kitchen", "clubhouse", "maintenance", "grounds",
  "pro shop", "hvac", "cart barn", "cart path", "range balls",
];
const INFORMATIONAL_TERMS = [
  "unsubscribe", "no reply", "no-reply", "newsletter", "auto reply",
  "auto-reply", "out of office", "vacation notice", "receipt of your email",
];

function countHits(text: string, terms: string[]): { hit: number; matches: string[] } {
  const lower = text.toLowerCase();
  const matches = terms.filter((t) => lower.includes(t.toLowerCase()));
  return { hit: matches.length, matches };
}

/**
 * Classify the work domain for a normalised email evidence snapshot.
 * Returns the decision + full evidence trail.
 */
export function classifyWorkDomain(input: WorkDomainClassifierInput): WorkDomainDecision {
  const scores: Record<WorkDomain, number> = {
    ACCOUNTS_PAYABLE: 0, ACCOUNTS_RECEIVABLE: 0, PAYROLL: 0, MEMBERSHIP: 0,
    COMMUNICATIONS: 0, GOVERNANCE: 0, OPERATIONS: 0, HOSPITALITY: 0,
    INFORMATIONAL: 0, GENERAL: 0,
  };
  const evidenceByDomain: Record<WorkDomain, Evidence[]> = {
    ACCOUNTS_PAYABLE: [], ACCOUNTS_RECEIVABLE: [], PAYROLL: [], MEMBERSHIP: [],
    COMMUNICATIONS: [], GOVERNANCE: [], OPERATIONS: [], HOSPITALITY: [],
    INFORMATIONAL: [], GENERAL: [],
  };

  const text = [input.subject ?? "", input.bodyText ?? ""].join(" ");
  const attachClass = (input.attachments ?? []).map((a) => (a.classification ?? "").toUpperCase());
  const hasInvoiceAttachment = attachClass.includes("INVOICE");
  const hasStatementAttachment = attachClass.includes("STATEMENT");
  const linkedAp = !!input.linkedToApWorkflow;

  // AP — requires positive AP evidence.
  if (linkedAp) {
    scores.ACCOUNTS_PAYABLE += 5;
    evidenceByDomain.ACCOUNTS_PAYABLE.push({ code: "AP_LINKED_WORKFLOW", weight: 5, detail: "linked to canonical AP intake" });
  }
  if (hasInvoiceAttachment) {
    scores.ACCOUNTS_PAYABLE += 4;
    evidenceByDomain.ACCOUNTS_PAYABLE.push({ code: "AP_INVOICE_ATTACHMENT", weight: 4, detail: "attachment classified INVOICE" });
  }
  if (hasStatementAttachment) {
    scores.ACCOUNTS_PAYABLE += 3;
    evidenceByDomain.ACCOUNTS_PAYABLE.push({ code: "AP_STATEMENT_ATTACHMENT", weight: 3, detail: "attachment classified STATEMENT" });
  }
  const apKw = countHits(text, AP_INVOICE_TERMS);
  if (apKw.hit > 0) {
    scores.ACCOUNTS_PAYABLE += apKw.hit;
    evidenceByDomain.ACCOUNTS_PAYABLE.push({ code: "AP_INVOICE_KEYWORDS", weight: apKw.hit, detail: apKw.matches.slice(0, 3).join(",") });
  }
  const stKw = countHits(text, AP_STATEMENT_TERMS);
  if (stKw.hit > 0) {
    scores.ACCOUNTS_PAYABLE += stKw.hit;
    evidenceByDomain.ACCOUNTS_PAYABLE.push({ code: "AP_STATEMENT_KEYWORDS", weight: stKw.hit, detail: stKw.matches.slice(0, 3).join(",") });
  }

  // AR — member account context.
  const arKw = countHits(text, AR_TERMS);
  if (arKw.hit > 0) {
    scores.ACCOUNTS_RECEIVABLE += arKw.hit * 2;
    evidenceByDomain.ACCOUNTS_RECEIVABLE.push({ code: "AR_KEYWORDS", weight: arKw.hit * 2, detail: arKw.matches.slice(0, 3).join(",") });
  }

  // Payroll — deliberately narrow to avoid false positives.
  const payKw = countHits(text, PAYROLL_TERMS);
  if (payKw.hit > 0) {
    scores.PAYROLL += payKw.hit * 3;
    evidenceByDomain.PAYROLL.push({ code: "PAYROLL_KEYWORDS", weight: payKw.hit * 3, detail: payKw.matches.slice(0, 3).join(",") });
  }

  // Membership — every membership term is worth 2 (versus internal-ops
  // 1) so a genuine prospect inquiry beats a stray operations keyword.
  const membKw = countHits(text, MEMBERSHIP_TERMS);
  if (membKw.hit > 0) {
    scores.MEMBERSHIP += membKw.hit * 2;
    evidenceByDomain.MEMBERSHIP.push({ code: "MEMBERSHIP_KEYWORDS", weight: membKw.hit * 2, detail: membKw.matches.slice(0, 3).join(",") });
  }

  // Governance / hospitality / operations / informational.
  const govKw = countHits(text, GOVERNANCE_TERMS);
  if (govKw.hit > 0) {
    scores.GOVERNANCE += govKw.hit;
    evidenceByDomain.GOVERNANCE.push({ code: "GOVERNANCE_KEYWORDS", weight: govKw.hit, detail: govKw.matches.slice(0, 3).join(",") });
  }
  const hospKw = countHits(text, HOSPITALITY_TERMS);
  if (hospKw.hit > 0) {
    scores.HOSPITALITY += hospKw.hit;
    evidenceByDomain.HOSPITALITY.push({ code: "HOSPITALITY_KEYWORDS", weight: hospKw.hit, detail: hospKw.matches.slice(0, 3).join(",") });
  }
  const opsKw = countHits(text, OPERATIONS_TERMS);
  if (opsKw.hit > 0) {
    scores.OPERATIONS += opsKw.hit;
    evidenceByDomain.OPERATIONS.push({ code: "OPERATIONS_KEYWORDS", weight: opsKw.hit, detail: opsKw.matches.slice(0, 3).join(",") });
  }
  const infoKw = countHits(text, INFORMATIONAL_TERMS);
  if (infoKw.hit > 0) {
    scores.INFORMATIONAL += infoKw.hit * 3;
    evidenceByDomain.INFORMATIONAL.push({ code: "INFO_KEYWORDS", weight: infoKw.hit * 3, detail: infoKw.matches.slice(0, 3).join(",") });
  }

  // Boost from ingestion classification (soft prior).
  const ic = (input.ingestionClassification ?? "").toUpperCase();
  if (ic === "INVOICE_LIKELY") { scores.ACCOUNTS_PAYABLE += 1; evidenceByDomain.ACCOUNTS_PAYABLE.push({ code: "INGESTION_HINT_INVOICE_LIKELY", weight: 1 }); }
  if (ic === "MEMBER_INQUIRY_LIKELY") { scores.MEMBERSHIP += 1; evidenceByDomain.MEMBERSHIP.push({ code: "INGESTION_HINT_MEMBER_INQUIRY", weight: 1 }); }
  // Strong AP hints — the AP intelligence materialiser has already
  // determined this is an AP workflow (INVOICE or STATEMENT). Treat
  // it as high-confidence AP evidence even when the WI is doc-only
  // (no email body / no attachments in the classifier input).
  if (ic === "AP_INVOICE_REVIEW") { scores.ACCOUNTS_PAYABLE += 5; evidenceByDomain.ACCOUNTS_PAYABLE.push({ code: "INGESTION_HINT_AP_INVOICE_REVIEW", weight: 5 }); }
  if (ic === "VENDOR_STATEMENT_REVIEW") { scores.ACCOUNTS_PAYABLE += 5; evidenceByDomain.ACCOUNTS_PAYABLE.push({ code: "INGESTION_HINT_VENDOR_STATEMENT_REVIEW", weight: 5 }); }
  if (ic?.startsWith("AR_AGING_")) { scores.ACCOUNTS_RECEIVABLE += 5; evidenceByDomain.ACCOUNTS_RECEIVABLE.push({ code: "INGESTION_HINT_AR_AGING", weight: 5 }); }

  // Winning domain.
  const ranked = (Object.entries(scores) as Array<[WorkDomain, number]>)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const [winner, winnerScore] = ranked[0]!;
  const [runnerUp, runnerScore] = ranked[1] ?? ["GENERAL", 0];

  // If nobody has any evidence at all → GENERAL.
  const selectedDomain: WorkDomain = winnerScore <= 0 ? "GENERAL" : winner;

  // Confidence: normalise by the total weight across all domains,
  // capped at 1.
  const totalScore = Object.values(scores).reduce((a, b) => a + b, 0);
  const rawConfidence = totalScore > 0 ? winnerScore / totalScore : 0;
  const marginConfidence = (winnerScore - runnerScore) / Math.max(winnerScore, 1);
  const confidence = Math.min(1, (rawConfidence * 0.6) + (marginConfidence * 0.4));

  // Subtype resolution.
  let selectedSubtype: string | undefined;
  if (selectedDomain === "MEMBERSHIP") selectedSubtype = pickMembershipSubtype(text);
  else if (selectedDomain === "ACCOUNTS_PAYABLE" && hasStatementAttachment && !hasInvoiceAttachment) selectedSubtype = "VENDOR_STATEMENT";
  else if (selectedDomain === "ACCOUNTS_PAYABLE" && hasInvoiceAttachment) selectedSubtype = "INVOICE";

  // Intent resolution.
  const selectedIntent = pickIntent(selectedDomain, selectedSubtype, hasInvoiceAttachment, hasStatementAttachment);

  // Contradictory evidence.
  const contradictoryEvidence: Evidence[] = [];
  for (const [d, s] of ranked.slice(1)) {
    if (s > 0) contradictoryEvidence.push({ code: `ALT_${d}`, weight: s, detail: `${s} evidence weight` });
  }

  const alternatives = ranked.slice(1).filter(([, s]) => s > 0).map(([d, s]) => ({
    domain: d, confidence: Math.min(1, s / Math.max(totalScore, 1)),
  }));

  return {
    selectedDomain,
    selectedSubtype,
    selectedIntent,
    confidence,
    supportingEvidence: evidenceByDomain[selectedDomain],
    contradictoryEvidence,
    alternatives,
    requiresReview: confidence < 0.35,
    classifierVersion: WORK_DOMAIN_CLASSIFIER_VERSION,
  };
}

function pickMembershipSubtype(text: string): MembershipSubtype {
  const t = text.toLowerCase();
  if (/waitlist|wait list|waiting list|waitlisted/.test(t)) return "WAITLIST";
  if (/(membership application|apply for membership|application (status|form))/.test(t)) return "APPLICATION";
  if (/(share purchase|share transfer|shareholder transfer)/.test(t)) return "SHARE_TRANSFER";
  if (/(resign|resignation)\b/.test(t)) return "RESIGNATION";
  if (/(join the club|become a member|prospective member|inquire|inquiring|interested in|considering|club tour|how do i join|how would i)/.test(t)) return "PROSPECT_INQUIRY";
  if (/(member number|update my member|reset my member)/.test(t)) return "MEMBER_SERVICE";
  return "OTHER";
}

function pickIntent(
  domain: WorkDomain,
  subtype: string | undefined,
  hasInvoice: boolean,
  hasStatement: boolean,
): WorkIntent {
  switch (domain) {
    case "ACCOUNTS_PAYABLE":
      if (hasInvoice) return "APPROVE";
      if (hasStatement) return "REVIEW";
      return "REVIEW";
    case "ACCOUNTS_RECEIVABLE":
      return "COLLECT";
    case "PAYROLL":
      return "APPROVE";
    case "MEMBERSHIP":
      if (subtype === "PROSPECT_INQUIRY" || subtype === "WAITLIST" || subtype === "APPLICATION") return "RESPOND";
      if (subtype === "RESIGNATION" || subtype === "SHARE_TRANSFER") return "RESOLVE";
      return "RESPOND";
    case "GOVERNANCE":
      return "SCHEDULE";
    case "OPERATIONS":
    case "HOSPITALITY":
      return "RESOLVE";
    case "INFORMATIONAL":
      return "INFORM";
    case "COMMUNICATIONS":
      return "RESPOND";
    case "GENERAL":
    default:
      return "REVIEW";
  }
}
