// Sprint 3 Checkpoint 15E (2026-07-24) — AP reconciliation.
//
// Given a parsed invoice + a matched vendor (or a set of candidates),
// search the APInvoice subledger for an existing record and emit the
// appropriate reconciliation finding. Every finding explains WHY.
//
// Duplicate detection is layered:
//   1. Hash duplicate — the SAME PDF has already been attached to an
//      APInvoice on this club (via IngestedDocumentEvidenceLink).
//   2. VendorRef duplicate — an APInvoice already exists on
//      (vendorId, vendorReference).
//   3. Amount / date mismatch — VendorRef matches but the header
//      totals differ from the extracted PDF.

import { prisma } from "@/lib/prisma";
import type { ApReconcileState, ExtractedInvoice } from "./types";
import type { VendorResolveResult } from "./vendor-resolve";
import { toMoney } from "@/lib/accounting/decimal";

const RULE_VERSION = 1;

export interface ReconcileFinding {
  key: string;
  severity: "INFO" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  statement: string;
  ruleKey: string;
  ruleVersion: number;
  apInvoiceId?: string;
}

export interface ReconcileResult {
  state: ApReconcileState;
  matchedApInvoiceId: string | null;
  findings: ReconcileFinding[];
  ruleVersion: number;
}

export interface ReconcileArgs {
  clubId: string;
  extraction: ExtractedInvoice;
  vendor: VendorResolveResult;
  ingestedDocumentId: string;
  ingestedDocumentSha256: string;
}

export async function reconcileAgainstAp(args: ReconcileArgs): Promise<ReconcileResult> {
  const findings: ReconcileFinding[] = [];

  // --- 1) Hash duplicate check -------------------------------------------
  const hashLink = await prisma.ingestedDocumentEvidenceLink.findFirst({
    where: {
      clubId: args.clubId,
      targetKind: "AP_INVOICE",
      ingestedDocument: { sha256Hash: args.ingestedDocumentSha256 },
    },
    select: { targetReferenceId: true },
  });
  if (hashLink) {
    findings.push({
      key: "ap.invoice.hash_duplicate",
      severity: "CRITICAL",
      statement: "An APInvoice on this club already has this exact PDF attached (same SHA-256). Do not create a duplicate — attach the source email to the existing invoice instead.",
      ruleKey: "reconcile.hash_duplicate",
      ruleVersion: RULE_VERSION,
      apInvoiceId: hashLink.targetReferenceId,
    });
    return {
      state: "HASH_DUPLICATE",
      matchedApInvoiceId: hashLink.targetReferenceId,
      findings,
      ruleVersion: RULE_VERSION,
    };
  }

  // --- 2) Vendor + vendorReference lookup --------------------------------
  const vendorId = args.vendor.state === "MATCHED" ? args.vendor.candidates[0].id : null;
  const vendorReference = args.extraction.invoiceNumber;

  if (!vendorId) {
    // No vendor match — cannot reconcile against AP by vendorRef alone.
    if (args.vendor.state === "AMBIGUOUS") {
      findings.push({
        key: "ap.invoice.vendor_ambiguous",
        severity: "MEDIUM",
        statement: `Multiple candidate vendors matched the extracted invoice. Reviewer must confirm which vendor.`,
        ruleKey: "reconcile.vendor_ambiguous",
        ruleVersion: RULE_VERSION,
      });
    } else if (args.vendor.state === "NOT_FOUND") {
      findings.push({
        key: "ap.invoice.vendor_not_found",
        severity: "MEDIUM",
        statement: "The vendor could not be resolved from the extracted invoice. Reviewer must select or create a vendor.",
        ruleKey: "reconcile.vendor_not_found",
        ruleVersion: RULE_VERSION,
      });
    } else {
      findings.push({
        key: "ap.invoice.insufficient_signal",
        severity: "LOW",
        statement: "The invoice did not contain enough vendor identity to attempt reconciliation.",
        ruleKey: "reconcile.insufficient_signal",
        ruleVersion: RULE_VERSION,
      });
    }
    return { state: "INSUFFICIENT_SIGNAL", matchedApInvoiceId: null, findings, ruleVersion: RULE_VERSION };
  }

  if (!vendorReference) {
    findings.push({
      key: "ap.invoice.no_reference",
      severity: "LOW",
      statement: "No invoice number was extracted from the PDF — cannot reconcile against existing APInvoices on (vendor, invoice #).",
      ruleKey: "reconcile.no_reference",
      ruleVersion: RULE_VERSION,
    });
    return { state: "INSUFFICIENT_SIGNAL", matchedApInvoiceId: null, findings, ruleVersion: RULE_VERSION };
  }

  // --- 3) Duplicate / mismatch lookup ------------------------------------
  const existing = await prisma.aPInvoice.findFirst({
    where: {
      clubId: args.clubId,
      vendorId,
      vendorReference,
    },
    select: {
      id: true,
      total: true,
      invoiceDate: true,
      vendorId: true,
    },
  });

  if (!existing) {
    findings.push({
      key: "ap.invoice.not_found",
      severity: "INFO",
      statement: `No APInvoice exists yet for vendor + invoice-number "${vendorReference}". Reviewer may create a new draft.`,
      ruleKey: "reconcile.not_found",
      ruleVersion: RULE_VERSION,
    });
    return { state: "NOT_FOUND", matchedApInvoiceId: null, findings, ruleVersion: RULE_VERSION };
  }

  const findingsForExisting: ReconcileFinding[] = [];
  let terminal: ApReconcileState = "MATCH";

  // Amount comparison
  if (args.extraction.total) {
    const extractedTotal = toMoney(args.extraction.total);
    const existingTotal = toMoney(existing.total);
    if (!extractedTotal.equals(existingTotal)) {
      findingsForExisting.push({
        key: "ap.invoice.amount_mismatch",
        severity: "HIGH",
        statement: `An APInvoice for this vendor already exists with reference "${vendorReference}" but with total ${existingTotal.toFixed(2)}. The extracted PDF says ${extractedTotal.toFixed(2)}.`,
        ruleKey: "reconcile.amount_mismatch",
        ruleVersion: RULE_VERSION,
        apInvoiceId: existing.id,
      });
      terminal = "AMOUNT_MISMATCH";
    }
  }

  // Date comparison — tolerate ±3 days for typo / timezone drift.
  if (args.extraction.invoiceDate) {
    const extractedIso = args.extraction.invoiceDate;
    const existingIso = existing.invoiceDate.toISOString().slice(0, 10);
    const diffDays = Math.abs(
      (new Date(extractedIso).getTime() - new Date(existingIso).getTime()) / (1000 * 60 * 60 * 24),
    );
    if (diffDays > 3) {
      findingsForExisting.push({
        key: "ap.invoice.date_mismatch",
        severity: "MEDIUM",
        statement: `An APInvoice with the same vendor + reference exists but with a different invoice date (${existingIso} vs ${extractedIso}).`,
        ruleKey: "reconcile.date_mismatch",
        ruleVersion: RULE_VERSION,
        apInvoiceId: existing.id,
      });
      if (terminal === "MATCH") terminal = "DATE_MISMATCH";
    }
  }

  if (terminal === "MATCH") {
    // Clean match / true duplicate.
    findings.push({
      key: "ap.invoice.duplicate",
      severity: "HIGH",
      statement: `An APInvoice already exists for this vendor + invoice number "${vendorReference}". Reviewer must decide whether to attach as evidence or dispute.`,
      ruleKey: "reconcile.duplicate",
      ruleVersion: RULE_VERSION,
      apInvoiceId: existing.id,
    });
    return { state: "DUPLICATE", matchedApInvoiceId: existing.id, findings, ruleVersion: RULE_VERSION };
  }

  findings.push(...findingsForExisting);
  return { state: terminal, matchedApInvoiceId: existing.id, findings, ruleVersion: RULE_VERSION };
}
