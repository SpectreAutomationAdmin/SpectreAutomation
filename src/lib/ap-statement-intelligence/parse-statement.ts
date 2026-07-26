// Sprint 3 Checkpoint 15G (2026-07-24) — Deterministic statement
// parser. Given pdf-parse text, extract header (vendor, period, opening
// / closing balance) + a list of ExtractedStatementLines.
//
// Approach: line-by-line scan. A statement line matches the pattern:
//   <date>  <reference>  <description>  <debit?>  <credit?>  <balance>
// with tolerances for column alignment and label variants.
//
// Rules only. No LLM. Every match records the rule key that produced
// it so a reviewer sees exactly why a line was parsed a given way.

import type {
  ExtractedStatement,
  ExtractedStatementLine,
  StatementExtractionState,
  StatementTransactionKind,
} from "./types";
import { STATEMENT_RULE_VERSION } from "./types";
import { classifyStatementLine } from "./classify-line";

const MONEY = /(-?\$?\s*\(?\s*[0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{2})\)?|-?\(?[0-9]+\.[0-9]{2}\)?)/;
const DATE_ISO = /(\d{4}-\d{2}-\d{2})/;
const DATE_NUMERIC = /(\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4})/;
const DATE_MONTH_NAME = /((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2},?\s+\d{4})/i;

function toNumericString(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const clean = raw.replace(/[,$\s]/g, "");
  // "(123.45)" → "-123.45" (parenthesised negatives).
  const paren = clean.match(/^\(([0-9.]+)\)$/);
  if (paren) return `-${paren[1]}`;
  return clean;
}

function normaliseDateToIso(raw: string | null): string | null {
  if (!raw) return null;
  const s = raw.trim();
  const iso = s.match(DATE_ISO);
  if (iso) return iso[1];
  const num = s.match(DATE_NUMERIC);
  if (num) {
    const parts = num[1].split(/[\/-]/).map((p) => parseInt(p, 10));
    let a = parts[0], b = parts[1], y = parts[2];
    if (y < 100) y += 2000;
    let month: number, day: number;
    if (a > 12 && b <= 12) { day = a; month = b; }
    else { month = a; day = b; }
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    return `${y.toString().padStart(4, "0")}-${month.toString().padStart(2, "0")}-${day.toString().padStart(2, "0")}`;
  }
  const name = s.match(DATE_MONTH_NAME);
  if (name) {
    const [, monPart, dayPart, yearPart] = name[1].match(/([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})/) ?? [];
    if (monPart && dayPart && yearPart) {
      const monMap: Record<string, number> = { jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12 };
      const m = monMap[monPart.toLowerCase().slice(0, 3)] ?? 0;
      if (m > 0) {
        return `${yearPart}-${m.toString().padStart(2, "0")}-${dayPart.padStart(2, "0")}`;
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Header extraction
// ---------------------------------------------------------------------------
function extractHeaderField(text: string, labels: string[]): { value: string; ruleKey: string } | null {
  const labelAlt = labels.map((l) => l.replace(/\s+/g, "\\s+")).join("|");
  const re = new RegExp(`\\b(?:${labelAlt})\\b[^\\n\\r]{0,30}?${MONEY.source}`, "i");
  const m = text.match(re);
  if (m) return { value: m[1], ruleKey: `header.${labels[0].replace(/\s+/g, "_").toLowerCase()}` };
  return null;
}

function extractHeaderDate(text: string, labels: string[]): { value: string; ruleKey: string } | null {
  const labelAlt = labels.map((l) => l.replace(/\s+/g, "\\s+")).join("|");
  for (const dp of [DATE_ISO, DATE_NUMERIC, DATE_MONTH_NAME]) {
    const re = new RegExp(`\\b(?:${labelAlt})\\b[^\\n\\r]{0,30}?${dp.source}`, "i");
    const m = text.match(re);
    if (m) {
      const iso = normaliseDateToIso(m[1]);
      if (iso) return { value: iso, ruleKey: `header.${labels[0].replace(/\s+/g, "_").toLowerCase()}` };
    }
  }
  return null;
}

function extractVendorNameGuess(text: string): string | null {
  const lines = text.split(/\r?\n/).slice(0, 25).map((l) => l.trim()).filter(Boolean);
  const skipPrefix = /^(statement|invoice|customer|account|remit|page|from:|to:|attn|attention|period|as of|billing|address)/i;
  for (const line of lines) {
    if (skipPrefix.test(line)) continue;
    if (line.length < 4 || line.length > 80) continue;
    if (!/[A-Za-z]/.test(line)) continue;
    if (/@/.test(line)) continue;
    if (/\bstatement\b/i.test(line)) continue;
    return line;
  }
  return null;
}

function extractAccountNumber(text: string): string | null {
  const labels = ["Account Number", "Customer Number", "Account No", "Customer No", "Client Number", "Client No"];
  const labelAlt = labels.map((l) => l.replace(/\s+/g, "\\s+")).join("|");
  const re = new RegExp(`\\b(?:${labelAlt})\\b\\s*[:#-]?\\s*([A-Za-z0-9][A-Za-z0-9\\-\\/]{1,40})`, "i");
  const m = text.match(re);
  return m ? m[1].trim() : null;
}

function extractCurrency(text: string): string | null {
  const explicit = text.match(/\b(USD|CAD|EUR|GBP)\b/);
  if (explicit) return explicit[1].toUpperCase();
  if (/CA\$/i.test(text)) return "CAD";
  if (/US\$/i.test(text)) return "USD";
  if (/\$/.test(text)) return "CAD";
  // Default to CAD when the statement clearly has decimal money but no
  // explicit currency marker (Canadian club default).
  if (/[0-9]+\.[0-9]{2}/.test(text)) return "CAD";
  return null;
}

// ---------------------------------------------------------------------------
// Line extraction — pattern-based
// ---------------------------------------------------------------------------
interface LineParseCandidate {
  transactionDate: string | null;
  referenceNumber: string | null;
  description: string | null;
  debitAmount: string | null;
  creditAmount: string | null;
  runningBalance: string | null;
  ruleKey: string;
  matchedTextSnippet: string;
}

// Six-column layout: date | ref | description | debit | credit | balance
// Numbers are trailing; date is leading.
const FULL_LINE_REGEX = new RegExp(
  `^\\s*` +
    `(?<date>(?:${DATE_ISO.source}|${DATE_NUMERIC.source}|${DATE_MONTH_NAME.source}))\\s+` +
    `(?<ref>[A-Za-z0-9][A-Za-z0-9\\-\\/#]{1,30})\\s+` +
    `(?<desc>.{3,80}?)\\s+` +
    `(?<debit>${MONEY.source})\\s+` +
    `(?<credit>${MONEY.source})\\s+` +
    `(?<balance>${MONEY.source})\\s*$`,
);
// Simpler layout: date | ref | description | amount | balance
const SIMPLE_LINE_REGEX = new RegExp(
  `^\\s*` +
    `(?<date>(?:${DATE_ISO.source}|${DATE_NUMERIC.source}|${DATE_MONTH_NAME.source}))\\s+` +
    `(?<ref>[A-Za-z0-9][A-Za-z0-9\\-\\/#]{1,30})\\s+` +
    `(?<desc>.{3,80}?)\\s+` +
    `(?<amount>${MONEY.source})\\s+` +
    `(?<balance>${MONEY.source})\\s*$`,
);
// Sparse layout: date | ref | description | (empty) | (empty) | balance
// (typical for opening-balance / balance-forward lines).
const SPARSE_BALANCE_REGEX = new RegExp(
  `^\\s*` +
    `(?<date>(?:${DATE_ISO.source}|${DATE_NUMERIC.source}|${DATE_MONTH_NAME.source}))\\s+` +
    `(?<ref>[A-Za-z0-9][A-Za-z0-9\\-\\/#]{1,30})\\s+` +
    `(?<desc>.{3,80}?)\\s+` +
    `(?<balance>${MONEY.source})\\s*$`,
);

function parseSingleLine(raw: string): LineParseCandidate | null {
  const full = raw.match(FULL_LINE_REGEX);
  if (full && full.groups) {
    const g = full.groups;
    const debit = toNumericString(g.debit);
    const credit = toNumericString(g.credit);
    return {
      transactionDate: normaliseDateToIso(g.date),
      referenceNumber: (g.ref ?? "").trim(),
      description: (g.desc ?? "").trim(),
      debitAmount: (debit && Number(debit) !== 0) ? debit : null,
      creditAmount: (credit && Number(credit) !== 0) ? credit : null,
      runningBalance: toNumericString(g.balance),
      ruleKey: "line.six_column",
      matchedTextSnippet: raw.slice(0, 120),
    };
  }
  const simple = raw.match(SIMPLE_LINE_REGEX);
  if (simple && simple.groups) {
    const g = simple.groups;
    const amount = toNumericString(g.amount);
    const num = Number(amount ?? "0");
    return {
      transactionDate: normaliseDateToIso(g.date),
      referenceNumber: (g.ref ?? "").trim(),
      description: (g.desc ?? "").trim(),
      debitAmount: num > 0 ? amount : null,
      creditAmount: num < 0 ? String(Math.abs(num)) : null,
      runningBalance: toNumericString(g.balance),
      ruleKey: "line.five_column",
      matchedTextSnippet: raw.slice(0, 120),
    };
  }
  const sparse = raw.match(SPARSE_BALANCE_REGEX);
  if (sparse && sparse.groups) {
    const g = sparse.groups;
    return {
      transactionDate: normaliseDateToIso(g.date),
      referenceNumber: (g.ref ?? "").trim(),
      description: (g.desc ?? "").trim(),
      debitAmount: null,
      creditAmount: null,
      runningBalance: toNumericString(g.balance),
      ruleKey: "line.sparse_balance_only",
      matchedTextSnippet: raw.slice(0, 120),
    };
  }
  return null;
}

const SKIP_LINE_PATTERNS = [
  /^\s*page\s+\d+/i,
  /^\s*total\s+due/i,
  /^\s*statement\s+of\s+account/i,
  /^\s*(date|ref|reference|description|debit|credit|balance|amount)\s+/i,
  /^\s*---/,
  /^\s*={3,}/,
];

function shouldSkipLine(raw: string): boolean {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return true;
  return SKIP_LINE_PATTERNS.some((p) => p.test(trimmed));
}

// ---------------------------------------------------------------------------
// Public entrypoint
// ---------------------------------------------------------------------------
export interface ParseStatementArgs {
  extractedText: string;
}

export function parseStatementText(args: ParseStatementArgs): ExtractedStatement {
  const text = args.extractedText ?? "";
  const warnings: string[] = [];
  const lines: ExtractedStatementLine[] = [];

  if (text.trim().length === 0) {
    return {
      state: "DOCUMENT_UNREADABLE",
      ruleVersion: STATEMENT_RULE_VERSION,
      extractedTextChars: 0,
      header: emptyHeader(),
      lines: [],
      warnings: ["No text extracted from PDF."],
    };
  }

  // Header
  const statementDate = extractHeaderDate(text, ["Statement Date", "Statement of Account", "Date"]);
  const periodStart = extractHeaderDate(text, ["Period Start", "From", "Beginning"]);
  const periodEnd = extractHeaderDate(text, ["Period End", "To", "Ending"]);
  const openingBalance = extractHeaderField(text, ["Opening Balance", "Previous Balance", "Balance Forward", "Beginning Balance"]);
  const closingBalance = extractHeaderField(text, ["Closing Balance", "Ending Balance", "New Balance", "Amount Due"]);
  const amountDue = extractHeaderField(text, ["Amount Due", "Total Due", "Balance Due"]);

  const header: ExtractedStatement["header"] = {
    vendorNameGuess: extractVendorNameGuess(text),
    vendorAccountNumber: extractAccountNumber(text),
    statementDate: statementDate?.value ?? null,
    periodStart: periodStart?.value ?? null,
    periodEnd: periodEnd?.value ?? null,
    openingBalance: toNumericString(openingBalance?.value ?? null),
    closingBalance: toNumericString(closingBalance?.value ?? null),
    amountDue: toNumericString(amountDue?.value ?? null),
    currency: extractCurrency(text),
  };

  // Lines
  const rawLines = text.split(/\r?\n/);
  let sequence = 0;
  for (const raw of rawLines) {
    if (shouldSkipLine(raw)) continue;
    const cand = parseSingleLine(raw);
    if (!cand) continue;
    sequence += 1;
    const kind = classifyStatementLine({
      description: cand.description,
      referenceNumber: cand.referenceNumber,
      debitAmount: cand.debitAmount,
      creditAmount: cand.creditAmount,
    });
    // For 5-column (SIMPLE) parses we assigned amount → debit by
    // default; if the classifier decides the line is a PAYMENT or
    // CREDIT_NOTE, flip the amount to credit so arithmetic is right.
    let debit = cand.debitAmount;
    let credit = cand.creditAmount;
    if ((kind === "PAYMENT" || kind === "CREDIT_NOTE") && debit && !credit) {
      credit = debit;
      debit = null;
    }
    lines.push({
      sequence,
      transactionDate: cand.transactionDate,
      referenceNumber: cand.referenceNumber,
      description: cand.description,
      transactionKind: kind,
      debitAmount: debit,
      creditAmount: credit,
      runningBalance: cand.runningBalance,
      evidence: { ruleKey: cand.ruleKey, matchedTextSnippet: cand.matchedTextSnippet },
    });
    if (lines.length >= 500) {
      warnings.push("Bounded to 500 statement lines per extraction.");
      break;
    }
  }

  // Determine extraction state.
  let state: StatementExtractionState = "STRUCTURED";
  if (lines.length === 0 && header.openingBalance === null && header.closingBalance === null) {
    state = "UNSUPPORTED_LAYOUT";
    warnings.push("No lines and no header balances extracted — layout may be unsupported.");
  } else if (lines.length === 0) {
    state = "INSUFFICIENT_EVIDENCE";
    warnings.push("Header balances extracted but no transaction lines matched.");
  } else if (header.closingBalance === null || header.openingBalance === null) {
    state = "PARTIALLY_STRUCTURED";
    warnings.push("Header balances incomplete.");
  }

  return {
    state,
    ruleVersion: STATEMENT_RULE_VERSION,
    extractedTextChars: text.length,
    header,
    lines,
    warnings,
  };
}

function emptyHeader(): ExtractedStatement["header"] {
  return {
    vendorNameGuess: null, vendorAccountNumber: null, statementDate: null,
    periodStart: null, periodEnd: null, openingBalance: null, closingBalance: null,
    amountDue: null, currency: null,
  };
}
