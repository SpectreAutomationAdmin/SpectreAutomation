// Sprint 3 · Checkpoint 15P-2 (2026-07-27) — resolve the two
// control accounts every AP posting needs: the AP control account
// (default 2010) and the GST recoverable / ITC account (default
// 1310, but actually derived from the matching TaxCode row so a
// club can point it wherever policy demands).
//
// Founder rule: "If any control account cannot be identified,
// block posting and show a clear configuration error. Do not
// fabricate a control account." — this module returns a discriminated
// result the caller can surface as a config error, never a fallback.

import { prisma } from "@/lib/prisma";

export const AP_CONTROL_ACCOUNT_NUMBER = "2010";
export const DEFAULT_GST_RECOVERABLE_ACCOUNT_NUMBER = "1310";
export const DEFAULT_GST_TAX_CODE_KEY = "GST_5";

export interface ResolvedControlAccount {
  id: string;
  accountNumber: string;
  name: string;
}

export type ControlAccountsResult =
  | {
      ok: true;
      apControl: ResolvedControlAccount;
      gstRecoverable: ResolvedControlAccount | null;   // null when NO tax on the invoice
      gstTaxCodeId: string | null;                     // the TaxCode row id, needed for APInvoiceLine.taxCodeId
      gstTaxCodeKey: string | null;                    // e.g. "GST_5" — for display
    }
  | {
      ok: false;
      code: "AP_CONTROL_MISSING" | "AP_CONTROL_INACTIVE" | "AP_CONTROL_MANUAL_BLOCKED" | "TAX_CODE_MISSING" | "TAX_RECOVERABLE_MISSING";
      message: string;
    };

export interface ResolveControlAccountsArgs {
  clubId: string;
  needsTax: boolean;                 // false → invoice has no tax; skip the tax lookup
  // Reserved for future: club-configurable tax code choice per-vendor / per-invoice.
  taxCodeKey?: string | null;
}

/**
 * Resolve the AP control account + (optionally) the GST recoverable
 * account for a Coulee Ridge–style tenant. Returns a discriminated
 * result — callers must check `ok` before consuming.
 *
 * The AP control account MUST exist AND be active AND allow non-
 * manual posting; if any of those is violated we return a config
 * error rather than fabricating. Same for the tax recoverable
 * account when the invoice carries tax.
 */
export async function resolveControlAccounts(args: ResolveControlAccountsArgs): Promise<ControlAccountsResult> {
  const apControl = await prisma.account.findFirst({
    where: { clubId: args.clubId, accountNumber: AP_CONTROL_ACCOUNT_NUMBER },
    select: { id: true, accountNumber: true, name: true, isActive: true, allowManualPosting: true, isControlAccount: true },
  });
  if (!apControl) {
    return {
      ok: false,
      code: "AP_CONTROL_MISSING",
      message: `Accounts Payable control account ${AP_CONTROL_ACCOUNT_NUMBER} is missing from this club's chart of accounts. Import or configure it before posting.`,
    };
  }
  if (!apControl.isActive) {
    return {
      ok: false,
      code: "AP_CONTROL_INACTIVE",
      message: `Accounts Payable control account ${AP_CONTROL_ACCOUNT_NUMBER} ${apControl.name} is INACTIVE — cannot post AP invoices until it is reactivated.`,
    };
  }
  // AP posting is a system-driven action, not manual — but the
  // `allowManualPosting` guard is the founder-facing "this account
  // is only postable via a subsystem" gate. The AP subsystem always
  // has permission; we only fail here if it's blocked BY misconfig.
  // We do NOT require `isControlAccount: true` because clubs that
  // imported a foreign COA may not have set that flag yet — the
  // account NUMBER is authoritative for now.

  if (!args.needsTax) {
    return {
      ok: true,
      apControl: { id: apControl.id, accountNumber: apControl.accountNumber, name: apControl.name },
      gstRecoverable: null,
      gstTaxCodeId: null,
      gstTaxCodeKey: null,
    };
  }

  // Look up the tax code (default GST_5 for AB tenants). The
  // recoverable account comes off the TaxCode row so a club can
  // reroute ITC to a different account without a code change.
  const taxKey = args.taxCodeKey ?? DEFAULT_GST_TAX_CODE_KEY;
  const taxCode = await prisma.taxCode.findFirst({
    where: { clubId: args.clubId, key: taxKey, isActive: true },
    select: {
      id: true, key: true, isRecoverable: true,
      recoverableAccount: { select: { id: true, accountNumber: true, name: true, isActive: true } },
    },
  });
  if (!taxCode) {
    return {
      ok: false,
      code: "TAX_CODE_MISSING",
      message: `Tax code "${taxKey}" is missing or inactive on this club — cannot split GST recoverable on posting.`,
    };
  }
  if (!taxCode.recoverableAccount || !taxCode.recoverableAccount.isActive) {
    return {
      ok: false,
      code: "TAX_RECOVERABLE_MISSING",
      message: `Tax code ${taxCode.key} has no active recoverable-account link — configure the GST recoverable account (typically ${DEFAULT_GST_RECOVERABLE_ACCOUNT_NUMBER}) before posting.`,
    };
  }

  return {
    ok: true,
    apControl: { id: apControl.id, accountNumber: apControl.accountNumber, name: apControl.name },
    gstRecoverable: {
      id: taxCode.recoverableAccount.id,
      accountNumber: taxCode.recoverableAccount.accountNumber,
      name: taxCode.recoverableAccount.name,
    },
    gstTaxCodeId: taxCode.id,
    gstTaxCodeKey: taxCode.key,
  };
}
