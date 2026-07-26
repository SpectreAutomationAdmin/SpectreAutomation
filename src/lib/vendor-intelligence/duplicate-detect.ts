// Sprint 3 Checkpoint 15F (2026-07-24) — Deterministic vendor
// duplicate detection.
//
// Given a pair of vendors (already loaded from the same club), return
// a VendorDuplicateState + the ordered list of match / conflict
// signals that produced it. Every recommendation is explainable —
// each Match / Conflict names its rule key and quotes the values
// that agreed / diverged.

import type { Vendor, VendorContact } from "@prisma/client";
import {
  domainFromEmail,
  fingerprintVendor,
  isConsumerDomain,
  normaliseEmail,
} from "./normalize";
import type {
  DuplicateRuleKey,
  VendorDuplicateState,
} from "./types";
import { SIGNAL_STRENGTHS } from "./types";

export interface DuplicateSignal {
  ruleKey: DuplicateRuleKey;
  strength: "STRONG" | "SUPPORTING" | "CONFLICT";
  leftValue: string;
  rightValue: string;
}

export interface DuplicateDetection {
  state: VendorDuplicateState;
  ruleVersion: number;
  matchSignals: DuplicateSignal[];
  conflictSignals: DuplicateSignal[];
  explanation: string;
}

const RULE_VERSION = 1;

// A "vendor-with-context" — the raw Vendor row plus the small set of
// child data the classifier actually uses.
export interface VendorForDetection {
  vendor: Pick<
    Vendor,
    | "id"
    | "legalName"
    | "operatingName"
    | "taxRegistrationNumber"
    | "email"
    | "website"
    | "phone"
    | "address1"
    | "postalCode"
    | "defaultExpenseAccountId"
    | "status"
  >;
  contacts: Array<Pick<VendorContact, "email" | "phone">>;
  historicalInvoiceReferences: string[]; // vendor's APInvoice.vendorReference values
  hasBanking: boolean;
  activeBankingAccountLast4?: string | null; // only used to detect banking DIFFERS; never exposed
}

export function detectDuplicate(a: VendorForDetection, b: VendorForDetection): DuplicateDetection {
  if (a.vendor.id === b.vendor.id) {
    return {
      state: "DISTINCT_VENDOR",
      ruleVersion: RULE_VERSION,
      matchSignals: [],
      conflictSignals: [],
      explanation: "Same vendor — cannot be a duplicate of itself.",
    };
  }

  const fa = fingerprintVendor(a.vendor);
  const fb = fingerprintVendor(b.vendor);

  const matches: DuplicateSignal[] = [];
  const conflicts: DuplicateSignal[] = [];

  // ---- Match signals ----------------------------------------------------
  if (fa.taxNumberNorm && fb.taxNumberNorm) {
    if (fa.taxNumberNorm === fb.taxNumberNorm) {
      matches.push({
        ruleKey: "match.tax_number_exact",
        strength: SIGNAL_STRENGTHS["match.tax_number_exact"]!,
        leftValue: a.vendor.taxRegistrationNumber ?? "",
        rightValue: b.vendor.taxRegistrationNumber ?? "",
      });
    } else {
      // Different registered tax numbers means DIFFERENT legal entities.
      conflicts.push({
        ruleKey: "conflict.tax_number_differs",
        strength: "CONFLICT",
        leftValue: a.vendor.taxRegistrationNumber ?? "",
        rightValue: b.vendor.taxRegistrationNumber ?? "",
      });
    }
  }

  if (fa.emailNorm && fb.emailNorm && fa.emailNorm === fb.emailNorm) {
    matches.push({
      ruleKey: "match.email_exact",
      strength: SIGNAL_STRENGTHS["match.email_exact"]!,
      leftValue: a.vendor.email ?? "",
      rightValue: b.vendor.email ?? "",
    });
  }

  // Contact-email cross match.
  if (matches.every((m) => m.ruleKey !== "match.email_exact")) {
    const emailsA = new Set(a.contacts.map((c) => normaliseEmail(c.email)).filter(Boolean));
    const contactMatch = b.contacts
      .map((c) => normaliseEmail(c.email))
      .find((e) => e && emailsA.has(e));
    if (contactMatch) {
      matches.push({
        ruleKey: "match.contact_email_exact",
        strength: SIGNAL_STRENGTHS["match.contact_email_exact"]!,
        leftValue: contactMatch,
        rightValue: contactMatch,
      });
    }
  }

  if (fa.websiteDomain && fb.websiteDomain && fa.websiteDomain === fb.websiteDomain) {
    matches.push({
      ruleKey: "match.website_domain_exact",
      strength: SIGNAL_STRENGTHS["match.website_domain_exact"]!,
      leftValue: a.vendor.website ?? "",
      rightValue: b.vendor.website ?? "",
    });
  } else {
    // Cross-source website vs email domain — treat a business email domain
    // matching the other side's website domain as SUPPORTING (rule reused).
    const domA = fa.emailDomain || fa.websiteDomain;
    const domB = fb.emailDomain || fb.websiteDomain;
    if (domA && domB && domA === domB && !isConsumerDomain(domA)) {
      matches.push({
        ruleKey: "match.website_domain_exact",
        strength: "SUPPORTING",
        leftValue: domA,
        rightValue: domB,
      });
    }
  }

  if (fa.phoneNorm && fb.phoneNorm && fa.phoneNorm === fb.phoneNorm) {
    matches.push({
      ruleKey: "match.telephone_normalised",
      strength: SIGNAL_STRENGTHS["match.telephone_normalised"]!,
      leftValue: a.vendor.phone ?? "",
      rightValue: b.vendor.phone ?? "",
    });
  }

  if (fa.legalNameNorm && fb.legalNameNorm && fa.legalNameNorm === fb.legalNameNorm) {
    matches.push({
      ruleKey: "match.legal_name_normalised",
      strength: SIGNAL_STRENGTHS["match.legal_name_normalised"]!,
      leftValue: a.vendor.legalName,
      rightValue: b.vendor.legalName,
    });
  }
  if (fa.operatingNameNorm && fb.operatingNameNorm && fa.operatingNameNorm === fb.operatingNameNorm) {
    matches.push({
      ruleKey: "match.trade_name_normalised",
      strength: SIGNAL_STRENGTHS["match.trade_name_normalised"]!,
      leftValue: a.vendor.operatingName ?? "",
      rightValue: b.vendor.operatingName ?? "",
    });
  }

  if (fa.postalCodeNorm && fb.postalCodeNorm && fa.postalCodeNorm === fb.postalCodeNorm &&
      fa.addressLine1Norm && fb.addressLine1Norm && fa.addressLine1Norm === fb.addressLine1Norm) {
    matches.push({
      ruleKey: "match.remittance_address_normalised",
      strength: SIGNAL_STRENGTHS["match.remittance_address_normalised"]!,
      leftValue: `${a.vendor.address1 ?? ""} ${a.vendor.postalCode ?? ""}`.trim(),
      rightValue: `${b.vendor.address1 ?? ""} ${b.vendor.postalCode ?? ""}`.trim(),
    });
  } else if (fa.postalCodeNorm && fb.postalCodeNorm && fa.postalCodeNorm !== fb.postalCodeNorm &&
             fa.addressLine1Norm && fb.addressLine1Norm && fa.addressLine1Norm !== fb.addressLine1Norm) {
    conflicts.push({
      ruleKey: "conflict.address_materially_differs",
      strength: "CONFLICT",
      leftValue: `${a.vendor.address1 ?? ""} ${a.vendor.postalCode ?? ""}`.trim(),
      rightValue: `${b.vendor.address1 ?? ""} ${b.vendor.postalCode ?? ""}`.trim(),
    });
  }

  if (a.vendor.defaultExpenseAccountId && b.vendor.defaultExpenseAccountId &&
      a.vendor.defaultExpenseAccountId === b.vendor.defaultExpenseAccountId) {
    matches.push({
      ruleKey: "match.default_expense_account",
      strength: SIGNAL_STRENGTHS["match.default_expense_account"]!,
      leftValue: a.vendor.defaultExpenseAccountId,
      rightValue: b.vendor.defaultExpenseAccountId,
    });
  }

  const overlap = intersectionSize(a.historicalInvoiceReferences, b.historicalInvoiceReferences);
  if (overlap > 0) {
    // Same vendor reference on invoices attributed to two Vendor rows is
    // a strong signal the vendors are duplicates BUT can also indicate a
    // data-entry mistake — treat as SUPPORTING match plus an explicit
    // conflict when the overlap size is > 0 but not conclusive.
    matches.push({
      ruleKey: "match.historical_invoice_number_overlap",
      strength: SIGNAL_STRENGTHS["match.historical_invoice_number_overlap"]!,
      leftValue: `${a.historicalInvoiceReferences.length} invoices`,
      rightValue: `${b.historicalInvoiceReferences.length} invoices`,
    });
  }

  // ---- Conflict signals not already flagged -----------------------------
  if (a.hasBanking && b.hasBanking && a.activeBankingAccountLast4 && b.activeBankingAccountLast4 &&
      a.activeBankingAccountLast4 !== b.activeBankingAccountLast4) {
    conflicts.push({
      ruleKey: "conflict.banking_differs",
      strength: "CONFLICT",
      leftValue: `****${a.activeBankingAccountLast4}`,
      rightValue: `****${b.activeBankingAccountLast4}`,
    });
  }

  // "Legal entity differs" fires when tax numbers are BOTH present AND
  // differ AND the operating names are ALSO different — i.e. these look
  // like two genuinely different corporate entities.
  if (conflicts.some((c) => c.ruleKey === "conflict.tax_number_differs") &&
      fa.operatingNameNorm && fb.operatingNameNorm && fa.operatingNameNorm !== fb.operatingNameNorm) {
    conflicts.push({
      ruleKey: "conflict.legal_entity_differs",
      strength: "CONFLICT",
      leftValue: a.vendor.legalName,
      rightValue: b.vendor.legalName,
    });
  }

  // ---- Classify state ---------------------------------------------------
  const strongCount = matches.filter((m) => m.strength === "STRONG").length;
  const supportingCount = matches.filter((m) => m.strength === "SUPPORTING").length;
  const hardConflict = conflicts.some(
    (c) => c.ruleKey === "conflict.tax_number_differs" ||
           c.ruleKey === "conflict.banking_differs" ||
           c.ruleKey === "conflict.legal_entity_differs",
  );

  let state: VendorDuplicateState;
  let explanation: string;
  if (hardConflict) {
    state = "CONFLICT_REQUIRES_REVIEW";
    explanation = `Blocking conflict(s): ${conflicts.map((c) => c.ruleKey).join(", ")}. A merge cannot be recommended until a human resolves them.`;
  } else if (strongCount >= 2) {
    state = "CONFIRMED_DUPLICATE";
    explanation = `Two or more strong deterministic signals agree (${matches.filter((m) => m.strength === "STRONG").map((m) => m.ruleKey).join(", ")}). Safe to recommend merge.`;
  } else if (strongCount === 1 && supportingCount >= 1) {
    state = "LIKELY_DUPLICATE";
    explanation = `One strong signal (${matches.find((m) => m.strength === "STRONG")?.ruleKey}) plus supporting evidence. Recommend reviewer confirmation before merge.`;
  } else if (strongCount === 1) {
    state = "LIKELY_DUPLICATE";
    explanation = `One strong signal (${matches.find((m) => m.strength === "STRONG")?.ruleKey}) with no corroboration. Reviewer must confirm.`;
  } else if (supportingCount >= 2) {
    state = "POSSIBLE_DUPLICATE";
    explanation = `Multiple supporting signals (${matches.map((m) => m.ruleKey).join(", ")}) but no strong evidence. Human review required.`;
  } else if (supportingCount === 1) {
    state = "POSSIBLE_DUPLICATE";
    explanation = `Single supporting signal (${matches[0].ruleKey}). Weak evidence — reviewer must decide.`;
  } else {
    state = "DISTINCT_VENDOR";
    explanation = "No matching signals detected — vendors appear distinct.";
  }

  return {
    state,
    ruleVersion: RULE_VERSION,
    matchSignals: matches,
    conflictSignals: conflicts,
    explanation,
  };
}

function intersectionSize(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const setA = new Set(a.map((s) => s.toLowerCase().trim()).filter(Boolean));
  let n = 0;
  for (const s of b) if (setA.has((s || "").toLowerCase().trim())) n += 1;
  return n;
}

// Batch helper — pairs every eligible vendor against every other and
// returns just the non-DISTINCT pairs. Caller supplies the loaded
// VendorForDetection[]; the function does NO database work.
export function findDuplicatePairsInBatch(
  vendors: VendorForDetection[],
): Array<{ a: string; b: string; detection: DuplicateDetection }> {
  const results: Array<{ a: string; b: string; detection: DuplicateDetection }> = [];
  for (let i = 0; i < vendors.length; i += 1) {
    for (let j = i + 1; j < vendors.length; j += 1) {
      const det = detectDuplicate(vendors[i], vendors[j]);
      if (det.state !== "DISTINCT_VENDOR") {
        results.push({ a: vendors[i].vendor.id, b: vendors[j].vendor.id, detection: det });
      }
    }
  }
  return results;
}
