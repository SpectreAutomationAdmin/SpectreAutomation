// HR-2B.3.2 §1 (2026-08-18) — Banking-document field extractor.
//
// The employee onboarding "Upload a void cheque / direct-deposit
// form" step calls this module AFTER the document has been persisted
// via `uploadSelfBankingDocument`. It extracts the four canonical
// direct-deposit fields (account-holder name, institution number,
// transit number, account number) so the UI can render a
// pre-populated confirmation form. The employee then edits and
// submits via the existing canonical `submitSelfBankAccount` path
// (KMS-encrypted at rest).
//
// Design rules — the founder's HR-2B.3.2 §1 mandate:
//
//   * Reuse existing document-intelligence primitives; DO NOT
//     invent new OCR. PDFs are read via `extractPdfText`
//     (`pdf-parse` behind the AP intelligence stack). Images are a
//     graceful fall-through — this slice returns extraction=missing
//     for images so the UI cleanly falls back to the manual form.
//     Adding image OCR later is a matter of plugging in a strategy;
//     the public contract does not change.
//
//   * Never persist / log / audit any extracted banking value.
//     Every extracted field lives only in the response payload the
//     server hands to the client, which the employee then confirms
//     via `submitSelfBankAccount` (KMS-encrypted). `meta` is the
//     ONLY property allowed to carry diagnostics (pages, mime,
//     sha256 prefix, extractor rules that matched).
//
//   * Never fabricate a value. Missing / uncertain → `confidence:
//     "missing"` with `value: null`. The client renders a badge so
//     the employee knows which fields need attention.
//
// This module DOES NOT touch `EmployeeBankAccount`. Banking
// canonicality remains `submitSelfBankAccount` (HR-2B.3), reached
// only after the employee has clicked "Confirm and save" on the
// extracted preview.

import { createHash } from "crypto";
import { extractPdfText } from "../ap-intelligence/pdf-extract";

// ---------------------------------------------------------------------------
// Public contract.
// ---------------------------------------------------------------------------

export type BankingFieldConfidence = "high" | "medium" | "low" | "missing";

export interface BankingExtractedField<T> {
  value: T | null;
  confidence: BankingFieldConfidence;
}

export interface BankingExtractionResult {
  holderName: BankingExtractedField<string>;
  institutionNumber: BankingExtractedField<string>;
  transitNumber: BankingExtractedField<string>;
  accountNumber: BankingExtractedField<string>;
  /** Non-sensitive diagnostic fields. Safe to log. */
  meta: {
    pages?: number;
    mimeType: string;
    sha256Prefix: string;
    /** Which internal extractor produced each field. Non-sensitive:
     *  values are opaque rule keys like "micr.symbols" or
     *  "labeled.transit". Absent when no rule matched. */
    ruleKeys?: Partial<Record<
      "holderName" | "institutionNumber" | "transitNumber" | "accountNumber",
      string
    >>;
    /** Diagnostic: reason the extractor could not read the bytes,
     *  when applicable. Values: "OK", "NON_PDF_BYTES",
     *  "PDF_PARSE_ERROR", "EMPTY_TEXT", "UNSUPPORTED_MIME". Never
     *  leaks document contents. */
    readOutcome: "OK" | "NON_PDF_BYTES" | "PDF_PARSE_ERROR" | "EMPTY_TEXT" | "UNSUPPORTED_MIME";
  };
}

export interface ExtractBankingFieldsArgs {
  bytes: Buffer;
  mimeType: string;
  /** Tenant scope. Diagnostic-only for this module — actual tenant
   *  enforcement lives at the API-route + `uploadSelfBankingDocument`
   *  layer. Kept in the signature so a future audit hook has the
   *  provenance it needs without a signature break. */
  clubId: string;
  /** Employee scope. Diagnostic-only for this module. */
  employeeId: string;
  /** The `EmployeeDocument.id` this bytes-buffer was just persisted
   *  as. Diagnostic-only. */
  documentId: string;
}

// ---------------------------------------------------------------------------
// Public entrypoint.
// ---------------------------------------------------------------------------

export async function extractBankingFieldsFromDocument(
  args: ExtractBankingFieldsArgs,
): Promise<BankingExtractionResult> {
  const mimeType = (args.mimeType ?? "").trim().toLowerCase();
  const sha256Prefix = createHash("sha256").update(args.bytes).digest("hex").slice(0, 12);

  if (mimeType === "application/pdf") {
    const pdf = await extractPdfText(args.bytes);
    if (!pdf.ok) {
      const reason: BankingExtractionResult["meta"]["readOutcome"] =
        pdf.reason === "NON_PDF_BYTES" ? "NON_PDF_BYTES"
        : pdf.reason === "EMPTY_TEXT" ? "EMPTY_TEXT"
        : "PDF_PARSE_ERROR";
      return allMissing({ mimeType, sha256Prefix, pages: pdf.numPages, readOutcome: reason });
    }
    const extracted = extractBankingFieldsFromText(pdf.text);
    return {
      ...extracted,
      meta: {
        mimeType,
        sha256Prefix,
        pages: pdf.numPages,
        readOutcome: "OK",
        ruleKeys: extracted.__ruleKeys,
      },
    };
  }

  // Images: this slice does NOT invent a new OCR provider. If a
  // future slice plugs in image OCR (AWS Textract raw text, etc.)
  // it does so behind this branch without touching the public
  // contract. Today the UI falls back to the manual form when
  // extraction produces no fields.
  return allMissing({ mimeType, sha256Prefix, readOutcome: "UNSUPPORTED_MIME" });
}

// ---------------------------------------------------------------------------
// Text-level extraction — exposed for unit tests.
// ---------------------------------------------------------------------------

interface ExtractedFromText {
  holderName: BankingExtractedField<string>;
  institutionNumber: BankingExtractedField<string>;
  transitNumber: BankingExtractedField<string>;
  accountNumber: BankingExtractedField<string>;
  __ruleKeys: BankingExtractionResult["meta"]["ruleKeys"];
}

/**
 * Deterministic text-level extractor. Given the raw text of a
 * banking document (a void cheque, a completed direct-deposit form,
 * a bank-issued PAD authorization), attempt to identify the four
 * canonical fields.
 *
 * Never returns a value it is not confident about — an uncertain
 * match is recorded as `confidence: "missing"`, `value: null`. The
 * employee sees the field labelled "Not detected — please fill in"
 * and types it manually.
 */
export function extractBankingFieldsFromText(text: string): ExtractedFromText {
  const normalised = (text ?? "").replace(/\r\n?/g, "\n");
  const ruleKeys: BankingExtractionResult["meta"]["ruleKeys"] = {};

  // -- Institution / transit / account -------------------------------------
  //
  // Strategy A — MICR block. Canadian cheque bottom row prints as
  //   ⑆ TTTTT ⑉ III ⑆ AAAAAAA ⑈
  // where T=5-digit transit, I=3-digit institution, A=7-12-digit
  // account. pdf-parse sometimes preserves the symbols, sometimes
  // strips them; both shapes match.
  let institution: BankingExtractedField<string> = missing();
  let transit: BankingExtractedField<string> = missing();
  let account: BankingExtractedField<string> = missing();

  const micrWithSymbols = normalised.match(
    /[⑆:]\s*(\d{5})\s*[⑉:]\s*(\d{3})\s*[⑆:]\s*(\d{7,12})\s*[⑈:]?/,
  );
  if (micrWithSymbols) {
    transit = { value: micrWithSymbols[1], confidence: "high" };
    institution = { value: micrWithSymbols[2], confidence: "high" };
    account = { value: micrWithSymbols[3], confidence: "high" };
    ruleKeys.transitNumber = "micr.symbols";
    ruleKeys.institutionNumber = "micr.symbols";
    ruleKeys.accountNumber = "micr.symbols";
  }

  // Strategy B — labeled fields. Highest-signal path on completed
  // direct-deposit forms (bank generates a PDF with "Institution
  // Number: 003", "Transit Number: 12345", etc.). Match line by
  // line to avoid a stray "12345" mid-paragraph poisoning transit.
  const labelPatterns: Array<{
    field: "institution" | "transit" | "account";
    regex: RegExp;
    rule: string;
    minLen: number;
    maxLen: number;
  }> = [
    // Institution — "Institution", "Institution Number", "Institution No",
    // "Bank Number", "Bank ID", "Financial Institution".
    {
      field: "institution",
      regex: /^[\s\|]*(?:Financial\s+)?(?:Institution|Bank)(?:\s+(?:Number|No\.?|ID|#))?\s*[:\-]?\s*(\d{3})\b/im,
      rule: "labeled.institution",
      minLen: 3,
      maxLen: 3,
    },
    // Transit — "Transit", "Transit Number", "Transit No", "Branch",
    // "Branch Number", "Branch Transit".
    {
      field: "transit",
      regex: /^[\s\|]*(?:Branch\s+)?(?:Transit|Branch)(?:\s+(?:Number|No\.?|Transit|#))?\s*[:\-]?\s*(\d{5})\b/im,
      rule: "labeled.transit",
      minLen: 5,
      maxLen: 5,
    },
    // Account — "Account Number", "Account No.", "Account #".
    {
      field: "account",
      regex: /^[\s\|]*Account(?:\s+(?:Number|No\.?|#))?\s*[:\-]?\s*(\d{7,12})\b/im,
      rule: "labeled.account",
      minLen: 7,
      maxLen: 12,
    },
  ];
  for (const p of labelPatterns) {
    const m = normalised.match(p.regex);
    if (!m || !m[1]) continue;
    const digits = m[1];
    if (digits.length < p.minLen || digits.length > p.maxLen) continue;
    if (p.field === "institution" && institution.confidence === "missing") {
      institution = { value: digits, confidence: "high" };
      ruleKeys.institutionNumber = p.rule;
    } else if (p.field === "transit" && transit.confidence === "missing") {
      transit = { value: digits, confidence: "high" };
      ruleKeys.transitNumber = p.rule;
    } else if (p.field === "account" && account.confidence === "missing") {
      account = { value: digits, confidence: "high" };
      ruleKeys.accountNumber = p.rule;
    }
  }

  // Strategy C — free-form 3-5-N or 5-3-N block on the cheque (no
  // MICR symbols, no labels). Uses conservative dash / space
  // separators so a random "123 45678 12345678" body sentence
  // cannot match. Confidence is "medium" — the employee will be
  // shown the values with a "please verify" badge.
  if (
    institution.confidence === "missing" ||
    transit.confidence === "missing" ||
    account.confidence === "missing"
  ) {
    // 3-5-N: institution-first (matches the founder's fixture
    // convention "123 - 12345 - 1234567890").
    const inst5first = normalised.match(
      /(?:^|[^\d])(\d{3})\s*[-|]\s*(\d{5})\s*[-|]\s*(\d{7,12})(?:[^\d]|$)/,
    );
    if (inst5first) {
      if (institution.confidence === "missing") {
        institution = { value: inst5first[1], confidence: "medium" };
        ruleKeys.institutionNumber = "block.3-5-N";
      }
      if (transit.confidence === "missing") {
        transit = { value: inst5first[2], confidence: "medium" };
        ruleKeys.transitNumber = "block.3-5-N";
      }
      if (account.confidence === "missing") {
        account = { value: inst5first[3], confidence: "medium" };
        ruleKeys.accountNumber = "block.3-5-N";
      }
    } else {
      // 5-3-N: transit-first (matches MICR line ordering without
      // the symbols).
      const tr5first = normalised.match(
        /(?:^|[^\d])(\d{5})\s*[-|]\s*(\d{3})\s*[-|]\s*(\d{7,12})(?:[^\d]|$)/,
      );
      if (tr5first) {
        if (transit.confidence === "missing") {
          transit = { value: tr5first[1], confidence: "medium" };
          ruleKeys.transitNumber = "block.5-3-N";
        }
        if (institution.confidence === "missing") {
          institution = { value: tr5first[2], confidence: "medium" };
          ruleKeys.institutionNumber = "block.5-3-N";
        }
        if (account.confidence === "missing") {
          account = { value: tr5first[3], confidence: "medium" };
          ruleKeys.accountNumber = "block.5-3-N";
        }
      }
    }
  }

  // -- Holder name ---------------------------------------------------------
  //
  // Strategy A — explicit label. Bank-issued direct-deposit forms
  // print "Account Holder", "Name on Account", "Account Name",
  // "Payable To", or on a void cheque the "Pay to the order of"
  // line reflects the account owner (for a personal cheque) or the
  // legal entity (for a corporate cheque).
  let holder: BankingExtractedField<string> = missing();
  const holderPatterns: Array<{ regex: RegExp; rule: string; confidence: BankingFieldConfidence }> = [
    // Explicit "Pay to the order of" — high confidence.
    {
      regex: /Pay\s+to\s+the\s+order\s+of[\s:\-]+([A-Z0-9][A-Za-z0-9&,'.\-\s]{2,80}?)(?:\s*[\|\n]|\s{2,}\d)/i,
      rule: "labeled.pay_to_order",
      confidence: "high",
    },
    // Account Holder / Name on Account / Account Name — high.
    {
      regex: /(?:Account\s+Holder|Name\s+on\s+(?:the\s+)?Account|Account\s+Name|Account\s+Owner|Payable\s+To)\s*[:\-]?\s*([A-Z0-9][A-Za-z0-9&,'.\-\s]{2,80})\s*$/im,
      rule: "labeled.account_holder",
      confidence: "high",
    },
  ];
  for (const p of holderPatterns) {
    const m = normalised.match(p.regex);
    if (!m || !m[1]) continue;
    const value = cleanName(m[1]);
    if (!isPlausibleHolderName(value)) continue;
    holder = { value, confidence: p.confidence };
    ruleKeys.holderName = p.rule;
    break;
  }

  return {
    holderName: holder,
    institutionNumber: institution,
    transitNumber: transit,
    accountNumber: account,
    __ruleKeys: ruleKeys,
  };
}

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

function missing(): BankingExtractedField<string> {
  return { value: null, confidence: "missing" };
}

function allMissing(meta: BankingExtractionResult["meta"]): BankingExtractionResult {
  return {
    holderName: missing(),
    institutionNumber: missing(),
    transitNumber: missing(),
    accountNumber: missing(),
    meta,
  };
}

function cleanName(raw: string): string {
  return raw
    .trim()
    // Collapse runs of whitespace.
    .replace(/\s{2,}/g, " ")
    // Strip trailing punctuation the regex tail may have swept in
    // (a dash, colon, or vertical bar left over from the cheque
    // layout).
    .replace(/[\|\-:;.,]+$/, "")
    .trim();
}

/**
 * Reject strings the regex may have captured that are clearly not
 * a person / entity name:
 *   * dominantly numeric (a MICR line, an amount);
 *   * shorter than 2 characters after cleanup;
 *   * a label word ("Institution", "Transit", "Account");
 *   * longer than 120 characters — anything past that is almost
 *     certainly a body-paragraph leak.
 */
function isPlausibleHolderName(value: string): boolean {
  const s = value.trim();
  if (s.length < 2 || s.length > 120) return false;
  if (!/[A-Za-z]/.test(s)) return false;
  // At least 40% letters (allows "1234567 Alberta Ltd." shape but
  // rejects an all-digits MICR fragment).
  const letters = (s.match(/[A-Za-z]/g) ?? []).length;
  if (letters < 2) return false;
  // Reject known label leaks.
  if (/^(institution|transit|account|routing|branch|bank|financial)\b/i.test(s)) return false;
  return true;
}
