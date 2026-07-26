// Sprint 3 Checkpoint 15E (2026-07-24) — Deterministic accounting
// validation on the parsed invoice. Every check emits a finding with
// a stable `ruleKey` so downstream persistence (WorkIntakeFinding)
// captures WHY the invoice is flagged.
//
// Rules are pure arithmetic — no rounding, no silent reconciliation.
// All money math flows through `toMoney` for Decimal safety.

import type { ExtractedInvoice } from "./types";
import { toMoney, sumMoney } from "@/lib/accounting/decimal";

export interface ValidationFinding {
  key: string;                    // "ap.invoice.total_mismatch" etc.
  severity: "INFO" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  statement: string;
  ruleKey: string;
  ruleVersion: number;
}

const RULE_VERSION = 1;

export function validateExtractedArithmetic(invoice: ExtractedInvoice): ValidationFinding[] {
  const findings: ValidationFinding[] = [];

  // Sprint 3 Checkpoint 15H Remediation (2026-07-25) — Every missing
  // accounting-critical field emits its own finding so the AP review
  // card's issue count reflects reality. Previously the card could say
  // "0 issues" even when the invoice number + total were missing.
  if (invoice.state === "DOCUMENT_UNREADABLE") {
    findings.push({
      key: "ap.invoice.unreadable",
      severity: "HIGH",
      statement: "Invoice PDF could not be parsed. Manual review required.",
      ruleKey: "validate.unreadable",
      ruleVersion: RULE_VERSION,
    });
  }
  if (invoice.invoiceNumber === null && invoice.state !== "DOCUMENT_UNREADABLE") {
    findings.push({
      key: "ap.invoice.missing_invoice_number",
      severity: "HIGH",
      statement: "Invoice number was not extracted from the invoice — cannot reconcile to AP subledger without it.",
      ruleKey: "validate.missing_invoice_number",
      ruleVersion: RULE_VERSION,
    });
  }
  if (invoice.total === null && invoice.state !== "DOCUMENT_UNREADABLE") {
    findings.push({
      key: "ap.invoice.missing_total",
      severity: "HIGH",
      statement: "Invoice total was not extracted — cannot post an amount without a total.",
      ruleKey: "validate.missing_total",
      ruleVersion: RULE_VERSION,
    });
  }
  if (invoice.invoiceDate === null && invoice.state !== "DOCUMENT_UNREADABLE") {
    findings.push({
      key: "ap.invoice.missing_invoice_date",
      severity: "MEDIUM",
      statement: "Invoice date was not extracted — cannot apply payment terms without it.",
      ruleKey: "validate.missing_invoice_date",
      ruleVersion: RULE_VERSION,
    });
  }
  if (invoice.vendor.guessedName === null && invoice.vendor.guessedTaxNumber === null && invoice.state !== "DOCUMENT_UNREADABLE") {
    findings.push({
      key: "ap.invoice.missing_vendor_identity",
      severity: "HIGH",
      statement: "No vendor identity could be extracted from the PDF (name and tax number both absent). Reviewer must resolve manually.",
      ruleKey: "validate.missing_vendor_identity",
      ruleVersion: RULE_VERSION,
    });
  }

  // Non-critical missing fields — retained at lower severity.
  if (invoice.subtotal === null && invoice.state !== "DOCUMENT_UNREADABLE") {
    findings.push({
      key: "ap.invoice.missing_subtotal",
      severity: "LOW",
      statement: "Subtotal was not extracted from the invoice.",
      ruleKey: "validate.missing_subtotal",
      ruleVersion: RULE_VERSION,
    });
  }
  if (invoice.taxTotal === null && invoice.state !== "DOCUMENT_UNREADABLE") {
    findings.push({
      key: "ap.invoice.missing_tax",
      severity: "INFO",
      statement: "Tax total was not extracted from the invoice.",
      ruleKey: "validate.missing_tax",
      ruleVersion: RULE_VERSION,
    });
  }

  // Negative-total guard
  const total = invoice.total ? toMoney(invoice.total) : null;
  const subtotal = invoice.subtotal ? toMoney(invoice.subtotal) : null;
  const tax = invoice.taxTotal ? toMoney(invoice.taxTotal) : null;

  if (total !== null && total.isNegative()) {
    findings.push({
      key: "ap.invoice.negative_total",
      severity: "HIGH",
      statement: `Invoice total is negative (${total.toFixed(2)}). This is not an invoice — treat as a credit note.`,
      ruleKey: "validate.negative_total",
      ruleVersion: RULE_VERSION,
    });
  }
  if (subtotal !== null && subtotal.isNegative()) {
    findings.push({
      key: "ap.invoice.negative_subtotal",
      severity: "MEDIUM",
      statement: `Subtotal is negative (${subtotal.toFixed(2)}).`,
      ruleKey: "validate.negative_subtotal",
      ruleVersion: RULE_VERSION,
    });
  }

  // Arithmetic: subtotal + tax = total (within 1 cent tolerance for
  // the sub-cent rounding some vendors' PDFs suffer from).
  if (total !== null && subtotal !== null && tax !== null) {
    const computed = subtotal.plus(tax);
    const diff = total.minus(computed).abs();
    if (diff.gt(toMoney("0.02"))) {
      findings.push({
        key: "ap.invoice.total_mismatch",
        severity: "HIGH",
        statement: `Subtotal (${subtotal.toFixed(2)}) + tax (${tax.toFixed(2)}) = ${computed.toFixed(2)}, but the extracted invoice total is ${total.toFixed(2)}. Difference ${diff.toFixed(2)}.`,
        ruleKey: "validate.total_mismatch",
        ruleVersion: RULE_VERSION,
      });
    }
  }

  // Line-item sum vs subtotal
  if (invoice.lineItems.length > 0 && subtotal !== null) {
    const linesSum = sumMoney(invoice.lineItems.map((l) => l.amount));
    const diff = subtotal.minus(linesSum).abs();
    if (diff.gt(toMoney("0.02"))) {
      findings.push({
        key: "ap.invoice.line_sum_mismatch",
        severity: "MEDIUM",
        statement: `Sum of line items (${linesSum.toFixed(2)}) does not equal the extracted subtotal (${subtotal.toFixed(2)}). Difference ${diff.toFixed(2)}.`,
        ruleKey: "validate.line_sum_mismatch",
        ruleVersion: RULE_VERSION,
      });
    }
  }

  // Duplicate line totals
  if (invoice.lineItems.length > 1) {
    const seen = new Map<string, number>();
    for (const l of invoice.lineItems) {
      const key = `${l.amount}::${l.description.toLowerCase()}`;
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
    const duplicates = [...seen.entries()].filter(([, n]) => n > 1).length;
    if (duplicates > 0) {
      findings.push({
        key: "ap.invoice.duplicate_line_items",
        severity: "LOW",
        statement: `${duplicates} duplicate line-item(s) detected (same description + amount).`,
        ruleKey: "validate.duplicate_lines",
        ruleVersion: RULE_VERSION,
      });
    }
  }

  // Currency-mismatch check runs downstream (needs vendor default);
  // parsed currency alone flagged only when explicitly non-CAD.
  if (invoice.currency && invoice.currency !== "CAD") {
    findings.push({
      key: "ap.invoice.currency_non_cad",
      severity: "INFO",
      statement: `Extracted invoice currency is ${invoice.currency}, not CAD. Confirm exchange handling before posting.`,
      ruleKey: "validate.currency_non_cad",
      ruleVersion: RULE_VERSION,
    });
  }

  return findings;
}
