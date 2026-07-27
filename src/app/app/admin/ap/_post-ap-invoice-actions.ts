// Sprint 3 · Checkpoint 15O (2026-07-27) — Step 2 server action:
// draft + post the AP invoice against an existing (already-created
// or already-selected) vendor, and resolve the source Work Intake
// item.
//
// This action is the ONLY path that resolves the WI — Step 1
// intentionally leaves it OPEN so a failed Step 2 (validation,
// duplicate, permission, network) preserves the vendor + a valid
// retry surface. See _create-vendor-actions.ts for Step 1.

"use server";

import { z } from "zod";
import { Decimal } from "@prisma/client/runtime/library";
import { prisma } from "@/lib/prisma";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { hasPermission } from "@/lib/rbac";
import { audit } from "@/lib/audit";
import { ConflictError, NotFoundError, ValidationError, isAppError } from "@/lib/errors";
import { logger } from "@/lib/observability/logger";

const codingSchema = z.object({
  invoiceNumber: z.string().trim().min(1),
  gross: z.string().trim().min(1),
  currency: z.string().trim().min(1).max(6),
  glAccountNumber: z.string().trim().min(1),
  glAccountName: z.string().trim().min(1),
  taxTotal: z.string().nullable().optional(),
  paymentTermsDays: z.number().int().min(0).max(365).nullable().optional(),
});

const schema = z.object({
  workIntakeItemId: z.string().min(1),
  vendorId: z.string().min(1),           // Must exist — Step 1 created / selected it.
  coding: codingSchema,
});

export interface PostApInvoiceResult {
  ok: true;
  vendorId: string;
  invoiceId: string;
  invoiceNumber: string;
  timelineUrl: string;
  apInvoiceUrl: string;
}
export interface PostApInvoiceFailure {
  ok: false;
  message: string;
  code?: string;
}

export async function postApInvoiceAction(
  raw: unknown,
): Promise<PostApInvoiceResult | PostApInvoiceFailure> {
  const principal = await getCurrentPrincipal();
  if (!principal) return { ok: false, message: "Not signed in.", code: "UNAUTHENTICATED" };

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, message: "Some fields need review before posting.", code: "VALIDATION" };
  }
  const input = parsed.data;

  const clubId = await getActiveClubId({ clubId: principal.activeClubId ?? null, role: "" });
  if (!clubId) return { ok: false, message: "No active club.", code: "NO_CLUB" };

  if (!hasPermission(principal, clubId, "ap:invoice:create")) {
    return { ok: false, message: "Your role cannot post AP invoices.", code: "PERMISSION" };
  }

  // Re-fetch WI + vendor + GL server-side. Never trust the client
  // with tenant-crossing or entity-state facts.
  const wi = await prisma.workIntakeItem.findFirst({
    where: { id: input.workIntakeItemId, clubId },
    select: { id: true, status: true, displaySender: true },
  });
  if (!wi) return { ok: false, message: "Work intake item not found.", code: "NOT_FOUND" };
  if (wi.status === "RESOLVED") {
    return { ok: false, message: "This intake is already resolved.", code: "ALREADY_RESOLVED" };
  }

  const vendor = await prisma.vendor.findFirst({
    where: { id: input.vendorId, clubId },
    select: { id: true, legalName: true, status: true, paymentTermsDays: true },
  });
  if (!vendor) return { ok: false, message: "Vendor not found.", code: "VENDOR_NOT_FOUND" };
  if (vendor.status === "BLOCKED") return { ok: false, message: "Vendor is BLOCKED — cannot post.", code: "VENDOR_BLOCKED" };

  const account = await prisma.account.findFirst({
    where: { clubId, accountNumber: input.coding.glAccountNumber, isActive: true },
    select: { id: true, accountNumber: true, name: true, type: true },
  });
  if (!account) {
    return {
      ok: false,
      message: `GL account ${input.coding.glAccountNumber} is not active or does not exist on this club.`,
      code: "BAD_GL",
    };
  }
  if (account.type !== "EXPENSE" && account.type !== "ASSET") {
    return {
      ok: false,
      message: `GL ${account.accountNumber} ${account.name} is a ${account.type} account — AP debits can only target EXPENSE or ASSET accounts.`,
      code: "BAD_GL_TYPE",
    };
  }

  const grossN = Number(input.coding.gross.replace(/,/g, ""));
  if (!Number.isFinite(grossN) || grossN <= 0) {
    return { ok: false, message: "Gross amount must be a positive number.", code: "BAD_GROSS" };
  }
  const grossD = new Decimal(grossN.toFixed(2));
  const taxD = input.coding.taxTotal
    ? new Decimal(Number(input.coding.taxTotal.replace(/,/g, "") || "0").toFixed(2))
    : new Decimal(0);
  const subtotalD = grossD.minus(taxD);

  try {
    const result = await prisma.$transaction(async (tx) => {
      // Duplicate detection inside the tx so a concurrent commit
      // can't race the check.
      const dupInv = await tx.aPInvoice.findFirst({
        where: { clubId, vendorId: vendor.id, vendorReference: input.coding.invoiceNumber },
        select: { id: true, invoiceNumber: true },
      });
      if (dupInv) {
        throw new ConflictError(
          `Invoice ${input.coding.invoiceNumber} already exists on this vendor as ${dupInv.invoiceNumber}.`,
        );
      }

      const yr = new Date().getFullYear();
      const seq = await tx.aPInvoice.count({ where: { clubId } });
      const invoiceNumber = `AP-${yr}-${String(seq + 1).padStart(6, "0")}`;

      const termsDays = input.coding.paymentTermsDays ?? vendor.paymentTermsDays ?? 30;
      const invoiceDate = new Date();
      const dueDate = new Date(invoiceDate.getTime() + termsDays * 86_400_000);

      const inv = await tx.aPInvoice.create({
        data: {
          clubId,
          invoiceNumber,
          vendorReference: input.coding.invoiceNumber,
          vendorId: vendor.id,
          invoiceDate,
          dueDate,
          terms: `Net ${termsDays}`,
          description: `AP drafted from Mission Control · ${wi.displaySender ?? "email"}`,
          departmentId: null,
          subtotal: subtotalD.gte(0) ? subtotalD : new Decimal(0),
          taxTotal: taxD,
          total: grossD,
          currency: input.coding.currency,
          status: "DRAFT",
          captureId: null,
          createdByUserId: principal.id,
        },
        select: { id: true, invoiceNumber: true },
      });

      await tx.aPInvoiceLine.create({
        data: {
          clubId,
          invoiceId: inv.id,
          lineNumber: 1,
          expenseAccountId: account.id,
          departmentId: null,
          costCenterId: null,
          description: `AP posted via Mission Control (${input.coding.invoiceNumber})`,
          quantity: null,
          unitCost: null,
          amount: grossD,
          taxCodeId: null,
          taxAmount: taxD,
          isCapital: account.type === "ASSET",
          isInventory: false,
        },
      });

      await tx.workIntakeItem.update({
        where: { id: wi.id },
        data: {
          status: "RESOLVED",
          resolvedAt: new Date(),
          resolvedByUserId: principal.id,
        },
      });

      return { invoiceId: inv.id, invoiceNumber: inv.invoiceNumber };
    }, {
      timeout: 60_000,
      maxWait: 15_000,
    });

    await audit(principal, {
      action: "ap.invoice.create",
      entityType: "APInvoice",
      entityId: result.invoiceId,
      clubId,
      after: {
        invoiceNumber: result.invoiceNumber,
        vendorId: vendor.id,
        vendorRef: input.coding.invoiceNumber,
        gross: grossD.toString(),
        gl: `${account.accountNumber} ${account.name}`,
        source: "mission-control:post-ap-invoice-step-2",
      },
    });
    await audit(principal, {
      action: "work-intake.resolve",
      entityType: "WorkIntakeItem",
      entityId: wi.id,
      clubId,
      after: { via: "mission-control:post-ap-invoice-step-2", apInvoiceId: result.invoiceId },
    });

    logger.info("mission-control.post-ap-invoice-step-2.success", {
      clubId,
      workIntakeItemId: wi.id,
      vendorId: vendor.id,
      invoiceId: result.invoiceId,
    });

    return {
      ok: true,
      vendorId: vendor.id,
      invoiceId: result.invoiceId,
      invoiceNumber: result.invoiceNumber,
      timelineUrl: `/app/admin/ap/vendors/${encodeURIComponent(vendor.id)}/timeline`,
      apInvoiceUrl: `/app/admin/ap/invoices/${encodeURIComponent(result.invoiceId)}`,
    };
  } catch (err) {
    if (isAppError(err)) return { ok: false, message: err.safeMessage, code: err.name };
    logger.error("mission-control.post-ap-invoice-step-2.failed", {
      clubId, workIntakeItemId: wi.id, vendorId: vendor.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      ok: false,
      message: err instanceof Error ? err.message : "AP invoice post failed.",
      code: "UNEXPECTED",
    };
  }
}
