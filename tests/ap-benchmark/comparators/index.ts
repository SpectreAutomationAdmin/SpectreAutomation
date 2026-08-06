// AP Benchmark — comparators. One function per ground-truth
// dimension. Each returns a `ComparatorResult` the runner records.
//
// Never uses founder-specific literals in production paths. All
// literals live inside the corpus JSON files and are received here
// via the `ExpectedTruth` argument.

import type { ComparatorResult, ExpectedTruth } from "../types";

// A minimal shape of what `analyseIngestedInvoice` returns — kept
// local so the comparators do not import from src/, which prevents
// harness circular-dep noise. Only the fields we compare are typed.
export interface AnalyserSnapshot {
  extractionState: string | null;
  supplier: string | null;
  invoiceNumber: string | null;
  invoiceDate: string | null;
  currency: string | null;
  subtotal: string | null;
  taxTotal: string | null;
  total: string | null;
  vendorState: string | null;
  glLeaderAccountNumber: string | null;
  glLeaderName: string | null;
  glLeaderSource: string | null;
  glConfidence: number | null;
  glCandidateNumbers: string[];
  glReason: string | null;
  workflowState: string | null;
  documentClass?: string | null;
}

function normalizeName(v: string): string {
  return v.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
function approxEqual(a: number, b: number, tol = 0.01): boolean {
  return Math.abs(a - b) <= tol;
}

// ---------------------------------------------------------------------------

export function cmpSupplier(expected: ExpectedTruth, actual: AnalyserSnapshot): ComparatorResult | null {
  const exp = expected.supplier;
  if (!exp) return null;
  const got = actual.supplier ?? "";
  const gotN = normalizeName(got);
  const acceptable = [exp.name, ...(exp.acceptableAliases ?? [])].map(normalizeName);
  const unacceptable = (exp.unacceptable ?? []).map(normalizeName);
  const isUnacceptable = unacceptable.some((u) => u && (gotN === u || gotN.startsWith(u)));
  const isAcceptable = acceptable.some((a) => a && (gotN === a || gotN.startsWith(a)));
  const verdict: ComparatorResult["verdict"] = isUnacceptable ? "FAIL" : isAcceptable ? "PASS" : (got ? "PARTIAL" : "FAIL");
  return {
    dimension: "supplier",
    verdict,
    score: verdict === "PASS" ? 1 : verdict === "PARTIAL" ? 0.4 : 0,
    actual: got,
    expected: acceptable[0] ?? null,
    reason: verdict === "FAIL" && isUnacceptable
      ? `Extracted supplier matched an EXPLICITLY forbidden token.`
      : verdict === "PASS"
        ? `Extracted supplier matched an acceptable alias.`
        : `Extracted supplier did not match any acceptable alias.`,
  };
}

export function cmpInvoiceNumber(expected: ExpectedTruth, actual: AnalyserSnapshot): ComparatorResult | null {
  const exp = expected.invoiceNumber;
  if (!exp) return null;
  const got = (actual.invoiceNumber ?? "").trim();
  const expected_ = exp.value.trim();
  const unacceptable = (exp.unacceptable ?? []).map((s) => s.trim());
  const isUnacceptable = unacceptable.some((u) => u && got === u);
  const verdict: ComparatorResult["verdict"] = isUnacceptable
    ? "FAIL"
    : got === expected_
      ? "PASS"
      : got.includes(expected_) || expected_.includes(got)
        ? "PARTIAL"
        : (got ? "FAIL" : "FAIL");
  return {
    dimension: "invoiceNumber",
    verdict,
    score: verdict === "PASS" ? 1 : verdict === "PARTIAL" ? 0.5 : 0,
    actual: got, expected: expected_,
    reason: verdict === "FAIL" && isUnacceptable
      ? `Extracted invoice number matched an EXPLICITLY forbidden value.`
      : verdict === "PASS"
        ? `Extracted invoice number matched expected exactly.`
        : verdict === "PARTIAL"
          ? `Extracted invoice number partially overlaps expected.`
          : `Extracted invoice number did not match expected.`,
  };
}

function cmpMoney(name: string, exp: number | undefined, actual: string | null): ComparatorResult | null {
  if (exp === undefined) return null;
  const n = actual == null ? NaN : Number(actual);
  if (Number.isNaN(n)) {
    return { dimension: name, verdict: "FAIL", score: 0, actual: actual, expected: exp,
      reason: `No ${name} extracted; expected ${exp.toFixed(2)}.` };
  }
  const ok = approxEqual(n, exp, 0.01);
  return {
    dimension: name,
    verdict: ok ? "PASS" : "FAIL",
    score: ok ? 1 : 0,
    actual: n, expected: exp,
    reason: ok ? `${name} matched within tolerance.` : `${name} ${n.toFixed(2)} did not match expected ${exp.toFixed(2)}.`,
  };
}

export function cmpSubtotal(e: ExpectedTruth, a: AnalyserSnapshot): ComparatorResult | null { return cmpMoney("subtotal", e.subtotal, a.subtotal); }
export function cmpTaxTotal(e: ExpectedTruth, a: AnalyserSnapshot): ComparatorResult | null { return cmpMoney("taxTotal", e.taxTotal, a.taxTotal); }
export function cmpTotal(e: ExpectedTruth, a: AnalyserSnapshot): ComparatorResult | null { return cmpMoney("total", e.total, a.total); }

export function cmpCurrency(e: ExpectedTruth, a: AnalyserSnapshot): ComparatorResult | null {
  if (!e.currency) return null;
  const ok = (a.currency ?? "") === e.currency;
  return {
    dimension: "currency", verdict: ok ? "PASS" : "FAIL", score: ok ? 1 : 0,
    actual: a.currency ?? null, expected: e.currency,
    reason: ok ? `Currency matched.` : `Currency ${a.currency ?? "(none)"} did not match expected ${e.currency}.`,
  };
}

export function cmpVendorMatch(e: ExpectedTruth, a: AnalyserSnapshot): ComparatorResult | null {
  if (!e.vendorMatchExpectation) return null;
  const ok = a.vendorState === e.vendorMatchExpectation;
  return {
    dimension: "vendorMatch",
    verdict: ok ? "PASS" : "FAIL", score: ok ? 1 : 0,
    actual: a.vendorState, expected: e.vendorMatchExpectation,
    reason: ok ? `Vendor state matched expected.` : `Vendor state ${a.vendorState} did not match expected ${e.vendorMatchExpectation}.`,
  };
}

// GL comparators — both a POSITIVE Top-1 accuracy and a NEGATIVE
// forbidden-account guard. Every forbidden-hit is marked `unsafe`.

export function cmpGlTop1(e: ExpectedTruth, a: AnalyserSnapshot): ComparatorResult | null {
  if (!e.acceptableGlAccounts && !e.expectedAbstention) return null;
  const leader = a.glLeaderAccountNumber;
  if (e.expectedAbstention) {
    // Abstention expected — a Top-1 present is a FAIL.
    const abstained = leader == null;
    return {
      dimension: "gl-top1",
      verdict: abstained ? "PASS" : "FAIL",
      score: abstained ? 1 : 0,
      actual: leader, expected: null,
      reason: abstained ? `Correctly abstained.` : `Recommended GL ${leader} when abstention was expected.`,
    };
  }
  if (!leader) {
    return {
      dimension: "gl-top1", verdict: "FAIL", score: 0,
      actual: null, expected: e.acceptableGlAccounts ?? null,
      reason: `No Top-1 recommendation; expected one of [${(e.acceptableGlAccounts ?? []).join(", ")}].`,
    };
  }
  const acceptable = e.acceptableGlAccounts ?? [];
  const ok = acceptable.includes(leader);
  return {
    dimension: "gl-top1",
    verdict: ok ? "PASS" : "FAIL", score: ok ? 1 : 0,
    actual: leader, expected: acceptable,
    reason: ok ? `Top-1 in acceptable set.` : `Top-1 ${leader} not in acceptable set [${acceptable.join(", ")}].`,
  };
}

export function cmpGlTop3(e: ExpectedTruth, a: AnalyserSnapshot): ComparatorResult | null {
  if (!e.acceptableGlAccounts) return null;
  const top3 = (a.glCandidateNumbers ?? []).slice(0, 3);
  const hit = top3.some((n) => (e.acceptableGlAccounts ?? []).includes(n));
  return {
    dimension: "gl-top3",
    verdict: hit ? "PASS" : "FAIL",
    score: hit ? 1 : 0,
    actual: top3, expected: e.acceptableGlAccounts,
    reason: hit ? `At least one Top-3 candidate in acceptable set.` : `No Top-3 candidate in acceptable set.`,
  };
}

export function cmpForbiddenGl(e: ExpectedTruth, a: AnalyserSnapshot): ComparatorResult | null {
  const forbidden = e.forbiddenGlAccounts ?? [];
  if (forbidden.length === 0) return null;
  const leader = a.glLeaderAccountNumber;
  const hit = leader != null && forbidden.includes(leader);
  return {
    dimension: "gl-forbidden",
    verdict: hit ? "FAIL" : "PASS",
    score: hit ? 0 : 1,
    actual: leader, expected: forbidden,
    reason: hit
      ? `UNSAFE — Top-1 recommended ${leader} which is on the forbidden list.`
      : `Top-1 did not land on a forbidden account.`,
    unsafe: hit ? true : false,
  };
}

export function cmpWorkflowType(e: ExpectedTruth, a: AnalyserSnapshot): ComparatorResult | null {
  if (!e.expectedWorkflowType) return null;
  const ok = (a.workflowState ?? "") === e.expectedWorkflowType;
  return {
    dimension: "workflowState",
    verdict: ok ? "PASS" : (a.workflowState ? "PARTIAL" : "FAIL"),
    score: ok ? 1 : (a.workflowState ? 0.3 : 0),
    actual: a.workflowState, expected: e.expectedWorkflowType,
    reason: ok ? `Workflow state matched expected.` : `Workflow state ${a.workflowState ?? "(none)"} did not match expected ${e.expectedWorkflowType}.`,
  };
}

export function cmpAbstention(e: ExpectedTruth, a: AnalyserSnapshot): ComparatorResult | null {
  if (e.expectedAbstention === undefined) return null;
  const abstained = a.glLeaderAccountNumber == null;
  const ok = abstained === e.expectedAbstention;
  return {
    dimension: "abstention",
    verdict: ok ? "PASS" : "FAIL",
    score: ok ? 1 : 0,
    actual: abstained, expected: e.expectedAbstention,
    reason: ok
      ? (e.expectedAbstention ? `Correctly abstained.` : `Correctly produced a recommendation.`)
      : (e.expectedAbstention ? `False recommendation when abstention was expected.` : `False abstention when a recommendation was expected.`),
  };
}

export function runAllComparators(expected: ExpectedTruth, actual: AnalyserSnapshot): ComparatorResult[] {
  const out: ComparatorResult[] = [];
  const push = (r: ComparatorResult | null) => { if (r) out.push(r); };
  push(cmpSupplier(expected, actual));
  push(cmpInvoiceNumber(expected, actual));
  push(cmpSubtotal(expected, actual));
  push(cmpTaxTotal(expected, actual));
  push(cmpTotal(expected, actual));
  push(cmpCurrency(expected, actual));
  push(cmpVendorMatch(expected, actual));
  push(cmpGlTop1(expected, actual));
  push(cmpGlTop3(expected, actual));
  push(cmpForbiddenGl(expected, actual));
  push(cmpWorkflowType(expected, actual));
  push(cmpAbstention(expected, actual));
  return out;
}
