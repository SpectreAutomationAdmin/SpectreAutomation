// Sprint 2 Checkpoint 14C (2026-07-23) — Deterministic operational
// analysis for invoice-related email conversations.
//
// This module is PURELY DETERMINISTIC. No AI. No fabrication. Every
// finding must be supported by:
//   - a regex match against subject + persisted preview + persisted
//     bodyTextExtract, or
//   - a real Prisma query against the club's Vendor / VendorContact
//     / APInvoice tables.
//
// Founder rules honored here (per Checkpoint 14C §6):
//   - Do not fabricate vendor matches.
//   - Do not fabricate invoice amounts / GST / GL account / due dates.
//   - Return truthful product language even when data is missing.
//   - If the AP subledger has zero rows for the club, report
//     "no AP data" — do not imply a search happened.
//   - Ambiguous vendor matches surface as AMBIGUOUS with candidates;
//     do not auto-select.

import { prisma } from "@/lib/prisma";
import type { EmailMessage } from "@prisma/client";

export type VendorMatchState = "MATCHED" | "AMBIGUOUS" | "NOT_FOUND";
export type ApLookupState =
  | "INVOICE_FOUND"
  | "POSSIBLE_DUPLICATE"
  | "INVOICE_NOT_FOUND"
  | "INSUFFICIENT_INFORMATION"
  | "VENDOR_AMBIGUOUS"
  | "VENDOR_NOT_FOUND"
  | "NO_AP_DATA_ON_CLUB";

export interface ExtractedIdentifiers {
  invoiceNumberRaw: string | null;
  invoiceNumberNormalized: string | null;
  statedAmountCents: number | null;
  purchaseOrderNumber: string | null;
  senderName: string;
  senderEmail: string;
  senderDomain: string;
}

export interface VendorMatchCandidate {
  id: string;
  operatingName: string | null;
  legalName: string;
  matchSignal: "email_exact" | "contact_email_exact" | "domain_match" | "name_exact" | "name_normalized";
}

export interface VendorMatchResult {
  state: VendorMatchState;
  candidates: VendorMatchCandidate[];
}

export interface ApLookupResult {
  state: ApLookupState;
  invoices: Array<{
    id: string;
    invoiceNumber: string;
    vendorReference: string | null;
    total: string;   // Decimal as string — never render as float
    status: string;
    postedAt: string | null;
  }>;
}

export interface EvidenceCell {
  label: "VENDOR" | "INVOICE" | "AP STATUS" | "AMOUNT";
  value: string;
  state: "found" | "ambiguous" | "not_found" | "not_extracted" | "extracted" | "duplicate" | "no_data";
}

export interface OperationalAnalysis {
  /** Concise action-oriented headline. Rendered as the card <h3>. */
  situationTitle: string;
  /** Small line above the title. "Vendor · AP · received 9 hr ago". */
  contextLine: string;
  /** 1-3 sentences explaining what the sender is asking, what was
   *  verified, what remains uncertain. Never restates the raw email. */
  synopsis: string;
  /** The 4-column evidence strip. Cells with `state: "not_extracted"`
   *  or "no_data" MUST render as "—" (or omitted) rather than
   *  fabricated values. */
  evidence: EvidenceCell[];
  /** The recommendation band content — one paragraph. */
  recommendation: string;
  /** Context-specific actions. Send-related actions are DISABLED in
   *  Phase 14C-A; will activate in 14C-B behind the consent gate. */
  actionSuggestions: Array<{
    key: string;
    label: string;
    kind: "primary" | "secondary" | "tertiary";
    iconKey?: "mail" | "reply" | "edit" | "clock" | "check" | "user-plus" | "send";
    /** When set, action is either disabled (staging) or informational
     *  only. The UI renders a disabled button with the reason as
     *  tooltip. */
    disabledReason?: string;
    /** onClick behaviour hint for the client card. */
    onClickAction?: "expand-view" | "expand-reply" | "expand-both";
  }>;
  /** Debug metadata — surfaced in the closeout report; NOT rendered. */
  debug: {
    ruleUsed: string;
    vendorMatch: VendorMatchState;
    vendorCandidateCount: number;
    apLookup: ApLookupState;
  };
}

// ---------------------------------------------------------------------------
// Identifier extraction
// ---------------------------------------------------------------------------

const INVOICE_NUMBER_PATTERNS: RegExp[] = [
  // Explicit alphanumeric invoice numbers — INV-2025-1029, APINV-2025-000123.
  /\b((?:INV|APINV|AP)[-\s]?\d{2,10}(?:[-\s]?\d{1,10})?)\b/i,
  // Common "Invoice #123" / "Invoice number 123" shapes with a
  // digits-only number.
  /\b[Ii]nvoice(?:\s*(?:number|no\.?|#))?\s*[:#-]?\s*(\d{3,10})\b/,
  /\b[Ii]nv(?:oice)?\.?\s*#\s*(\d{3,10})\b/,
  // Bare '#123' — least specific, used last.
  /#\s*(\d{3,10})\b/,
];

const AMOUNT_PATTERNS: RegExp[] = [
  /(?:total|amount(?:\s+due)?|balance|owing|owed)\s*(?::|is)?\s*\$?\s*([\d,]+(?:\.\d{2})?)/i,
  /\$\s*([\d,]+(?:\.\d{2})?)/,
];

const PO_PATTERN = /\b(?:PO|P\.O\.|purchase\s+order)\s*#?\s*([A-Z0-9-]{3,20})/i;

export function extractIdentifiersFromEmail(email: EmailMessage): ExtractedIdentifiers {
  const haystack = [email.subject, email.preview, email.bodyTextExtract]
    .filter((s): s is string => typeof s === "string" && s.length > 0)
    .join("\n");

  let invoiceNumberRaw: string | null = null;
  for (const re of INVOICE_NUMBER_PATTERNS) {
    const m = haystack.match(re);
    if (m && m[1]) { invoiceNumberRaw = m[1].trim(); break; }
  }
  const invoiceNumberNormalized = invoiceNumberRaw
    ? invoiceNumberRaw.replace(/[^A-Za-z0-9]/g, "").replace(/^0+/, "").toLowerCase() || null
    : null;

  let statedAmountCents: number | null = null;
  for (const re of AMOUNT_PATTERNS) {
    const m = haystack.match(re);
    if (m && m[1]) {
      const cleaned = m[1].replace(/,/g, "");
      const asNumber = Number(cleaned);
      if (Number.isFinite(asNumber) && asNumber > 0) {
        statedAmountCents = Math.round(asNumber * 100);
        break;
      }
    }
  }

  const poMatch = haystack.match(PO_PATTERN);
  const purchaseOrderNumber = poMatch ? poMatch[1] : null;

  const senderEmail = email.senderAddress || "";
  const senderDomain = senderEmail.includes("@") ? senderEmail.split("@")[1]!.toLowerCase() : "";

  return {
    invoiceNumberRaw,
    invoiceNumberNormalized,
    statedAmountCents,
    purchaseOrderNumber,
    senderName: email.senderName || "",
    senderEmail,
    senderDomain,
  };
}

// ---------------------------------------------------------------------------
// Vendor matching (bounded — deterministic signals only)
// ---------------------------------------------------------------------------

/** Corporate-suffix / punctuation normalization for name comparison. */
export function normalizeVendorName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[,.'"()]/g, "")
    .replace(/&/g, "and")
    .replace(/\b(inc|incorporated|llc|ltd|limited|corp|corporation|co|company|holdings|group)\b\.?/g, "")
    .trim();
}

const CONSUMER_MAILBOX_DOMAINS = new Set([
  "gmail.com", "outlook.com", "hotmail.com", "yahoo.com", "icloud.com",
  "aol.com", "live.com", "protonmail.com", "proton.me",
]);

export async function matchVendorForClub(args: {
  clubId: string;
  ident: ExtractedIdentifiers;
}): Promise<VendorMatchResult> {
  const { clubId, ident } = args;
  const email = ident.senderEmail.toLowerCase();
  const domain = ident.senderDomain;

  // Emails are stored as originally entered; we normalize both sides
  // to lowercase in JS after querying so this stays provider-portable.
  // (SQLite Prisma provider does not support the `mode: "insensitive"`
  // filter — Postgres does. Normalizing in JS works on both.)
  let candidates: VendorMatchCandidate[] = [];
  if (email) {
    const byEmail = await prisma.vendor.findMany({
      where: { clubId, NOT: { email: null } },
      select: { id: true, operatingName: true, legalName: true, email: true },
      take: 500,
    });
    for (const v of byEmail) {
      if ((v.email || "").toLowerCase() === email) {
        candidates.push({ id: v.id, operatingName: v.operatingName, legalName: v.legalName, matchSignal: "email_exact" });
      }
    }
  }

  // Signal 2: exact match on VendorContact.email
  if (candidates.length === 0 && email) {
    const byContact = await prisma.vendorContact.findMany({
      where: { clubId, NOT: { email: null } },
      select: { vendorId: true, email: true },
      take: 500,
    });
    const matchingVendorIds = new Set<string>();
    for (const c of byContact) {
      if ((c.email || "").toLowerCase() === email) matchingVendorIds.add(c.vendorId);
    }
    if (matchingVendorIds.size > 0) {
      const vendors = await prisma.vendor.findMany({
        where: { clubId, id: { in: [...matchingVendorIds] } },
        select: { id: true, operatingName: true, legalName: true },
      });
      for (const v of vendors) {
        candidates.push({ id: v.id, operatingName: v.operatingName, legalName: v.legalName, matchSignal: "contact_email_exact" });
      }
    }
  }

  // Signal 3: sender-domain match against Vendor.email domain
  //   Skip consumer mailbox domains — matching "gmail.com" would produce
  //   false positives.
  if (candidates.length === 0 && domain && !CONSUMER_MAILBOX_DOMAINS.has(domain)) {
    const byDomain = await prisma.vendor.findMany({
      where: { clubId, NOT: { email: null } },
      select: { id: true, operatingName: true, legalName: true, email: true },
      take: 500,
    });
    const domainSuffix = `@${domain}`;
    for (const v of byDomain) {
      if ((v.email || "").toLowerCase().endsWith(domainSuffix)) {
        candidates.push({ id: v.id, operatingName: v.operatingName, legalName: v.legalName, matchSignal: "domain_match" });
      }
    }
  }

  // Signal 4: exact / normalized name match against sender NAME.
  //   Only run when the sender name looks like a business name
  //   (space-separated proper words, not a single personal name).
  if (candidates.length === 0 && ident.senderName && ident.senderName.split(/\s+/).length >= 2) {
    const normalized = normalizeVendorName(ident.senderName);
    if (normalized.length >= 4) {
      const all = await prisma.vendor.findMany({
        where: { clubId },
        select: { id: true, operatingName: true, legalName: true },
        take: 500,
      });
      for (const v of all) {
        const opNorm = v.operatingName ? normalizeVendorName(v.operatingName) : "";
        const legalNorm = normalizeVendorName(v.legalName);
        if (opNorm === normalized || legalNorm === normalized) {
          candidates.push({ id: v.id, operatingName: v.operatingName, legalName: v.legalName, matchSignal: "name_normalized" });
        }
      }
    }
  }

  // De-duplicate by id (multi-signal same vendor)
  const seen = new Set<string>();
  candidates = candidates.filter((c) => (seen.has(c.id) ? false : seen.add(c.id)));

  if (candidates.length === 0) return { state: "NOT_FOUND", candidates: [] };
  if (candidates.length === 1) return { state: "MATCHED", candidates };
  return { state: "AMBIGUOUS", candidates };
}

// ---------------------------------------------------------------------------
// AP subledger lookup
// ---------------------------------------------------------------------------

export async function lookupInvoiceInAp(args: {
  clubId: string;
  vendorMatch: VendorMatchResult;
  ident: ExtractedIdentifiers;
}): Promise<ApLookupResult> {
  const { clubId, vendorMatch, ident } = args;

  // Founder rule: never imply a search happened if the club has zero
  // AP data. This is a whole-table check — cheap on staging.
  const clubApCount = await prisma.aPInvoice.count({ where: { clubId } });
  if (clubApCount === 0) return { state: "NO_AP_DATA_ON_CLUB", invoices: [] };

  if (vendorMatch.state === "NOT_FOUND") return { state: "VENDOR_NOT_FOUND", invoices: [] };
  if (vendorMatch.state === "AMBIGUOUS") return { state: "VENDOR_AMBIGUOUS", invoices: [] };
  if (!ident.invoiceNumberRaw) return { state: "INSUFFICIENT_INFORMATION", invoices: [] };

  const vendorId = vendorMatch.candidates[0]!.id;
  const raw = ident.invoiceNumberRaw;
  const normalized = ident.invoiceNumberNormalized ?? "";

  // Exact + normalized match on vendorReference (the vendor's own
  // invoice number field). Provider-portable: filter with `equals`
  // (no `mode: insensitive`) and compare case-insensitively in JS.
  const allForVendor = await prisma.aPInvoice.findMany({
    where: { clubId, vendorId, NOT: { vendorReference: null } },
    select: {
      id: true,
      invoiceNumber: true,
      vendorReference: true,
      total: true,
      status: true,
      postedAt: true,
    },
    take: 500,
  });
  const rawLc = raw.toLowerCase();
  const candidates = allForVendor.filter((r) => {
    const ref = (r.vendorReference || "").toLowerCase();
    if (ref === rawLc) return true;
    if (normalized && ref.replace(/[^a-z0-9]/g, "").replace(/^0+/, "") === normalized) return true;
    return false;
  }).slice(0, 5);

  if (candidates.length === 0) return { state: "INVOICE_NOT_FOUND", invoices: [] };
  if (candidates.length > 1) {
    return {
      state: "POSSIBLE_DUPLICATE",
      invoices: candidates.map((c) => ({
        id: c.id,
        invoiceNumber: c.invoiceNumber,
        vendorReference: c.vendorReference,
        total: c.total.toString(),
        status: c.status,
        postedAt: c.postedAt?.toISOString() ?? null,
      })),
    };
  }
  return {
    state: "INVOICE_FOUND",
    invoices: [
      {
        id: candidates[0]!.id,
        invoiceNumber: candidates[0]!.invoiceNumber,
        vendorReference: candidates[0]!.vendorReference,
        total: candidates[0]!.total.toString(),
        status: candidates[0]!.status,
        postedAt: candidates[0]!.postedAt?.toISOString() ?? null,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Analysis assembler
// ---------------------------------------------------------------------------

/**
 * Compose the full operational analysis for one email conversation.
 * `newestEmail` is the message the card display should reflect;
 * `conversationEmails` is the full conversation (newest first) so
 * later phases can extract identifiers from any message in the
 * thread.
 */
export async function analyseInvoiceConversation(args: {
  clubId: string;
  newestEmail: EmailMessage;
  conversationEmails: EmailMessage[];
  classificationLabel: string | null;
  classificationReason: string | null;
  relTimeLabel: string;
}): Promise<OperationalAnalysis> {
  const { clubId, newestEmail, conversationEmails, classificationLabel, classificationReason, relTimeLabel } = args;
  // Sprint 3 · Checkpoint 16G Stage C (2026-08-04) — vendor-resolution
  // gate now requires POSITIVE AP evidence, not merely a subject-
  // keyword match. Founder rule: "Vendor resolution may run only
  // where the evidence supports an AP/vendor workflow."
  //
  // POSITIVE AP evidence = at least one of:
  //   * classification was INVOICE_LIKELY (ingestion pipeline saw an
  //     invoice attachment or invoice-shaped body);
  //   * the sender pattern is a known vendor / remittance address
  //     (sales@, billing@, accounting@, ap@, accountspayable@);
  //   * an invoice number could actually be extracted from the
  //     conversation (extractIdentifiersFromEmail found one);
  //   * a monetary amount could be extracted alongside AP-vocabulary
  //     terms (amount due / balance owing / remit / payable).
  //
  // A subject that mentions "invoice" alone (e.g. a member asking
  // "What's on my next invoice?" or a marketing email "Invoice
  // manager for small clubs") is NO LONGER sufficient. Vendor
  // resolution stays off unless positive evidence lands.
  const identForGate = extractIdentifiersFromEmail(newestEmail);
  const senderLower = (newestEmail.senderAddress ?? "").toLowerCase();
  const senderIsVendorAddress = /^(sales|billing|accounting|ap|accountspayable|remit|payments)@/.test(senderLower);
  const bodyLower = `${newestEmail.subject ?? ""} ${newestEmail.preview ?? ""}`.toLowerCase();
  const apVocab = /\b(amount due|balance owing|remit to|payable to|past due|invoice number|payment due|please pay)\b/.test(bodyLower);
  const looksLikeInvoiceThread =
    classificationLabel === "INVOICE_LIKELY" ||
    senderIsVendorAddress ||
    !!identForGate.invoiceNumberRaw ||
    apVocab;

  const ident = identForGate;
  // If the newest message didn't carry an invoice number, try older ones.
  if (!ident.invoiceNumberRaw) {
    for (const older of conversationEmails.slice(1)) {
      const altIdent = extractIdentifiersFromEmail(older);
      if (altIdent.invoiceNumberRaw) {
        ident.invoiceNumberRaw = altIdent.invoiceNumberRaw;
        ident.invoiceNumberNormalized = altIdent.invoiceNumberNormalized;
        ident.statedAmountCents = ident.statedAmountCents ?? altIdent.statedAmountCents;
        break;
      }
    }
  }

  const vendorMatch = looksLikeInvoiceThread
    ? await matchVendorForClub({ clubId, ident })
    : { state: "NOT_FOUND" as const, candidates: [] };

  const apResult = looksLikeInvoiceThread
    ? await lookupInvoiceInAp({ clubId, vendorMatch, ident })
    : { state: "INSUFFICIENT_INFORMATION" as const, invoices: [] };

  if (looksLikeInvoiceThread) {
    return composeInvoiceSynopsis({
      ident, vendorMatch, apResult, newestEmail, classificationReason, relTimeLabel,
      // Sprint 3 · Checkpoint 15S — signal to the vendor-display
      // helper that this email carries an attachment which the AP
      // pipeline is (or should be) analysing. Prevents the sender-
      // as-vendor fallback that mislabelled the founder as vendor
      // on the Pt2 email.
      hasPdfInvoiceAttachment: !!newestEmail.hasAttachments,
    });
  }
  return composeGenericSynopsis({ newestEmail, classificationLabel, classificationReason, relTimeLabel });
}

function composeInvoiceSynopsis(args: {
  ident: ExtractedIdentifiers;
  vendorMatch: VendorMatchResult;
  apResult: ApLookupResult;
  newestEmail: EmailMessage;
  classificationReason: string | null;
  relTimeLabel: string;
  hasPdfInvoiceAttachment?: boolean;
}): OperationalAnalysis {
  const { ident, vendorMatch, apResult, newestEmail, relTimeLabel } = args;

  // -- Situation title -----------------------------------------------
  const invoiceLabel = ident.invoiceNumberRaw ? `Invoice #${ident.invoiceNumberRaw}` : "an invoice";
  const situationTitle = ident.invoiceNumberRaw
    ? `Vendor reports ${invoiceLabel} remains unpaid`
    : `Vendor reports an unpaid invoice`;

  // -- Context line --------------------------------------------------
  const vendorDisplay = pickVendorDisplayName(vendorMatch, ident, {
    hasPdfInvoiceAttachment: args.hasPdfInvoiceAttachment,
  });
  const contextLine = `${vendorDisplay} · Accounts payable · received ${relTimeLabel}`;

  // -- Evidence strip ------------------------------------------------
  const evidence: EvidenceCell[] = [
    {
      label: "VENDOR",
      value: vendorDisplay,
      state:
        vendorMatch.state === "MATCHED" ? "found" :
        vendorMatch.state === "AMBIGUOUS" ? "ambiguous" : "not_found",
    },
    {
      label: "INVOICE",
      value: ident.invoiceNumberRaw ? `#${ident.invoiceNumberRaw}` : "—",
      state: ident.invoiceNumberRaw ? "extracted" : "not_extracted",
    },
    {
      label: "AP STATUS",
      value: humanApStatus(apResult.state, apResult.invoices[0]?.status),
      state:
        apResult.state === "INVOICE_FOUND" ? "found" :
        apResult.state === "POSSIBLE_DUPLICATE" ? "duplicate" :
        apResult.state === "NO_AP_DATA_ON_CLUB" ? "no_data" :
        "not_found",
    },
    {
      label: "AMOUNT",
      value: ident.statedAmountCents != null ? formatCentsToDollars(ident.statedAmountCents) :
             (apResult.invoices[0]?.total ? `$${prettyDecimal(apResult.invoices[0].total)}` : "—"),
      state: ident.statedAmountCents != null || apResult.invoices[0]?.total ? "extracted" : "not_extracted",
    },
  ];

  // -- Synopsis + recommendation branches ---------------------------
  const senderRefLabel = vendorMatch.state === "MATCHED"
    ? vendorDisplay
    : ident.senderName || ident.senderEmail || "the sender";

  let synopsis: string;
  let recommendation: string;
  let debugRule: string;
  let actions: OperationalAnalysis["actionSuggestions"];

  if (apResult.state === "NO_AP_DATA_ON_CLUB") {
    debugRule = "invoice_no_ap_data_on_club";
    synopsis =
      `${senderRefLabel} states ${invoiceLabel} remains unpaid. ` +
      `This club has no imported vendor or AP subledger data, so Spectre cannot ` +
      `verify whether the invoice exists, is a duplicate, or has already been paid.`;
    recommendation =
      `The Accounts Payable subledger and vendor list are empty on this staging club. ` +
      `Import vendors and invoices before creating any AP entry. In the meantime, ` +
      `ask the sender to resend the invoice with a copy attached.`;
    actions = [
      { key: "view", label: "View email", kind: "primary", iconKey: "mail", onClickAction: "expand-view" },
      { key: "reply", label: "Review & send reply", kind: "secondary", iconKey: "reply", onClickAction: "expand-reply" },
      { key: "ap-draft", label: "Create AP draft", kind: "tertiary", iconKey: "edit",
        disabledReason: "AP subledger has no data on this staging club — vendor and invoice source required first." },
    ];
  } else if (apResult.state === "VENDOR_NOT_FOUND") {
    debugRule = "invoice_vendor_not_found";
    synopsis =
      `${senderRefLabel} states ${invoiceLabel} remains unpaid. ` +
      `Spectre searched the imported vendor list and found no vendor matching the ` +
      `sender's email, domain, or name. The vendor may not yet be onboarded, or ` +
      `this may be a first-time supplier.`;
    recommendation =
      `Confirm the vendor exists in Spectre before creating any AP entry. If this ` +
      `is a first-time supplier, onboard the vendor first. Otherwise ask the ` +
      `sender for the vendor's registered legal name.`;
    actions = [
      { key: "view", label: "View email", kind: "primary", iconKey: "mail", onClickAction: "expand-view" },
      { key: "reply", label: "Review & send reply", kind: "secondary", iconKey: "reply", onClickAction: "expand-reply" },
      { key: "ap-draft", label: "Create AP draft", kind: "tertiary", iconKey: "edit",
        disabledReason: "Vendor not found in Spectre. Onboard the vendor before creating an AP entry." },
    ];
  } else if (apResult.state === "VENDOR_AMBIGUOUS") {
    debugRule = "invoice_vendor_ambiguous";
    const names = vendorMatch.candidates.map((c) => c.operatingName ?? c.legalName).join(", ");
    synopsis =
      `${senderRefLabel} states ${invoiceLabel} remains unpaid. ` +
      `Spectre found multiple vendor candidates that could match this sender: ${names}. ` +
      `A specific vendor must be selected before Spectre can check the AP subledger.`;
    recommendation =
      `Select the correct vendor from the candidates before searching the AP ` +
      `subledger. Do not create an AP entry until the vendor is unambiguous.`;
    actions = [
      { key: "view", label: "View email", kind: "primary", iconKey: "mail", onClickAction: "expand-view" },
      { key: "reply", label: "Review & send reply", kind: "secondary", iconKey: "reply", onClickAction: "expand-reply" },
    ];
  } else if (apResult.state === "INSUFFICIENT_INFORMATION") {
    debugRule = "invoice_no_invoice_number_extracted";
    synopsis =
      `${senderRefLabel} references an invoice, but Spectre could not extract a ` +
      `specific invoice number from the message. Without an invoice number, no AP ` +
      `subledger check is possible.`;
    recommendation =
      `Ask the sender to include the exact invoice number in the reply, or attach ` +
      `the invoice document. Do not create an AP entry from a collection email alone.`;
    actions = [
      { key: "view", label: "View email", kind: "primary", iconKey: "mail", onClickAction: "expand-view" },
      { key: "reply", label: "Review & send reply", kind: "secondary", iconKey: "reply", onClickAction: "expand-reply" },
    ];
  } else if (apResult.state === "INVOICE_FOUND") {
    const inv = apResult.invoices[0]!;
    const paid = inv.status === "PAID" || Number(inv.total) === 0 || inv.postedAt != null;
    debugRule = paid ? "invoice_found_paid" : "invoice_found_open";
    if (paid) {
      synopsis =
        `${senderRefLabel} reports ${invoiceLabel} remains unpaid. ` +
        `Spectre's AP subledger has this invoice as ${inv.status} — ` +
        `payment appears to have been processed. The sender may not have received notification.`;
      recommendation =
        `Draft a reply with the payment date and reference, or investigate whether the ` +
        `payment was mis-allocated on the vendor's side.`;
    } else {
      synopsis =
        `${senderRefLabel} reports ${invoiceLabel} remains unpaid. ` +
        `Spectre's AP subledger confirms an open invoice: status ${inv.status}.`;
      recommendation =
        `Review the invoice's due status. Schedule or approve payment if it is due, ` +
        `and draft a reply confirming the schedule.`;
    }
    actions = [
      { key: "view", label: "View email", kind: "primary", iconKey: "mail", onClickAction: "expand-view" },
      { key: "reply", label: "Review & send reply", kind: "secondary", iconKey: "reply", onClickAction: "expand-reply" },
    ];
  } else if (apResult.state === "POSSIBLE_DUPLICATE") {
    debugRule = "invoice_possible_duplicate";
    synopsis =
      `${senderRefLabel} reports ${invoiceLabel} remains unpaid. ` +
      `Spectre found ${apResult.invoices.length} candidate AP entries that could match. ` +
      `The correct entry must be identified before responding.`;
    recommendation =
      `Review the candidate AP entries and determine which is correct. Do not ` +
      `create an additional AP entry without eliminating the possibility of duplication.`;
    actions = [
      { key: "view", label: "View email", kind: "primary", iconKey: "mail", onClickAction: "expand-view" },
      { key: "reply", label: "Review & send reply", kind: "secondary", iconKey: "reply", onClickAction: "expand-reply" },
    ];
  } else {
    // INVOICE_NOT_FOUND — the vendor is known but the invoice isn't in AP.
    debugRule = "invoice_not_found_in_ap";
    const hasAttachment = newestEmail.hasAttachments;
    if (hasAttachment) {
      synopsis =
        `${senderRefLabel} reports ${invoiceLabel} remains unpaid. ` +
        `Spectre found the vendor but no matching invoice in the AP subledger. ` +
        `The email includes an attachment — this may be the invoice document.`;
      recommendation =
        `Review the attached invoice and create an AP draft if the details are complete. ` +
        `Verify vendor, amount, tax, and expense-account assignment before posting.`;
    } else {
      synopsis =
        `${senderRefLabel} reports ${invoiceLabel} remains unpaid. ` +
        `Spectre found the vendor but no matching invoice in the AP subledger, and ` +
        `no invoice document is attached to this email.`;
      recommendation =
        `Ask the vendor to resend the invoice as an attachment before creating any AP entry. ` +
        `Do not post an invoice from a collection email alone — required fields (line items, ` +
        `tax breakdown, invoice date) are not verifiable from this message.`;
    }
    actions = [
      { key: "view", label: "View email", kind: "primary", iconKey: "mail", onClickAction: "expand-view" },
      { key: "reply", label: "Review & send reply", kind: "secondary", iconKey: "reply", onClickAction: "expand-reply" },
      { key: "ap-draft", label: "Create AP draft", kind: "tertiary", iconKey: "edit",
        disabledReason: hasAttachment
          ? "AP draft creation from email is not yet available. Manually create the AP entry from the attachment."
          : "No invoice attachment. Ask the vendor to resend before creating an AP entry." },
    ];
  }

  return {
    situationTitle,
    contextLine,
    synopsis,
    evidence,
    recommendation,
    actionSuggestions: actions,
    debug: {
      ruleUsed: debugRule,
      vendorMatch: vendorMatch.state,
      vendorCandidateCount: vendorMatch.candidates.length,
      apLookup: apResult.state,
    },
  };
}

function composeGenericSynopsis(args: {
  newestEmail: EmailMessage;
  classificationLabel: string | null;
  classificationReason: string | null;
  relTimeLabel: string;
}): OperationalAnalysis {
  const { newestEmail, classificationLabel, classificationReason, relTimeLabel } = args;
  const senderLabel = newestEmail.senderName || newestEmail.senderAddress || "Unknown sender";
  const kind = classificationLabel === "INTERNAL_OPERATIONS" ? "Internal operations"
             : classificationLabel === "MEMBER_INQUIRY_LIKELY" ? "Member inquiry"
             : classificationLabel === "VENDOR_COMMUNICATION" ? "Vendor communication"
             : classificationLabel === "HIGH_IMPORTANCE" ? "High-importance mail"
             : classificationLabel === "INFORMATIONAL" ? "Informational"
             : "Correspondence";

  return {
    situationTitle: newestEmail.subject || "(no subject)",
    contextLine: `${senderLabel} · ${kind} · received ${relTimeLabel}`,
    synopsis:
      `${senderLabel} sent this message. Spectre classified it as ${kind.toLowerCase()}. ` +
      (classificationReason || `Open the message to review the sender's intent and decide next steps.`),
    // Sprint 3 · Checkpoint 16G Stage D (2026-08-04) — the evidence
    // array remains AP-labelled here for backward compatibility with
    // legacy renderers, but the DomainCardViewModel path in the card
    // no longer uses it. Non-AP cards render domain-specific fields
    // via buildDomainViewModel; the AP labels below are inert unless
    // the pre-16G fallback renderer fires (only possible when
    // workDomain is absent, i.e. an ancient unbacked WI).
    evidence: [
      { label: "VENDOR", value: senderLabel, state: "not_found" },
      { label: "INVOICE", value: "—", state: "not_extracted" },
      { label: "AP STATUS", value: "n/a", state: "no_data" },
      { label: "AMOUNT", value: "—", state: "not_extracted" },
    ],
    recommendation:
      classificationReason ??
      `Review the message and take the appropriate action. If a response is required, use "Review & send reply".`,
    actionSuggestions: [
      { key: "view", label: "View email", kind: "primary", iconKey: "mail", onClickAction: "expand-view" },
      { key: "reply", label: "Review & send reply", kind: "secondary", iconKey: "reply", onClickAction: "expand-reply" },
    ],
    debug: {
      ruleUsed: "generic_non_invoice",
      vendorMatch: "NOT_FOUND",
      vendorCandidateCount: 0,
      apLookup: "INSUFFICIENT_INFORMATION",
    },
  };
}

// ---------------------------------------------------------------------------
// Small formatting helpers
// ---------------------------------------------------------------------------

function pickVendorDisplayName(
  match: VendorMatchResult,
  ident: ExtractedIdentifiers,
  opts?: { hasPdfInvoiceAttachment?: boolean },
): string {
  if (match.state === "MATCHED" && match.candidates[0]) {
    return match.candidates[0].operatingName ?? match.candidates[0].legalName;
  }
  // Sprint 3 · Checkpoint 15S (2026-07-29) — do NOT fall back to
  // sender when the email carries a PDF invoice attachment. The
  // canonical AP analysis is the authoritative source of vendor
  // identity in that case; the message-level projection MUST NOT
  // claim the sender IS the vendor. When the AP intake resolves
  // via ApIntakeSource, the AP card variant renders instead of
  // this email variant. When the AP variant fails to render for
  // any reason, showing the em-dash (existing missing-data
  // convention used by INVOICE / AMOUNT cells) is safer than
  // silently mislabelling the founder as the vendor.
  if (opts?.hasPdfInvoiceAttachment) {
    return "—";
  }
  return ident.senderName || ident.senderEmail || "Unknown sender";
}

function humanApStatus(state: ApLookupState, invoiceStatus?: string): string {
  switch (state) {
    case "INVOICE_FOUND": return invoiceStatus ? `Found · ${invoiceStatus}` : "Found";
    case "POSSIBLE_DUPLICATE": return "Possible duplicate";
    case "INVOICE_NOT_FOUND": return "Not found";
    case "INSUFFICIENT_INFORMATION": return "Not searchable";
    case "VENDOR_AMBIGUOUS": return "Vendor ambiguous";
    case "VENDOR_NOT_FOUND": return "Vendor not found";
    case "NO_AP_DATA_ON_CLUB": return "No AP data";
    default: return "—";
  }
}

function formatCentsToDollars(cents: number): string {
  const dollars = cents / 100;
  return `$${dollars.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function prettyDecimal(decimalStr: string): string {
  const num = Number(decimalStr);
  if (!Number.isFinite(num)) return decimalStr;
  return num.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
