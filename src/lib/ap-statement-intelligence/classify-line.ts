// Sprint 3 Checkpoint 15G (2026-07-24) — Deterministic per-line
// transaction classification.
//
// Rules only; first match wins. Description keywords are the primary
// signal, then reference-number patterns, then debit/credit direction.

import type { StatementTransactionKind } from "./types";

export interface ClassifyLineArgs {
  description: string | null;
  referenceNumber: string | null;
  debitAmount: string | null;
  creditAmount: string | null;
}

const KEYWORD_TO_KIND: Array<{ kind: StatementTransactionKind; patterns: RegExp[] }> = [
  { kind: "OPENING_BALANCE", patterns: [/\bopening balance\b/i, /\bbalance forward\b/i, /\bprevious balance\b/i, /\bbeginning balance\b/i] },
  { kind: "BALANCE_FORWARD", patterns: [/\bcarry forward\b/i, /\bcarry-forward\b/i] },
  { kind: "PAYMENT", patterns: [/\bpayment\b/i, /\bpymt\b/i, /\bcheque\b/i, /\bcheck\b/i, /\beft\b/i, /\bwire\b/i, /\bach\b/i, /\brec'?d\b/i, /\breceived\b/i] },
  { kind: "CREDIT_NOTE", patterns: [/\bcredit note\b/i, /\bcredit memo\b/i, /\bcreditmemo\b/i, /\breturn\b/i, /\brefund\b/i, /\bcredit adjustment\b/i] },
  { kind: "FINANCE_CHARGE", patterns: [/\bfinance charge\b/i, /\binterest\b/i, /\blate fee\b/i, /\boverdue fee\b/i] },
  { kind: "ADJUSTMENT", patterns: [/\badjustment\b/i, /\bwrite[- ]off\b/i, /\bcorrection\b/i] },
  { kind: "INVOICE", patterns: [/\binvoice\b/i, /\binv\b/i, /\bbill\b/i, /\bpurchase\b/i, /\bservice\b/i, /\bproduct\b/i] },
];

const REF_TO_KIND: Array<{ kind: StatementTransactionKind; patterns: RegExp[] }> = [
  { kind: "INVOICE", patterns: [/^INV[-#]?/i, /^INVOICE/i, /^APINV/i, /^BILL/i] },
  { kind: "CREDIT_NOTE", patterns: [/^CN[-#]?/i, /^CM[-#]?/i, /^CR[-#]?/i, /^CREDIT/i, /^RMA/i] },
  { kind: "PAYMENT", patterns: [/^PMT/i, /^PAY[-#]?/i, /^CHQ/i, /^EFT/i, /^ACH/i, /^WIRE/i, /^CHECK[-#]?/i] },
];

export function classifyStatementLine(args: ClassifyLineArgs): StatementTransactionKind {
  const desc = args.description ?? "";
  const ref = args.referenceNumber ?? "";

  for (const rule of KEYWORD_TO_KIND) {
    for (const p of rule.patterns) {
      if (p.test(desc)) return rule.kind;
    }
  }
  for (const rule of REF_TO_KIND) {
    for (const p of rule.patterns) {
      if (p.test(ref)) return rule.kind;
    }
  }
  // Fall back on direction: credit-only line usually a payment / credit;
  // debit-only line usually an invoice / charge.
  const hasDebit = !!args.debitAmount && Number(args.debitAmount) !== 0;
  const hasCredit = !!args.creditAmount && Number(args.creditAmount) !== 0;
  if (hasCredit && !hasDebit) return "PAYMENT"; // could be CREDIT_NOTE — reviewer decides
  if (hasDebit && !hasCredit) return "INVOICE";
  return "UNKNOWN";
}
