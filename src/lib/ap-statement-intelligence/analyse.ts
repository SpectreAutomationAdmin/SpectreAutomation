// Sprint 3 Checkpoint 15G (2026-07-24) — Statement analyser
// orchestrator.
//
// Sequence:
//   1. Load IngestedDocument (must be STATEMENT classification, PDF).
//   2. Extract bytes (or use the extractedTextOverride seam for tests).
//   3. pdf-parse → text.
//   4. parseStatementText → structured extraction.
//   5. Resolve canonical vendor via 15F alias-aware resolver.
//   6. For each line: classify → match against APInvoice / VendorPayment /
//      Credit → collect findings.
//   7. Validate statement arithmetic + Spectre ledger balance vs closing.
//   8. Derive terminal reconciliationState from the collected findings.

import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/observability/logger";
import { extractPdfText } from "@/lib/ap-intelligence/pdf-extract";
import { parseStatementText } from "./parse-statement";
import { resolveStatementVendor, type StatementVendorResolution } from "./vendor-resolve";
import { matchInvoiceLine, type InvoiceMatchResult } from "./match-invoice";
import { matchPaymentLine, type PaymentMatchResult } from "./match-payment";
import { matchCreditLine, type CreditMatchResult } from "./match-credit";
import { validateStatementArithmetic, validateLedgerBalance } from "./balance-validate";
import { findCandidateInvoiceDocument, type CandidateInvoiceDocument } from "./cross-link";
import { resolveDocumentStorage } from "@/lib/documents/storage";
import type { DocumentStorageAdapter } from "@/lib/documents/types";
import type {
  ExtractedStatement,
  ReconciliationState,
  StatementFindingKey,
  StatementMatchState,
  StatementTransactionKind,
} from "./types";
import { STATEMENT_RULE_VERSION } from "./types";

export interface StatementAnalyseArgs {
  clubId: string;
  ingestedDocumentId: string;
  now?: Date;
  emailSubject?: string | null;
  emailSenderAddress?: string | null;
  storageOverride?: DocumentStorageAdapter;
  extractedTextOverride?: string | null;
}

export interface StatementLineOutcome {
  sequence: number;
  transactionKind: StatementTransactionKind;
  matchTargetKind: "AP_INVOICE" | "VENDOR_PAYMENT" | "AP_CREDIT" | "NONE";
  matchTargetReferenceId: string | null;
  matchState: StatementMatchState;
  matchBasis: { ruleKey: string; signals: string[] };
  amountDifferenceCents: number | null;
  dateDifferenceDays: number | null;
  candidateInvoiceDocument?: CandidateInvoiceDocument | null;
}

export interface StatementFinding {
  key: StatementFindingKey;
  severity: "INFO" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  statement: string;
  ruleKey: string;
  ruleVersion: number;
  lineSequence?: number | null;
  targetKind?: "AP_INVOICE" | "VENDOR_PAYMENT" | "AP_CREDIT" | "INGESTED_DOCUMENT" | null;
  targetReferenceId?: string | null;
  amountDifferenceCents?: number | null;
  dateDifferenceDays?: number | null;
}

export interface StatementAnalyseResult {
  documentId: string;
  ruleVersion: number;
  extraction: ExtractedStatement;
  vendor: StatementVendorResolution;
  lineOutcomes: StatementLineOutcome[];
  findings: StatementFinding[];
  reconciliationState: ReconciliationState;
}

export async function analyseIngestedStatement(args: StatementAnalyseArgs): Promise<StatementAnalyseResult> {
  const doc = await prisma.ingestedDocument.findFirst({
    where: { id: args.ingestedDocumentId, clubId: args.clubId },
    select: { id: true, mimeType: true, classification: true, storageBucket: true, storageKey: true, filename: true },
  });
  if (!doc) throw new Error(`Statement analyser: document ${args.ingestedDocumentId} not found for club ${args.clubId}`);
  if (doc.mimeType !== "application/pdf") throw new Error(`Statement analyser: document ${doc.id} is ${doc.mimeType}, not PDF`);

  // ---- 1) extract text --------------------------------------------------
  let pdfOk = true;
  let pdfText = "";
  let pdfReason: string | null = null;
  if (args.extractedTextOverride != null) {
    pdfText = args.extractedTextOverride;
    pdfOk = pdfText.trim().length > 0;
    if (!pdfOk) pdfReason = "EMPTY_TEXT";
  } else {
    const adapter = args.storageOverride ?? (await resolveDocumentStorage({ clubId: args.clubId }));
    const bytes = await adapter.get({ storageKey: doc.storageKey });
    if (!bytes) throw new Error(`Statement analyser: storage returned no bytes for ${doc.id}`);
    const pdf = await extractPdfText(bytes);
    pdfOk = pdf.ok;
    pdfText = pdf.ok ? pdf.text : "";
    pdfReason = pdf.reason ?? null;
  }

  const extraction = parseStatementText({ extractedText: pdfOk ? pdfText : "" });
  if (!pdfOk) {
    extraction.state = "DOCUMENT_UNREADABLE";
    extraction.warnings.push(pdfReason ?? "PDF_PARSE_ERROR");
  }

  const findings: StatementFinding[] = [];
  const lineOutcomes: StatementLineOutcome[] = [];

  if (extraction.state === "DOCUMENT_UNREADABLE") {
    findings.push({
      key: "ap.statement.unreadable",
      severity: "HIGH",
      statement: "Statement PDF could not be parsed.",
      ruleKey: "analyse.unreadable",
      ruleVersion: STATEMENT_RULE_VERSION,
    });
    return {
      documentId: doc.id,
      ruleVersion: STATEMENT_RULE_VERSION,
      extraction,
      vendor: { state: "NOT_FOUND", canonicalVendorId: null, candidates: [], ruleVersion: STATEMENT_RULE_VERSION },
      lineOutcomes: [],
      findings,
      reconciliationState: "DOCUMENT_UNREADABLE",
    };
  }
  if (extraction.state === "UNSUPPORTED_LAYOUT") {
    findings.push({
      key: "ap.statement.unsupported_layout",
      severity: "MEDIUM",
      statement: "Statement layout is not one the deterministic parser recognises.",
      ruleKey: "analyse.unsupported_layout",
      ruleVersion: STATEMENT_RULE_VERSION,
    });
  }

  // ---- 2) resolve vendor ------------------------------------------------
  const vendor = await resolveStatementVendor({
    clubId: args.clubId,
    extraction,
    senderAddress: args.emailSenderAddress ?? null,
  });
  if (vendor.state === "NOT_FOUND") {
    findings.push({
      key: "ap.statement.vendor_not_found",
      severity: "HIGH",
      statement: `No canonical vendor matched the statement header (extracted vendor guess: "${extraction.header.vendorNameGuess ?? "unknown"}").`,
      ruleKey: "analyse.vendor_not_found",
      ruleVersion: STATEMENT_RULE_VERSION,
    });
  } else if (vendor.state === "AMBIGUOUS" || vendor.state === "CONFLICT_REQUIRES_REVIEW") {
    findings.push({
      key: "ap.statement.vendor_ambiguous",
      severity: "MEDIUM",
      statement: `${vendor.candidates.length} candidate vendors matched. Reviewer must confirm.`,
      ruleKey: "analyse.vendor_ambiguous",
      ruleVersion: STATEMENT_RULE_VERSION,
    });
  }

  // Only reconcile lines if we have a canonical vendor.
  if (vendor.state === "MATCHED" && vendor.canonicalVendorId) {
    const seenRefs = new Map<string, number[]>();
    for (const line of extraction.lines) {
      let outcome: StatementLineOutcome;
      if (line.transactionKind === "OPENING_BALANCE" || line.transactionKind === "BALANCE_FORWARD") {
        outcome = {
          sequence: line.sequence,
          transactionKind: line.transactionKind,
          matchTargetKind: "NONE",
          matchTargetReferenceId: null,
          matchState: "NOT_FOUND",
          matchBasis: { ruleKey: "line.opening_balance_no_match", signals: [] },
          amountDifferenceCents: null,
          dateDifferenceDays: null,
        };
      } else if (line.transactionKind === "INVOICE") {
        const m = await matchInvoiceLine({ clubId: args.clubId, canonicalVendorId: vendor.canonicalVendorId, line });
        outcome = await outcomeFromInvoice(m, line);
        if (m.state === "NOT_FOUND") {
          // Phase Q cross-link.
          const candidate = await findCandidateInvoiceDocument({
            clubId: args.clubId, canonicalVendorId: vendor.canonicalVendorId, line,
          });
          if (candidate) outcome.candidateInvoiceDocument = candidate;
        }
        pushInvoiceFindings(findings, line, m);
      } else if (line.transactionKind === "PAYMENT") {
        const m = await matchPaymentLine({ clubId: args.clubId, canonicalVendorId: vendor.canonicalVendorId, line });
        outcome = outcomeFromPayment(m, line);
        pushPaymentFindings(findings, line, m);
      } else if (line.transactionKind === "CREDIT_NOTE") {
        const m = await matchCreditLine({ clubId: args.clubId, canonicalVendorId: vendor.canonicalVendorId, line });
        outcome = outcomeFromCredit(m, line);
        pushCreditFindings(findings, line, m);
      } else if (line.transactionKind === "FINANCE_CHARGE") {
        outcome = {
          sequence: line.sequence,
          transactionKind: line.transactionKind,
          matchTargetKind: "NONE",
          matchTargetReferenceId: null,
          matchState: "NOT_FOUND",
          matchBasis: { ruleKey: "line.finance_charge_unrecorded", signals: [] },
          amountDifferenceCents: null,
          dateDifferenceDays: null,
        };
        findings.push({
          key: "ap.statement.finance_charge_unrecorded",
          severity: "LOW",
          statement: `Statement contains a finance charge that Spectre AP has no matching record for.`,
          ruleKey: "analyse.finance_charge",
          ruleVersion: STATEMENT_RULE_VERSION,
          lineSequence: line.sequence,
        });
      } else {
        outcome = {
          sequence: line.sequence,
          transactionKind: line.transactionKind,
          matchTargetKind: "NONE",
          matchTargetReferenceId: null,
          matchState: "NOT_FOUND",
          matchBasis: { ruleKey: "line.unknown_transaction", signals: [] },
          amountDifferenceCents: null,
          dateDifferenceDays: null,
        };
        findings.push({
          key: "ap.statement.unknown_transaction",
          severity: "LOW",
          statement: `Statement line ${line.sequence} could not be classified deterministically.`,
          ruleKey: "analyse.unknown_transaction",
          ruleVersion: STATEMENT_RULE_VERSION,
          lineSequence: line.sequence,
        });
      }

      // Duplicate-statement-line detection (same ref, same amount, appears twice).
      const refKey = `${(line.referenceNumber ?? "").toLowerCase()}::${line.debitAmount ?? ""}::${line.creditAmount ?? ""}`;
      const prior = seenRefs.get(refKey) ?? [];
      if (prior.length > 0) {
        outcome.matchState = "DUPLICATE_STATEMENT_LINE";
        findings.push({
          key: "ap.statement.duplicate_statement_line",
          severity: "MEDIUM",
          statement: `Statement lines ${prior.join(",")} + ${line.sequence} share the same reference + amount.`,
          ruleKey: "analyse.duplicate_statement_line",
          ruleVersion: STATEMENT_RULE_VERSION,
          lineSequence: line.sequence,
        });
      }
      prior.push(line.sequence);
      seenRefs.set(refKey, prior);

      lineOutcomes.push(outcome);
    }
  }

  // ---- 3) balance validation --------------------------------------------
  const arithmetic = validateStatementArithmetic(extraction);
  for (const a of arithmetic) {
    findings.push({
      key: a.key,
      severity: a.severity,
      statement: a.statement,
      ruleKey: "analyse.balance_arithmetic",
      ruleVersion: STATEMENT_RULE_VERSION,
      amountDifferenceCents: a.differenceCents,
    });
  }
  if (vendor.state === "MATCHED" && vendor.canonicalVendorId && extraction.header.statementDate) {
    const ledger = await validateLedgerBalance({
      clubId: args.clubId,
      vendorId: vendor.canonicalVendorId,
      statementDate: new Date(extraction.header.statementDate),
      extraction,
    });
    if (ledger) {
      findings.push({
        key: ledger.key,
        severity: ledger.severity,
        statement: ledger.statement,
        ruleKey: "analyse.ledger_balance",
        ruleVersion: STATEMENT_RULE_VERSION,
        amountDifferenceCents: ledger.differenceCents,
      });
    }
  }

  // ---- 4) derive reconciliation state -----------------------------------
  const reconciliationState = deriveReconciliationState({ extraction, vendor, findings });

  // If we're RECONCILED, emit the affirmative finding.
  if (reconciliationState === "RECONCILED" || reconciliationState === "RECONCILED_WITH_TIMING_DIFFERENCES") {
    findings.push({
      key: "ap.statement.reconciled",
      severity: "INFO",
      statement: reconciliationState === "RECONCILED"
        ? "Statement reconciled cleanly with the AP ledger."
        : "Statement reconciled; only timing differences remain.",
      ruleKey: "analyse.reconciled",
      ruleVersion: STATEMENT_RULE_VERSION,
    });
  }

  logger.info("ap-statement.analyse.complete", {
    clubId: args.clubId,
    documentIdTail: doc.id.slice(-6),
    extractionState: extraction.state,
    lineCount: extraction.lines.length,
    vendorState: vendor.state,
    findingCount: findings.length,
    reconciliationState,
  });

  return {
    documentId: doc.id,
    ruleVersion: STATEMENT_RULE_VERSION,
    extraction,
    vendor,
    lineOutcomes,
    findings,
    reconciliationState,
  };
}

// -----------------------------------------------------------------------------
// helpers
// -----------------------------------------------------------------------------
async function outcomeFromInvoice(m: InvoiceMatchResult, line: { sequence: number; transactionKind: StatementTransactionKind }): Promise<StatementLineOutcome> {
  return {
    sequence: line.sequence,
    transactionKind: line.transactionKind,
    matchTargetKind: "AP_INVOICE",
    matchTargetReferenceId: m.matchedApInvoiceId,
    matchState: m.state,
    matchBasis: m.matchBasis,
    amountDifferenceCents: m.amountDifferenceCents,
    dateDifferenceDays: m.dateDifferenceDays,
  };
}
function outcomeFromPayment(m: PaymentMatchResult, line: { sequence: number; transactionKind: StatementTransactionKind }): StatementLineOutcome {
  return {
    sequence: line.sequence,
    transactionKind: line.transactionKind,
    matchTargetKind: "VENDOR_PAYMENT",
    matchTargetReferenceId: m.matchedPaymentId,
    matchState: m.state,
    matchBasis: m.matchBasis,
    amountDifferenceCents: m.amountDifferenceCents,
    dateDifferenceDays: m.dateDifferenceDays,
  };
}
function outcomeFromCredit(m: CreditMatchResult, line: { sequence: number; transactionKind: StatementTransactionKind }): StatementLineOutcome {
  return {
    sequence: line.sequence,
    transactionKind: line.transactionKind,
    matchTargetKind: m.matchedTargetKind === "VENDOR_PAYMENT" ? "VENDOR_PAYMENT" : m.matchedTargetKind === "AP_INVOICE" ? "AP_CREDIT" : "NONE",
    matchTargetReferenceId: m.matchedTargetReferenceId,
    matchState: m.state,
    matchBasis: m.matchBasis,
    amountDifferenceCents: m.amountDifferenceCents,
    dateDifferenceDays: null,
  };
}

function pushInvoiceFindings(findings: StatementFinding[], line: { sequence: number; referenceNumber: string | null }, m: InvoiceMatchResult) {
  const base = { lineSequence: line.sequence, targetKind: "AP_INVOICE" as const, targetReferenceId: m.matchedApInvoiceId, amountDifferenceCents: m.amountDifferenceCents, dateDifferenceDays: m.dateDifferenceDays, ruleVersion: STATEMENT_RULE_VERSION };
  switch (m.state) {
    case "NOT_FOUND":
      findings.push({ key: "ap.statement.invoice_not_found", severity: "HIGH", statement: `Statement invoice ${line.referenceNumber ?? "?"} has no matching AP record.`, ruleKey: m.matchBasis.ruleKey, ...base });
      break;
    case "AMOUNT_MISMATCH":
      findings.push({ key: "ap.statement.invoice_amount_mismatch", severity: "HIGH", statement: `Invoice ${line.referenceNumber ?? "?"} matched by reference but amount differs by ${m.amountDifferenceCents ? (m.amountDifferenceCents/100).toFixed(2) : "?"}.`, ruleKey: m.matchBasis.ruleKey, ...base });
      break;
    case "DATE_MISMATCH":
      findings.push({ key: "ap.statement.invoice_date_mismatch", severity: "MEDIUM", statement: `Invoice ${line.referenceNumber ?? "?"} matched by reference but date differs by ${m.dateDifferenceDays ?? "?"} days.`, ruleKey: m.matchBasis.ruleKey, ...base });
      break;
    case "DUPLICATE_LEDGER_ENTRY":
      findings.push({ key: "ap.statement.duplicate_invoice_in_ledger", severity: "HIGH", statement: `Reference ${line.referenceNumber ?? "?"} exists on 2+ AP invoices for this vendor.`, ruleKey: m.matchBasis.ruleKey, ...base });
      break;
    default:
      break;
  }
}

function pushPaymentFindings(findings: StatementFinding[], line: { sequence: number; referenceNumber: string | null }, m: PaymentMatchResult) {
  const base = { lineSequence: line.sequence, targetKind: "VENDOR_PAYMENT" as const, targetReferenceId: m.matchedPaymentId, amountDifferenceCents: m.amountDifferenceCents, dateDifferenceDays: m.dateDifferenceDays, ruleVersion: STATEMENT_RULE_VERSION };
  switch (m.state) {
    case "PAYMENT_NOT_FOUND":
    case "NOT_FOUND":
      findings.push({ key: "ap.statement.payment_not_found", severity: "HIGH", statement: `Statement payment ${line.referenceNumber ?? "?"} not found in Spectre AP.`, ruleKey: m.matchBasis.ruleKey, ...base });
      break;
    case "PAYMENT_AMOUNT_MISMATCH":
      findings.push({ key: "ap.statement.payment_amount_mismatch", severity: "HIGH", statement: `Payment ${line.referenceNumber ?? "?"} matched but amount differs.`, ruleKey: m.matchBasis.ruleKey, ...base });
      break;
    case "UNAPPLIED_PAYMENT":
      findings.push({ key: "ap.statement.unapplied_payment", severity: "MEDIUM", statement: `Vendor-level payment matches but has no invoice application in Spectre — cannot prove which invoice it settled.`, ruleKey: m.matchBasis.ruleKey, ...base });
      break;
    case "VOIDED_PAYMENT_CONFLICT":
      findings.push({ key: "ap.statement.voided_payment_conflict", severity: "HIGH", statement: `Statement shows payment ${line.referenceNumber ?? "?"}, but Spectre has this payment marked VOIDED.`, ruleKey: m.matchBasis.ruleKey, ...base });
      break;
    default:
      break;
  }
}

function pushCreditFindings(findings: StatementFinding[], line: { sequence: number; referenceNumber: string | null }, m: CreditMatchResult) {
  const base = { lineSequence: line.sequence, targetKind: (m.matchedTargetKind === "AP_INVOICE" ? "AP_CREDIT" : m.matchedTargetKind === "VENDOR_PAYMENT" ? "VENDOR_PAYMENT" : null) as StatementFinding["targetKind"], targetReferenceId: m.matchedTargetReferenceId, amountDifferenceCents: m.amountDifferenceCents, ruleVersion: STATEMENT_RULE_VERSION };
  switch (m.state) {
    case "CREDIT_NOT_FOUND":
      findings.push({ key: "ap.statement.credit_not_found", severity: "MEDIUM", statement: `Statement credit ${line.referenceNumber ?? "?"} has no matching Spectre AP credit or unapplied payment.`, ruleKey: m.matchBasis.ruleKey, ...base });
      break;
    case "UNAPPLIED_CREDIT":
      findings.push({ key: "ap.statement.unapplied_credit", severity: "MEDIUM", statement: `Statement credit matched an unapplied payment on the vendor.`, ruleKey: m.matchBasis.ruleKey, ...base });
      break;
    case "CREDIT_AMOUNT_MISMATCH":
      findings.push({ key: "ap.statement.credit_amount_mismatch" as StatementFindingKey, severity: "MEDIUM", statement: `Statement credit matched Spectre credit note but amount differs.`, ruleKey: m.matchBasis.ruleKey, ...base });
      break;
    default:
      break;
  }
}

function deriveReconciliationState(args: {
  extraction: ExtractedStatement;
  vendor: StatementVendorResolution;
  findings: StatementFinding[];
}): ReconciliationState {
  if (args.extraction.state === "DOCUMENT_UNREADABLE") return "DOCUMENT_UNREADABLE";
  if (args.extraction.state === "UNSUPPORTED_LAYOUT" || args.extraction.state === "INSUFFICIENT_EVIDENCE") return "INSUFFICIENT_EVIDENCE";
  if (args.vendor.state !== "MATCHED") return "VENDOR_UNRESOLVED";

  const hasExceptions = args.findings.some((f) =>
    f.severity === "HIGH" || f.severity === "CRITICAL",
  );
  const hasTimingOnly = args.findings.every((f) =>
    f.key === "ap.statement.reconciled" ||
    f.key === "ap.statement.invoice_date_mismatch" ||
    f.key === "ap.statement.finance_charge_unrecorded" ||
    f.severity === "INFO" ||
    f.severity === "LOW",
  );
  if (hasExceptions) return "EXCEPTIONS_FOUND";
  if (args.findings.length === 0) return "RECONCILED";
  if (hasTimingOnly) return "RECONCILED_WITH_TIMING_DIFFERENCES";
  return "REVIEW_REQUIRED";
}
