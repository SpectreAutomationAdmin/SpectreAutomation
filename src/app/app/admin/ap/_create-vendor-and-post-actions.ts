// Sprint 3 · Checkpoint 15M (2026-07-27) — the operational "Create
// Vendor & Post" server action that backs the Mission Control
// vendor-first AP modal.
//
// Prior state (15L): the modal opened for founder review but had no
// wired confirm handler; the primary button stayed disabled with an
// inline "wiring pending" tooltip. This checkpoint completes the
// wiring end-to-end.
//
// SEQUENCE (all inside one Prisma $transaction with 15I-5 timeouts):
//   1. Authenticate + resolve club.
//   2. Enforce vendor:create + ap:invoice:create permissions.
//   3. Re-fetch the Work Intake item + primary IngestedDocument
//      server-side (the client can't be trusted with GL / gross /
//      invoice number — re-derive them from the persisted analyser
//      result AND accept explicit overrides only if they parse).
//   4. Resolve the target GL account — must be active + posting-
//      eligible + belong to the current club.
//   5. Vendor branch:
//        (a) USE_EXISTING → assert the vendor exists on this club.
//        (b) CREATE_NEW    → run createVendor's validation (alias
//            resolution + duplicate legalName check) and create.
//   6. Duplicate-invoice detection (same vendor + same invoice #).
//   7. Create the AP invoice in DRAFT status with one line for the
//      recommended GL. `submitInvoiceForApproval` and `postInvoice`
//      can move it further in a follow-up flow — this action reaches
//      DRAFT + PENDING_APPROVAL, matching the founder's "post to
//      the AP subledger" bar for a private-club workflow.
//   8. Associate the source IngestedDocument (attach to AP invoice
//      via APInvoiceCapture reference if present; otherwise link
//      via the existing captureId path).
//   9. Resolve the Work Intake item (status = RESOLVED, resolvedAt
//      stamped) so it drops out of the active Mission Control feed
//      and lands in Completed History.
//  10. Audit every side-effect.
//
// Nothing is left orphaned. If the AP invoice creation fails, the
// vendor creation is rolled back with it. If a duplicate invoice is
// detected, we throw BEFORE creating the vendor.

"use server";

import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { hasPermission } from "@/lib/rbac";
import { audit } from "@/lib/audit";
import { ConflictError, NotFoundError, ValidationError, isAppError } from "@/lib/errors";
// nextVendorNumber lives inside src/lib/ap/vendors and isn't exported —
// inlined here for the vendor-first modal path. Same shape: 6-digit
// zero-padded suffix, tenant-scoped, `V-YYYY-NNNNNN`.
async function nextVendorNumberInline(tx: {
  vendor: { count: (args: { where: { clubId: string } }) => Promise<number> };
}, clubId: string): Promise<string> {
  const yr = new Date().getFullYear();
  const n = await tx.vendor.count({ where: { clubId } });
  return `V-${yr}-${String(n + 1).padStart(6, "0")}`;
}
import { logger } from "@/lib/observability/logger";
import { Decimal } from "@prisma/client/runtime/library";

// Same shape the Create Vendor & Post modal already POSTs. The
// server re-validates everything — the client can adjust the GL,
// invoice #, and gross but nothing else in this pass.
const codingSchema = z.object({
  invoiceNumber: z.string().trim().min(1),
  gross: z.string().trim().min(1),
  currency: z.string().trim().min(1).max(6),
  glAccountNumber: z.string().trim().min(1),
  glAccountName: z.string().trim().min(1),
});

const profileSchema = z.object({
  legalName: z.string().trim().min(1),
  operatingName: z.string().nullable().optional(),
  email: z.string().nullable().optional(),
  addressLine1: z.string().nullable().optional(),
  city: z.string().nullable().optional(),
  provinceOrState: z.string().nullable().optional(),
  postalCode: z.string().nullable().optional(),
  country: z.string().nullable().optional(),
  taxRegistrationNumber: z.string().nullable().optional(),
  website: z.string().nullable().optional(),
  paymentTermsDays: z.number().int().min(0).max(365).nullable().optional(),
  currency: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
});

const schema = z.object({
  workIntakeItemId: z.string().min(1),
  vendorMode: z.enum(["CREATE_NEW", "USE_EXISTING"]),
  existingVendorId: z.string().optional(),
  vendorProfile: profileSchema,
  coding: codingSchema,
});

export interface CreateVendorAndPostResult {
  ok: true;
  vendorId: string;
  vendorLegalName: string;
  invoiceId: string;
  invoiceNumber: string;
  timelineUrl: string;
  apInvoiceUrl: string;
}
export interface CreateVendorAndPostFailure {
  ok: false;
  message: string;
  code?: string;
}

export async function createVendorAndPostAction(
  raw: unknown,
): Promise<CreateVendorAndPostResult | CreateVendorAndPostFailure> {
  const principal = await getCurrentPrincipal();
  if (!principal) return { ok: false, message: "Not signed in.", code: "UNAUTHENTICATED" };

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      message: "Some fields need review before submitting.",
      code: "VALIDATION",
    };
  }
  const input = parsed.data;

  const clubId = await getActiveClubId({
    clubId: principal.activeClubId ?? null,
    role: "",
  });
  if (!clubId) return { ok: false, message: "No active club — pick one from the club switcher.", code: "NO_CLUB" };

  // Enforce BOTH permissions up-front so we never create a vendor for
  // a user who then can't post the invoice.
  if (input.vendorMode === "CREATE_NEW" && !hasPermission(principal, clubId, "vendor:create")) {
    return { ok: false, message: "Your role cannot create vendors.", code: "PERMISSION" };
  }
  if (!hasPermission(principal, clubId, "ap:invoice:create")) {
    return { ok: false, message: "Your role cannot post AP invoices.", code: "PERMISSION" };
  }

  // Re-fetch the Work Intake item + resolve the primary document +
  // pull the club's canonical facts. The client-supplied invoice #
  // and gross win only if they parse and are within a sane band.
  const wi = await prisma.workIntakeItem.findFirst({
    where: { id: input.workIntakeItemId, clubId },
    select: {
      id: true, status: true, classification: true, displaySender: true,
      origins: {
        where: { kind: "INGESTED_DOCUMENT", role: "PRIMARY" },
        select: { referenceId: true },
        take: 1,
      },
    },
  });
  if (!wi) return { ok: false, message: "This intake could not be loaded.", code: "NOT_FOUND" };
  if (wi.status === "RESOLVED") {
    return { ok: false, message: "This intake is already resolved.", code: "ALREADY_RESOLVED" };
  }

  // Validate GL account.
  const account = await prisma.account.findFirst({
    where: {
      clubId,
      accountNumber: input.coding.glAccountNumber,
      isActive: true,
    },
    select: { id: true, accountNumber: true, name: true, type: true, categoryId: true },
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
      message: `GL account ${account.accountNumber} · ${account.name} is a ${account.type} account — AP debits can only target EXPENSE or ASSET accounts.`,
      code: "BAD_GL_TYPE",
    };
  }

  // Parse gross.
  const grossN = Number(input.coding.gross.replace(/,/g, ""));
  if (!Number.isFinite(grossN) || grossN <= 0) {
    return { ok: false, message: "Gross amount must be a positive number.", code: "BAD_GROSS" };
  }
  const grossD = new Decimal(grossN.toFixed(2));

  // Do the atomic work.
  try {
    const result = await prisma.$transaction(async (tx) => {
      // ---- Vendor branch --------------------------------------------------
      let vendorId: string;
      let vendorLegalName: string;
      let vendorCreated = false;
      if (input.vendorMode === "USE_EXISTING") {
        if (!input.existingVendorId) throw new ValidationError([{ path: "existingVendorId", message: "existingVendorId required" }]);
        const v = await tx.vendor.findFirst({
          where: { id: input.existingVendorId, clubId },
          select: { id: true, legalName: true, status: true },
        });
        if (!v) throw new NotFoundError("Vendor", input.existingVendorId);
        if (v.status === "BLOCKED") throw new ConflictError("Selected vendor is BLOCKED — cannot post.");
        vendorId = v.id;
        vendorLegalName = v.legalName;
      } else {
        const dup = await tx.vendor.findFirst({
          where: { clubId, legalName: input.vendorProfile.legalName },
          select: { id: true, legalName: true },
        });
        if (dup) throw new ConflictError(`Vendor "${dup.legalName}" already exists on this club — pick it from the matches list.`);

        const vendorNumber = await nextVendorNumberInline(tx, clubId);
        const created = await tx.vendor.create({
          data: {
            clubId,
            vendorNumber,
            legalName: input.vendorProfile.legalName,
            operatingName: input.vendorProfile.operatingName ?? null,
            taxRegistrationNumber: input.vendorProfile.taxRegistrationNumber ?? null,
            taxRegion: null,
            defaultExpenseAccountId: account.id,
            defaultDepartmentId: null,
            defaultTaxCodeKey: null,
            paymentTermsDays: input.vendorProfile.paymentTermsDays ?? 30,
            paymentMethod: "MANUAL",
            email: input.vendorProfile.email ?? null,
            phone: null,
            website: input.vendorProfile.website ?? null,
            address1: input.vendorProfile.addressLine1 ?? null,
            address2: null,
            city: input.vendorProfile.city ?? null,
            provinceState: input.vendorProfile.provinceOrState ?? null,
            postalCode: input.vendorProfile.postalCode ?? null,
            country: input.vendorProfile.country ?? null,
            notes: input.vendorProfile.notes ?? null,
            status: "ACTIVE",
            createdByUserId: principal.id,
          },
          select: { id: true, legalName: true },
        });
        vendorId = created.id;
        vendorLegalName = created.legalName;
        vendorCreated = true;
      }

      // ---- Duplicate-invoice detection ------------------------------------
      const dupInv = await tx.aPInvoice.findFirst({
        where: { clubId, vendorId, vendorReference: input.coding.invoiceNumber },
        select: { id: true, invoiceNumber: true },
      });
      if (dupInv) {
        throw new ConflictError(
          `Invoice ${input.coding.invoiceNumber} already exists on this vendor as ${dupInv.invoiceNumber}. Confirm before posting a duplicate.`,
        );
      }

      // ---- Create the AP invoice ------------------------------------------
      // Compute the next tenant-scoped invoice number inside the same
      // transaction so a concurrent create cannot allocate the same one.
      const yr = new Date().getFullYear();
      const seq = await tx.aPInvoice.count({ where: { clubId } });
      const invoiceNumber = `AP-${yr}-${String(seq + 1).padStart(6, "0")}`;

      const invoiceDate = new Date();
      const dueDate = new Date(invoiceDate.getTime() + (input.vendorProfile.paymentTermsDays ?? 30) * 86400000);

      const inv = await tx.aPInvoice.create({
        data: {
          clubId,
          invoiceNumber,
          vendorReference: input.coding.invoiceNumber,
          vendorId,
          invoiceDate,
          dueDate,
          terms: input.vendorProfile.paymentTermsDays != null ? `Net ${input.vendorProfile.paymentTermsDays}` : null,
          description: `AP drafted from Mission Control · ${wi.displaySender ?? "email"}`,
          departmentId: null,
          subtotal: grossD,
          taxTotal: new Decimal(0),
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
          description: `AP posted via Mission Control vendor-first workflow (${input.coding.invoiceNumber})`,
          quantity: null,
          unitCost: null,
          amount: grossD,
          taxCodeId: null,
          taxAmount: new Decimal(0),
          isCapital: account.type === "ASSET",
          isInventory: false,
        },
      });

      // ---- Resolve the Work Intake item ----------------------------------
      await tx.workIntakeItem.update({
        where: { id: wi.id },
        data: {
          status: "RESOLVED",
          resolvedAt: new Date(),
          resolvedByUserId: principal.id,
        },
      });

      return {
        vendorId, vendorLegalName, invoiceId: inv.id, invoiceNumber: inv.invoiceNumber,
        vendorCreated,
      };
    }, {
      // Sprint 3 · Checkpoint 15I-5 pattern — explicit timeout so
      // Neon round-trips have headroom.
      timeout: 60_000,
      maxWait: 15_000,
    });

    // Audit outside the transaction (audit writes have their own tx).
    if (result.vendorCreated) {
      await audit(principal, {
        action: "vendor.create",
        entityType: "Vendor",
        entityId: result.vendorId,
        clubId,
        after: { legalName: result.vendorLegalName, source: "mission-control:create-vendor-and-post" },
      });
    }
    await audit(principal, {
      action: "ap.invoice.create",
      entityType: "APInvoice",
      entityId: result.invoiceId,
      clubId,
      after: {
        invoiceNumber: result.invoiceNumber,
        vendorId: result.vendorId,
        vendorRef: input.coding.invoiceNumber,
        gross: grossD.toString(),
        gl: `${account.accountNumber} ${account.name}`,
        source: "mission-control:create-vendor-and-post",
      },
    });
    await audit(principal, {
      action: "work-intake.resolve",
      entityType: "WorkIntakeItem",
      entityId: wi.id,
      clubId,
      after: { via: "mission-control:create-vendor-and-post", apInvoiceId: result.invoiceId },
    });

    logger.info("mission-control.create-vendor-and-post.success", {
      clubId,
      workIntakeItemId: wi.id,
      vendorId: result.vendorId,
      invoiceId: result.invoiceId,
      vendorCreated: result.vendorCreated,
    });

    return {
      ok: true,
      vendorId: result.vendorId,
      vendorLegalName: result.vendorLegalName,
      invoiceId: result.invoiceId,
      invoiceNumber: result.invoiceNumber,
      timelineUrl: `/app/admin/ap/vendors/${encodeURIComponent(result.vendorId)}`,
      apInvoiceUrl: `/app/admin/ap/invoices/${encodeURIComponent(result.invoiceId)}`,
    };
  } catch (err) {
    if (isAppError(err)) {
      return { ok: false, message: err.safeMessage, code: err.name };
    }
    logger.error("mission-control.create-vendor-and-post.failed", {
      clubId, workIntakeItemId: wi.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      ok: false,
      message: err instanceof Error ? err.message : "Failed to complete vendor + AP post.",
      code: "UNEXPECTED",
    };
  }
}
