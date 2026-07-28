// Sprint 3 · Checkpoint 15P-5 (2026-07-28) — plain POST API route
// for the Step-2 accounting-entry preview.
//
// Replaces the pre-15P-5 `previewApEntryAction` server action. Root
// cause of the founder-observed "Cannot read properties of undefined
// (reading 'ok')" / "Preview unavailable" defect: Next.js hashes
// server-action ids at build time. A browser page loaded from
// deploy v_N that tries to invoke an action rehashed in v_N+1
// receives `undefined` from the RPC. The old modal had a defensive
// UI, but the founder's rule is:
//
//   "Do not add fallback UI until the underlying issue is fixed."
//
// This route uses a stable URL — `/api/mission-control/ap-preview` —
// that survives every deploy. A pre-deploy browser session posting
// to this URL either hits the current handler (correct behaviour)
// or, in a shape-mismatch case, gets a plain 4xx with an actionable
// JSON message. No hash lookup, no undefined RPC return.
//
// Same auth + tenant scoping + business logic as the retired
// server action — the underlying handler shape is unchanged and
// still uses the shared `buildProposedApEntry` so preview and
// posting can never diverge.

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { hasPermission } from "@/lib/rbac";
import { logger } from "@/lib/observability/logger";
import { buildProposedApEntry, type ProposedApEntry, type TaxTreatment } from "@/lib/ap-intelligence/proposed-ap-entry";
import { resolveControlAccounts } from "@/lib/ap-intelligence/control-accounts";
import { toMoney, isZero } from "@/lib/accounting/decimal";

const bodySchema = z.object({
  workIntakeItemId: z.string().min(1),
  vendorId: z.string().min(1),
  coding: z.object({
    invoiceNumber: z.string().trim().min(1),
    subtotal: z.string().trim().min(1),
    tax: z.string().trim(),
    gross: z.string().trim().min(1),
    currency: z.string().trim().min(1).max(6),
    glAccountNumber: z.string().trim().min(1),
    taxTreatment: z.enum(["RECOVERABLE", "NON_RECOVERABLE", "NONE"]),
    taxCodeKey: z.string().trim().nullable().optional(),
  }),
});

export type PreviewApEntryResponse =
  | { ok: true; entry: ProposedApEntry; vendorLegalName: string; expenseAccount: { number: string; name: string; type: "EXPENSE" | "ASSET" } }
  | { ok: false; message: string; code: string; };

export async function POST(req: Request): Promise<NextResponse<PreviewApEntryResponse>> {
  const principal = await getCurrentPrincipal();
  if (!principal) return NextResponse.json({ ok: false, message: "Not signed in.", code: "UNAUTHENTICATED" }, { status: 401 });

  const raw = await req.json().catch(() => null);
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) return NextResponse.json({ ok: false, message: "Invalid preview inputs.", code: "VALIDATION" }, { status: 400 });
  const input = parsed.data;

  const clubId = await getActiveClubId({ clubId: principal.activeClubId ?? null, role: "" });
  if (!clubId) return NextResponse.json({ ok: false, message: "No active club.", code: "NO_CLUB" }, { status: 400 });

  if (!hasPermission(principal, clubId, "ap:invoice:view")) {
    return NextResponse.json({ ok: false, message: "Your role cannot preview AP entries.", code: "PERMISSION" }, { status: 403 });
  }

  const vendor = await prisma.vendor.findFirst({
    where: { id: input.vendorId, clubId },
    select: { id: true, legalName: true, status: true },
  });
  if (!vendor) return NextResponse.json({ ok: false, message: "Vendor not found.", code: "VENDOR_NOT_FOUND" }, { status: 404 });

  const expenseAccount = await prisma.account.findFirst({
    where: { clubId, accountNumber: input.coding.glAccountNumber, isActive: true },
    select: { id: true, accountNumber: true, name: true, type: true, allowManualPosting: true },
  });
  if (!expenseAccount) {
    return NextResponse.json({ ok: false, message: `GL account ${input.coding.glAccountNumber} is inactive or missing.`, code: "BAD_GL" }, { status: 400 });
  }
  if (expenseAccount.type !== "EXPENSE" && expenseAccount.type !== "ASSET") {
    return NextResponse.json({
      ok: false,
      message: `GL ${expenseAccount.accountNumber} ${expenseAccount.name} is a ${expenseAccount.type} account — AP debits can only target EXPENSE or ASSET accounts.`,
      code: "BAD_GL_TYPE",
    }, { status: 400 });
  }

  const taxAmount = toMoney(input.coding.tax);
  const needsTax = input.coding.taxTreatment !== "NONE" && !isZero(taxAmount);
  const control = await resolveControlAccounts({
    clubId,
    needsTax: needsTax && input.coding.taxTreatment === "RECOVERABLE",
    taxCodeKey: input.coding.taxCodeKey ?? null,
  });
  if (!control.ok) {
    return NextResponse.json({ ok: false, message: control.message, code: control.code }, { status: 400 });
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

  return NextResponse.json({
    ok: true,
    entry,
    vendorLegalName: vendor.legalName,
    expenseAccount: { number: expenseAccount.accountNumber, name: expenseAccount.name, type: expenseAccount.type as "EXPENSE" | "ASSET" },
  });
}
