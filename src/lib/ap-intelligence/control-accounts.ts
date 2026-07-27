// Sprint 3 · Checkpoint 15P-2 (2026-07-27) — resolve the control
// accounts every AP posting needs.
//
// Founder rules (§Phase 3-4):
//   • "Use actual Coulee Ridge GL accounts. Do not hardcode generic
//     account numbers."
//   • "If any control account cannot be identified, block posting
//     and show a clear configuration error. Do not fabricate a
//     control account."
//
// Resolution strategy — semantic identity, NOT hardcoded numbers:
//
//   AP control account:
//     1. Prefer any Account flagged `isControlAccount: true` whose
//        name matches /(^|\W)(accounts?\s*payable|ap\s*control|
//        trade\s*payable)(\W|$)/i and whose type is LIABILITY.
//     2. Otherwise: pick the LIABILITY account with the lowest
//        account number whose name matches the same pattern.
//     3. When the well-known numbers (2000 / 2009 / 2010 / 2100)
//        appear as a tie-breaker they help, but the NAME + TYPE
//        must match. Numbers alone don't win.
//     4. If no match → typed config error. Never fabricated.
//
//   GST recoverable / input-tax-credit account:
//     1. Prefer the TaxCode row (`recoverableAccount` relation) when
//        one exists for the requested key (e.g. GST_5). This is the
//        canonical source — a club can point ITC to any account it
//        wants via TaxCode config.
//     2. When NO TaxCode exists but the invoice has recoverable
//        tax: fall back to name-based lookup on Account with
//        names matching /(gst.*(?:paid|recoverable)|input\s*tax|
//        itc|hst.*recoverable)/i and type LIABILITY or ASSET.
//     3. If neither succeeds → typed config error. Never fabricated.

import { prisma } from "@/lib/prisma";

export const DEFAULT_GST_TAX_CODE_KEY = "GST_5";

// Fallback / well-known numbers — used ONLY as tiebreakers when
// multiple name-match candidates exist. Never used as the sole
// signal.
const KNOWN_AP_NUMBERS = ["2000", "2009", "2010", "2100"];

const AP_NAME_RE = /(^|\W)(accounts?\s*payable|ap\s*control|trade\s*payable)(\W|$)/i;
const GST_RECOVERABLE_NAME_RE = /(gst.*(?:paid|recoverable)|input\s*tax\s*credit|itc\b|hst.*recoverable)/i;

export interface ResolvedControlAccount {
  id: string;
  accountNumber: string;
  name: string;
}

export type ControlAccountsResult =
  | {
      ok: true;
      apControl: ResolvedControlAccount;
      gstRecoverable: ResolvedControlAccount | null;
      gstTaxCodeId: string | null;
      gstTaxCodeKey: string | null;
      resolutionNotes: string[];
    }
  | {
      ok: false;
      code: "AP_CONTROL_MISSING" | "AP_CONTROL_AMBIGUOUS" | "TAX_CODE_MISSING" | "TAX_RECOVERABLE_MISSING";
      message: string;
    };

export interface ResolveControlAccountsArgs {
  clubId: string;
  needsTax: boolean;
  taxCodeKey?: string | null;
}

export async function resolveControlAccounts(args: ResolveControlAccountsArgs): Promise<ControlAccountsResult> {
  const notes: string[] = [];

  // ---- AP control account resolution ----------------------------------------
  const apCandidates = await prisma.account.findMany({
    where: { clubId: args.clubId, isActive: true, type: "LIABILITY" },
    select: { id: true, accountNumber: true, name: true, isControlAccount: true },
  });
  const nameMatches = apCandidates.filter((a) => AP_NAME_RE.test(a.name));
  const flagged = nameMatches.filter((a) => a.isControlAccount);
  let apControl: ResolvedControlAccount | null = null;
  if (flagged.length === 1) {
    apControl = { id: flagged[0].id, accountNumber: flagged[0].accountNumber, name: flagged[0].name };
    notes.push(`AP control resolved via isControlAccount flag: ${flagged[0].accountNumber} ${flagged[0].name}`);
  } else if (flagged.length > 1) {
    // Prefer flagged + known-number tiebreaker.
    const preferred = flagged.find((a) => KNOWN_AP_NUMBERS.includes(a.accountNumber));
    if (preferred) {
      apControl = { id: preferred.id, accountNumber: preferred.accountNumber, name: preferred.name };
      notes.push(`AP control resolved from ${flagged.length} flagged candidates via number tiebreaker: ${preferred.accountNumber}`);
    } else {
      return {
        ok: false,
        code: "AP_CONTROL_AMBIGUOUS",
        message: `Multiple AP control accounts are flagged: ${flagged.map((a) => `${a.accountNumber} ${a.name}`).join(", ")}. Configure exactly ONE as isControlAccount before posting.`,
      };
    }
  } else if (nameMatches.length >= 1) {
    // No flagged candidate — pick the one with the smallest known
    // number, else the lowest number overall.
    const known = nameMatches.filter((a) => KNOWN_AP_NUMBERS.includes(a.accountNumber));
    const sorted = (known.length ? known : nameMatches).sort((a, b) => a.accountNumber.localeCompare(b.accountNumber));
    const pick = sorted[0];
    apControl = { id: pick.id, accountNumber: pick.accountNumber, name: pick.name };
    notes.push(`AP control resolved by name: ${pick.accountNumber} ${pick.name}${nameMatches.length > 1 ? ` (chosen from ${nameMatches.length} candidates)` : ""}`);
  } else {
    return {
      ok: false,
      code: "AP_CONTROL_MISSING",
      message: `No Accounts Payable control account was found on this club. Import or configure a LIABILITY account named "Accounts Payable" before posting AP invoices.`,
    };
  }

  // ---- Short-circuit when no tax is needed ----------------------------------
  if (!args.needsTax) {
    return {
      ok: true,
      apControl,
      gstRecoverable: null,
      gstTaxCodeId: null,
      gstTaxCodeKey: null,
      resolutionNotes: notes,
    };
  }

  // ---- Tax code + recoverable account lookup --------------------------------
  const taxKey = args.taxCodeKey ?? DEFAULT_GST_TAX_CODE_KEY;
  const taxCode = await prisma.taxCode.findFirst({
    where: { clubId: args.clubId, key: taxKey, isActive: true },
    select: {
      id: true, key: true, isRecoverable: true,
      recoverableAccount: { select: { id: true, accountNumber: true, name: true, isActive: true } },
    },
  });

  // Path A: TaxCode exists AND its recoverable-account link resolves.
  if (taxCode && taxCode.recoverableAccount && taxCode.recoverableAccount.isActive) {
    notes.push(`GST recoverable resolved via TaxCode(${taxCode.key}): ${taxCode.recoverableAccount.accountNumber} ${taxCode.recoverableAccount.name}`);
    return {
      ok: true,
      apControl,
      gstRecoverable: {
        id: taxCode.recoverableAccount.id,
        accountNumber: taxCode.recoverableAccount.accountNumber,
        name: taxCode.recoverableAccount.name,
      },
      gstTaxCodeId: taxCode.id,
      gstTaxCodeKey: taxCode.key,
      resolutionNotes: notes,
    };
  }

  // Path B: TaxCode missing OR misconfigured — fall back to name-based
  // lookup on Account. The Account row IS the ITC destination; the
  // TaxCode.id will remain null on the APInvoiceLine, which means
  // `postInvoiceToGl` will roll tax into expense (safe under-recovery)
  // unless the caller subsequently seeds the TaxCode row. Preview
  // rendering already reflects the correct 3-line split using the
  // resolved account.
  const gstMatches = await prisma.account.findMany({
    where: {
      clubId: args.clubId,
      isActive: true,
      type: { in: ["ASSET", "LIABILITY"] },
    },
    select: { id: true, accountNumber: true, name: true, type: true },
  });
  const gstNameMatches = gstMatches.filter((a) => GST_RECOVERABLE_NAME_RE.test(a.name));
  if (gstNameMatches.length >= 1) {
    // Prefer ASSET over LIABILITY (typical accounting classification
    // for ITC), then lowest number.
    const sorted = [...gstNameMatches].sort((a, b) => {
      if (a.type !== b.type) return a.type === "ASSET" ? -1 : 1;
      return a.accountNumber.localeCompare(b.accountNumber);
    });
    const pick = sorted[0];
    notes.push(
      taxCode
        ? `GST recoverable resolved by name (TaxCode ${taxCode.key} had no recoverableAccount link): ${pick.accountNumber} ${pick.name}`
        : `GST recoverable resolved by name (no TaxCode ${taxKey} configured on this club): ${pick.accountNumber} ${pick.name}`,
    );
    return {
      ok: true,
      apControl,
      gstRecoverable: { id: pick.id, accountNumber: pick.accountNumber, name: pick.name },
      // gstTaxCodeId only when a TaxCode row backs the resolution.
      // Otherwise remain null so APInvoiceLine.taxCodeId is null and
      // postInvoiceToGl falls back to the non-recoverable path (safe).
      gstTaxCodeId: taxCode?.id ?? null,
      gstTaxCodeKey: taxCode?.key ?? null,
      resolutionNotes: notes,
    };
  }

  // Path C: nothing found — typed config error.
  return {
    ok: false,
    code: taxCode ? "TAX_RECOVERABLE_MISSING" : "TAX_CODE_MISSING",
    message: taxCode
      ? `Tax code ${taxCode.key} has no active recoverable-account link and no account named "GST Recoverable / Input Tax / ITC" exists on this club. Configure one before posting recoverable-tax invoices.`
      : `No tax code "${taxKey}" is configured on this club and no account named "GST Recoverable / GST Paid / Input Tax / ITC" exists. Configure a tax code (typical: GST_5) or an ITC account before posting recoverable-tax invoices.`,
  };
}
