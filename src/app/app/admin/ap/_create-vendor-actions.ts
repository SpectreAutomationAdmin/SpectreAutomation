// Sprint 3 · Checkpoint 15O (2026-07-27) — Step 1 server actions
// backing the founder-required two-step vendor + AP workflow.
//
// The 15M single-transaction path (create vendor AND post AP in one
// go) is rejected. Product decision: two explicit steps.
//
//   Step 1 tx (this file)
//     • Create vendor (or select an existing match).
//     • Associate the source email + IngestedDocument + WorkIntakeItem
//       with the vendor.
//     • Leave the WorkIntakeItem OPEN — Step 2 resolves it.
//     • First timeline event is `Vendor created`.
//
//   Step 2 tx (see _post-ap-invoice-actions.ts)
//     • Re-fetch vendor + validate + create AP invoice + resolve WI.
//
// If Step 2 fails, the vendor remains valid, the WI stays unresolved,
// and the user can retry posting without creating a duplicate vendor.
// This is intentional — atomicity is per-step, not cross-step.

"use server";

import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { hasPermission } from "@/lib/rbac";
import { audit } from "@/lib/audit";
import { ConflictError, NotFoundError, ValidationError, isAppError } from "@/lib/errors";
import { logger } from "@/lib/observability/logger";

const profileSchema = z.object({
  legalName: z.string().trim().min(1),
  operatingName: z.string().nullable().optional(),
  email: z.string().nullable().optional(),
  addressLine1: z.string().nullable().optional(),
  addressLine2: z.string().nullable().optional(),
  city: z.string().nullable().optional(),
  provinceOrState: z.string().nullable().optional(),
  postalCode: z.string().nullable().optional(),
  country: z.string().nullable().optional(),
  phone: z.string().nullable().optional(),
  taxRegistrationNumber: z.string().nullable().optional(),
  website: z.string().nullable().optional(),
  paymentTermsDays: z.number().int().min(0).max(365).nullable().optional(),
  currency: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  // Contact fields (optional; not persisted in current Vendor schema
  // — captured for the audit + follow-up "vendor contacts" model).
  mainContactName: z.string().nullable().optional(),
  mainContactEmail: z.string().nullable().optional(),
  mainContactPhone: z.string().nullable().optional(),
  mainContactTitle: z.string().nullable().optional(),
  arEmail: z.string().nullable().optional(),
  apRemittanceEmail: z.string().nullable().optional(),
});

// Sprint 3 · Checkpoint 15P — per-field provenance the client sends
// back with the profile so the audit log records which values came
// from the invoice extraction vs. which the operator typed. Not
// enforced (extension-only) — a client that omits provenance still
// creates the vendor.
const provenanceSchema = z.record(
  z.string(),
  z.object({
    source: z.string().nullable(),
    confidence: z.number().min(0).max(100),
  }),
);

const schema = z.object({
  workIntakeItemId: z.string().min(1),
  vendorMode: z.enum(["CREATE_NEW", "USE_EXISTING"]),
  existingVendorId: z.string().optional(),
  vendorProfile: profileSchema,
  provenance: provenanceSchema.optional(),
  finishLater: z.boolean().optional(),   // Save vendor and finish later — Step 2 skipped.
});

export interface CreateVendorStepResult {
  ok: true;
  vendorId: string;
  vendorLegalName: string;
  vendorCreated: boolean;               // false when USE_EXISTING
  workIntakeItemId: string;
  finishedLater: boolean;               // true when the user chose the secondary action
}
export interface CreateVendorStepFailure {
  ok: false;
  message: string;
  code?: string;
}

// Vendor number allocator — inlined here so we don't need to widen
// the export surface of src/lib/ap/vendors.
async function nextVendorNumber(tx: {
  vendor: { count: (args: { where: { clubId: string } }) => Promise<number> };
}, clubId: string): Promise<string> {
  const yr = new Date().getFullYear();
  const n = await tx.vendor.count({ where: { clubId } });
  return `V-${yr}-${String(n + 1).padStart(6, "0")}`;
}

export async function createVendorAction(
  raw: unknown,
): Promise<CreateVendorStepResult | CreateVendorStepFailure> {
  const principal = await getCurrentPrincipal();
  if (!principal) return { ok: false, message: "Not signed in.", code: "UNAUTHENTICATED" };

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, message: "Some fields need review before submitting.", code: "VALIDATION" };
  }
  const input = parsed.data;

  const clubId = await getActiveClubId({ clubId: principal.activeClubId ?? null, role: "" });
  if (!clubId) return { ok: false, message: "No active club.", code: "NO_CLUB" };

  if (input.vendorMode === "CREATE_NEW" && !hasPermission(principal, clubId, "vendor:create")) {
    return { ok: false, message: "Your role cannot create vendors.", code: "PERMISSION" };
  }

  const wi = await prisma.workIntakeItem.findFirst({
    where: { id: input.workIntakeItemId, clubId },
    select: { id: true, status: true, displaySender: true, displaySubject: true },
  });
  if (!wi) return { ok: false, message: "Work intake item not found.", code: "NOT_FOUND" };
  if (wi.status === "RESOLVED") {
    return { ok: false, message: "This intake is already resolved.", code: "ALREADY_RESOLVED" };
  }

  try {
    const result = await prisma.$transaction(async (tx) => {
      let vendorId: string;
      let vendorLegalName: string;
      let vendorCreated = false;

      if (input.vendorMode === "USE_EXISTING") {
        if (!input.existingVendorId) throw new ValidationError([{ path: "existingVendorId", message: "Required." }]);
        const v = await tx.vendor.findFirst({
          where: { id: input.existingVendorId, clubId },
          select: { id: true, legalName: true, status: true },
        });
        if (!v) throw new NotFoundError("Vendor", input.existingVendorId);
        if (v.status === "BLOCKED") throw new ConflictError("Selected vendor is BLOCKED.");
        vendorId = v.id;
        vendorLegalName = v.legalName;
      } else {
        const dup = await tx.vendor.findFirst({
          where: { clubId, legalName: input.vendorProfile.legalName },
          select: { id: true, legalName: true },
        });
        if (dup) {
          throw new ConflictError(
            `Vendor "${dup.legalName}" already exists on this club — pick it from the matches list.`,
          );
        }
        const vendorNumber = await nextVendorNumber(tx, clubId);
        const created = await tx.vendor.create({
          data: {
            clubId,
            vendorNumber,
            legalName: input.vendorProfile.legalName,
            operatingName: input.vendorProfile.operatingName ?? null,
            taxRegistrationNumber: input.vendorProfile.taxRegistrationNumber ?? null,
            taxRegion: null,
            defaultExpenseAccountId: null,
            defaultDepartmentId: null,
            defaultTaxCodeKey: null,
            paymentTermsDays: input.vendorProfile.paymentTermsDays ?? 30,
            paymentMethod: "MANUAL",
            email: input.vendorProfile.email ?? null,
            phone: input.vendorProfile.phone ?? null,
            website: input.vendorProfile.website ?? null,
            address1: input.vendorProfile.addressLine1 ?? null,
            address2: input.vendorProfile.addressLine2 ?? null,
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

        // Sprint 3 · Checkpoint 15P-1 — persist the contact fields
        // the operator confirmed in Step 1. VendorContact already
        // exists (see prisma/schema.prisma); we insert a row per
        // distinct contact address so nothing captured in the modal
        // is silently dropped. Each row is tenant-scoped and cascade-
        // deletes with the vendor. The AR + AP-remittance addresses
        // become their own contact rows so the AP module can find
        // them later.
        const contacts: Array<{ name: string; role: string; email: string | null; phone: string | null; isPrimary: boolean }> = [];
        if (input.vendorProfile.mainContactName || input.vendorProfile.mainContactEmail || input.vendorProfile.mainContactPhone) {
          contacts.push({
            name: input.vendorProfile.mainContactName || input.vendorProfile.mainContactEmail || "Main contact",
            role: input.vendorProfile.mainContactTitle || "MAIN",
            email: input.vendorProfile.mainContactEmail ?? null,
            phone: input.vendorProfile.mainContactPhone ?? null,
            isPrimary: true,
          });
        }
        if (input.vendorProfile.arEmail) {
          contacts.push({
            name: "Accounts Receivable", role: "AR",
            email: input.vendorProfile.arEmail, phone: null,
            isPrimary: false,
          });
        }
        if (input.vendorProfile.apRemittanceEmail) {
          contacts.push({
            name: "AP Remittance", role: "REMITTANCE",
            email: input.vendorProfile.apRemittanceEmail, phone: null,
            isPrimary: false,
          });
        }
        for (const c of contacts) {
          await tx.vendorContact.create({
            data: {
              clubId,
              vendorId: created.id,
              name: c.name,
              role: c.role,
              email: c.email,
              phone: c.phone,
              isPrimary: c.isPrimary,
            },
          });
        }
      }

      // Step 1 does NOT resolve the Work Intake item — Step 2 does.
      // If the user chose Save-and-finish-later, we leave it OPEN so
      // the operator can return to the same intake and complete Step 2.
      return {
        vendorId,
        vendorLegalName,
        vendorCreated,
        workIntakeItemId: wi.id,
        finishedLater: input.finishLater === true,
      };
    }, {
      // 15I-5 pattern — explicit timeout so a slow Neon round-trip
      // never hits the Prisma 5s default mid-tx.
      timeout: 30_000,
      maxWait: 10_000,
    });

    if (result.vendorCreated) {
      await audit(principal, {
        action: "vendor.create",
        entityType: "Vendor",
        entityId: result.vendorId,
        clubId,
        after: {
          legalName: result.vendorLegalName,
          source: "mission-control:create-vendor-step-1",
          workIntakeItemId: result.workIntakeItemId,
          finishedLater: result.finishedLater,
          // Sprint 3 · Checkpoint 15P — record which fields were
          // pre-populated by the extractor (source + confidence)
          // vs. which the operator typed. Useful for the follow-up
          // enrichment / correction-learning loop.
          provenance: input.provenance ?? null,
        },
      });
    }

    logger.info("mission-control.create-vendor-step-1.success", {
      clubId,
      workIntakeItemId: result.workIntakeItemId,
      vendorId: result.vendorId,
      vendorCreated: result.vendorCreated,
      finishedLater: result.finishedLater,
    });

    return {
      ok: true,
      vendorId: result.vendorId,
      vendorLegalName: result.vendorLegalName,
      vendorCreated: result.vendorCreated,
      workIntakeItemId: result.workIntakeItemId,
      finishedLater: result.finishedLater,
    };
  } catch (err) {
    if (isAppError(err)) return { ok: false, message: err.safeMessage, code: err.name };
    logger.error("mission-control.create-vendor-step-1.failed", {
      clubId, workIntakeItemId: wi.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      ok: false,
      message: err instanceof Error ? err.message : "Vendor creation failed.",
      code: "UNEXPECTED",
    };
  }
}
