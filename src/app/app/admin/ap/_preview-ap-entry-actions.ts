// Sprint 3 · Checkpoint 15P-2 (2026-07-27) — preview server action
// backing Step 2 of the Create Vendor & Post modal. Returns the
// ProposedApEntry the founder sees (subtotal / tax / gross + full
// debit/credit table + balance) computed via the same shared
// `buildProposedApEntry` function the posting action uses.
//
// Never persists. Never resolves the Work Intake. Never touches
// the AP invoice / journal tables. Safe to call multiple times as
// the operator edits GL / tax / dates in the modal.

"use server";

import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { hasPermission } from "@/lib/rbac";
import { logger } from "@/lib/observability/logger";
import { buildProposedApEntry, type ProposedApEntry, type TaxTreatment } from "@/lib/ap-intelligence/proposed-ap-entry";
import { resolveControlAccounts } from "@/lib/ap-intelligence/control-accounts";
import { toMoney, isZero } from "@/lib/accounting/decimal";

const schema = z.object({
  workIntakeItemId: z.string().min(1),
  vendorId: z.string().min(1),
  coding: z.object({
    invoiceNumber: z.string().trim().min(1),
    // All money fields are decimal-safe strings (no floats over the wire).
    subtotal: z.string().trim().min(1),
    tax: z.string().trim(),               // "0" is legal for tax-exempt
    gross: z.string().trim().min(1),
    currency: z.string().trim().min(1).max(6),
    glAccountNumber: z.string().trim().min(1),
    // Tax treatment: RECOVERABLE (Canadian GST/HST ITC), NON_RECOVERABLE
    // (roll into expense), NONE (no tax on the invoice).
    taxTreatment: z.enum(["RECOVERABLE", "NON_RECOVERABLE", "NONE"]),
    taxCodeKey: z.string().trim().nullable().optional(),   // e.g. "GST_5"
  }),
});

export type PreviewApEntryResult =
  | { ok: true; entry: ProposedApEntry; vendorLegalName: string; expenseAccount: { number: string; name: string; type: "EXPENSE" | "ASSET" } }
  | { ok: false; message: string; code: string; };

export async function previewApEntryAction(raw: unknown): Promise<PreviewApEntryResult> {
  const principal = await getCurrentPrincipal();
  if (!principal) return { ok: false, message: "Not signed in.", code: "UNAUTHENTICATED" };

  const parsed = schema.safeParse(raw);
  if (!parsed.success) return { ok: false, message: "Invalid preview inputs.", code: "VALIDATION" };
  const input = parsed.data;

  const clubId = await getActiveClubId({ clubId: principal.activeClubId ?? null, role: "" });
  if (!clubId) return { ok: false, message: "No active club.", code: "NO_CLUB" };

  // Read permission is enough for preview — no writes happen here.
  if (!hasPermission(principal, clubId, "ap:invoice:view")) {
    return { ok: false, message: "Your role cannot preview AP entries.", code: "PERMISSION" };
  }

  // Vendor + WI existence + tenant checks — cheap up front.
  const vendor = await prisma.vendor.findFirst({
    where: { id: input.vendorId, clubId },
    select: { id: true, legalName: true, status: true },
  });
  if (!vendor) return { ok: false, message: "Vendor not found.", code: "VENDOR_NOT_FOUND" };

  const expenseAccount = await prisma.account.findFirst({
    where: { clubId, accountNumber: input.coding.glAccountNumber, isActive: true },
    select: { id: true, accountNumber: true, name: true, type: true, allowManualPosting: true },
  });
  if (!expenseAccount) {
    return { ok: false, message: `GL account ${input.coding.glAccountNumber} is inactive or missing.`, code: "BAD_GL" };
  }
  if (expenseAccount.type !== "EXPENSE" && expenseAccount.type !== "ASSET") {
    return {
      ok: false,
      message: `GL ${expenseAccount.accountNumber} ${expenseAccount.name} is a ${expenseAccount.type} account — AP debits can only target EXPENSE or ASSET accounts.`,
      code: "BAD_GL_TYPE",
    };
  }

  // Control accounts.
  const taxAmount = toMoney(input.coding.tax);
  const needsTax = input.coding.taxTreatment !== "NONE" && !isZero(taxAmount);
  const control = await resolveControlAccounts({
    clubId,
    needsTax: needsTax && input.coding.taxTreatment === "RECOVERABLE",
    taxCodeKey: input.coding.taxCodeKey ?? null,
  });
  if (!control.ok) {
    return { ok: false, message: control.message, code: control.code };
  }

  const treatment: TaxTreatment =
    input.coding.taxTreatment === "RECOVERABLE" && control.gstRecoverable
      ? { kind: "RECOVERABLE", recoverableAccount: control.gstRecoverable }
      : input.coding.taxTreatment === "NON_RECOVERABLE"
      ? { kind: "NON_RECOVERABLE" }
      : { kind: "NONE" };

  const entry = buildProposedApEntry({
    currency: input.coding.currency,
    subtotal: input.coding.subtotal,
    tax: input.coding.tax,
    gross: input.coding.gross,
    expenseAccount: {
      id: expenseAccount.id,
      accountNumber: expenseAccount.accountNumber,
      name: expenseAccount.name,
      type: expenseAccount.type as "EXPENSE" | "ASSET",
    },
    apControlAccount: control.apControl,
    taxTreatment: treatment,
    vendorLegalName: vendor.legalName,
    invoiceRef: input.coding.invoiceNumber,
  });

  logger.info("mission-control.preview-ap-entry.ok", {
    clubId, vendorId: vendor.id,
    lines: entry.lines.length,
    balanced: entry.isBalanced,
    subtotal: entry.subtotal, tax: entry.tax, gross: entry.gross,
  });

  return {
    ok: true,
    entry,
    vendorLegalName: vendor.legalName,
    expenseAccount: { number: expenseAccount.accountNumber, name: expenseAccount.name, type: expenseAccount.type as "EXPENSE" | "ASSET" },
  };
}
